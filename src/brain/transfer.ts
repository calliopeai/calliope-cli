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
import { makeExchange, parseExchangeArchive, type BrainTransferOptions } from './exchange.js';
import { canonicalExchangeJson, parseExchangeJson } from './exchange-json.js';
import { claimSource } from './kg-claims.js';
import { obj } from './validation.js';
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
export async function exportBrain(cwd: string, path: string, options: BrainTransferOptions = {}) {
  if (options.manifestPath && !options.exchange)
    throw new BrainError(
      'invalid',
      'A manifest requires --exchange so it can be retained in the archive.',
    );
  const store = brainStore(cwd, options),
    view = store.read(options.signal);
  await new BrainAccess(cwd, view.state.sources, options).all();
  const bundle: BrainBundle = {
    version: 1,
    kind: 'calliope.brain',
    journal: view.journal,
    checksum: checksum(view.journal),
  };
  const manifestFile = options.manifestPath
    ? await readBrainFile(cwd, options.manifestPath, options)
    : undefined;
  const manifest = manifestFile ? parseExchangeJson(manifestFile.original) : null;
  if (manifest !== null && !obj(manifest))
    throw new BrainError('invalid', 'Manifest must be an object.');
  const value = options.exchange
    ? makeExchange(
        bundle as unknown as Record<string, unknown>,
        { id: view.state.header.id, revision: view.state.revision },
        manifest,
      )
    : bundle;
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > BRAIN_LIMITS.journalBytes)
    throw new BrainError('limit', 'Brain export exceeds its byte limit.');
  // Historical records can acquire newly configured secret values; never export unsanitized history.
  if (hasBrainSecrets(value))
    throw new BrainError(
      'policy-denied',
      'Retained history matches current secret material; preserve it privately and export a reviewed sanitized scope.',
    );
  const target = projectFile(cwd, path);
  const receipt = {
    path: target.file,
    checksum: bundle.checksum,
    revision: view.state.revision,
    ...(options.exchange
      ? {
          format: 'brain-exchange/v2',
          manifestHash: manifest ? digest(canonicalExchangeJson(manifest)) : null,
        }
      : {}),
  };
  if (options.preview) return { ...receipt, preview: true };
  await authorizeSessionAction(
    cwd,
    'write_file',
    {
      path: target.file,
      operation: 'brain-export',
      checksum: bundle.checksum,
      digest: digest(content),
      bytes: Buffer.byteLength(content),
    },
    { ...options, confirmation: options.confirmation ?? 'mutating' },
  );
  await new BrainAccess(cwd, view.state.sources, options).all();
  if (manifestFile) {
    await readBrainFile(cwd, options.manifestPath!, options);
    manifestFile.assertUnchanged();
  }
  if (hasBrainSecrets(value))
    throw new BrainError('policy-denied', 'Transfer now matches secret material; preview again.');
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
    // POSIX-only: Windows denies FlushFileBuffers on a directory handle opened via 'r' (#382, #384, #388).
    if (process.platform !== 'win32') {
      const parent = fs.openSync(dirname(target.file), 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
    return receipt;
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

export { exportKnowledgeGraphFile } from './kg-export.js';

/** Imported authority is discarded. Claims are namespaced and staged as proposals for local review. */
export async function importBrain(cwd: string, path: string, options: BrainOptions = {}) {
  const input = await readBrainFile(cwd, path, options, BRAIN_LIMITS.journalBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.original);
  } catch {
    throw new BrainError('invalid', 'Brain import must be a JSON export.');
  }
  const archive =
    obj(parsed) && typeof parsed.format === 'string' && parsed.format.startsWith('brain-exchange/')
      ? parseExchangeArchive(parseExchangeJson(input.original))
      : undefined;
  const bundle = parseBrainBundle(archive?.payload ?? parsed, options.signal),
    origin = replayBrain(bundle.journal, options.signal).state,
    store = brainStore(cwd, options),
    prior = store.read(options.signal);
  if (
    archive &&
    (archive.origin.id !== origin.header.id || archive.origin.revision !== origin.revision)
  )
    throw new BrainError(
      'invalid',
      'Native exchange origin must match its validated journal identity and revision.',
    );
  const access = new BrainAccess(cwd, prior.state.sources, options),
    retainedIds = new Set<string>();
  const retainedRecords: (BrainEntity | BrainEdge)[] = [];
  const namespace = (kind: string, id: string) =>
      'import:' + digest(origin.header.id + ':' + kind + ':' + id),
    changes: BrainChange[] = [];
  let transfer:
    | {
        representation: 'journal-snapshot';
        archiveDigest: string;
        manifestHash: string | null;
        metadataSourceId: string;
      }
    | undefined;
  if (archive) {
    const metadata = {
      format: 'calliope-native-transfer/v1',
      origin: archive.origin,
      manifest: archive.manifest,
      sourceFormat: archive.sourceFormat,
      archiveDigest: archive.sha256,
      history:
        'Native replay validated the source archive. Destination imports active claims; retain the archive for foreign history and reversals.',
    };
    if (hasBrainSecrets(metadata))
      throw new BrainError('policy-denied', 'Native transfer metadata contains secret material.');
    const source = claimSource(
      metadata,
      {
        importedFrom: origin.header.id,
        projectKey: input.project.projectKey,
        path: input.relative,
      },
      [],
    );
    if (prior.state.sources[source.id]) {
      await access.source(source.id);
      retainedIds.add(source.id);
    } else changes.push({ kind: 'source', value: source });
    transfer = {
      representation: 'journal-snapshot',
      archiveDigest: archive.sha256,
      manifestHash: archive.manifest ? digest(canonicalExchangeJson(archive.manifest)) : null,
      metadataSourceId: source.id,
    };
  }
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
    if (previous) {
      await access.source(previous.id);
      retainedIds.add(previous.id);
    }
    if (
      previous &&
      canonicalJson(recordInput(previous)) !==
        canonicalJson({ ...value, locator: previous.locator })
    )
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
        await access.record(previous);
        retainedRecords.push(previous);
        if (canonicalJson(recordInput(previous)) !== canonicalJson(value))
          throw new BrainError(
            'conflict',
            'Import conflicts with retained knowledge or a local correction; review its differences.',
          );
        continue;
      }
      if (prior.state.revisions[kind + ':' + id])
        throw new BrainError(
          'conflict',
          'Native import would restore a locally deleted record; review it in a separate scope.',
        );
      changes.push({
        kind,
        id,
        expected: prior.state.revisions[kind + ':' + id] ?? null,
        value,
      } as BrainChange);
    }
  if (!changes.length)
    return {
      ...prior,
      index: 'unchanged' as const,
      imported: 0,
      origin: origin.header.id,
      ...(transfer ? { transfer } : {}),
    };
  return {
    ...(await commitBrain(
      cwd,
      changes,
      'import',
      'Imported source claims; accepted claims require new local human review.',
      prior,
      options,
      async () => {
        const current = new BrainAccess(cwd, prior.state.sources, options);
        for (const id of retainedIds) await current.source(id);
        for (const record of retainedRecords) await current.record(record);
        await readBrainFile(cwd, path, options, BRAIN_LIMITS.journalBytes);
        if (hasBrainSecrets(changes))
          throw new BrainError(
            'policy-denied',
            'Transfer now matches secret material; review again.',
          );
        input.assertUnchanged();
      },
    )),
    imported: changes.length,
    origin: origin.header.id,
    ...(transfer ? { transfer } : {}),
  };
}

export { importKnowledgeGraph } from './kg-transfer.js';
