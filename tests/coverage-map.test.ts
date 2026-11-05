import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  JEV_MIN_CONFIDENCE,
  JEV_MODEL,
  MAP_VERSION,
  anchorLines,
  askJev,
  classify,
  decide,
  decodeMappings,
  executedLines,
  formatMarkdown,
  fromRanges,
  gitInput,
  jevRequest,
  lineTranslator,
  mapProblems,
  parseArgs,
  parseDiff,
  segmentsOf,
  selectTests,
  toRanges,
  uncoveredLines,
  unplacedTests,
} from '../scripts/coverage-map.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'coverage-map.mjs');
const NOW = Date.parse('2026-11-05T12:00:00Z');

type Tests = Record<string, Record<string, string>>;
function makeMap(tests: Tests, executable: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    version: MAP_VERSION,
    commit: 'c'.repeat(40),
    dirty: false,
    builtAt: new Date(NOW - 3_600_000).toISOString(),
    vitest: '5.0.5',
    failed: [] as string[],
    unplaced: [] as string[],
    tests,
    executable,
    ...extra,
  };
}

const change = (path: string, hunks: number[][], status = 'M', extra: Record<string, unknown> = {}) => ({
  path,
  status,
  binary: false,
  hunks,
  added: hunks.reduce((n, h) => n + h[3], 0),
  deleted: hunks.reduce((n, h) => n + h[1], 0),
  ...extra,
});

// Ten test files: a runs src/x.ts, b runs x and y, c runs y, d..j run z.
const SUITE = new Set('abcdefghij'.split('').map((l) => `tests/${l}.test.ts`));
const TESTS: Tests = {
  'tests/a.test.ts': { 'src/x.ts': '1-10' },
  'tests/b.test.ts': { 'src/x.ts': '1-3', 'src/y.ts': '1-5' },
  'tests/c.test.ts': { 'src/y.ts': '1-2,4' },
  ...Object.fromEntries('defghij'.split('').map((l) => [`tests/${l}.test.ts`, { 'src/z.ts': '1-20' }])),
};
// Line 11 of x is a comment (no code); line 12 is code no test runs.
const EXECUTABLE = { 'src/x.ts': '1-10,12', 'src/y.ts': '1-5', 'src/z.ts': '1-20' };
const MAP = makeMap(TESTS, EXECUTABLE);

const choose = (path: string, hunks: number[][], extra: Record<string, unknown> = {}) =>
  decide({ map: MAP, changes: [change(path, hunks)], suite: SUITE, ...extra });

describe('line ranges and source maps', () => {
  it('round-trips line ranges', () => {
    expect(toRanges([7, 1, 2, 3, 9, 10, 3])).toBe('1-3,7,9-10');
    expect(fromRanges('1-3,7,9-10')).toEqual([[1, 3], [7, 7], [9, 10]]);
    expect(toRanges([])).toBe('');
    expect(fromRanges('')).toEqual([]);
  });

  it('decodes source map mappings across lines, skipping segments without a source', () => {
    // [0,0,0,0] ; [0,0,1,0] , [2,0,0,2] , a generated-only segment [4]
    expect(decodeMappings('AAAA;AACA,EAAE,I')).toEqual([
      [0, 0, 0, 0],
      [1, 0, 0, 1],
      [1, 2, 0, 1],
    ]);
    expect(decodeMappings('AAAA;;AAEA')).toEqual([
      [0, 0, 0, 0],
      [2, 0, 0, 2],
    ]);
    expect(() => decodeMappings('A!')).toThrow(/Invalid source map/);
  });

  it('counts a line executed when the innermost V8 range around its code ran', () => {
    // Generated: "a();\nif(x){\nb();\n}\n" from source lines 1, 3, 4 and 5 (line 2 was a comment).
    const code = 'a();\nif(x){\nb();\n}\n';
    const segments = segmentsOf(code, { sources: ['x.ts'], mappings: 'AAAA;AAEA;AACA;AACA' }, 'src/x.ts')!;
    expect([...segments.lines]).toEqual([1, 3, 4, 5]);
    // The top-level script ran once; a block over offsets 11-15 (holding "b();" at 12) never ran.
    const functions = [{ ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }, { startOffset: 11, endOffset: 16, count: 0 }] }];
    expect([...executedLines(segments, functions)].sort()).toEqual([1, 3, 5]);
    // The module wrapper shifts every V8 offset by its length.
    const wrapped = [{ ranges: [{ startOffset: 0, endOffset: code.length + 30, count: 1 }, { startOffset: 41, endOffset: 46, count: 0 }] }];
    expect([...executedLines(segments, wrapped, 30)].sort()).toEqual([1, 3, 5]);
    // A function that was never called has count 0 over its own range.
    expect([...executedLines(segments, [{ ranges: [{ startOffset: 0, endOffset: code.length, count: 0 }] }])]).toEqual([]);
  });

  it('places only test files that run something at most half the suite runs', () => {
    const tests: Tests = {
      'tests/a.test.ts': { 'src/hub.ts': '1-5', 'src/a.ts': '1' },
      'tests/b.test.ts': { 'src/hub.ts': '1-5' },
      'tests/c.test.ts': { 'src/hub.ts': '1-5' },
      'tests/d.test.ts': {},
    };
    expect(unplacedTests(tests)).toEqual(['tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts']);
  });
});

