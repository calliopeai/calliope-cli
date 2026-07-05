/**
 * UI Module - Smart Context Management
 *
 * Tracks context window usage and provides progressive warnings
 * as the conversation approaches the model's context limit.
 */

import type { LLMProvider } from '../types.js';
import { getModelContextLimit } from '../model-detection.js';

// ============================================================================
// Types
// ============================================================================

export type ContextLevel = 'healthy' | 'caution' | 'warning' | 'critical' | 'emergency';

interface ContextState {
  lastLevel: ContextLevel;
  warningCounts: Record<ContextLevel, number>;
  lastWarningTime: number;
}

// ============================================================================
// Module-level State (persists across renders)
// ============================================================================

const contextState: ContextState = {
  lastLevel: 'healthy',
  warningCounts: { healthy: 0, caution: 0, warning: 0, critical: 0, emergency: 0 },
  lastWarningTime: 0,
};

// ============================================================================
// Functions
// ============================================================================

export function getContextLevel(percentage: number): ContextLevel {
  if (percentage >= 98) return 'emergency';
  if (percentage >= 95) return 'critical';
  if (percentage >= 85) return 'warning';
  if (percentage >= 70) return 'caution';
  return 'healthy';
}

function getContextLevelIndex(level: ContextLevel): number {
  const order: ContextLevel[] = ['healthy', 'caution', 'warning', 'critical', 'emergency'];
  return order.indexOf(level);
}

function shouldShowContextWarning(level: ContextLevel): boolean {
  if (level === 'healthy') return false;

  const now = Date.now();
  const timeSinceLastWarning = now - contextState.lastWarningTime;
  const minInterval = level === 'emergency' ? 30000 : 60000; // 30s for emergency, 60s otherwise

  // Always warn on level increase
  if (getContextLevelIndex(level) > getContextLevelIndex(contextState.lastLevel)) {
    return true;
  }

  // Warn again if enough time has passed and we're at critical/emergency
  if ((level === 'critical' || level === 'emergency') && timeSinceLastWarning > minInterval) {
    return true;
  }

  return false;
}

export function checkAndWarnContextLimit(
  provider: LLMProvider,
  model: string,
  tokens: number,
  addMessage?: (type: 'user' | 'assistant' | 'system' | 'error', content: string) => void
): void {
  const limit = getModelContextLimit(provider, model);
  const percentage = (tokens / limit) * 100;
  const level = getContextLevel(percentage);
  const used = Math.round(tokens / 1000);
  const limitK = Math.round(limit / 1000);

  if (!shouldShowContextWarning(level)) return;

  // Update state
  contextState.lastLevel = level;
  contextState.warningCounts[level]++;
  contextState.lastWarningTime = Date.now();

  // Generate warning message based on level
  let message: string;
  switch (level) {
    case 'emergency':
      message = `\x1b[31m\x1b[1m🚨 EMERGENCY: Context at ${Math.round(percentage)}% (${used}K/${limitK}K)\x1b[0m
\x1b[31m   Responses WILL be truncated. Take action NOW:\x1b[0m
\x1b[2m   /compact - Auto-compress (recommended)
   /clear - Fresh start
   /branch new "save" - Save and branch\x1b[0m`;
      break;
    case 'critical':
      message = `\x1b[31m🔴 CRITICAL: Context at ${Math.round(percentage)}% (${used}K/${limitK}K)\x1b[0m
\x1b[2m   Approaching limits. Action recommended:
   /compact | /clear | shorter messages\x1b[0m`;
      break;
    case 'warning':
      message = `\x1b[33m⚠️  WARNING: Context at ${Math.round(percentage)}% (${used}K/${limitK}K)\x1b[0m
\x1b[2m   Consider: /compact | /clear\x1b[0m`;
      break;
    case 'caution':
      message = `\x1b[36m💡 Context at ${Math.round(percentage)}% (${used}K/${limitK}K)\x1b[0m
\x1b[2m   Monitor usage. /compact for a summary\x1b[0m`;
      break;
    default:
      return;
  }

  console.log(message + '\n');

  // Also add to UI messages if callback provided (for critical+)
  if (addMessage && (level === 'critical' || level === 'emergency')) {
    const uiMessage = level === 'emergency'
      ? `🚨 EMERGENCY: Context at ${Math.round(percentage)}% - responses will be truncated! Use /compact NOW`
      : `🔴 Context at ${Math.round(percentage)}% - consider /compact`;
    addMessage('system', uiMessage);
  }
}

export function resetContextWarnings(): void {
  contextState.lastLevel = 'healthy';
  contextState.warningCounts = { healthy: 0, caution: 0, warning: 0, critical: 0, emergency: 0 };
  contextState.lastWarningTime = 0;
}
