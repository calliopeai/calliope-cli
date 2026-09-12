import type { LLMProvider, Message } from '../types.js';
import type { ModelCapabilities, ModelInfo, ReasoningEffort } from '../models/index.js';
import type { HealthProvider } from '../health/index.js';

export interface RoutingPreferences {
  enabled?: boolean;
  costSensitivity?: number;
  preferredProviders?: HealthProvider[];
  providerPool?: HealthProvider[];
  discoveryTimeoutMs?: number;
}
export interface RoutingRequirements extends Partial<Record<keyof ModelCapabilities, boolean>> {
  /** Estimates for ranking; input can be compacted before dispatch. */
  inputTokens?: number;
  outputTokens?: number;
  /** Optional hard minimum, distinct from the cost estimate. */
  minOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
}
export interface RoutingRequest {
  provider: LLMProvider;
  model?: string;
  /** Original client preference when a continuation is pinned to a selected route. */
  origin?: { provider: LLMProvider; model?: string };
  messages?: Message[];
  requirements?: RoutingRequirements;
  preferences?: RoutingPreferences;
  signal?: AbortSignal;
}
export interface RouteCandidate {
  provider: HealthProvider;
  model: string;
  target: string;
  evidence: 'live' | 'explicit-unverified';
  discoveredAt: string | null;
  capabilities: ModelCapabilities;
  reasoningEffort?: ReasoningEffort;
  contextLength: number | null;
  maxOutputTokens: number | null;
  price: ModelInfo['pricing'] | null;
  estimatedCost: number | null;
  latencyMs: number | null;
  errorRate: number | null;
  score: number;
  reason: string;
}
export interface RoutingDecision {
  version: 1;
  id: string;
  at: string;
  status: 'selected' | 'unavailable' | 'cancelled';
  requested: { provider: LLMProvider; model: string | null };
  mode: 'explicit' | 'auto' | 'protocol-pinned' | 'turn-pinned';
  selected: RouteCandidate | null;
  alternatives: RouteCandidate[];
  exclusions: { provider: string; model?: string; reason: string }[];
  reason: string;
  preferenceSources?: { provider: string; model: string | null };
}
