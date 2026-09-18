import * as fs from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, digest } from '../approvals/index.js';
import { authorizeSessionAction } from '../session-management/index.js';
import { throwIfCancelled } from '../cancellation.js';
import {
  BrainError,
  BRAIN_LIMITS,
  type BrainChange,
  type BrainJournal,
  type SourceInput,
  type EntityInput,
  type EdgeInput,
  type Provenance,
  type BrainEntity,
  type BrainSource,
  type BrainEdge,
  type KnowledgeOrigin,
} from './types.js';
import { shape, hash } from './validation.js';
import { replayBrain, recordInput } from './journal.js';
import {
  brainStore,
  BrainAccess,
  readBrainFile,
  projectFile,
  sanitizeBrainText,
  sanitizeBrainValue,
  hasBrainSecrets,
  type BrainOptions,
} from './access.js';
import { commitBrain } from './actions.js';
import { exportKnowledgeGraph, type PortableKnowledgeGraph } from './kg.js';
export interface BrainBundle {
  version: 1;
  kind: 'calliope.brain';
  journal: BrainJournal;
  checksum: string;
}
const checksum = (journal: BrainJournal) =>
  digest(
    canonicalJson({
      version: 1,
      kind: 'calliope.brain',
      brain: journal.header.id,
      head: journal.hash,
    }),
  );
export function parseBrainBundle(value: unknown, signal?: AbortSignal): BrainBundle {
  shape(value, ['version', 'kind', 'journal', 'checksum']);
  if (value.version !== 1 || value.kind !== 'calliope.brain' || !hash(value.checksum))
    throw new BrainError('invalid', 'Unsupported brain export schema.');
  const view = replayBrain(value.journal, signal);
  if (value.checksum !== checksum(view.journal))
    throw new BrainError('invalid', 'Brain export checksum differs from its journal.');
  return value as unknown as BrainBundle;
}
export async function exportBrain(cwd: string, path: string, options: BrainOptions = {}) {
  const store = brainStore(cwd, options),
    view = store.read(options.signal);
  await new BrainAccess(cwd, view.state.sources, options).all();
  const bundle: BrainBundle = {
      version: 1,
      kind: 'calliope.brain',
      journal: view.journal,
      checksum: checksum(view.journal),
    },
    content = JSON.stringify(bundle);
  if (Buffer.byteLength(content) > BRAIN_LIMITS.journalBytes)
    throw new BrainError('limit', 'Brain export exceeds its byte limit.');
  // Historical records can acquire newly configured secret values; never export unsanitized history.
  if (hasBrainSecrets(bundle))
    throw new BrainError(
      'policy-denied',
      'Retained history matches current secret material; preserve it privately and export a reviewed sanitized scope.',
    );
  const target = projectFile(cwd, path);
  await authorizeSessionAction(
    cwd,
    'write_file',
    {
      path: target.file,
      operation: 'brain-export',
      checksum: bundle.checksum,
      bytes: Buffer.byteLength(content),
    },
    { ...options, confirmation: options.confirmation ?? 'mutating' },
  );
  target.recheck();
  throwIfCancelled(options.signal);
  const temp = join(
    dirname(target.file),
    '.' + basename(target.file) + '-' + randomUUID() + '.tmp',
  );
  let created = false;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    target.recheck();
    throwIfCancelled(options.signal);
    fs.linkSync(temp, target.file);
    const parent = fs.openSync(dirname(target.file), 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
    return { path: target.file, checksum: bundle.checksum, revision: view.state.revision };
  } finally {
    if (created)
      try {
        target.recheck();
        fs.unlinkSync(temp);
      } catch {
        /* Preserve files in replaced directories. */
      }
  }
}

