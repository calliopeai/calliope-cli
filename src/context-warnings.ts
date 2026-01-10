/**
 * Calliope CLI - Context Warnings
 *
 * Utilities for proactive context limit warnings and management suggestions.
 */

// Context window limits by model family (approximate token counts)
const CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4': 200000,
  'claude-opus-4': 200000,
  'claude-3': 200000,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gemini-2': 1000000,
  'gemini-1.5-pro': 1000000,
  'gemini-1.5-flash': 1000000,
  'llama-3.3': 128000,
  'llama-3.1': 128000,
  'mistral-large': 128000,
  'default': 32000,
};

/**
 * Get context limit for a model
 */
export function getContextLimit(model: string): number {
  const lowerModel = model.toLowerCase();
  for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (lowerModel.includes(key.toLowerCase())) {
      return limit;
    }
  }
  return CONTEXT_LIMITS.default;
}

/**
 * Warning thresholds
 */
export const WARNING_THRESHOLDS = {
  notice: 0.5,    // 50% - just informational
  warning: 0.75,  // 75% - suggest compacting
  critical: 0.9,  // 90% - strongly suggest action
};

export type WarningLevel = 'none' | 'notice' | 'warning' | 'critical';

export interface ContextStatus {
  tokens: number;
  limit: number;
  percentage: number;
  level: WarningLevel;
  message?: string;
}

/**
 * Get context status with warning level
 */
export function getContextStatus(tokens: number, model: string): ContextStatus {
  const limit = getContextLimit(model);
  const percentage = tokens / limit;

  let level: WarningLevel = 'none';
  let message: string | undefined;

  if (percentage >= WARNING_THRESHOLDS.critical) {
    level = 'critical';
    message = `⚠️ Context at ${Math.round(percentage * 100)}% capacity! Consider: /summarize compact or /clear`;
  } else if (percentage >= WARNING_THRESHOLDS.warning) {
    level = 'warning';
    message = `Context at ${Math.round(percentage * 100)}%. Consider /summarize compact to free space.`;
  } else if (percentage >= WARNING_THRESHOLDS.notice) {
    level = 'notice';
    // No message for notice level - just color indicator in status bar
  }

  return {
    tokens,
    limit,
    percentage,
    level,
    message,
  };
}

/**
 * Check if context warning should be shown
 * Returns message if warning needed, undefined otherwise
 */
export function checkContextWarning(
  currentTokens: number,
  previousTokens: number,
  model: string
): string | undefined {
  const current = getContextStatus(currentTokens, model);
  const previous = getContextStatus(previousTokens, model);

  // Only show warning when crossing a threshold
  if (current.level !== previous.level && current.level !== 'none') {
    return current.message;
  }

  return undefined;
}

/**
 * Get suggestions for managing context
 */
export function getContextSuggestions(percentage: number): string[] {
  const suggestions: string[] = [];

  if (percentage >= 0.9) {
    suggestions.push('/clear - Start fresh conversation');
    suggestions.push('/summarize compact - Compress older messages');
  } else if (percentage >= 0.75) {
    suggestions.push('/summarize compact - Compress context');
    suggestions.push('Use shorter messages');
  } else if (percentage >= 0.5) {
    suggestions.push('/summarize context - View summary');
  }

  return suggestions;
}

/**
 * Format tokens for display
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return String(tokens);
}

/**
 * Get color for context percentage
 */
export function getContextColor(percentage: number): 'green' | 'yellow' | 'red' {
  if (percentage >= WARNING_THRESHOLDS.critical) return 'red';
  if (percentage >= WARNING_THRESHOLDS.warning) return 'yellow';
  return 'green';
}
