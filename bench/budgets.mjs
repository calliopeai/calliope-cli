/**
 * Central performance budgets + the CI noise multiplier.
 *
 * Shared by the cold-start script, the vitest benches, and the orchestrator so
 * there is exactly one source of truth for every gate.
 *
 * CI multiplier (CALLIOPE_BENCH_CI=1): GitHub-hosted runners are slower and
 * noisier than a developer laptop, so TIME budgets are doubled in CI. This makes
 * the gate catch genuine regressions (a 2x+ slowdown) rather than tripping on
 * runner jitter. MEMORY budgets are NOT scaled: allocation is deterministic and
 * machine-independent, so a heap regression shows up identically everywhere.
 */

export const CI = process.env.CALLIOPE_BENCH_CI === '1';
export const CI_TIME_MULTIPLIER = 2;

/**
 * Base budgets (developer-laptop scale). See docs/performance.md for the
 * baseline measurements each was derived from.
 */
export const BASE_BUDGETS = {
  // Bench 1 — cold start. Gated on the network-free `--help` and `--config`
  // paths plus `--version` first-byte (the version string prints before the
  // npm update-check). This is the interim node-runtime budget (`node
  // dist/bin.js`), the default for `npm run bench`.
  coldStartMedianMs: 200,

  // Bench 1, binary mode — the compiled single binary (#187). Selected by
  // cold-start.mjs when CALLIOPE_BENCH_BINARY=<path> is set (see `bench:binary`).
  // The binary embeds the runtime, so startup is faster than `node dist/bin.js`;
  // the budget tightens to 150ms accordingly.
  coldStartBinaryMedianMs: 150,

  // Bench 2 — keystroke-to-paint. p95 of stdin.write -> frame-containing-char,
  // measured unthrottled (ink-testing-library debug mode). One 60fps frame.
  keystrokeP95Ms: 16,

  // Bench 3 — memory flatness. Post-GC heapUsed regression slope over the final
  // 300 messages, and absolute post-GC growth across the whole session.
  //
  // Baseline: slope ~22-24 KB/msg (very stable — deterministic content). It is
  // dominated by INTENDED scrollback retention: Ink keeps `fullStaticOutput`
  // (the rendered ANSI of every emitted <Static> item, for resize/clear redraw)
  // plus the message bodies held in transcript state. The slope is content-
  // driven, so it is machine-independent (hence not CI-scaled). Budget = 23.6 x
  // 1.5 rounded up to a clean 40 KB/msg: ~1.7x headroom over the observed max to
  // absorb GC nondeterminism, while still tripping on a real leak that grows the
  // heap faster than the scrollback it renders. Absolute cap catches gross leaks.
  memorySlopeKbPerMsg: 40,
  memoryAbsoluteGrowthMb: 40,
};

const TIME_KEYS = new Set(['coldStartMedianMs', 'coldStartBinaryMedianMs', 'keystrokeP95Ms']);

/** Effective budget for a key, applying the CI time multiplier where relevant. */
export function budget(key) {
  const base = BASE_BUDGETS[key];
  if (base === undefined) throw new Error(`unknown budget: ${key}`);
  if (CI && TIME_KEYS.has(key)) return base * CI_TIME_MULTIPLIER;
  return base;
}

/** True when the given budget key is scaled by the CI multiplier. */
export function isTimeBudget(key) {
  return TIME_KEYS.has(key);
}