describe('diffs', () => {
  it('parses statuses, hunks and counts from a zero-context patch', () => {
    const patch = [
      'diff --git a/src/x.ts b/src/x.ts',
      'index 1111111..2222222 100644',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -3 +3 @@ export const a = 1;',
      '---old',
      '+++new',
      '@@ -10,0 +11,2 @@',
      '+one',
      '+two',
      '\\ No newline at end of file',
      'diff --git a/tests/new.test.ts b/tests/new.test.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/tests/new.test.ts',
      '@@ -0,0 +1,3 @@',
      '+a',
      '+b',
      '+c',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/docs/logo.png b/docs/logo.png',
      'Binary files a/docs/logo.png and b/docs/logo.png differ',
      'diff --git "a/docs/a \\"quoted\\" name.md" "b/docs/a \\"quoted\\" name.md"',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/docs/with space.md b/docs/with space.md',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');
    expect(parseDiff(patch)).toEqual([
      { path: 'src/x.ts', status: 'M', binary: false, hunks: [[3, 1, 3, 1], [10, 0, 11, 2]], added: 3, deleted: 1 },
      { path: 'tests/new.test.ts', status: 'A', binary: false, hunks: [[0, 0, 1, 3]], added: 3, deleted: 0 },
      { path: 'src/gone.ts', status: 'D', binary: false, hunks: [[1, 2, 0, 0]], added: 0, deleted: 2 },
      { path: 'docs/logo.png', status: 'M', binary: true, hunks: [], added: 0, deleted: 0 },
      { path: 'docs/a "quoted" name.md', status: 'M', binary: false, hunks: [], added: 0, deleted: 0 },
      { path: 'docs/with space.md', status: 'M', binary: false, hunks: [], added: 0, deleted: 0 },
    ]);
  });

  it('translates newer lines back across replacements, insertions and deletions', () => {
    // Old lines 3-4 became new lines 3-5; old line 8 was deleted (after new line 8).
    const translate = lineTranslator([[3, 2, 3, 3], [8, 1, 8, 0]]);
    expect([1, 2, 3, 5, 6, 8, 9, 10].map(translate)).toEqual([1, 2, null, null, 5, 7, 9, 10]);
    // Two lines inserted after old line 5.
    const inserted = lineTranslator([[5, 0, 6, 2]]);
    expect([5, 6, 7, 8].map(inserted)).toEqual([5, null, null, 6]);
    // The first two old lines deleted.
    expect(lineTranslator([[1, 2, 0, 0]])(1)).toBe(3);
  });

  it('anchors a hunk on its executable lines, or on the nearest code around it', () => {
    const executable = [1, 2, 3, 6, 7, 10];
    expect(anchorLines([[2, 2, 2, 2]], executable)).toEqual(new Set([2, 3]));
    // Insertion after line 4 (not code): nearest code above is 3, below is 6.
    expect(anchorLines([[4, 0, 5, 1]], executable)).toEqual(new Set([3, 6]));
    // Only non-code lines touched (4-5): their neighbours stand in.
    expect(anchorLines([[4, 2, 4, 2]], executable)).toEqual(new Set([3, 6]));
    // An insertion before the first line has nothing above it.
    expect(anchorLines([[0, 0, 1, 1]], executable)).toEqual(new Set([1]));
    // A touched line with no counterpart at the map's commit: the caller goes file level.
    expect(anchorLines([[2, 1, 2, 1]], executable, (line: number) => (line === 2 ? null : line))).toBeNull();
  });
});

