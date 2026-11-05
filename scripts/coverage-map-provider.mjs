/**
 * Vitest coverage provider for scripts/coverage-map.mjs: the stock V8 collection, with each test
 * file's coverage kept apart instead of merged (docs/test-selection.md).
 *
 * Vitest takes V8 coverage once per test file and hands the provider that chunk with the file's
 * name; the stock provider merges every chunk into one report. COVERAGE_MAP_CAPTURE names the
 * JSON this one writes instead: the src/ lines each test file executed.
 */
import v8 from '@vitest/coverage-v8';

export default {
  // Worker side, delegated to the stock module and bound to it: its inspector session then
  // survives this wrapper being imported again for each isolated test file.
  startCoverage: (options) => v8.startCoverage(options),
  takeCoverage: (options) => v8.takeCoverage(options),
  stopCoverage: (options) => v8.stopCoverage(options),
  async getProvider() {
    const { captureProvider } = await import('./coverage-map.mjs');
    return captureProvider(await v8.getProvider(), process.env.COVERAGE_MAP_CAPTURE);
  },
};
