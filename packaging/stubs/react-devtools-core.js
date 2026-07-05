/**
 * Build-time stub for `react-devtools-core` (issue #187).
 *
 * Ink imports `react-devtools-core` from `ink/build/devtools.js`, which is
 * itself only imported dynamically by `ink/build/reconciler.js` when
 * `process.env.DEV === 'true'`. The package is an OPTIONAL dev dependency and is
 * not installed in production, so it never resolves at runtime under Node — the
 * dynamic import's `ERR_MODULE_NOT_FOUND` is caught and ignored.
 *
 * When bundling into a single executable with Bun, that dynamic import pulls
 * `devtools.js` (and its top-level `import devtools from 'react-devtools-core'`)
 * into the module graph. Marking the package `--external` leaves a bare
 * specifier that the compiled binary cannot resolve from its virtual filesystem,
 * producing `Cannot find package 'react-devtools-core' from '/$bunfs/root/...'`.
 *
 * Aliasing the specifier to this no-op stub at bundle time makes the graph
 * self-contained: the devtools hooks become harmless no-ops that are only ever
 * called under `DEV=true` (never in a shipped binary). The default export
 * matches the shape Ink consumes — `devtools.initialize()` and
 * `devtools.connectToDevTools()`.
 */
const noop = () => {};

export default {
  initialize: noop,
  connectToDevTools: noop,
};
