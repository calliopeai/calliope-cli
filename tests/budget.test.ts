/**
 * Tests for src/budget.ts — spend caps and per-project accumulation.
 *
 * Covers: evaluateBudget for run cost, run tokens, and project cost; the
 * per-project spend ledger (load/record/reset, atomic + resilient); cap
 * presence detection; and the halt summary formatting.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const { tmpHome } = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'calliope-budget-test-'));
  return { tmpHome: dir };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

import {
  evaluateBudget,
  hasBudgetCaps,
  loadProjectSpend,
  recordProjectSpend,
  resetProjectSpend,
  projectBudgetPath,
  formatBudgetHalt,
  type BudgetCaps,
} from '../src/budget.js';

const PROJECT = tmpHome; // a real, resolvable dir so realpath works

beforeEach(() => {
  resetProjectSpend(PROJECT);
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// hasBudgetCaps
// ---------------------------------------------------------------------------

describe('hasBudgetCaps', () => {
  it('is false for an empty caps object', () => {
    expect(hasBudgetCaps({})).toBe(false);
  });
  it('is true if any cap is set', () => {
    expect(hasBudgetCaps({ maxCostPerRun: 1 })).toBe(true);
    expect(hasBudgetCaps({ maxTokensPerRun: 100 })).toBe(true);
    expect(hasBudgetCaps({ maxCostPerProject: 5 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateBudget
// ---------------------------------------------------------------------------

describe('evaluateBudget', () => {
  const usage = { runCostUsd: 0, runTokens: 0, projectCostUsd: 0 };

  it('does not fire when within all caps', () => {
    const caps: BudgetCaps = { maxCostPerRun: 1, maxTokensPerRun: 1000, maxCostPerProject: 10 };
    const v = evaluateBudget(caps, { runCostUsd: 0.5, runTokens: 500, projectCostUsd: 5 });
    expect(v.exceeded).toBe(false);
  });

  it('fires on run cost at or above the cap', () => {
    const v = evaluateBudget({ maxCostPerRun: 1 }, { ...usage, runCostUsd: 1.0 });
    expect(v.exceeded).toBe(true);
    expect(v.scope).toBe('run');
    expect(v.kind).toBe('cost');
    expect(v.cap).toBe(1);
    expect(v.spent).toBe(1);
  });

  it('fires on run tokens at or above the cap', () => {
    const v = evaluateBudget({ maxTokensPerRun: 1000 }, { ...usage, runTokens: 1200 });
    expect(v.exceeded).toBe(true);
    expect(v.scope).toBe('run');
    expect(v.kind).toBe('tokens');
    expect(v.spent).toBe(1200);
  });

  it('fires on project cost at or above the cap', () => {
    const v = evaluateBudget({ maxCostPerProject: 10 }, { ...usage, projectCostUsd: 10.5 });
    expect(v.exceeded).toBe(true);
    expect(v.scope).toBe('project');
    expect(v.kind).toBe('cost');
    expect(v.spent).toBe(10.5);
  });

  it('prefers run cost, then run tokens, then project cost', () => {
    const caps: BudgetCaps = { maxCostPerRun: 1, maxTokensPerRun: 100, maxCostPerProject: 5 };
    const v = evaluateBudget(caps, { runCostUsd: 2, runTokens: 200, projectCostUsd: 6 });
    expect(v.scope).toBe('run');
    expect(v.kind).toBe('cost');
  });

  it('ignores caps left undefined', () => {
    const v = evaluateBudget({ maxCostPerProject: 5 }, { runCostUsd: 999, runTokens: 999999, projectCostUsd: 1 });
    expect(v.exceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-project spend ledger
// ---------------------------------------------------------------------------

describe('project spend ledger', () => {
  it('starts at zero for an unseen project', () => {
    expect(loadProjectSpend(PROJECT).spentUsd).toBe(0);
  });

  it('accumulates spend across records and persists atomically', () => {
    expect(recordProjectSpend(PROJECT, 0.5)).toBeCloseTo(0.5);
    expect(recordProjectSpend(PROJECT, 0.25)).toBeCloseTo(0.75);
    expect(loadProjectSpend(PROJECT).spentUsd).toBeCloseTo(0.75);
    // File is real JSON on disk.
    const parsed = JSON.parse(fs.readFileSync(projectBudgetPath(PROJECT), 'utf-8'));
    expect(parsed.spentUsd).toBeCloseTo(0.75);
  });

  it('ignores non-positive deltas', () => {
    recordProjectSpend(PROJECT, 1);
    expect(recordProjectSpend(PROJECT, 0)).toBeCloseTo(1);
    expect(recordProjectSpend(PROJECT, -5)).toBeCloseTo(1);
  });

  it('reset clears the ledger', () => {
    recordProjectSpend(PROJECT, 2);
    resetProjectSpend(PROJECT);
    expect(loadProjectSpend(PROJECT).spentUsd).toBe(0);
  });

  it('recovers gracefully from a corrupt ledger file', () => {
    fs.mkdirSync(path.dirname(projectBudgetPath(PROJECT)), { recursive: true });
    fs.writeFileSync(projectBudgetPath(PROJECT), 'not json');
    expect(loadProjectSpend(PROJECT).spentUsd).toBe(0);
  });

  it('keys different project dirs separately', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-proj-'));
    recordProjectSpend(PROJECT, 1);
    recordProjectSpend(other, 3);
    expect(loadProjectSpend(PROJECT).spentUsd).toBeCloseTo(1);
    expect(loadProjectSpend(other).spentUsd).toBeCloseTo(3);
    fs.rmSync(other, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// formatBudgetHalt
// ---------------------------------------------------------------------------

describe('formatBudgetHalt', () => {
  it('formats a cost halt with dollar units', () => {
    const s = formatBudgetHalt({ exceeded: true, scope: 'run', kind: 'cost', spent: 1.5, cap: 1 });
    expect(s).toContain('run cost');
    expect(s).toContain('$1.5000');
    expect(s).toContain('$1.00');
  });

  it('formats a token halt without dollar units', () => {
    const s = formatBudgetHalt({ exceeded: true, scope: 'run', kind: 'tokens', spent: 1200, cap: 1000 });
    expect(s).toContain('tokens');
    expect(s).toContain('1200');
    expect(s).not.toContain('$');
  });

  it('returns empty string when not exceeded', () => {
    expect(formatBudgetHalt({ exceeded: false })).toBe('');
  });
});
