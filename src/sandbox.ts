/**
 * Calliope CLI - Code Execution Sandbox
 *
 * Secure code execution using Docker containers.
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export interface SandboxConfig {
  enabled: boolean;
  image: string;           // Docker image to use
  timeout: number;         // Execution timeout in ms
  memoryLimit: string;     // Memory limit (e.g., '256m')
  cpuLimit: string;        // CPU limit (e.g., '0.5')
  networkEnabled: boolean; // Allow network access
  mountWorkdir: boolean;   // Mount current working directory
  readOnly: boolean;       // Mount as read-only
}

export interface ExecutionResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  sandboxed: boolean;
}

export type Language = 'python' | 'node' | 'bash' | 'ruby' | 'go' | 'rust';

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  image: 'calliope-sandbox',  // Custom image or use language-specific
  timeout: 30000,
  memoryLimit: '256m',
  cpuLimit: '1',
  networkEnabled: false,
  mountWorkdir: true,
  readOnly: true,
};

// Language-specific Docker images
const LANGUAGE_IMAGES: Record<Language, string> = {
  python: 'python:3.11-slim',
  node: 'node:20-slim',
  bash: 'alpine:latest',
  ruby: 'ruby:3.2-slim',
  go: 'golang:1.21-alpine',
  rust: 'rust:1.74-slim',
};

// ============================================================================
// Docker Detection
// ============================================================================

let dockerAvailable: boolean | null = null;

/**
 * Check if Docker is available
 */
export function isDockerAvailable(): boolean {
  if (dockerAvailable !== null) return dockerAvailable;

  try {
    execSync('docker --version', { stdio: 'pipe' });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }

  return dockerAvailable;
}

/**
 * Check if Docker image exists
 */
