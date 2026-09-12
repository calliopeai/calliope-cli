import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as config from '../src/config.js';
import { saveHooks } from '../src/hooks.js';
import {
  BrainAccess,
  BrainStore,
  BrainIndex,
  brainLines,
  initBrain,
  noteBrain,
  ingestBrainFile,
  queryBrain,
  commitBrain,
  editBrainEdge,
  linkBrain,
  runBrainCommand,
  sanitizeBrainValue,
  projectFile,
  parseBrainBundle,
} from '../src/brain/index.js';
import { fixture, entity, source, changes, append, emptyJournal } from './helpers/brain.js';
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
let f: ReturnType<typeof fixture>;
const options = () => ({ base: f.base, confirmation: 'none' as const });
beforeEach(() => {
  f = fixture();
  config.resetConfig();
  saveHooks([]);
});
afterEach(() => {
  f.clean();
  config.resetConfig();
  saveHooks([]);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('renders compact knowledge, graph, source and history views with bounded terminal previews', () => {
  const data = {
    entity: {
      id: 'a',
      kind: 'decision',
      name: 'Storage',
      state: 'accepted',
      effectiveState: 'stale',
      freshness: 'changed',
      summary: 'Needs review',
    },
    entities: [{ id: 'a', kind: 'decision', name: 'Storage' }],
    edges: [{ id: 'e', from: 'a', to: 'b', type: 'supports', state: 'proposed' }],
    sources: [{ id: 's', name: 'design.md', content: 'x'.repeat(4000) }],
    events: [{ id: 'event', at: '2026-09-12', actor: 'human', reason: 'Reviewed' }],
    revision: 'head',
    partial: true,
  };
  const text = brainLines('entity', data).join('\n');
  expect(text).toContain('Needs review');
  expect(text).toContain('a --supports--> b');
  expect(text).toContain('human · Reviewed');
  expect(text).toContain('source preview limited');
  expect(text).not.toContain('x'.repeat(3001));
  expect(brainLines('search', { entities: [] })).toContain('No matching knowledge.');
});
it('preserves committed knowledge if index replacement fails and recovers on a later read', async () => {
  await initBrain(f.cwd, options());
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('index.sqlite')) throw new Error('Disk failure');
    return rename(from, to);
  });
  const result = await noteBrain(f.cwd, 'Storage', 'Use SQLite', 'decision', options());
  expect(result.index).toBe('rebuild-required');
  expect(f.store.read().state.entities[result.entityId]?.summary).toBe('Use SQLite');
  vi.restoreAllMocks();
  expect((await queryBrain(f.cwd, 'search', { query: 'SQLite' }, options())).entities).toHaveLength(
    1,
  );
});
it('rechecks current secret material before releasing retained source content or record names', async () => {
  await initBrain(f.cwd, options());
  const secret = 'synthetic-eventual-private-value';
  fs.writeFileSync(join(f.cwd, 'design.md'), 'Architecture ' + secret);
  const ingested = await ingestBrainFile(f.cwd, 'design.md', options());
  config.setProviderCred('google', { apiKey: secret });
  expect(
    (await queryBrain(f.cwd, 'search', { query: 'Architecture' }, options())).entities,
  ).toEqual([]);
  await expect(
    queryBrain(f.cwd, 'entity', { query: ingested.entityId }, options()),
  ).rejects.toThrow('newly configured secret');
  config.resetConfig();
  const note = await noteBrain(f.cwd, secret, 'A proposal', 'decision', options());
  config.setProviderCred('google', { apiKey: secret });
  await expect(queryBrain(f.cwd, 'entity', { query: note.entityId }, options())).rejects.toThrow(
    'newly configured secret',
  );
  const value = sanitizeBrainValue({ list: [{ password: 'short', value: secret }], enabled: true });
  expect(value).toEqual({ list: [{ password: '[REDACTED]', value: '[REDACTED]' }], enabled: true });
  await expect(
    commitBrain(
      f.cwd,
      changes(entity(secret)),
      'human',
      'Do not retain secrets',
      f.store.read(),
      options(),
    ),
  ).rejects.toThrow('secret material');
});
it('keeps file-backed global knowledge within its source project and handles denied/cancelled/corrupt provenance', async () => {
  await initBrain(f.cwd, { ...options(), scope: 'global' });
  fs.writeFileSync(join(f.cwd, 'design.md'), 'Architecture');
  const added = await ingestBrainFile(f.cwd, 'design.md', { ...options(), scope: 'global' }),
    record = added.state.entities[added.entityId]!;
  const other = join(f.root, 'other');
  fs.mkdirSync(other);
  await expect(
    new BrainAccess(other, added.state.sources, options()).record(record),
  ).rejects.toThrow('another project');
  const access = new BrainAccess(f.cwd, added.state.sources, options());
  await expect(access.source('missing')).rejects.toThrow('source is missing');
  await expect(
    access.visible({ ...record, provenance: [{ sourceId: 'missing', basis: 'observed' }] }),
  ).rejects.toThrow('source is missing');
  await expect(
    new BrainAccess(f.cwd, added.state.sources, {
      ...options(),
      signal: AbortSignal.abort(),
    }).visible(record),
  ).rejects.toThrow();
  fs.linkSync(join(f.cwd, 'design.md'), join(f.root, 'shared'));
  expect(await access.visible(record)).toBeNull();
});
it('detects directory replacement and invalid query and review controls', async () => {
  fs.mkdirSync(join(f.cwd, 'docs'));
  fs.writeFileSync(join(f.cwd, 'docs/design.md'), 'Architecture');
  const target = projectFile(f.cwd, 'docs/design.md');
  fs.renameSync(join(f.cwd, 'docs'), join(f.cwd, 'old-docs'));
  fs.mkdirSync(join(f.cwd, 'docs'));
  fs.writeFileSync(join(f.cwd, 'docs/design.md'), 'Replacement');
  expect(target.recheck).toThrow('Source path changed');
  await initBrain(f.cwd, options());
  const a = await noteBrain(f.cwd, 'A', 'First', 'decision', options()),
    b = await noteBrain(f.cwd, 'B', 'Second', 'decision', options());
  await expect(
    linkBrain(f.cwd, a.entityId, b.entityId, 'bad type', a.sourceId, options()),
  ).rejects.toThrow('identifier');
  const linked = await linkBrain(f.cwd, a.entityId, b.entityId, 'supports', a.sourceId, options());
  await expect(
    editBrainEdge(f.cwd, 'missing', { state: 'accepted' }, 'Review', options()),
  ).rejects.toThrow('Unknown relationship');
  await expect(editBrainEdge(f.cwd, linked.edgeId, {}, 'Review', options())).rejects.toThrow(
    'requires',
  );
  await expect(queryBrain(f.cwd, 'search', { query: 'A', limit: 0 }, options())).rejects.toThrow(
    '1–100',
  );
  await expect(
    queryBrain(f.cwd, 'search', { query: 'A', kind: 'invalid' as never }, options()),
  ).rejects.toThrow('kind');
  await expect(queryBrain(f.cwd, 'neighbors', {}, options())).rejects.toThrow('starting');
  expect((await queryBrain(f.cwd, 'decisions', { limit: 1 }, options())).entities).toHaveLength(1);
  expect(
    (await queryBrain(f.cwd, 'neighbors', { from: a.entityId, limit: 1 }, options())).edges,
  ).toHaveLength(1);
  expect((await queryBrain(f.cwd, 'graph', { limit: 1 }, options())).entities).toHaveLength(1);
});
it('rejects a foreign journal and alias, and preserves history when retention/review bounds fail', async () => {
  await f.store.init();
  await expect(f.store.append([], 'human', 'Empty transaction')).rejects.toThrow('record count');
  const other = join(f.root, 'other');
  fs.mkdirSync(other);
  const foreign = new BrainStore(other, 'project', f.base);
  await foreign.init();
  fs.copyFileSync(join(foreign.root, 'history.json'), join(f.store.root, 'history.json'));
  expect(() => f.store.read()).toThrow('another project');
  const alias = join(f.root, 'alias');
  fs.symlinkSync(f.base, alias);
  expect(() => new BrainStore(f.cwd, 'project', alias)).toThrow('aliases');
  const invalid = append(emptyJournal(), changes(entity()));
  invalid.header.scope = 'project';
  invalid.header.project = { root: f.cwd, key: 'bad' };
  expect(() =>
    parseBrainBundle({
      version: 1,
      kind: 'calliope.brain',
      journal: invalid,
      checksum: '0'.repeat(64),
    }),
  ).toThrow();
});
it('reports invalid and policy-denied terminal invocations without exposing internal exceptions', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  expect(await runBrainCommand(['unknown'], { cwd: f.cwd, base: f.base })).toBe(2);
  expect(write).toHaveBeenCalledWith(expect.stringContaining('calliope brain'));
  expect(await runBrainCommand(['init'], { cwd: f.cwd, base: f.base })).toBe(3);
  expect(write).toHaveBeenLastCalledWith(expect.stringContaining('denied by current policy'));
  expect(
    await runBrainCommand(
      Array.from({ length: 65 }, () => ''),
      { cwd: f.cwd, base: f.base },
    ),
  ).toBe(2);
});
