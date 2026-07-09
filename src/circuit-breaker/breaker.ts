/**
 * Circuit Breaker
 *
 * Framework-agnostic circuit breaker that monitors agent loop iterations
 * and trips on bad behavior patterns. State machine: closed → open → half-open.
 *
 * When tripped (open), the agent loop should pause and notify the user.
 * User can resume (half-open) which runs at reduced thresholds (50%).
 */

import type {
  BreakerType,
  BreakerState,
  BreakerStatus,
  BreakerEvent,
  BreakerCheckResult,
  CircuitBreakerConfig,
  IterationData,
} from './types.js';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from './defaults.js';

// ============================================================================
// Tool Call Fingerprinting
// ============================================================================

function fingerprint(toolCall: { name: string; arguments: Record<string, unknown> }): string {
  const sortedArgs = Object.keys(toolCall.arguments)
    .sort()
    .map(k => `${k}=${JSON.stringify(toolCall.arguments[k])}`)
    .join('&');
  return `${toolCall.name}:${sortedArgs}`;
}

// ============================================================================
// CircuitBreaker Class
// ============================================================================

export class CircuitBreaker {
  private config: CircuitBreakerConfig;

  // Per-breaker state
  private states: Map<BreakerType, BreakerState> = new Map();
  private tripCounts: Map<BreakerType, number> = new Map();
  private lastTripped: Map<BreakerType, Date> = new Map();
  private lastEvents: Map<BreakerType, BreakerEvent> = new Map();

