#!/usr/bin/env node
/**
 * Which test files execute which src/ lines, and which test files a change reaches
 * (docs/test-selection.md).
 *
 *   node scripts/coverage-map.mjs build [--out coverage-map.json] [vitest flags]
 *   node scripts/coverage-map.mjs select --base <ref> [--map coverage-map.json]
 *       [--max-age-hours 72] [--json] [--report] [--run] [--jev] [vitest flags]
 *
 * `build` runs the suite once under scripts/coverage-map-provider.mjs and records, per test file,
 * the src/ line ranges it executed. `select` maps a change onto that map, or says why everything
 * has to run. `--report` measures the changed source lines no selected test executes, `--run`
 * runs the selection and exits with vitest's status, and `--jev` lets Typesafe's Jev judge the
 * changes the map cannot see. Vitest's own output goes to stderr; stdout carries the selection.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_VERSION = 1;
export const MAX_AGE_HOURS = 72;
/** A selection over this share of the suite runs everything anyway. */
export const RUN_ALL_SHARE = 0.7;
/** A test file is placed when it executes a line that at most this share of the suite executes. */
export const PLACED_SHARE = 0.5;
export const JEV_MODEL = 'jev-1.14.0';
export const JEV_MIN_CONFIDENCE = 0.8;
export const JEV_TIMEOUT_MS = 15_000;
const JEV_BASE_URL = 'https://api.typesafe.ai';
const PROVIDER = fileURLToPath(new URL('./coverage-map-provider.mjs', import.meta.url));

/** vitest.config.ts `include`, and where vitest writes each file's snapshots. */
const TEST_FILE = /^tests\/(?:[^/]+\/)*[^/]+\.test\.ts$/;
const SNAPSHOT = /^(tests\/(?:[^/]+\/)*)__snapshots__\/([^/]+\.test\.ts)\.snap$/;
/** Changes to how every test runs: never judged, always run everything. */
const TOOLING = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^\.npmrc$/,
  /^vitest\.(?:config|workspace)\.[^/]+$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^tests\/setup\//,
  /^scripts\/coverage-map(?:-provider)?\.mjs$/,
];
const STATUS = { A: 'added', M: 'modified', D: 'deleted' };

// ---- line ranges --------------------------------------------------------------------------

/** Line numbers as "1-4,7,9-12". */
export function toRanges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

/** "1-4,7" as [[1, 4], [7, 7]]. */
export function fromRanges(text) {
  if (!text) return [];
  return text.split(',').map((part) => {
    const [start, end = start] = part.split('-').map(Number);
    return [start, end];
  });
}

