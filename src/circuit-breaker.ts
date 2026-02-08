/**
 * Circuit Breaker - Top-level barrel
 *
 * Re-exports from src/circuit-breaker/ for clean imports.
 */

export {
  CircuitBreaker,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from './circuit-breaker/index.js';

export type {
  BreakerType,
  BreakerState,
  BreakerStatus,
  BreakerEvent,
  BreakerCheckResult,
  CircuitBreakerConfig,
  IterationData,
  RepeatedFailureThresholds,
  CostRunawayThresholds,
  InfiniteLoopThresholds,
  TokenBurnThresholds,
  StallThresholds,
  BreakerThresholds,
} from './circuit-breaker/index.js';
