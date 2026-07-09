/**
 * UI Module - Debug logging
 *
 * A process-wide debug flag (toggled by /debug) and a timestamped stderr logger.
 * Kept as module state — matching the original — so the /debug command's toggle
 * and the various debugLog call sites share one source of truth.
 */

let debugEnabled = process.env.CALLIOPE_DEBUG === '1';

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function setDebugEnabled(value: boolean): void {
  debugEnabled = value;
}

export const debugLog = (label: string, ...args: unknown[]): void => {
  if (debugEnabled) {
    const timestamp = new Date().toISOString().split('T')[1]!.slice(0, 12);
    console.error(`[${timestamp}] ${label}:`, ...args);
  }
};
