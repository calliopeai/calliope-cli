/**
 * Calliope CLI - Budget Caps (#189)
 *
 * Spend guardrails for agent-in-CI and enterprise use. Three optional caps:
 *   - budget.maxCostPerRun   (USD, per agent run)
 *   - budget.maxTokensPerRun (input+output tokens, per agent run)
 *   - budget.maxCostPerProject (USD, accumulated across runs in a project dir)
 *
 * Per-run caps are checked against totals the caller accumulates during a single
 * run. The per-project cap is checked against a small ledger file under
 * `~/.calliope-cli/projects/<hash>/budget.json`, keyed by a hash of the resolved
 * project path so it never lands inside the user's repo.
 *
 * When a cap is exceeded the agent loop finishes the current tool result, emits a
 * `budget_event` to the run log, and halts cleanly (headless exit code 3).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import * as config from './config.js';

export interface BudgetCaps {
  maxCostPerRun?: number;
  maxTokensPerRun?: number;
  maxCostPerProject?: number;
}

export interface BudgetUsage {
  /** USD spent so far in the current run. */
  runCostUsd: number;
  /** input+output tokens so far in the current run. */
  runTokens: number;
  /** USD spent across all runs in this project (including the current run). */
  projectCostUsd: number;
}

export interface BudgetVerdict {
  exceeded: boolean;
  scope?: 'run' | 'project';
  kind?: 'cost' | 'tokens';
  spent?: number;
  cap?: number;
  message?: string;
}

export interface ProjectSpend {
  spentUsd: number;
  updatedAt: string;
}

// ============================================================================
// Config
// ============================================================================

/** Read the configured budget caps (empty object when none set). */
export function getBudgetCaps(): BudgetCaps {
  try {
    return (config.get('budget') as BudgetCaps | undefined) ?? {};
  } catch {
    return {};
  }
}

/** True if any cap is set (used to skip work / show state entirely). */
export function hasBudgetCaps(caps: BudgetCaps): boolean {
  return (
    typeof caps.maxCostPerRun === 'number' ||
    typeof caps.maxTokensPerRun === 'number' ||
    typeof caps.maxCostPerProject === 'number'
  );
}

// ============================================================================
// Per-project spend ledger
// ============================================================================

const PROJECTS_DIR = path.join(os.homedir(), '.calliope-cli', 'projects');

/** Stable per-project key: first 16 hex of sha256 of the resolved path. */
export function projectKey(projectDir: string): string {
  let resolved = projectDir;
  try {
    resolved = fs.realpathSync(projectDir);
  } catch {
    resolved = path.resolve(projectDir);
  }
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

export function projectBudgetPath(projectDir: string): string {
  return path.join(PROJECTS_DIR, projectKey(projectDir), 'budget.json');
}

export function loadProjectSpend(projectDir: string): ProjectSpend {
  const file = projectBudgetPath(projectDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ProjectSpend>;
    const spentUsd = typeof parsed.spentUsd === 'number' && parsed.spentUsd >= 0 ? parsed.spentUsd : 0;
    return { spentUsd, updatedAt: parsed.updatedAt ?? new Date(0).toISOString() };
  } catch {
    return { spentUsd: 0, updatedAt: new Date(0).toISOString() };
  }
}

/**
 * Add `costUsd` to the project's accumulated spend and persist it atomically.
 * Returns the new total. A zero/negative delta is a no-op read.
 */
export function recordProjectSpend(projectDir: string, costUsd: number): number {
  const current = loadProjectSpend(projectDir);
  if (!(costUsd > 0)) return current.spentUsd;

  const next: ProjectSpend = {
    spentUsd: current.spentUsd + costUsd,
    updatedAt: new Date().toISOString(),
  };
  const file = projectBudgetPath(projectDir);
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Persistence is best-effort; enforcement still uses the in-memory total.
  }
  return next.spentUsd;
}

/** Reset a project's accumulated spend (used by tooling/tests). */
export function resetProjectSpend(projectDir: string): void {
  const file = projectBudgetPath(projectDir);
  try {
    fs.unlinkSync(file);
  } catch {
    /* nothing to reset */
  }
}

// ============================================================================
// Evaluation
// ============================================================================

/**
 * Evaluate caps against current usage. Returns the first cap exceeded (run cost,
 * then run tokens, then project cost). `exceeded: false` when within budget.
 */
export function evaluateBudget(caps: BudgetCaps, usage: BudgetUsage): BudgetVerdict {
  if (typeof caps.maxCostPerRun === 'number' && usage.runCostUsd >= caps.maxCostPerRun) {
    return {
      exceeded: true,
      scope: 'run',
      kind: 'cost',
      spent: usage.runCostUsd,
      cap: caps.maxCostPerRun,
      message: `Run cost cap reached: $${usage.runCostUsd.toFixed(4)} >= $${caps.maxCostPerRun.toFixed(2)} cap`,
    };
  }
  if (typeof caps.maxTokensPerRun === 'number' && usage.runTokens >= caps.maxTokensPerRun) {
    return {
      exceeded: true,
      scope: 'run',
      kind: 'tokens',
      spent: usage.runTokens,
      cap: caps.maxTokensPerRun,
      message: `Run token cap reached: ${usage.runTokens} >= ${caps.maxTokensPerRun} cap`,
    };
  }
  if (typeof caps.maxCostPerProject === 'number' && usage.projectCostUsd >= caps.maxCostPerProject) {
    return {
      exceeded: true,
      scope: 'project',
      kind: 'cost',
      spent: usage.projectCostUsd,
      cap: caps.maxCostPerProject,
      message: `Project cost cap reached: $${usage.projectCostUsd.toFixed(4)} >= $${caps.maxCostPerProject.toFixed(2)} cap`,
    };
  }
  return { exceeded: false };
}

/** One-line halt summary for the user/CI log. */
export function formatBudgetHalt(verdict: BudgetVerdict): string {
  if (!verdict.exceeded) return '';
  const unit = verdict.kind === 'tokens' ? '' : '$';
  const spent = verdict.kind === 'tokens'
    ? String(verdict.spent ?? 0)
    : (verdict.spent ?? 0).toFixed(4);
  const cap = verdict.kind === 'tokens'
    ? String(verdict.cap ?? 0)
    : (verdict.cap ?? 0).toFixed(2);
  return `Budget cap reached (${verdict.scope} ${verdict.kind}): spent ${unit}${spent} of ${unit}${cap}. Halting.`;
}
