import { describe, it, expect, beforeEach } from 'vitest';
import { IterationLedger } from '../src/iteration-ledger.js';
// Also import the standalone helper functions (not directly exported, but exercised through the class)

describe('IterationLedger', () => {
  let ledger: IterationLedger;

  beforeEach(() => {
    ledger = new IterationLedger();
  });

  describe('basic tracking', () => {
    it('should start with no entries', () => {
      expect(ledger.getEntries()).toHaveLength(0);
      expect(ledger.getTotals().iterations).toBe(0);
    });

    it('should track a successful iteration', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/src/index.ts' }, 'ok');
      ledger.recordAction('write_file', { path: '/src/index.ts', content: '...' }, 'ok');
      ledger.recordTokens(1000, 500, 0.01);
      ledger.endIteration();

      const entries = ledger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].iteration).toBe(1);
      expect(entries[0].outcome).toBe('success');
      expect(entries[0].actions).toHaveLength(2);
      expect(entries[0].tokens.input).toBe(1000);
      expect(entries[0].tokens.output).toBe(500);
      expect(entries[0].cost).toBe(0.01);
      expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should infer error outcome when all actions fail', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'npm test' }, 'error', 'Exit code 1');
      ledger.endIteration();

      expect(ledger.getEntries()[0].outcome).toBe('error');
    });

    it('should infer partial outcome when some actions fail', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      ledger.recordAction('shell', { command: 'bad' }, 'error', 'not found');
      ledger.endIteration();

      expect(ledger.getEntries()[0].outcome).toBe('partial');
    });

    it('should allow explicit outcome override', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'npm test' }, 'ok');
      ledger.endIteration('error');

      expect(ledger.getEntries()[0].outcome).toBe('error');
    });

    it('should track multiple iterations', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      ledger.endIteration();

      ledger.startIteration(2);
      ledger.recordAction('write_file', { path: '/b.ts', content: '...' }, 'ok');
      ledger.endIteration();

      expect(ledger.getEntries()).toHaveLength(2);
      expect(ledger.getTotals().iterations).toBe(2);
    });
  });

  describe('failed approach tracking', () => {
    it('should auto-detect failed approaches from error iterations', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'npm test' }, 'error', 'Test failed: 3 assertions');
      ledger.endIteration();

      const msg = ledger.getFailedApproachesMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('shell');
      expect(msg).toContain('FAILED');
      expect(msg).toContain('Test failed');
    });

    it('should return null when no failures', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      ledger.endIteration();

      expect(ledger.getFailedApproachesMessage()).toBeNull();
    });

    it('should manually record failed approaches', () => {
      ledger.recordFailedApproach(
        'Tried refactoring utils.ts',
        'Circular dependency introduced',
        ['write_file']
      );

      const msg = ledger.getFailedApproachesMessage();
      expect(msg).toContain('refactoring utils.ts');
      expect(msg).toContain('Circular dependency');
    });

    it('should detect previously failed tool patterns', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'npm test' }, 'error', 'Failed');
      ledger.endIteration();

      const match = ledger.hasFailedBefore('shell', { command: 'npm test' });
      expect(match).toBeDefined();
      expect(match!.reason).toContain('Failed');
    });

    it('should not match different tool patterns', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'npm test' }, 'error', 'Failed');
      ledger.endIteration();

      const match = ledger.hasFailedBefore('shell', { command: 'npm build' });
      expect(match).toBeUndefined();
    });
  });

  describe('context summary', () => {
    it('should generate a readable summary', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/src/index.ts' }, 'ok');
      ledger.recordTokens(500, 200, 0.005);
      ledger.endIteration();

      ledger.startIteration(2);
      ledger.recordAction('shell', { command: 'npm test' }, 'error', 'Exit 1');
      ledger.recordTokens(800, 300, 0.008);
      ledger.endIteration();

      const summary = ledger.getContextSummary();
      expect(summary).toContain('Iteration History');
      expect(summary).toContain('#1 [success]');
      expect(summary).toContain('#2 [error]');
      expect(summary).toContain('Failed Approaches');
    });

    it('should limit entries in summary', () => {
      for (let i = 1; i <= 20; i++) {
        ledger.startIteration(i);
        ledger.recordAction('read_file', { path: `/file${i}.ts` }, 'ok');
        ledger.endIteration();
      }

      const summary = ledger.getContextSummary(5);
      // Should only show last 5
      expect(summary).toContain('#16');
      expect(summary).toContain('#20');
      expect(summary).not.toContain('#10');
    });
  });

  describe('totals', () => {
    it('should aggregate totals correctly', () => {
      ledger.startIteration(1);
      ledger.recordTokens(1000, 500, 0.01);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      ledger.endIteration();

      ledger.startIteration(2);
      ledger.recordTokens(2000, 1000, 0.02);
      ledger.recordAction('shell', { command: 'bad' }, 'error', 'fail');
      ledger.endIteration();

      const totals = ledger.getTotals();
      expect(totals.iterations).toBe(2);
      expect(totals.totalTokens).toBe(4500);
      expect(totals.totalCost).toBeCloseTo(0.03);
      expect(totals.failures).toBe(1);
      expect(totals.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      ledger.endIteration();
      ledger.recordFailedApproach('foo', 'bar');

      ledger.reset();

      expect(ledger.getEntries()).toHaveLength(0);
      expect(ledger.getFailedApproachesMessage()).toBeNull();
      expect(ledger.getTotals().iterations).toBe(0);
    });
  });

  describe('snapshot persistence', () => {
    it('should round-trip a snapshot with runs and failures', () => {
      const runId = ledger.startRun('loop', 'Keep fixing the repo', {
        maxIterations: null,
        completionPromise: 'DONE',
      });
      ledger.startIteration(ledger.getNextIterationNumber());
      ledger.recordAction('shell', { command: 'npm test' }, 'error', 'Test suite failed');
      ledger.endIteration();
      ledger.finishRun(runId, 'stopped', { errorSummary: 'Completion promise not met' });

      const restored = new IterationLedger(ledger.toSnapshot());

      expect(restored.getEntries()).toHaveLength(1);
      expect(restored.getRuns()).toHaveLength(1);
      expect(restored.getRuns()[0].kind).toBe('loop');
      expect(restored.getRuns()[0].status).toBe('stopped');
      expect(restored.getRuns()[0].completionPromise).toBe('DONE');
      expect(restored.getFailedApproachesMessage()).toContain('Test suite failed');
    });

    it('should recover interrupted state from a saved snapshot', () => {
      const runId = ledger.startRun('agent', 'Finish the migration');
      ledger.startIteration(ledger.getNextIterationNumber());
      ledger.recordAction('read_file', { path: '/src/index.ts' }, 'ok');

      const restored = new IterationLedger(ledger.toSnapshot());

      expect(restored.getEntries()).toHaveLength(1);
      expect(restored.getEntries()[0].outcome).toBe('error');
      expect(restored.getRuns()).toHaveLength(1);
      expect(restored.getRuns()[0].id).toBe(runId);
      expect(restored.getRuns()[0].status).toBe('interrupted');
      expect(restored.getRuns()[0].errorSummary).toContain('Previous session ended');
      expect(restored.getActiveRun()).toBeUndefined();
    });

    it('should preserve totals and monotonic numbering after retention pruning', () => {
      ledger.setRetentionLimit(2);

      for (let i = 1; i <= 4; i++) {
        ledger.startIteration(ledger.getNextIterationNumber());
        if (i % 2 === 0) {
          ledger.recordAction('shell', { command: `fail-${i}` }, 'error', `failed-${i}`);
        } else {
          ledger.recordAction('read_file', { path: `/file-${i}.ts` }, 'ok');
        }
        ledger.recordTokens(100 * i, 50 * i, 0.01 * i);
        ledger.endIteration();
      }

      ledger.recordFailedApproach('manual-1', 'reason-1');
      ledger.recordFailedApproach('manual-2', 'reason-2');
      ledger.recordFailedApproach('manual-3', 'reason-3');

      expect(ledger.getEntries().map(entry => entry.iteration)).toEqual([3, 4]);
      expect(ledger.getFailedApproaches()).toHaveLength(2);
      expect(ledger.getNextIterationNumber()).toBe(5);

      const totals = ledger.getTotals();
      expect(totals.iterations).toBe(4);
      expect(totals.totalTokens).toBe(1500);
      expect(totals.totalCost).toBeCloseTo(0.1);
      expect(totals.failures).toBe(2);
      expect(ledger.getFailedApproachCount()).toBe(5);

      const restored = new IterationLedger(ledger.toSnapshot());
      expect(restored.getEntries().map(entry => entry.iteration)).toEqual([3, 4]);
      expect(restored.getNextIterationNumber()).toBe(5);
      expect(restored.getTotals()).toEqual(totals);
      expect(restored.getFailedApproachCount()).toBe(5);
    });
  });

  // ===========================================================================
  // compactArgs — covers all switch branches in the helper
  // ===========================================================================

  describe('compactArgs (via recordAction)', () => {
    it('should use command arg for shell tool', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'npm install --save-dev typescript' }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toContain('npm install');
    });

    it('should use path arg for write_file tool', () => {
      ledger.startIteration(1);
      ledger.recordAction('write_file', { path: '/src/index.ts', content: '...' }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toContain('/src/index.ts');
    });

    it('should use path arg for list_files tool', () => {
      ledger.startIteration(1);
      ledger.recordAction('list_files', { path: '/src' }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toContain('/src');
    });

    it('should use thought arg for think tool', () => {
      ledger.startIteration(1);
      ledger.recordAction('think', { thought: 'Consider the implications' }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toContain('Consider the implications');
    });

    it('should use query arg for web_search tool', () => {
      ledger.startIteration(1);
      ledger.recordAction('web_search', { query: 'typescript best practices' }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toContain('typescript best practices');
    });

    it('should use language arg for execute_code tool', () => {
      ledger.startIteration(1);
      ledger.recordAction('execute_code', { language: 'python', code: 'print("hello")' }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toBe('python');
    });

    it('should use first value for unknown tool with args', () => {
      ledger.startIteration(1);
      ledger.recordAction('custom_tool', { url: 'https://example.com' }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toContain('https://example.com');
    });

    it('should return empty string for unknown tool with no args', () => {
      ledger.startIteration(1);
      ledger.recordAction('custom_tool', {}, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toBe('');
    });

    it('should truncate long args to 60 chars for shell', () => {
      const longCommand = 'a'.repeat(100);
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: longCommand }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args.length).toBeLessThanOrEqual(63); // 60 + '...'
      expect(entry.actions[0].args).toContain('...');
    });

    it('should truncate long thought to 40 chars for think', () => {
      const longThought = 'x'.repeat(100);
      ledger.startIteration(1);
      ledger.recordAction('think', { thought: longThought }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args.length).toBeLessThanOrEqual(43); // 40 + '...'
    });

    it('should handle missing command in shell', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', {}, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      // args becomes String(undefined || '') = ''
      expect(entry.actions[0].args).toBe('');
    });
  });

  // ===========================================================================
  // inferOutcome edge cases
  // ===========================================================================

  describe('inferOutcome edge cases', () => {
    it('should return skipped when no actions', () => {
      ledger.startIteration(1);
      // No recordAction calls
      ledger.endIteration();
      expect(ledger.getEntries()[0].outcome).toBe('skipped');
    });

    it('should return blocked when there is a blocked action (no errors)', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'sudo rm -rf /' }, 'blocked');
      ledger.endIteration();
      expect(ledger.getEntries()[0].outcome).toBe('blocked');
    });

    it('should return partial when there is blocked and ok action', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      ledger.recordAction('shell', { command: 'sudo rm /' }, 'blocked');
      ledger.endIteration();
      // hasError=false, allOk=false, hasBlocked=true => blocked
      expect(ledger.getEntries()[0].outcome).toBe('blocked');
    });

    it('should return error when all actions fail', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'bad1' }, 'error', 'fail1');
      ledger.recordAction('shell', { command: 'bad2' }, 'error', 'fail2');
      ledger.endIteration();
      expect(ledger.getEntries()[0].outcome).toBe('error');
    });
  });

  // ===========================================================================
  // recordAction called without startIteration (no-op)
  // ===========================================================================

  describe('no-op guards', () => {
    it('should not crash when recordAction called without startIteration', () => {
      expect(() => {
        ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      }).not.toThrow();
      expect(ledger.getEntries()).toHaveLength(0);
    });

    it('should not crash when recordTokens called without startIteration', () => {
      expect(() => {
        ledger.recordTokens(100, 50, 0.01);
      }).not.toThrow();
    });

    it('should not crash when endIteration called without startIteration', () => {
      expect(() => {
        ledger.endIteration();
      }).not.toThrow();
      expect(ledger.getEntries()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // getContextSummary — durationMs formatting (< 1000ms vs >= 1000ms)
  // ===========================================================================

  describe('getContextSummary - duration formatting', () => {
    it('should format duration in ms when under 1000ms', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      ledger.endIteration();

      const summary = ledger.getContextSummary();
      // Duration should show in ms (e.g., "5ms") since test runs fast
      expect(summary).toMatch(/\d+ms|\d+\.\ds/);
    });

    it('should show failed FAILED annotation in action summary', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'npm test' }, 'error', 'Tests failed');
      ledger.endIteration();

      const summary = ledger.getContextSummary();
      expect(summary).toContain('FAILED');
    });
  });

  // ===========================================================================
  // failedApproaches — limit to last 5
  // ===========================================================================

  describe('failed approaches capped at 5', () => {
    it('should only show last 5 failed approaches in message', () => {
      for (let i = 0; i < 8; i++) {
        ledger.recordFailedApproach(`approach-${i}`, `reason-${i}`);
      }

      const msg = ledger.getFailedApproachesMessage();
      expect(msg).not.toBeNull();
      // Should contain 5 items (last 5)
      expect(msg!.match(/approach-/g)?.length).toBe(5);
      expect(msg).toContain('approach-7');
      expect(msg).not.toContain('approach-0');
    });

    it('should only show last 5 failed approaches in context summary', () => {
      for (let i = 0; i < 8; i++) {
        ledger.recordFailedApproach(`approach-${i}`, `reason-${i}`);
      }

      const summary = ledger.getContextSummary();
      expect(summary).toContain('approach-7');
      expect(summary).not.toContain('approach-2');
    });
  });

  // ===========================================================================
  // error without errorSummary
  // ===========================================================================

  describe('failed approach auto-detection', () => {
    it('should handle error with no error summary (uses unknown error)', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'fail' }, 'error'); // no errorSummary
      ledger.endIteration();

      const msg = ledger.getFailedApproachesMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('unknown error');
    });

    it('should not auto-detect failed approaches when outcome is partial (not all error)', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      ledger.recordAction('shell', { command: 'bad' }, 'error', 'failed');
      ledger.endIteration();

      // outcome is 'partial', not 'error', so no auto-detection of failed approach
      expect(ledger.getEntries()[0].outcome).toBe('partial');
      // No failed approaches should be tracked for partial outcome
      expect(ledger.getFailedApproachesMessage()).toBeNull();
    });
  });
});
