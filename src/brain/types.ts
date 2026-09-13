export const ENTITY_KINDS = [
  'document',
  'decision',
  'requirement',
  'task',
  'risk',
  'dependency',
  'stakeholder',
  'provider',
  'agent',
  'artifact',
  'test_evidence',
  'run',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export type KnowledgeState = 'proposed' | 'accepted' | 'rejected' | 'stale';
export type KnowledgeBasis = 'observed' | 'inferred';
export interface Provenance {
  sourceId: string;
  basis: KnowledgeBasis;
  excerpt?: string;
}
export interface SourceLocator {
  projectKey?: string;
  path?: string;
  runId?: string;
  eventId?: string;
  importedFrom?: string;
}
/** Original claims retained through a bounded sequence of explicit transfers. */
export interface KnowledgeOrigin {
  brainId: string;
  recordId: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  checksum: string;
  state?: KnowledgeState;
  confidence?: number;
  sourceKind?: SourceInput['kind'];
  locator?: SourceLocator;
}
export interface SourceInput {
  id: string;
  kind: 'file' | 'run' | 'human' | 'import';
  name: string;
  content: string;
  originalHash: string;
  contentHash: string;
  redacted: boolean;
  locator: SourceLocator;
  origins?: KnowledgeOrigin[];
}
export interface EntityInput {
  id: string;
  kind: EntityKind;
  name: string;
  summary: string;
  state: KnowledgeState;
  confidence: number;
  provenance: Provenance[];
  attributes: Record<string, string | number | boolean | null>;
  origins?: KnowledgeOrigin[];
}
export interface EdgeInput {
  id: string;
  from: string;
  to: string;
  type: string;
  state: KnowledgeState;
  confidence: number;
  provenance: Provenance[];
  origins?: KnowledgeOrigin[];
}
export interface RecordStamp {
  version: 1;
  createdAt: string;
  updatedAt: string;
  revision: string;
}
export type BrainSource = SourceInput & RecordStamp;
export type BrainEntity = EntityInput & RecordStamp;
export type BrainEdge = EdgeInput & RecordStamp;
export type BrainChange =
  | { kind: 'source'; value: SourceInput }
  | { kind: 'entity'; id: string; expected: string | null; value: EntityInput | null }
  | { kind: 'edge'; id: string; expected: string | null; value: EdgeInput | null };
export interface BrainHeader {
  version: 1;
  id: string;
  scope: 'project' | 'global';
  project: { root: string; key: string } | null;
  createdAt: string;
}
export interface BrainEvent {
  version: 1;
  id: string;
  sequence: number;
  at: string;
  previous: string;
  hash: string;
  actor: 'human' | 'ingest' | 'run' | 'import' | 'reversal';
  reason: string;
  changes: BrainChange[];
  reverses: string | null;
}
export interface BrainJournal {
  version: 1;
  header: BrainHeader;
  events: BrainEvent[];
  hash: string;
}
export interface BrainState {
  version: 1;
  header: BrainHeader;
  revision: string;
  sources: Record<string, BrainSource>;
  entities: Record<string, BrainEntity>;
  edges: Record<string, BrainEdge>;
  revisions: Record<string, string>;
}
export interface BrainInspection {
  journal: BrainJournal;
  state: BrainState;
}
export class BrainError extends Error {
  constructor(
    readonly code: 'invalid' | 'conflict' | 'unavailable' | 'limit' | 'policy-denied' | 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'BrainError';
  }
}
export const BRAIN_LIMITS = {
  journalBytes: 64 * 1024 * 1024,
  indexBytes: 64 * 1024 * 1024,
  events: 10000,
  entities: 10000,
  edges: 30000,
  sources: 5000,
  changes: 256,
  contentBytes: 128 * 1024,
  sourceBytes: 512 * 1024,
  results: 100,
  queryTokens: 16,
  queryBytes: 4096,
  depth: 16,
} as const;
