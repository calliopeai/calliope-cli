import { describe, expect, it } from 'vitest';
import { exportKnowledgeGraph, parseKnowledgeGraph } from '../src/brain/kg.js';

const view = {
  state: {
    entities: {
      a: { id: 'a', name: 'Alpha', kind: 'concept', summary: 'A concept', state: 'accepted', confidence: 1, provenance: [{ sourceId: 's', basis: 'observed' }], attributes: {}, revision: 'ra', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      b: { id: 'b', name: 'Beta', kind: 'technology', summary: 'A system', state: 'proposed', confidence: 0.5, provenance: [{ sourceId: 's', basis: 'inferred' }], attributes: { active: true }, revision: 'rb', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    },
    edges: { e: { id: 'e', from: 'a', to: 'b', type: 'depends-on', state: 'accepted', confidence: 1, provenance: [{ sourceId: 's', basis: 'observed' }], revision: 're', createdAt: '2026-01-01', updatedAt: '2026-01-01' } },
  },
} as any;

describe('portable Brain KG', () => {
  it('projects the journal state and accepts both interchange names', () => {
    const graph = exportKnowledgeGraph(view), conflict = { ...graph, format: 'conflict-kg/v1' as const };
    expect(parseKnowledgeGraph(graph)).toEqual(graph);
    expect(parseKnowledgeGraph(conflict).format).toBe('conflict-kg/v1');
    expect(graph.nodes[0]).toMatchObject({ id: 'a', name: 'Alpha', type: 'concept', props: { state: 'accepted' } });
    expect(graph.edges[0]).toMatchObject({ source: 'a', target: 'b', type: 'depends-on' });
  });
  it('rejects duplicate nodes and dangling edges', () => {
    const graph = exportKnowledgeGraph(view);
    expect(() => parseKnowledgeGraph({ ...graph, nodes: [...graph.nodes, graph.nodes[0]] })).toThrow(/duplicate/);
    expect(() => parseKnowledgeGraph({ ...graph, edges: [...graph.edges, { source: 'a', target: 'missing', type: 'x', props: {} }] })).toThrow(/edge/);
  });
});
