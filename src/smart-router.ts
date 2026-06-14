/**
 * Smart Router - Cross-Provider Model Selection
 *
 * Analyzes each prompt's task type and routes to the best model
 * across all configured providers. Unlike autoRoute (single-provider
 * tier selection), smart routing considers strength matrices across
 * provider boundaries.
 *
 * Pure functions, no API calls - easy to test.
 */

import type { LLMProvider } from './types.js';
import { analyzeComplexity, type TaskComplexity } from './model-router.js';
import { getConfiguredProviders } from './config.js';

// ============================================================================
// Types
// ============================================================================

export type TaskType = 'code' | 'research' | 'creative' | 'analysis' | 'simple-qa' | 'general';

export interface SmartRouteCandidate {
  provider: LLMProvider;
  model: string;
  tier: 'fast' | 'balanced' | 'smart';
  score: number;
  reason: string;
}

export interface SmartRouteDecision {
  selected: SmartRouteCandidate;
  alternatives: SmartRouteCandidate[];
  taskType: TaskType;
  complexity: TaskComplexity;
  confidence: number;
}

export interface SmartRoutingConfig {
  enabled: boolean;
  providerPool: LLMProvider[];       // Which providers to consider
  costSensitivity: number;            // 0-1: 0 = best quality, 1 = cheapest
  preferredProviders: LLMProvider[];  // Tie-breaker preference
}

// ============================================================================
// Model Strength Matrix
// ============================================================================

interface ModelInfo {
  model: string;
  costPer1kInput: number;
  costPer1kOutput: number;
}

interface ProviderStrengths {
  tiers: Record<'fast' | 'balanced' | 'smart', ModelInfo>;
  strengths: Record<TaskType, number>; // 0-1 relative strength
}

