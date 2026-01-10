/**
 * Calliope CLI - Error Handling
 *
 * Provides retry logic, error classification, and actionable suggestions.
 */

// ============================================================================
// Types
// ============================================================================

export type ErrorCategory =
  | 'network'
  | 'rate_limit'
  | 'auth'
  | 'invalid_request'
  | 'server'
  | 'timeout'
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  suggestion: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classify an error and provide actionable suggestions
 */
export function classifyError(error: unknown): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  // Network errors
  if (
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('network') ||
    lowerMessage.includes('dns') ||
    lowerMessage.includes('socket')
  ) {
    return {
      category: 'network',
      message: 'Network connection failed',
      suggestion: 'Check your internet connection and try again.',
      retryable: true,
      retryAfterMs: 2000,
    };
  }

  // Rate limiting
  if (
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('too many requests') ||
    lowerMessage.includes('429') ||
    lowerMessage.includes('quota')
  ) {
    // Try to extract retry-after from error
    const retryMatch = message.match(/retry.?after[:\s]+(\d+)/i);
    const retryAfterMs = retryMatch ? parseInt(retryMatch[1]) * 1000 : 60000;

    return {
      category: 'rate_limit',
      message: 'Rate limit exceeded',
      suggestion: `Wait ${Math.round(retryAfterMs / 1000)} seconds and try again, or switch providers with /provider.`,
      retryable: true,
      retryAfterMs,
    };
  }

  // Authentication errors
  if (
    lowerMessage.includes('unauthorized') ||
    lowerMessage.includes('401') ||
    lowerMessage.includes('api key') ||
    lowerMessage.includes('authentication') ||
    lowerMessage.includes('invalid key') ||
    lowerMessage.includes('invalid_api_key')
  ) {
    return {
      category: 'auth',
      message: 'Authentication failed',
      suggestion: 'Check your API key with /config or run `calliope --setup` to reconfigure.',
      retryable: false,
    };
  }

  // Invalid request errors
  if (
    lowerMessage.includes('bad request') ||
    lowerMessage.includes('400') ||
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('malformed')
  ) {
    return {
      category: 'invalid_request',
      message: 'Invalid request',
      suggestion: 'Try rephrasing your message or use /clear to reset the conversation.',
      retryable: false,
    };
  }

  // Timeout errors
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('etimedout')
  ) {
    return {
      category: 'timeout',
      message: 'Request timed out',
      suggestion: 'The request took too long. Try a simpler query or check server status.',
      retryable: true,
      retryAfterMs: 5000,
    };
  }

  // Server errors
  if (
    lowerMessage.includes('500') ||
    lowerMessage.includes('502') ||
    lowerMessage.includes('503') ||
    lowerMessage.includes('504') ||
    lowerMessage.includes('internal server') ||
    lowerMessage.includes('service unavailable')
  ) {
    return {
      category: 'server',
      message: 'Server error',
      suggestion: 'The API server is having issues. Wait a moment and try again, or switch providers.',
      retryable: true,
      retryAfterMs: 10000,
    };
  }

  // Unknown error
  return {
    category: 'unknown',
    message: message.length > 100 ? message.substring(0, 100) + '...' : message,
    suggestion: 'An unexpected error occurred. Try again or use /clear to reset.',
    retryable: true,
    retryAfterMs: 3000,
  };
}

/**
 * Format an error for user display
 */
export function formatError(error: unknown): string {
  const classified = classifyError(error);

  let output = `✗ ${classified.message}`;
  if (classified.suggestion) {
    output += `\n  💡 ${classified.suggestion}`;
  }

  return output;
}

// ============================================================================
// Retry Logic
// ============================================================================

const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      const classified = classifyError(error);
      if (!classified.retryable || attempt > opts.maxRetries) {
        throw lastError;
      }

      // Use the error's suggested delay if available
      const retryDelay = classified.retryAfterMs
        ? Math.min(classified.retryAfterMs, opts.maxDelayMs)
        : Math.min(delay, opts.maxDelayMs);

      // Notify about retry
      if (opts.onRetry) {
        opts.onRetry(attempt, lastError, retryDelay);
      }

      await sleep(retryDelay);

      // Exponential backoff
      delay *= opts.backoffMultiplier;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

/**
 * Wrap an async function to add retry logic
 */
export function retryable<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: RetryOptions = {}
): T {
  return ((...args: Parameters<T>) => withRetry(() => fn(...args), options)) as T;
}

// ============================================================================
// Provider-Specific Error Handling
// ============================================================================

/**
 * Get provider-specific suggestions
 */
export function getProviderSuggestion(provider: string, error: unknown): string | null {
  const classified = classifyError(error);

  if (classified.category === 'auth') {
    switch (provider) {
      case 'anthropic':
        return 'Get your API key at https://console.anthropic.com/';
      case 'openai':
        return 'Get your API key at https://platform.openai.com/api-keys';
      case 'google':
        return 'Get your API key at https://aistudio.google.com/apikey';
      case 'openrouter':
        return 'Get your API key at https://openrouter.ai/keys';
      default:
        return null;
    }
  }

  if (classified.category === 'rate_limit') {
    return `Try switching to another provider with /provider`;
  }

  return null;
}
