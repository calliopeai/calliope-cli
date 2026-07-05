#!/usr/bin/env bun
/**
 * Compile Calliope into a standalone, zero-dependency executable (issue #187).
 *
 * MUST be run with Bun (it uses the `Bun.build` JS API):
 *
 *   bun packaging/build-binary.mjs [--native | --all | --target <t> ...]
 *
 * Prerequisite: `npm run build` (produces dist/bin.js, the bundle entrypoint).
 *
 * ── How the two known bundling hazards are handled ──────────────────────────
 *
 * 1. react-devtools-core. Ink's reconciler dynamically imports ./devtools.js
 *    under `DEV=true`; that file statically imports the OPTIONAL, uninstalled
 *    `react-devtools-core`. Under Node the failed import is caught and ignored,
 *    but a compiled binary cannot resolve a bare/`--external` specifier from its
 *    virtual filesystem ($bunfs) and dies with
 *    `Cannot find package 'react-devtools-core'` (observed even on `--version`).
 *    FIX: an onResolve plugin aliases the specifier to a local no-op stub
 *    (packaging/stubs/react-devtools-core.js), so the graph is self-contained.
 *    We do NOT use `--external` for it.
 *
 * 2. Version string. src/version-check.ts reads package.json via
 *    `new URL('../package.json', import.meta.url)`. That file is not on disk next
 *    to the executable, so inside the binary the read fails and the version
 *    falls back to 0.0.0. FIX: bake the real version in at bundle time with a
 *    Bun `define` on `globalThis.__CALLIOPE_BINARY_VERSION__`, which
 *    getCurrentVersion() consults first (undefined — and thus a no-op — for the
 *    normal `node dist/bin.js` build).
 *
 * ── Cross-compilation ───────────────────────────────────────────────────────
 * Bun 1.3's `Bun.build({ compile: { target, outfile }, plugins, define })`
 * cross-compiles to any of the four supported targets in-process (it downloads
 * and caches the target runtime on first use), so the stub plugin and version
 * define apply uniformly to every target from a single Node/Bun invocation — no
 * shelling out to the CLI, no per-target prebundle. Verified on bun 1.3.11.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  rmSync,
  symlinkSync,
} from 'node:fs';

if (typeof Bun === 'undefined') {
  console.error('build-binary.mjs must be run with Bun:  bun packaging/build-binary.mjs');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const entrypoint = join(repoRoot, 'dist', 'bin.js');
const stub = join(__dirname, 'stubs', 'react-devtools-core.js');
const outDir = join(__dirname, 'dist');

if (!existsSync(entrypoint)) {
  console.error(`Entrypoint not found: ${entrypoint}\nRun \`npm run build\` first.`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const version = pkg.version;

/** All supported Bun compile targets, in the release matrix order. */
const ALL_TARGETS = ['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-linux-arm64'];

/** The Bun target for the host running this script. */
function nativeTarget() {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `bun-${os}-${arch}`;
}

/** `bun-darwin-arm64` -> `darwin-arm64` (the output-file suffix). */
const shortName = (target) => target.replace(/^bun-/, '');

/** Accept both `bun-darwin-arm64` and the short `darwin-arm64`. */
function normalizeTarget(t) {
  const full = t.startsWith('bun-') ? t : `bun-${t}`;
  if (!ALL_TARGETS.includes(full)) {
    console.error(`Unknown target: ${t}\nValid targets: ${ALL_TARGETS.join(', ')} (or their short forms)`);
    process.exit(1);
  }
  return full;
}

// ── Parse args ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let targets = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--all') targets = [...ALL_TARGETS];
  else if (a === '--native') targets.push(nativeTarget());
  else if (a === '--target') targets.push(normalizeTarget(argv[++i]));
  else if (a.startsWith('--target=')) targets.push(normalizeTarget(a.slice('--target='.length)));
  else {
    console.error(`Unknown argument: ${a}\nUsage: bun packaging/build-binary.mjs [--native | --all | --target <t> ...]`);
    process.exit(1);
  }
}
// Default: build the host target only.
if (targets.length === 0) targets = [nativeTarget()];
targets = [...new Set(targets)];

// ── The stub-aliasing plugin (see hazard #1 above). ─────────────────────────
const stubReactDevtools = {
  name: 'stub-react-devtools-core',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: stub }));
  },
};

mkdirSync(outDir, { recursive: true });

const fmtMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

console.log(`Building calliope v${version} single binaries → ${outDir}`);
console.log(`Targets: ${targets.map(shortName).join(', ')}\n`);

const built = [];
for (const target of targets) {
  const outfile = join(outDir, `calliope-${shortName(target)}`);
  const t0 = performance.now();
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'bun',
    minify: true,
    plugins: [stubReactDevtools],
    define: {
      'globalThis.__CALLIOPE_BINARY_VERSION__': JSON.stringify(version),
    },
    compile: { target, outfile },
  });
  if (!result.success) {
    console.error(`Build failed for ${target}:`);
    for (const log of result.logs) console.error(`  ${log.message ?? log}`);
    process.exit(1);
  }
  const bytes = statSync(outfile).size;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`  ✓ ${shortName(target).padEnd(13)} ${fmtMb(bytes).padStart(9)}  ${secs}s  ${outfile}`);
  built.push({ target, outfile });
}

// Refresh a stable `calliope-native` symlink → the host binary, so tooling
// (e.g. `bench:binary`) can reference one path regardless of platform/arch.
const native = built.find((b) => b.target === nativeTarget());
if (native) {
  const link = join(outDir, 'calliope-native');
  if (existsSync(link)) rmSync(link);
  symlinkSync(basename(native.outfile), link);
  console.log(`\n  calliope-native → ${basename(native.outfile)}`);
}

console.log(`\nDone. ${built.length} binar${built.length === 1 ? 'y' : 'ies'} in ${outDir}.`);
