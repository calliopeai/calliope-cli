import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../src/circuit-breaker.js';
import type { IterationData, BreakerType, CircuitBreakerConfig } from '../src/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker();
  });

  // ============================================================================
  // Defaults & Initialization
  // ============================================================================

  describe('defaults', () => {
    it('should have all 5 breaker types configured', () => {
      const config = DEFAULT_CIRCUIT_BREAKER_CONFIG;
      expect(config.breakers['repeated-failure']).toBeDefined();
      expect(config.breakers['cost-runaway']).toBeDefined();
      expect(config.breakers['infinite-loop']).toBeDefined();
      expect(config.breakers['token-burn']).toBeDefined();
      expect(config.breakers['stall']).toBeDefined();
    });

    it('should have sensible default thresholds', () => {
      const config = DEFAULT_CIRCUIT_BREAKER_CONFIG;
      expect(config.breakers['repeated-failure'].maxConsecutiveErrors).toBe(3);
      expect(config.breakers['cost-runaway'].maxSessionCost).toBe(5.0);
      expect(config.breakers['cost-runaway'].maxCostPerMinute).toBe(1.0);
      expect(config.breakers['infinite-loop'].maxIdenticalInWindow).toBe(3);
      expect(config.breakers['token-burn'].maxTokensPerIteration).toBe(200_000);
      expect(config.breakers['token-burn'].maxTotalTokens).toBe(5_000_000);
      expect(config.breakers['stall'].maxIdleIterations).toBe(5);
    });

    it('should be enabled by default', () => {
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.enabled).toBe(true);
    });
  });

  describe('initialization', () => {
    it('should start with all breakers closed', () => {
      const statuses = breaker.getStatus();
      expect(statuses).toHaveLength(6);
      for (const status of statuses) {
        expect(status.state).toBe('closed');
        expect(status.tripCount).toBe(0);
      }
    });

    it('should report health as ok initially', () => {
      expect(breaker.getHealth()).toBe('ok');
    });

    it('should not be tripped initially', () => {
      expect(breaker.isTripped()).toBe(false);
    });

    it('should accept custom config', () => {
      const custom = new CircuitBreaker({
        breakers: {
          'repeated-failure': { maxConsecutiveErrors: 10 },
          'cost-runaway': { maxSessionCost: 20, maxCostPerMinute: 5, windowSizeMs: 60000 },
          'infinite-loop': { maxIdenticalInWindow: 5, windowSize: 10, detectOscillation: false },
          'token-burn': { maxTokensPerIteration: 100000, maxTotalTokens: 5000000 },
          'stall': { maxIdleIterations: 10 },
        },
      });
      const config = custom.getConfig();
      expect(config.breakers['repeated-failure'].maxConsecutiveErrors).toBe(10);
    });
  });

  // ============================================================================
  // Repeated Failure Breaker
  // ============================================================================

  describe('repeated-failure breaker', () => {
    it('should not trip on a single error', () => {
      const result = breaker.check({ iteration: 1, error: 'API error' });
      expect(result.tripped).toBe(false);
    });

    it('should not trip on 2 consecutive errors (default limit is 3)', () => {
      breaker.check({ iteration: 1, error: 'error 1' });
      const result = breaker.check({ iteration: 2, error: 'error 2' });
      expect(result.tripped).toBe(false);
    });

    it('should trip on 3 consecutive errors', () => {
      breaker.check({ iteration: 1, error: 'error 1' });
      breaker.check({ iteration: 2, error: 'error 2' });
      const result = breaker.check({ iteration: 3, error: 'error 3' });
      expect(result.tripped).toBe(true);
      expect(result.breaker).toBe('repeated-failure');
    });

    it('should reset consecutive count on success', () => {
      breaker.check({ iteration: 1, error: 'error 1' });
      breaker.check({ iteration: 2, error: 'error 2' });
      // Success resets the counter
      breaker.check({ iteration: 3, toolCalls: [{ name: 'read_file', arguments: { path: '/tmp/test' } }] });
      // Now 2 more errors shouldn't trip
      breaker.check({ iteration: 4, error: 'error 4' });
      const result = breaker.check({ iteration: 5, error: 'error 5' });
      expect(result.tripped).toBe(false);
    });

    it('should report health as tripped after tripping', () => {
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });
      expect(breaker.getHealth()).toBe('tripped');
      expect(breaker.isTripped()).toBe(true);
    });
  });

  // ============================================================================
  // Cost Runaway Breaker
  // ============================================================================

  describe('cost-runaway breaker', () => {
    it('should not trip under the session cost limit', () => {
      const result = breaker.check({ iteration: 1, cost: 0.5, content: 'x' });
      expect(result.tripped).toBe(false);
    });

    it('should trip when session cost exceeds limit', () => {
      // Use small per-iteration costs under the $1/min rate limit
      // but accumulating past the $5 session limit
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const r = breaker.check({
          iteration: i + 1,
          cost: 0.9,
          content: `result ${i}`,
          timestamp: new Date(now + i * 70_000), // Spread apart so rate stays under $1/min
        });
        expect(r.tripped).toBe(false);
      }
      // totalCost is now 4.5, under $5 limit
      expect(breaker.getTrackingStats().totalCost).toBeCloseTo(4.5);
      const result = breaker.check({
        iteration: 6,
        cost: 0.9,
        content: 'result 5',
        timestamp: new Date(now + 5 * 70_000),
      });
      // totalCost is now 5.4, exceeding $5 limit
      expect(result.tripped).toBe(true);
      expect(result.breaker).toBe('cost-runaway');
    });

    it('should trip on high spend rate within window', () => {
      const now = Date.now();
      // All within the same 1-minute window
      breaker.check({ iteration: 1, cost: 0.4, timestamp: new Date(now) });
      breaker.check({ iteration: 2, cost: 0.4, timestamp: new Date(now + 1000) });
      const result = breaker.check({ iteration: 3, cost: 0.4, timestamp: new Date(now + 2000) });
      expect(result.tripped).toBe(true);
      expect(result.breaker).toBe('cost-runaway');
    });
  });

  // ============================================================================
  // Infinite Loop Breaker
  // ============================================================================

  describe('infinite-loop breaker', () => {
    it('should not trip on different tool calls', () => {
      const result1 = breaker.check({
        iteration: 1,
        toolCalls: [{ name: 'read_file', arguments: { path: '/a.ts' } }],
      });
      const result2 = breaker.check({
        iteration: 2,
        toolCalls: [{ name: 'read_file', arguments: { path: '/b.ts' } }],
      });
      const result3 = breaker.check({
        iteration: 3,
        toolCalls: [{ name: 'write_file', arguments: { path: '/c.ts', content: 'x' } }],
      });
      expect(result1.tripped).toBe(false);
      expect(result2.tripped).toBe(false);
      expect(result3.tripped).toBe(false);
    });

    it('should trip on identical tool calls repeated', () => {
      const sameCall = [{ name: 'read_file', arguments: { path: '/same.ts' } }];
      breaker.check({ iteration: 1, toolCalls: sameCall });
      breaker.check({ iteration: 2, toolCalls: sameCall });
      const result = breaker.check({ iteration: 3, toolCalls: sameCall });
      expect(result.tripped).toBe(true);
      expect(result.breaker).toBe('infinite-loop');
    });

    it('should detect A-B-A-B oscillation', () => {
      const callA = [{ name: 'read_file', arguments: { path: '/a.ts' } }];
      const callB = [{ name: 'write_file', arguments: { path: '/a.ts', content: 'x' } }];
      breaker.check({ iteration: 1, toolCalls: callA });
      breaker.check({ iteration: 2, toolCalls: callB });
      breaker.check({ iteration: 3, toolCalls: callA });
      const result = breaker.check({ iteration: 4, toolCalls: callB });
      expect(result.tripped).toBe(true);
      expect(result.breaker).toBe('infinite-loop');
      expect(result.data?.pattern).toBe('A-B-A-B');
    });
  });

  // ============================================================================
  // Token Burn Breaker
  // ============================================================================

  describe('token-burn breaker', () => {
    it('should not trip on normal token usage', () => {
      const result = breaker.check({
        iteration: 1,
        inputTokens: 5000,
        outputTokens: 3000,
      });
      expect(result.tripped).toBe(false);
    });

    it('should trip on excessive per-iteration tokens', () => {
      const result = breaker.check({
        iteration: 1,
        inputTokens: 120000,
        outputTokens: 100000,
      });
      expect(result.tripped).toBe(true);
      expect(result.breaker).toBe('token-burn');
    });

    it('should trip on cumulative token burn', () => {
      // Each iteration uses 180K tokens (under 200K per-iteration limit)
      // 5M / 180K = ~27.8, so iteration 28 should trip
      let tripped = false;
      let tripResult;
      for (let i = 0; i < 35; i++) {
        const result = breaker.check({
          iteration: i + 1,
          inputTokens: 100000,
          outputTokens: 80000,
          content: `Response ${i}`,
        });
        if (result.tripped && result.breaker === 'token-burn') {
          tripped = true;
          tripResult = result;
          break;
        }
      }
      expect(tripped).toBe(true);
      expect(tripResult!.breaker).toBe('token-burn');
      // Should trip around iteration 28
      expect(breaker.getTrackingStats().totalTokens).toBeGreaterThan(5_000_000);
    });
  });

  // ============================================================================
  // Stall Breaker
  // ============================================================================

  describe('stall breaker', () => {
    it('should not trip when there are tool calls', () => {
      for (let i = 0; i < 10; i++) {
        const result = breaker.check({
          iteration: i + 1,
          toolCalls: [{ name: 'read_file', arguments: { path: `/file-${i}.ts` } }],
        });
        expect(result.tripped).toBe(false);
      }
    });

    it('should not trip when there is content', () => {
      for (let i = 0; i < 10; i++) {
        const result = breaker.check({
          iteration: i + 1,
          content: 'Some meaningful response',
        });
        expect(result.tripped).toBe(false);
      }
    });

    it('should trip after 5 idle iterations', () => {
      for (let i = 0; i < 4; i++) {
        breaker.check({ iteration: i + 1 });
      }
      const result = breaker.check({ iteration: 5 });
      expect(result.tripped).toBe(true);
      expect(result.breaker).toBe('stall');
    });

    it('should reset idle count on tool call', () => {
      breaker.check({ iteration: 1 });
      breaker.check({ iteration: 2 });
      breaker.check({ iteration: 3 });
      // Tool call resets idle count
      breaker.check({
        iteration: 4,
        toolCalls: [{ name: 'read_file', arguments: { path: '/test' } }],
      });
      breaker.check({ iteration: 5 });
      breaker.check({ iteration: 6 });
      const result = breaker.check({ iteration: 7 });
      expect(result.tripped).toBe(false);
    });
  });

  // ============================================================================
  // State Machine: Resume & Reset
  // ============================================================================

  describe('resume', () => {
    it('should move tripped breaker to half-open', () => {
      // Trip the breaker
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });
      expect(breaker.getHealth()).toBe('tripped');

      // Resume
      breaker.resume('repeated-failure');
      expect(breaker.getHealth()).toBe('warning');

      const status = breaker.getStatus().find(s => s.type === 'repeated-failure');
      expect(status?.state).toBe('half-open');
    });

    it('should resume all open breakers when no type specified', () => {
      // Trip two breakers
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });

      // Reset repeated-failure to closed, trip stall
      breaker.reset('repeated-failure');
      for (let i = 0; i < 5; i++) {
        breaker.check({ iteration: i + 4 });
      }

      breaker.resume(); // Resume all
      const statuses = breaker.getStatus();
      for (const s of statuses) {
        expect(s.state).not.toBe('open');
      }
    });

    it('should use 50% more generous thresholds in half-open', () => {
      // Trip repeated-failure (3 errors)
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });

      // Resume to half-open
      breaker.resume('repeated-failure');

      // In half-open, limit is ceil(3 * 1.5) = 5
      // 3 more errors from the consecutive count (still at 3, wasn't reset)
      const result4 = breaker.check({ iteration: 4, error: 'e4' });
      expect(result4.tripped).toBe(false); // 4 < 5
      const result5 = breaker.check({ iteration: 5, error: 'e5' });
      expect(result5.tripped).toBe(true); // 5 >= 5
    });
  });

  describe('reset', () => {
    it('should reset a specific breaker to closed', () => {
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });

      breaker.reset('repeated-failure');
      const status = breaker.getStatus().find(s => s.type === 'repeated-failure');
      expect(status?.state).toBe('closed');
      expect(breaker.getHealth()).toBe('ok');
    });

    it('should reset all breakers when no type specified', () => {
      // Trip a breaker
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });

      breaker.reset();
      for (const status of breaker.getStatus()) {
        expect(status.state).toBe('closed');
      }
    });

    it('should reset tracking data for the breaker', () => {
      // Build up some consecutive errors
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.reset('repeated-failure');

      // Should need 3 fresh errors to trip now
      breaker.check({ iteration: 3, error: 'e3' });
      breaker.check({ iteration: 4, error: 'e4' });
      const result = breaker.check({ iteration: 5, error: 'e5' });
      expect(result.tripped).toBe(true);
    });
  });

  // ============================================================================
  // Adjust
  // ============================================================================

  describe('adjust', () => {
    it('should update thresholds at runtime', () => {
      breaker.adjust('repeated-failure', { maxConsecutiveErrors: 10 });
      const config = breaker.getConfig();
      expect(config.breakers['repeated-failure'].maxConsecutiveErrors).toBe(10);
    });

    it('should take effect immediately', () => {
      breaker.adjust('repeated-failure', { maxConsecutiveErrors: 1 });
      const result = breaker.check({ iteration: 1, error: 'single error' });
      expect(result.tripped).toBe(true);
    });
  });

  // ============================================================================
  // Disabled
  // ============================================================================

  describe('disabled', () => {
    it('should not trip any breakers when disabled', () => {
      const disabled = new CircuitBreaker({ enabled: false });

      // Try to trip every breaker
      disabled.check({ iteration: 1, error: 'e1' });
      disabled.check({ iteration: 2, error: 'e2' });
      const result = disabled.check({ iteration: 3, error: 'e3' });
      expect(result.tripped).toBe(false);
    });
  });

  // ============================================================================
  // Tracking Stats
  // ============================================================================

  describe('tracking stats', () => {
    it('should track consecutive errors', () => {
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      const stats = breaker.getTrackingStats();
      expect(stats.consecutiveErrors).toBe(2);
    });

    it('should track total tokens', () => {
      breaker.check({ iteration: 1, inputTokens: 1000, outputTokens: 500, content: 'x' });
      breaker.check({ iteration: 2, inputTokens: 2000, outputTokens: 1000, content: 'y' });
      const stats = breaker.getTrackingStats();
      expect(stats.totalTokens).toBe(4500);
    });

    it('should track total cost', () => {
      breaker.check({ iteration: 1, cost: 0.05, content: 'x' });
      breaker.check({ iteration: 2, cost: 0.10, content: 'y' });
      const stats = breaker.getTrackingStats();
      expect(stats.totalCost).toBeCloseTo(0.15);
    });

    it('should track idle count', () => {
      breaker.check({ iteration: 1 });
      breaker.check({ iteration: 2 });
      breaker.check({ iteration: 3 });
      const stats = breaker.getTrackingStats();
      expect(stats.idleCount).toBe(3);
    });
  });

  // ============================================================================
  // Status Reporting
  // ============================================================================

  describe('status', () => {
    it('should report trip counts', () => {
      // Trip, reset, trip again
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });
      breaker.reset('repeated-failure');
      breaker.check({ iteration: 4, error: 'e4' });
      breaker.check({ iteration: 5, error: 'e5' });
      breaker.check({ iteration: 6, error: 'e6' });

      const status = breaker.getStatus().find(s => s.type === 'repeated-failure');
      expect(status?.tripCount).toBe(2);
    });

    it('should track last tripped time', () => {
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });

      const status = breaker.getStatus().find(s => s.type === 'repeated-failure');
      expect(status?.lastTripped).toBeInstanceOf(Date);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('should handle empty iteration data', () => {
      const result = breaker.check({ iteration: 1 });
      expect(result.tripped).toBe(false);
    });

    it('should not double-trip an already-open breaker', () => {
      // Trip repeated-failure
      breaker.check({ iteration: 1, error: 'e1' });
      breaker.check({ iteration: 2, error: 'e2' });
      breaker.check({ iteration: 3, error: 'e3' });

      // Further errors should not re-trip (it's already open)
      const result = breaker.check({ iteration: 4, error: 'e4' });
      expect(result.tripped).toBe(false); // Already open, skip

      const status = breaker.getStatus().find(s => s.type === 'repeated-failure');
      expect(status?.tripCount).toBe(1);
    });

    it('should handle multiple breakers tripping independently', () => {
      // Trip repeated-failure
      const failBreaker = new CircuitBreaker();
      const c1 = failBreaker.check({ iteration: 1, error: 'e1' });
      const c2 = failBreaker.check({ iteration: 2, error: 'e2' });
      const r1 = failBreaker.check({ iteration: 3, error: 'e3' });
      // Verify tracking state
      const stats = failBreaker.getTrackingStats();
      expect(stats.consecutiveErrors).toBe(3);
      expect(c1.tripped).toBe(false);
      expect(c2.tripped).toBe(false);
      expect(r1.tripped).toBe(true);
      expect(r1.breaker).toBe('repeated-failure');

      // Trip stall on a separate breaker
      const stallBreaker = new CircuitBreaker();
      for (let i = 0; i < 5; i++) {
        stallBreaker.check({ iteration: i + 1 });
      }
      expect(stallBreaker.getStatus().find(s => s.type === 'stall')?.state).toBe('open');

      // Both breaker types can trip independently
      expect(failBreaker.getStatus().find(s => s.type === 'repeated-failure')?.state).toBe('open');
      expect(stallBreaker.getStatus().find(s => s.type === 'stall')?.state).toBe('open');
    });
  });
});
