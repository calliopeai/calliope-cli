import { canonicalJson, digest } from '../approvals/index.js';
import { throwIfCancelled } from '../cancellation.js';
import {
  BrainError,
  BRAIN_LIMITS,
  type BrainHeader,
  type BrainEvent,
  type BrainJournal,
  type BrainState,
  type BrainChange,
  type EntityInput,
  type EdgeInput,
  type SourceInput,
} from './types.js';
import { shape, uuid, hash, iso, text, change, invalid, enumValue } from './validation.js';
export function validateHeader(value: unknown): BrainHeader {
  shape(value, ['version', 'id', 'scope', 'project', 'createdAt']);
  if (
    value.version !== 1 ||
    !uuid(value.id) ||
    !iso(value.createdAt) ||
    !enumValue(value.scope, ['project', 'global'])
  )
    invalid();
  if (value.scope === 'global') {
    if (value.project !== null) invalid();
  } else {
    shape(value.project, ['root', 'key']);
    text(value.project.root, 4096);
    if (!hash(value.project.key)) invalid();
  }
  return value as unknown as BrainHeader;
}
export function recordInput<
  T extends { version: 1; createdAt: string; updatedAt: string; revision: string },
>(value: T): Omit<T, 'version' | 'createdAt' | 'updatedAt' | 'revision'> {
  const { version, createdAt, updatedAt, revision, ...input } = value;
  return input;
}
export function validateEvent(value: unknown): BrainEvent {
  shape(value, [
    'version',
    'id',
    'sequence',
    'at',
    'previous',
    'hash',
    'actor',
    'reason',
    'changes',
    'reverses',
  ]);
  if (
    value.version !== 1 ||
    !uuid(value.id) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    !iso(value.at) ||
    !hash(value.previous) ||
    !hash(value.hash) ||
    !enumValue(value.actor, ['human', 'ingest', 'run', 'import', 'reversal']) ||
    (value.reverses !== null && !uuid(value.reverses))
  )
    invalid();
  text(value.reason, 4096);
  if (
    !Array.isArray(value.changes) ||
    !value.changes.length ||
    value.changes.length > BRAIN_LIMITS.changes
  )
    invalid();
  value.changes.forEach(change);
  const keys = value.changes.map((c) => `${c.kind}:${c.kind === 'source' ? c.value.id : c.id}`);
  if (new Set(keys).size !== keys.length) invalid('A batch may change each record only once.');
  const { hash: expected, ...body } = value;
  if (
    Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024 ||
    digest(canonicalJson(body)) !== expected
  )
    invalid('Brain event hash or size is invalid.');
  return value as unknown as BrainEvent;
}
function checkProvenance(
  state: BrainState,
  value: EntityInput | EdgeInput,
  actor: BrainEvent['actor'],
): void {
  for (const p of value.provenance) {
    const source = state.sources[p.sourceId];
    if (!source || (p.excerpt !== undefined && !source.content.includes(p.excerpt)))
      invalid('Knowledge cites missing source evidence or an unverified excerpt.');
  }
  if (
    value.state === 'accepted' &&
    value.provenance.some((p) => p.basis === 'inferred') &&
    !['human', 'reversal'].includes(actor)
  )
    throw new BrainError(
      'policy-denied',
      'Inferred knowledge requires human review before acceptance.',
    );
  if (actor === 'import' && value.state === 'accepted')
    throw new BrainError(
      'policy-denied',
      'Imported acceptance is a source claim; review it locally before accepting.',
    );
}
/** Reversals retain sources and are rejected if later work changed an affected record. */
export function inverseChanges(event: BrainEvent, before: BrainState): BrainChange[] {
  return event.changes
    .filter((c) => c.kind !== 'source')
    .map((c) => {
      const prior = c.kind === 'entity' ? before.entities[c.id] : before.edges[c.id];
      return {
        kind: c.kind,
        id: c.id,
        expected: event.id,
        value: prior ? recordInput(prior) : null,
      } as BrainChange;
    });
}
export function applyEvent(state: BrainState, event: BrainEvent): void {
  for (const c of event.changes)
    if (c.kind === 'source') {
      const prior = state.sources[c.value.id];
      if (prior) {
        if (canonicalJson(recordInput(prior)) !== canonicalJson(c.value))
          throw new BrainError('conflict', 'A source ID cannot replace immutable evidence.');
      } else
        state.sources[c.value.id] = {
          ...structuredClone(c.value),
          version: 1,
          createdAt: event.at,
          updatedAt: event.at,
          revision: event.id,
        };
    }
  for (const c of event.changes)
    if (c.kind !== 'source') {
      const records = c.kind === 'entity' ? state.entities : state.edges,
        prior = records[c.id];
      if ((state.revisions[c.kind + ':' + c.id] ?? null) !== c.expected)
        throw new BrainError(
          'conflict',
          'Knowledge changed; inspect its current revision before writing.',
        );
      state.revisions[c.kind + ':' + c.id] = event.id;
      if (c.value === null) {
        if (!prior) throw new BrainError('conflict', 'Cannot remove absent knowledge.');
        delete records[c.id];
      } else {
        checkProvenance(state, c.value, event.actor);
        const value = {
          ...structuredClone(c.value),
          version: 1 as const,
          createdAt: prior?.createdAt ?? event.at,
          updatedAt: event.at,
          revision: event.id,
        };
        if (c.kind === 'entity') state.entities[c.id] = value as (typeof state.entities)[string];
        else state.edges[c.id] = value as (typeof state.edges)[string];
      }
    }
  for (const edge of Object.values(state.edges))
    if (!state.entities[edge.from] || !state.entities[edge.to])
      throw new BrainError(
        'conflict',
        'A relationship would reference missing knowledge; reverse its dependents first.',
      );
  if (
    Object.keys(state.entities).length > BRAIN_LIMITS.entities ||
    Object.keys(state.edges).length > BRAIN_LIMITS.edges ||
    Object.keys(state.sources).length > BRAIN_LIMITS.sources
  )
    throw new BrainError(
      'limit',
      'Brain record retention reached; preserve or export its history before continuing.',
    );
  state.revision = event.hash;
}
export function replayBrain(
  value: unknown,
  signal?: AbortSignal,
): { journal: BrainJournal; state: BrainState } {
  throwIfCancelled(signal);
  shape(value, ['version', 'header', 'events', 'hash']);
  if (
    value.version !== 1 ||
    !Array.isArray(value.events) ||
    value.events.length > BRAIN_LIMITS.events ||
    !hash(value.hash)
  )
    invalid();
  const header = validateHeader(value.header);
  const state: BrainState = {
      version: 1,
      header,
      revision: digest(canonicalJson(header)),
      sources: Object.create(null),
      entities: Object.create(null),
      edges: Object.create(null),
      revisions: Object.create(null),
    },
    seen = new Set<string>();
  let at = header.createdAt;
  const inverses = new Map<string, BrainChange[]>();
  for (const raw of value.events) {
    throwIfCancelled(signal);
    const event = validateEvent(raw);
    if (
      seen.has(event.id) ||
      event.sequence !== seen.size + 1 ||
      event.previous !== state.revision ||
      event.at < at
    )
      invalid('Broken brain event ancestry.');
    if (event.actor === 'reversal') {
      if (
        !event.reverses ||
        canonicalJson(event.changes) !== canonicalJson(inverses.get(event.reverses) ?? null)
      )
        invalid('Reversal differs from its recorded inverse.');
    } else if (event.reverses !== null) invalid('Only a reversal may cite an inverse event.');
    inverses.set(event.id, inverseChanges(event, state));
    applyEvent(state, event);
    seen.add(event.id);
    at = event.at;
  }
  if (state.revision !== value.hash) invalid('Brain history head differs from its events.');
  return { journal: value as unknown as BrainJournal, state };
}