export const MODEL_STRENGTHS: Partial<Record<LLMProvider, ProviderStrengths>> = {
  anthropic: {
    tiers: {
      fast: { model: 'claude-haiku-4-5', costPer1kInput: 0.001, costPer1kOutput: 0.005 },
      balanced: { model: 'claude-sonnet-4-6', costPer1kInput: 0.003, costPer1kOutput: 0.015 },
      smart: { model: 'claude-opus-4-8', costPer1kInput: 0.005, costPer1kOutput: 0.025 },
    },
    strengths: {
      'code': 0.95,
      'research': 0.85,
      'creative': 0.90,
      'analysis': 0.90,
      'simple-qa': 0.80,
      'general': 0.90,
    },
  },
  openai: {
    tiers: {
      fast: { model: 'gpt-4o-mini', costPer1kInput: 0.00015, costPer1kOutput: 0.0006 },
      balanced: { model: 'gpt-4o', costPer1kInput: 0.0025, costPer1kOutput: 0.01 },
      smart: { model: 'o1', costPer1kInput: 0.015, costPer1kOutput: 0.06 },
    },
    strengths: {
      'code': 0.90,
      'research': 0.85,
      'creative': 0.85,
      'analysis': 0.90,
      'simple-qa': 0.85,
      'general': 0.88,
    },
  },
  google: {
    tiers: {
      fast: { model: 'gemini-2.0-flash', costPer1kInput: 0.000075, costPer1kOutput: 0.0003 },
      balanced: { model: 'gemini-1.5-pro', costPer1kInput: 0.00125, costPer1kOutput: 0.005 },
      smart: { model: 'gemini-1.5-pro', costPer1kInput: 0.00125, costPer1kOutput: 0.005 },
    },
    strengths: {
      'code': 0.80,
      'research': 0.90,
      'creative': 0.80,
      'analysis': 0.85,
      'simple-qa': 0.90,
      'general': 0.85,
    },
  },
  groq: {
    tiers: {
      fast: { model: 'llama-3.1-8b-instant', costPer1kInput: 0.00005, costPer1kOutput: 0.00008 },
      balanced: { model: 'llama-3.3-70b-versatile', costPer1kInput: 0.00059, costPer1kOutput: 0.00079 },
      smart: { model: 'llama-3.3-70b-versatile', costPer1kInput: 0.00059, costPer1kOutput: 0.00079 },
    },
    strengths: {
      'code': 0.70,
      'research': 0.65,
      'creative': 0.65,
      'analysis': 0.65,
      'simple-qa': 0.80,
      'general': 0.70,
    },
  },
  together: {
    tiers: {
      fast: { model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', costPer1kInput: 0.00018, costPer1kOutput: 0.00018 },
      balanced: { model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', costPer1kInput: 0.00088, costPer1kOutput: 0.00088 },
      smart: { model: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', costPer1kInput: 0.003, costPer1kOutput: 0.003 },
    },
    strengths: {
      'code': 0.75,
      'research': 0.70,
      'creative': 0.70,
      'analysis': 0.70,
      'simple-qa': 0.80,
      'general': 0.72,
    },
  },
  openrouter: {
    tiers: {
      fast: { model: 'anthropic/claude-3.5-haiku', costPer1kInput: 0.0008, costPer1kOutput: 0.004 },
      balanced: { model: 'anthropic/claude-sonnet-4', costPer1kInput: 0.003, costPer1kOutput: 0.015 },
      smart: { model: 'anthropic/claude-opus-4', costPer1kInput: 0.015, costPer1kOutput: 0.075 },
    },
    strengths: {
      'code': 0.93,
      'research': 0.83,
      'creative': 0.88,
      'analysis': 0.88,
      'simple-qa': 0.78,
      'general': 0.88,
    },
  },
  fireworks: {
    tiers: {
      fast: { model: 'accounts/fireworks/models/llama-v3p1-8b-instruct', costPer1kInput: 0.0002, costPer1kOutput: 0.0002 },
      balanced: { model: 'accounts/fireworks/models/llama-v3p1-70b-instruct', costPer1kInput: 0.0009, costPer1kOutput: 0.0009 },
      smart: { model: 'accounts/fireworks/models/llama-v3p1-405b-instruct', costPer1kInput: 0.003, costPer1kOutput: 0.003 },
    },
    strengths: {
      'code': 0.73,
      'research': 0.68,
      'creative': 0.68,
      'analysis': 0.68,
      'simple-qa': 0.78,
      'general': 0.70,
    },
  },
  mistral: {
    tiers: {
      fast: { model: 'mistral-small-latest', costPer1kInput: 0.001, costPer1kOutput: 0.003 },
      balanced: { model: 'mistral-large-latest', costPer1kInput: 0.003, costPer1kOutput: 0.009 },
      smart: { model: 'mistral-large-latest', costPer1kInput: 0.003, costPer1kOutput: 0.009 },
    },
    strengths: {
      'code': 0.78,
      'research': 0.75,
      'creative': 0.75,
      'analysis': 0.78,
      'simple-qa': 0.82,
      'general': 0.78,
    },
  },
  ollama: {
    tiers: {
      fast: { model: 'llama3.1:8b', costPer1kInput: 0, costPer1kOutput: 0 },
      balanced: { model: 'llama3.3', costPer1kInput: 0, costPer1kOutput: 0 },
      smart: { model: 'llama3.3', costPer1kInput: 0, costPer1kOutput: 0 },
    },
    strengths: {
      'code': 0.65,
      'research': 0.60,
      'creative': 0.60,
      'analysis': 0.60,
      'simple-qa': 0.75,
      'general': 0.65,
    },
  },
};

// ============================================================================
// Task Type Detection
// ============================================================================

const TASK_TYPE_PATTERNS: Partial<Record<TaskType, RegExp[]>> = {
  'code': [
    /\b(implement|refactor|bug|fix|debug|code|function|class|method|module)\b/i,
    /\b(typescript|javascript|python|rust|java|go|ruby|c\+\+)\b/i,
    /\.(ts|js|tsx|jsx|py|rs|go|java|rb|cpp|c|h|css|html|sql)\b/,
    /```[\s\S]*```/,
    /\b(npm|pip|cargo|maven|yarn|pnpm|git)\b/i,
    /\b(compile|build|test|lint|deploy)\b/i,
  ],
  'research': [
    /\b(explain|compare|documentation|how\s+does|what\s+is|describe|overview)\b/i,
    /\b(research|investigate|look\s+into|find\s+out|summarize)\b/i,
    /\b(pros\s+and\s+cons|tradeoffs?|trade-offs?|differences?\s+between)\b/i,
  ],
  'creative': [
    /\b(write|story|brainstorm|imagine|creative|poem|narrative)\b/i,
    /\b(generate|compose|craft|design|invent|create\s+a)\b/i,
    /\b(naming|tagline|slogan|pitch|headline)\b/i,
  ],
  'analysis': [
    /\b(analyze|review|audit|evaluate|assess|inspect)\b/i,
    /\b(metrics|performance|benchmark|profil|optimize)\b/i,
    /\b(security|vulnerability|risk|compliance)\b/i,
    /\b(data|statistics|trends|patterns|correlat)\b/i,
  ],
  'simple-qa': [
    /^.{0,80}$/,  // Very short messages
    /^(what|who|when|where|why|how|is|are|do|does|can|could|will|would)\b/i,
    /\?$/,
  ],
};

/**
 * Detect the task type from a user message.
 */
export function detectTaskType(message: string): { taskType: TaskType; confidence: number; signals: string[] } {
  const scores: Record<TaskType, number> = {
    'code': 0,
    'research': 0,
    'creative': 0,
    'analysis': 0,
    'simple-qa': 0,
    'general': 0,
  };
  const signals: string[] = [];

  for (const [type, patterns] of Object.entries(TASK_TYPE_PATTERNS) as [TaskType, RegExp[] | undefined][]) {
    if (!patterns) continue;
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        scores[type] += 1;
        if (scores[type] === 1) {
          signals.push(type);
        }
      }
    }
  }

  // Find highest scoring type
  let bestType: TaskType = 'general';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores) as [TaskType, number][]) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  // If simple-qa is the only match but it's a short question, keep it
  // If code or analysis also matches, those take priority
  if (bestType === 'simple-qa' && scores['code'] > 0) bestType = 'code';
  if (bestType === 'simple-qa' && scores['analysis'] > 0) bestType = 'analysis';
  if (bestType === 'simple-qa' && scores['research'] > 0) bestType = 'research';

  const confidence = bestScore > 0 ? Math.min(0.95, 0.5 + bestScore * 0.15) : 0.3;

  return { taskType: bestType, confidence, signals };
}

