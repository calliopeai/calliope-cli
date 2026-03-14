/**
 * Extended coverage tests for src/streaming.ts
 *
 * Targets remaining uncovered branches:
 * - TokenBuffer.destroy(): clears timers and buffer
 * - TokenBuffer.reset() when no pending timer (no-op branch)
 * - TokenBuffer.flush() when emitTimer is null (no timer to clear)
 * - createProgressIndicator.update() with no argument (undefined msg)
 * - createCursorAnimation.stop() when not started (timer is null)
 * - TokenBuffer: emit() → inlineCodeStart < emitPoint with complete inline code where chunkSize blocks word boundary
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TokenBuffer,
  createProgressIndicator,
  createCursorAnimation,
} from '../src/streaming.js';

// ===========================================================================
// TokenBuffer.destroy()
// ===========================================================================

describe('TokenBuffer - destroy()', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should clear buffer, emitted, and timer on destroy', () => {
    const cb = vi.fn();
    const buf = new TokenBuffer(cb, { smoothing: true });
    buf.push('hello world');
    // timer is pending; destroy clears it
    buf.destroy();

    // After destroy, getEmitted returns empty (buffer and emitted cleared)
    expect(buf.getEmitted()).toBe('');

    // Advancing timers should NOT fire the callback (timer was cleared)
    const callsBefore = cb.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(cb.mock.calls.length).toBe(callsBefore);
  });

  it('should handle destroy when no timer is pending', () => {
    const cb = vi.fn();
    const buf = new TokenBuffer(cb, { smoothing: false });
    buf.push('hello');
    // smoothing=false: immediate emit, no timer
    // destroy with no timer should not throw
    expect(() => buf.destroy()).not.toThrow();
    expect(buf.getEmitted()).toBe('');
  });
});

// ===========================================================================
// TokenBuffer.reset() when no timer pending
// ===========================================================================

describe('TokenBuffer - reset() with no timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should reset cleanly when no timer is pending', () => {
    const cb = vi.fn();
    const buf = new TokenBuffer(cb, { smoothing: false });
    buf.push('hello');
    // smoothing=false: emitted immediately, no timer
    // reset should clear buffer/emitted without timer-clearing
    buf.reset();
    expect(buf.getEmitted()).toBe('');
    expect(() => buf.push('new content')).not.toThrow();
  });
});

// ===========================================================================
// TokenBuffer.flush() when emitTimer is null
// ===========================================================================

describe('TokenBuffer - flush() when no pending timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should handle flush with no pending timer (timer null check)', () => {
    const cb = vi.fn();
    const buf = new TokenBuffer(cb, { smoothing: false });
    // No smoothing: no timer scheduled
    buf.push('content');
    // Clear the mock to check fresh calls
    cb.mockClear();
    // flush with no timer pending (buffer empty after immediate emit)
    buf.flush();
    // Should emit empty string with isFinal=true
    expect(cb).toHaveBeenCalledWith('', true);
  });
});

// ===========================================================================
// createProgressIndicator.update() with undefined msg
// ===========================================================================

describe('createProgressIndicator - update() without argument', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should not update message when called without argument', () => {
    const cb = vi.fn();
    const indicator = createProgressIndicator(cb);
    indicator.update('Initial message');
    indicator.start();

    // Call update without argument — message should stay 'Initial message'
    indicator.update(); // undefined — should not change message
    vi.advanceTimersByTime(80);
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1][0];
    expect(lastCall).toContain('Initial message');

    indicator.stop();
  });
});

// ===========================================================================
// createCursorAnimation.stop() when not started
// ===========================================================================

describe('createCursorAnimation - stop() when not started', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should handle stop() when timer is null (not started)', () => {
    const cb = vi.fn();
    const cursor = createCursorAnimation(cb);
    // Stop without starting — timer is null; the if(timer) check skips clearInterval
    // but updateCallback('') still called
    cursor.stop();
    expect(cb).toHaveBeenCalledWith('');
  });
});

// ===========================================================================
// TokenBuffer - breakPoint <= chunkSize (no word boundary adjustment)
// ===========================================================================

describe('TokenBuffer - emit without word boundary (breakPoint <= chunkSize)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('should emit entire buffer when no space/newline found before emitPoint', () => {
    const cb = vi.fn();
    // chunkSize=100 means lastSpace must be > 100 to adjust emitPoint
    // With a short string of only letters (no spaces), breakPoint = -1 < 100 = chunkSize
    const buf = new TokenBuffer(cb, {
      smoothing: false,
      preserveFormatting: false,
      chunkSize: 100,
    });
    buf.push('nospaces'); // 8 chars, no spaces, emitPoint=8
    // emitPoint(8) > chunkSize(100)? No — 8 is NOT > 100, so word boundary check skipped
    // Actually wait: 8 > 100 is false, so line 110 check fails, we DON'T adjust emitPoint
    // Let's test with content longer than chunkSize but with no spaces:
    // This tests the branch where emitPoint > chunkSize but breakPoint <= chunkSize

    // Fresh buf with small chunkSize to force the breakPoint check
    cb.mockClear();
    const buf2 = new TokenBuffer(cb, {
      smoothing: false,
      preserveFormatting: false,
      chunkSize: 1, // small chunkSize so we enter the word boundary block
    });
    // Push something where lastSpace and lastNewline are both -1 (no spaces/newlines)
    buf2.push('nospaces'); // 8 chars; emitPoint=8 > chunkSize=1
    // lastSpace = -1, lastNewline = -1, breakPoint = max(-1, -1) = -1
    // -1 > 1 (chunkSize) is false → emitPoint unchanged → emits all 8 chars
    const emitted = cb.mock.calls.map(c => c[0]).join('');
    expect(emitted).toBe('nospaces');
    buf2.flush();
  });
});
