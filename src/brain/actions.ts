import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, digest } from '../approvals/index.js';
import { throwIfCancelled } from '../cancellation.js';
import {
  BrainError,
  BRAIN_LIMITS,
  type BrainChange,
  type EntityInput,
  type BrainInspection,
  type BrainSource,
  type EdgeInput,
} from './types.js';
import { recordInput } from './journal.js';
import { entity as validateEntity, edge as validateEdge, text, identifier } from './validation.js';
import {
  brainStore,
  readBrainFile,
  authorizeBrain,
  BrainAccess,
  sanitizeBrainText,
  hasBrainSecrets,
  changeDigest,
  type BrainOptions,
} from './access.js';
import { BrainStore } from './store.js';
async function cache(store: BrainStore, view: BrainInspection, options: BrainOptions) {
  let index;
  try {
    index = await store.index(options.signal);
    if (index.state.revision !== view.state.revision)
      throw new BrainError('conflict', 'A later write is pending index replacement.');
    await store.saveIndex(index, options);
    return { ...view, index: 'current' as const };
  } catch {
    throwIfCancelled(options.signal);
    return { ...view, index: 'rebuild-required' as const };
  } finally {
    index?.close();
  }
}
export async function initBrain(cwd: string, options: BrainOptions = {}) {
  await authorizeBrain(cwd, 'init', {}, options);
  const store = brainStore(cwd, options);
  return cache(store, await store.init(options), options);
}
export async function commitBrain(
  cwd: string,
  changes: BrainChange[],
  actor: 'human' | 'ingest' | 'run' | 'import',
  reason: string,
  prior: BrainInspection,
  options: BrainOptions = {},
  beforeCommit?: () => void,
) {
  if (hasBrainSecrets(changes))
    throw new BrainError(
      'policy-denied',
      'Knowledge change contains secret material outside its sanitized source content.',
    );
  const cleanReason = sanitizeBrainText(reason);
  text(cleanReason);
  const store = brainStore(cwd, options);
  // Approval binds the complete proposal by digest; content never enters the policy log.
  await authorizeBrain(
    cwd,
    'write',
    {
      revision: prior.state.revision,
      changes: changes.length,
      digest: changeDigest(changes),
      actor,
    },
    options,
  );
  const view = await store.append(changes, actor, cleanReason, {
    ...options,
    expectedRevision: prior.state.revision,
    beforeCommit,
  });
  return cache(store, view, options);
}
export async function ingestBrainFile(cwd: string, path: string, options: BrainOptions = {}) {
  const store = brainStore(cwd, options),
    prior = store.read(options.signal),
    input = await readBrainFile(cwd, path, options);
  text(input.content, BRAIN_LIMITS.contentBytes, true);
  const id = 'document:' + digest(input.project.projectKey + ':' + input.relative),
    sourceId =
      'file:' +
      digest(
        input.project.projectKey +
          ':' +
          input.relative +
          ':' +
          input.hash +
          ':' +
          digest(input.content),
      );
  const old = prior.state.entities[id];
  if (old?.provenance.some((p) => p.sourceId === sourceId) && old.state !== 'stale')
    return { ...prior, index: 'unchanged' as const, entityId: id, sourceId, unchanged: true };
  const src = {
    id: sourceId,
    kind: 'file' as const,
    name: sanitizeBrainText(input.relative),
    content: input.content,
    originalHash: input.hash,
    contentHash: digest(input.content),
    redacted: input.redacted,
    locator: { projectKey: input.project.projectKey, path: input.relative },
  };
  const value: EntityInput = {
    id,
    kind: 'document',
    name: sanitizeBrainText(basename(input.relative)),
    summary: `Recorded source document: ${sanitizeBrainText(input.relative)}`,
    state: 'accepted',
    confidence: 1,
    provenance: [{ sourceId, basis: 'observed' }],
    attributes: { path: input.relative, sha256: input.hash, redacted: input.redacted },
  };
  const result = await commitBrain(
    cwd,
    [
      { kind: 'source', value: src },
      { kind: 'entity', id, expected: prior.state.revisions['entity:' + id] ?? null, value },
    ],
    'ingest',
    'Ingested a source snapshot; document contents remain claims of their author.',
    prior,
    options,
    input.assertUnchanged,
  );
  return { ...result, entityId: id, sourceId, unchanged: false };
}
export async function noteBrain(
  cwd: string,
  name: string,
  content: string,
  kind: EntityInput['kind'] = 'decision',
  options: BrainOptions = {},
) {
  const store = brainStore(cwd, options),
    prior = store.read(options.signal),
    clean = sanitizeBrainText(content),
    id = randomUUID(),
    sourceId = randomUUID();
  text(clean, 16384);
  text(name, 512);
  const value = validateEntity({
    id,
    kind,
    name: sanitizeBrainText(name),
    summary: clean,
    state: 'proposed',
    confidence: 1,
    provenance: [{ sourceId, basis: 'observed' }],
    attributes: {},
  });
  const src = {
    id: sourceId,
    kind: 'human' as const,
    name: 'Human knowledge proposal',
    content: clean,
    originalHash: digest(content),
    contentHash: digest(clean),
    redacted: clean !== content,
    locator: {},
  };
  return {
    ...(await commitBrain(
      cwd,
      [
        { kind: 'source', value: src },
        { kind: 'entity', id, expected: null, value },
      ],
      'human',
      'Created a human proposal for review.',
      prior,
      options,
    )),
    entityId: id,
    sourceId,
  };
}
export async function editBrain(
  cwd: string,
  selector: string,
  patch: Partial<Pick<EntityInput, 'name' | 'summary' | 'state' | 'confidence'>>,
  reason: string,
  options: BrainOptions = {},
) {
  const store = brainStore(cwd, options),
    index = await store.index(options.signal);
  let previous;
  try {
    previous = index.entity(selector);
  } finally {
    index.close();
  }
  const prior = store.read(options.signal);
  if (prior.state.entities[previous.id]?.revision !== previous.revision)
    throw new BrainError('conflict', 'Knowledge changed before correction.');
  await new BrainAccess(cwd, prior.state.sources, options).record(previous);
  if (
    !Object.keys(patch).length ||
    Object.keys(patch).some((k) => !['name', 'summary', 'state', 'confidence'].includes(k))
  )
    throw new BrainError('invalid', 'A correction requires name, summary, state or confidence.');
  const sourceId = randomUUID(),
    content = sanitizeBrainText(reason);
  text(content);
  const cleanPatch = {
    ...patch,
    ...(patch.name !== undefined ? { name: sanitizeBrainText(patch.name) } : {}),
    ...(patch.summary !== undefined ? { summary: sanitizeBrainText(patch.summary) } : {}),
  };
  const value = validateEntity({
    ...recordInput(previous),
    ...cleanPatch,
    provenance: [...previous.provenance, { sourceId, basis: 'observed' }],
  });
  const src = {
    id: sourceId,
    kind: 'human' as const,
    name: 'Human correction and review',
    content,
    originalHash: digest(reason),
    contentHash: digest(content),
    redacted: reason !== content,
    locator: {},
  };
  return {
    ...(await commitBrain(
      cwd,
      [
        { kind: 'source', value: src },
        { kind: 'entity', id: value.id, expected: previous.revision, value },
      ],
      'human',
      content,
      prior,
      options,
    )),
    entityId: value.id,
  };
}
export async function linkBrain(
  cwd: string,
  from: string,
  to: string,
  type: string,
  sourceId: string,
  options: BrainOptions = {},
) {
  if (!identifier(type))
    throw new BrainError('invalid', 'Relationship type must be a bounded identifier.');
  const store = brainStore(cwd, options),
    index = await store.index(options.signal);
  let a, b;
  try {
    a = index.entity(from);
    b = index.entity(to);
  } finally {
    index.close();
  }
  const prior = store.read(options.signal),
    access = new BrainAccess(cwd, prior.state.sources, options);
  await access.record(a);
  await access.record(b);
  await access.source(sourceId);
  const id = randomUUID(),
    value: EdgeInput = validateEdge({
      id,
      from: a.id,
      to: b.id,
      type,
      state: 'proposed',
      confidence: 0.5,
      provenance: [{ sourceId, basis: 'inferred' }],
    });
  return {
    ...(await commitBrain(
      cwd,
      [{ kind: 'edge', id, expected: null, value }],
      'human',
      'Proposed an inferred relationship for review.',
      prior,
      options,
    )),
    edgeId: id,
  };
}
export async function reverseBrain(
  cwd: string,
  eventId: string,
  reason: string,
  options: BrainOptions = {},
) {
  const store = brainStore(cwd, options),
    prior = store.read(options.signal);
  await new BrainAccess(cwd, prior.state.sources, options).all();
  await authorizeBrain(cwd, 'reverse', { eventId, revision: prior.state.revision }, options);
  return cache(
    store,
    await store.reverse(eventId, sanitizeBrainText(reason), {
      ...options,
      expectedRevision: prior.state.revision,
    }),
    options,
  );
}
export async function reindexBrain(cwd: string, options: BrainOptions = {}) {
  const store = brainStore(cwd, options),
    prior = store.read(options.signal);
  await authorizeBrain(cwd, 'reindex', { revision: prior.state.revision }, options);
  return cache(store, prior, options);
}
export async function refreshBrain(cwd: string, options: BrainOptions = {}) {
  const store = brainStore(cwd, options),
    prior = store.read(options.signal),
    access = new BrainAccess(cwd, prior.state.sources, options),
    changes: BrainChange[] = [];
  for (const [kind, records] of [
    ['entity', prior.state.entities],
    ['edge', prior.state.edges],
  ] as const)
    for (const record of Object.values(records)) {
      const checked = await access.visible(record);
      if (checked?.effectiveState === 'stale' && record.state !== 'stale')
        changes.push({
          kind,
          id: record.id,
          expected: record.revision,
          value: { ...recordInput(record), state: 'stale' },
        } as BrainChange);
    }
  return changes.length
    ? commitBrain(
        cwd,
        changes,
        'ingest',
        'Recorded stale knowledge after source changes or removal.',
        prior,
        options,
      )
    : { ...prior, index: 'unchanged' as const };
}