describe('selection by line', () => {
  it('selects the test files that executed a touched line', async () => {
    const result = await choose('src/x.ts', [[5, 1, 5, 1]]);
    expect(result.runAll).toBe(false);
    expect(result.selected).toEqual(['tests/a.test.ts']);
    expect(result.why['tests/a.test.ts']).toBe('executes src/x.ts:5');
  });

  it('uses the nearest code above and below a pure insertion or a comment-only hunk', async () => {
    expect((await choose('src/x.ts', [[3, 0, 4, 1]])).selected).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    // Line 11 is a comment: 10 above runs in a; 12 below runs nowhere.
    expect((await choose('src/x.ts', [[11, 0, 12, 2]])).selected).toEqual(['tests/a.test.ts']);
    expect((await choose('src/x.ts', [[11, 1, 11, 1]])).selected).toEqual(['tests/a.test.ts']);
  });

  it('selects nothing for code no test executed', async () => {
    const result = await choose('src/x.ts', [[12, 1, 12, 1]]);
    expect(result).toMatchObject({ runAll: false, selected: [], reasons: [] });
  });

  it('translates lines of a file that changed between the map and the merge base', async () => {
    // Two lines were added at the top since the map: merge-base line 7 is map line 5.
    const moved = new Map([['src/x.ts', lineTranslator([[0, 0, 1, 2]])]]);
    expect((await choose('src/x.ts', [[7, 1, 7, 1]], { moved })).selected).toEqual(['tests/a.test.ts']);
    // A touched line that changed since the map has no counterpart: every test that ran the file.
    const rewritten = new Map([['src/x.ts', lineTranslator([[5, 1, 5, 1]])]]);
    const result = await choose('src/x.ts', [[5, 1, 5, 1]], { moved: rewritten });
    expect(result.selected).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
    expect(result.notes).toEqual(['src/x.ts: every test that ran it (changed since the map)']);
  });

  it('always adds the test files the change edits, and the test a snapshot belongs to', async () => {
    const result = await decide({
      map: MAP,
      suite: SUITE,
      changes: [change('tests/c.test.ts', [[1, 1, 1, 1]]), change('tests/__snapshots__/d.test.ts.snap', [[1, 1, 1, 1]]), change('tests/gone.test.ts', [[1, 3, 0, 0]], 'D')],
    });
    expect(result.runAll).toBe(false);
    expect(result.why).toEqual({ 'tests/c.test.ts': 'changed', 'tests/d.test.ts': 'its snapshot tests/__snapshots__/d.test.ts.snap changed' });
    expect(result.notes).toEqual(['tests/gone.test.ts: deleted test file']);
  });

  it('adds a new test file the map has never seen', async () => {
    const suite = new Set([...SUITE, 'tests/new.test.ts']);
    const result = await decide({ map: MAP, suite, changes: [change('tests/new.test.ts', [[0, 0, 1, 5]], 'A')] });
    expect(result.why['tests/new.test.ts']).toBe('changed');
    expect(result.runAll).toBe(false);
  });

  it('adds the tests that read a changed source file as text', async () => {
    const texts = new Map([
      ['tests/j.test.ts', "readFileSync(new URL('../src/x.ts', import.meta.url))"],
      ['tests/i.test.ts', "import { x } from '../src/x.js';"],
    ]);
    const result = await choose('src/x.ts', [[12, 1, 12, 1]], { texts });
    expect(result.why).toEqual({ 'tests/j.test.ts': 'reads src/x.ts as text' });
  });

  it('keeps an always tier: tests absent from the map, edited since it, failed in it or unplaced by it', async () => {
    const map = makeMap(TESTS, EXECUTABLE, { failed: ['tests/c.test.ts'], unplaced: ['tests/d.test.ts'] });
    const suite = new Set([...SUITE, 'tests/new.test.ts']);
    const result = await decide({ map, suite, stale: new Set(['tests/b.test.ts']), changes: [change('src/x.ts', [[12, 1, 12, 1]])] });
    expect(result.why).toEqual({
      'tests/b.test.ts': 'changed since the map',
      'tests/c.test.ts': 'failed when the map was built',
      'tests/d.test.ts': 'the map cannot place it (it runs only what most tests run)',
      'tests/new.test.ts': 'not in the map',
    });
  });

  it('selects nothing when nothing changed', async () => {
    const map = makeMap(TESTS, EXECUTABLE, { unplaced: ['tests/d.test.ts'] });
    expect(await decide({ map, suite: SUITE, changes: [] })).toMatchObject({ runAll: false, selected: [] });
  });
});