// ============================================================================
// Cost Efficiency
// ============================================================================

function costEfficiency(info: ModelInfo): number {
  const avgCost = (info.costPer1kInput + info.costPer1kOutput) / 2;
  if (avgCost === 0) return 1.0; // Free (local) = max efficiency
  // Normalize: lower cost = higher efficiency. Cap at 1.0
  return Math.min(1.0, 0.01 / avgCost);
}

// ============================================================================
// Smart Routing
// ============================================================================

/**
 * Route to the best model across all configured providers.
 *
 * Algorithm:
 * 1. analyzeComplexity() → tier (fast/balanced/smart)
 * 2. detectTaskType() → task type
 * 3. Score each (provider, tier) pair:
 *    score = strength * (1 - costWeight) + costEfficiency * costWeight
 * 4. Return best candidate + alternatives
 */
export function smartRoute(
  message: string,
  routingConfig: SmartRoutingConfig,
  context?: {
    messageCount?: number;
    hasCode?: boolean;
    fileCount?: number;
    toolsUsed?: string[];
  },
): SmartRouteDecision {
  // Step 1: Determine complexity → tier
  const { complexity, confidence: complexityConfidence } = analyzeComplexity(message, context);

  let tier: 'fast' | 'balanced' | 'smart';
  switch (complexity) {
    case 'trivial':
    case 'simple':
      tier = 'fast';
      break;
    case 'moderate':
      tier = 'balanced';
      break;
    case 'complex':
    case 'expert':
      tier = 'smart';
      break;
  }

  // Step 2: Detect task type
  const { taskType, confidence: typeConfidence } = detectTaskType(message);

  // Step 3: Score each (provider, tier) pair
  const pool = routingConfig.providerPool.length > 0
    ? routingConfig.providerPool
    : getConfiguredProviders();
  const costWeight = routingConfig.costSensitivity;

  const candidates: SmartRouteCandidate[] = [];

  for (const provider of pool) {
    const strengths = MODEL_STRENGTHS[provider];
    if (!strengths) continue;

    const modelInfo = strengths.tiers[tier];
    const taskStrength = strengths.strengths[taskType] ?? 0.5;
    const efficiency = costEfficiency(modelInfo);

    const score = taskStrength * (1 - costWeight) + efficiency * costWeight;

    // Preference bonus for preferred providers (small tie-breaker)
    const preferenceBonus = routingConfig.preferredProviders.includes(provider) ? 0.01 : 0;

    candidates.push({
      provider,
      model: modelInfo.model,
      tier,
      score: score + preferenceBonus,
      reason: `${taskType}/${complexity} - strength ${(taskStrength * 100).toFixed(0)}%, cost efficiency ${(efficiency * 100).toFixed(0)}%`,
    });
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // If no candidates found, return a fallback
  if (candidates.length === 0) {
    return {
      selected: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        tier,
        score: 0.5,
        reason: 'fallback - no providers available',
      },
      alternatives: [],
      taskType,
      complexity,
      confidence: Math.min(complexityConfidence, typeConfidence),
    };
  }

  return {
    selected: candidates[0],
    alternatives: candidates.slice(1),
    taskType,
    complexity,
    confidence: Math.min(complexityConfidence, typeConfidence),
  };
}

/**
 * Get default smart routing config.
 */
export function getDefaultSmartRoutingConfig(): SmartRoutingConfig {
  return {
    enabled: false,
    providerPool: [],
    costSensitivity: 0.3,
    preferredProviders: [],
  };
}