function rangesHave(ranges, line) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (line < ranges[mid][0]) hi = mid - 1;
    else if (line > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function rangeLines(text) {
  const lines = [];
  for (const [start, end] of fromRanges(text)) for (let l = start; l <= end; l++) lines.push(l);
  return lines;
}

// ---- V8 coverage to source lines ----------------------------------------------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) DIGIT[BASE64.charCodeAt(i)] = i;

/** A source map's `mappings` as [generated line, generated column, source, original line], 0-based. */
export function decodeMappings(mappings) {
  const out = [];
  let line = 0;
  let column = 0;
  let source = 0;
  let originalLine = 0;
  let fields = [];
  let value = 0;
  let shift = 0;
  const flush = () => {
    if (!fields.length) return;
    column += fields[0];
    if (fields.length >= 4) {
      source += fields[1];
      originalLine += fields[2];
      out.push([line, column, source, originalLine]);
    }
    fields = [];
  };
  for (let i = 0; i < mappings.length; i++) {
    const code = mappings.charCodeAt(i);
    if (code === 59 /* ; */) {
      flush();
      line++;
      column = 0;
    } else if (code === 44 /* , */) {
      flush();
    } else {
      const digit = code < 128 ? DIGIT[code] : -1;
      if (digit < 0) throw new Error(`Invalid source map mapping character ${JSON.stringify(mappings[i])}`);
      value += (digit & 31) * 2 ** shift;
      if (digit & 32) {
        shift += 5;
      } else {
        fields.push(value % 2 ? -(value - 1) / 2 : value / 2);
        value = 0;
        shift = 0;
      }
    }
  }
  flush();
  return out;
}

/**
 * Where the transformed code of `file` maps back to it: generated offsets, sorted, with the
 * 1-based source line each one came from. A source line with no segment emitted no code (a
 * comment, a blank line, an interface or type-only import), so it is not executable.
 */
export function segmentsOf(code, map, file) {
  const sources = map?.sources ?? [];
  const self = sources.length === 1 ? 0 : sources.findIndex((s) => s && basename(s) === basename(file));
  if (!map?.mappings || self < 0) return null;
  const lineStart = [0];
  for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) lineStart.push(i + 1);
  const pairs = [];
  for (const [line, column, source, originalLine] of decodeMappings(map.mappings)) {
    if (source === self && line < lineStart.length) pairs.push([lineStart[line] + column, originalLine + 1]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return {
    offsets: Int32Array.from(pairs, (p) => p[0]),
    lines: Int32Array.from(pairs, (p) => p[1]),
  };
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The source lines whose code ran: a segment counts when the most specific V8 range around it
 * has a non-zero count. Ranges are painted largest first (ties: the one ending first), so the
 * innermost wins, as in ast-v8-to-istanbul. `startOffset` is the module wrapper's length.
 */
export function executedLines(segments, functions, startOffset = 0) {
  const ranges = functions.flatMap((fn) => fn.ranges);
  ranges.sort(
    (a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset) || a.endOffset - b.endOffset,
  );
  const counts = new Float64Array(segments.offsets.length);
  for (const r of ranges) {
    const from = lowerBound(segments.offsets, r.startOffset - startOffset);
    const to = lowerBound(segments.offsets, r.endOffset - startOffset);
    counts.fill(r.count, from, to);
  }
  const lines = new Set();
  counts.forEach((count, i) => {
    if (count > 0) lines.add(segments.lines[i]);
  });
  return lines;
}

function sourcePath(root, url) {
  if (!url.startsWith('file://')) return null;
  const rel = relative(root, fileURLToPath(url.split('?')[0])).split(sep).join('/');
  return rel.startsWith('src/') ? rel : null;
}

/**
 * Wrap the stock V8 provider so each test file's coverage chunk stays apart. `spec` (JSON) is
 * `{ out, files }`: where to write, and the only src/ files to report (null for all).
 */
export function captureProvider(provider, spec) {
  const { out, files = null } = JSON.parse(spec ?? 'null') ?? {};
  if (!out) throw new Error('COVERAGE_MAP_CAPTURE must name the capture output');
  const chunks = [];
  const initialize = provider.initialize.bind(provider);
  provider.initialize = (ctx) => {
    initialize(ctx);
    if (ctx.projects.some((project) => project.config.isolate === false)) {
      throw new Error('The coverage map needs isolated test files (isolate: true)');
    }
    // The capture is the only output: no reports and no coverage floor to enforce.
    const options = provider.resolveOptions();
    options.reporter = [];
    options.thresholds = undefined;
  };
  const onAfterSuiteRun = provider.onAfterSuiteRun.bind(provider);
  provider.onAfterSuiteRun = (meta) => {
    onAfterSuiteRun(meta);
    if (!meta.coverage) return;
    if (meta.testFiles.length !== 1) {
      throw new Error(`A coverage chunk spans ${meta.testFiles.length} test files; expected one`);
    }
    chunks.push(meta);
  };
  provider.generateCoverage = async () => {
    writeFileSync(out, JSON.stringify(await readChunks(provider, chunks, files)));
    return provider.createCoverageMap();
  };
  return provider;
}

async function readChunks(provider, chunks, only) {
  const ctx = provider.ctx;
  const root = ctx.config.root;
  const wanted = only && new Set(only);
  const sources = new Map();
  const segmentsFor = (file, environment = 'ssr', projectName = '') => {
    if (!sources.has(file)) {
      const project = ctx.projects.find((p) => p.name === projectName) ?? ctx.getRootProject();
      sources.set(
        file,
        project.vite.environments[environment]
          .transformRequest(join(root, file))
          .then((result) => (result ? segmentsOf(result.code, result.map, file) : null)),
      );
    }
    return sources.get(file);
  };
  const tests = {};
  for (const chunk of chunks) {
    const raw = JSON.parse(await readFile(chunk.coverage, 'utf8'));
    const executed = new Map();
    for (const script of raw.result) {
      const file = sourcePath(root, script.url);
      if (!file || (wanted && !wanted.has(file))) continue;
      const segments = await segmentsFor(file, chunk.environment, chunk.projectName);
      if (!segments) continue;
      const lines = executed.get(file) ?? new Set();
      for (const line of executedLines(segments, script.functions, script.startOffset ?? 0)) lines.add(line);
      executed.set(file, lines);
    }
    const entry = (tests[chunk.testFiles[0]] ??= {});
    for (const [file, lines] of executed) {
      if (lines.size) entry[file] = toRanges([...rangeLines(entry[file] ?? ''), ...lines]);
    }
  }
  const executable = {};
  for (const file of new Set([...sources.keys(), ...(only ?? [])])) {
    const segments = await segmentsFor(file).catch(() => null);
    if (segments?.lines.length) executable[file] = toRanges(segments.lines);
  }
  const failed = ctx.state
    .getTestModules()
    .filter((module) => module.state() === 'failed')
    .map((module) => relative(root, module.moduleId).split(sep).join('/'));
  // Files the coverage floor (vitest.config.ts include/exclude) leaves out.
  const outsideFloor = (only ?? []).filter((file) => !provider.isIncluded(join(root, file)));
  return { tests, executable, failed: failed.sort(), outsideFloor };
}

/** Test files whose map entry runs nothing that at most half of the suite does not also run. */
export function unplacedTests(tests) {
  const names = Object.keys(tests);
  const limit = names.length * PLACED_SHARE;
  const counts = new Map();
  for (const name of names) {
    for (const [file, text] of Object.entries(tests[name])) {
      const ranges = fromRanges(text);
      const size = ranges.at(-1)[1] + 2;
      const diff = counts.get(file) ?? new Int32Array(size);
      const grown = diff.length >= size ? diff : Int32Array.from({ length: size }, (_, i) => diff[i] ?? 0);
      for (const [start, end] of ranges) {
        grown[start]++;
        grown[end + 1]--;
      }
      counts.set(file, grown);
    }
  }
  const rare = new Map();
  for (const [file, diff] of counts) {
    const prefix = new Int32Array(diff.length + 1);
    let running = 0;
    for (let line = 0; line < diff.length; line++) {
      running += diff[line];
      prefix[line + 1] = prefix[line] + (running > 0 && running <= limit ? 1 : 0);
    }
    rare.set(file, prefix);
  }
  return names
    .filter((name) =>
      !Object.entries(tests[name]).some(([file, text]) => {
        const prefix = rare.get(file);
        return fromRanges(text).some(([start, end]) => prefix[end + 1] - prefix[start] > 0);
      }),
    )
    .sort();
}

// ---- diffs --------------------------------------------------------------------------------

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(text) {
  if (!text.startsWith('"')) return text;
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] !== '\\') {
      bytes.push(...Buffer.from(text[i]));
    } else if (/[0-7]/.test(text[i + 1])) {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      i++;
      bytes.push(escapes[text[i]] ?? text.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(rest) {
  if (rest.startsWith('"')) return unquote(/^"(?:[^"\\]|\\.)*"/.exec(rest)[0]).replace(/^a\//, '');
  // `a/<path> b/<path>`: both sides are the same path without renames.
  return rest.slice(2, 2 + (rest.length - 5) / 2);
}

/**
 * A `git diff --unified=0 --no-renames` patch as files with their status, hunks
 * ([oldStart, oldCount, newStart, newCount]) and added and deleted line counts.
 */
export function parseDiff(patch) {
  const files = [];
  let file = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-') && oldLeft > 0) {
        oldLeft--;
        file.deleted++;
        continue;
      }
      if (line.startsWith('+') && newLeft > 0) {
        newLeft--;
        file.added++;
        continue;
      }
      if (line.startsWith('\\')) continue;
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith('diff --git ')) {
      file = { path: headerPath(line.slice(11)), status: 'M', binary: false, hunks: [], added: 0, deleted: 0 };
      files.push(file);
    } else if (!file || line.startsWith('\\')) {
      continue;
    } else if (line.startsWith('new file mode')) {
      file.status = 'A';
    } else if (line.startsWith('deleted file mode')) {
      file.status = 'D';
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true;
    } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      file.path = unquote(line.slice(4)).replace(/^b\//, '');
    } else if (line.startsWith('--- ') && line !== '--- /dev/null') {
      file.path = unquote(line.slice(4)).replace(/^a\//, '');
    } else {
      const m = HUNK.exec(line);
      if (!m) continue;
      const hunk = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
      file.hunks.push(hunk);
      oldLeft = hunk[1];
      newLeft = hunk[3];
    }
  }
  return files;
}

/** Map a line of a diff's newer side to its older side; null when the diff changed it. */
export function lineTranslator(hunks) {
  return (line) => {
    let delta = 0;
    for (const [oldStart, oldCount, newStart, newCount] of hunks) {
      if (newCount > 0 && line >= newStart && line < newStart + newCount) return null;
      if (line < (newCount > 0 ? newStart : newStart + 1)) break;
      delta += oldCount - newCount;
    }
    return line + delta;
  };
}

const same = (line) => line;

/**
 * The lines, at the map's commit, whose tests a change's hunks reach: the touched old lines
 * that are executable, or, for a pure insertion or a hunk of comments, blank lines and types,
 * the nearest executable line above and below. Null when a line has no counterpart at the
 * map's commit (the file changed there since): the caller falls back to the whole file.
 */
export function anchorLines(hunks, executable, translate = same) {
  const anchors = new Set();
  const nearest = (line, step) => {
    if (step < 0) {
      const i = lowerBound(executable, line + 1) - 1;
      return i >= 0 ? executable[i] : null;
    }
    const i = lowerBound(executable, line);
    return i < executable.length ? executable[i] : null;
  };
  const live = new Set(executable);
  for (const [oldStart, oldCount] of hunks) {
    const touched = [];
    for (let line = oldStart; line < oldStart + oldCount; line++) touched.push(translate(line));
    if (touched.includes(null)) return null;
    const code = touched.filter((line) => live.has(line));
    if (code.length) {
      for (const line of code) anchors.add(line);
      continue;
    }
    const above = translate(oldCount > 0 ? oldStart - 1 : oldStart);
    const below = translate(oldCount > 0 ? oldStart + oldCount : oldStart + 1);
    if (above === null || below === null) return null;
    for (const line of [nearest(above, -1), nearest(below, 1)]) if (line !== null) anchors.add(line);
  }
  return anchors;
}

// ---- selection ----------------------------------------------------------------------------

export function classify(path) {
  if (TEST_FILE.test(path)) return { kind: 'test' };
  const snapshot = SNAPSHOT.exec(path);
  if (snapshot) return { kind: 'snapshot', test: snapshot[1] + snapshot[2] };
  if (path.startsWith('src/')) return { kind: 'source' };
  if (TOOLING.some((pattern) => pattern.test(path))) return { kind: 'tooling' };
  return { kind: 'other' };
}

/** Why the map is unusable, if it is. */
export function mapProblems(map, { now = Date.now(), maxAgeHours = MAX_AGE_HOURS, vitest = null } = {}) {
  if (!map) return ['there is no coverage map'];
  if (map.version !== MAP_VERSION) return [`the coverage map has format ${map.version}, expected ${MAP_VERSION}`];
  const problems = [];
  if (map.dirty) problems.push('the map was built from uncommitted changes');
  const age = (now - Date.parse(map.builtAt)) / 3_600_000;
  if (!(age <= maxAgeHours)) problems.push(`the map is ${Number.isNaN(age) ? 'of unknown age' : `${Math.floor(age)} hours old`} (max ${maxAgeHours})`);
  if (map.vitest !== vitest) problems.push(`the map was built with vitest ${map.vitest}, this checkout has ${vitest ?? 'no vitest'}`);
  return problems;
}

/** Test files whose source names `path` (as a string: reading it, not importing it). */
function namers(path, texts) {
  const names = [path, basename(path)];
  if (/\.tsx?$/.test(path)) names.push(path.replace(/\.tsx?$/, '.js'), basename(path).replace(/\.tsx?$/, '.js'));
  return [...texts].filter(([, text]) => names.some((name) => text.includes(name))).map(([test]) => test);
}

/**
 * The test files a change reaches by the map, and the changes it cannot judge. `changes` is the
 * parsed diff of the working tree against the merge base; `moved` holds line translators for
 * files changed between the map's commit and the merge base; `texts` holds each test file's
 * source, for the tests that read a changed source file as text.
 */
export function selectTests(map, { changes, suite, moved = new Map(), texts = new Map() }) {
  const picks = new Map();
  const unmapped = [];
  const notes = [];
  const pick = (test, why) => {
    if (suite.has(test) && !picks.has(test)) picks.set(test, why);
  };
  const runners = new Map();
  for (const [test, files] of Object.entries(map.tests)) {
    for (const file of Object.keys(files)) runners.set(file, [...(runners.get(file) ?? []), test]);
  }
  const unmap = (change, kind, why) =>
    unmapped.push({ path: change.path, status: change.status, kind, why, added: change.added, deleted: change.deleted, binary: change.binary });
  for (const change of changes) {
    const { path, status } = change;
    const type = classify(path);
    if (type.kind === 'test') {
      if (status === 'D') notes.push(`${path}: deleted test file`);
      else pick(path, 'changed');
      continue;
    }
    if (type.kind === 'snapshot') {
      if (suite.has(type.test)) pick(type.test, `its snapshot ${path} changed`);
      else if (status !== 'D') unmap(change, 'other', 'snapshot without its test file');
      continue;
    }
    if (type.kind === 'tooling') {
      unmap(change, 'tooling', 'changes how every test runs');
      continue;
    }
    if (type.kind === 'other') {
      unmap(change, 'other', 'outside src/, which is all the map measures');
      continue;
    }
    // Source. Tests that name it by its source path read it as text (imports use `.js`).
    for (const [test, text] of texts) if (text.includes(path)) pick(test, `reads ${path} as text`);
    const ran = runners.get(path) ?? [];
    if (status === 'D') {
      for (const test of ran) pick(test, `ran ${path}, now deleted`);
      unmap(change, 'source', 'deleted source file');
      continue;
    }
    if (status === 'A') {
      unmap(change, 'source', 'new source file, not in the map');
      continue;
    }
    if (change.binary) {
      unmap(change, 'source', 'binary source file');
      continue;
    }
    if (!ran.length || !map.executable[path]) {
      unmap(change, 'source', 'no test executed it when the map was built');
      continue;
    }
    const anchors = anchorLines(change.hunks, rangeLines(map.executable[path]), moved.get(path));
    if (anchors === null) {
      for (const test of ran) pick(test, `ran ${path}, which changed since the map`);
      notes.push(`${path}: every test that ran it (changed since the map)`);
      continue;
    }
    for (const test of ran) {
      const ranges = fromRanges(map.tests[test][path]);
      const hit = [...anchors].filter((line) => rangesHave(ranges, line));
      if (hit.length) pick(test, `executes ${path}:${toRanges(hit)}`);
    }
  }
  return { picks, unmapped, notes, namers: (path) => namers(path, texts) };
}

// ---- Jev ----------------------------------------------------------------------------------

/** The System One request for the unmapped changes: one typed choice. */
export function jevRequest({ unmapped, selected, suite, named }) {
  return {
    model: JEV_MODEL,
    state: {
      project: 'A TypeScript CLI. Its vitest test files live under tests/; the coverage map measures only src/.',
      selection: { test_files: selected, suite },
      unmapped: unmapped.map((u) => ({
        path: u.path,
        change: STATUS[u.status],
        added: u.added,
        deleted: u.deleted,
        ...(u.binary ? { binary: true } : {}),
        named_by_tests: named(u.path),
      })),
    },
    questions: {
      decision: {
        type: 'choice',
        instructions:
          'A coverage map picked the test files that execute the changed source lines. The changes in `unmapped` are outside what the map measures. Could any of them change the outcome of a test file the selection leaves out? With `run_selection`, the test files in `named_by_tests` run too.',
        criteria: {
          run_all:
            'Yes, or it cannot be ruled out: a path could change how tests run or what an unselected test reads or loads (configuration, scripts, CI files, test helpers or fixtures, a new or deleted source file).',
          run_selection: 'No: every path is prose or metadata that no unselected test reads, such as a changelog entry or a guide.',
        },
      },
    },
  };
}

/**
 * Ask Jev whether the unmapped changes need the whole suite. Only a confident `run_selection`
 * narrows; a missing key, an error, a timeout, an unexpected answer or low confidence keeps
 * everything, and says which.
 */
export async function askJev(input, { key, fetch: fetchImpl = globalThis.fetch, baseUrl = JEV_BASE_URL, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  const keep = (reason, extra = {}) => ({ asked: Boolean(key), narrowed: false, reason, ...extra });
  if (!key) return keep('TYPESAFE_API_KEY is not set');
  let answer;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(jevRequest(input)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return keep(`Jev answered HTTP ${res.status}`);
    answer = await res.json();
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return keep(`Jev did not answer within ${timeoutMs / 1000} s`);
    }
    return keep(error instanceof SyntaxError ? 'Jev did not answer JSON' : 'Jev could not be reached');
  }
  const decision = answer?.answers?.decision;
  const labels = ['run_all', 'run_selection'];
  if (
    decision?.type !== 'choice' ||
    !labels.includes(decision.choice) ||
    typeof decision.confidence !== 'number' ||
    !(decision.confidence >= 0 && decision.confidence <= 1) ||
    Object.keys(decision.probabilities ?? {}).some((label) => !labels.includes(label))
  ) {
    return keep('Jev answered something other than the choice it was asked');
  }
  const model = typeof answer.model === 'string' ? answer.model : JEV_MODEL;
  const extra = { model, choice: decision.choice, confidence: decision.confidence };
  const said = `${model} chose ${decision.choice} (confidence ${decision.confidence.toFixed(2)})`;
  // A float epsilon, so a confidence exactly at the bar passes.
  if (decision.choice === 'run_selection' && decision.confidence + 1e-9 >= JEV_MIN_CONFIDENCE) {
    return { asked: true, narrowed: true, reason: said, ...extra };
  }
  return keep(decision.choice === 'run_all' ? said : `${said}, below ${JEV_MIN_CONFIDENCE}`, extra);
}

/**
 * The decision: the test files to run, or everything with the reasons. `problems` are reasons
 * the map cannot be used at all; the rest of the input is as for selectTests, plus `stale`
 * (test files added or edited between the map's commit and the merge base) and `jev`.
 */
export async function decide({ map, problems = [], changes = [], suite, moved, stale = new Set(), texts, jev = {} }) {
  const result = { runAll: false, reasons: [], selected: [], suite: suite.size, why: {}, unmapped: [], notes: [], jev: null };
  if (problems.length) {
    result.runAll = true;
    result.reasons = problems;
    return result;
  }
  // No change, nothing to test.
  if (!changes.length) return result;
  const { picks, unmapped, notes, namers: named } = selectTests(map, { changes, suite, moved, texts });
  const pick = (test, why) => {
    if (!picks.has(test)) picks.set(test, why);
  };
  // The always tier: what the map holds no current record of, or cannot place.
  const unplaced = new Set(map.unplaced);
  const failed = new Set(map.failed);
  for (const test of [...suite].sort()) {
    if (!(test in map.tests)) pick(test, 'not in the map');
    else if (stale.has(test)) pick(test, 'changed since the map');
    else if (failed.has(test)) pick(test, 'failed when the map was built');
    else if (unplaced.has(test)) pick(test, 'the map cannot place it (it runs only what most tests run)');
  }
  result.unmapped = unmapped;
  result.notes = notes;
  if (unmapped.length) {
    const tooling = unmapped.filter((u) => u.kind === 'tooling');
    if (tooling.length) {
      result.runAll = true;
      result.reasons.push(`${tooling.map((u) => u.path).join(', ')} ${tooling.length === 1 ? 'changes' : 'change'} how every test runs`);
      result.jev = { asked: false, narrowed: false, reason: 'not asked: tooling changes always run everything' };
    } else {
      result.jev = jev.enabled
        ? await askJev({ unmapped, selected: picks.size, suite: suite.size, named }, jev)
        : { asked: false, narrowed: false, reason: 'not asked (off; select --jev with TYPESAFE_API_KEY set)' };
      if (result.jev.narrowed) {
        for (const u of unmapped) for (const test of named(u.path)) if (suite.has(test)) pick(test, `names ${u.path}`);
      } else {
        result.runAll = true;
        result.reasons.push(`${unmapped.length} changed ${unmapped.length === 1 ? 'file is' : 'files are'} outside what the map can judge`);
      }
    }
  }
  if (!result.runAll && picks.size > RUN_ALL_SHARE * suite.size) {
    result.runAll = true;
    result.reasons.push(`the selection is ${Math.round((100 * picks.size) / suite.size)}% of the suite (over ${100 * RUN_ALL_SHARE}%)`);
  }
  result.selected = [...picks.keys()].sort();
  result.why = Object.fromEntries(result.selected.map((test) => [test, picks.get(test)]));
  return result;
}

/** Changed executable source lines no measured test executed, per file. */
export function uncoveredLines(changes, capture) {
  const files = [];
  for (const change of changes) {
    if (classify(change.path).kind !== 'source' || change.status === 'D' || change.binary) continue;
    const executable = capture.executable[change.path];
    const outsideFloor = capture.outsideFloor.includes(change.path);
    if (!executable) {
      files.push({ path: change.path, measured: false, outsideFloor });
      continue;
    }
    const live = new Set(rangeLines(executable));
    const changed = [];
    for (const [, , newStart, newCount] of change.hunks) {
      for (let line = newStart; line < newStart + newCount; line++) if (live.has(line)) changed.push(line);
    }
    if (!changed.length) continue;
    const ran = new Set();
    for (const files of Object.values(capture.tests)) for (const line of rangeLines(files[change.path])) ran.add(line);
    const missed = changed.filter((line) => !ran.has(line));
    files.push({ path: change.path, measured: true, outsideFloor, changed: changed.length, uncovered: missed.length, lines: toRanges(missed) });
  }
  return files;
}

// ---- git and vitest -----------------------------------------------------------------------

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOk(root, args) {
  return spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0;
}

const DIFF = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0'];

/** The working tree's changes against `mergeBase`, untracked files included. */
export function workingChanges(root, mergeBase, untracked) {
  const changes = parseDiff(git(root, [...DIFF, mergeBase, '--']));
  for (const path of untracked) {
    const bytes = readFileSync(join(root, path));
    const binary = bytes.includes(0);
    const lines = binary ? 0 : bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0);
    changes.push({ path, status: 'A', binary, hunks: lines ? [[0, 0, 1, lines]] : [], added: lines, deleted: 0 });
  }
  return changes;
}

