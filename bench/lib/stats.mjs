/**
 * Shared statistics helpers for the performance benches.
 *
 * Plain ESM, no dependencies — imported by both the .mjs scripts (cold-start,
 * orchestrator) and the vitest .bench.test.ts files.
 */

/** Nearest-rank quantile (conservative: rounds up to a real sample). */
export function quantile(samples, q) {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  if (q <= 0) return sorted[0];
  if (q >= 1) return sorted[sorted.length - 1];
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function median(samples) {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function mean(samples) {
  if (samples.length === 0) return NaN;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/** min / median / p95 / max / mean over a sample array. */
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    min: sorted[0],
    median: median(sorted),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: mean(sorted),
  };
}

/**
 * Ordinary-least-squares slope of y over x (units: y per one unit of x).
 * Used for the memory heap-vs-message-count regression.
 */
export function linregSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const xBar = mean(xs);
  const yBar = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xBar) * (ys[i] - yBar);
    den += (xs[i] - xBar) ** 2;
  }
  return den === 0 ? NaN : num / den;
}

/** Round a number up to a "clean" budget value (1/2/5 x 10^k ladder). */
export function roundUpClean(value) {
  if (value <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= value) return candidate;
  }
  return 10 * mag;
}

export function fmtMs(n) {
  return `${n.toFixed(1)}ms`;
}

export function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(2)}KB`;
}

export function fmtMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}
