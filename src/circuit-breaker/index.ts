/**
 * Circuit Breaker Module
 *
 * Barrel export for the circuit breaker system.
 */

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
} from './types.js';

export { DEFAULT_CIRCUIT_BREAKER_CONFIG } from './defaults.js';
export { CircuitBreaker } from './breaker.js';
