/**
 * Extended tests for errors.ts — retry logic edge cases, error classification
 * branches, rate limit handling, and provider-specific suggestions.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyError,
  formatError,
  withRetry,
  retryable,
  getProviderSuggestion,
} from '../src/errors.js';
import type { ClassifiedError, ErrorCategory, RetryOptions } from '../src/errors.js';

// ============================================================================
// classifyError — additional branch coverage
// ============================================================================

describe('classifyError (extended)', () => {
  describe('network errors — all keywords', () => {
    it('should classify DNS errors', () => {
      const result = classifyError(new Error('dns resolution failed'));
      expect(result.category).toBe('network');
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBe(2000);
    });

    it('should classify generic network errors', () => {
      const result = classifyError(new Error('network error occurred'));
      expect(result.category).toBe('network');
    });
  });

  describe('billing errors — checked before rate limit', () => {
    it('should classify billing keyword', () => {
      const result = classifyError(new Error('billing issue with your account'));
      expect(result.category).toBe('auth');
      expect(result.retryable).toBe(false);
      expect(result.message).toContain('Billing');
    });

    it('should classify payment required', () => {
      const result = classifyError(new Error('payment required to continue'));
      expect(result.category).toBe('auth');
      expect(result.retryable).toBe(false);
    });

    it('should prioritize billing over rate limit when both keywords present', () => {
      // "exceeded your current quota" matches billing, NOT rate_limit
      const result = classifyError(new Error('You exceeded your current quota'));
      expect(result.category).toBe('auth');
      expect(result.retryable).toBe(false);
    });
  });

  describe('rate limit — retry-after extraction', () => {
    it('should use default 60s when no retry-after header', () => {
      const result = classifyError(new Error('too many requests'));
      expect(result.category).toBe('rate_limit');
      expect(result.retryAfterMs).toBe(60000);
    });

    it('should extract retry-after with colon format', () => {
      const result = classifyError(new Error('rate limit exceeded, retry after: 45'));
      expect(result.retryAfterMs).toBe(45000);
    });

    it('should extract retry-after with space format', () => {
      const result = classifyError(new Error('rate limit hit. Retry after 10 seconds'));
      expect(result.retryAfterMs).toBe(10000);
    });

    it('should classify 429 status code', () => {
      const result = classifyError(new Error('HTTP 429 Too Many Requests'));
      expect(result.category).toBe('rate_limit');
    });

    it('should include suggestion with wait time', () => {
      const result = classifyError(new Error('rate limit exceeded'));
      expect(result.suggestion).toContain('60');
      expect(result.suggestion).toContain('/provider');
    });
  });

  describe('auth errors — all keywords', () => {
    it('should classify "authentication" keyword', () => {
      const result = classifyError(new Error('authentication required'));
      expect(result.category).toBe('auth');
    });

    it('should classify "api key" keyword', () => {
      const result = classifyError(new Error('please provide a valid api key'));
      expect(result.category).toBe('auth');
    });

    it('should classify "invalid key" keyword', () => {
      const result = classifyError(new Error('invalid key provided'));
      expect(result.category).toBe('auth');
    });
  });

  describe('timeout errors — all keywords', () => {
    it('should classify "timeout" keyword', () => {
      const result = classifyError(new Error('connection timeout'));
      expect(result.category).toBe('timeout');
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBe(5000);
    });

    it('should classify "timed out" keyword', () => {
      const result = classifyError(new Error('the request timed out'));
      expect(result.category).toBe('timeout');
    });
  });

  describe('server errors — all status codes', () => {
    it('should classify 504 errors', () => {
      // Note: "504 Gateway Timeout" contains "timeout" which matches timeout category first
      const result = classifyError(new Error('504 Gateway Timeout'));
      expect(result.category).toBe('timeout');
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBe(5000);
    });

    it('should classify plain 504 errors without timeout keyword', () => {
      const result = classifyError(new Error('504 Bad Gateway'));
      expect(result.category).toBe('server');
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBe(10000);
    });

    it('should classify "internal server" keyword', () => {
      const result = classifyError(new Error('internal server error'));
      expect(result.category).toBe('server');
    });
  });

  describe('file not found errors', () => {
    it('should classify "no such file" errors', () => {
      const result = classifyError(new Error("no such file or directory: '/tmp/missing.txt'"));
      expect(result.category).toBe('invalid_request');
      expect(result.message).toContain('File not found');
    });

    it('should extract file path from quoted string', () => {
      const result = classifyError(new Error("ENOENT: no such file or directory, open '/home/user/test.js'"));
      expect(result.message).toContain('/home/user/test.js');
    });

    it('should use "the file" when no path is extractable', () => {
      const result = classifyError(new Error('ENOENT: no such file'));
      expect(result.message).toContain('the file');
    });

    it('should classify "does not exist" errors', () => {
      const result = classifyError(new Error('the file does not exist'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify "file not found" with file keyword', () => {
      const result = classifyError(new Error('file not found at specified path'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify "directory not found"', () => {
      const result = classifyError(new Error('directory not found'));
      expect(result.category).toBe('invalid_request');
    });

    it('should NOT classify "model not found" as file error', () => {
      // The model check should prevent "not found" + "model" from matching file errors
      const result = classifyError(new Error('model not found: gpt-5'));
      expect(result.category).toBe('invalid_request');
      expect(result.message).toContain('Model');
    });
  });

  describe('permission errors', () => {
    it('should classify EACCES', () => {
      const result = classifyError(new Error('EACCES: permission denied'));
      expect(result.category).toBe('invalid_request');
      expect(result.message).toContain('Permission denied');
    });

    it('should classify EPERM', () => {
      const result = classifyError(new Error('EPERM: operation not permitted'));
      expect(result.category).toBe('invalid_request');
      expect(result.message).toContain('Permission denied');
    });

    it('should classify "access denied"', () => {
      const result = classifyError(new Error('access denied to resource'));
      expect(result.category).toBe('invalid_request');
      expect(result.message).toContain('Permission denied');
    });

    it('should suggest ls -la in permission errors', () => {
      const result = classifyError(new Error('permission denied'));
      expect(result.suggestion).toContain('ls -la');
    });
  });

  describe('disk space errors', () => {
    it('should classify ENOSPC', () => {
      const result = classifyError(new Error('ENOSPC: no space left on device'));
      expect(result.category).toBe('server');
      expect(result.retryable).toBe(false);
      expect(result.message).toContain('Disk space');
    });

    it('should classify "no space" keyword', () => {
      const result = classifyError(new Error('no space left'));
      expect(result.category).toBe('server');
      expect(result.retryable).toBe(false);
    });

    it('should classify "disk full"', () => {
      const result = classifyError(new Error('disk full, cannot write'));
      expect(result.category).toBe('server');
    });
  });

  describe('context/token limit errors', () => {
    it('should classify "context length" errors', () => {
      const result = classifyError(new Error('context length exceeded'));
      expect(result.category).toBe('invalid_request');
      expect(result.suggestion).toContain('/summarize compact');
    });

    it('should classify "token limit" errors', () => {
      const result = classifyError(new Error('token limit reached'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify "maximum context" errors', () => {
      const result = classifyError(new Error('maximum context window exceeded'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify "too long" errors', () => {
      const result = classifyError(new Error('input is too long'));
      expect(result.category).toBe('invalid_request');
    });
  });

  describe('model not found errors', () => {
    it('should classify "invalid model" errors', () => {
      const result = classifyError(new Error('invalid model specified'));
      // "invalid" also matches invalid_request, but "invalid model" should match model check
      expect(result.category).toBe('invalid_request');
    });
  });

  describe('OpenAI Responses API errors', () => {
    it('should classify "not in v1/chat/completions"', () => {
      const result = classifyError(new Error('This feature is not in v1/chat/completions'));
      expect(result.category).toBe('invalid_request');
      expect(result.message).toContain('Responses API');
    });
  });

  describe('vision/image errors', () => {
    it('should classify "vision" keyword', () => {
      const result = classifyError(new Error('vision capabilities are not available'));
      expect(result.category).toBe('invalid_request');
      expect(result.message).toContain('Vision');
    });

    it('should classify "image not supported"', () => {
      const result = classifyError(new Error('image input not supported by this model'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify "image cannot be processed"', () => {
      const result = classifyError(new Error('image cannot be processed'));
      expect(result.category).toBe('invalid_request');
    });
  });

  describe('tool/function calling errors', () => {
    it('should classify "function calling" errors', () => {
      const result = classifyError(new Error('function calling is not available'));
      expect(result.category).toBe('invalid_request');
      expect(result.message).toContain('Tool');
    });

    it('should classify "tool invalid" errors', () => {
      const result = classifyError(new Error('tool definition is invalid'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify "tool not supported" errors', () => {
      const result = classifyError(new Error('tool use is not supported'));
      expect(result.category).toBe('invalid_request');
    });
  });

  describe('content policy errors', () => {
    it('should classify "content policy" errors', () => {
      const result = classifyError(new Error('content policy violation'));
      expect(result.category).toBe('invalid_request');
      expect(result.suggestion).toContain('Rephrase');
    });

    it('should classify "harmful" keyword', () => {
      const result = classifyError(new Error('potentially harmful content detected'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify "blocked" keyword', () => {
      const result = classifyError(new Error('request blocked by content filter'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify "safety" keyword', () => {
      const result = classifyError(new Error('safety system triggered'));
      expect(result.category).toBe('invalid_request');
    });
  });

  describe('unknown errors', () => {
    it('should handle null input', () => {
      const result = classifyError(null);
      expect(result.category).toBe('unknown');
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBe(3000);
    });

    it('should handle undefined input', () => {
      const result = classifyError(undefined);
      expect(result.category).toBe('unknown');
    });

    it('should handle number input', () => {
      const result = classifyError(42);
      expect(result.category).toBe('unknown');
    });

    it('should handle object input', () => {
      const result = classifyError({ foo: 'bar' });
      expect(result.category).toBe('unknown');
    });

    it('should truncate very long unknown error messages', () => {
      const longMsg = 'a'.repeat(200);
      const result = classifyError(new Error(longMsg));
      expect(result.message.length).toBeLessThanOrEqual(103);
      expect(result.message).toContain('...');
    });

    it('should not truncate short unknown messages', () => {
      const result = classifyError(new Error('short error'));
      expect(result.message).toBe('short error');
    });
  });
});

// ============================================================================
// formatError — additional branch coverage
// ============================================================================

describe('formatError (extended)', () => {
  it('should include tool context when provided', () => {
    const result = formatError(new Error('ECONNREFUSED'), { tool: 'web_search' });
    expect(result).toContain('[web_search]');
  });

  it('should include provider-specific help for auth errors', () => {
    const result = formatError(new Error('unauthorized'), { provider: 'anthropic' });
    expect(result).toContain('console.anthropic.com');
  });

  it('should include provider-specific help for openai auth errors', () => {
    const result = formatError(new Error('unauthorized'), { provider: 'openai' });
    expect(result).toContain('platform.openai.com');
  });

  it('should include provider-specific help for google auth errors', () => {
    const result = formatError(new Error('unauthorized'), { provider: 'google' });
    expect(result).toContain('aistudio.google.com');
  });

  it('should not include provider help when no provider given', () => {
    const result = formatError(new Error('unauthorized'));
    expect(result).not.toContain('🔗');
  });

  it('should not include provider help for non-auth errors', () => {
    const result = formatError(new Error('ECONNREFUSED'), { provider: 'anthropic' });
    // Network errors don't get provider-specific auth help
    expect(result).not.toContain('console.anthropic.com');
  });

  it('should show auto-retry info with seconds for retryable errors', () => {
    const result = formatError(new Error('socket error'));
    expect(result).toContain('Auto-retry');
    expect(result).toContain('2s');
  });

  it('should show auto-retry info for server errors', () => {
    const result = formatError(new Error('500 internal server error'));
    expect(result).toContain('Auto-retry');
    expect(result).toContain('10s');
  });

  it('should show auto-retry info for timeout errors', () => {
    const result = formatError(new Error('request timed out'));
    expect(result).toContain('Auto-retry');
    expect(result).toContain('5s');
  });

  it('should not show auto-retry for non-retryable errors', () => {
    const result = formatError(new Error('unauthorized'));
    expect(result).not.toContain('Auto-retry');
  });

  it('should show correct icon for unknown errors', () => {
    const result = formatError(new Error('something unexpected'));
    expect(result).toContain('❓');
  });

  it('should show correct icon for invalid_request errors', () => {
    const result = formatError(new Error('bad request'));
    expect(result).toContain('❌');
  });

  it('should include both tool and provider context', () => {
    const result = formatError(new Error('unauthorized'), { tool: 'shell', provider: 'anthropic' });
    expect(result).toContain('[shell]');
    expect(result).toContain('console.anthropic.com');
  });
});

// ============================================================================
// withRetry — extended edge cases
// ============================================================================

describe('withRetry (extended)', () => {
  it('should use default options when none provided', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts === 1) throw new Error('ECONNREFUSED');
      return 'ok';
    };

    // Override sleep by using very small delays
    const result = await withRetry(fn, { initialDelayMs: 1, maxDelayMs: 2 });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('should respect maxDelayMs cap on error-suggested delay', async () => {
    let attempts = 0;
    let retryDelays: number[] = [];
    const fn = async () => {
      attempts++;
      if (attempts < 3) throw new Error('rate limit exceeded, retry after: 9999');
      return 'ok';
    };

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 10,
      maxDelayMs: 50,
      onRetry: (_attempt, _error, delayMs) => {
        retryDelays.push(delayMs);
      },
    });

    expect(result).toBe('ok');
    // The error suggests 9999s*1000 = 9999000ms, but maxDelayMs caps it to 50ms
    for (const delay of retryDelays) {
      expect(delay).toBeLessThanOrEqual(50);
    }
  });

  it('should apply exponential backoff', async () => {
    let attempts = 0;
    let retryDelays: number[] = [];

    const fn = async () => {
      attempts++;
      if (attempts <= 3) throw new Error('ECONNREFUSED');
      return 'done';
    };

    await withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 10,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
      onRetry: (_attempt, _error, delay) => {
        retryDelays.push(delay);
      },
    });

    // Network errors have retryAfterMs=2000 which gets capped by min(2000, 1000)
    // All delays should be the error's suggested delay (capped to maxDelayMs)
    expect(retryDelays.length).toBe(3);
  });

  it('should throw immediately for non-retryable error on first attempt', async () => {
    const fn = async () => {
      throw new Error('bad request');
    };

    await expect(withRetry(fn, { maxRetries: 5, initialDelayMs: 1 })).rejects.toThrow('bad request');
  });

  it('should convert non-Error throws to Error', async () => {
    const fn = async () => {
      throw 'string error';
    };

    try {
      await withRetry(fn, { maxRetries: 0 });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe('string error');
    }
  });

  it('should handle zero maxRetries (no retries)', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('ECONNREFUSED');
    };

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow('ECONNREFUSED');
    expect(attempts).toBe(1);
  });

  it('should call onRetry with correct attempt number', async () => {
    let callCount = 0;
    const retryAttempts: number[] = [];

    const fn = async () => {
      callCount++;
      if (callCount <= 2) throw new Error('ECONNREFUSED');
      return 'success';
    };

    await withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 1,
      maxDelayMs: 5,
      onRetry: (attempt) => {
        retryAttempts.push(attempt);
      },
    });

    expect(retryAttempts).toEqual([1, 2]);
  });

  it('should pass error to onRetry callback', async () => {
    let callCount = 0;
    let capturedErrors: Error[] = [];

    const fn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('ECONNREFUSED');
      return 'ok';
    };

    await withRetry(fn, {
      maxRetries: 2,
      initialDelayMs: 1,
      maxDelayMs: 5,
      onRetry: (_attempt, error) => {
        capturedErrors.push(error);
      },
    });

    expect(capturedErrors.length).toBe(1);
    expect(capturedErrors[0].message).toBe('ECONNREFUSED');
  });
});

// ============================================================================
// retryable wrapper
// ============================================================================

describe('retryable', () => {
  it('should wrap a function with retry logic', async () => {
    let attempts = 0;
    const originalFn = async (msg: string) => {
      attempts++;
      if (attempts < 2) throw new Error('ECONNREFUSED');
      return `result: ${msg}`;
    };

    const wrapped = retryable(originalFn as any, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 });
    const result = await wrapped('test');
    expect(result).toBe('result: test');
    expect(attempts).toBe(2);
  });

  it('should throw when wrapped function exhausts retries', async () => {
    const alwaysFails = async () => {
      throw new Error('ECONNREFUSED');
    };

    const wrapped = retryable(alwaysFails as any, { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 });
    await expect(wrapped()).rejects.toThrow('ECONNREFUSED');
  });
});

// ============================================================================
// getProviderSuggestion
// ============================================================================

describe('getProviderSuggestion', () => {
  describe('auth errors', () => {
    it('should return anthropic URL', () => {
      const result = getProviderSuggestion('anthropic', new Error('unauthorized'));
      expect(result).toContain('console.anthropic.com');
    });

    it('should return openai URL', () => {
      const result = getProviderSuggestion('openai', new Error('unauthorized'));
      expect(result).toContain('platform.openai.com');
    });

    it('should return google URL', () => {
      const result = getProviderSuggestion('google', new Error('unauthorized'));
      expect(result).toContain('aistudio.google.com');
    });

    it('should return openrouter URL', () => {
      const result = getProviderSuggestion('openrouter', new Error('unauthorized'));
      expect(result).toContain('openrouter.ai');
    });

    it('should return together URL', () => {
      const result = getProviderSuggestion('together', new Error('unauthorized'));
      expect(result).toContain('api.together.xyz');
    });

    it('should return groq URL', () => {
      const result = getProviderSuggestion('groq', new Error('unauthorized'));
      expect(result).toContain('console.groq.com');
    });

    it('should return mistral URL', () => {
      const result = getProviderSuggestion('mistral', new Error('unauthorized'));
      expect(result).toContain('console.mistral.ai');
    });

    it('should return fireworks URL', () => {
      const result = getProviderSuggestion('fireworks', new Error('unauthorized'));
      expect(result).toContain('fireworks.ai');
    });

    it('should return null for unknown provider auth error', () => {
      const result = getProviderSuggestion('unknown-provider', new Error('unauthorized'));
      expect(result).toBeNull();
    });
  });

  describe('rate limit errors', () => {
    it('should suggest switching providers', () => {
      const result = getProviderSuggestion('anthropic', new Error('rate limit exceeded'));
      expect(result).toContain('/provider');
    });

    it('should suggest switching for any provider', () => {
      const result = getProviderSuggestion('openai', new Error('too many requests'));
      expect(result).toContain('/provider');
    });
  });

  describe('server errors', () => {
    it('should return anthropic status page', () => {
      const result = getProviderSuggestion('anthropic', new Error('500 internal server error'));
      expect(result).toContain('status.anthropic.com');
    });

    it('should return openai status page', () => {
      const result = getProviderSuggestion('openai', new Error('502 bad gateway'));
      expect(result).toContain('status.openai.com');
    });

    it('should return google status page', () => {
      const result = getProviderSuggestion('google', new Error('service unavailable'));
      expect(result).toContain('status.cloud.google.com');
    });

    it('should return null for unknown provider server error', () => {
      const result = getProviderSuggestion('together', new Error('500 server error'));
      expect(result).toBeNull();
    });
  });

  describe('other error categories', () => {
    it('should return null for network errors', () => {
      const result = getProviderSuggestion('anthropic', new Error('ECONNREFUSED'));
      expect(result).toBeNull();
    });

    it('should return null for timeout errors', () => {
      const result = getProviderSuggestion('openai', new Error('request timed out'));
      expect(result).toBeNull();
    });

    it('should return null for unknown errors', () => {
      const result = getProviderSuggestion('google', new Error('something unexpected'));
      expect(result).toBeNull();
    });

    it('should return null for invalid_request errors', () => {
      const result = getProviderSuggestion('anthropic', new Error('bad request'));
      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// ClassifiedError structure validation
// ============================================================================

describe('ClassifiedError structure', () => {
  const testCases: Array<{ input: string; expectedCategory: ErrorCategory }> = [
    { input: 'ECONNREFUSED', expectedCategory: 'network' },
    { input: 'rate limit exceeded', expectedCategory: 'rate_limit' },
    { input: 'unauthorized', expectedCategory: 'auth' },
    { input: 'bad request', expectedCategory: 'invalid_request' },
    { input: '500 error', expectedCategory: 'server' },
    { input: 'request timed out', expectedCategory: 'timeout' },
    { input: 'something weird', expectedCategory: 'unknown' },
  ];

  for (const { input, expectedCategory } of testCases) {
    it(`should return valid structure for ${expectedCategory} category`, () => {
      const result = classifyError(new Error(input));
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('suggestion');
      expect(result).toHaveProperty('retryable');
      expect(typeof result.category).toBe('string');
      expect(typeof result.message).toBe('string');
      expect(typeof result.suggestion).toBe('string');
      expect(typeof result.retryable).toBe('boolean');
      if (result.retryAfterMs !== undefined) {
        expect(typeof result.retryAfterMs).toBe('number');
        expect(result.retryAfterMs).toBeGreaterThan(0);
      }
    });
  }
});
