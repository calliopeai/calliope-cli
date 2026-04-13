/**
 * Shared macOS sleep prevention for long-running agent work.
 *
 * Uses `caffeinate` with a timeout and refresh interval so orphaned child
 * processes self-expire even if Calliope is terminated abruptly.
 */

import { spawn, type ChildProcess } from 'child_process';

const CAFFEINATE_TIMEOUT_SECONDS = 300;
const CAFFEINATE_REFRESH_MS = 4 * 60 * 1000;

let activeProcess: ChildProcess | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let retainCount = 0;

function spawnSleepGuard(): void {
  if (process.platform !== 'darwin' || activeProcess) return;

  try {
    activeProcess = spawn(
      'caffeinate',
      ['-di', '-t', String(CAFFEINATE_TIMEOUT_SECONDS)],
      { stdio: 'ignore' },
    );
    activeProcess.unref();

    const proc = activeProcess;
    proc.on('error', () => {
      if (activeProcess === proc) {
        activeProcess = null;
      }
    });
    proc.on('exit', () => {
      if (activeProcess === proc) {
        activeProcess = null;
      }
    });
  } catch {
    activeProcess = null;
  }
}

function stopSleepGuard(): void {
  if (!activeProcess) return;

  const proc = activeProcess;
  activeProcess = null;
  try {
    proc.kill('SIGKILL');
  } catch {
    // Process may already be gone.
  }
}

function ensureRefreshTimer(): void {
  if (process.platform !== 'darwin' || refreshTimer) return;

  refreshTimer = setInterval(() => {
    if (retainCount <= 0) return;
    stopSleepGuard();
    spawnSleepGuard();
  }, CAFFEINATE_REFRESH_MS);
  refreshTimer.unref();
}

function clearRefreshTimer(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

export function startPreventSleep(): void {
  retainCount += 1;
  if (retainCount !== 1) return;

  spawnSleepGuard();
  ensureRefreshTimer();
}

export function stopPreventSleep(): void {
  if (retainCount > 0) {
    retainCount -= 1;
  }
  if (retainCount > 0) return;

  clearRefreshTimer();
  stopSleepGuard();
}

export function resetPreventSleepForTests(): void {
  retainCount = 0;
  clearRefreshTimer();
  stopSleepGuard();
}
