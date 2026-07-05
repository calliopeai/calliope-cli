/**
 * Calliope CLI - Improved Streaming
 *
 * Word-by-word streaming with smooth output.
 */

// ============================================================================
// Types
// ============================================================================

export interface StreamOptions {
  wordsPerSecond?: number;  // Target words per second (for smoothing)
  chunkSize?: number;       // Minimum chars before emitting
  smoothing?: boolean;      // Enable word-by-word smoothing
  preserveFormatting?: boolean;  // Preserve markdown formatting
}

export type StreamCallback = (text: string, isFinal: boolean) => void;

// ============================================================================
// Token Buffer
// ============================================================================

export class TokenBuffer {
  private buffer: string = '';
  private emitted: string = '';
  private callback: StreamCallback;
  private options: Required<StreamOptions>;
  private emitTimer: NodeJS.Timeout | null = null;
  private lastEmitTime: number = 0;

  constructor(callback: StreamCallback, options: StreamOptions = {}) {
    this.callback = callback;
    this.options = {
      wordsPerSecond: options.wordsPerSecond || 30,
      chunkSize: options.chunkSize || 1,
      smoothing: options.smoothing !== false,
      preserveFormatting: options.preserveFormatting !== false,
    };
  }

  /**
   * Add tokens to buffer
   */
  push(token: string): void {
    this.buffer += token;
    this.scheduleEmit();
  }

  /**
   * Schedule emission of buffered content
   */
  private scheduleEmit(): void {
    if (this.emitTimer) return;

    if (!this.options.smoothing) {
      // Immediate emission
      this.emit();
      return;
    }

    // Calculate delay for smooth word-by-word output
    const msPerWord = 1000 / this.options.wordsPerSecond;
    const now = Date.now();
    const timeSinceLastEmit = now - this.lastEmitTime;
    const delay = Math.max(0, msPerWord - timeSinceLastEmit);

    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit();
    }, delay);
  }

  /**
   * Emit buffered content
   */
  private emit(): void {
    if (this.buffer.length === 0) return;

    // Find a good break point (word boundary)
    let emitPoint = this.buffer.length;

    if (this.options.preserveFormatting) {
      // Don't break in the middle of markdown elements
      const codeBlockStart = this.buffer.indexOf('```');
      const inlineCodeStart = this.buffer.indexOf('`');

      // If we're in a code block, emit everything up to the closing
      if (codeBlockStart !== -1) {
        const codeBlockEnd = this.buffer.indexOf('```', codeBlockStart + 3);
        if (codeBlockEnd !== -1) {
          emitPoint = codeBlockEnd + 3;
        } else {
          // Still in code block, wait for more
          return;
        }
      }

      // Handle inline code
      if (inlineCodeStart !== -1 && inlineCodeStart < emitPoint) {
        const inlineCodeEnd = this.buffer.indexOf('`', inlineCodeStart + 1);
        if (inlineCodeEnd === -1) {
          // Incomplete inline code, wait
          emitPoint = inlineCodeStart;
        }
      }
    }

    // Find word boundary
    if (emitPoint > this.options.chunkSize) {
      const lastSpace = this.buffer.lastIndexOf(' ', emitPoint);
      const lastNewline = this.buffer.lastIndexOf('\n', emitPoint);
      const breakPoint = Math.max(lastSpace, lastNewline);

      if (breakPoint > this.options.chunkSize) {
        emitPoint = breakPoint + 1;
      }
    }

    // Emit content
    const toEmit = this.buffer.slice(0, emitPoint);
    this.buffer = this.buffer.slice(emitPoint);
    this.emitted += toEmit;
    this.lastEmitTime = Date.now();

    this.callback(toEmit, false);

    // Schedule next emission if there's more content
    if (this.buffer.length > 0) {
      this.scheduleEmit();
    }
  }

  /**
   * Flush all remaining content
   */
  flush(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }

    if (this.buffer.length > 0) {
      const remaining = this.buffer;
      this.buffer = '';
      this.emitted += remaining;
      this.callback(remaining, true);
    } else {
      this.callback('', true);
    }
  }

  /**
   * Get all emitted content
   */
  getEmitted(): string {
    return this.emitted + this.buffer;
  }

  /**
   * Reset buffer
   */
  reset(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.buffer = '';
    this.emitted = '';
  }

  /**
   * Destroy the buffer, clearing any pending timers
   */
  destroy(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.buffer = '';
    this.emitted = '';
    this.callback = () => {};
  }
}

// ============================================================================
// Frame-bounded stream flusher
// ============================================================================

export interface StreamFlusher {
  /** Buffer a token. The first token flushes synchronously (leading edge);
   *  subsequent tokens are coalesced and flushed at most once per interval. */
  push(token: string): void;
  /** Flush any buffered tail immediately — call on stream completion so the
   *  last tokens are never dropped. No-op when nothing is buffered. */
  flush(): void;
  /** Cancel: clear the pending timer and drop buffered tokens — call on
   *  error/cancel paths so a queued flush can't fire after teardown. */
  destroy(): void;
}

