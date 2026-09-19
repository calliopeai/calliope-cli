import { digest } from '../approvals/index.js';
import { canonicalExchangeJson } from './exchange-json.js';
import { BrainError, type BrainInspection } from './types.js';
import { obj, shape } from './validation.js';

export interface PortableKgNode {
  id: string;
  name: string;
  type: string;
  props: Record<string, unknown>;
}
export interface PortableKgEdge {
  source: string;
  target: string;
  type: string;
  props: Record<string, unknown>;
}
export interface PortableKnowledgeGraph {
  format: 'calliope-kg/v1' | 'conflict-kg/v1';
  nodes: PortableKgNode[];
  edges: PortableKgEdge[];
}

/** Project Brain-compatible projection; the journal remains the write/audit source. */
export function exportKnowledgeGraph(
  view: BrainInspection,
  format: PortableKnowledgeGraph['format'] = 'calliope-kg/v1',
): PortableKnowledgeGraph {
  const origin = {
    id: view.state.header.id,
    revision: view.state.revision,
    scope: view.state.header.scope,
  };
  const sources = (record: { provenance: { sourceId: string }[] }) =>
    [...new Set(record.provenance.map((p) => p.sourceId))].map((id) => {
      const source = view.state.sources[id];
      if (!source) throw new BrainError('invalid', 'Knowledge graph source snapshot is missing.');
      return structuredClone(source);
    });
  const nodes = Object.values(view.state.entities).map((entity) => ({
    id: entity.id,
    name: entity.name,
    type: entity.kind,
    props: {
      summary: entity.summary,
      state: entity.state,
      confidence: entity.confidence,
      provenance: entity.provenance,
      attributes: entity.attributes,
      revision: entity.revision,
      origins: entity.origins ?? [],
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      origin,
      sourceSnapshots: sources(entity),
    },
  }));
  const edges = Object.values(view.state.edges).map((edge) => ({
    source: edge.from,
    target: edge.to,
    type: edge.type,
    props: {
      id: edge.id,
      state: edge.state,
      confidence: edge.confidence,
      provenance: edge.provenance,
      revision: edge.revision,
      origins: edge.origins ?? [],
      createdAt: edge.createdAt,
      updatedAt: edge.updatedAt,
      origin,
      sourceSnapshots: sources(edge),
    },
  }));
  return parseKnowledgeGraph({ format, nodes, edges });
}

export function parseKnowledgeGraph(value: unknown): PortableKnowledgeGraph {
  shape(value, ['format', 'nodes', 'edges']);
  if (value.format !== 'calliope-kg/v1' && value.format !== 'conflict-kg/v1')
    throw new BrainError('invalid', 'Unsupported knowledge graph format.');
  if (
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    value.nodes.length > 10000 ||
    value.edges.length > 30000
  )
    throw new BrainError('limit', 'Knowledge graph exceeds its limits.');
  const ids = new Set<string>();
  const normalize = (raw: unknown, fields: string[]) => {
    if (!obj(raw) || fields.some((field) => !Object.hasOwn(raw, field)))
      throw new BrainError('invalid', 'Knowledge graph record is incomplete.');
    const props = Object.hasOwn(raw, 'props') ? raw.props : {};
    if (!obj(props)) throw new BrainError('invalid', 'Knowledge graph props must be an object.');
    const extra = Object.entries(raw).filter(([key]) => ![...fields, 'props'].includes(key));
    if (extra.some(([key]) => Object.hasOwn(props, key)))
      throw new BrainError('invalid', 'Ambiguous legacy graph property collides with props.');
    return {
      ...Object.fromEntries(fields.map((key) => [key, raw[key]])),
      props: { ...props, ...Object.fromEntries(extra) },
    };
  };
  const nodes = value.nodes.map((raw) => {
    const node = normalize(raw, ['id', 'name', 'type']) as unknown as PortableKgNode;
    if (typeof node.id !== 'string' || !node.id.trim() || node.id.length > 512)
      throw new BrainError('invalid', 'Knowledge graph node ID is invalid.');
    if (ids.has(node.id))
      throw new BrainError('invalid', 'Knowledge graph contains duplicate node IDs.');
    ids.add(node.id);
    if (typeof node.name !== 'string' || typeof node.type !== 'string' || !node.type.trim())
      throw new BrainError('invalid', 'Knowledge graph node is invalid.');
    return node;
  });
  const edges = value.edges.map((raw) => {
    const edge = normalize(raw, ['source', 'target', 'type']) as unknown as PortableKgEdge;
    if (
      typeof edge.source !== 'string' ||
      typeof edge.target !== 'string' ||
      !ids.has(edge.source) ||
      !ids.has(edge.target) ||
      typeof edge.type !== 'string' ||
      !edge.type.trim()
    )
      throw new BrainError('invalid', 'Knowledge graph edge is invalid.');
    return edge;
  });
  const graph = { format: value.format, nodes, edges };
  canonicalExchangeJson(graph);
  return structuredClone(graph) as PortableKnowledgeGraph;
}

export const knowledgeGraphDigest = (graph: PortableKnowledgeGraph) =>
  digest(
    canonicalExchangeJson({
      ...parseKnowledgeGraph(graph),
      format: 'conflict-kg/v1',
    }),
  );
