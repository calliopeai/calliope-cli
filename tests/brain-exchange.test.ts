import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { archiveGraph, makeExchange, parseExchangeArchive } from '../src/brain/exchange.js';
import { knowledgeGraphDigest, parseKnowledgeGraph } from '../src/brain/kg.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/brain-interchange/exchange-v2.json', import.meta.url), 'utf8'),
);
describe('brain exchange archive', () => {
  it('verifies the Python archive and produces the same digest from native values', () => {
    expect(parseExchangeArchive(fixture)).toEqual(fixture);
    expect(makeExchange(fixture.payload, fixture.origin, fixture.manifest)).toEqual(fixture);
    expect(archiveGraph(fixture)).toEqual(fixture.payload);
  });
  it('rejects altered bodies, relabelled versions, unknown source formats and grants outside the schema', () => {
    for (const value of [
      { ...fixture, format: 'brain-exchange/v1' },
      { ...fixture, manifest: { grants: ['admin'] } },
      { ...fixture, sourceFormat: 'compiled-brain/v1' },
      { ...fixture, sha256: 'invalid' },
      { ...fixture, grants: ['admin'] },
      { ...fixture, origin: { id: 'new', revision: 'new' } },
    ])
      expect(() => parseExchangeArchive(value)).toThrow();
    expect(() => makeExchange({ format: 'unknown/v1' }, fixture.origin)).toThrow('Unsupported');
    expect(() => makeExchange(fixture.payload, { id: '', revision: 'x' })).toThrow();
    expect(() => makeExchange(fixture.payload, fixture.origin, [] as any)).toThrow('manifest');
  });
  it('maps compiled records explicitly and keeps the envelope/manifest in the archive', () => {
    const native = {
      meta: { version: '1', ontology: { sha256: 'unverified-binding' } },
      nodes: [
        {
          id: 'decision:a',
          kind: 'Decision',
          title: 'Decision',
          data: { confidence: null },
          evidence: { source: 'claimed' },
        },
        { id: 'source:a', kind: 'Source', text: 'Source bytes' },
      ],
      edges: [
        {
          source: 'decision:a',
          target: 'source:a',
          rel: 'supported_by',
          evidence: { locator: { page: 3 } },
        },
      ],
    };
    const archive = makeExchange(native, fixture.origin, fixture.manifest);
    expect(archive.payload).toEqual(native);
    const graph = archiveGraph(archive);
    expect(graph.nodes[0]).toEqual({
      id: 'decision:a',
      name: 'Decision',
      type: 'Decision',
      props: {
        title: 'Decision',
        data: { confidence: null },
        evidence: { source: 'claimed' },
      },
    });
    expect(graph.edges[0].props).toEqual({
      evidence: { locator: { page: 3 } },
    });
    expect(archive.manifest).toEqual(fixture.manifest);
    expect(() =>
      makeExchange({ ...native, nodes: [{ ...native.nodes[0], data: [] }] }, fixture.origin),
    ).toThrow('data');
    expect(() => makeExchange({ ...native, meta: { version: '2' } }, fixture.origin)).toThrow(
      'Unsupported',
    );
  });
  it('refuses to masquerade a journal as a graph or native replay proof', () => {
    const archive = makeExchange(
      { kind: 'calliope.brain', version: 1, journal: { version: 1 } },
      fixture.origin,
    );
    expect(archive.sourceFormat).toBe('calliope.brain/v1');
    expect(() => archiveGraph(archive)).toThrow('native brain import');
  });
  it('normalizes legacy properties and alias identity without guessing collisions', () => {
    const original = {
      format: 'conflict-kg/v1',
      nodes: [
        {
          id: 'a',
          name: 'A',
          type: 'concept',
          sessions: ['s'],
          props: { confidence: 0.25 },
        },
      ],
      edges: [],
    };
    const graph = parseKnowledgeGraph(original);
    expect(graph.nodes[0].props).toEqual({ sessions: ['s'], confidence: 0.25 });
    expect(knowledgeGraphDigest(graph)).toBe(
      knowledgeGraphDigest({ ...graph, format: 'calliope-kg/v1' }),
    );
    expect(() =>
      parseKnowledgeGraph({
        ...original,
        nodes: [{ ...original.nodes[0], confidence: 0.25 }],
      }),
    ).toThrow('collides');
    expect(() => parseKnowledgeGraph({ ...original, manifest: fixture.manifest })).toThrow();
  });
});

it('rejects malformed graph records and versions instead of guessing a projection', () => {
  const graph = {
    format: 'calliope-kg/v1',
    nodes: [{ id: 'a', name: 'A', type: 'decision', props: {} }],
    edges: [],
  };
  for (const change of [
    { format: 'calliope-kg/v2' },
    { nodes: null },
    { nodes: new Array(10001) },
    { nodes: [null] },
    { nodes: [{}] },
    { nodes: [{ ...graph.nodes[0], props: [] }] },
    { nodes: [{ ...graph.nodes[0], id: '' }] },
    { nodes: [{ ...graph.nodes[0], name: false }] },
    { nodes: [{ ...graph.nodes[0], type: '' }] },
  ])
    expect(() => parseKnowledgeGraph({ ...graph, ...change })).toThrow();
  const normalized = parseKnowledgeGraph({
    ...graph,
    nodes: [{ id: 'a', name: 'A', type: 'decision' }],
  });
  expect(normalized.nodes[0]!.props).toEqual({});
  expect(() => makeExchange(null as never, fixture.origin)).toThrow('object');
});
