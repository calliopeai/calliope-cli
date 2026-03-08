import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  configureTimeout,
  onTimeout,
  recordActivity,
  getIdleDuration,
  getTimeRemaining,
  isWarning,
  formatTimeRemaining,
  clearTimers,
  getTimeoutConfig,
} from '../src/session-timeout.js';
import type { SessionTimeoutConfig, TimeoutCallback } from '../src/session-timeout.js';

describe('session-timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset to disabled state
    configureTimeout({ enabled: false, idleTimeoutMs: 2 * 60 * 60 * 1000, warningBeforeMs: 5 * 60 * 1000 });
    onTimeout(() => {});
  });

  afterEach(() => {
    clearTimers();
    vi.useRealTimers();
  });

  // ============================================================================
  // configureTimeout
  // ============================================================================

  describe('configureTimeout', () => {
    it('should enable timeout with default config', () => {
      configureTimeout({ enabled: true });
      const cfg = getTimeoutConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.idleTimeoutMs).toBe(7200000);
      expect(cfg.warningBeforeMs).toBe(300000);
    });

    it('should disable timeout and clear timers', () => {
      configureTimeout({ enabled: true });
      configureTimeout({ enabled: false });
      const cfg = getTimeoutConfig();
      expect(cfg.enabled).toBe(false);
    });

    it('should accept custom timeout values', () => {
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });
      const cfg = getTimeoutConfig();
      expect(cfg.idleTimeoutMs).toBe(60000);
      expect(cfg.warningBeforeMs).toBe(10000);
    });

    it('should merge partial options with existing config', () => {
      configureTimeout({ idleTimeoutMs: 90000 });
      configureTimeout({ warningBeforeMs: 15000 });
      const cfg = getTimeoutConfig();
      expect(cfg.idleTimeoutMs).toBe(90000);
      expect(cfg.warningBeforeMs).toBe(15000);
    });
  });

  // ============================================================================
  // onTimeout callback
  // ============================================================================

  describe('onTimeout', () => {
    it('should fire warning callback at the right time', () => {
      const cb = vi.fn();
      onTimeout(cb);
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });

      // Advance to just before warning (50000ms)
      vi.advanceTimersByTime(49999);
      expect(cb).not.toHaveBeenCalled();

      // Advance past warning delay
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledWith('warning');
    });

    it('should fire timeout callback when idle timeout expires', () => {
      const cb = vi.fn();
      onTimeout(cb);
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });

      vi.advanceTimersByTime(60000);
      expect(cb).toHaveBeenCalledWith('timeout');
    });

    it('should fire both warning and timeout in order', () => {
      const calls: string[] = [];
      onTimeout((type) => calls.push(type));
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });

      vi.advanceTimersByTime(60000);
      expect(calls).toEqual(['warning', 'timeout']);
    });

    it('should not fire callbacks when disabled', () => {
      const cb = vi.fn();
      onTimeout(cb);
      configureTimeout({ enabled: false, idleTimeoutMs: 60000, warningBeforeMs: 10000 });

      vi.advanceTimersByTime(120000);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // recordActivity
  // ============================================================================

  describe('recordActivity', () => {
    it('should reset idle timer when enabled', () => {
      const cb = vi.fn();
      onTimeout(cb);
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });

      // Advance 40s then record activity
      vi.advanceTimersByTime(40000);
      recordActivity();

      // Advance another 40s (total 80s since start, but only 40s since last activity)
      vi.advanceTimersByTime(40000);
      // Warning should not have fired yet for the original timer at 50s
      // but a new warning was set at 40000 + 50000 = 90000 from start
      expect(cb).not.toHaveBeenCalledWith('timeout');
    });

    it('should reset the warning timer on activity', () => {
      const cb = vi.fn();
      onTimeout(cb);
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });

      // At 49s, almost at warning. Record activity to reset.
      vi.advanceTimersByTime(49000);
      expect(cb).not.toHaveBeenCalled();
      recordActivity();

      // Now 49000 + 49999 = ~98s from start, but only 49999ms since activity
      vi.advanceTimersByTime(49999);
      expect(cb).not.toHaveBeenCalledWith('warning');

      // One more ms triggers warning (50000ms since last activity)
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledWith('warning');
    });

    it('should update lastActivity timestamp', () => {
      vi.advanceTimersByTime(5000);
      recordActivity();
      expect(getIdleDuration()).toBe(0);
    });

    it('should not reset timers when disabled', () => {
      configureTimeout({ enabled: false });
      const cb = vi.fn();
      onTimeout(cb);
      recordActivity();
      vi.advanceTimersByTime(999999999);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // getIdleDuration
  // ============================================================================

  describe('getIdleDuration', () => {
    it('should return 0 immediately after recordActivity', () => {
      recordActivity();
      expect(getIdleDuration()).toBe(0);
    });

    it('should increase over time', () => {
      recordActivity();
      vi.advanceTimersByTime(30000);
      expect(getIdleDuration()).toBe(30000);
    });

    it('should reset after recordActivity', () => {
      recordActivity();
      vi.advanceTimersByTime(10000);
      expect(getIdleDuration()).toBe(10000);
      recordActivity();
      expect(getIdleDuration()).toBe(0);
    });
  });

  // ============================================================================
  // getTimeRemaining
  // ============================================================================

  describe('getTimeRemaining', () => {
    it('should return null when disabled', () => {
      configureTimeout({ enabled: false });
      expect(getTimeRemaining()).toBeNull();
    });

    it('should return full timeout when just configured', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000 });
      expect(getTimeRemaining()).toBe(60000);
    });

    it('should decrease over time', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000 });
      vi.advanceTimersByTime(20000);
      expect(getTimeRemaining()).toBe(40000);
    });

    it('should not go below 0', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000 });
      vi.advanceTimersByTime(120000);
      expect(getTimeRemaining()).toBe(0);
    });

    it('should reset after recordActivity', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000 });
      vi.advanceTimersByTime(30000);
      expect(getTimeRemaining()).toBe(30000);
      recordActivity();
      expect(getTimeRemaining()).toBe(60000);
    });
  });

  // ============================================================================
  // isWarning
  // ============================================================================

  describe('isWarning', () => {
    it('should return false when disabled', () => {
      configureTimeout({ enabled: false });
      expect(isWarning()).toBe(false);
    });

    it('should return false when plenty of time remains', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });
      expect(isWarning()).toBe(false);
    });

    it('should return true when within warning period', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });
      vi.advanceTimersByTime(51000); // 9s remaining, within 10s warning
      expect(isWarning()).toBe(true);
    });

    it('should return true at exactly the warning boundary', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });
      vi.advanceTimersByTime(50000); // exactly 10s remaining
      expect(isWarning()).toBe(true);
    });

    it('should return true when timeout has passed (0 remaining)', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });
      vi.advanceTimersByTime(70000);
      expect(isWarning()).toBe(true);
    });
  });

  // ============================================================================
  // formatTimeRemaining
  // ============================================================================

  describe('formatTimeRemaining', () => {
    it('should return null when disabled', () => {
      configureTimeout({ enabled: false });
      expect(formatTimeRemaining()).toBeNull();
    });

    it('should format hours and minutes', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 2 * 60 * 60 * 1000 }); // 2 hours
      // Just configured, ~2h remaining
      expect(formatTimeRemaining()).toBe('2h 0m');
    });

    it('should format minutes and seconds', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 600000 }); // 10 min
      vi.advanceTimersByTime(300000); // 5 min elapsed
      expect(formatTimeRemaining()).toBe('5m 0s');
    });

    it('should format seconds only when under a minute', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000 });
      vi.advanceTimersByTime(55000); // 5s left
      expect(formatTimeRemaining()).toBe('5s');
    });

    it('should show 0s when fully elapsed', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60000 });
      vi.advanceTimersByTime(120000);
      expect(formatTimeRemaining()).toBe('0s');
    });

    it('should format mixed hours and minutes', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 5400000 }); // 1h 30m
      expect(formatTimeRemaining()).toBe('1h 30m');
    });

    it('should format 61 minutes correctly (in hours)', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 61 * 60 * 1000 }); // 61 min
      expect(formatTimeRemaining()).toBe('1h 1m');
    });

    it('should format exactly 60 minutes as minutes and seconds', () => {
      recordActivity();
      configureTimeout({ enabled: true, idleTimeoutMs: 60 * 60 * 1000 }); // 60 min
      // 60 min = 60m 0s (not hours, because mins > 60 is the threshold)
      expect(formatTimeRemaining()).toBe('60m 0s');
    });
  });

  // ============================================================================
  // clearTimers
  // ============================================================================

  describe('clearTimers', () => {
    it('should prevent warning callback from firing', () => {
      const cb = vi.fn();
      onTimeout(cb);
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });

      clearTimers();
      vi.advanceTimersByTime(120000);
      expect(cb).not.toHaveBeenCalled();
    });

    it('should prevent timeout callback from firing', () => {
      const cb = vi.fn();
      onTimeout(cb);
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });

      clearTimers();
      vi.advanceTimersByTime(120000);
      expect(cb).not.toHaveBeenCalledWith('timeout');
    });

    it('should be safe to call multiple times', () => {
      clearTimers();
      clearTimers();
      clearTimers();
      // No error thrown
    });

    it('should be safe to call when no timers are set', () => {
      configureTimeout({ enabled: false });
      clearTimers();
      // No error thrown
    });
  });

  // ============================================================================
  // getTimeoutConfig
  // ============================================================================

  describe('getTimeoutConfig', () => {
    it('should return a copy of the config', () => {
      configureTimeout({ enabled: true, idleTimeoutMs: 60000, warningBeforeMs: 10000 });
      const cfg1 = getTimeoutConfig();
      const cfg2 = getTimeoutConfig();
      expect(cfg1).toEqual(cfg2);
      expect(cfg1).not.toBe(cfg2); // Different object references
    });

    it('should not be affected by mutations to the returned object', () => {
      configureTimeout({ enabled: true, idleTimeoutMs: 60000 });
      const cfg = getTimeoutConfig();
      cfg.idleTimeoutMs = 999;
      expect(getTimeoutConfig().idleTimeoutMs).toBe(60000);
    });

    it('should reflect the latest configuration', () => {
      configureTimeout({ enabled: false });
      expect(getTimeoutConfig().enabled).toBe(false);
      configureTimeout({ enabled: true });
      expect(getTimeoutConfig().enabled).toBe(true);
    });

    it('should have correct defaults initially', () => {
      const cfg = getTimeoutConfig();
      expect(cfg.idleTimeoutMs).toBe(7200000);
      expect(cfg.warningBeforeMs).toBe(300000);
    });
  });
});