describe('run-everything rules', () => {
  it('reports each reason the map is unusable', () => {
    expect(mapProblems(null)).toEqual(['there is no coverage map']);
    expect(mapProblems({ ...MAP, version: 0 })).toEqual(['the coverage map has format 0, expected 1']);
    const at = { now: NOW, vitest: '5.0.5' };
    expect(mapProblems(MAP, at)).toEqual([]);
    expect(mapProblems({ ...MAP, dirty: true }, at)).toEqual(['the map was built from uncommitted changes']);
    const old = { ...MAP, builtAt: new Date(NOW - 73 * 3_600_000).toISOString() };
    expect(mapProblems(old, at)).toEqual(['the map is 73 hours old (max 72)']);
    expect(mapProblems({ ...MAP, builtAt: new Date(NOW - 72 * 3_600_000).toISOString() }, at)).toEqual([]);
    expect(mapProblems(old, { ...at, maxAgeHours: 96 })).toEqual([]);
    expect(mapProblems({ ...MAP, builtAt: 'yesterday' }, at)).toEqual(['the map is of unknown age (max 72)']);
    expect(mapProblems(MAP, { now: NOW, vitest: '5.1.0' })).toEqual(['the map was built with vitest 5.0.5, this checkout has 5.1.0']);
  });

  it('runs everything when the map is unusable', async () => {
    const result = await decide({ map: null, problems: ['there is no coverage map at coverage-map.json'], suite: SUITE, changes: [change('src/x.ts', [[5, 1, 5, 1]])] });
    expect(result).toMatchObject({ runAll: true, reasons: ['there is no coverage map at coverage-map.json'], selected: [], suite: 10 });
  });

  it.each([
    ['package.json', 'tooling'],
    ['package-lock.json', 'tooling'],
    ['vitest.config.ts', 'tooling'],
    ['tsconfig.json', 'tooling'],
    ['tests/setup/isolate-stores.ts', 'tooling'],
    ['scripts/coverage-map.mjs', 'tooling'],
    ['scripts/release/assemble.mjs', 'other'],
    ['packaging/build-binary.mjs', 'other'],
    ['docs/runtime.md', 'other'],
    ['.github/workflows/ci.yml', 'other'],
    ['tests/helpers/provider-wire.ts', 'other'],
    ['tests/fixtures/brain-interchange/cli-bundle.json', 'other'],
  ])('runs everything when %s changes (%s)', async (path, kind) => {
    const result = await decide({ map: MAP, suite: SUITE, changes: [change('src/x.ts', [[5, 1, 5, 1]]), change(path, [[1, 1, 1, 1]])] });
    expect(result.runAll).toBe(true);
    expect(result.unmapped).toEqual([expect.objectContaining({ path, kind, status: 'M', added: 1, deleted: 1 })]);
    expect(result.reasons).toEqual([kind === 'tooling' ? `${path} changes how every test runs` : '1 changed file is outside what the map can judge']);
    // The map's own picks are still reported for comparison.
    expect(result.selected).toEqual(['tests/a.test.ts']);
  });

  it.each([
    ['a new source file', change('src/new.ts', [[0, 0, 1, 4]], 'A'), 'new source file, not in the map'],
    ['a deleted source file', change('src/y.ts', [[1, 5, 0, 0]], 'D'), 'deleted source file'],
    ['a source file no test executed', change('src/bin.ts', [[1, 1, 1, 1]]), 'no test executed it when the map was built'],
    ['a binary source file', change('src/x.ts', [], 'M', { binary: true }), 'binary source file'],
  ])('runs everything for %s', async (_, source, why) => {
    const result = await decide({ map: MAP, suite: SUITE, changes: [source] });
    expect(result.runAll).toBe(true);
    expect(result.unmapped).toEqual([expect.objectContaining({ path: source.path, kind: 'source', why })]);
  });

  it('still picks the tests that ran a deleted source file', async () => {
    const result = await decide({ map: MAP, suite: SUITE, changes: [change('src/y.ts', [[1, 5, 0, 0]], 'D')] });
    expect(result.why).toEqual({ 'tests/b.test.ts': 'ran src/y.ts, now deleted', 'tests/c.test.ts': 'ran src/y.ts, now deleted' });
  });

  it('runs everything when the selection is over 70% of the suite, and not at exactly 70%', async () => {
    const atLimit = await choose('src/z.ts', [[1, 1, 1, 1]]);
    expect(atLimit.selected).toHaveLength(7);
    expect(atLimit.runAll).toBe(false);
    const over = await decide({ map: MAP, suite: SUITE, changes: [change('src/z.ts', [[1, 1, 1, 1]]), change('src/y.ts', [[1, 1, 1, 1]])] });
    expect(over.selected).toHaveLength(9);
    expect(over).toMatchObject({ runAll: true, reasons: ['the selection is 90% of the suite (over 70%)'] });
  });
});

