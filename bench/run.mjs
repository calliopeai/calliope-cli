/**
 * Bench orchestrator — `npm run bench`.
 *
 * 1. builds the CLI (cold start measures the built dist/bin.js)
 * 2. runs all three benches (cold start, keystroke, memory)
 * 3. prints one summary table of budget vs. baseline
 * 4. exits non-zero if ANY budget was breached
 *
 * Memory needs --expose-gc, so the vitest child is spawned with
 * NODE_OPTIONS=--expose-gc. CALLIOPE_BENCH_CI is inherited by every child, so a
 * single `CALLIOPE_BENCH_CI=1 npm run bench` applies the CI time multiplier
 * everywhere.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { CI } from './budgets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const RESULTS = join(__dirname, '.results');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function step(name, cmd, args, extraEnv = {}) {
  console.log(`\n── ${name} ──`);
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  return res.status ?? 1;
}

function readResult(file) {
  const p = join(RESULTS, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// Start clean so a stale result can never mask a bench that failed to run.
if (existsSync(RESULTS)) rmSync(RESULTS, { recursive: true, force: true });

// 1. Build.
if (step('build', npm, ['run', 'build']) !== 0) {
  console.error('\nBuild failed — aborting bench.');
  process.exit(1);
}

// 2. Cold start (spawns the built binary).
const coldStatus = step('bench:cold', process.execPath, [join(__dirname, 'cold-start.mjs')]);

// 3. Keystroke + memory (vitest; memory needs --expose-gc).
const vitestStatus = step(
  'bench:ui + bench:mem',
  npx,
  ['vitest', 'run', '-c', join('bench', 'vitest.bench.config.ts')],
  { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc`.trim() },
);

// 4. Summary table.
const cold = readResult('cold-start.json');
const keys = readResult('keystroke.json');
const mem = readResult('memory.json');

const rows = [];
const fmt = (n, unit) => (n === undefined || n === null || Number.isNaN(n) ? 'n/a' : `${n.toFixed(2)}${unit}`);

if (cold) {
  const helpExit = cold.gated.find((g) => g.name === '--help exit')?.medianMs;
  rows.push({
    bench: 'cold start',
    metric: '--help exit median',
    baseline: fmt(helpExit, 'ms'),
    budget: `<= ${cold.budgetMs}ms`,
    pass: cold.pass,
  });
} else {
  rows.push({ bench: 'cold start', metric: '(no result)', baseline: 'n/a', budget: 'n/a', pass: false });
}

if (keys) {
  rows.push({
    bench: 'keystroke',
    metric: 'stdin->paint p95',
    baseline: fmt(keys.p95, 'ms'),
    budget: `<= ${keys.budgetP95Ms}ms`,
    pass: keys.pass,
  });
} else {
  rows.push({ bench: 'keystroke', metric: '(no result)', baseline: 'n/a', budget: 'n/a', pass: false });
}

if (mem) {
  rows.push({
    bench: 'memory',
    metric: 'final-300 slope',
    baseline: fmt(mem.slopeKbPerMsg, 'KB/msg'),
    budget: `<= ${mem.slopeBudgetKbPerMsg}KB/msg`,
    pass: mem.slopeKbPerMsg <= mem.slopeBudgetKbPerMsg,
  });
  rows.push({
    bench: 'memory',
    metric: 'absolute growth',
    baseline: fmt(mem.absoluteGrowthMb, 'MB'),
    budget: `< ${mem.absoluteGrowthBudgetMb}MB`,
    pass: mem.absoluteGrowthMb < mem.absoluteGrowthBudgetMb,
  });
} else {
  rows.push({ bench: 'memory', metric: '(no result)', baseline: 'n/a', budget: 'n/a', pass: false });
}

const col = (s, w) => String(s).padEnd(w);
const w = { bench: 12, metric: 20, baseline: 16, budget: 18 };
console.log(`\n═══ Performance budget summary${CI ? ' (CI mode: time budgets x2)' : ''} ═══\n`);
console.log(`  ${col('bench', w.bench)}${col('metric', w.metric)}${col('baseline', w.baseline)}${col('budget', w.budget)}status`);
for (const r of rows) {
  console.log(
    `  ${col(r.bench, w.bench)}${col(r.metric, w.metric)}${col(r.baseline, w.baseline)}${col(r.budget, w.budget)}${r.pass ? 'PASS' : 'FAIL'}`,
  );
}

const allPass = rows.every((r) => r.pass) && coldStatus === 0 && vitestStatus === 0;
console.log(`\n  Overall: ${allPass ? 'PASS ✓' : 'FAIL ✗'}\n`);

process.exit(allPass ? 0 : 1);
