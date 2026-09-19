import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as config from '../src/config.js';
import * as hooks from '../src/hooks.js';
import { fixture } from './helpers/brain.js';
import {
  initBrain,
  importKnowledgeGraph,
  editBrain,
  noteBrain,
  queryBrain,
  makeExchange,
  BrainError,
  BrainTransferError,
  type PortableKnowledgeGraph,
} from '../src/brain/index.js';
let f: ReturnType<typeof fixture>;
const opts = () => ({
  base: f.base,
  confirmation: 'none' as const,
  origin: 'product:sample',
  allowLoss: true,
});
const graph = (): PortableKnowledgeGraph => ({
  format: 'calliope-kg/v1',
  nodes: [
    {
      id: 'same',
      name: 'Design',
      type: 'decision',
      props: {
        confidence: 0.7,
        state: 'accepted',
        createdAt: '2025-01-02T00:00:00.000Z',
        attributes: { nested: { rating: 7 }, externalId: 'cannot-override' },
        evidence: {
          original: {
            uri: 'https://foreign.invalid/private.wav',
            locator: { start: 2.5, end: 8.1 },
          },
          basis: 'inferred',
        },
      },
    },
    {
      id: 'second',
      name: 'Storage',
      type: 'component',
      props: { confidence: 'unknown' },
    },
  ],
  edges: [
    {
      source: 'same',
      target: 'second',
      type: 'supports',
      props: { id: 'same', confidence: 0.3 },
    },
  ],
});
const write = (value: unknown = graph(), path = 'graph.json') =>
  fs.writeFileSync(join(f.cwd, path), JSON.stringify(value));