describe('Jev', () => {
  const docs = () => [change('src/x.ts', [[5, 1, 5, 1]]), change('docs/runtime.md', [[3, 1, 3, 2]])];
  const answer = (decision: Record<string, unknown>, model = 'jev-1.14.0') =>
    new Response(JSON.stringify({ model, answers: { decision }, usage: { input_tokens: 300, output_tokens: 4 } }), { status: 200 });
  const choice = (label: string, confidence: number) =>
    answer({ type: 'choice', choice: label, confidence, probabilities: { run_all: 1 - (confidence + 1) / 2, run_selection: (confidence + 1) / 2 } });
  const ask = (fetch: unknown, extra: Record<string, unknown> = {}) =>
    decide({ map: MAP, suite: SUITE, changes: docs(), jev: { enabled: true, key: 'test-key', fetch, ...extra }, ...extra });

  it('is off unless asked for, and needs a key', async () => {
    const fetch = vi.fn();
    const off = await decide({ map: MAP, suite: SUITE, changes: docs() });
    expect(off.jev).toEqual({ asked: false, narrowed: false, reason: 'not asked (off; select --jev with TYPESAFE_API_KEY set)' });
    expect(off.runAll).toBe(true);
    const keyless = await decide({ map: MAP, suite: SUITE, changes: docs(), jev: { enabled: true, key: '', fetch } });
    expect(keyless.jev).toEqual({ asked: false, narrowed: false, reason: 'TYPESAFE_API_KEY is not set' });
    expect(keyless.runAll).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is never asked about tooling changes', async () => {
    const fetch = vi.fn();
    const result = await decide({ map: MAP, suite: SUITE, changes: [...docs(), change('package.json', [[2, 1, 2, 1]])], jev: { enabled: true, key: 'k', fetch } });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.runAll).toBe(true);
    expect(result.jev.reason).toBe('not asked: tooling changes always run everything');
  });

  it('sends one typed choice over the unmapped paths and their stats, with the key only in the header', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const fetch = async (url: string, init: RequestInit) => {
      request = { url, init };
      return choice('run_all', 0.9);
    };
    const texts = new Map([['tests/j.test.ts', "readFileSync('docs/runtime.md')"]]);
    await decide({ map: MAP, suite: SUITE, changes: docs(), texts, jev: { enabled: true, key: 'secret-key', fetch } });
    expect(request!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request!.init.headers).toMatchObject({ authorization: 'Bearer secret-key', 'content-type': 'application/json' });
    const body = JSON.parse(String(request!.init.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state.selection).toEqual({ test_files: 1, suite: 10 });
    expect(body.state.unmapped).toEqual([{ path: 'docs/runtime.md', change: 'modified', added: 2, deleted: 1, named_by_tests: ['tests/j.test.ts'] }]);
    expect(Object.keys(body.questions)).toEqual(['decision']);
    expect(body.questions.decision.type).toBe('choice');
    expect(Object.keys(body.questions.decision.criteria)).toEqual(['run_all', 'run_selection']);
    expect(String(request!.init.body)).not.toContain('secret-key');
  });

  it('narrows only on a confident run_selection, adding the tests that name the paths', async () => {
    const texts = new Map([['tests/j.test.ts', "readFileSync('docs/runtime.md')"]]);
    const result = await ask(async () => choice('run_selection', JEV_MIN_CONFIDENCE), { texts });
    expect(result.runAll).toBe(false);
    expect(result.jev).toMatchObject({ asked: true, narrowed: true, model: 'jev-1.14.0', choice: 'run_selection', confidence: 0.8 });
    // It never drops what the map selected.
    expect(result.why).toEqual({ 'tests/a.test.ts': 'executes src/x.ts:5', 'tests/j.test.ts': 'names docs/runtime.md' });
  });

  it.each([
    ['run_selection below the bar', async () => choice('run_selection', 0.79), 'jev-1.14.0 chose run_selection (confidence 0.79), below 0.8'],
    ['run_all', async () => choice('run_all', 0.95), 'jev-1.14.0 chose run_all (confidence 0.95)'],
    ['an unreachable service', async () => Promise.reject(new TypeError('fetch failed')), 'Jev could not be reached'],
    ['an HTTP error', async () => new Response('{"detail":"no"}', { status: 401 }), 'Jev answered HTTP 401'],
    ['a body that is not JSON', async () => new Response('<html>', { status: 200 }), 'Jev did not answer JSON'],
    ['an unknown label', async () => answer({ type: 'choice', choice: 'maybe', confidence: 0.9, probabilities: {} }), 'Jev answered something other than the choice it was asked'],
    ['a probability for a label not asked', async () => answer({ type: 'choice', choice: 'run_selection', confidence: 0.9, probabilities: { other: 0.1 } }), 'Jev answered something other than the choice it was asked'],
    ['a confidence out of range', async () => answer({ type: 'choice', choice: 'run_selection', confidence: 1.5, probabilities: {} }), 'Jev answered something other than the choice it was asked'],
    ['another answer type', async () => answer({ type: 'noul', noul: 0.99 }), 'Jev answered something other than the choice it was asked'],
  ])('keeps everything on %s', async (_, fetch, reason) => {
    const result = await ask(fetch);
    expect(result.runAll).toBe(true);
    expect(result.jev.narrowed).toBe(false);
    expect(result.jev.reason).toBe(reason);
    expect(result.reasons).toEqual(['1 changed file is outside what the map can judge']);
  });

  it('keeps everything when Jev does not answer in time', async () => {
    const hang = (_: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
    const result = await askJev({ unmapped: [], selected: 0, suite: 1, named: () => [] }, { key: 'k', fetch: hang, timeoutMs: 20 });
    expect(result).toEqual({ asked: true, narrowed: false, reason: 'Jev did not answer within 0.02 s' });
  });

  it('still runs everything after narrowing when the selection is over 70%', async () => {
    const result = await decide({
      map: MAP,
      suite: SUITE,
      changes: [change('src/z.ts', [[1, 1, 1, 1]]), change('src/y.ts', [[1, 1, 1, 1]]), change('docs/runtime.md', [[1, 1, 1, 1]])],
      jev: { enabled: true, key: 'k', fetch: async () => choice('run_selection', 0.99) },
    });
    expect(result.jev.narrowed).toBe(true);
    expect(result).toMatchObject({ runAll: true, reasons: ['the selection is 90% of the suite (over 70%)'] });
  });

  it('describes paths without sending their contents', () => {
    const body = jevRequest({
      unmapped: [{ path: 'docs/a.md', status: 'A', added: 3, deleted: 0, binary: false }, { path: 'docs/logo.png', status: 'D', added: 0, deleted: 0, binary: true }],
      selected: 2,
      suite: 9,
      named: () => [],
    });
    expect(body.state.unmapped).toEqual([
      { path: 'docs/a.md', change: 'added', added: 3, deleted: 0, named_by_tests: [] },
      { path: 'docs/logo.png', change: 'deleted', added: 0, deleted: 0, binary: true, named_by_tests: [] },
    ]);
  });
});

