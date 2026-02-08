/**
 * Tests for src/streaming.ts
 *
 * Covers: TokenBuffer (push, flush, getEmitted, reset, smoothing/no-smoothing,
 * formatting preservation), createTypingStream, createSentenceStream,
 * createParagraphStream, createStreamStats, createProgressIndicator,
 * createCursorAnimation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TokenBuffer,
  createTypingStream,
  createSentenceStream,
  createParagraphStream,
  createStreamStats,
  createProgressIndicator,
  createCursorAnimation,
} from '../src/streaming.js';
import type { StreamCallback } from '../src/streaming.js';

// ===========================================================================
// TokenBuffer
// ===========================================================================

describe('TokenBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor defaults', () => {
    it('should default smoothing to true', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb);
      buf.push('hello');
      // With smoothing, nothing emitted immediately (needs timer)
      expect(cb).not.toHaveBeenCalled();
      // After advancing timers, content should emit
      vi.advanceTimersByTime(200);
      expect(cb).toHaveBeenCalled();
      buf.flush();
    });

    it('should respect smoothing: false', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: false });
      buf.push('hello');
      // Without smoothing, emitted immediately
      expect(cb).toHaveBeenCalledWith(expect.any(String), false);
      buf.flush();
    });
  });

  describe('push and emit with no smoothing', () => {
    it('should emit content immediately when smoothing is off', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: false });
      buf.push('Hello ');
      buf.push('world');
      expect(cb).toHaveBeenCalledTimes(2);
      buf.flush();
    });

    it('should pass isFinal=false for pushed content', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: false });
      buf.push('test');
      expect(cb).toHaveBeenCalledWith(expect.any(String), false);
      buf.flush();
    });
  });

  describe('flush', () => {
    it('should emit all remaining buffer content with isFinal=true', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: true });
      buf.push('hello world');
      // Flush without waiting for timers
      buf.flush();
      // Should receive the content with isFinal=true
      const finalCall = cb.mock.calls[cb.mock.calls.length - 1];
      expect(finalCall[1]).toBe(true);
    });

    it('should emit empty string with isFinal=true when buffer is empty', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: false });
      buf.flush();
      expect(cb).toHaveBeenCalledWith('', true);
    });

    it('should clear pending timer on flush', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: true });
      buf.push('hello');
      // Timer is scheduled; flush should clear it
      buf.flush();
      // Advancing timers should not cause additional emissions
      const callCountAfterFlush = cb.mock.calls.length;
      vi.advanceTimersByTime(1000);
      expect(cb.mock.calls.length).toBe(callCountAfterFlush);
    });
  });

  describe('getEmitted', () => {
    it('should return all pushed content', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: false });
      buf.push('hello ');
      buf.push('world');
      expect(buf.getEmitted()).toBe('hello world');
    });

    it('should include both emitted and buffered content', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: true });
      buf.push('hello');
      // With smoothing, content may still be in buffer
      expect(buf.getEmitted()).toBe('hello');
    });

    it('should return empty string when nothing pushed', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb);
      expect(buf.getEmitted()).toBe('');
    });
  });

  describe('reset', () => {
    it('should clear buffer and emitted content', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: false });
      buf.push('hello');
      buf.reset();
      expect(buf.getEmitted()).toBe('');
    });

    it('should clear pending timers', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: true });
      buf.push('hello');
      buf.reset();
      vi.advanceTimersByTime(1000);
      // Only the flush or nothing should have been called
      // After reset, no further emissions
      expect(buf.getEmitted()).toBe('');
    });
  });

  describe('smoothing and word-boundary emission', () => {
    it('should schedule emissions with smoothing enabled', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: true, wordsPerSecond: 30 });
      buf.push('hello world foo bar');
      expect(cb).not.toHaveBeenCalled();
      // Advance enough for all words to emit
      vi.advanceTimersByTime(500);
      expect(cb).toHaveBeenCalled();
      buf.flush();
    });

    it('should not double-schedule when multiple pushes happen before timer fires', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, { smoothing: true, wordsPerSecond: 10 });
      buf.push('hello ');
      buf.push('world ');
      buf.push('foo ');
      // Only one timer should be scheduled; first fire emits accumulated content
      vi.advanceTimersByTime(200);
      expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);
      buf.flush();
    });
  });

  describe('formatting preservation', () => {
    it('should hold incomplete code blocks when preserveFormatting is true', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, {
        smoothing: false,
        preserveFormatting: true,
      });
      // Push an incomplete code block (only opening ```)
      buf.push('before ```code here');
      // The code block is incomplete, so emit should hold content from ``` onward
      // The callback might not emit any content (holding for complete block)
      // Let's flush to get all content
      buf.flush();
      // All content should come out eventually
      const allEmitted = cb.mock.calls.map(c => c[0]).join('');
      expect(allEmitted).toContain('```code here');
    });

    it('should emit complete code blocks', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, {
        smoothing: false,
        preserveFormatting: true,
      });
      buf.push('text ```code``` more');
      const allEmitted = cb.mock.calls.map(c => c[0]).join('');
      expect(allEmitted).toContain('```code```');
      buf.flush();
    });

    it('should emit complete inline code', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, {
        smoothing: false,
        preserveFormatting: true,
        chunkSize: 1,
      });
      // Complete inline code with closing backtick
      buf.push('prefix `code` suffix');
      const allEmitted = cb.mock.calls.map(c => c[0]).join('');
      expect(allEmitted).toContain('`code`');
      buf.flush();
    });

    it('should work when preserveFormatting is false', () => {
      const cb = vi.fn();
      const buf = new TokenBuffer(cb, {
        smoothing: false,
        preserveFormatting: false,
      });
      buf.push('text ```code');
      // Should emit without worrying about formatting
      expect(cb).toHaveBeenCalled();
      buf.flush();
    });
  });
});

// ===========================================================================
// createTypingStream
// ===========================================================================

describe('createTypingStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return a TokenBuffer', () => {
    const cb = vi.fn();
    const stream = createTypingStream(cb);
    expect(stream).toBeInstanceOf(TokenBuffer);
  });

  it('should enable smoothing by default', () => {
    const cb = vi.fn();
    const stream = createTypingStream(cb);
    stream.push('test');
    // With smoothing, nothing emitted synchronously
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(cb).toHaveBeenCalled();
    stream.flush();
  });

  it('should accept custom wordsPerSecond', () => {
    const cb = vi.fn();
    const stream = createTypingStream(cb, { wordsPerSecond: 100 });
    stream.push('hello world');
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalled();
    stream.flush();
  });
});

// ===========================================================================
// createSentenceStream
// ===========================================================================

describe('createSentenceStream', () => {
  it('should emit complete sentences', () => {
    const cb = vi.fn();
    const stream = createSentenceStream(cb);
    stream.push('Hello there. ');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('Hello there. ', false);
  });

  it('should buffer until sentence end', () => {
    const cb = vi.fn();
    const stream = createSentenceStream(cb);
    stream.push('Hello ');
    stream.push('there');
    expect(cb).not.toHaveBeenCalled();
  });

  it('should handle multiple sentence enders', () => {
    const cb = vi.fn();
    const stream = createSentenceStream(cb);
    stream.push('Really? ');
    expect(cb).toHaveBeenCalledWith('Really? ', false);
  });

  it('should detect exclamation marks', () => {
    const cb = vi.fn();
    const stream = createSentenceStream(cb);
    stream.push('Wow! ');
    expect(cb).toHaveBeenCalledWith('Wow! ', false);
  });

  it('should handle sentence built across multiple pushes', () => {
    const cb = vi.fn();
    const stream = createSentenceStream(cb);
    stream.push('Hello ');
    stream.push('world. ');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('Hello world. ', false);
  });

  it('should handle multiple sentences in one push', () => {
    const cb = vi.fn();
    const stream = createSentenceStream(cb);
    stream.push('First sentence. Second sentence. ');
    // First sentence emitted, then remainder triggers second
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  describe('flush', () => {
    it('should emit remaining buffer with isFinal=true', () => {
      const cb = vi.fn();
      const stream = createSentenceStream(cb);
      stream.push('Incomplete sentence');
      stream.flush();
      expect(cb).toHaveBeenCalledWith('Incomplete sentence', true);
    });

    it('should emit empty string with isFinal=true when buffer is empty', () => {
      const cb = vi.fn();
      const stream = createSentenceStream(cb);
      stream.flush();
      expect(cb).toHaveBeenCalledWith('', true);
    });

    it('should clear buffer after flush', () => {
      const cb = vi.fn();
      const stream = createSentenceStream(cb);
      stream.push('Some text');
      stream.flush();
      cb.mockClear();
      stream.flush();
      expect(cb).toHaveBeenCalledWith('', true);
    });
  });
});

// ===========================================================================
// createParagraphStream
// ===========================================================================

describe('createParagraphStream', () => {
  it('should emit on double newline', () => {
    const cb = vi.fn();
    const stream = createParagraphStream(cb);
    stream.push('First paragraph.\n\nSecond');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('First paragraph.\n\n', false);
  });

  it('should buffer until paragraph break', () => {
    const cb = vi.fn();
    const stream = createParagraphStream(cb);
    stream.push('No paragraph break yet\n');
    expect(cb).not.toHaveBeenCalled();
  });

  it('should handle paragraph break across pushes', () => {
    const cb = vi.fn();
    const stream = createParagraphStream(cb);
    stream.push('End of paragraph.\n');
    expect(cb).not.toHaveBeenCalled();
    stream.push('\nStart of next');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('End of paragraph.\n\n', false);
  });

  it('should handle multiple paragraphs in one push', () => {
    const cb = vi.fn();
    const stream = createParagraphStream(cb);
    stream.push('Para one.\n\nPara two.\n\nPara three');
    // At least the first paragraph should be emitted
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  describe('flush', () => {
    it('should emit remaining content with isFinal=true', () => {
      const cb = vi.fn();
      const stream = createParagraphStream(cb);
      stream.push('Unfinished paragraph');
      stream.flush();
      expect(cb).toHaveBeenCalledWith('Unfinished paragraph', true);
    });

    it('should emit empty string with isFinal=true when empty', () => {
      const cb = vi.fn();
      const stream = createParagraphStream(cb);
      stream.flush();
      expect(cb).toHaveBeenCalledWith('', true);
    });
  });
});

// ===========================================================================
// createStreamStats
// ===========================================================================

describe('createStreamStats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start with zero counts', () => {
    const stats = createStreamStats();
    const s = stats.getStats();
    expect(s.tokenCount).toBe(0);
    expect(s.charCount).toBe(0);
    expect(s.wordCount).toBe(0);
  });

  it('should count tokens', () => {
    const stats = createStreamStats();
    stats.track('hello');
    stats.track(' world');
    const s = stats.getStats();
    expect(s.tokenCount).toBe(2);
  });

  it('should count characters', () => {
    const stats = createStreamStats();
    stats.track('hello');
    stats.track(' world');
    const s = stats.getStats();
    expect(s.charCount).toBe(11);
  });

  it('should count words', () => {
    const stats = createStreamStats();
    stats.track('hello world');
    stats.track(' foo bar');
    const s = stats.getStats();
    expect(s.wordCount).toBe(4);
  });

  it('should handle empty tokens for word count', () => {
    const stats = createStreamStats();
    stats.track('');
    const s = stats.getStats();
    expect(s.wordCount).toBe(0);
    expect(s.tokenCount).toBe(1);
    expect(s.charCount).toBe(0);
  });

  it('should calculate tokens per second', () => {
    const stats = createStreamStats();
    stats.track('token1');
    vi.advanceTimersByTime(1000);
    stats.track('token2');
    vi.advanceTimersByTime(1000);
    stats.track('token3');
    const s = stats.getStats();
    expect(s.tokensPerSecond).toBeGreaterThan(0);
    expect(s.tokenCount).toBe(3);
  });

  it('should record start time on first track call', () => {
    const stats = createStreamStats();
    const before = Date.now();
    stats.track('first');
    const s = stats.getStats();
    expect(s.startTime).toBeGreaterThanOrEqual(before);
  });

  describe('reset', () => {
    it('should reset all counters', () => {
      const stats = createStreamStats();
      stats.track('hello world');
      stats.track('foo');
      stats.reset();
      const s = stats.getStats();
      expect(s.tokenCount).toBe(0);
      expect(s.charCount).toBe(0);
      expect(s.wordCount).toBe(0);
    });

    it('should update start time on reset', () => {
      const stats = createStreamStats();
      stats.track('a');
      vi.advanceTimersByTime(5000);
      stats.reset();
      const s = stats.getStats();
      expect(s.startTime).toBe(Date.now());
    });
  });
});

// ===========================================================================
// createProgressIndicator
// ===========================================================================

describe('createProgressIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call updateCallback with spinner frames on start', () => {
    const cb = vi.fn();
    const indicator = createProgressIndicator(cb);
    indicator.start();
    vi.advanceTimersByTime(80);
    expect(cb).toHaveBeenCalled();
    indicator.stop();
  });

  it('should cycle through spinner frames', () => {
    const cb = vi.fn();
    const indicator = createProgressIndicator(cb);
    indicator.start();
    // Advance through several frames
    vi.advanceTimersByTime(80 * 10);
    expect(cb.mock.calls.length).toBe(10);
    indicator.stop();
  });

  it('should include message in output', () => {
    const cb = vi.fn();
    const indicator = createProgressIndicator(cb);
    indicator.update('Loading...');
    indicator.start();
    vi.advanceTimersByTime(80);
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1][0];
    expect(lastCall).toContain('Loading...');
    indicator.stop();
  });

  it('should update message dynamically', () => {
    const cb = vi.fn();
    const indicator = createProgressIndicator(cb);
    indicator.start();
    indicator.update('Step 1');
    vi.advanceTimersByTime(80);
    let lastCall = cb.mock.calls[cb.mock.calls.length - 1][0];
    expect(lastCall).toContain('Step 1');

    indicator.update('Step 2');
    vi.advanceTimersByTime(80);
    lastCall = cb.mock.calls[cb.mock.calls.length - 1][0];
    expect(lastCall).toContain('Step 2');
    indicator.stop();
  });

  it('should not start multiple intervals', () => {
    const cb = vi.fn();
    const indicator = createProgressIndicator(cb);
    indicator.start();
    indicator.start(); // second call should be no-op
    vi.advanceTimersByTime(80);
    // Should only have one interval's worth of calls
    expect(cb.mock.calls.length).toBe(1);
    indicator.stop();
  });

  it('should stop the interval on stop()', () => {
    const cb = vi.fn();
    const indicator = createProgressIndicator(cb);
    indicator.start();
    vi.advanceTimersByTime(80 * 3);
    const countBeforeStop = cb.mock.calls.length;
    indicator.stop();
    vi.advanceTimersByTime(80 * 5);
    expect(cb.mock.calls.length).toBe(countBeforeStop);
  });
});

// ===========================================================================
// createCursorAnimation
// ===========================================================================

describe('createCursorAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should toggle between cursor and space', () => {
    const cb = vi.fn();
    const cursor = createCursorAnimation(cb);
    cursor.start();
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledWith(' ');
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledWith('\u258C'); // ▌
    cursor.stop();
  });

  it('should not start multiple intervals', () => {
    const cb = vi.fn();
    const cursor = createCursorAnimation(cb);
    cursor.start();
    cursor.start();
    vi.advanceTimersByTime(500);
    expect(cb.mock.calls.length).toBe(1);
    cursor.stop();
  });

  it('should emit empty string on stop', () => {
    const cb = vi.fn();
    const cursor = createCursorAnimation(cb);
    cursor.start();
    cursor.stop();
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1];
    expect(lastCall[0]).toBe('');
  });

  it('should stop interval on stop()', () => {
    const cb = vi.fn();
    const cursor = createCursorAnimation(cb);
    cursor.start();
    vi.advanceTimersByTime(500);
    const countBeforeStop = cb.mock.calls.length;
    cursor.stop();
    vi.advanceTimersByTime(2000);
    // Only the stop() call itself should have added one more
    expect(cb.mock.calls.length).toBe(countBeforeStop + 1);
  });
});
