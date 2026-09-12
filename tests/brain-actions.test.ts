import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as config from '../src/config.js';
import * as hooks from '../src/hooks.js';
import { RunLog } from '../src/runlog.js';
import {
  initBrain,
  ingestBrainFile,
  noteBrain,
  editBrain,
  linkBrain,
  reverseBrain,
  refreshBrain,
  reindexBrain,
  queryBrain,
  exportBrain,
  importBrain,
  parseBrainBundle,
  BrainStore,
  sanitizeBrainText,
} from '../src/brain/index.js';
import { fixture, changes, entity } from './helpers/brain.js';
let f: ReturnType<typeof fixture>;
const opts = () => ({ base: f.base, confirmation: 'none' as const });
beforeEach(() => {
  f = fixture();
  config.resetConfig();
  hooks.saveHooks([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Brain must be local-only.');
    }),
  );
});
afterEach(() => {
  f.clean();
  config.resetConfig();
  hooks.saveHooks([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('requires mutation approval and current policy, with no source or partial state written on denial', async () => {
  await expect(initBrain(f.cwd, { base: f.base })).rejects.toThrow('denied');
  expect(fs.existsSync(f.store.root)).toBe(false);
  await initBrain(f.cwd, opts());
  fs.writeFileSync(join(f.cwd, 'source.md'), 'Architecture uses portable SQLite.');
  const before = f.store.read();
  await expect(ingestBrainFile(f.cwd, 'source.md', { base: f.base })).rejects.toThrow('denied');
  expect(f.store.read()).toEqual(before);
  const denied = vi
    .spyOn(hooks, 'checkHooksAllow')
    .mockResolvedValue({ allowed: false, reason: 'Current policy forbids knowledge writes' });
  await expect(noteBrain(f.cwd, 'Secret change', 'A proposal', 'decision', opts())).rejects.toThrow(
    'denied',
  );
  expect(f.store.read()).toEqual(before);
  denied.mockRestore();
  await expect(
    noteBrain(f.cwd, 'Plan mutation', 'A proposal', 'decision', { ...opts(), mode: 'plan' }),
  ).rejects.toThrow('denied');
});
it('ingests sanitized UTF-8 source snapshots without changing source files and returns useful indexed knowledge', async () => {
  await initBrain(f.cwd, opts());
  const secret = 'example-exact-private-credential',
    content = 'Architecture uses portable SQLite.\nvalue=' + secret;
  vi.stubEnv('TEST_API_KEY', secret);
  fs.writeFileSync(join(f.cwd, 'source.md'), content);
  const result = await ingestBrainFile(f.cwd, 'source.md', opts());
  expect(fs.readFileSync(join(f.cwd, 'source.md'), 'utf8')).toBe(content);
  expect(result.state.sources[result.sourceId]?.content).not.toContain(secret);
  expect(result.state.sources[result.sourceId]?.redacted).toBe(true);
  expect((await ingestBrainFile(f.cwd, 'source.md', opts())).unchanged).toBe(true);
  expect(f.store.read().journal.events).toHaveLength(1);
  const found = await queryBrain(f.cwd, 'search', { query: 'portable SQLite' }, opts());
  expect(found.entities).toHaveLength(1);
  const detail = await queryBrain(f.cwd, 'entity', { query: result.entityId }, opts());
  expect(detail.entity).toMatchObject({ effectiveState: 'accepted', freshness: 'current' });
  expect(detail.sources?.[0]?.originalHash).not.toBe(detail.sources?.[0]?.contentHash);
  expect(fetch).not.toHaveBeenCalled();
});
it('detects changed and missing sources, explicitly records stale knowledge and retains reversible history', async () => {
  await initBrain(f.cwd, opts());
  fs.mkdirSync(join(f.cwd, 'docs'));
  const path = join(f.cwd, 'docs/source.md');
  fs.writeFileSync(path, 'Original architecture.');
  const first = await ingestBrainFile(f.cwd, 'docs/source.md', opts());
  fs.writeFileSync(path, 'Revised architecture.');
  expect(
    (await queryBrain(f.cwd, 'entity', { query: first.entityId }, opts())).entity,
  ).toMatchObject({ state: 'accepted', effectiveState: 'stale', freshness: 'changed' });
  expect(f.store.read().journal.events).toHaveLength(1);
  const refreshed = await refreshBrain(f.cwd, opts());
  expect(refreshed.state.entities[first.entityId]?.state).toBe('stale');
  expect((await refreshBrain(f.cwd, opts())).index).toBe('unchanged');
  await reverseBrain(f.cwd, refreshed.journal.events.at(-1)!.id, 'Revert stale marker', opts());
  expect(f.store.read().state.entities[first.entityId]?.state).toBe('accepted');
  const updated = await ingestBrainFile(f.cwd, 'docs/source.md', opts());
  expect(updated.sourceId).not.toBe(first.sourceId);
  expect(Object.keys(updated.state.sources)).toHaveLength(2);
  fs.rmSync(join(f.cwd, 'docs'), { recursive: true });
  expect(
    (await queryBrain(f.cwd, 'entity', { query: first.entityId }, opts())).entity,
  ).toMatchObject({ freshness: 'missing', effectiveState: 'stale' });
});
it('does not let retained content bypass newly denied source paths or changed project identities', async () => {
  await initBrain(f.cwd, opts());
  fs.writeFileSync(join(f.cwd, 'source.md'), 'Restricted architecture');
  const ingested = await ingestBrainFile(f.cwd, 'source.md', opts());
  const hook = vi.spyOn(hooks, 'checkHooksAllow').mockImplementation(async (_event, context) => ({
    allowed: !(context.toolArgs as { operation?: string })?.operation?.includes('retained-source'),
  }));
  expect((await queryBrain(f.cwd, 'search', { query: 'Restricted' }, opts())).entities).toEqual([]);
  await expect(queryBrain(f.cwd, 'entity', { query: ingested.entityId }, opts())).rejects.toThrow(
    'denied',
  );
  await expect(exportBrain(f.cwd, 'copy.json', opts())).rejects.toThrow('denied');
  hook.mockRestore();
  fs.unlinkSync(join(f.cwd, 'source.md'));
  fs.symlinkSync(join(f.root, 'external'), join(f.cwd, 'source.md'));
  fs.writeFileSync(join(f.root, 'external'), 'Restricted outside scope');
  expect((await queryBrain(f.cwd, 'search', { query: 'Restricted' }, opts())).entities).toEqual([]);
});
it('rejects secret paths, aliases, binary input and source changes during approval', async () => {
  await initBrain(f.cwd, opts());
  fs.writeFileSync(join(f.cwd, '.env'), 'API_KEY=private');
  await expect(ingestBrainFile(f.cwd, '.env', opts())).rejects.toThrow('denied');
  await expect(ingestBrainFile(f.cwd, '../outside', opts())).rejects.toThrow('inside');
  fs.writeFileSync(join(f.cwd, 'binary'), Buffer.from([0xff, 0xff]));
  await expect(ingestBrainFile(f.cwd, 'binary', opts())).rejects.toThrow('UTF-8');
  fs.writeFileSync(join(f.cwd, 'source.md'), 'Original');
  fs.linkSync(join(f.cwd, 'source.md'), join(f.cwd, 'shared.md'));
  await expect(ingestBrainFile(f.cwd, 'shared.md', opts())).rejects.toThrow('hard-linked');
  fs.unlinkSync(join(f.cwd, 'shared.md'));
  await expect(
    ingestBrainFile(f.cwd, 'source.md', {
      base: f.base,
      approve: async () => {
        fs.writeFileSync(join(f.cwd, 'source.md'), 'Changed during review');
        return 'allow';
      },
    }),
  ).rejects.toThrow('Source content changed');
  expect(f.store.read().journal.events).toHaveLength(0);
});
it('records proposals, human corrections and inferred relationships with evidence, then traverses the graph', async () => {
  await initBrain(f.cwd, opts());
  const a = await noteBrain(f.cwd, 'SQLite', 'Use portable storage.', 'decision', opts()),
    b = await noteBrain(f.cwd, 'Memory', 'Bound database size.', 'risk', opts()),
    c = await noteBrain(f.cwd, 'Index', 'Index source records.', 'requirement', opts());
  expect(a.state.entities[a.entityId]?.state).toBe('proposed');
  const accepted = await editBrain(
    f.cwd,
    a.entityId,
    { state: 'accepted', confidence: 0.9 },
    'Reviewed upstream documentation.',
    opts(),
  );
  expect(accepted.state.entities[a.entityId]?.state).toBe('accepted');
  await expect(editBrain(f.cwd, a.entityId, {}, 'Missing correction', opts())).rejects.toThrow(
    'requires',
  );
  const linked = await linkBrain(f.cwd, a.entityId, b.entityId, 'introduces', a.sourceId, opts());
  await linkBrain(f.cwd, b.entityId, c.entityId, 'mitigated_by', b.sourceId, opts());
  await linkBrain(f.cwd, c.entityId, a.entityId, 'supports', c.sourceId, opts());
  expect(linked.state.edges[linked.edgeId]).toMatchObject({
    state: 'proposed',
    provenance: [{ sourceId: a.sourceId, basis: 'inferred' }],
  });
  expect(
    (await queryBrain(f.cwd, 'neighbors', { from: a.entityId }, opts())).entities,
  ).toHaveLength(2);
  expect(
    (
      await queryBrain(
        f.cwd,
        'path',
        { from: a.entityId, to: c.entityId, direction: 'out' },
        opts(),
      )
    ).edges,
  ).toHaveLength(2);
  expect(
    (
      await queryBrain(
        f.cwd,
        'path',
        { from: a.entityId, to: c.entityId, direction: 'out', depth: 1 },
        opts(),
      )
    ).found,
  ).toBe(false);
  expect(
    (await queryBrain(f.cwd, 'path', { from: a.entityId, to: a.entityId, depth: 0 }, opts())).found,
  ).toBe(true);
  expect((await queryBrain(f.cwd, 'graph', {}, opts())).entities).toHaveLength(3);
  expect((await queryBrain(f.cwd, 'decisions', {}, opts())).entities).toHaveLength(1);
  expect((await queryBrain(f.cwd, 'risks', {}, opts())).entities).toHaveLength(1);
  await expect(
    queryBrain(f.cwd, 'path', { from: a.entityId, to: b.entityId, depth: 99 }, opts()),
  ).rejects.toThrow('0–16');
  expect((await queryBrain(f.cwd, 'status', {}, opts())).entities).toBe(3);
  expect((await queryBrain(f.cwd, 'history', { limit: 2 }, opts())).events).toHaveLength(2);
  expect((await reindexBrain(f.cwd, opts())).index).toBe('current');
});
it('transfers provenance without importing acceptance or overwriting human corrections', async () => {
  await initBrain(f.cwd, opts());
  const note = await noteBrain(f.cwd, 'Architecture', 'Choose SQLite.', 'decision', opts());
  await editBrain(f.cwd, note.entityId, { state: 'accepted' }, 'Reviewed', opts());
  const exported = await exportBrain(f.cwd, 'brain.json', opts());
  expect(fs.statSync(exported.path).mode & 0o777).toBe(0o600);
  await expect(exportBrain(f.cwd, 'brain.json', opts())).rejects.toThrow();
  await initBrain(f.cwd, { ...opts(), scope: 'global' });
  const imported = await importBrain(f.cwd, 'brain.json', { ...opts(), scope: 'global' });
  expect(Object.values(imported.state.entities)[0]?.state).toBe('proposed');
  expect(Object.values(imported.state.entities)[0]?.origins?.[0]).toMatchObject({
    brainId: note.state.header.id,
    recordId: note.entityId,
    state: 'accepted',
  });
  expect(Object.values(imported.state.sources)[0]?.origins?.[0]).toMatchObject({
    brainId: note.state.header.id,
    sourceKind: 'human',
  });
  expect(Object.values(imported.state.sources).every((s) => s.kind === 'import')).toBe(true);
  expect(imported.state.header.scope).toBe('global');
  expect((await importBrain(f.cwd, 'brain.json', { ...opts(), scope: 'global' })).imported).toBe(0);
  const id = Object.keys(imported.state.entities)[0]!;
  expect(
    (await queryBrain(f.cwd, 'entity', { query: id }, { ...opts(), scope: 'global' })).entity
      ?.freshness,
  ).toBe('unverified');
  await editBrain(f.cwd, id, { summary: 'Local correction' }, 'Corrected after review', {
    ...opts(),
    scope: 'global',
  });
  await expect(importBrain(f.cwd, 'brain.json', { ...opts(), scope: 'global' })).rejects.toThrow(
    'local correction',
  );
  const bundle = JSON.parse(fs.readFileSync(exported.path, 'utf8'));
  bundle.checksum = '0'.repeat(64);
  expect(() => parseBrainBundle(bundle)).toThrow('checksum');
  expect(() => parseBrainBundle({ ...bundle, version: 99 })).toThrow('schema');
  fs.writeFileSync(join(f.cwd, 'broken.json'), '{');
  await expect(importBrain(f.cwd, 'broken.json', opts())).rejects.toThrow('JSON export');
});
it('atomically imports more than one event batch and preserves all entities on restart', async () => {
  await initBrain(f.cwd, opts());
  await f.store.append(
    changes(...Array.from({ length: 260 }, (_, i) => entity('e' + i))),
    'human',
    'Many records',
  );
  expect(f.store.read().journal.events).toHaveLength(2);
  await exportBrain(f.cwd, 'large.json', opts());
  await initBrain(f.cwd, { ...opts(), scope: 'global' });
  const result = await importBrain(f.cwd, 'large.json', { ...opts(), scope: 'global' });
  expect(result.imported).toBe(261);
  expect(Object.keys(new BrainStore(f.cwd, 'global', f.base).read().state.entities)).toHaveLength(
    260,
  );
});
it('redacts complete private key blocks, configured credentials and audit arguments', async () => {
  const secret = 'synthetic-private-secret-value';
  config.setProviderCred('google', { apiKey: secret });
  expect(
    sanitizeBrainText(
      '-----BEGIN RSA PRIVATE KEY-----\nprivatebody\n-----END RSA PRIVATE KEY-----',
    ),
  ).not.toContain('privatebody');
  expect(sanitizeBrainText(secret)).toBe('[REDACTED]');
  const log = RunLog.open('brain-audit-test'),
    options = { ...opts(), runlog: log };
  await initBrain(f.cwd, options);
  await noteBrain(f.cwd, 'Credentials', secret, 'risk', options);
  await log.flush();
  const audit = fs.readFileSync(log.filePath, 'utf8');
  expect(audit).not.toContain(secret);
  expect(audit).toContain('brain_write');
  expect(JSON.stringify(f.store.read().journal)).not.toContain(secret);
});
it('cancels ingestion before mutation and retains the old journal', async () => {
  await initBrain(f.cwd, opts());
  fs.writeFileSync(join(f.cwd, 'doc.md'), 'Architecture');
  const before = f.store.read(),
    controller = new AbortController();
  await expect(
    ingestBrainFile(f.cwd, 'doc.md', {
      base: f.base,
      signal: controller.signal,
      approve: async () => {
        controller.abort();
        return 'allow';
      },
    }),
  ).rejects.toThrow();
  expect(f.store.read()).toEqual(before);
});