export function imageExists(image: string): boolean {
  try {
    execSync(`docker image inspect ${image}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull Docker image if needed
 */
export async function ensureImage(image: string): Promise<boolean> {
  if (imageExists(image)) return true;

  return new Promise((resolve) => {
    const proc = spawn('docker', ['pull', image], { stdio: 'pipe' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

// ============================================================================
// Sandbox Execution
// ============================================================================

/**
 * Execute code in Docker sandbox
 */
export async function executeInSandbox(
  language: Language,
  code: string,
  config: Partial<SandboxConfig> = {}
): Promise<ExecutionResult> {
  const cfg: SandboxConfig = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  // Check Docker availability
  if (!isDockerAvailable()) {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Docker is not available. Install Docker to enable sandboxed execution.',
      duration: 0,
      sandboxed: false,
    };
  }

  // Get language-specific image
  const image = LANGUAGE_IMAGES[language] || cfg.image;

  // Ensure image exists
  const imageReady = await ensureImage(image);
  if (!imageReady) {
    return {
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: `Failed to pull Docker image: ${image}`,
      duration: Date.now() - startTime,
      sandboxed: false,
    };
  }

  // Create temp directory for code
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-sandbox-'));
  const codeFile = getCodeFilename(language);
  const codePath = path.join(tempDir, codeFile);
  fs.writeFileSync(codePath, code);

  // Build Docker command
  const dockerArgs = buildDockerArgs(language, cfg, tempDir, codeFile);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, cfg.timeout);

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);

      // Cleanup
      try {
        fs.rmSync(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }

      const duration = Date.now() - startTime;

      if (timedOut) {
        resolve({
          success: false,
          exitCode: 124,
          stdout,
          stderr: stderr + '\nExecution timed out',
          duration,
          sandboxed: true,
        });
      } else {
        resolve({
          success: exitCode === 0,
          exitCode: exitCode || 0,
          stdout,
          stderr,
          duration,
          sandboxed: true,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);

      try {
        fs.rmSync(tempDir, { recursive: true });
      } catch {
        // Ignore
      }

      resolve({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        duration: Date.now() - startTime,
        sandboxed: false,
      });
    });
  });
}

/**
 * Get appropriate filename for language
 */
function getCodeFilename(language: Language): string {
  switch (language) {
    case 'python': return 'code.py';
    case 'node': return 'code.js';
    case 'bash': return 'code.sh';
    case 'ruby': return 'code.rb';
    case 'go': return 'main.go';
    case 'rust': return 'main.rs';
    default: return 'code.txt';
  }
}

/**
 * Build Docker run arguments
 */
function buildDockerArgs(
  language: Language,
  config: SandboxConfig,
  tempDir: string,
  codeFile: string
): string[] {
  const image = LANGUAGE_IMAGES[language];
  const args: string[] = ['run', '--rm'];

  // Resource limits
  args.push('--memory', config.memoryLimit);
  args.push('--cpus', config.cpuLimit);

  // Network
  if (!config.networkEnabled) {
    args.push('--network', 'none');
  }

  // Security
  args.push('--security-opt', 'no-new-privileges');
  args.push('--cap-drop', 'ALL');

  // Mount temp directory with code
  args.push('-v', `${tempDir}:/workspace:ro`);
  args.push('-w', '/workspace');

  // Mount workdir if enabled
  if (config.mountWorkdir) {
    const rwFlag = config.readOnly ? 'ro' : 'rw';
    args.push('-v', `${process.cwd()}:/project:${rwFlag}`);
  }

  // Image
  args.push(image);

  // Command based on language
  switch (language) {
    case 'python':
      args.push('python', `/workspace/${codeFile}`);
      break;
    case 'node':
      args.push('node', `/workspace/${codeFile}`);
      break;
    case 'bash':
      args.push('sh', `/workspace/${codeFile}`);
      break;
    case 'ruby':
      args.push('ruby', `/workspace/${codeFile}`);
      break;
    case 'go':
      args.push('sh', '-c', `cd /workspace && go run ${codeFile}`);
      break;
    case 'rust':
      args.push('sh', '-c', `cd /workspace && rustc ${codeFile} -o /tmp/prog && /tmp/prog`);
      break;
  }

  return args;
}

// ============================================================================
// Fallback Execution (without Docker)
// ============================================================================

/**
 * Execute code without sandbox (fallback)
 */
export function executeUnsafe(
  language: Language,
  code: string,
  timeout: number = 30000
): Promise<ExecutionResult> {
  const startTime = Date.now();

  // Create temp file
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-exec-'));
  const codeFile = getCodeFilename(language);
  const codePath = path.join(tempDir, codeFile);
  fs.writeFileSync(codePath, code);

  // Get command
  let cmd: string;
  let args: string[];

  switch (language) {
    case 'python':
      cmd = 'python3';
      args = [codePath];
      break;
    case 'node':
      cmd = 'node';
      args = [codePath];
      break;
    case 'bash':
      cmd = 'bash';
      args = [codePath];
      break;
    case 'ruby':
      cmd = 'ruby';
      args = [codePath];
      break;
    default:
      return Promise.resolve({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `Unsupported language: ${language}`,
        duration: 0,
        sandboxed: false,
      });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.stdout?.on('data', (data) => stdout += data.toString());
    proc.stderr?.on('data', (data) => stderr += data.toString());

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      try { fs.rmSync(tempDir, { recursive: true }); } catch {}

      resolve({
        success: !timedOut && exitCode === 0,
        exitCode: timedOut ? 124 : (exitCode || 0),
        stdout,
        stderr: timedOut ? stderr + '\nExecution timed out' : stderr,
        duration: Date.now() - startTime,
        sandboxed: false,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      try { fs.rmSync(tempDir, { recursive: true }); } catch {}

      resolve({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        duration: Date.now() - startTime,
        sandboxed: false,
      });
    });
  });
}

// ============================================================================
// Main Execute Function
// ============================================================================

/**
 * Execute code (with or without sandbox based on availability)
 */
export async function execute(
  language: Language,
  code: string,
  config: Partial<SandboxConfig> = {}
): Promise<ExecutionResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (cfg.enabled && isDockerAvailable()) {
    return executeInSandbox(language, code, cfg);
  } else {
    return executeUnsafe(language, code, cfg.timeout);
  }
}
