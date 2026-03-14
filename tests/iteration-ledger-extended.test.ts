/**
 * Extended coverage tests for src/iteration-ledger.ts
 *
 * Targets uncovered branches:
 * - getContextSummary: durationMs >= 1000ms → shows seconds format ("X.Xs")
 * - inferOutcome: last `return 'partial'` (unreachable with current types - skipped)
 * - endIteration: || fallbacks (currentEntry.actions, tokens, cost)
 * - errorSummary optional chaining branches
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IterationLedger } from '../src/iteration-ledger.js';

describe('IterationLedger - extended coverage', () => {
  let ledger: IterationLedger;

  beforeEach(() => {
    ledger = new IterationLedger();
  });

  // =========================================================================
  // getContextSummary - duration >= 1000ms shows seconds
  // =========================================================================

  describe('getContextSummary - seconds format for long iterations', () => {
    it('should show duration in seconds when durationMs >= 1000', () => {
      // Manually construct an entry with a large durationMs by manipulating the ledger
      // We start an iteration, then artificially move the iterationStart back in time
      // by patching the private field.
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'sleep 1' }, 'ok');
      ledger.recordTokens(500, 200, 0.005);

      // Patch iterationStart to be 2 seconds ago so durationMs >= 1000
      (ledger as any).iterationStart = Date.now() - 2500;

      ledger.endIteration();

      const summary = ledger.getContextSummary();
      // Should show "2.5s" format rather than "Xms"
      expect(summary).toMatch(/\d+\.\ds/);
    });

    it('should show duration in ms when durationMs < 1000', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/a.ts' }, 'ok');
      // iterationStart is now (very recent), durationMs will be tiny
      ledger.endIteration();

      const summary = ledger.getContextSummary();
      // durationMs < 1000 → shows ms format
      expect(summary).toMatch(/\d+ms/);
    });
  });

  // =========================================================================
  // errorSummary optional chaining: multiline error (split by \n)
  // =========================================================================

  describe('recordAction - errorSummary truncation', () => {
    it('should only keep first line of multi-line errorSummary', () => {
      ledger.startIteration(1);
      ledger.recordAction(
        'shell',
        { command: 'failing-cmd' },
        'error',
        'Error: File not found\n  at someFunc (index.js:10)\n  at main (index.js:20)'
      );
      ledger.endIteration();

      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].errorSummary).toBe('Error: File not found');
    });

    it('should truncate errorSummary to 120 chars', () => {
      const longError = 'E'.repeat(200);
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'cmd' }, 'error', longError);
      ledger.endIteration();

      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].errorSummary!.length).toBe(120);
    });

    it('should handle errorSummary that is exactly at boundary', () => {
      const exactError = 'X'.repeat(120);
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'cmd' }, 'error', exactError);
      ledger.endIteration();

      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].errorSummary).toBe(exactError);
    });

    it('should store undefined errorSummary when not provided', () => {
      ledger.startIteration(1);
      ledger.recordAction('shell', { command: 'cmd' }, 'error'); // no errorSummary
      ledger.endIteration();

      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].errorSummary).toBeUndefined();
    });
  });

  // =========================================================================
  // getContextSummary - when entries is empty (parts stays empty)
  // =========================================================================

  describe('getContextSummary - empty state', () => {
    it('should return empty string when no entries and no failed approaches', () => {
      const summary = ledger.getContextSummary();
      expect(summary).toBe('');
    });

    it('should show failed approaches even when no iteration entries', () => {
      ledger.recordFailedApproach('something', 'because reason', ['tool1']);
      const summary = ledger.getContextSummary();
      expect(summary).toContain('Failed Approaches');
      expect(summary).toContain('something');
    });
  });

  // =========================================================================
  // getTotals - entries with zero cost and zero tokens
  // =========================================================================

  describe('getTotals - zero-value entries', () => {
    it('should aggregate correctly when cost and tokens are zero', () => {
      ledger.startIteration(1);
      ledger.recordAction('think', { thought: 'thinking' }, 'ok');
      // No recordTokens call — tokens stay at {input:0, output:0}, cost stays 0
      ledger.endIteration();

      const totals = ledger.getTotals();
      expect(totals.totalTokens).toBe(0);
      expect(totals.totalCost).toBe(0);
      expect(totals.failures).toBe(0);
      expect(totals.iterations).toBe(1);
    });
  });

  // =========================================================================
  // read_file in compactArgs
  // =========================================================================

  describe('compactArgs - read_file path', () => {
    it('should use path arg for read_file tool', () => {
      ledger.startIteration(1);
      ledger.recordAction('read_file', { path: '/very/long/path/to/some/file.ts' }, 'ok');
      ledger.endIteration();
      const entry = ledger.getEntries()[0];
      expect(entry.actions[0].args).toContain('/very/long/path');
    });
  });

  // =========================================================================
  // hasFailedBefore - empty failedApproaches returns undefined
  // =========================================================================

  describe('hasFailedBefore - no matches', () => {
    it('should return undefined when failedApproaches is empty', () => {
      const result = ledger.hasFailedBefore('shell', { command: 'anything' });
      expect(result).toBeUndefined();
    });
  });
});