describe('uncovered changed lines', () => {
  const capture = {
    tests: { 'tests/a.test.ts': { 'src/x.ts': '1-3' }, 'tests/b.test.ts': { 'src/x.ts': '7' } },
    executable: { 'src/x.ts': '1-5,7', 'src/new.ts': '1-2,4', 'src/ui/view.tsx': '1-3' },
    outsideFloor: ['src/ui/view.tsx'],
  };

  it('lists changed executable lines no measured test ran, skipping comments, blanks and types', () => {
    // New lines 2-6: 2-3 ran, 4-5 did not, 6 has no code.
    expect(uncoveredLines([change('src/x.ts', [[2, 0, 2, 5]])], capture)).toEqual([
      { path: 'src/x.ts', measured: true, outsideFloor: false, changed: 4, uncovered: 2, lines: '4-5' },
    ]);
    // Only a comment changed: nothing to report.
    expect(uncoveredLines([change('src/x.ts', [[6, 1, 6, 1]])], capture)).toEqual([]);
    expect(uncoveredLines([change('src/x.ts', [[7, 1, 7, 1]])], capture)[0]).toMatchObject({ uncovered: 0, lines: '' });
  });

  it('counts every line of a new file, marks files outside the coverage floor, and skips the rest', () => {
    const changes = [
      change('src/new.ts', [[0, 0, 1, 4]], 'A'),
      change('src/ui/view.tsx', [[1, 1, 1, 1]]),
      change('src/gone.ts', [[1, 2, 0, 0]], 'D'),
      change('tests/a.test.ts', [[1, 1, 1, 1]]),
      change('src/data.json', [[1, 1, 1, 1]]),
    ];
    expect(uncoveredLines(changes, capture)).toEqual([
      { path: 'src/new.ts', measured: true, outsideFloor: false, changed: 3, uncovered: 3, lines: '1-2,4' },
      { path: 'src/ui/view.tsx', measured: true, outsideFloor: true, changed: 1, uncovered: 1, lines: '1' },
      { path: 'src/data.json', measured: false, outsideFloor: false },
    ]);
  });

  it('reports in the job summary', () => {
    const result = {
      runAll: false,
      reasons: [],
      selected: ['tests/a.test.ts'],
      suite: 10,
      why: { 'tests/a.test.ts': 'executes src/x.ts:5' },
      unmapped: [],
      notes: [],
      jev: null,
      base: { ref: 'origin/main', mergeBase: 'b'.repeat(40) },
      map: { commit: 'c'.repeat(40), builtAt: '2026-11-05T06:00:00.000Z', vitest: '5.0.5', ageHours: 6 },
      uncovered: { tests: 'the 1 selected test files', status: 1, files: uncoveredLines([change('src/x.ts', [[2, 0, 2, 5]])], capture) },
    };
    const text = formatMarkdown(result);
    expect(text).toContain('**Runs 1 of 10 test files (10%).**');
    expect(text).toContain('Map `ccccccccc` built 2026-11-05T06:00:00.000Z (6 h old, vitest 5.0.5); base `origin/main`, merge base `bbbbbbbbb`.');
    expect(text).toContain('- `tests/a.test.ts`: executes src/x.ts:5');
    expect(text).toContain('measured by running the 1 selected test files, which exited 1');
    expect(text).toContain('- `src/x.ts`: 4-5 (2 of 4 changed executable lines)');
    const all = formatMarkdown({ ...result, runAll: true, reasons: ['package.json changes how every test runs'], uncovered: { skipped: 'no source file changed' } });
    expect(all).toContain('**Runs all 10 test files:** package.json changes how every test runs.');
    expect(all).toContain('test files the map alone would pick');
    expect(all).toContain('**Uncovered changed lines:** not measured, no source file changed.');
  });
});

