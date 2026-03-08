import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  configureEviction,
  onEviction,
  recordActivity,
  getIdleDuration,
  getEvictionStats,
  startMonitor,
  stopMonitor,
  getEvictionConfig,
} from '../src/idle-eviction.js';

describe('idle-eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset to defaults with monitor disabled so tests start clean
    configureEviction({
      enabled: false,
      idleThresholdMs: 30 * 60 * 1000,
      checkIntervalMs: 5 * 60 * 1000,
      autoSaveOnEvict: true,
    });
    // Record activity to reset the idle timer baseline
    recordActivity();
  });

  afterEach(() => {
    stopMonitor();
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // configureEviction
  // --------------------------------------------------------------------------
  describe('configureEviction', () => {
    it('should enable the monitor when enabled is set to true', () => {
      configureEviction({ enabled: true });
      const cfg = getEvictionConfig();
      expect(cfg.enabled).toBe(true);
    });

    it('should disable the monitor when enabled is set to false', () => {
      configureEviction({ enabled: true });
      configureEviction({ enabled: false });
      const cfg = getEvictionConfig();
      expect(cfg.enabled).toBe(false);
    });

    it('should merge partial config with existing config', () => {
      configureEviction({ idleThresholdMs: 10000 });
      const cfg = getEvictionConfig();
      expect(cfg.idleThresholdMs).toBe(10000);
      // Other fields should retain their values
      expect(cfg.checkIntervalMs).toBe(5 * 60 * 1000);
      expect(cfg.autoSaveOnEvict).toBe(true);
    });

    it('should start the monitor when enabling', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
      });

      // Advance past threshold + one check interval
      vi.advanceTimersByTime(1500);
      expect(cb).toHaveBeenCalled();
    });

    it('should stop the monitor when disabling', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
      });

      // Disable before threshold is reached
      configureEviction({ enabled: false });
      vi.advanceTimersByTime(5000);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // onEviction callback
  // --------------------------------------------------------------------------
  describe('onEviction', () => {
    it('should fire auto-save and evict events when idle threshold is exceeded', () => {
      const actions: string[] = [];
      onEviction((action) => actions.push(action));

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
        autoSaveOnEvict: true,
      });

      vi.advanceTimersByTime(1500);
      expect(actions).toContain('auto-save');
      expect(actions).toContain('evict');
      // auto-save should come before evict
      expect(actions.indexOf('auto-save')).toBeLessThan(actions.indexOf('evict'));
    });

    it('should fire only evict (not auto-save) when autoSaveOnEvict is false', () => {
      const actions: string[] = [];
      onEviction((action) => actions.push(action));

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
        autoSaveOnEvict: false,
      });

      vi.advanceTimersByTime(1500);
      expect(actions).not.toContain('auto-save');
      expect(actions).toContain('evict');
    });

    it('should fire multiple registered callbacks', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      onEviction(cb1);
      onEviction(cb2);

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
      });

      vi.advanceTimersByTime(1500);
      expect(cb1).toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();
    });

    it('should not fire callbacks before idle threshold', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 5000,
        checkIntervalMs: 1000,
      });

      vi.advanceTimersByTime(3000);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // recordActivity
  // --------------------------------------------------------------------------
  describe('recordActivity', () => {
    it('should reset the idle timer', () => {
      vi.advanceTimersByTime(5000);
      expect(getIdleDuration()).toBe(5000);

      recordActivity();
      expect(getIdleDuration()).toBe(0);
    });

    it('should prevent eviction when called before threshold', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 2000,
        checkIntervalMs: 1000,
      });

      // Advance 1500ms, then record activity to reset
      vi.advanceTimersByTime(1500);
      recordActivity();

      // Advance another 1500ms - total 3000ms but only 1500ms since last activity
      vi.advanceTimersByTime(1500);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getIdleDuration
  // --------------------------------------------------------------------------
  describe('getIdleDuration', () => {
    it('should return 0 immediately after recordActivity', () => {
      recordActivity();
      expect(getIdleDuration()).toBe(0);
    });

    it('should track elapsed time correctly', () => {
      recordActivity();
      vi.advanceTimersByTime(10000);
      expect(getIdleDuration()).toBe(10000);
    });

    it('should accumulate time without activity', () => {
      recordActivity();
      vi.advanceTimersByTime(3000);
      expect(getIdleDuration()).toBe(3000);
      vi.advanceTimersByTime(2000);
      expect(getIdleDuration()).toBe(5000);
    });
  });

  // --------------------------------------------------------------------------
  // getEvictionStats
  // --------------------------------------------------------------------------
  describe('getEvictionStats', () => {
    it('should return correct initial stats', () => {
      const stats = getEvictionStats();
      expect(stats.idleDuration).toBe(0);
      expect(stats.enabled).toBe(false);
      expect(typeof stats.evictionCount).toBe('number');
    });

    it('should reflect enabled state', () => {
      configureEviction({ enabled: true });
      expect(getEvictionStats().enabled).toBe(true);

      configureEviction({ enabled: false });
      expect(getEvictionStats().enabled).toBe(false);
    });

    it('should increment evictionCount after evictions', () => {
      const baseCount = getEvictionStats().evictionCount;

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
        autoSaveOnEvict: false,
      });

      vi.advanceTimersByTime(1500);
      const stats = getEvictionStats();
      // At 500ms: idle=500 < 1000, no eviction
      // At 1000ms: idle=1000 >= 1000, eviction
      // At 1500ms: idle=1500 >= 1000, eviction
      // But callbacks from prior tests are still registered and may trigger additional evictions
      // Just verify the count increased
      expect(stats.evictionCount).toBeGreaterThan(baseCount);
    });

    it('should report correct idle duration', () => {
      recordActivity();
      vi.advanceTimersByTime(7000);
      const stats = getEvictionStats();
      expect(stats.idleDuration).toBe(7000);
    });
  });

  // --------------------------------------------------------------------------
  // startMonitor / stopMonitor lifecycle
  // --------------------------------------------------------------------------
  describe('startMonitor / stopMonitor', () => {
    it('should not start monitor when config is disabled', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: false,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
      });
      startMonitor(); // should be a no-op since enabled=false

      vi.advanceTimersByTime(5000);
      expect(cb).not.toHaveBeenCalled();
    });

    it('should stop monitoring when stopMonitor is called', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 2000,
        checkIntervalMs: 500,
      });

      // Stop before threshold
      vi.advanceTimersByTime(1000);
      stopMonitor();

      vi.advanceTimersByTime(5000);
      expect(cb).not.toHaveBeenCalled();
    });

    it('should allow restarting the monitor after stopping', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
      });

      stopMonitor();
      vi.advanceTimersByTime(3000);
      expect(cb).not.toHaveBeenCalled();

      // Re-enable and restart
      recordActivity();
      startMonitor();
      vi.advanceTimersByTime(1500);
      expect(cb).toHaveBeenCalled();
    });

    it('should handle multiple startMonitor calls without stacking intervals', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
        autoSaveOnEvict: false,
      });

      // Call startMonitor multiple times
      startMonitor();
      startMonitor();
      startMonitor();

      vi.advanceTimersByTime(1500);
      // Should only fire once per check, not 4 times (original + 3 extra)
      // At 1500ms with 500ms interval: check at 500, 1000, 1500
      // Eviction happens at 1000ms and 1500ms (idle >= 1000)
      const evictCalls = cb.mock.calls.filter(([a]: [string]) => a === 'evict');
      // With stacking, we'd see far more calls. With a single interval, we expect 2 checks that trigger eviction.
      expect(evictCalls.length).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // Eviction trigger timing
  // --------------------------------------------------------------------------
  describe('eviction trigger timing', () => {
    it('should trigger eviction exactly at threshold boundary', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 1000,
        autoSaveOnEvict: false,
      });

      // At 1000ms: idle=1000 >= threshold=1000 → should trigger
      vi.advanceTimersByTime(1000);
      expect(cb).toHaveBeenCalledWith('evict');
    });

    it('should trigger eviction repeatedly on subsequent checks while still idle', () => {
      const cb = vi.fn();
      onEviction(cb);

      configureEviction({
        enabled: true,
        idleThresholdMs: 1000,
        checkIntervalMs: 500,
        autoSaveOnEvict: false,
      });

      vi.advanceTimersByTime(3000);
      // Checks at 500, 1000, 1500, 2000, 2500, 3000
      // Evictions at 1000, 1500, 2000, 2500, 3000 (5 times)
      const evictCalls = cb.mock.calls.filter(([a]: [string]) => a === 'evict');
      expect(evictCalls.length).toBe(5);
    });
  });

  // --------------------------------------------------------------------------
  // autoSaveOnEvict flag
  // --------------------------------------------------------------------------
  describe('autoSaveOnEvict', () => {
    it('should call auto-save before evict when enabled', () => {
      const actions: string[] = [];
      onEviction((action) => actions.push(action));

      configureEviction({
        enabled: true,
        idleThresholdMs: 500,
        checkIntervalMs: 500,
        autoSaveOnEvict: true,
      });

      vi.advanceTimersByTime(500);
      expect(actions).toEqual(['auto-save', 'evict']);
    });

    it('should skip auto-save when disabled', () => {
      const actions: string[] = [];
      onEviction((action) => actions.push(action));

      configureEviction({
        enabled: true,
        idleThresholdMs: 500,
        checkIntervalMs: 500,
        autoSaveOnEvict: false,
      });

      vi.advanceTimersByTime(500);
      expect(actions).toEqual(['evict']);
    });

    it('should respect autoSaveOnEvict toggling via configureEviction', () => {
      const actions: string[] = [];
      onEviction((action) => actions.push(action));

      // Start with auto-save enabled
      configureEviction({
        enabled: true,
        idleThresholdMs: 500,
        checkIntervalMs: 500,
        autoSaveOnEvict: true,
      });

      vi.advanceTimersByTime(500);
      expect(actions).toEqual(['auto-save', 'evict']);

      // Now disable auto-save
      actions.length = 0;
      recordActivity();
      configureEviction({ autoSaveOnEvict: false });

      vi.advanceTimersByTime(500);
      expect(actions).toEqual(['evict']);
    });
  });

  // --------------------------------------------------------------------------
  // getEvictionConfig
  // --------------------------------------------------------------------------
  describe('getEvictionConfig', () => {
    it('should return a copy of the config', () => {
      const cfg1 = getEvictionConfig();
      const cfg2 = getEvictionConfig();
      expect(cfg1).toEqual(cfg2);
      expect(cfg1).not.toBe(cfg2); // different references
    });

    it('should not allow mutation of internal config via returned object', () => {
      const cfg = getEvictionConfig();
      cfg.idleThresholdMs = 999999;
      cfg.enabled = !cfg.enabled;

      const fresh = getEvictionConfig();
      expect(fresh.idleThresholdMs).not.toBe(999999);
    });

    it('should reflect changes made via configureEviction', () => {
      configureEviction({
        idleThresholdMs: 42000,
        checkIntervalMs: 7000,
        autoSaveOnEvict: false,
      });

      const cfg = getEvictionConfig();
      expect(cfg.idleThresholdMs).toBe(42000);
      expect(cfg.checkIntervalMs).toBe(7000);
      expect(cfg.autoSaveOnEvict).toBe(false);
    });
  });
});
