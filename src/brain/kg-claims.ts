/** Preserve rich foreign claims without extending the closed native journal schema. */
import { digest } from '../approvals/index.js';
import { sanitizeBrainValue, hasBrainSecrets } from './access.js';
import { canonicalExchangeJson } from './exchange-json.js';
import {
  knowledgeGraphDigest,
  type PortableKnowledgeGraph,
  type PortableKgNode,
  type PortableKgEdge,
} from './kg.js';
import type { ExchangeArchive } from './exchange.js';
import type { TransferLoss } from './transfer-report.js';
import {
  BrainError,
  ENTITY_KINDS,
  type EntityInput,
  type EdgeInput,
  type SourceInput,
} from './types.js';
import { obj, text, identifier, entity, edge, source } from './validation.js';

export function graphOrigin(
  graph: PortableKnowledgeGraph,
  archive?: ExchangeArchive,
  explicit?: string,
) {
  const claims = [...graph.nodes, ...graph.edges].map((record) => record.props.origin);
  const embedded = claims.filter((value) => value !== undefined);
  if (
    embedded.some(
      (value) => !obj(value) || typeof value.id !== 'string' || typeof value.revision !== 'string',
    )
  )
    throw new BrainError('invalid', 'Graph origin claims require an ID and revision.');
  const ids = new Set(embedded.map((value) => (value as Record<string, string>).id));
  const revisions = new Set(embedded.map((value) => (value as Record<string, string>).revision));
  if (ids.size > 1 || revisions.size > 1)
    throw new BrainError('invalid', 'Graph origin claims disagree.');
  const claimedId = ids.values().next().value;
  const id = archive?.origin.id ?? explicit ?? claimedId;
  if (!id)
    throw new BrainError(
      'invalid',
      'A bare graph needs --origin or consistent embedded origin claims.',
    );
  if ((explicit && explicit !== id) || (claimedId && claimedId !== id))
    throw new BrainError('invalid', 'Explicit, archive and graph origin IDs must agree.');
  const claimedRevision = revisions.values().next().value;
  if (archive && claimedRevision && archive.origin.revision !== claimedRevision)
    throw new BrainError('invalid', 'Archive and graph origin revisions disagree.');
  const revision = archive?.origin.revision ?? claimedRevision ?? knowledgeGraphDigest(graph);
  text(id, 512);
  text(revision, 512);
  if (hasBrainSecrets({ id, revision }))
    throw new BrainError('policy-denied', 'Origin identifiers contain secret material.');
  return { id, revision };
}

export const graphNamespace = (origin: string, kind: 'entity' | 'edge', id: string) =>
  'import:kg:' + digest(canonicalExchangeJson([origin, kind, id]));

export function edgeIdentities(graph: PortableKnowledgeGraph): string[] {
  const triples = graph.edges.map((record) =>
    canonicalExchangeJson([record.source, record.type, record.target]),
  );
  const counts = new Map<string, number>();
  for (const triple of triples) counts.set(triple, (counts.get(triple) ?? 0) + 1);
  const ids = graph.edges.map((record, index) => {
    if (Object.hasOwn(record.props, 'id')) {
      text(record.props.id, 512);
      return record.props.id;
    }
    if (counts.get(triples[index]!) !== 1)
      throw new BrainError(
        'invalid',
        'Parallel relationships require distinct explicit props.id values.',
      );
    return 'derived:' + digest(triples[index]!);
  });
  if (new Set(ids).size !== ids.length)
    throw new BrainError('invalid', 'Duplicate relationship IDs.');
  return ids;
}

export function claimSource(
  value: unknown,
  locator: SourceInput['locator'],
  losses: TransferLoss[],
): SourceInput {
  const original = canonicalExchangeJson(value),
    clean = sanitizeBrainValue(value);
  if (hasBrainSecrets(clean))
    throw new BrainError(
      'policy-denied',
      'Transfer metadata contains secret keys that cannot be safely retained.',
    );
  const content = canonicalExchangeJson(clean),
    originalHash = digest(original),
    contentHash = digest(content);
  if (content !== original)
    losses.push({
      code: 'redaction',
      message: 'Recognized secrets are redacted from retained source claims.',
    });
  return source({
    id: 'source:kg:' + digest(originalHash + ':' + contentHash),
    kind: 'import',
    name: 'Portable graph source claim',
    content,
    originalHash,
    contentHash,
    redacted: content !== original,
    locator,
  });
}

