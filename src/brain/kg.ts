import { canonicalJson, digest } from '../approvals/index.js';
import { BrainError, type BrainInspection } from './types.js';
import { shape } from './validation.js';

export interface PortableKgNode { id: string; name: string; type: string; props: Record<string, unknown> }
export interface PortableKgEdge { source: string; target: string; type: string; props: Record<string, unknown> }
export interface PortableKnowledgeGraph { format: 'calliope-kg/v1' | 'conflict-kg/v1'; nodes: PortableKgNode[]; edges: PortableKgEdge[] }

/** Project Brain-compatible projection; the journal remains the write/audit source. */
export function exportKnowledgeGraph(view: BrainInspection, format: PortableKnowledgeGraph['format'] = 'calliope-kg/v1'): PortableKnowledgeGraph {
  const nodes = Object.values(view.state.entities).map(entity => ({
    id: entity.id,
    name: entity.name,
    type: entity.kind,
    props: { summary: entity.summary, state: entity.state, confidence: entity.confidence, provenance: entity.provenance, attributes: entity.attributes, revision: entity.revision, origins: entity.origins ?? [] },
  }));
  const edges = Object.values(view.state.edges).map(edge => ({
    source: edge.from,
    target: edge.to,
    type: edge.type,
    props: { id: edge.id, state: edge.state, confidence: edge.confidence, provenance: edge.provenance, revision: edge.revision, origins: edge.origins ?? [] },
  }));
  return { format, nodes, edges };
}

export function parseKnowledgeGraph(value: unknown): PortableKnowledgeGraph {
  shape(value, ['format', 'nodes', 'edges']);
  if (value.format !== 'calliope-kg/v1' && value.format !== 'conflict-kg/v1') throw new BrainError('invalid', 'Unsupported knowledge graph format.');
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 10000 || value.edges.length > 30000) throw new BrainError('limit', 'Knowledge graph exceeds its limits.');
  const ids = new Set<string>();
  const nodes = value.nodes.map(raw => { shape(raw, ['id', 'name', 'type', 'props']); const node = raw as Record<string, unknown>, id = node.id; if (typeof id !== 'string' || !id || id.length > 512) throw new BrainError('invalid', 'Knowledge graph node ID is invalid.'); if (ids.has(id)) throw new BrainError('invalid', 'Knowledge graph contains duplicate node IDs.'); ids.add(id); if (typeof node.name !== 'string' || typeof node.type !== 'string' || !node.props || typeof node.props !== 'object' || Array.isArray(node.props)) throw new BrainError('invalid', 'Knowledge graph node is invalid.'); return node as unknown as PortableKgNode; });
  const edges = value.edges.map(raw => { shape(raw, ['source', 'target', 'type', 'props']); const edge = raw as Record<string, unknown>, source = edge.source, target = edge.target; if (typeof source !== 'string' || typeof target !== 'string' || !ids.has(source) || !ids.has(target) || typeof edge.type !== 'string' || !edge.props || typeof edge.props !== 'object' || Array.isArray(edge.props)) throw new BrainError('invalid', 'Knowledge graph edge is invalid.'); return edge as unknown as PortableKgEdge; });
  return JSON.parse(canonicalJson({ format: value.format, nodes, edges })) as PortableKnowledgeGraph;
}

export const knowledgeGraphDigest = (graph: PortableKnowledgeGraph) => digest(canonicalJson(graph));
