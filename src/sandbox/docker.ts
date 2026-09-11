/**
 * Calliope CLI - Code Execution Sandbox
 *
 * Secure code execution using Docker containers.
 */

import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from '../cancellation.js';
import { bindProcessCancellation, detachedProcess } from '../process-cancellation.js';
import { spawn, execSync, execFileSync } from 'child_process';
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
    execFileSync('docker', ['--version'], { stdio: 'pipe' });
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
    execFileSync('docker', ['image', 'inspect', '--', image], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull Docker image if needed
 */
export async function ensureImage(image: string, signal?: AbortSignal): Promise<boolean> {
  throwIfCancelled(signal);
  if (imageExists(image)) return true;

  return new Promise((resolve) => {
    const proc = spawn('docker', ['pull', image], { stdio: 'pipe', detached: detachedProcess });
    const stopped = bindProcessCancellation(proc, signal);
    proc.on('close', async (code) => { await stopped; resolve(code === 0); });
    proc.on('error', () => resolve(false));
  });
}

// ============================================================================
// Output Size Limits
// ============================================================================

/** Maximum size for stdout/stderr buffers (10MB) to prevent unbounded memory growth */
const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;
const TRUNCATION_WARNING = '\n\n[Output truncated at 10MB limit]';

// ============================================================================
// Sandbox Execution
// ============================================================================

/**
 * Execute code in Docker sandbox
 */
export async function executeInSandbox(
  language: Language,
  code: string,
  config: Partial<SandboxConfig> = {},
  cwd?: string,
  signal?: AbortSignal
): Promise<ExecutionResult> {
  throwIfCancelled(signal);
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
  const imageReady = await ensureImage(image, signal);
  throwIfCancelled(signal);
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
  const dockerArgs = buildDockerArgs(language, cfg, tempDir, codeFile, cwd || process.cwd());
  const containerName = `calliope-${randomUUID()}`;
  dockerArgs.splice(1, 0, '--name', containerName);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const proc = spawn('docker', dockerArgs, {
      detached: detachedProcess,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Killing the Docker client alone does not stop the daemon's container.
    // Keep ownership until the named container's removal attempt completes.
    let removal: Promise<boolean> | undefined;
    const removeContainer = () => {
      removal ??= new Promise<boolean>(resolveRemoval => {
        const cleanup = spawn('docker', ['rm', '--force', containerName], { stdio: 'pipe', timeout: 5000 });
        let cleanupError = '';
        cleanup.stderr?.on('data', data => { cleanupError += String(data); });
        cleanup.on('close', code => resolveRemoval(code === 0 || /No such container/i.test(cleanupError)));
        cleanup.on('error', () => resolveRemoval(false));
      });
    };
    const stopped = bindProcessCancellation(proc, signal, removeContainer);
    const timer = setTimeout(() => {
      timedOut = true;
      removeContainer();
      proc.kill('SIGKILL');
    }, cfg.timeout);

    proc.stdout?.on('data', (data) => {
      if (!stdoutTruncated) {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE);
          stdoutTruncated = true;
        }
      }
    });

    proc.stderr?.on('data', (data) => {
      if (!stderrTruncated) {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
          stderrTruncated = true;
        }
      }
    });

    proc.on('close', async (exitCode) => {
      clearTimeout(timer);
      await stopped;
      if (removal) {
        await removal;
        // Retry after the client closes: its run request may have been racing
        // the first removal while the daemon was still creating the container.
        removal = undefined;
        removeContainer();
        if (!await removal) stderr += `\nCould not confirm removal of container ${containerName}; inspect it with docker ps -a.`;
      }

      // Cleanup
      try {
        fs.rmSync(tempDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }

      if (stdoutTruncated) stdout += TRUNCATION_WARNING;
      if (stderrTruncated) stderr += TRUNCATION_WARNING;

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
          success: !signal?.aborted && exitCode === 0,
          exitCode: signal?.aborted ? 130 : (exitCode ?? 1),
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
  codeFile: string,
  cwd: string
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
    args.push('-v', `${cwd}:/project:${rwFlag}`);
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
  timeout: number = 30000,
  signal?: AbortSignal
): Promise<ExecutionResult> {
  throwIfCancelled(signal);
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
      fs.rmSync(tempDir, { recursive: true, force: true });
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
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: detachedProcess });
    const stopped = bindProcessCancellation(proc, signal);

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.stdout?.on('data', (data) => {
      if (!stdoutTruncated) {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE);
          stdoutTruncated = true;
        }
      }
    });
    proc.stderr?.on('data', (data) => {
      if (!stderrTruncated) {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
          stderrTruncated = true;
        }
      }
    });

    proc.on('close', async (exitCode) => {
      clearTimeout(timer);
      await stopped;
      try { fs.rmSync(tempDir, { recursive: true }); } catch {}

      if (stdoutTruncated) stdout += TRUNCATION_WARNING;
      if (stderrTruncated) stderr += TRUNCATION_WARNING;

      resolve({
        success: !signal?.aborted && !timedOut && exitCode === 0,
        exitCode: signal?.aborted ? 130 : timedOut ? 124 : (exitCode ?? 1),
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
  config: Partial<SandboxConfig> = {},
  cwd?: string,
  signal?: AbortSignal
): Promise<ExecutionResult> {
  throwIfCancelled(signal);
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (cfg.enabled && isDockerAvailable()) {
    return executeInSandbox(language, code, cfg, cwd, signal);
  } else {
    return executeUnsafe(language, code, cfg.timeout, signal);
  }
}
