/**
 * Calliope CLI - Idle Session Eviction
 *
 * Manages memory for long-running CLI sessions by evicting
 * cached data and auto-saving state when idle.
 */

export interface EvictionConfig {
  enabled: boolean;
  idleThresholdMs: number;    // Evict caches after this idle time (default: 30 min)
  checkIntervalMs: number;    // How often to check (default: 5 min)
  autoSaveOnEvict: boolean;   // Auto-save session before eviction (default: true)
}

export type EvictionCallback = (action: 'evict' | 'auto-save') => void;

const DEFAULT_CONFIG: EvictionConfig = {
  enabled: true,
  idleThresholdMs: 30 * 60 * 1000,    // 30 minutes
  checkIntervalMs: 5 * 60 * 1000,     // 5 minutes
  autoSaveOnEvict: true,
};

let config: EvictionConfig = { ...DEFAULT_CONFIG };
let lastActivityMs = Date.now();
let checkInterval: ReturnType<typeof setInterval> | null = null;
let callbacks: EvictionCallback[] = [];
let evictionCount = 0;

/** Configure eviction behavior */
export function configureEviction(opts: Partial<EvictionConfig>): void {
  config = { ...config, ...opts };
  if (config.enabled) {
    startMonitor();
  } else {
    stopMonitor();
  }
}

/** Register callback for eviction events */
export function onEviction(cb: EvictionCallback): void {
  callbacks.push(cb);
}

/** Record user activity */
export function recordActivity(): void {
  lastActivityMs = Date.now();
}

/** Get idle duration in ms */
export function getIdleDuration(): number {
  return Date.now() - lastActivityMs;
}

/** Get eviction stats */
export function getEvictionStats(): { evictionCount: number; idleDuration: number; enabled: boolean } {
  return { evictionCount, idleDuration: getIdleDuration(), enabled: config.enabled };
}

/** Start the idle monitor */
export function startMonitor(): void {
  stopMonitor();
  if (!config.enabled) return;
  checkInterval = setInterval(checkIdle, config.checkIntervalMs);
  // Don't prevent process exit
  if (checkInterval && typeof checkInterval === 'object' && 'unref' in checkInterval) {
    checkInterval.unref();
  }
}

/** Stop the idle monitor */
export function stopMonitor(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

function checkIdle(): void {
  const idle = Date.now() - lastActivityMs;
  if (idle >= config.idleThresholdMs) {
    evictionCount++;
    if (config.autoSaveOnEvict) {
      for (const cb of callbacks) cb('auto-save');
    }
    for (const cb of callbacks) cb('evict');
  }
}

/** Get current config */
export function getEvictionConfig(): EvictionConfig {
  return { ...config };
}