beforeEach(async () => {
  f = fixture();
  config.resetConfig();
  hooks.saveHooks([]);
  await initBrain(f.cwd, opts());
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Transfers must not fetch foreign locators.');
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
it('previews losses and stable mappings without any journal or index write', async () => {
  write();
  const before = f.store.read(),
    files = fs.readdirSync(f.store.root);
  const preview = await importKnowledgeGraph(f.cwd, 'graph.json', {
    ...opts(),
    preview: true,
  });
  expect(preview.report.losses.map((loss) => loss.code)).toEqual(
    expect.arrayContaining([
      'unsupported-kind',
      'source-only-attributes',
      'unknown-confidence',
      'graph-history',
      'local-review',
    ]),
  );
  expect(preview.report.mappings.map((mapping) => mapping.status)).toEqual(['new', 'new', 'new']);
  expect(preview.report.mappings[0]!.localId).not.toBe(preview.report.mappings[2]!.localId);
  expect(f.store.read()).toEqual(before);
  expect(fs.readdirSync(f.store.root)).toEqual(files);
  await expect(
    importKnowledgeGraph(f.cwd, 'graph.json', { ...opts(), allowLoss: false }),
  ).rejects.toBeInstanceOf(BrainTransferError);
  expect(f.store.read()).toEqual(before);
});
it('retains nested claims and timestamps, proposes inferred knowledge and exposes it through SQLite', async () => {
  write();
  const result = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  const node = result.state.entities[result.report.mappings[0]!.localId]!;
  expect(node.state).toBe('proposed');
  expect(node.provenance.every((p) => p.basis === 'inferred')).toBe(true);
  expect(node.attributes).toEqual({
    externalId: 'same',
    externalType: 'decision',
  });
  const claim = JSON.parse(result.state.sources[node.provenance[0]!.sourceId]!.content);
  expect(claim.record).toEqual(graph().nodes[0]);
  expect(result.index).toBe('current');
  const found = await queryBrain(f.cwd, 'entity', { query: node.id }, opts());
  expect(found.entity).toMatchObject({ id: node.id, freshness: 'unverified' });
  expect(found.sources?.some((s) => JSON.parse(s.content).record?.props.evidence)).toBe(true);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('retries are idempotent across alias, whitespace and local transfer file changes', async () => {
  write();
  const first = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  const alias = { ...graph(), format: 'conflict-kg/v1' };
  fs.writeFileSync(join(f.cwd, 'copy.json'), JSON.stringify(alias, null, 4));
  const again = await importKnowledgeGraph(f.cwd, 'copy.json', {
    ...opts(),
    allowLoss: false,
  });
  expect(again.unchanged).toBe(true);
  expect(again.imported).toBe(0);
  expect(again.state).toEqual(first.state);
  expect(again.report.mappings.every((m) => m.status === 'unchanged')).toBe(true);
});
it('rechecks retained source access even on an exact retry or preview', async () => {
  write();
  await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  const deny = () => {
    throw new BrainError('policy-denied', 'Source revoked');
  };
  for (const preview of [false, true])
    await expect(
      importKnowledgeGraph(f.cwd, 'graph.json', {
        ...opts(),
        preview,
        authorizeSource: deny,
      }),
    ).rejects.toThrow('revoked');
});
it('preserves local corrections until an explicit current-revision reconciliation', async () => {
  write();
  const first = await importKnowledgeGraph(f.cwd, 'graph.json', opts()),
    id = first.report.mappings[0]!.localId;
  await editBrain(
    f.cwd,
    id,
    { summary: 'Human correction', state: 'accepted' },
    'Reviewed evidence',
    opts(),
  );
  const preview = await importKnowledgeGraph(f.cwd, 'graph.json', {
    ...opts(),
    preview: true,
  });
  expect(preview.report.conflicts).toBe(1);
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toMatchObject({
    code: 'conflict',
  });
  await expect(
    importKnowledgeGraph(f.cwd, 'graph.json', {
      ...opts(),
      reconcileRevision: first.state.revision,
    }),
  ).rejects.toThrow('stale');
  const reconciled = await importKnowledgeGraph(f.cwd, 'graph.json', {
    ...opts(),
    reconcileRevision: preview.state.revision,
  });
  expect(reconciled.state.entities[id]!.summary).toBe('Design');
  expect(reconciled.state.entities[id]!.state).toBe('proposed');
  expect(reconciled.journal.events.at(-1)!.actor).toBe('import');
});
it('uses stable identities for successor revisions but reports changed source claims', async () => {
  write();
  const first = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  const next = graph();
  next.nodes[0]!.props.evidence = { locator: 'successor', basis: 'inferred' };
  write(next);
  const preview = await importKnowledgeGraph(f.cwd, 'graph.json', {
    ...opts(),
    preview: true,
  });
  expect(preview.report.mappings.map((m) => m.localId)).toEqual(
    first.report.mappings.map((m) => m.localId),
  );
  expect(preview.report.conflicts).toBeGreaterThan(0);
  const result = await importKnowledgeGraph(f.cwd, 'graph.json', {
    ...opts(),
    reconcileRevision: preview.state.revision,
  });
  expect(Object.keys(result.state.entities)).toHaveLength(2);
  expect(Object.keys(result.state.edges)).toHaveLength(1);
  expect(Object.keys(result.state.sources).length).toBeGreaterThan(
    Object.keys(first.state.sources).length,
  );
});
it('requires explicit reconciliation to restore a local deletion', async () => {
  write();
  const first = await importKnowledgeGraph(f.cwd, 'graph.json', opts()),
    id = first.report.mappings[2]!.localId;
  await f.store.append(
    [
      {
        kind: 'edge',
        id,
        expected: first.state.edges[id]!.revision,
        value: null,
      },
    ],
    'human',
    'Remove relationship',
  );
  const preview = await importKnowledgeGraph(f.cwd, 'graph.json', {
    ...opts(),
    preview: true,
  });
  expect(preview.report.mappings[2]!.status).toBe('deleted');
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow('deletions');
  const result = await importKnowledgeGraph(f.cwd, 'graph.json', {
    ...opts(),
    reconcileRevision: preview.state.revision,
  });
  expect(result.state.edges[id]).toBeDefined();
});
it('rejects ambiguous parallel edges and duplicate explicit edge IDs', async () => {
  const value = graph();
  value.edges[0]!.props = { confidence: 1 };
  value.edges.push(structuredClone(value.edges[0]!));
  write(value);
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow('Parallel');
  value.edges.forEach((e) => (e.props.id = 'shared'));
  write(value);
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow('Duplicate');
  value.edges[1]!.props.id = 'second-edge';
  write(value);
  const result = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  expect(Object.keys(result.state.edges)).toHaveLength(2);
});
it('never clamps invalid confidence or narrows invalid relationship types', async () => {
  for (const confidence of [-0.1, 1.1, 'certain']) {
    const value = graph();
    value.nodes[0]!.props.confidence = confidence;
    write(value);
    await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow(
      'never clamped',
    );
  }
  const value = graph();
  value.edges[0]!.type = 'not a native identifier';
  write(value);
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow(
    'identifier grammar',
  );
  expect(f.store.read().journal.events).toHaveLength(0);
});
it('fails atomically for oversized snapshots instead of truncating claims', async () => {
  const value = graph();
  value.nodes[0]!.props.large = 'x'.repeat(128 * 1024);
  write(value);
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow('oversized');
  expect(f.store.read().journal.events).toHaveLength(0);
});
it('retains the core v2 fixture and manifest as source claims through the indexed view', async () => {
  const fixture = fs.readFileSync(
    new URL('./fixtures/brain-interchange/exchange-v2.json', import.meta.url),
    'utf8',
  );
  fs.writeFileSync(join(f.cwd, 'core.json'), fixture);
  const result = await importKnowledgeGraph(f.cwd, 'core.json', {
    ...opts(),
    origin: undefined,
  });
  const original = JSON.parse(fixture),
    metadata = JSON.parse(result.state.sources[result.report.metadataSourceId!]!.content);
  expect(metadata.manifest).toEqual(original.manifest);
  expect(result.report.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  const id = result.report.mappings[0]!.localId,
    query = await queryBrain(f.cwd, 'entity', { query: id }, opts());
  const source = query.sources!.find((source) => JSON.parse(source.content).record);
  expect(JSON.parse(source!.content).record.props.data).toEqual(
    original.payload.nodes[0].props.data,
  );
});
it('retains compiled envelopes and never activates manifest grants', async () => {
  write(
    makeExchange(
      {
        meta: { version: '1', title: 'A product brain' },
        registry: { terms: ['x'] },
        nodes: [
          {
            id: 'decision:a',
            kind: 'decision',
            title: 'A',
            data: { evidence: ['source:a'] },
          },
        ],
        edges: [],
      },
      { id: 'product:sample', revision: 'v1' },
      { capabilities: ['write'], grants: ['everything'] },
    ),
  );
  const before = f.store.read();
  await expect(
    importKnowledgeGraph(f.cwd, 'graph.json', {
      base: f.base,
      allowLoss: true,
    }),
  ).rejects.toThrow('denied');
  expect(f.store.read()).toEqual(before);
  const result = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  expect(
    JSON.parse(result.state.sources[result.report.metadataSourceId!]!.content).envelope.registry,
  ).toEqual({ terms: ['x'] });
});
it('requires a stable origin and rejects inconsistent source identity claims', async () => {
  write();
  await expect(
    importKnowledgeGraph(f.cwd, 'graph.json', { ...opts(), origin: undefined }),
  ).rejects.toThrow('--origin');
  const value = graph();
  for (const record of [...value.nodes, ...value.edges])
    record.props.origin = { id: 'embedded', revision: 'r1' };
  write(value);
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow('must agree');
  const result = await importKnowledgeGraph(f.cwd, 'graph.json', {
    ...opts(),
    origin: undefined,
  });
  expect(result.report.origin.id).toBe('embedded');
});
it('retains metadata for an empty graph and repeats it without a new event', async () => {
  write(
    makeExchange(
      { format: 'conflict-kg/v1', nodes: [], edges: [] },
      { id: 'product:sample', revision: 'empty' },
      { scope: 'product' },
    ),
  );
  const first = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  expect(first.imported).toBe(1);
  const repeat = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  expect(repeat.unchanged).toBe(true);
});
it('reports redaction while preserving valid JSON source claims', async () => {
  const secret = 'private-configured-credential-for-transfer';
  vi.stubEnv('TRANSFER_API_KEY', secret);
  const value = graph();
  value.nodes[0]!.props.summary = secret;
  write(value);
  const result = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  expect(result.report.losses.some((l) => l.code === 'redaction')).toBe(true);
  expect(JSON.stringify(result.journal)).not.toContain(secret);
  expect(Object.values(result.state.sources).every((s) => !!JSON.parse(s.content))).toBe(true);
});
it('rechecks the source file after mutation approval and retains no partial event', async () => {
  write();
  const before = f.store.read();
  await expect(
    importKnowledgeGraph(f.cwd, 'graph.json', {
      ...opts(),
      confirmation: 'mutating',
      approve: async () => {
        const changed = graph();
        changed.nodes[0]!.name = 'Changed during approval';
        write(changed);
        return 'allow';
      },
    }),
  ).rejects.toThrow('Source content changed');
  expect(f.store.read()).toEqual(before);
});
it('rechecks retained source policy after approval under the journal writer lock', async () => {
  write();
  const first = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  await editBrain(
    f.cwd,
    first.report.mappings[0]!.localId,
    { summary: 'Local correction' },
    'Reviewed',
    opts(),
  );
  let revoked = false;
  const before = f.store.read();
  await expect(
    importKnowledgeGraph(f.cwd, 'graph.json', {
      ...opts(),
      reconcileRevision: before.state.revision,
      confirmation: 'mutating',
      authorizeSource: () => {
        if (revoked) throw new BrainError('policy-denied', 'Revoked during review');
      },
      approve: async () => {
        revoked = true;
        return 'allow';
      },
    }),
  ).rejects.toThrow('Revoked during review');
  expect(f.store.read()).toEqual(before);
  expect(fs.existsSync(join(f.store.root, 'writer.lock'))).toBe(false);
});
it('rejects a concurrent destination write after approval without losing its winner', async () => {
  write();
  let wrote = false;
  await expect(
    importKnowledgeGraph(f.cwd, 'graph.json', {
      ...opts(),
      confirmation: 'mutating',
      approve: async () => {
        if (!wrote) {
          wrote = true;
          await noteBrain(f.cwd, 'Winner', 'Concurrent knowledge', 'decision', opts());
        }
        return 'allow';
      },
    }),
  ).rejects.toThrow('revision changed');
  expect(Object.values(f.store.read().state.entities).map((e) => e.name)).toEqual(['Winner']);
});

it('retains unsupported summaries and attribute shapes while reporting their native projection', async () => {
  const value = graph();
  value.nodes[0]!.props.attributes = ['nested', { original: 'value' }];
  value.nodes[0]!.props.summary = { paragraphs: ['Original summary'] };
  value.nodes[1]!.props.attributes = {
    scalar: 'Retained scalar',
    count: 3,
    enabled: true,
    missing: null,
  };
  value.edges[0]!.props = {
    attributes: { edgeNote: 'Kept as a claim' },
    summary: { text: 'Edge note' },
  };
  write(value);
  const result = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  expect(result.report.losses.map((loss) => loss.code)).toEqual(
    expect.arrayContaining([
      'source-only-summary',
      'source-only-attributes',
      'source-only-edge-properties',
    ]),
  );
  const entities = Object.values(result.state.entities),
    edge = Object.values(result.state.edges)[0]!;
  expect(entities.find((record) => record.name === 'Design')!.summary).toBe('Design');
  expect(entities.find((record) => record.name === 'Storage')!.attributes).toMatchObject({
    scalar: 'Retained scalar',
    count: 3,
    enabled: true,
    missing: null,
  });
  expect(edge.confidence).toBe(0);
  expect(
    JSON.parse(result.state.sources[edge.provenance[0]!.sourceId]!.content).record.props,
  ).toEqual(value.edges[0]!.props);
  const again = await importKnowledgeGraph(f.cwd, 'graph.json', opts());
  expect(again.unchanged).toBe(true);
});

it('rejects malformed or disagreeing origin claims before any journal write', async () => {
  for (const origin of [null, { id: 'a' }, { id: 1, revision: 'v1' }]) {
    const value = graph();
    value.nodes[0]!.props.origin = origin;
    write(value);
    await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow(
      'require an ID',
    );
  }
  const value = graph();
  value.nodes[0]!.props.origin = { id: 'product:sample', revision: 'v1' };
  value.nodes[1]!.props.origin = { id: 'different', revision: 'v1' };
  write(value);
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow('disagree');
  value.nodes[1]!.props.origin = { id: 'product:sample', revision: 'v1' };
  write(
    makeExchange(value as unknown as Record<string, unknown>, {
      id: 'product:sample',
      revision: 'v2',
    }),
  );
  await expect(importKnowledgeGraph(f.cwd, 'graph.json', opts())).rejects.toThrow(
    'revisions disagree',
  );
  expect(f.store.read().journal.events).toHaveLength(0);
});
