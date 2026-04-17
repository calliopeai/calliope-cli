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

  // Extract HTTP status code from error object properties if available
  const statusCode = (error as any)?.status ?? (error as any)?.statusCode ?? (error as any)?.code;
  const numericStatus = typeof statusCode === 'number' ? statusCode : parseInt(String(statusCode), 10);

  // Network errors
  if (
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('network') ||
    lowerMessage.includes('dns') ||
    /\bsocket\b/i.test(message)
  ) {
    return {
      category: 'network',
      message: 'Network connection failed',
      suggestion: 'Check your internet connection and try again.',
      retryable: true,
      retryAfterMs: 2000,
    };
  }

  // Billing/quota exhausted (check before rate limit - these require payment, not waiting)
  if (
    lowerMessage.includes('billing') ||
    lowerMessage.includes('insufficient_quota') ||
    lowerMessage.includes('exceeded your current quota') ||
    lowerMessage.includes('payment required')
  ) {
    return {
      category: 'auth',
      message: 'Billing or quota issue',
      suggestion: 'Check your billing at the provider dashboard, or switch to another provider with /provider.',
      retryable: false,
    };
  }

  // Rate limiting (temporary, can retry)
  if (
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('too many requests') ||
    numericStatus === 429 ||
    /\b429\b/.test(message) ||
    lowerMessage.includes('quota exceeded')  // Generic rate limit (not billing)
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
    numericStatus === 401 ||
    /\b401\b/.test(message) ||
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

  // AWS SigV4 signature mismatch (Bedrock). 403 with signature/credentials text.
  // Don't truncate the message — the full body usually contains useful detail
  // (e.g. which key was tried). Also treat as non-retryable so we don't burn time.
  if (
    (numericStatus === 403 || /\b403\b/.test(message)) &&
    (lowerMessage.includes('signature') || lowerMessage.includes('access key') || lowerMessage.includes('security token'))
  ) {
    return {
      category: 'auth',
      message: `AWS SigV4 signature mismatch. ${message.slice(0, 600)}`,
      suggestion:
        'Likely causes: (1) stale AWS_ACCESS_KEY_ID env vars overriding your profile — `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN` and retry; ' +
        '(2) SSO token expired — `aws sso login --profile <name>`; ' +
        '(3) clock skew — check `date` against AWS server time.',
      retryable: false,
    };
  }

  // Bedrock ValidationException: on-demand not supported — model needs an inference profile.
  if (
    lowerMessage.includes("on-demand throughput isn't supported") ||
    lowerMessage.includes('inference profile') ||
    lowerMessage.includes('inferenceprofile')
  ) {
    return {
      category: 'invalid_request',
      message: `Bedrock model requires an inference profile. ${message.slice(0, 500)}`,
      suggestion:
        'Pick the "us.*" (or your region) prefixed cross-region inference profile ID via /model — raw foundation IDs for newer Claude 4.x/Haiku 4.5 models aren\'t invokable on-demand.',
      retryable: false,
    };
  }

  // Invalid request errors. Keep the underlying body (up to 500 chars) so the
  // user can see the actual Bedrock / provider validation message.
  if (
    lowerMessage.includes('bad request') ||
    numericStatus === 400 ||
    /\b400\b/.test(message) ||
    lowerMessage.includes('invalid request') ||
    lowerMessage.includes('invalid model') ||
    lowerMessage.includes('invalid parameter') ||
    lowerMessage.includes('malformed') ||
    lowerMessage.includes('validationexception')
  ) {
    return {
      category: 'invalid_request',
      message: `Invalid request: ${message.slice(0, 500)}`,
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
    numericStatus === 500 || numericStatus === 502 || numericStatus === 503 || numericStatus === 504 ||
    /\b500\b/.test(message) ||
    /\b502\b/.test(message) ||
    /\b503\b/.test(message) ||
    /\b504\b/.test(message) ||
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

  // File not found errors (but not model errors)
  if (
    !lowerMessage.includes('model') && (
      lowerMessage.includes('enoent') ||
      lowerMessage.includes('no such file') ||
      (lowerMessage.includes('not found') && (lowerMessage.includes('file') || lowerMessage.includes('path') || lowerMessage.includes('directory'))) ||
      lowerMessage.includes('does not exist')
    )
  ) {
    // Extract filename if possible
    const pathMatch = message.match(/['"]([^'"]+)['"]/);
    const filePath = pathMatch ? pathMatch[1] : 'the file';
    return {
      category: 'invalid_request',
      message: `File not found: ${filePath}`,
      suggestion: 'Check the file path. Use /find <name> to search for files, or list_files to explore.',
      retryable: false,
    };
  }

  // Permission errors
  if (
    lowerMessage.includes('permission denied') ||
    lowerMessage.includes('eacces') ||
    lowerMessage.includes('eperm') ||
    lowerMessage.includes('access denied')
  ) {
    return {
      category: 'invalid_request',
      message: 'Permission denied',
      suggestion: 'Check file permissions with `ls -la`. You may need elevated privileges.',
      retryable: false,
    };
  }

  // Disk/space errors
  if (
    lowerMessage.includes('enospc') ||
    lowerMessage.includes('no space') ||
    lowerMessage.includes('disk full')
  ) {
    return {
      category: 'server',
      message: 'Disk space exhausted',
      suggestion: 'Free up disk space and try again.',
      retryable: false,
    };
  }

  // Context/token limit errors
  if (
    lowerMessage.includes('context length') ||
    lowerMessage.includes('token limit') ||
    lowerMessage.includes('maximum context') ||
    lowerMessage.includes('too long')
  ) {
    return {
      category: 'invalid_request',
      message: 'Context limit exceeded',
      suggestion: 'Use /summarize compact to reduce context, or /clear to start fresh.',
      retryable: false,
    };
  }

  // Model not found errors
  if (
    lowerMessage.includes('model not found') ||
    lowerMessage.includes('invalid model') ||
    lowerMessage.includes('does not exist') && lowerMessage.includes('model')
  ) {
    return {
      category: 'invalid_request',
      message: 'Model not available',
      suggestion: 'Use /models to see available models, or /provider to switch providers.',
      retryable: false,
    };
  }

  // OpenAI Responses API specific errors
  if (
    lowerMessage.includes('only supported in v1/responses') ||
    lowerMessage.includes('not in v1/chat/completions')
  ) {
    return {
      category: 'invalid_request',
      message: 'Model requires Responses API',
      suggestion: 'This model (o3/o4-mini) should auto-route to Responses API. Update calliope: npm update -g calliope-cli',
      retryable: false,
    };
  }

  // Vision/image capability errors
  if (
    (lowerMessage.includes('vision') && (lowerMessage.includes('not supported') || lowerMessage.includes('not available') || lowerMessage.includes('does not support') || lowerMessage.includes('cannot'))) ||
    (lowerMessage.includes('image') && (lowerMessage.includes('not supported') || lowerMessage.includes('cannot')))
  ) {
    return {
      category: 'invalid_request',
      message: 'Vision not supported',
      suggestion: 'This model does not support images. Try anthropic (Claude), openai (GPT-4o), or google (Gemini).',
      retryable: false,
    };
  }

  // Tool/function calling errors
  if (
    lowerMessage.includes('tool') && (lowerMessage.includes('not supported') || lowerMessage.includes('invalid')) ||
    lowerMessage.includes('function calling')
  ) {
    return {
      category: 'invalid_request',
      message: 'Tool use not supported',
      suggestion: 'This model may not support tools. Try a more capable model with /model.',
      retryable: false,
    };
  }

  // Content policy / safety errors
  if (
    lowerMessage.includes('content policy') ||
    lowerMessage.includes('safety') ||
    lowerMessage.includes('blocked') ||
    lowerMessage.includes('harmful')
  ) {
    return {
      category: 'invalid_request',
      message: 'Content blocked by safety filter',
      suggestion: 'Rephrase your request to avoid triggering content filters.',
      retryable: false,
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
 * Format an error for user display with category-specific styling
 */
export function formatError(error: unknown, context?: { tool?: string; provider?: string }): string {
  const classified = classifyError(error);

  // Category-specific icons
  const categoryIcons: Record<ErrorCategory, string> = {
    network: '🌐',
    rate_limit: '⏱️',
    auth: '🔑',
    invalid_request: '❌',
    server: '🖥️',
    timeout: '⏰',
    unknown: '❓',
  };

  const icon = categoryIcons[classified.category];
  let output = `${icon} ${classified.message}`;
  
  // Add context if provided
  if (context?.tool) {
    output = `${icon} [${context.tool}] ${classified.message}`;
  }
  
  // Add suggestion
  if (classified.suggestion) {
    output += `\n   💡 ${classified.suggestion}`;
  }
  
  // Add provider-specific help for auth errors
  if (classified.category === 'auth' && context?.provider) {
    const providerHelp = getProviderSuggestion(context.provider, error);
    if (providerHelp) {
      output += `\n   🔗 ${providerHelp}`;
    }
  }
  
  // Add retry info for retryable errors
  if (classified.retryable && classified.retryAfterMs) {
    const waitSecs = Math.round(classified.retryAfterMs / 1000);
    if (waitSecs > 0) {
      output += `\n   ⏳ Auto-retry in ${waitSecs}s...`;
    }
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
      case 'together':
        return 'Get your API key at https://api.together.xyz/settings/api-keys';
      case 'groq':
        return 'Get your API key at https://console.groq.com/keys';
      case 'mistral':
        return 'Get your API key at https://console.mistral.ai/api-keys/';
      case 'fireworks':
        return 'Get your API key at https://fireworks.ai/api-keys';
      default:
        return null;
    }
  }

  if (classified.category === 'rate_limit') {
    return `Try switching to another provider with /provider`;
  }

  if (classified.category === 'server') {
    const statusPages: Record<string, string> = {
      anthropic: 'Check status at https://status.anthropic.com/',
      openai: 'Check status at https://status.openai.com/',
      google: 'Check status at https://status.cloud.google.com/',
    };
    return statusPages[provider] || null;
  }

  return null;
}