describe('command line', () => {
  it('separates its own flags from vitest flags', () => {
    expect(parseArgs(['select', '--base', 'origin/main', '--run', '--maxWorkers=2', '--map=m.json', '--', '--reporter', 'dot'])).toMatchObject({
      command: 'select',
      base: 'origin/main',
      map: 'm.json',
      run: true,
      report: false,
      vitest: ['--maxWorkers=2', '--reporter', 'dot'],
    });
    expect(parseArgs(['build', '--out', 'x.json', '--maxWorkers', '2'])).toMatchObject({ command: 'build', out: 'x.json', vitest: ['--maxWorkers', '2'] });
    expect(() => parseArgs(['select'])).toThrow('select needs --base <ref>');
    expect(() => parseArgs(['select', '--base'])).toThrow('--base needs a value');
    expect(() => parseArgs(['list'])).toThrow(/Usage/);
    expect(() => parseArgs(['select', '--base', 'x', '--max-age-hours', 'soon'])).toThrow(/positive number/);
  });

  it('wires CI as report only, beside the unchanged full suite', () => {
    const workflow = (name: string) => parse(readFileSync(join(REPO, '.github', 'workflows', name), 'utf8'));
    const selection = workflow('test-selection.yml');
    expect(Object.keys(selection.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    const { map, report } = selection.jobs;
    expect(map.if).toBe("github.event_name != 'pull_request'");
    const upload = map.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.if).toContain('always()');
    expect(upload.with).toEqual({ name: 'coverage-map', path: 'coverage-map.json', 'retention-days': 14 });
    expect(map.steps.some((s: { run?: string }) => s.run?.startsWith('npm run --silent coverage:map'))).toBe(true);
    expect(report.name).toBe('test selection (report)');
    expect(report['continue-on-error']).toBe(true);
    expect(report.if).toBe("github.event_name == 'pull_request'");
    expect(report.steps.at(-1).run).toContain('select --base "origin/$BASE_REF" --report');
    for (const step of [...map.steps, ...report.steps]) expect(step.run ?? '').not.toContain('secrets.');
    // The required build job still runs the whole suite, and nothing else gates on the selector.
    const ci = workflow('ci.yml');
    expect(ci.jobs.build.steps.some((s: { run?: string }) => s.run === 'npm test -- --maxWorkers=2')).toBe(true);
    expect(JSON.stringify(ci)).not.toContain('coverage-map');
    const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts;
    expect(scripts['coverage:map']).toBe('node scripts/coverage-map.mjs build');
    expect(scripts['test:affected']).toBe('node scripts/coverage-map.mjs select --base origin/main --run');
  });

  it('classifies paths', () => {
    expect(classify('tests/a/b.test.ts')).toEqual({ kind: 'test' });
    expect(classify('tests/__snapshots__/a.test.ts.snap')).toEqual({ kind: 'snapshot', test: 'tests/a.test.ts' });
    expect(classify('tests/helpers/a.ts')).toEqual({ kind: 'other' });
    expect(classify('src/ui/a.tsx')).toEqual({ kind: 'source' });
    expect(classify('vitest.config.ts')).toEqual({ kind: 'tooling' });
  });
});

// ---- real Git ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-map-')));
  roots.push(root);
  return root;
}
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function write(root: string, path: string, text: string) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}
const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `export const ${tag}${i + 1} = ${i + 1};`).join('\n') + '\n';

describe('select against a real repository', () => {
  function fixture() {
    const root = repo();
    git(root, 'init', '-q', '-b', 'main');
    write(root, 'src/x.ts', lines(10));
    write(root, 'tests/a.test.ts', "import '../src/x.js';\n");
    write(root, 'tests/b.test.ts', "import '../src/x.js';\n");
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    const commit = git(root, 'rev-parse', 'HEAD');
    const map = makeMap({ 'tests/a.test.ts': { 'src/x.ts': '1-5' }, 'tests/b.test.ts': { 'src/x.ts': '6-10' } }, { 'src/x.ts': '1-10' }, { commit });
    return { root, commit, map };
  }

  it('diffs the working tree, untracked files included, against the merge base', async () => {
    const { root, commit, map } = fixture();
    write(root, 'src/x.ts', lines(10).replace('line7 = 7', 'line7 = 70'));
    write(root, 'tests/c.test.ts', "it('new', () => {});\n");
    const input = gitInput(root, commit, map);
    expect(input.problems).toEqual([]);
    expect(input.mergeBase).toBe(commit);
    expect([...input.suite].sort()).toEqual(['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']);
    expect(input.changes).toEqual([
      { path: 'src/x.ts', status: 'M', binary: false, hunks: [[7, 1, 7, 1]], added: 1, deleted: 1 },
      { path: 'tests/c.test.ts', status: 'A', binary: false, hunks: [[0, 0, 1, 1]], added: 1, deleted: 0 },
    ]);
    const result = await decide({ map, ...input });
    expect(result.why).toEqual({ 'tests/b.test.ts': 'executes src/x.ts:7', 'tests/c.test.ts': 'changed' });
  });

  it('translates lines that moved on the base branch since the map, and keeps tests edited since it', async () => {
    const { root, commit, map } = fixture();
    write(root, 'src/x.ts', `// one\n// two\n${lines(10)}`);
    write(root, 'tests/a.test.ts', "import '../src/x.js';\n// edited\n");
    git(root, 'commit', '-qam', 'base moved');
    const base = git(root, 'rev-parse', 'HEAD');
    // Map line 3 is now line 5.
    write(root, 'src/x.ts', `// one\n// two\n${lines(10).replace('line3 = 3', 'line3 = 30')}`);
    const input = gitInput(root, base, map);
    expect(input.stale).toEqual(new Set(['tests/a.test.ts']));
    const result = await decide({ map, ...input });
    expect(result.why).toEqual({ 'tests/a.test.ts': 'executes src/x.ts:3' });
    expect(commit).not.toBe(base);
  });

  it('runs everything when the map commit is not an ancestor, not in the clone, or the base is unknown', async () => {
    const { root, commit, map } = fixture();
    git(root, 'checkout', '-qb', 'side');
    write(root, 'src/x.ts', lines(11));
    git(root, 'commit', '-qam', 'side');
    const side = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', 'main');
    expect(gitInput(root, commit, { ...map, commit: side }).problems).toEqual([`the map's commit ${side.slice(0, 12)} is not an ancestor of the merge base`]);
    expect(gitInput(root, commit, { ...map, commit: 'f'.repeat(40) }).problems).toEqual(["the map's commit ffffffffffff is not in this clone"]);
    const unknown = gitInput(root, 'origin/nowhere', map);
    expect(unknown.problems).toEqual(['origin/nowhere has no merge base with HEAD in this clone']);
    expect(unknown.suite.size).toBe(2);
    expect((await decide({ map, ...unknown })).runAll).toBe(true);
  });
});

