/**
 * Calliope CLI - Multi-Model Router
 *
 * Intelligently routes requests to different models based on task complexity.
 */

import type { LLMProvider } from './types.js';
import * as config from './config.js';

// ============================================================================
// Types
// ============================================================================

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';

export interface ModelTier {
  name: string;
  provider: LLMProvider;
  model: string;
  maxTokens: number;
  costPer1kInput: number;
  costPer1kOutput: number;
}

export interface RoutingConfig {
  enabled: boolean;
  tiers: {
    fast: ModelTier;      // For trivial/simple tasks
    balanced: ModelTier;  // For moderate tasks
    smart: ModelTier;     // For complex/expert tasks
  };
  autoRoute: boolean;     // Automatically choose model
  defaultTier: 'fast' | 'balanced' | 'smart';
}

export interface RouteDecision {
  tier: 'fast' | 'balanced' | 'smart';
  model: ModelTier;
  reason: string;
  complexity: TaskComplexity;
  confidence: number;  // 0-1
}

// ============================================================================
// Default Model Tiers
// ============================================================================

const DEFAULT_TIERS: Record<LLMProvider, RoutingConfig['tiers']> = {
  anthropic: {
    fast: {
      name: 'Haiku',
      provider: 'anthropic',
      model: 'claude-3-5-haiku-20241022',
      maxTokens: 8192,
      costPer1kInput: 0.00025,
      costPer1kOutput: 0.00125,
    },
    balanced: {
      name: 'Sonnet',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
    },
    smart: {
      name: 'Opus',
      provider: 'anthropic',
      model: 'claude-opus-4-20250514',
      maxTokens: 8192,
      costPer1kInput: 0.015,
      costPer1kOutput: 0.075,
    },
  },
  openai: {
    fast: {
      name: 'GPT-4o Mini',
      provider: 'openai',
      model: 'gpt-4o-mini',
      maxTokens: 16384,
      costPer1kInput: 0.00015,
      costPer1kOutput: 0.0006,
    },
    balanced: {
      name: 'GPT-4o',
      provider: 'openai',
      model: 'gpt-4o',
      maxTokens: 16384,
      costPer1kInput: 0.0025,
      costPer1kOutput: 0.01,
    },
    smart: {
      name: 'o1',
      provider: 'openai',
      model: 'o1',
      maxTokens: 32768,
      costPer1kInput: 0.015,
      costPer1kOutput: 0.06,
    },
  },
  google: {
    fast: {
      name: 'Flash',
      provider: 'google',
      model: 'gemini-2.0-flash',
      maxTokens: 8192,
      costPer1kInput: 0.000075,
      costPer1kOutput: 0.0003,
    },
    balanced: {
      name: 'Pro',
      provider: 'google',
      model: 'gemini-1.5-pro',
      maxTokens: 8192,
      costPer1kInput: 0.00125,
      costPer1kOutput: 0.005,
    },
    smart: {
      name: 'Pro (long)',
      provider: 'google',
      model: 'gemini-1.5-pro',
      maxTokens: 32768,
      costPer1kInput: 0.00125,
      costPer1kOutput: 0.005,
    },
  },
  // Fallback for other providers
  together: {
    fast: { name: 'Llama 8B', provider: 'together', model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', maxTokens: 8192, costPer1kInput: 0.00018, costPer1kOutput: 0.00018 },
    balanced: { name: 'Llama 70B', provider: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', maxTokens: 8192, costPer1kInput: 0.00088, costPer1kOutput: 0.00088 },
    smart: { name: 'Llama 405B', provider: 'together', model: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', maxTokens: 8192, costPer1kInput: 0.003, costPer1kOutput: 0.003 },
  },
  groq: {
    fast: { name: 'Llama 8B', provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 8192, costPer1kInput: 0.00005, costPer1kOutput: 0.00008 },
    balanced: { name: 'Llama 70B', provider: 'groq', model: 'llama-3.3-70b-versatile', maxTokens: 8192, costPer1kInput: 0.00059, costPer1kOutput: 0.00079 },
    smart: { name: 'Llama 70B', provider: 'groq', model: 'llama-3.3-70b-versatile', maxTokens: 32768, costPer1kInput: 0.00059, costPer1kOutput: 0.00079 },
  },
  openrouter: {
    fast: { name: 'Haiku', provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', maxTokens: 8192, costPer1kInput: 0.0008, costPer1kOutput: 0.004 },
    balanced: { name: 'Sonnet', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', maxTokens: 8192, costPer1kInput: 0.003, costPer1kOutput: 0.015 },
    smart: { name: 'Opus', provider: 'openrouter', model: 'anthropic/claude-opus-4', maxTokens: 8192, costPer1kInput: 0.015, costPer1kOutput: 0.075 },
  },
  fireworks: {
    fast: { name: 'Llama 8B', provider: 'fireworks', model: 'accounts/fireworks/models/llama-v3p1-8b-instruct', maxTokens: 8192, costPer1kInput: 0.0002, costPer1kOutput: 0.0002 },
    balanced: { name: 'Llama 70B', provider: 'fireworks', model: 'accounts/fireworks/models/llama-v3p1-70b-instruct', maxTokens: 8192, costPer1kInput: 0.0009, costPer1kOutput: 0.0009 },
    smart: { name: 'Llama 405B', provider: 'fireworks', model: 'accounts/fireworks/models/llama-v3p1-405b-instruct', maxTokens: 8192, costPer1kInput: 0.003, costPer1kOutput: 0.003 },
  },
  mistral: {
    fast: { name: 'Mistral Small', provider: 'mistral', model: 'mistral-small-latest', maxTokens: 8192, costPer1kInput: 0.001, costPer1kOutput: 0.003 },
    balanced: { name: 'Mistral Large', provider: 'mistral', model: 'mistral-large-latest', maxTokens: 8192, costPer1kInput: 0.003, costPer1kOutput: 0.009 },
    smart: { name: 'Mistral Large', provider: 'mistral', model: 'mistral-large-latest', maxTokens: 32768, costPer1kInput: 0.003, costPer1kOutput: 0.009 },
  },
  ollama: {
    fast: { name: 'Llama 8B', provider: 'ollama', model: 'llama3.1:8b', maxTokens: 8192, costPer1kInput: 0, costPer1kOutput: 0 },
    balanced: { name: 'Llama 70B', provider: 'ollama', model: 'llama3.3', maxTokens: 8192, costPer1kInput: 0, costPer1kOutput: 0 },
    smart: { name: 'Llama 70B', provider: 'ollama', model: 'llama3.3', maxTokens: 32768, costPer1kInput: 0, costPer1kOutput: 0 },
  },
  ai21: {
    fast: { name: 'Jamba Mini', provider: 'ai21', model: 'jamba-1.5-mini', maxTokens: 4096, costPer1kInput: 0.0002, costPer1kOutput: 0.0004 },
    balanced: { name: 'Jamba Large', provider: 'ai21', model: 'jamba-1.5-large', maxTokens: 4096, costPer1kInput: 0.002, costPer1kOutput: 0.008 },
    smart: { name: 'Jamba Large', provider: 'ai21', model: 'jamba-1.5-large', maxTokens: 4096, costPer1kInput: 0.002, costPer1kOutput: 0.008 },
  },
  huggingface: {
    fast: { name: 'Default', provider: 'huggingface', model: 'meta-llama/Llama-3.1-8B-Instruct', maxTokens: 4096, costPer1kInput: 0, costPer1kOutput: 0 },
    balanced: { name: 'Default', provider: 'huggingface', model: 'meta-llama/Llama-3.1-70B-Instruct', maxTokens: 4096, costPer1kInput: 0, costPer1kOutput: 0 },
    smart: { name: 'Default', provider: 'huggingface', model: 'meta-llama/Llama-3.1-70B-Instruct', maxTokens: 4096, costPer1kInput: 0, costPer1kOutput: 0 },
  },
  litellm: {
    fast: { name: 'Default', provider: 'litellm', model: 'gpt-4o-mini', maxTokens: 8192, costPer1kInput: 0, costPer1kOutput: 0 },
    balanced: { name: 'Default', provider: 'litellm', model: 'gpt-4o', maxTokens: 8192, costPer1kInput: 0, costPer1kOutput: 0 },
    smart: { name: 'Default', provider: 'litellm', model: 'gpt-4o', maxTokens: 16384, costPer1kInput: 0, costPer1kOutput: 0 },
  },
  bedrock: {
    fast: { name: 'Haiku 4.5', provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', maxTokens: 8192, costPer1kInput: 0.0008, costPer1kOutput: 0.004 },
    balanced: { name: 'Sonnet 4', provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-20250514-v1:0', maxTokens: 8192, costPer1kInput: 0.003, costPer1kOutput: 0.015 },
    smart: { name: 'Opus 4', provider: 'bedrock', model: 'us.anthropic.claude-opus-4-20250514-v1:0', maxTokens: 8192, costPer1kInput: 0.015, costPer1kOutput: 0.075 },
  },
  auto: {
    fast: { name: 'Auto', provider: 'auto', model: 'auto', maxTokens: 8192, costPer1kInput: 0, costPer1kOutput: 0 },
    balanced: { name: 'Auto', provider: 'auto', model: 'auto', maxTokens: 8192, costPer1kInput: 0, costPer1kOutput: 0 },
    smart: { name: 'Auto', provider: 'auto', model: 'auto', maxTokens: 8192, costPer1kInput: 0, costPer1kOutput: 0 },
  },
};

// ============================================================================
// Complexity Analysis
// ============================================================================

/**
 * Analyze task complexity from user message
 */
export function analyzeComplexity(message: string, context?: {
  messageCount?: number;
  hasCode?: boolean;
  fileCount?: number;
  toolsUsed?: string[];
}): { complexity: TaskComplexity; confidence: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  const lower = message.toLowerCase();
  const words = message.split(/\s+/).length;

  // Message length signals
  if (words < 10) {
    signals.push('short message');
    score -= 1;
  } else if (words > 100) {
    signals.push('long message');
    score += 2;
  }

  // Simple task indicators — only count when the message is short enough
  // to likely be a genuinely simple request (not a complex question starting with "what")
  const simplePatterns = [
    /\b(simple|quick|easy|basic|just)\b/i,
    /\b(typo|fix|rename|format)\b/i,
  ];
  // Question words only count as simple for short messages (< 30 words)
  const simpleQuestionPattern = /\b(what|how|explain|show|list|print|display)\b/i;
  if (words < 30 && simpleQuestionPattern.test(lower)) {
    signals.push('simple task keywords');
    score -= 1;
  } else {
    for (const pattern of simplePatterns) {
      if (pattern.test(lower)) {
        signals.push('simple task keywords');
        score -= 1;
        break;
      }
    }
  }

  // Complex task indicators — cap at first match to prevent score explosion
  const complexPatterns = [
    /\b(refactor|architect|design|implement|optimize)\b/i,
    /\b(complex|comprehensive|thorough|detailed)\b/i,
    /\b(security|performance|scalability)\s+(audit|review|analysis|optimization|issue|improvement)/i,
    /\b(debug|investigate|diagnose)\b/i,
    /\b(multiple|several|various|different)\s+(files?|components?|modules?)/i,
  ];
  let complexMatchCount = 0;
  for (const pattern of complexPatterns) {
    if (pattern.test(lower)) {
      signals.push('complex task keywords');
      score += 2;
      complexMatchCount++;
      if (complexMatchCount >= 2) break;  // Cap accumulation at 2 matches
    }
  }

  // "analyze" is complex only when accompanied by another complex signal or a long message
  if (/\banalyze\b/i.test(lower) && (complexMatchCount > 0 || words > 20)) {
    signals.push('complex task keywords');
    score += 2;
  }

  // Expert task indicators
  const expertPatterns = [
    /\b(cryptograph|concurrency|distributed|microservice)/i,
    /\b(algorithm|data\s*structure)\b/i,
    /\b(security\s*audit|vulnerability|exploit)\b/i,
    /\b(machine\s*learning|neural|ai\s*model)\b/i,
  ];
  for (const pattern of expertPatterns) {
    if (pattern.test(lower)) {
      signals.push('expert domain keywords');
      score += 3;
    }
  }

  // Context-based adjustments
  if (context) {
    if (context.messageCount && context.messageCount > 10) {
      signals.push('long conversation');
      score += 1;
    }
    if (context.hasCode) {
      signals.push('involves code');
      score += 1;
    }
    if (context.fileCount && context.fileCount > 3) {
      signals.push('multiple files');
      score += 1;
    }
    if (context.toolsUsed && context.toolsUsed.length > 2) {
      signals.push('multiple tools needed');
      score += 1;
    }
  }

  // Map score to complexity
  let complexity: TaskComplexity;
  if (score <= -1) complexity = 'trivial';
  else if (score <= 1) complexity = 'simple';
  else if (score <= 3) complexity = 'moderate';
  else if (score <= 5) complexity = 'complex';
  else complexity = 'expert';

  // Confidence based on signal count
  const confidence = Math.min(0.9, 0.5 + signals.length * 0.1);

  return { complexity, confidence, signals };
}

// ============================================================================
// Routing
// ============================================================================

/**
 * Route request to appropriate model tier
 */
export function routeRequest(
  message: string,
  provider: LLMProvider,
  context?: {
    messageCount?: number;
    hasCode?: boolean;
    fileCount?: number;
    toolsUsed?: string[];
  }
): RouteDecision {
  const { complexity, confidence, signals } = analyzeComplexity(message, context);
  const tiers = DEFAULT_TIERS[provider] || DEFAULT_TIERS.anthropic;

  let tier: 'fast' | 'balanced' | 'smart';
  let reason: string;

  switch (complexity) {
    case 'trivial':
    case 'simple':
      tier = 'fast';
      reason = `Simple task (${signals.join(', ')})`;
      break;
    case 'moderate':
      tier = 'balanced';
      reason = `Moderate complexity (${signals.join(', ')})`;
      break;
    case 'complex':
    case 'expert':
      tier = 'smart';
      reason = `Complex task (${signals.join(', ')})`;
      break;
  }

  return {
    tier,
    model: tiers[tier],
    reason,
    complexity,
    confidence,
  };
}

/**
 * Get model tier for provider
 */
export function getModelTier(
  provider: LLMProvider,
  tier: 'fast' | 'balanced' | 'smart'
): ModelTier {
  const tiers = DEFAULT_TIERS[provider] || DEFAULT_TIERS.anthropic;
  return tiers[tier];
}

/**
 * Get all tiers for a provider
 */
export function getAllTiers(provider: LLMProvider): RoutingConfig['tiers'] {
  return DEFAULT_TIERS[provider] || DEFAULT_TIERS.anthropic;
}

/**
 * Check if provider supports routing
 */
export function supportsRouting(provider: LLMProvider): boolean {
  return provider in DEFAULT_TIERS;
}
