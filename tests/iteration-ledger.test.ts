import { describe, it, expect, beforeEach } from 'vitest';
import { IterationLedger } from '../src/iteration-ledger.js';

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
});
