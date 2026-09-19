import { describe, expect, it } from 'vitest';
import { exportKnowledgeGraph, parseKnowledgeGraph } from '../src/brain/kg.js';
import { replayBrain } from '../src/brain/journal.js';
import { append, changes, edge, emptyJournal, entity } from './helpers/brain.js';

const view = replayBrain(
  append(emptyJournal(), [
    ...changes(
      entity('a', { name: 'Alpha', kind: 'artifact' }),
      entity('b', { name: 'Beta', kind: 'provider', state: 'proposed' }),
    ),
    {
      kind: 'edge',
      id: 'e',
      expected: null,
      value: edge('e', { from: 'a', to: 'b', type: 'depends-on' }),
    },
  ]),
);

describe('portable Brain KG', () => {
  it('projects the journal state and accepts both interchange names', () => {
    const graph = exportKnowledgeGraph(view),
      conflict = { ...graph, format: 'conflict-kg/v1' as const };
    expect(parseKnowledgeGraph(graph)).toEqual(graph);
    expect(parseKnowledgeGraph(conflict).format).toBe('conflict-kg/v1');
    expect(graph.nodes[0]).toMatchObject({
      id: 'a',
      name: 'Alpha',
      type: 'artifact',
      props: {
        state: 'accepted',
        createdAt: view.state.header.createdAt,
        sourceSnapshots: [view.state.sources.source],
        origin: { id: view.state.header.id },
      },
    });
    expect(graph.edges[0]).toMatchObject({
      source: 'a',
      target: 'b',
      type: 'depends-on',
    });
  });
  it('rejects duplicate nodes and dangling edges', () => {
    const graph = exportKnowledgeGraph(view);
    expect(() =>
      parseKnowledgeGraph({
        ...graph,
        nodes: [...graph.nodes, graph.nodes[0]],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      parseKnowledgeGraph({
        ...graph,
        edges: [...graph.edges, { source: 'a', target: 'missing', type: 'x', props: {} }],
      }),
    ).toThrow(/edge/);
  });
});
