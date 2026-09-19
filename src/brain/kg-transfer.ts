import { digest } from '../approvals/index.js';
import { brainStore, BrainAccess, readBrainFile, hasBrainSecrets } from './access.js';
import { commitBrain } from './actions.js';
import { parseExchangeJson, canonicalExchangeJson } from './exchange-json.js';
import { archiveGraph, parseExchangeArchive, type BrainTransferOptions } from './exchange.js';
import { parseKnowledgeGraph } from './kg.js';
import {
  graphOrigin,
  edgeIdentities,
  graphNamespace,
  claimSource,
  projectClaim,
} from './kg-claims.js';
import { recordInput } from './journal.js';
import { BrainTransferError, type TransferReport } from './transfer-report.js';
import {
  BrainError,
  BRAIN_LIMITS,
  type BrainChange,
  type BrainEntity,
  type BrainEdge,
  type SourceInput,
} from './types.js';
import { obj, text } from './validation.js';

/** Normal journal transaction; a transfer's metadata never authorizes a write. */
export async function importKnowledgeGraph(
  cwd: string,
  path: string,
  options: BrainTransferOptions = {},
) {
  const input = await readBrainFile(cwd, path, options, BRAIN_LIMITS.journalBytes);
  const parsed = parseExchangeJson(input.original);
  const archive =
    obj(parsed) && typeof parsed.format === 'string' && parsed.format.startsWith('brain-exchange/')
      ? parseExchangeArchive(parsed)
      : undefined;
  const graph = archive ? archiveGraph(archive) : parseKnowledgeGraph(parsed);
  const origin = graphOrigin(graph, archive, options.origin),
    edgeIds = edgeIdentities(graph);
  const prior = brainStore(cwd, options).read(options.signal);
  const report: TransferReport = {
    format: 'calliope-brain-transfer-report/v1',
    operation: 'import',
    representation: 'graph-projection',
    origin,
    destinationRevision: prior.state.revision,
    manifestHash: archive?.manifest ? digest(canonicalExchangeJson(archive.manifest)) : null,
    losses: [
      {
        code: 'graph-history',
        message:
          'A graph snapshot cannot restore journal history, tombstones or reversals. Use a native bundle to preserve history.',
      },
    ],
    mappings: [],
    conflicts: 0,
    changes: 0,
  };
  const locator = {
    projectKey: input.project.projectKey,
    path: input.relative,
    importedFrom: origin.id,
  };
  const envelope =
    archive?.sourceFormat === 'compiled-brain/v1'
      ? Object.fromEntries(
          Object.entries(archive.payload).filter(([key]) => !['nodes', 'edges'].includes(key)),
        )
      : null;
  const metadata = claimSource(
    {
      format: 'calliope-kg-transfer/v1',
      origin,
      sourceFormat:
        archive?.sourceFormat === 'compiled-brain/v1' ? archive.sourceFormat : 'conflict-kg/v1',
      manifest: archive?.manifest ?? null,
      envelope,
    },
    locator,
    report.losses,
  );
  report.metadataSourceId = metadata.id;
  const changes: BrainChange[] = [],
    retainedIds = new Set<string>(),
    plannedSources = new Set<string>();
  const records: (BrainEntity | BrainEdge)[] = [];
  const access = new BrainAccess(cwd, prior.state.sources, options);
  const addSource = async (source: SourceInput) => {
    const old = prior.state.sources[source.id];
    if (old) {
      await access.source(old.id);
      retainedIds.add(old.id);
      if (old.content !== source.content || old.originalHash !== source.originalHash)
        throw new BrainError(
          'conflict',
          'Retained transfer source differs from its content identity.',
        );
    } else if (!plannedSources.has(source.id)) {
      plannedSources.add(source.id);
      if (Object.keys(prior.state.sources).length + plannedSources.size > BRAIN_LIMITS.sources)
        throw new BrainError(
          'limit',
          'Import would exceed native source retention; preserve history before continuing.',
        );
      changes.push({ kind: 'source', value: source });
    }
  };
  await addSource(metadata);
  for (const [kind, externalId, record] of [
    ...graph.nodes.map((node) => ['entity', node.id, node] as const),
    ...graph.edges.map((edge, index) => ['edge', edgeIds[index]!, edge] as const),
  ]) {
    text(externalId, 512);
    const source = claimSource(
      {
        format: 'calliope-kg-claim/v1',
        originId: origin.id,
        kind,
        externalId,
        record,
      },
      locator,
      report.losses,
    );
    const value = projectClaim(
      kind,
      externalId,
      record,
      origin.id,
      [source.id, metadata.id],
      report.losses,
    );
    const id = graphNamespace(origin.id, kind, externalId);
    const old = kind === 'entity' ? prior.state.entities[id] : prior.state.edges[id];
    const expected = prior.state.revisions[kind + ':' + id] ?? null;
    if (old) {
      await access.record(old);
      records.push(old);
    }
    const equal = old && canonicalExchangeJson(recordInput(old)) === canonicalExchangeJson(value);
    const status = equal ? 'unchanged' : old ? 'conflict' : expected ? 'deleted' : 'new';
    report.mappings.push({ kind, externalId, localId: id, status });
    if (status === 'conflict' || status === 'deleted') report.conflicts++;
    await addSource(source);
    if (!equal) changes.push({ kind, id, expected, value } as BrainChange);
  }
  report.changes = changes.length;
  if (hasBrainSecrets(report))
    throw new BrainError('policy-denied', 'Transfer report identifiers contain secret material.');
  for (const kind of ['entity', 'edge'] as const) {
    const table = kind === 'entity' ? 'entities' : 'edges';
    const added = report.mappings.filter(
      (mapping) => mapping.kind === kind && ['new', 'deleted'].includes(mapping.status),
    ).length;
    if (Object.keys(prior.state[table]).length + added > BRAIN_LIMITS[table])
      throw new BrainError(
        'limit',
        'Import would exceed native graph retention; preserve history before continuing.',
      );
  }
  if (options.preview)
    return {
      ...prior,
      index: 'unchanged' as const,
      preview: true,
      imported: 0,
      unchanged: !changes.length,
      report,
    };
  if (options.reconcileRevision !== undefined && options.reconcileRevision !== prior.state.revision)
    throw new BrainTransferError(
      'conflict',
      'The reviewed destination revision is stale; preview the transfer again.',
      report,
    );
  if (report.conflicts && !options.reconcileRevision)
    throw new BrainTransferError(
      'conflict',
      'Existing source claims, local corrections or deletions differ; preview and explicitly reconcile the destination revision.',
      report,
    );
  if (!changes.length)
    return {
      ...prior,
      index: 'unchanged' as const,
      preview: false,
      imported: 0,
      unchanged: true,
      report,
    };
  if (report.losses.length && !options.allowLoss)
    throw new BrainTransferError(
      'invalid',
      'Review the transfer report and pass --allow-loss to acknowledge the projection limits.',
      report,
    );
  const result = await commitBrain(
    cwd,
    changes,
    'import',
    'Imported foreign source claims as inferred proposals; metadata grants no authority.',
    prior,
    options,
    async () => {
      // Approval may have waited while source policy, secrets or the input changed.
      const currentAccess = new BrainAccess(cwd, prior.state.sources, options);
      for (const id of retainedIds) await currentAccess.source(id);
      for (const record of records) await currentAccess.record(record);
      await readBrainFile(cwd, path, options, BRAIN_LIMITS.journalBytes);
      if (hasBrainSecrets(changes))
        throw new BrainError(
          'policy-denied',
          'Transfer claims now match secret material; preview again.',
        );
      input.assertUnchanged();
    },
  );
  return {
    ...result,
    preview: false,
    imported: changes.length,
    unchanged: false,
    report,
  };
}
