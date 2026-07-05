import { defineConfig } from 'vitest/config';

/**
 * Standalone vitest config for the performance benches.
 *
 * Kept separate from the repo's vitest.config.ts on purpose: the default config
 * includes only `tests/**` and enforces coverage thresholds, so `npm test` never
 * runs (or is slowed by) the benches. This config includes ONLY the bench files
 * and is used exclusively by the `bench:*` scripts / `npm run bench`.
 *
 * Benches run single-threaded and serially: they measure wall-clock latency and
 * heap growth, which parallel workers would perturb.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['bench/**/*.bench.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    // Benches drive real render loops and long simulated sessions.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