  // Tracking data
  private consecutiveErrors = 0;
  private totalTokens = 0;
  private totalCost = 0;
  private idleCount = 0;
  private costWindow: Array<{ cost: number; timestamp: number }> = [];
  private toolCallHistory: string[] = []; // fingerprints
  private startTime: number;
  private lastIterationStart = 0;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    // Deep clone defaults to avoid shared state between instances
    this.config = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...config,
      breakers: {
        'repeated-failure': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['repeated-failure'] },
        'cost-runaway': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['cost-runaway'] },
        'infinite-loop': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['infinite-loop'] },
        'token-burn': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['token-burn'] },
        'stall': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['stall'] },
        'wall-clock': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['wall-clock'] },
        ...(config?.breakers ? {
          ...(config.breakers['repeated-failure'] ? { 'repeated-failure': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['repeated-failure'], ...config.breakers['repeated-failure'] } } : {}),
          ...(config.breakers['cost-runaway'] ? { 'cost-runaway': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['cost-runaway'], ...config.breakers['cost-runaway'] } } : {}),
          ...(config.breakers['infinite-loop'] ? { 'infinite-loop': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['infinite-loop'], ...config.breakers['infinite-loop'] } } : {}),
          ...(config.breakers['token-burn'] ? { 'token-burn': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['token-burn'], ...config.breakers['token-burn'] } } : {}),
          ...(config.breakers['stall'] ? { 'stall': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['stall'], ...config.breakers['stall'] } } : {}),
          ...(config.breakers['wall-clock'] ? { 'wall-clock': { ...DEFAULT_CIRCUIT_BREAKER_CONFIG.breakers['wall-clock'], ...config.breakers['wall-clock'] } } : {}),
        } : {}),
      },
    };
    this.startTime = Date.now();

    // Initialize all breakers to closed
    const types: BreakerType[] = ['repeated-failure', 'cost-runaway', 'infinite-loop', 'token-burn', 'stall', 'wall-clock'];
    for (const type of types) {
      this.states.set(type, 'closed');
      this.tripCounts.set(type, 0);
    }
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Check all breakers against iteration data. Returns the first trip found.
   */
  check(data: IterationData): BreakerCheckResult {
    if (!this.config.enabled) {
      return { tripped: false };
    }

    // Update tracking state
    this.updateTracking(data);

    // Check each breaker (skip if already open)
    const checks: Array<() => BreakerCheckResult> = [
      () => this.checkRepeatedFailure(data),
      () => this.checkCostRunaway(data),
      () => this.checkInfiniteLoop(data),
      () => this.checkTokenBurn(data),
      () => this.checkStall(data),
      () => this.checkWallClock(data),
    ];

    for (const check of checks) {
      const result = check();
      if (result.tripped) {
        return result;
      }
    }

    return { tripped: false };
  }

  /**
   * Resume a tripped breaker (moves to half-open state with 50% thresholds).
   */
  resume(type?: BreakerType): void {
    if (type) {
      if (this.states.get(type) === 'open') {
        this.states.set(type, 'half-open');
      }
    } else {
      // Resume all open breakers
      for (const [t, state] of this.states) {
        if (state === 'open') {
          this.states.set(t, 'half-open');
        }
      }
    }
  }

  /**
   * Reset a specific breaker or all breakers to closed.
   */
  reset(type?: BreakerType): void {
    if (type) {
      this.states.set(type, 'closed');
      this.resetTrackingForBreaker(type);
    } else {
      for (const t of this.states.keys()) {
        this.states.set(t, 'closed');
      }
      this.resetAllTracking();
    }
  }

  /**
   * Update thresholds for a specific breaker at runtime.
   */
  adjust(type: BreakerType, thresholds: Record<string, unknown>): void {
    const current = this.config.breakers[type];
    (this.config.breakers as Record<string, unknown>)[type] = { ...current, ...thresholds };
  }

  /**
   * Get status of all breakers.
   */
  getStatus(): BreakerStatus[] {
    const types: BreakerType[] = ['repeated-failure', 'cost-runaway', 'infinite-loop', 'token-burn', 'stall', 'wall-clock'];
    return types.map(type => ({
      type,
      state: this.states.get(type) || 'closed',
      tripCount: this.tripCounts.get(type) || 0,
      lastTripped: this.lastTripped.get(type),
      lastEvent: this.lastEvents.get(type),
    }));
  }

  /**
   * Get overall health: 'ok' | 'warning' | 'tripped'
   */
  getHealth(): 'ok' | 'warning' | 'tripped' {
    let hasHalfOpen = false;
    for (const state of this.states.values()) {
      if (state === 'open') return 'tripped';
      if (state === 'half-open') hasHalfOpen = true;
    }
    return hasHalfOpen ? 'warning' : 'ok';
  }

  /**
   * Check if any breaker is currently tripped (open state).
   */
  isTripped(): boolean {
    for (const state of this.states.values()) {
      if (state === 'open') return true;
    }
    return false;
  }

  /**
   * Get the current config.
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /**
   * Get tracking stats for display.
   */
  getTrackingStats(): {
    consecutiveErrors: number;
    totalTokens: number;
    totalCost: number;
    idleCount: number;
    recentToolCalls: number;
  } {
    return {
      consecutiveErrors: this.consecutiveErrors,
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
      idleCount: this.idleCount,
      recentToolCalls: this.toolCallHistory.length,
    };
  }

  // ============================================================================
  // Tracking Updates
  // ============================================================================

  private updateTracking(data: IterationData): void {
    const now = data.timestamp?.getTime() ?? Date.now();

    // Consecutive errors
    if (data.error) {
      this.consecutiveErrors++;
    } else {
      this.consecutiveErrors = 0;
    }

    // Token tracking
    const iterationTokens = (data.inputTokens || 0) + (data.outputTokens || 0);
    this.totalTokens += iterationTokens;

    // Cost tracking
    if (data.cost && data.cost > 0) {
      this.totalCost += data.cost;
      this.costWindow.push({ cost: data.cost, timestamp: now });
      // Prune old entries outside window
      const windowMs = this.config.breakers['cost-runaway'].windowSizeMs;
      this.costWindow = this.costWindow.filter(e => now - e.timestamp < windowMs);
    }

    // Tool call fingerprinting
    if (data.toolCalls && data.toolCalls.length > 0) {
      for (const tc of data.toolCalls) {
        this.toolCallHistory.push(fingerprint(tc));
      }
      // Keep only recent history
      const maxHistory = this.config.breakers['infinite-loop'].windowSize * 2;
      if (this.toolCallHistory.length > maxHistory) {
        this.toolCallHistory = this.toolCallHistory.slice(-maxHistory);
      }
      this.idleCount = 0; // Tool calls = not idle
    } else if (data.content && data.content.trim().length > 0) {
      this.idleCount = 0; // Content = not idle
    } else if (!data.error) {
      this.idleCount++;
    }
  }

  private resetTrackingForBreaker(type: BreakerType): void {
    switch (type) {
      case 'repeated-failure':
        this.consecutiveErrors = 0;
        break;
      case 'cost-runaway':
        this.costWindow = [];
        break;
      case 'infinite-loop':
        this.toolCallHistory = [];
        break;
      case 'token-burn':
        this.totalTokens = 0;
        break;
      case 'stall':
        this.idleCount = 0;
        break;
      case 'wall-clock':
        this.lastIterationStart = 0;
        break;
    }
  }

  private resetAllTracking(): void {
    this.consecutiveErrors = 0;
    this.totalTokens = 0;
    this.totalCost = 0;
    this.idleCount = 0;
    this.costWindow = [];
    this.toolCallHistory = [];
    this.startTime = Date.now();
    this.lastIterationStart = 0;
  }

  // ============================================================================
  // Individual Breaker Checks
  // ============================================================================

  private trip(type: BreakerType, message: string, data?: Record<string, unknown>): BreakerCheckResult {
    this.states.set(type, 'open');
    this.tripCounts.set(type, (this.tripCounts.get(type) || 0) + 1);
    this.lastTripped.set(type, new Date());

    const event: BreakerEvent = { type, timestamp: new Date(), message, data };
    this.lastEvents.set(type, event);

    return { tripped: true, breaker: type, message, data };
  }

  private getThresholdMultiplier(type: BreakerType): number {
    // Half-open state uses 50% more generous thresholds
    return this.states.get(type) === 'half-open' ? 1.5 : 1.0;
  }

  private checkRepeatedFailure(_data: IterationData): BreakerCheckResult {
    const type: BreakerType = 'repeated-failure';
    if (this.states.get(type) === 'open') return { tripped: false };

    const thresholds = this.config.breakers[type];
    const limit = Math.ceil(thresholds.maxConsecutiveErrors * this.getThresholdMultiplier(type));

    if (this.consecutiveErrors >= limit) {
      return this.trip(type,
        `${this.consecutiveErrors} consecutive errors detected. The agent may be stuck in an error loop.`,
        { consecutiveErrors: this.consecutiveErrors, limit },
      );
    }

    return { tripped: false };
  }

  private checkCostRunaway(_data: IterationData): BreakerCheckResult {
    const type: BreakerType = 'cost-runaway';
    if (this.states.get(type) === 'open') return { tripped: false };

    const thresholds = this.config.breakers[type];
    const multiplier = this.getThresholdMultiplier(type);

    // Check session ceiling
    const sessionLimit = thresholds.maxSessionCost * multiplier;
    if (this.totalCost >= sessionLimit) {
      return this.trip(type,
        `Session cost $${this.totalCost.toFixed(2)} exceeded limit of $${sessionLimit.toFixed(2)}.`,
        { totalCost: this.totalCost, limit: sessionLimit },
      );
    }

    // Check spend rate (sliding window)
    if (this.costWindow.length > 0) {
      const windowCost = this.costWindow.reduce((sum, e) => sum + e.cost, 0);
      const rateLimit = thresholds.maxCostPerMinute * multiplier;
      if (windowCost >= rateLimit) {
        return this.trip(type,
          `Spend rate $${windowCost.toFixed(2)}/min exceeded limit of $${rateLimit.toFixed(2)}/min.`,
          { windowCost, rateLimit },
        );
      }
    }

    return { tripped: false };
  }

  private checkInfiniteLoop(_data: IterationData): BreakerCheckResult {
    const type: BreakerType = 'infinite-loop';
    if (this.states.get(type) === 'open') return { tripped: false };

    const thresholds = this.config.breakers[type];
    const multiplier = this.getThresholdMultiplier(type);
    const history = this.toolCallHistory;

    if (history.length < 2) return { tripped: false };

    // Check for identical tool calls in window
    const window = history.slice(-thresholds.windowSize);
    const fingerCounts = new Map<string, number>();
    for (const fp of window) {
      fingerCounts.set(fp, (fingerCounts.get(fp) || 0) + 1);
    }

    const identicalLimit = Math.ceil(thresholds.maxIdenticalInWindow * multiplier);
    for (const [fp, count] of fingerCounts) {
      if (count >= identicalLimit) {
        const toolName = fp.split(':')[0];
        return this.trip(type,
          `Tool "${toolName}" called ${count} times with identical arguments in last ${thresholds.windowSize} calls.`,
          { fingerprint: fp, count, limit: identicalLimit },
        );
      }
    }

    // Check for A-B-A-B oscillation pattern
    if (thresholds.detectOscillation && history.length >= 4) {
      const recent = history.slice(-4);
      if (recent[0] === recent[2] && recent[1] === recent[3] && recent[0] !== recent[1]) {
        const toolA = recent[0]!.split(':')[0];
        const toolB = recent[1]!.split(':')[0];
        return this.trip(type,
          `Oscillation detected: "${toolA}" and "${toolB}" alternating repeatedly.`,
          { pattern: 'A-B-A-B', toolA, toolB },
        );
      }
    }

    return { tripped: false };
  }

  private checkTokenBurn(data: IterationData): BreakerCheckResult {
    const type: BreakerType = 'token-burn';
    if (this.states.get(type) === 'open') return { tripped: false };

    const thresholds = this.config.breakers[type];
    const multiplier = this.getThresholdMultiplier(type);

    // Check per-iteration token usage
    const iterationTokens = (data.inputTokens || 0) + (data.outputTokens || 0);
    const iterLimit = Math.ceil(thresholds.maxTokensPerIteration * multiplier);
    if (iterationTokens > iterLimit) {
      return this.trip(type,
        `Iteration used ${iterationTokens.toLocaleString()} tokens, exceeding limit of ${iterLimit.toLocaleString()}.`,
        { iterationTokens, limit: iterLimit },
      );
    }

    // Check cumulative token usage
    const totalLimit = Math.ceil(thresholds.maxTotalTokens * multiplier);
    if (this.totalTokens > totalLimit) {
      return this.trip(type,
        `Total token usage ${this.totalTokens.toLocaleString()} exceeded limit of ${totalLimit.toLocaleString()}.`,
        { totalTokens: this.totalTokens, limit: totalLimit },
      );
    }

    return { tripped: false };
  }

  private checkStall(_data: IterationData): BreakerCheckResult {
    const type: BreakerType = 'stall';
    if (this.states.get(type) === 'open') return { tripped: false };

    const thresholds = this.config.breakers[type];
    const limit = Math.ceil(thresholds.maxIdleIterations * this.getThresholdMultiplier(type));

    if (this.idleCount >= limit) {
      return this.trip(type,
        `Agent idle for ${this.idleCount} iterations (no tool calls or meaningful content).`,
        { idleCount: this.idleCount, limit },
      );
    }

    return { tripped: false };
  }

  private checkWallClock(_data: IterationData): BreakerCheckResult {
    const type: BreakerType = 'wall-clock';
    if (this.states.get(type) === 'open') return { tripped: false };

    const thresholds = this.config.breakers[type];
    const multiplier = this.getThresholdMultiplier(type);
    const now = Date.now();

    // Check session duration (0 = no cap)
    if (thresholds.maxSessionDurationMs > 0) {
      const sessionDuration = now - this.startTime;
      const sessionLimit = Math.ceil(thresholds.maxSessionDurationMs * multiplier);
      if (sessionDuration >= sessionLimit) {
        const minutes = Math.round(sessionDuration / 60_000);
        const limitMinutes = Math.round(sessionLimit / 60_000);
        return this.trip(type,
          `Session running for ${minutes} minutes, exceeded limit of ${limitMinutes} minutes.`,
          { sessionDurationMs: sessionDuration, limitMs: sessionLimit },
        );
      }
    }

    // Check iteration duration (using timestamp from iteration data vs last check)
    if (this.lastIterationStart > 0) {
      const iterDuration = now - this.lastIterationStart;
      const iterLimit = Math.ceil(thresholds.maxIterationDurationMs * multiplier);
      if (iterDuration >= iterLimit) {
        const seconds = Math.round(iterDuration / 1000);
        const limitSeconds = Math.round(iterLimit / 1000);
        return this.trip(type,
          `Single iteration took ${seconds}s, exceeded limit of ${limitSeconds}s.`,
          { iterationDurationMs: iterDuration, limitMs: iterLimit },
        );
      }
    }
    this.lastIterationStart = now;

    return { tripped: false };
  }
}
