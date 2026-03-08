/**
 * Calliope CLI - Session Timeout
 *
 * Configurable idle timeout for long-running sessions.
 * Warns before termination, auto-saves session state.
 */

export interface SessionTimeoutConfig {
  enabled: boolean;
  idleTimeoutMs: number;     // Default: 2 hours (7200000)
  warningBeforeMs: number;   // Warn this many ms before timeout (default: 5 min)
}

export type TimeoutCallback = (type: 'warning' | 'timeout') => void;

const DEFAULT_CONFIG: SessionTimeoutConfig = {
  enabled: false,  // Disabled by default for CLI (opt-in)
  idleTimeoutMs: 2 * 60 * 60 * 1000,   // 2 hours
  warningBeforeMs: 5 * 60 * 1000,       // 5 min warning
};

let config: SessionTimeoutConfig = { ...DEFAULT_CONFIG };
let lastActivityMs = Date.now();
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
let warningTimer: ReturnType<typeof setTimeout> | null = null;
let callback: TimeoutCallback | null = null;

/** Configure session timeout */
export function configureTimeout(opts: Partial<SessionTimeoutConfig>): void {
  config = { ...config, ...opts };
  if (config.enabled) {
    resetIdleTimer();
  } else {
    clearTimers();
  }
}

/** Register callback for timeout events */
export function onTimeout(cb: TimeoutCallback): void {
  callback = cb;
}

/** Record user activity (resets idle timer) */
export function recordActivity(): void {
  lastActivityMs = Date.now();
  if (config.enabled) {
    resetIdleTimer();
  }
}

/** Get idle duration in ms */
export function getIdleDuration(): number {
  return Date.now() - lastActivityMs;
}

/** Get time remaining before timeout (ms), or null if disabled */
export function getTimeRemaining(): number | null {
  if (!config.enabled) return null;
  const elapsed = Date.now() - lastActivityMs;
  return Math.max(0, config.idleTimeoutMs - elapsed);
}

/** Check if session is about to expire */
export function isWarning(): boolean {
  if (!config.enabled) return false;
  const remaining = getTimeRemaining();
  return remaining !== null && remaining <= config.warningBeforeMs;
}

/** Get current config */
export function getTimeoutConfig(): SessionTimeoutConfig {
  return { ...config };
}

/** Format time remaining for display */
export function formatTimeRemaining(): string | null {
  const remaining = getTimeRemaining();
  if (remaining === null) return null;
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  if (mins > 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/** Stop all timers (call on exit) */
export function clearTimers(): void {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  if (warningTimer) { clearTimeout(warningTimer); warningTimer = null; }
}

function resetIdleTimer(): void {
  clearTimers();
  if (!config.enabled) return;

  // Set warning timer
  const warningDelay = config.idleTimeoutMs - config.warningBeforeMs;
  if (warningDelay > 0) {
    warningTimer = setTimeout(() => {
      callback?.('warning');
    }, warningDelay);
  }

  // Set timeout timer
  timeoutTimer = setTimeout(() => {
    callback?.('timeout');
  }, config.idleTimeoutMs);
}
