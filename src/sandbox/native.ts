/**
 * Calliope CLI - Native OS Sandbox
 *
 * Lightweight OS-level sandboxing as an alternative to Docker.
 * Currently supports macOS (Seatbelt via sandbox-exec).
 * Linux Landlock support is planned for the future.
 */

import { spawn, execFileSync } from 'child_process';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export type SandboxBackend = 'seatbelt' | 'landlock' | 'none';

export interface NativeSandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxed: boolean;
  backend: SandboxBackend;
}

export interface NativeSandboxOptions {
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;
  /** Allow network access (default: false) */
  networkEnabled?: boolean;
  /** Additional read-only paths to allow */
  readOnlyPaths?: string[];
  /** Additional read-write paths to allow */
  readWritePaths?: string[];
}

// ============================================================================
// macOS Seatbelt Profile
// ============================================================================

/**
 * Build a Seatbelt profile for sandboxed execution.
 *
 * Defaults:
 *  - deny everything by default
 *  - allow process execution and forking
 *  - allow broad file reads BUT explicitly deny common secret locations
 *    (~/.ssh, ~/.aws, ~/.config, ~/.gnupg, ~/.gcloud, *.env) so that even with
 *    network off a poisoned command cannot read credentials (#133). Seatbelt
 *    applies the most-specific matching rule, so a (deny file-read*) subpath
 *    overrides the broad (allow file-read*).
 *  - allow file writes only in: project cwd, /dev (stdout/stderr), temp dirs
 *  - allow file-ioctl (terminal I/O), sysctl-read, mach-lookup, signal
 *  - network is DENIED by default; outbound HTTP/HTTPS is only added when the
 *    caller explicitly opts in via options.networkEnabled (#133).
 */
/**
 * Common secret/credential locations that must never be readable from inside the
 * sandbox, expressed relative to the user's home directory plus a literal .env
 * regex. Read denials for these override the broad (allow file-read*).
 */
const SECRET_READ_DENY_SUBPATHS = [
  '.ssh',
  '.aws',
  '.config',
  '.gnupg',
  '.gcloud',
  '.config/gcloud',
  '.kube',
  '.docker',
  '.netrc',
];
/**
 * Sanitize a path for safe embedding in a Seatbelt profile string.
 * Escapes characters that are significant in the Scheme-like DSL
 * (double quotes, backslashes, parentheses) to prevent profile injection.
 */