export function projectClaim(
  kind: 'entity' | 'edge',
  externalId: string,
  record: PortableKgNode | PortableKgEdge,
  origin: string,
  sourceIds: string[],
  losses: TransferLoss[],
): EntityInput | EdgeInput {
  const clean = sanitizeBrainValue(record),
    props = clean.props;
  const loss = (code: string, message: string, fields?: string[]) =>
    losses.push({
      code,
      record: { kind, id: externalId },
      message,
      ...(fields ? { fields } : {}),
    });
  if (hasBrainSecrets(externalId))
    throw new BrainError('policy-denied', 'Record identifiers contain secret material.');
  let confidence = props.confidence;
  if (confidence === undefined || confidence === null || confidence === 'unknown') {
    loss(
      'unknown-confidence',
      'Native projection uses zero for unknown confidence; the original claim remains in its source.',
    );
    confidence = 0;
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1)
    throw new BrainError(
      'invalid',
      'Confidence must be in [0,1] or explicitly unknown; values are never clamped.',
    );
  const sourceOnly = Object.keys(props).filter(
    (key) => !['summary', 'state', 'confidence', 'attributes', 'id'].includes(key),
  );
  if (sourceOnly.length)
    loss(
      'source-only-metadata',
      'Evidence, origin and other metadata remain source claims; native queries do not interpret them.',
      sourceOnly,
    );
  if (props.state !== undefined && props.state !== 'proposed')
    loss(
      'local-review',
      'Imported status remains a source claim; the local projection starts proposed.',
      ['state'],
    );
  const common = {
    id: graphNamespace(origin, kind, externalId),
    state: 'proposed' as const,
    confidence,
    provenance: sourceIds.map((sourceId) => ({
      sourceId,
      basis: 'inferred' as const,
    })),
  };
  if (kind === 'edge') {
    const relation = clean as PortableKgEdge;
    if (Object.hasOwn(props, 'summary') || Object.hasOwn(props, 'attributes'))
      loss(
        'source-only-edge-properties',
        'Relationship summary and attributes remain source claims.',
        ['summary', 'attributes'],
      );
    if (!identifier(relation.type))
      throw new BrainError(
        'invalid',
        'Relationship type cannot be represented by the native identifier grammar.',
      );
    return edge({
      ...common,
      from: graphNamespace(origin, 'entity', relation.source),
      to: graphNamespace(origin, 'entity', relation.target),
      type: relation.type,
    });
  }
  const node = clean as PortableKgNode;
  const nativeKind = ENTITY_KINDS.includes(node.type as never)
    ? (node.type as EntityInput['kind'])
    : 'artifact';
  if (nativeKind !== node.type)
    loss(
      'unsupported-kind',
      'Native projection uses artifact for this foreign kind; the original kind is retained.',
    );
  const attributes: EntityInput['attributes'] = {
    externalId,
    externalType: node.type,
  };
  if (props.attributes !== undefined && !obj(props.attributes))
    loss('source-only-attributes', 'Non-object attributes remain source claims.', ['attributes']);
  if (obj(props.attributes)) {
    const omitted: string[] = [];
    for (const [key, value] of Object.entries(props.attributes)) {
      if (
        ['externalId', 'externalType'].includes(key) ||
        (value !== null && !['string', 'number', 'boolean'].includes(typeof value))
      )
        omitted.push(key);
      else
        Object.defineProperty(attributes, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    if (omitted.length)
      loss(
        'source-only-attributes',
        'Nested or reserved attributes remain source claims.',
        omitted,
      );
  }
  if (props.summary !== undefined && typeof props.summary !== 'string')
    loss(
      'source-only-summary',
      'Non-text summary remains a source claim; the projection uses the name.',
      ['summary'],
    );
  return entity({
    ...common,
    kind: nativeKind,
    name: node.name,
    summary: typeof props.summary === 'string' ? props.summary : node.name,
    attributes,
  });
}
