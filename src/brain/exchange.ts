/** The shared archive is transport metadata, not a journal or permission grant. */
import { digest } from '../approvals/index.js';
import type { BrainOptions } from './access.js';
import { canonicalExchangeJson } from './exchange-json.js';
import { parseKnowledgeGraph, type PortableKnowledgeGraph } from './kg.js';
import { BrainError } from './types.js';
import { hash, obj, shape, text } from './validation.js';

export interface BrainTransferOptions extends BrainOptions {
  allowLoss?: boolean;
  preview?: boolean;
  origin?: string;
  manifestPath?: string;
  exchange?: boolean;
  reconcileRevision?: string;
}
export interface ExchangeArchive {
  format: 'brain-exchange/v2';
  sourceFormat: PortableKnowledgeGraph['format'] | 'compiled-brain/v1' | 'calliope.brain/v1';
  origin: { id: string; revision: string };
  manifest: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  sha256: string;
}

function sourceFormat(value: unknown): ExchangeArchive['sourceFormat'] {
  if (!obj(value)) throw new BrainError('invalid', 'Exchange payload must be an object.');
  if (value.format === 'calliope-kg/v1' || value.format === 'conflict-kg/v1') {
    parseKnowledgeGraph(value);
    return value.format;
  }
  if ('format' in value) throw new BrainError('invalid', 'Unsupported exchange payload format.');
  if (
    value.kind === 'calliope.brain' &&
    value.version === 1 &&
    obj(value.journal) &&
    value.journal.version === 1
  )
    return 'calliope.brain/v1'; // Native replay remains required at import.
  if (obj(value.meta) && value.meta.version === '1') {
    compiledGraph(value);
    return 'compiled-brain/v1'; // Destination ontology semantics are not inferred.
  }
  throw new BrainError('invalid', 'Unsupported exchange payload version.');
}

export function makeExchange(
  payload: Record<string, unknown>,
  origin: ExchangeArchive['origin'],
  manifest: ExchangeArchive['manifest'] = null,
): ExchangeArchive {
  shape(origin, ['id', 'revision']);
  text(origin.id, 512);
  text(origin.revision, 512);
  if (manifest !== null && !obj(manifest))
    throw new BrainError('invalid', 'Exchange manifest must be an object or null.');
  const body = {
    format: 'brain-exchange/v2' as const,
    sourceFormat: sourceFormat(payload),
    origin,
    manifest,
    payload,
  };
  return structuredClone({
    ...body,
    sha256: digest(canonicalExchangeJson(body)),
  });
}

export function parseExchangeArchive(value: unknown): ExchangeArchive {
  shape(value, ['format', 'sourceFormat', 'origin', 'manifest', 'payload', 'sha256']);
  if (value.format !== 'brain-exchange/v2')
    throw new BrainError(
      'invalid',
      'CLI exchange requires brain-exchange/v2; validate/unpack v1 with the core and explicitly repack as v2.',
    );
  if (!hash(value.sha256)) throw new BrainError('invalid', 'Invalid exchange digest.');
  const expected = makeExchange(
    value.payload as Record<string, unknown>,
    value.origin as ExchangeArchive['origin'],
    value.manifest as ExchangeArchive['manifest'],
  );
  if (canonicalExchangeJson(expected) !== canonicalExchangeJson(value))
    throw new BrainError('invalid', 'Exchange digest or source format mismatch.');
  return expected;
}

export function compiledGraph(value: Record<string, unknown>): PortableKnowledgeGraph {
  if (
    !obj(value.meta) ||
    value.meta.version !== '1' ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    throw new BrainError('invalid', 'Unsupported compiled brain envelope.');
  const nodes = value.nodes.map((raw) => {
    if (!obj(raw)) throw new BrainError('invalid', 'Compiled node must be an object.');
    if ('data' in raw && !obj(raw.data))
      throw new BrainError('invalid', 'Compiled node data must be an object.');
    const { id, kind, ...props } = raw;
    const name = raw.title || raw.text || id;
    return { id, name, type: kind, props };
  });
  const edges = value.edges.map((raw) => {
    if (!obj(raw)) throw new BrainError('invalid', 'Compiled edge must be an object.');
    const { source, target, rel, ...props } = raw;
    return { source, target, type: rel, props };
  });
  return parseKnowledgeGraph({ format: 'conflict-kg/v1', nodes, edges });
}

export function archiveGraph(archive: ExchangeArchive): PortableKnowledgeGraph {
  if (archive.sourceFormat === 'calliope.brain/v1')
    throw new BrainError(
      'invalid',
      'Use native brain import for journal archives; graph projection cannot replay history.',
    );
  return archive.sourceFormat === 'compiled-brain/v1'
    ? compiledGraph(archive.payload)
    : parseKnowledgeGraph(archive.payload);
}