// ---- the real provider --------------------------------------------------------------------

describe('building a map with the real provider', () => {
  const run = (root: string, ...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });

  it('attributes executed lines to each test file and reports uncovered changed lines', { timeout: 120_000 }, () => {
    const root = repo();
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
    write(root, 'package.json', '{"name":"fixture","private":true,"type":"module"}\n');
    write(root, '.gitignore', 'node_modules\ncoverage-map.json\n');
    write(
      root,
      'vitest.config.mjs',
      "export default { test: { globals: true, include: ['tests/**/*.test.ts'], coverage: { include: ['src/**/*.ts'], exclude: ['src/c.ts'] } } };\n",
    );
    write(root, 'src/a.ts', "export const LABEL = 'a';\nexport function used(n: number) {\n  return n + 1;\n}\nexport function unused() {\n  return 'never';\n}\n");
    write(root, 'src/b.ts', "import { used } from './a.js';\n// a comment\nexport function twice(n: number) {\n  return used(used(n));\n}\n");
    write(root, 'src/c.ts', 'export const c = 3;\n');
    write(root, 'tests/a.test.ts', "import { used } from '../src/a.js';\nit('a', () => expect(used(1)).toBe(2));\n");
    write(root, 'tests/b.test.ts', "import { twice } from '../src/b.js';\nit('b', () => expect(twice(1)).toBe(3));\n");
    for (const name of ['c', 'c2', 'c3']) write(root, `tests/${name}.test.ts`, "import { c } from '../src/c.js';\nit('c', () => expect(c).toBe(3));\n");
    write(root, 'tests/static.test.ts', "it('static', () => expect(1).toBe(1));\n");
    write(root, 'tests/fails.test.ts', "import { used } from '../src/a.js';\nit('fails', () => expect(used(1)).toBe(3));\n");
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    const commit = git(root, 'rev-parse', 'HEAD');

    const built = run(root, 'build');
    // A failing test file fails the build, after the map is written.
    expect(built.status, built.stderr).toBe(1);
    const map = JSON.parse(readFileSync(join(root, 'coverage-map.json'), 'utf8'));
    expect(map).toMatchObject({ version: MAP_VERSION, commit, dirty: false, failed: ['tests/fails.test.ts'], unplaced: ['tests/static.test.ts'] });
    expect(Object.keys(map.tests).sort()).toEqual([
      'tests/a.test.ts',
      'tests/b.test.ts',
      'tests/c.test.ts',
      'tests/c2.test.ts',
      'tests/c3.test.ts',
      'tests/fails.test.ts',
      'tests/static.test.ts',
    ]);
    expect(map.tests['tests/a.test.ts']).toEqual({ 'src/a.ts': '1-4' });
    expect(map.tests['tests/b.test.ts']).toEqual({ 'src/a.ts': '1-4', 'src/b.ts': '1,3-5' });
    expect(map.tests['tests/static.test.ts']).toEqual({});
    // The comment on b.ts line 2 emits no code; unused() (5-7) never ran.
    expect(map.executable).toMatchObject({ 'src/a.ts': '1-7', 'src/b.ts': '1,3-5' });

    // Change code nobody runs, and code everyone runs.
    write(root, 'src/a.ts', "export const LABEL = 'a';\nexport function used(n: number) {\n  return n + 1;\n}\nexport function unused() {\n  return 'still never';\n}\n");
    const quiet = run(root, 'select', '--base', commit, '--json', '--report');
    expect(quiet.status, quiet.stderr).toBe(0);
    const report = JSON.parse(quiet.stdout);
    expect(report).toMatchObject({ runAll: false, selected: ['tests/fails.test.ts', 'tests/static.test.ts'] });
    expect(report.uncovered.files).toEqual([{ path: 'src/a.ts', measured: true, outsideFloor: false, changed: 1, uncovered: 1, lines: '6' }]);
    // The selected tests include one that fails; --run exits with vitest's status.
    expect(run(root, 'select', '--base', commit, '--run').status).toBe(1);

    write(root, 'src/c.ts', 'export const c = 3;\nexport const d = 4;\n');
    const floor = JSON.parse(run(root, 'select', '--base', commit, '--json', '--report').stdout);
    expect(floor.uncovered.files).toContainEqual({ path: 'src/c.ts', measured: true, outsideFloor: true, changed: 1, uncovered: 0, lines: '' });
  });
});