export async function editBrainEdge(
  cwd: string,
  id: string,
  patch: Partial<Pick<EdgeInput, 'state' | 'confidence'>>,
  reason: string,
  options: BrainOptions = {},
) {
  const prior = brainStore(cwd, options).read(options.signal),
    previous = prior.state.edges[id];
  if (!previous) throw new BrainError('not-found', 'Unknown relationship ID.');
  const access = new BrainAccess(cwd, prior.state.sources, options);
  await access.record(previous);
  await access.record(prior.state.entities[previous.from]!);
  await access.record(prior.state.entities[previous.to]!);
  if (
    !Object.keys(patch).length ||
    Object.keys(patch).some((k) => !['state', 'confidence'].includes(k))
  )
    throw new BrainError('invalid', 'Relationship review requires state or confidence.');
  const sourceId = randomUUID(),
    content = sanitizeBrainText(reason);
  text(content);
  const value = validateEdge({
    ...recordInput(previous),
    ...patch,
    provenance: [...previous.provenance, { sourceId, basis: 'observed' }],
  });
  const source = {
    id: sourceId,
    kind: 'human' as const,
    name: 'Human relationship review',
    content,
    originalHash: digest(reason),
    contentHash: digest(content),
    redacted: content !== reason,
    locator: {},
  };
  return {
    ...(await commitBrain(
      cwd,
      [
        { kind: 'source', value: source },
        { kind: 'edge', id, expected: previous.revision, value },
      ],
      'human',
      content,
      prior,
      options,
    )),
    edgeId: id,
  };
}
