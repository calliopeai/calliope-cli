import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalJson, digest } from '../../src/approvals/index.js';
import {
  BrainStore,
  type BrainJournal,
  type BrainChange,
  type SourceInput,
  type EntityInput,
  type EdgeInput,
  type BrainEvent,
} from '../../src/brain/index.js';
export function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-brain-'))),
    cwd = join(root, 'project'),
    base = join(root, 'store');
  fs.mkdirSync(cwd);
  return {
    root,
    cwd,
    base,
    store: new BrainStore(cwd, 'project', base),
    clean: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
export function source(
  id = 'source',
  content = 'The project requires a portable database.',
): SourceInput {
  return {
    id,
    kind: 'human',
    name: 'Review evidence',
    content,
    originalHash: digest(content),
    contentHash: digest(content),
    redacted: false,
    locator: {},
  };
}
export function entity(id = 'document', patch: Partial<EntityInput> = {}): EntityInput {
  return {
    id,
    kind: 'document',
    name: 'Architecture',
    summary: 'Portable storage',
    state: 'accepted',
    confidence: 1,
    provenance: [{ sourceId: 'source', basis: 'observed' }],
    attributes: {},
    ...patch,
  };
}
export function edge(id = 'rel', patch: Partial<EdgeInput> = {}): EdgeInput {
  return {
    id,
    from: 'document',
    to: 'decision',
    type: 'supports',
    state: 'proposed',
    confidence: 0.9,
    provenance: [{ sourceId: 'source', basis: 'observed' }],
    ...patch,
  };
}
export function changes(...entities: EntityInput[]): BrainChange[] {
  return [
    { kind: 'source', value: source() },
    ...entities.map((value) => ({ kind: 'entity' as const, id: value.id, expected: null, value })),
  ];
}
export function emptyJournal(): BrainJournal {
  const header = {
    version: 1 as const,
    id: randomUUID(),
    scope: 'global' as const,
    project: null,
    createdAt: '2026-09-12T00:00:00.000Z',
  };
  return { version: 1, header, events: [], hash: digest(canonicalJson(header)) };
}
export function append(
  journal: BrainJournal,
  changes: BrainChange[],
  extra: Partial<BrainEvent> = {},
): BrainJournal {
  const body = {
    version: 1 as const,
    id: randomUUID(),
    sequence: journal.events.length + 1,
    at: journal.header.createdAt,
    previous: journal.hash,
    actor: 'human' as const,
    reason: 'A deliberate public test change',
    changes,
    reverses: null,
    ...extra,
  };
  const { hash: _, ...payload } = body as BrainEvent;
  const event = { ...payload, hash: digest(canonicalJson(payload)) };
  return { ...journal, events: [...journal.events, event], hash: event.hash };
}
