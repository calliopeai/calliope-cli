/**
 * Bench 1 — Cold start.
 *
 * Spawns the built CLI N times per command and measures two things:
 *   - spawn -> first stdout byte   (time to first output; the honest
 *     "module-load + ready" proxy)
 *   - spawn -> process exit         (full process cost)
 * Reports min / median / p95 for each.
 *
 * WHAT IS GATED, AND WHY THESE COMMANDS:
 *   - `--help`   prints and exits with zero I/O beyond stdout. Fully
 *                deterministic and network-free — the primary gated metric.
 *   - `--config` reads the on-disk config store then exits. Network-free.
 *   - `--version` prints the version string BEFORE the npm update-check, so its
 *                *first byte* is a clean module-load proxy and is gated; its
 *                *exit* includes a one-time network update-check (cached for 24h
 *                afterwards) so exit is REPORTED but NOT gated.
 *   - `--headless "noop"` cannot run without API keys: with no keys it falls
 *                into interactive setup and exits non-zero after ~0.5s. It is
 *                therefore NOT a valid keyless cold-start metric. We probe it
 *                once, print the finding, and do not gate on it. See
 *                docs/performance.md.
 *
 * The gated node-runtime budget is interim. #187 (compiled single binary)
 * replaces the gated artifact with the compiled binary and tightens the budget
 * to 150ms.
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { summarize, fmtMs } from './lib/stats.mjs';
import { budget as budgetFor, CI } from './budgets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const BIN = join(repoRoot, 'dist', 'bin.js');
const RESULTS = join(__dirname, '.results');

if (!existsSync(BIN)) {
  console.error(`dist/bin.js not found at ${BIN}\nRun \`npm run build\` first (or use \`npm run bench:cold\` / \`npm run bench\`, which build for you).`);
  process.exit(1);
}

const N = 10;

/** Spawn the CLI once and time first-byte + exit. */
function runOnce(args, { env = {}, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let firstByte = null;
    let exitAt = null;
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onFirstOut = () => {
      if (firstByte === null) firstByte = performance.now() - t0;
    };
    child.stdout.on('data', onFirstOut);
    child.stderr.on('data', () => {});
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('exit', (code) => {
      exitAt = performance.now() - t0;
      child._exitCode = code;
    });
    child.on('close', () => {
      clearTimeout(killer);
      resolve({
        firstByte,
        exit: exitAt ?? performance.now() - t0,
        code: child._exitCode,
        timedOut: exitAt === null,
      });
    });
  });
}

/** Run a command N times and summarize first-byte and exit distributions. */
async function measure(label, args, opts) {
  const firstBytes = [];
  const exits = [];
  let lastCode = null;
  for (let i = 0; i < N; i++) {
    const r = await runOnce(args, opts);
    if (r.firstByte !== null) firstBytes.push(r.firstByte);
    exits.push(r.exit);
    lastCode = r.code;
  }
  return {
    label,
    args: args.join(' '),
    code: lastCode,
    firstByte: firstBytes.length ? summarize(firstBytes) : null,
    exit: summarize(exits),
  };
}

async function main() {
  console.log(`\n=== Bench 1: Cold start (node ${process.version}, N=${N}${CI ? ', CI mode' : ''}) ===\n`);

  const help = await measure('--help', ['--help']);
  const config = await measure('--config', ['--config']);
  const version = await measure('--version', ['--version']);

  // Informational headless probe (single run, not gated). Empty out any API-key
  // env vars so this reflects the honest keyless path.
  const keylessEnv = {};
  for (const k of Object.keys(process.env)) {
    if (/API_KEY|BASE_URL|ANTHROPIC|OPENAI|GOOGLE|OLLAMA|GROQ|MISTRAL|TOGETHER|OPENROUTER|BEDROCK|AI21|HUGGINGFACE|LITELLM/.test(k)) {
      keylessEnv[k] = '';
    }
  }
  const headless = await runOnce(['--headless', 'noop'], { env: keylessEnv, timeoutMs: 4000 });

  const coldBudget = budgetFor('coldStartMedianMs');

  // Gated metrics: network-free medians.
  const gates = [
    { name: '--help first-byte', value: help.firstByte?.median },
    { name: '--help exit', value: help.exit.median },
    { name: '--config exit', value: config.exit.median },
    { name: '--version first-byte', value: version.firstByte?.median },
  ];

  const rows = [];
  const push = (name, s, gated) => {
    if (!s) return;
    rows.push({ name, min: s.min, median: s.median, p95: s.p95, gated });
  };
  push('--help  first-byte', help.firstByte, true);
  push('--help  exit', help.exit, true);
  push('--config first-byte', config.firstByte, false);
  push('--config exit', config.exit, true);
  push('--version first-byte', version.firstByte, true);
  push('--version exit (network*)', version.exit, false);

  const nameW = Math.max(...rows.map((r) => r.name.length));
  console.log(
    `  ${'metric'.padEnd(nameW)}   ${'min'.padStart(9)} ${'median'.padStart(9)} ${'p95'.padStart(9)}   gate`,
  );
  for (const r of rows) {
    const g = r.gated ? `<= ${fmtMs(coldBudget)}` : 'report only';
    const breach = r.gated && r.median > coldBudget ? '  BREACH' : '';
    console.log(
      `  ${r.name.padEnd(nameW)}   ${fmtMs(r.min).padStart(9)} ${fmtMs(r.median).padStart(9)} ${fmtMs(r.p95).padStart(9)}   ${g}${breach}`,
    );
  }
  console.log(
    `\n  * --version exit includes a one-time npm update-check (cached 24h); reported, not gated.`,
  );
  console.log(
    `  headless keyless probe: exit code ${headless.code}${headless.timedOut ? ' (timed out)' : ''} in ${fmtMs(headless.exit)}, ` +
      `first stdout byte ${headless.firstByte === null ? 'none (setup went to stderr)' : fmtMs(headless.firstByte)}.`,
  );
  console.log(`    -> headless requires keys; not a valid keyless cold-start metric (see docs/performance.md).`);

  const breaches = gates.filter((g) => g.value !== undefined && g.value > coldBudget);
  const pass = breaches.length === 0;

  console.log(
    `\n  RESULT: ${pass ? 'PASS' : 'FAIL'} — gated cold-start medians ${pass ? 'within' : 'exceed'} ${fmtMs(coldBudget)}${CI ? ' (CI x2)' : ''}.`,
  );
  if (!pass) {
    for (const b of breaches) console.log(`    BREACH: ${b.name} median ${fmtMs(b.value)} > ${fmtMs(coldBudget)}`);
  }

  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(
    join(RESULTS, 'cold-start.json'),
    JSON.stringify(
      {
        bench: 'cold-start',
        node: process.version,
        ci: CI,
        budgetMs: coldBudget,
        pass,
        gated: gates.map((g) => ({ name: g.name, medianMs: g.value })),
        detail: { help, config, version, headless },
      },
      null,
      2,
    ),
  );

  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error('cold-start bench failed:', err);
  process.exitCode = 1;
});