/** Everything select needs from git, plus the reasons it cannot judge the change. */
export function gitInput(root, base, map) {
  const problems = [];
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const tracked = git(root, ['ls-files', '-z', '--', 'tests']).split('\0');
  const suite = new Set([...tracked, ...untracked].filter((path) => TEST_FILE.test(path) && existsSync(join(root, path))));
  let mergeBase = null;
  try {
    mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  } catch {
    return { problems: [`${base} has no merge base with HEAD in this clone`], mergeBase, changes: [], suite };
  }
  const changes = workingChanges(root, mergeBase, untracked);
  const texts = new Map([...suite].sort().map((test) => [test, readFileSync(join(root, test), 'utf8')]));
  const moved = new Map();
  let stale = new Set();
  if (map) {
    if (!gitOk(root, ['cat-file', '-e', `${map.commit}^{commit}`])) {
      problems.push(`the map's commit ${map.commit.slice(0, 12)} is not in this clone`);
    } else if (!gitOk(root, ['merge-base', '--is-ancestor', map.commit, mergeBase])) {
      problems.push(`the map's commit ${map.commit.slice(0, 12)} is not an ancestor of the merge base`);
    } else {
      const sources = changes.filter((c) => classify(c.path).kind === 'source' && c.status === 'M').map((c) => c.path);
      if (sources.length) {
        for (const file of parseDiff(git(root, [...DIFF, map.commit, mergeBase, '--', ...sources]))) {
          moved.set(file.path, lineTranslator(file.hunks));
        }
      }
      stale = new Set(
        git(root, ['diff', '--name-only', '--no-renames', '--diff-filter=AM', map.commit, mergeBase, '--', 'tests'])
          .split('\n')
          .filter((path) => TEST_FILE.test(path)),
      );
    }
  }
  return { problems, mergeBase, changes, suite, moved, stale, texts };
}