/** Export the derived portable graph without exposing the append-only journal. */
export async function exportKnowledgeGraphFile(cwd: string, path: string, options: BrainOptions = {}) {
  const store = brainStore(cwd, options), view = store.read(options.signal);
  await new BrainAccess(cwd, view.state.sources, options).all();
  const graph: PortableKnowledgeGraph = exportKnowledgeGraph(view), content = JSON.stringify(graph);
  if (Buffer.byteLength(content) > BRAIN_LIMITS.journalBytes) throw new BrainError('limit', 'Knowledge graph export exceeds its byte limit.');
  if (hasBrainSecrets(graph)) throw new BrainError('policy-denied', 'Knowledge graph matches current secret material; preserve it privately and export a reviewed sanitized scope.');
  const target = projectFile(cwd, path);
  await authorizeSessionAction(cwd, 'write_file', { path: target.file, operation: 'brain-kg-export', format: graph.format, bytes: Buffer.byteLength(content) }, { ...options, confirmation: options.confirmation ?? 'mutating' });
  target.recheck(); throwIfCancelled(options.signal);
  const temp = join(dirname(target.file), '.' + basename(target.file) + '-' + randomUUID() + '.tmp'); let created = false;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600); created = true;
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    target.recheck(); throwIfCancelled(options.signal); fs.linkSync(temp, target.file);
    const parent = fs.openSync(dirname(target.file), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return { path: target.file, format: graph.format, nodes: graph.nodes.length, edges: graph.edges.length, revision: view.state.revision };
  } finally { if (created) try { target.recheck(); fs.unlinkSync(temp); } catch { /* preserve replaced directories */ } }
}
/** Imported authority is discarded. Claims are namespaced and staged as proposals for local review. */
export async function importBrain(cwd: string, path: string, options: BrainOptions = {}) {
  const input = await readBrainFile(cwd, path, options, BRAIN_LIMITS.journalBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.original);
  } catch {
    throw new BrainError('invalid', 'Brain import must be a JSON export.');
  }
  const bundle = parseBrainBundle(parsed, options.signal),
    origin = replayBrain(bundle.journal, options.signal).state,
    store = brainStore(cwd, options),
    prior = store.read(options.signal);
  const namespace = (kind: string, id: string) =>
      'import:' + digest(origin.header.id + ':' + kind + ':' + id),
    changes: BrainChange[] = [];
  const origins = (record: BrainEntity | BrainSource | BrainEdge): KnowledgeOrigin[] => {
    if ((record.origins?.length ?? 0) >= 8)
      throw new BrainError(
        'limit',
        'Knowledge transfer ancestry reached eight origins; preserve its export.',
      );
    return [
      ...(record.origins ?? []),
      {
        brainId: origin.header.id,
        recordId: record.id,
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        checksum: bundle.checksum,
        ...('state' in record
          ? { state: record.state, confidence: record.confidence }
          : { sourceKind: record.kind, locator: record.locator }),
      },
    ];
  };
  for (const record of Object.values(origin.sources)) {
    const id = namespace('source', record.id),
      content = sanitizeBrainText(record.content),
      value: SourceInput = {
        id,
        kind: 'import',
        origins: origins(record),
        name: sanitizeBrainText(record.name),
        content,
        originalHash: record.originalHash,
        contentHash: digest(content),
        redacted: record.redacted || content !== record.content,
        locator: {
          importedFrom: origin.header.id,
          projectKey: input.project.projectKey,
          path: input.relative,
        },
      };
    // File provenance remains an unverified source claim; it cannot cause reads in a foreign project.
    const previous = prior.state.sources[id];
    if (previous && canonicalJson(recordInput(previous)) !== canonicalJson(value))
      throw new BrainError(
        'conflict',
        'Imported source differs from the retained snapshot; preserve both exports.',
      );
    if (!previous) changes.push({ kind: 'source', value });
  }
  for (const [kind, records] of [
    ['entity', origin.entities],
    ['edge', origin.edges],
  ] as const)
    for (const record of Object.values(records)) {
      const id = namespace(kind, record.id),
        provenance = record.provenance.map((p: Provenance) => ({
          ...p,
          sourceId: namespace('source', p.sourceId),
          ...(p.excerpt !== undefined ? { excerpt: sanitizeBrainText(p.excerpt) } : {}),
        }));
      const state = record.state === 'accepted' ? 'proposed' : record.state;
      const value =
        kind === 'entity'
          ? {
              ...recordInput(record as (typeof origin.entities)[string]),
              origins: origins(record),
              id,
              name: sanitizeBrainText((record as (typeof origin.entities)[string]).name),
              summary: sanitizeBrainText((record as (typeof origin.entities)[string]).summary),
              attributes: sanitizeBrainValue(
                (record as (typeof origin.entities)[string]).attributes,
              ),
              state,
              provenance,
            }
          : {
              ...recordInput(record as (typeof origin.edges)[string]),
              origins: origins(record),
              id,
              from: namespace('entity', (record as (typeof origin.edges)[string]).from),
              to: namespace('entity', (record as (typeof origin.edges)[string]).to),
              state,
              provenance,
            };
      const previous = kind === 'entity' ? prior.state.entities[id] : prior.state.edges[id];
      if (previous) {
        if (canonicalJson(recordInput(previous)) !== canonicalJson(value))
          throw new BrainError(
            'conflict',
            'Import conflicts with retained knowledge or a local correction; review its differences.',
          );
        continue;
      }
      changes.push({
        kind,
        id,
        expected: prior.state.revisions[kind + ':' + id] ?? null,
        value,
      } as BrainChange);
    }
  if (!changes.length)
    return { ...prior, index: 'unchanged' as const, imported: 0, origin: origin.header.id };
  return {
    ...(await commitBrain(
      cwd,
      changes,
      'import',
      'Imported source claims; accepted claims require new local human review.',
      prior,
      options,
      input.assertUnchanged,
    )),
    imported: changes.length,
    origin: origin.header.id,
  };
}
