/** Immutable delta records; messages.json commits the chosen history head. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from '../cancellation.js';
import { assertSessionDirectory, hash, invalid, object, readPrivateSessionFile, SessionRecoveryError, statuses,
  validateMessages, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_MESSAGES, type ConversationState, type ConversationSnapshot, type RecoveryStatus } from './format.js';
import type { Message } from '../types.js';

export interface EventLink { id: string; hash: string; sessionId: string }
export interface SessionEvent extends EventLink {
  version: 1;
  at: string;
  parent: EventLink | null;
  change: { keep: number; append: Message[]; status: RecoveryStatus; droppedMessages: number };
  stateHash: string;
}
export const MAX_HISTORY_EVENTS = 10000;
export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const fields = new Set(['version', 'id', 'hash', 'sessionId', 'at', 'parent', 'change', 'stateHash']);
export const stateHash = (state: Pick<ConversationState, 'messages' | 'status' | 'droppedMessages'>): string =>
  hash(JSON.stringify({ messages: state.messages, status: state.status, droppedMessages: state.droppedMessages }));
export const eventLink = (event: SessionEvent): EventLink => ({ id: event.id, hash: event.hash, sessionId: event.sessionId });

export function validateEvent(value: unknown, sessionId: string): SessionEvent {
  if (!object(value)) throw invalid();
  const event = value as unknown as SessionEvent;
  const link = (value: unknown) => object(value) && Object.keys(value).length === 3 && typeof value.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value.sessionId) && typeof value.id === 'string' && uuid.test(value.id) && typeof value.hash === 'string' && digest.test(value.hash);
  if (Object.keys(value).some(key => !fields.has(key)) || event.version !== 1 || event.sessionId !== sessionId || !/^[a-zA-Z0-9_-]{1,200}$/.test(event.sessionId) ||
    typeof event.id !== 'string' || !uuid.test(event.id) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) ||
    new Date(event.at).toISOString() !== event.at || event.parent !== null && !link(event.parent) ||
    !object(event.change) || Object.keys(event.change).sort().join() !== 'append,droppedMessages,keep,status' ||
    !Number.isSafeInteger(event.change.keep) || event.change.keep < 0 || event.change.keep > MAX_SNAPSHOT_MESSAGES ||
    !Array.isArray(event.change.append) || event.change.append.length > MAX_SNAPSHOT_MESSAGES ||
    !Number.isSafeInteger(event.change.droppedMessages) || event.change.droppedMessages < 0 ||
    !statuses.includes(event.change.status) || !digest.test(event.stateHash) || !digest.test(event.hash)) throw invalid();
  try {
    const { hash: expected, ...body } = event;
    if (hash(JSON.stringify(body)) !== expected) throw invalid();
  } catch { throw invalid(); }
  return event;
}

export function makeEvent(sessionId: string, previous: ConversationState | null, next: ConversationState,
  parent: EventLink | null, id = randomUUID(), at = new Date().toISOString()): SessionEvent {
  validateMessages(next.messages);
  let keep = 0;
  if (previous && parent) while (keep < Math.min(previous.messages.length, next.messages.length) &&
    JSON.stringify(previous.messages[keep]) === JSON.stringify(next.messages[keep])) keep++;
  const body = { version: 1 as const, id, sessionId, at, parent,
    change: { keep, append: next.messages.slice(keep), status: next.status, droppedMessages: next.droppedMessages }, stateHash: stateHash(next) };
  return validateEvent(JSON.parse(JSON.stringify({ ...body, hash: hash(JSON.stringify(body)) })), sessionId);
}

function historyDir(dir: string, create = false): string {
  assertSessionDirectory(dir);
  const target = join(dir, 'events');
  if (create && !fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  if (!fs.lstatSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) throw invalid();
  return target;
}

export function readSessionEvent(dir: string, sessionId: string | undefined, id: string): SessionEvent {
  if (!uuid.test(id)) throw invalid();
  const raw = readPrivateSessionFile(join(historyDir(dir), `${id}.json`), MAX_SNAPSHOT_BYTES + 4096);
  if (raw === null) throw invalid();
  try {
    const data: unknown = JSON.parse(raw);
    if (!object(data) || typeof data.sessionId !== 'string') throw invalid();
    const event = validateEvent(data, sessionId ?? data.sessionId);
    if (event.id !== id) throw invalid();
    return event;
  } catch { throw invalid(); }
}

/** Caller holds messages.lock. Orphans count toward the budget and are never erased. */
export function appendSessionEvents(dir: string, events: SessionEvent[], signal?: AbortSignal): void {
  throwIfCancelled(signal);
  const target = historyDir(dir, true);
  let bytes = 0, count = 0;
  const entries = fs.opendirSync(target);
  try {
    let entry: fs.Dirent | null;
    while ((entry = entries.readSync())) {
      if (!entry.isFile()) throw invalid();
      count++; bytes += fs.lstatSync(join(target, entry.name)).size;
      if (count > MAX_HISTORY_EVENTS || bytes > MAX_HISTORY_BYTES) break;
    }
  } finally { entries.closeSync(); }
  const records = events.map(event => JSON.stringify(validateEvent(event, event.sessionId)));
  if (records.some(text => Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES + 4096) || count + records.length > MAX_HISTORY_EVENTS ||
    bytes + records.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_HISTORY_BYTES)
    throw new SessionRecoveryError('io', 'session history budget reached; create /branch or /new to continue while preserving existing history.');
  for (let index = 0; index < events.length; index++) {
    throwIfCancelled(signal);
    const fd = fs.openSync(join(target, `${events[index]!.id}.json`), 'wx', 0o600);
    try { fs.writeFileSync(fd, records[index]!); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  // NTFS journals directory metadata on commit; on Windows, libuv opens a
  // directory with fs.openSync(dir, 'r') using a read-only (FILE_GENERIC_READ)
  // handle, and FlushFileBuffers on that handle fails with EPERM, so this
  // fsync is POSIX-only (#384).
  if (process.platform !== 'win32') {
    const fd = fs.openSync(target, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

export function applyEvent(previous: ConversationState | null, event: SessionEvent): ConversationSnapshot {
  if ((!previous && event.change.keep !== 0) || event.change.keep > (previous?.messages.length ?? 0)) throw invalid();
  const messages = [...(previous?.messages.slice(0, event.change.keep) ?? []), ...event.change.append];
  validateMessages(messages);
  const body = { version: 1 as const, sessionId: event.sessionId, revision: event.id, updatedAt: event.at,
    status: event.change.status, droppedMessages: event.change.droppedMessages, messages, history: eventLink(event) };
  if (stateHash(body) !== event.stateHash) throw invalid();
  return { ...body, checksum: hash(JSON.stringify(body)) };
}

export interface HistoryReplay { snapshot: ConversationSnapshot; events: SessionEvent[] }
/** Pure deterministic projection; yields so cancellation can interrupt large histories. */
export async function replayEvents(events: SessionEvent[], head: EventLink, sessionId: string, signal?: AbortSignal): Promise<HistoryReplay> {
  if (!events.length || events.length > MAX_HISTORY_EVENTS) throw invalid();
  const byId = new Map<string, SessionEvent>(); let bytes = 0;
  for (const event of events) {
    throwIfCancelled(signal);
    if (!object(event)) throw invalid();
    validateEvent(event, event.sessionId);
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (byId.has(event.id) || bytes > MAX_HISTORY_BYTES) throw invalid();
    byId.set(event.id, event);
    if (byId.size % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  const chain: SessionEvent[] = [], seen = new Set<string>(); let current: EventLink | null = head;
  while (current) {
    throwIfCancelled(signal);
    const event: SessionEvent | undefined = byId.get(current.id);
    if (!event || event.sessionId !== current.sessionId || event.hash !== current.hash || seen.has(event.id)) throw invalid();
    seen.add(event.id); chain.push(event); current = event.parent;
  }
  chain.reverse();
  let snapshot: ConversationSnapshot | null = null;
  for (let index = 0; index < chain.length; index++) {
    throwIfCancelled(signal);
    snapshot = applyEvent(snapshot, chain[index]!);
    if (index % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  throwIfCancelled(signal);
  if (snapshot!.sessionId !== sessionId) {
    const { checksum: _checksum, ...body } = snapshot!;
    body.sessionId = sessionId;
    snapshot = { ...body, checksum: hash(JSON.stringify(body)) };
  }
  return { snapshot: snapshot!, events: chain };
}

export async function replaySessionHistory(dir: string, sessionId: string, head: EventLink, signal?: AbortSignal): Promise<HistoryReplay> {
  const events: SessionEvent[] = [], seen = new Set<string>(); let current: EventLink | null = head, bytes = 0;
  while (current) {
    throwIfCancelled(signal);
    if (seen.has(current.id) || events.length >= MAX_HISTORY_EVENTS) throw invalid();
    const event = readSessionEvent(dir, current.sessionId, current.id);
    if (event.hash !== current.hash) throw invalid();
    bytes += Buffer.byteLength(JSON.stringify(event)); if (bytes > MAX_HISTORY_BYTES) throw invalid();
    events.push(event); seen.add(event.id); current = event.parent;
    if (events.length % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return replayEvents(events, head, sessionId, signal);
}
