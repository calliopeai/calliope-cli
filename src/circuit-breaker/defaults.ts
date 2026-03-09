/**
 * Circuit Breaker Defaults
 *
 * Default threshold configurations for all 5 breakers.
 */

import type { CircuitBreakerConfig } from './types.js';

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  enabled: true,
  breakers: {
    'repeated-failure': {
      maxConsecutiveErrors: 3,
    },
    'cost-runaway': {
      maxSessionCost: 5.0,        // $5 per session
      maxCostPerMinute: 1.0,      // $1/min sustained spend rate
      windowSizeMs: 60_000,       // 1 minute sliding window
    },
    'infinite-loop': {
      maxIdenticalInWindow: 3,    // 3 identical tool calls in window
      windowSize: 6,              // Check last 6 tool calls
      detectOscillation: true,    // Detect A-B-A-B patterns
    },
    'token-burn': {
      maxTokensPerIteration: 200_000,
      maxTotalTokens: 5_000_000,
    },
    'stall': {
      maxIdleIterations: 5,
    },
    'wall-clock': {
      maxSessionDurationMs: 0,                  // 0 = no session cap
      maxIterationDurationMs: 10 * 60 * 1000,   // 10 minutes per iteration
    },
  },
};
