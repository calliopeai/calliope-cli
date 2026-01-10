/**
 * Tests for error handling module
 */

import { describe, it, expect } from 'vitest';
import {
  classifyError,
  formatError,
  withRetry,
} from '../src/errors.js';

describe('classifyError', () => {
  describe('network errors', () => {
    it('should classify ECONNREFUSED as network error', () => {
      const result = classifyError(new Error('ECONNREFUSED'));
      expect(result.category).toBe('network');
      expect(result.retryable).toBe(true);
    });

    it('should classify ENOTFOUND as network error', () => {
      const result = classifyError(new Error('getaddrinfo ENOTFOUND api.example.com'));
      expect(result.category).toBe('network');
    });

    it('should classify socket errors as network error', () => {
      const result = classifyError(new Error('socket hang up'));
      expect(result.category).toBe('network');
    });
  });

  describe('rate limit errors', () => {
    it('should classify rate limit message', () => {
      const result = classifyError(new Error('rate limit exceeded'));
      expect(result.category).toBe('rate_limit');
      expect(result.retryable).toBe(true);
    });

    it('should classify 429 errors', () => {
      const result = classifyError(new Error('Request failed with status 429'));
      expect(result.category).toBe('rate_limit');
    });

    it('should classify quota errors', () => {
      const result = classifyError(new Error('quota exceeded'));
      expect(result.category).toBe('rate_limit');
    });

    it('should extract retry-after when present', () => {
      const result = classifyError(new Error('rate limit exceeded, retry after: 30'));
      expect(result.category).toBe('rate_limit');
      expect(result.retryAfterMs).toBe(30000);
    });
  });

  describe('authentication errors', () => {
    it('should classify unauthorized as auth error', () => {
      const result = classifyError(new Error('unauthorized'));
      expect(result.category).toBe('auth');
      expect(result.retryable).toBe(false);
    });

    it('should classify invalid API key', () => {
      const result = classifyError(new Error('invalid_api_key'));
      expect(result.category).toBe('auth');
    });

    it('should classify 401 errors', () => {
      const result = classifyError(new Error('Request failed with status 401'));
      expect(result.category).toBe('auth');
    });
  });

  describe('invalid request errors', () => {
    it('should classify bad request', () => {
      const result = classifyError(new Error('bad request'));
      expect(result.category).toBe('invalid_request');
      expect(result.retryable).toBe(false);
    });

    it('should classify 400 errors', () => {
      const result = classifyError(new Error('Request failed with status 400'));
      expect(result.category).toBe('invalid_request');
    });

    it('should classify malformed errors', () => {
      const result = classifyError(new Error('malformed JSON in request'));
      expect(result.category).toBe('invalid_request');
    });
  });

  describe('timeout errors', () => {
    it('should classify timeout', () => {
      const result = classifyError(new Error('request timed out'));
      expect(result.category).toBe('timeout');
      expect(result.retryable).toBe(true);
    });

    it('should classify ETIMEDOUT', () => {
      const result = classifyError(new Error('ETIMEDOUT'));
      expect(result.category).toBe('timeout');
    });
  });

  describe('server errors', () => {
    it('should classify 500 errors', () => {
      const result = classifyError(new Error('Internal Server Error 500'));
      expect(result.category).toBe('server');
      expect(result.retryable).toBe(true);
    });

    it('should classify 503 errors', () => {
      const result = classifyError(new Error('service unavailable'));
      expect(result.category).toBe('server');
    });

    it('should classify 502 bad gateway', () => {
      const result = classifyError(new Error('502 Bad Gateway'));
      expect(result.category).toBe('server');
    });
  });

  describe('unknown errors', () => {
    it('should classify unknown errors as unknown', () => {
      const result = classifyError(new Error('something weird happened'));
      expect(result.category).toBe('unknown');
      expect(result.retryable).toBe(true);
    });

    it('should handle non-Error objects', () => {
      const result = classifyError('string error');
      expect(result.category).toBe('unknown');
    });

    it('should truncate long error messages', () => {
      const longMessage = 'x'.repeat(200);
      const result = classifyError(new Error(longMessage));
      expect(result.message.length).toBeLessThanOrEqual(103); // 100 + '...'
    });
  });
});

describe('formatError', () => {
  it('should format network errors with suggestion', () => {
    const result = formatError(new Error('ECONNREFUSED'));
    expect(result).toContain('✗');
    expect(result).toContain('💡');
    expect(result).toContain('internet connection');
  });

  it('should format auth errors with suggestion', () => {
    const result = formatError(new Error('unauthorized'));
    expect(result).toContain('Authentication failed');
    expect(result).toContain('API key');
  });

  it('should format rate limit errors', () => {
    const result = formatError(new Error('rate limit exceeded'));
    expect(result).toContain('Rate limit');
    expect(result).toContain('/provider');
  });
});

describe('withRetry', () => {
  it('should succeed without retry on first success', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      return 'success';
    };

    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('success');
    expect(attempts).toBe(1);
  });

  it('should retry on retryable errors', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('ECONNREFUSED'); // Network error is retryable
      }
      return 'success';
    };

    const result = await withRetry(fn, { 
      maxRetries: 3,
      initialDelayMs: 10, // Speed up test
      maxDelayMs: 20,     // Cap delay for fast tests
    });
    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  it('should not retry on non-retryable errors', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('unauthorized'); // Auth error is not retryable
    };

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow('unauthorized');
    expect(attempts).toBe(1);
  });

  it('should throw after max retries exceeded', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      throw new Error('ECONNREFUSED');
    };

    await expect(withRetry(fn, { 
      maxRetries: 2,
      initialDelayMs: 10,
      maxDelayMs: 20,
    })).rejects.toThrow('ECONNREFUSED');
    expect(attempts).toBe(3); // Initial + 2 retries
  });

  it('should call onRetry callback', async () => {
    let retryAttempts: number[] = [];
    let callCount = 0;
    
    const fn = async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('ECONNREFUSED'); // Network error - fast retry
      }
      return 'success';
    };

    await withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 10,
      maxDelayMs: 20, // Cap delay so test runs fast
      onRetry: (attempt) => {
        retryAttempts.push(attempt);
      },
    });

    expect(retryAttempts).toEqual([1, 2]);
  });
});
