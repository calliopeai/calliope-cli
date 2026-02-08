/**
 * Circuit Breaker Types
 *
 * Type definitions for the circuit breaker system that replaces
 * hard iteration caps with intelligent pause-on-bad-behavior.
 */

// ============================================================================
// Breaker Types
// ============================================================================

export type BreakerType =
  | 'repeated-failure'
  | 'cost-runaway'
  | 'infinite-loop'
  | 'token-burn'
  | 'stall';

export type BreakerState = 'closed' | 'open' | 'half-open';

// ============================================================================
// Thresholds
// ============================================================================

export interface RepeatedFailureThresholds {
  maxConsecutiveErrors: number;
}

export interface CostRunawayThresholds {
  maxSessionCost: number;       // USD ceiling per session
  maxCostPerMinute: number;     // USD/min sliding window
  windowSizeMs: number;         // Sliding window size (default: 60000)
}

export interface InfiniteLoopThresholds {
  maxIdenticalInWindow: number; // Identical tool call fingerprints in window
  windowSize: number;           // Number of recent calls to check
  detectOscillation: boolean;   // Detect A-B-A-B patterns
}

export interface TokenBurnThresholds {
  maxTokensPerIteration: number;
  maxTotalTokens: number;
}

export interface StallThresholds {
  maxIdleIterations: number;    // Iterations with no tool calls or content
}

export type BreakerThresholds =
  | RepeatedFailureThresholds
  | CostRunawayThresholds
  | InfiniteLoopThresholds
  | TokenBurnThresholds
  | StallThresholds;

// ============================================================================
// Events & Status
// ============================================================================

export interface BreakerEvent {
  type: BreakerType;
  timestamp: Date;
  message: string;
  data?: Record<string, unknown>;
}

export interface BreakerStatus {
  type: BreakerType;
  state: BreakerState;
  tripCount: number;
  lastTripped?: Date;
  lastEvent?: BreakerEvent;
}

// ============================================================================
// Configuration
// ============================================================================

export interface CircuitBreakerConfig {
  enabled: boolean;
  breakers: {
    'repeated-failure': RepeatedFailureThresholds;
    'cost-runaway': CostRunawayThresholds;
    'infinite-loop': InfiniteLoopThresholds;
    'token-burn': TokenBurnThresholds;
    'stall': StallThresholds;
  };
}

// ============================================================================
// Iteration Data (fed into breaker checks)
// ============================================================================

export interface IterationData {
  iteration: number;
  error?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  content?: string;
  timestamp?: Date;
}

// ============================================================================
// Check Result
// ============================================================================

export interface BreakerCheckResult {
  tripped: boolean;
  breaker?: BreakerType;
  message?: string;
  data?: Record<string, unknown>;
}
