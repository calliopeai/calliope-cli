import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as config from '../src/config.js';
import { saveHooks } from '../src/hooks.js';
import { runBrainCommand } from '../src/brain/index.js';
import { fixture } from './helpers/brain.js';
import { simulateWindowsDirectoryFsyncDenial } from './helpers/windows-fsync.js';
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
let f: ReturnType<typeof fixture>;
let lines: string[] = [];
beforeEach(() => {
  f = fixture();
  lines = [];
  config.resetConfig();
  saveHooks([]);
});
afterEach(() => {
  f.clean();
  config.resetConfig();
  saveHooks([]);
  vi.restoreAllMocks();
});
const call = (args: string[], extra: Parameters<typeof runBrainCommand>[1] = {}) => {
  lines = [];
  return runBrainCommand(args, { cwd: f.cwd, base: f.base, write: (l) => lines.push(l), ...extra });
};
const data = () => JSON.parse(lines.at(-1)!).data;
it('allows brain init/ingest mutations on Windows instead of denying them (#382)', async () => {
  const restore = simulateWindowsDirectoryFsyncDenial();
  try {
    expect(await call(['init', '--json'])).toBe(3);
    expect(JSON.parse(lines[0]!).error.code).toBe('policy-denied');
    expect(await call(['init', '--allow-mutations', '--json'])).toBe(0);
    expect(data().scope).toBe('project');
    fs.writeFileSync(join(f.cwd, 'design.md'), 'Architecture uses SQLite');
    expect(await call(['ingest', 'design.md', '--allow-mutations', '--json'])).toBe(0);
    expect(data().entityId).toBeTruthy();
    expect(await call(['search', 'SQLite', '--json'])).toBe(0);
    expect(data().entities).toHaveLength(1);
  } finally {
    restore();
  }
});
it('provides stable local JSON with safe defaults, compact mutation receipts and restartable search', async () => {
  expect(await call(['init', '--json'])).toBe(3);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    version: 1,
    type: 'brain',
    action: 'init',
    localOnly: true,
    error: { code: 'policy-denied' },
  });
  expect(await call(['init', '--allow-mutations', '--json'])).toBe(0);
  expect(data().scope).toBe('project');
  fs.writeFileSync(join(f.cwd, 'design.md'), 'Architecture uses SQLite');
  expect(await call(['ingest', 'design.md', '--allow-mutations', '--json'])).toBe(0);
  const id = data().entityId;
  expect(data().journal).toBeUndefined();
  expect(data().state).toBeUndefined();
  expect(await call(['search', 'SQLite', '--json'])).toBe(0);
  expect(data().entities[0].id).toBe(id);
  expect(await call(['entity', id, '--json'])).toBe(0);
  expect(data().sources[0].content).toContain('SQLite');
  expect(await call(['status'])).toBe(0);
  expect(lines.join('')).toContain('Brain status');
});
it('supports note/review/link/graph/reversal, export/import, freshness and reindex controls', async () => {
  await call(['init', '--allow-mutations']);
  await call([
    'note',
    'Storage',
    'Choose SQLite',
    '--kind',
    'decision',
    '--allow-mutations',
    '--json',
  ]);
  const a = data().entityId,
    source = data().sourceId;
  await call(['note', 'Memory', 'Keep bounded', '--kind', 'risk', '--allow-mutations', '--json']);
  const b = data().entityId;
  expect(
    await call([
      'edit',
      a,
      '--name',
      'Portable storage',
      '--summary',
      'Use SQLite',
      '--state',
      'accepted',
      '--confidence',
      '0.9',
      '--reason',
      'Reviewed',
      '--allow-mutations',
      '--json',
    ]),
  ).toBe(0);
  expect(
    await call(['link', a, b, 'introduces', '--source', source, '--allow-mutations', '--json']),
  ).toBe(0);
  const edgeEvent = data().eventId,
    edgeId = data().edgeId;
  expect(
    await call([
      'edit-edge',
      edgeId,
      '--state',
      'accepted',
      '--confidence',
      '1',
      '--reason',
      'Source reviewed',
      '--allow-mutations',
      '--json',
    ]),
  ).toBe(0);
  const reviewEvent = data().eventId;
  expect(
    await call([
      'reverse',
      reviewEvent,
      '--reason',
      'Withdraw review',
      '--allow-mutations',
      '--json',
    ]),
  ).toBe(0);
  expect(
    await call(['graph', a, '--limit', '10', '--include-rejected', '--json'], { kg: true }),
  ).toBe(0);
  expect(data().edges).toHaveLength(1);
  expect(await call(['path', a, b, '--direction', 'out', '--depth', '2', '--json'])).toBe(0);
  expect(data().found).toBe(true);
  expect(
    await call([
      'reverse',
      edgeEvent,
      '--reason',
      'Relationship withdrawn',
      '--allow-mutations',
      '--json',
    ]),
  ).toBe(1);
  for (const action of ['decisions', 'risks', 'history', 'neighbors'])
    expect(await call([action, ...(action === 'neighbors' ? [a] : []), '--json'])).toBe(0);
  expect(await call(['export', 'copy.json', '--allow-mutations', '--json'])).toBe(0);
  expect(await call(['init', '--global', '--allow-mutations'])).toBe(0);
  expect(await call(['import', 'copy.json', '--global', '--allow-mutations', '--json'])).toBe(0);
  for (const action of ['refresh', 'reindex'])
    expect(await call([action, '--allow-mutations', '--json'])).toBe(0);
});
it.each([
  ['wat'],
  ['note'],
  ['status', 'extra'],
  ['edit', 'id'],
  ['edit', 'id', '--reason', 'x'],
  ['link', 'a', 'b', 'uses'],
  ['note', 'a', 'b', '--kind', 'unknown', '--allow-mutations'],
  ['reverse', 'id'],
  ['search', 'a', '--depth', '1'],
  ['status', '--unknown'],
  ['path', 'a'],
  ['search', '\u001b'],
  ['search', 'x'.repeat(16385)],
])('rejects malformed or inapplicable arguments: %j', async (args) => {
  await call(['init', '--allow-mutations']);
  expect(await call([...args, '--json'])).toBe(2);
  expect(JSON.parse(lines.at(-1)!).error.code).toBe('invalid');
});
it('returns cancellation/failure codes and constrains KG aliases', async () => {
  expect(await call(['status', '--json'])).toBe(1);
  expect(await call(['init', '--json'], { kg: true })).toBe(2);
  expect(await call(['status', '--json'], { signal: AbortSignal.abort() })).toBe(130);
  expect(JSON.parse(lines[0]!).error.code).toBe('cancelled');
  await call(['init', '--allow-mutations']);
  expect(await call(['--json'], { kg: true })).toBe(0);
  expect(data().entities).toEqual([]);
  fs.writeFileSync(join(f.store.root, 'history.json'), '{');
  expect(await call(['status', '--json'])).toBe(1);
  expect(JSON.parse(lines.at(-1)!).error.message).not.toContain('SyntaxError');
});
