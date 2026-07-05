/**
 * Calliope CLI - Sandbox (unified public surface)
 *
 * Single entry point for code/shell sandboxing (#181). Two backends live
 * behind this barrel:
 *  - ./docker.ts  — Docker-container execution (executeInSandbox / execute)
 *  - ./native.ts  — native OS sandbox (macOS Seatbelt via executeInNativeSandbox)
 *
 * Consumers import ONLY this module. The mode-routing helpers below resolve the
 * `sandboxMode` config into a concrete backend decision:
 *  - 'auto':   native/Docker when available, otherwise run unsandboxed
 *  - 'native': require the native OS sandbox
 *  - 'docker': use the Docker sandbox
 *  - 'off':    no sandboxing
 */

import config from '../config.js';
import { isDockerAvailable } from './docker.js';
import { isNativeSandboxAvailable } from './native.js';

export * from './docker.js';
export * from './native.js';

export type SandboxMode = 'auto' | 'native' | 'docker' | 'off';

/** Current sandbox mode from config, defaulting to 'auto'. */
export function getSandboxMode(): SandboxMode {
  return (config.get('sandboxMode') as SandboxMode) || 'auto';
}

/**
 * Decide whether a shell command should run inside the native OS sandbox.
 *  - 'use':     native sandbox available and should be used
 *  - 'skip':    run unsandboxed (mode 'off'/'docker', or 'auto' with no backend)
 *  - 'require': native sandbox mandated (mode 'native') — caller fails closed
 *               if no backend is available
 */
export function shouldUseNativeSandbox(): 'use' | 'skip' | 'require' {
  const mode = getSandboxMode();
  if (mode === 'off' || mode === 'docker') return 'skip';
  if (mode === 'native') return 'require';
  // 'auto': use if available
  return isNativeSandboxAvailable() ? 'use' : 'skip';
}

/**
 * Decide which backend to use for sandboxed code execution.
 *  - 'docker':      mode 'docker', or 'auto' with Docker available
 *  - 'native':      mode 'native', or 'auto' with only the native backend available
 *  - 'unsandboxed': mode 'off', or 'auto' with no backend available
 */
export function selectCodeSandbox(): 'docker' | 'native' | 'unsandboxed' {
  const mode = getSandboxMode();
  if (mode === 'docker') return 'docker';
  if (mode === 'native') return 'native';
  if (mode === 'off') return 'unsandboxed';
  // 'auto': prefer Docker, then the native OS sandbox, else unsandboxed
  if (isDockerAvailable()) return 'docker';
  if (isNativeSandboxAvailable()) return 'native';
  return 'unsandboxed';
}