/**
 * Coalesce streamed tokens so UI updates are frame-rate-bounded.
 *
 * Providers invoke `onToken` once per token; forwarding each straight to a React
 * setState re-renders the transcript on every token — a full-frame redraw per
 * token on a fast stream. This batches tokens and calls `onFlush` with the
 * concatenated delta at most once per `intervalMs` (default 33ms ≈ 30fps). The
 * first token flushes synchronously so perceived latency is unchanged.
 *
 * Distinct from {@link TokenBuffer}, which smooths on word/markdown boundaries
 * for a typing effect and can withhold content mid-code-block: this is purely a
 * time throttle and never holds tokens back on content boundaries.
 */
export function createStreamFlusher(
  onFlush: (delta: string) => void,
  intervalMs = 33,
): StreamFlusher {
  let pending = '';
  let timer: NodeJS.Timeout | null = null;
  let lastFlush = Number.NEGATIVE_INFINITY;

  const emit = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const delta = pending;
    pending = '';
    lastFlush = Date.now();
    onFlush(delta);
  };

  const schedule = (): void => {
    if (timer) return; // a trailing flush is already queued
    const wait = intervalMs - (Date.now() - lastFlush);
    if (wait <= 0) {
      emit(); // leading edge — enough time has passed, flush now
    } else {
      timer = setTimeout(emit, wait);
    }
  };

  return {
    push(token: string): void {
      if (token.length === 0) return;
      pending += token;
      schedule();
    },
    flush(): void {
      emit();
    },
    destroy(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = '';
    },
  };
}

// ============================================================================
// Stream Transformers
// ============================================================================

/**
 * Transform stream to add typing effect
 */
export function createTypingStream(
  callback: StreamCallback,
  options: StreamOptions = {}
): TokenBuffer {
  return new TokenBuffer(callback, {
    ...options,
    smoothing: true,
    wordsPerSecond: options.wordsPerSecond || 40,
  });
}

/**
 * Transform stream to accumulate and emit by sentence
 */
export function createSentenceStream(callback: StreamCallback): {
  push: (token: string) => void;
  flush: () => void;
} {
  let buffer = '';

  const sentenceEnders = /[.!?]\s+/;

  return {
    push(token: string): void {
      buffer += token;

      // Check for sentence end
      const match = buffer.match(sentenceEnders);
      if (match) {
        const endIndex = match.index! + match[0].length;
        const sentence = buffer.slice(0, endIndex);
        buffer = buffer.slice(endIndex);
        callback(sentence, false);
      }
    },

    flush(): void {
      if (buffer.length > 0) {
        callback(buffer, true);
        buffer = '';
      } else {
        callback('', true);
      }
    },
  };
}

/**
 * Transform stream to group by paragraphs
 */
export function createParagraphStream(callback: StreamCallback): {
  push: (token: string) => void;
  flush: () => void;
} {
  let buffer = '';

  return {
    push(token: string): void {
      buffer += token;

      // Check for paragraph break (double newline)
      const paragraphBreak = buffer.indexOf('\n\n');
      if (paragraphBreak !== -1) {
        const paragraph = buffer.slice(0, paragraphBreak + 2);
        buffer = buffer.slice(paragraphBreak + 2);
        callback(paragraph, false);
      }
    },

    flush(): void {
      if (buffer.length > 0) {
        callback(buffer, true);
        buffer = '';
      } else {
        callback('', true);
      }
    },
  };
}

// ============================================================================
// Stream Statistics
// ============================================================================

export interface StreamStats {
  startTime: number;
  tokenCount: number;
  charCount: number;
  wordCount: number;
  tokensPerSecond: number;
}

/**
 * Track streaming statistics
 */
export function createStreamStats(): {
  track: (token: string) => void;
  getStats: () => StreamStats;
  reset: () => void;
} {
  let startTime = Date.now();
  let tokenCount = 0;
  let charCount = 0;
  let wordCount = 0;

  return {
    track(token: string): void {
      if (tokenCount === 0) {
        startTime = Date.now();
      }
      tokenCount++;
      charCount += token.length;
      wordCount += token.split(/\s+/).filter(Boolean).length;
    },

    getStats(): StreamStats {
      const elapsed = (Date.now() - startTime) / 1000;
      return {
        startTime,
        tokenCount,
        charCount,
        wordCount,
        tokensPerSecond: elapsed > 0 ? tokenCount / elapsed : 0,
      };
    },

    reset(): void {
      startTime = Date.now();
      tokenCount = 0;
      charCount = 0;
      wordCount = 0;
    },
  };
}

// ============================================================================
// Progress Indicators
// ============================================================================

/**
 * Create a streaming progress indicator
 */
export function createProgressIndicator(
  updateCallback: (indicator: string) => void
): {
  start: () => void;
  update: (message?: string) => void;
  stop: () => void;
} {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;
  let timer: NodeJS.Timeout | null = null;
  let message = '';

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        frameIndex = (frameIndex + 1) % frames.length;
        updateCallback(`${frames[frameIndex]} ${message}`);
      }, 80);
    },

    update(msg?: string): void {
      if (msg !== undefined) {
        message = msg;
      }
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

// ============================================================================
// Cursor Animation
// ============================================================================

/**
 * Create blinking cursor for streaming
 */
export function createCursorAnimation(
  updateCallback: (cursor: string) => void
): {
  start: () => void;
  stop: () => void;
} {
  let visible = true;
  let timer: NodeJS.Timeout | null = null;

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        visible = !visible;
        updateCallback(visible ? '▌' : ' ');
      }, 500);
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      updateCallback('');
    },
  };
}