function sanitizeSeatbeltPath(p: string): string {
  // Reject paths containing null bytes
  if (p.includes('\0')) {
    throw new Error(`Invalid path for sandbox profile: contains null bytes`);
  }
  // Escape backslashes first, then double quotes
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildSeatbeltProfile(
  cwd: string,
  options: NativeSandboxOptions = {},
): string {
  const extraReadWrite = options.readWritePaths || [];

  const safeCwd = sanitizeSeatbeltPath(cwd);

  // Build read-write subpath rules for extra paths
  const extraRwRules = extraReadWrite
    .map((p) => `(allow file-write* (subpath "${sanitizeSeatbeltPath(p)}"))`)
    .join('\n');

  // Network rules — DENIED by default; only enabled on explicit opt-in (#133)
  const networkRules = options.networkEnabled
    ? `(allow network-outbound (remote ip "*:443") (remote ip "*:80"))\n(allow network-outbound (remote unix-socket))`
    : '';

  // Deny reads of well-known secret locations even though reads are broadly
  // allowed (#133). Seatbelt resolves the most-specific subpath rule, so these
  // denials win over the broad (allow file-read*) below. We also deny *.env via
  // a regex so credential files anywhere on disk are not readable.
  const home = os.homedir();
  const secretDenyRules = [
    ...SECRET_READ_DENY_SUBPATHS.map(
      (sub) => `(deny file-read* (subpath "${sanitizeSeatbeltPath(`${home}/${sub}`)}"))`,
    ),
    // Any file whose name ends in .env (e.g. .env, foo.env, .env.production)
    `(deny file-read* (regex #"\\.env($|\\.)"))`,
  ].join('\n');

  const profile = `(version 1)
(deny default)

;; Process execution
(allow process-exec)
(allow process-fork)

;; File reads: allow broadly, then deny known secret locations (#133)
(allow file-read*)
${secretDenyRules}

;; File writes: restricted to project directory, temp dirs, and stdout/stderr devices
(allow file-write*
  (subpath "/dev")
  (subpath "/private/tmp")
  (subpath "/private/var/tmp")
  (subpath "/private/var/folders")
  (subpath "/var/tmp")
  (subpath "/tmp")
  (subpath "${safeCwd}")
)

;; Extra paths
${extraRwRules}

;; Terminal I/O control (needed for stdout/stderr)
(allow file-ioctl)

;; System operations
(allow sysctl-read)
(allow mach-lookup)
(allow signal)

;; Network
${networkRules}
`;

  return profile;
}

// ============================================================================
// Detection
// ============================================================================

let _seatbeltAvailable: boolean | null = null;
let _landlockAvailable: boolean | null = null;

/**
 * Check if macOS Seatbelt (sandbox-exec) is available
 */
export function isSeatbeltAvailable(): boolean {
  if (_seatbeltAvailable !== null) return _seatbeltAvailable;

  if (os.platform() !== 'darwin') {
    _seatbeltAvailable = false;
    return false;
  }

  try {
    // sandbox-exec exists on macOS by default, just verify the binary is present
    execFileSync('which', ['sandbox-exec'], { stdio: 'pipe' });
    _seatbeltAvailable = true;
  } catch {
    _seatbeltAvailable = false;
  }

  return _seatbeltAvailable;
}

/**
 * Check if Linux Landlock is available (placeholder for future implementation)
 */
export function isLandlockAvailable(): boolean {
  if (_landlockAvailable !== null) return _landlockAvailable;

  if (os.platform() !== 'linux') {
    _landlockAvailable = false;
    return false;
  }

  // TODO: Check for Landlock support via /proc/sys/kernel/landlock or similar
  // Landlock requires Linux 5.13+ and is a kernel-level sandboxing mechanism.
  // For now, return false until full implementation is done.
  _landlockAvailable = false;
  return false;
}

/**
 * Check if any native sandbox backend is available
 */
export function isNativeSandboxAvailable(): boolean {
  return isSeatbeltAvailable() || isLandlockAvailable();
}

/**
 * Get the available native sandbox backend
 */
export function getAvailableBackend(): SandboxBackend {
  if (isSeatbeltAvailable()) return 'seatbelt';
  if (isLandlockAvailable()) return 'landlock';
  return 'none';
}

/**
 * Get a human-readable description of the current sandbox status
 */
export function getSandboxStatus(): {
  platform: string;
  backend: SandboxBackend;
  available: boolean;
  description: string;
} {
  const platform = os.platform();
  const backend = getAvailableBackend();
  const available = backend !== 'none';

  let description: string;
  switch (backend) {
    case 'seatbelt':
      description = 'macOS Seatbelt (sandbox-exec) - restricts file access, network, and system calls';
      break;
    case 'landlock':
      description = 'Linux Landlock - kernel-level filesystem sandboxing';
      break;
    case 'none':
      if (platform === 'darwin') {
        description = 'sandbox-exec not found on this macOS system';
      } else if (platform === 'linux') {
        description = 'Landlock not available (requires Linux 5.13+, not yet implemented)';
      } else {
        description = `No native sandbox available for ${platform}`;
      }
      break;
  }

  return { platform, backend, available, description };
}

// ============================================================================
// Output Size Limits
// ============================================================================

/** Maximum size for stdout/stderr buffers (10MB) to prevent unbounded memory growth */
const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;
const TRUNCATION_WARNING = '\n\n[Output truncated at 10MB limit]';

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute a shell command inside a native OS sandbox
 */
export function executeInNativeSandbox(
  command: string,
  cwd: string,
  options: NativeSandboxOptions = {},
): Promise<NativeSandboxResult> {
  const backend = getAvailableBackend();

  switch (backend) {
    case 'seatbelt':
      return executeWithSeatbelt(command, cwd, options);
    case 'landlock':
      // Landlock not yet implemented — fall through to unsandboxed
      return Promise.resolve({
        stdout: '',
        stderr: 'Landlock sandbox is not yet implemented. Command was not executed.',
        exitCode: 1,
        sandboxed: false,
        backend: 'none',
      });
    case 'none':
    default:
      return Promise.resolve({
        stdout: '',
        stderr: 'No native sandbox backend available. Command was not executed.',
        exitCode: 1,
        sandboxed: false,
        backend: 'none',
      });
  }
}

/**
 * Execute a command using macOS Seatbelt (sandbox-exec)
 */
function executeWithSeatbelt(
  command: string,
  cwd: string,
  options: NativeSandboxOptions = {},
): Promise<NativeSandboxResult> {
  const timeout = options.timeout || 60000;
  const profile = buildSeatbeltProfile(cwd, options);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const child = spawn('sandbox-exec', ['-p', profile, 'bash', '-c', command], {
      cwd,
      timeout,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (data) => {
      if (!stdoutTruncated) {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE);
          stdoutTruncated = true;
        }
      }
    });

    child.stderr.on('data', (data) => {
      if (!stderrTruncated) {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
          stderrTruncated = true;
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (stdoutTruncated) stdout += TRUNCATION_WARNING;
      if (stderrTruncated) stderr += TRUNCATION_WARNING;

      if (timedOut) {
        resolve({
          stdout,
          stderr: stderr + '\nExecution timed out',
          exitCode: 124,
          sandboxed: true,
          backend: 'seatbelt',
        });
      } else {
        resolve({
          stdout,
          stderr,
          exitCode: code || 0,
          sandboxed: true,
          backend: 'seatbelt',
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        sandboxed: false,
        backend: 'none',
      });
    });
  });
}

/**
 * Reset cached detection results (useful for testing)
 */
export function resetDetectionCache(): void {
  _seatbeltAvailable = null;
  _landlockAvailable = null;
}