function vitestPackage(root) {
  try {
    const path = createRequire(join(root, 'package.json')).resolve('vitest/package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    return { version: pkg.version, bin: join(dirname(path), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.vitest) };
  } catch {
    return null;
  }
}

/** `vitest run` with stdout on our stderr, so stdout stays the selection. */
function runVitest(root, args, env = process.env) {
  const vitest = vitestPackage(root);
  if (!vitest) throw new Error('vitest is not installed: run npm ci');
  const child = spawnSync(process.execPath, [vitest.bin, 'run', ...args], { cwd: root, env, stdio: ['inherit', 2, 'inherit'] });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

/**
 * Run test files (null: all of them; []: none) under the capturing provider and return what
 * each one executed, plus the executable lines of every source file seen or named in `files`.
 */
function captureRun(root, testFiles, files, flags) {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-map-'));
  try {
    const out = join(dir, 'capture.json');
    const filters = testFiles === null ? [] : testFiles.length ? testFiles : ['--passWithNoTests', '__coverage_map_no_test_files__'];
    const status = runVitest(
      root,
      [
        ...filters,
        '--coverage.enabled=true',
        '--coverage.provider=custom',
        `--coverage.customProviderModule=${PROVIDER}`,
        `--coverage.reportsDirectory=${join(dir, 'reports')}`,
        ...flags,
      ],
      { ...process.env, COVERAGE_MAP_CAPTURE: JSON.stringify({ out, files }) },
    );
    if (!existsSync(out)) throw new Error(`vitest exited with ${status} before writing the coverage capture`);
    return { status, capture: JSON.parse(readFileSync(out, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function loadMap(path) {
  if (!existsSync(path)) return { map: null, problem: `there is no coverage map at ${path}` };
  try {
    const map = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof map?.tests !== 'object' || typeof map?.executable !== 'object' || typeof map?.commit !== 'string') {
      return { map: null, problem: `${path} is not a coverage map` };
    }
    return { map, problem: null };
  } catch {
    return { map: null, problem: `${path} is not valid JSON` };
  }
}

// ---- output -------------------------------------------------------------------------------

const short = (sha) => (sha ? sha.slice(0, 9) : 'none');
const code = (text) => `\`${text}\``;

export function formatMarkdown(result) {
  const out = ['### Test selection', ''];
  const share = result.suite ? Math.round((100 * result.selected.length) / result.suite) : 0;
  if (result.runAll) out.push(`**Runs all ${result.suite} test files:** ${result.reasons.join('; ')}.`);
  else out.push(`**Runs ${result.selected.length} of ${result.suite} test files (${share}%).**`);
  out.push('');
  if (result.map) {
    out.push(
      `Map ${code(short(result.map.commit))} built ${result.map.builtAt} (${result.map.ageHours} h old, vitest ${result.map.vitest}); ` +
        `base ${code(result.base.ref)}, merge base ${code(short(result.base.mergeBase))}.`,
      '',
    );
  }
  if (result.unmapped.length) {
    out.push('**Unmapped** (changes the map cannot judge):');
    for (const u of result.unmapped) {
      const stats = u.binary ? 'binary' : `+${u.added} -${u.deleted}`;
      out.push(`- ${code(u.path)} (${STATUS[u.status]}, ${stats}): ${u.why}`);
    }
    out.push('');
  }
  if (result.jev) out.push(`**Jev:** ${result.jev.reason}.`, '');
  for (const note of result.notes) out.push(`- ${note}`);
  if (result.notes.length) out.push('');
  if (result.selected.length) {
    const label = result.runAll ? 'test files the map alone would pick' : 'selected test files';
    out.push(`<details><summary>${result.selected.length} ${label}</summary>`, '');
    for (const test of result.selected) out.push(`- ${code(test)}: ${result.why[test]}`);
    out.push('', '</details>', '');
  }
  if (result.uncovered?.skipped) {
    out.push(`**Uncovered changed lines:** not measured, ${result.uncovered.skipped}.`, '');
  } else if (result.uncovered) {
    const { files, tests, status } = result.uncovered;
    const measured = files.filter((f) => f.measured);
    const missed = measured.filter((f) => f.uncovered > 0);
    out.push(`**Uncovered changed lines** (report only; measured by running ${tests}${status ? `, which exited ${status}` : ''}):`);
    for (const f of missed) {
      const floor = f.outsideFloor ? ', outside the coverage floor' : '';
      out.push(`- ${code(f.path)}: ${f.lines} (${f.uncovered} of ${f.changed} changed executable lines${floor})`);
    }
    for (const f of files.filter((f) => !f.measured)) out.push(`- ${code(f.path)}: not measured (no source map)`);
    if (!missed.length && measured.length) out.push('- none: a measured test executes every changed executable line');
    if (!files.length) out.push('- none: no changed executable source lines');
    out.push('');
  }
  return out.join('\n');
}

// ---- command line -------------------------------------------------------------------------

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, out: 'coverage-map.json', map: 'coverage-map.json', base: null, maxAgeHours: MAX_AGE_HOURS, json: false, report: false, run: false, jev: false, vitest: [] };
  const values = { '--out': 'out', '--map': 'map', '--base': 'base', '--max-age-hours': 'maxAgeHours' };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const [flag, inline] = arg.split(/=(.*)/s);
    if (arg === '--') {
      options.vitest.push(...rest.slice(i + 1));
      break;
    } else if (flag in values) {
      const value = inline ?? rest[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[values[flag]] = values[flag] === 'maxAgeHours' ? Number(value) : value;
    } else if (['--json', '--report', '--run', '--jev'].includes(arg)) {
      options[arg.slice(2)] = true;
    } else {
      options.vitest.push(arg);
    }
  }
  if (!['build', 'select'].includes(command)) throw new Error('Usage: coverage-map.mjs build | select --base <ref>');
  if (command === 'select' && !options.base) throw new Error('select needs --base <ref>');
  if (!(options.maxAgeHours > 0)) throw new Error('--max-age-hours needs a positive number');
  return options;
}

async function build(root, options) {
  const started = Date.now();
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).trim() !== '';
  const { status, capture } = captureRun(root, null, null, options.vitest);
  const map = {
    version: MAP_VERSION,
    commit,
    dirty,
    builtAt: new Date(started).toISOString(),
    vitest: vitestPackage(root)?.version ?? null,
    node: process.version,
    durationMs: Date.now() - started,
    failed: capture.failed,
    unplaced: unplacedTests(capture.tests),
    tests: capture.tests,
    executable: capture.executable,
  };
  const text = `${JSON.stringify(map)}\n`;
  writeFileSync(resolve(root, options.out), text);
  const files = Object.keys(map.executable).length;
  console.log(
    `${options.out}: ${Object.keys(map.tests).length} test files over ${files} source files at ${short(commit)}${dirty ? ' (uncommitted changes)' : ''}, ` +
      `${(text.length / 1048576).toFixed(1)} MiB, built in ${Math.round(map.durationMs / 1000)} s; ` +
      `${map.unplaced.length} unplaced, ${map.failed.length} failed`,
  );
  return status;
}

async function select(root, options) {
  const vitest = vitestPackage(root)?.version ?? null;
  const loaded = loadMap(resolve(root, options.map));
  const problems = loaded.problem ? [loaded.problem] : mapProblems(loaded.map, { maxAgeHours: options.maxAgeHours, vitest });
  const input = gitInput(root, options.base, problems.length ? null : loaded.map);
  const result = await decide({
    map: loaded.map,
    ...input,
    problems: [...problems, ...input.problems],
    jev: { enabled: options.jev, key: process.env.TYPESAFE_API_KEY, baseUrl: process.env.TYPESAFE_BASE_URL || undefined },
  });
  result.base = { ref: options.base, mergeBase: input.mergeBase };
  if (loaded.map) {
    const { commit, builtAt, vitest: built } = loaded.map;
    result.map = { commit, builtAt, vitest: built, ageHours: Math.floor((Date.now() - Date.parse(builtAt)) / 3_600_000) };
  }
  const tests = result.runAll ? null : result.selected;
  let status = 0;
  let ran = false;
  if (options.report) {
    const files = input.changes.filter((c) => classify(c.path).kind === 'source' && c.status !== 'D' && !c.binary).map((c) => c.path);
    if (input.mergeBase === null) {
      result.uncovered = { skipped: 'there is no diff to measure' };
    } else if (!files.length) {
      result.uncovered = { skipped: 'no source file changed' };
    } else {
      const run = captureRun(root, tests, files, options.vitest);
      ran = true;
      status = run.status;
      result.uncovered = {
        tests: tests === null ? 'every test file' : `the ${tests.length} selected test files`,
        status,
        files: uncoveredLines(input.changes, run.capture),
      };
    }
  }
  console.log(options.json ? JSON.stringify(result, null, 2) : formatMarkdown(result));
  if (options.run && !ran) {
    if (tests?.length === 0) console.error('No test file is affected.');
    else status = runVitest(root, [...(tests ?? []), ...options.vitest]);
  }
  return options.run ? status : 0;
}

export async function main(argv, root = process.cwd()) {
  const options = parseArgs(argv);
  return options.command === 'build' ? build(root, options) : select(root, options);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    },
  );
}
