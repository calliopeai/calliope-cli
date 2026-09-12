import { canonicalJson, digest } from '../approvals/index.js';
import {
  BrainError,
  ENTITY_KINDS,
  BRAIN_LIMITS,
  type SourceInput,
  type EntityInput,
  type EdgeInput,
  type Provenance,
  type BrainChange,
} from './types.js';
export function invalid(message = 'Invalid brain record or schema.'): never {
  throw new BrainError('invalid', message);
}
export const obj = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export function shape(
  v: unknown,
  required: string[],
  optional: string[] = [],
): asserts v is Record<string, unknown> {
  if (
    !obj(v) ||
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => ![...required, ...optional].includes(k))
  )
    invalid();
}
export function text(v: unknown, max = 4096, empty = false): asserts v is string {
  if (
    typeof v !== 'string' ||
    (!empty && !v.trim()) ||
    Buffer.byteLength(v) > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)
  )
    invalid('Invalid or oversized brain text.');
}
export const identifier = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
export const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
export const iso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function provenance(value: unknown): Provenance[] {
  if (!Array.isArray(value) || !value.length || value.length > 32)
    invalid('Knowledge requires bounded source provenance.');
  for (const p of value) {
    shape(p, ['sourceId', 'basis'], ['excerpt']);
    if (!identifier(p.sourceId) || !['observed', 'inferred'].includes(String(p.basis))) invalid();
    if (p.excerpt !== undefined) text(p.excerpt, 4096);
  }
  if (new Set(value.map((v) => canonicalJson(v))).size !== value.length)
    invalid('Duplicate provenance.');
  return value as Provenance[];
}
function origins(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 8)
    invalid('Knowledge transfer ancestry is limited to eight origins.');
  for (const item of value) {
    shape(
      item,
      ['brainId', 'recordId', 'revision', 'createdAt', 'updatedAt', 'checksum'],
      ['state', 'confidence', 'sourceKind', 'locator'],
    );
    if (
      !uuid(item.brainId) ||
      !identifier(item.recordId) ||
      !uuid(item.revision) ||
      !iso(item.createdAt) ||
      !iso(item.updatedAt) ||
      !hash(item.checksum)
    )
      invalid('Invalid knowledge origin.');
    if (
      item.state !== undefined &&
      !['proposed', 'accepted', 'rejected', 'stale'].includes(String(item.state))
    )
      invalid();
    if (
      item.confidence !== undefined &&
      (typeof item.confidence !== 'number' ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1)
    )
      invalid();
    if (
      item.sourceKind !== undefined &&
      !['file', 'run', 'human', 'import'].includes(String(item.sourceKind))
    )
      invalid();
    if (item.locator !== undefined) {
      shape(item.locator, [], ['projectKey', 'path', 'runId', 'eventId', 'importedFrom']);
      for (const textValue of Object.values(item.locator)) text(textValue, 4096);
    }
  }
}
function knowledge(v: Record<string, unknown>): void {
  if (
    !identifier(v.id) ||
    !['proposed', 'accepted', 'rejected', 'stale'].includes(String(v.state)) ||
    typeof v.confidence !== 'number' ||
    !Number.isFinite(v.confidence) ||
    v.confidence < 0 ||
    v.confidence > 1
  )
    invalid();
  provenance(v.provenance);
  origins(v.origins);
}
export function source(value: unknown): SourceInput {
  shape(
    value,
    ['id', 'kind', 'name', 'content', 'originalHash', 'contentHash', 'redacted', 'locator'],
    ['origins'],
  );
  origins(value.origins);
  if (
    !identifier(value.id) ||
    !['file', 'run', 'human', 'import'].includes(String(value.kind)) ||
    !hash(value.originalHash) ||
    !hash(value.contentHash) ||
    typeof value.redacted !== 'boolean'
  )
    invalid();
  text(value.name, 512);
  text(value.content, BRAIN_LIMITS.contentBytes, true);
  if (
    digest(value.content) !== value.contentHash ||
    (!value.redacted && value.originalHash !== value.contentHash)
  )
    invalid('Source content differs from its recorded hash.');
  shape(value.locator, [], ['projectKey', 'path', 'runId', 'eventId', 'importedFrom']);
  for (const item of Object.values(value.locator)) text(item, 4096);
  if (value.locator.projectKey !== undefined && !hash(value.locator.projectKey))
    invalid('Invalid source project identity.');
  if (
    value.locator.path !== undefined &&
    (typeof value.locator.path !== 'string' ||
      value.locator.path.startsWith('/') ||
      value.locator.path.includes('\\') ||
      value.locator.path.split('/').some((p) => !p || p === '.' || p === '..'))
  )
    invalid('Source path must be relative to its original project.');
  if (
    (value.kind === 'file' &&
      (!hash(value.locator.projectKey) || typeof value.locator.path !== 'string')) ||
    (value.kind === 'run' && (!uuid(value.locator.runId) || !uuid(value.locator.eventId)))
  )
    invalid('Source locator is incomplete.');
  return value as unknown as SourceInput;
}
export function entity(value: unknown): EntityInput {
  shape(
    value,
    ['id', 'kind', 'name', 'summary', 'state', 'confidence', 'provenance', 'attributes'],
    ['origins'],
  );
  knowledge(value);
  if (!ENTITY_KINDS.includes(value.kind as never)) invalid('Unknown entity kind.');
  text(value.name, 512);
  text(value.summary, 16384, true);
  if (!obj(value.attributes) || Object.keys(value.attributes).length > 64) invalid();
  for (const [key, item] of Object.entries(value.attributes)) {
    text(key, 128);
    if (typeof item === 'string') text(item, 4096, true);
    else if (
      item !== null &&
      typeof item !== 'boolean' &&
      (typeof item !== 'number' || !Number.isFinite(item))
    )
      invalid();
  }
  return value as unknown as EntityInput;
}
export function edge(value: unknown): EdgeInput {
  shape(value, ['id', 'from', 'to', 'type', 'state', 'confidence', 'provenance'], ['origins']);
  knowledge(value);
  if (!identifier(value.from) || !identifier(value.to) || !identifier(value.type))
    invalid('Invalid relationship endpoints or type.');
  return value as unknown as EdgeInput;
}
export function change(value: unknown): BrainChange {
  shape(value, ['kind', 'value'], ['id', 'expected']);
  if (value.kind === 'source') {
    shape(value, ['kind', 'value']);
    source(value.value);
  } else {
    shape(value, ['kind', 'id', 'expected', 'value']);
    if (
      !['entity', 'edge'].includes(String(value.kind)) ||
      !identifier(value.id) ||
      (value.expected !== null && !uuid(value.expected))
    )
      invalid();
    if (value.value !== null) {
      const item = value.kind === 'entity' ? entity(value.value) : edge(value.value);
      if (item.id !== value.id) invalid('Change ID differs from its record.');
    }
  }
  return value as unknown as BrainChange;
}
