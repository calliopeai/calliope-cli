/** Private recovery snapshots. Audit events must contain only their revision/hash. */
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import { throwIfCancelled } from '../cancellation.js';

export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_MESSAGES = 10000;
export type RecoveryStatus = 'active' | 'completed' | 'cancelled' | 'interrupted' | 'waiting_for_user';
export interface ConversationState {
  revision: string | null;
  messages: Message[];
  status: RecoveryStatus;
  droppedMessages: number;
}
export interface ConversationSnapshot extends ConversationState {
  version: 1;
  sessionId: string;
  revision: string;
  updatedAt: string;
  checksum: string;
}
export class SessionRecoveryError extends Error {
  constructor(public readonly code: 'invalid' | 'conflict' | 'locked' | 'io', message: string) {
    super(`Session recovery: ${message}`); this.name = 'SessionRecoveryError';
  }
}
const invalid = () => new SessionRecoveryError('invalid', 'invalid or damaged snapshot; preserve the file and start /new or restore a known backup.');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const statuses: RecoveryStatus[] = ['active', 'completed', 'cancelled', 'interrupted', 'waiting_for_user'];

/** Keep protocol-owned JSON opaque, while rejecting lossy or unbounded values. */
export function validateMessages(value: unknown): asserts value is Message[] {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_MESSAGES) throw invalid();
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0, bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 1000000 || item.depth > 64) throw invalid();
    const v = item.value;
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v);
      if (bytes > MAX_SNAPSHOT_BYTES) throw new SessionRecoveryError('invalid', 'snapshot exceeds 16 MiB; compact the conversation or start /new.');
      continue;
    }
    if (v === null || v === undefined || typeof v === 'boolean') continue;
    if (typeof v === 'number' && Number.isFinite(v)) continue;
    if (typeof v !== 'object' || !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) throw invalid();
    for (const child of Object.values(v)) pending.push({ value: child, depth: item.depth + 1 });
  }
  let calls = new Set<string>(), results = new Set<string>();
  for (const m of value) {
    if (!object(m) || !['user', 'assistant', 'system', 'tool'].includes(String(m.role))) throw invalid();
    if (typeof m.content !== 'string' && !(Array.isArray(m.content) && m.content.every(part => object(part) &&
      (part.type === 'text' && typeof part.text === 'string' || part.type === 'image' && typeof part.data === 'string' &&
        ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(part.mediaType)))))) throw invalid();
    if (m.role === 'tool' && (typeof m.toolCallId !== 'string' || !m.toolCallId)) throw invalid();
    if (m.providerMetadata !== undefined && !object(m.providerMetadata)) throw invalid();
    if (m.toolCalls !== undefined && (m.role !== 'assistant' || !Array.isArray(m.toolCalls) || !m.toolCalls.every(call =>
      object(call) && typeof call.id === 'string' && !!call.id && typeof call.name === 'string' && !!call.name && object(call.arguments)))) throw invalid();
    if (Array.isArray(m.toolCalls) && new Set(m.toolCalls.map(call => call.id)).size !== m.toolCalls.length) throw invalid();
    if (m.role === 'tool') {
      if (!calls.has(m.toolCallId as string) || results.has(m.toolCallId as string)) throw invalid();
      results.add(m.toolCallId as string);
    } else {
      calls = new Set((m.toolCalls as Message['toolCalls'])?.map(call => call.id)); results = new Set();
    }
  }
}

/** The count is a soft boundary: retain the initial system message and whole tool groups. */
export function retainMessages(messages: Message[], cap: number): Message[] {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_SNAPSHOT_MESSAGES) throw invalid();
  if (messages.length <= cap) return messages;
  const system = messages[0]?.role === 'system';
  let start = Math.max(system ? 1 : 0, messages.length - Math.max(1, cap - (system ? 1 : 0)));
  while (start > 0 && messages[start]?.role === 'tool') start--;
  return system && start > 0 ? [messages[0]!, ...messages.slice(start)] : messages.slice(start);
}

export function readPrivateSessionFile(file: string, limit = MAX_SNAPSHOT_BYTES): string | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw invalid(); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw invalid();
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0, n = 0;
    while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
    if (size !== stat.size) throw invalid();
    return buffer.subarray(0, size).toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** A session directory must be a real, immediate child of the configured store. */
export function assertSessionDirectory(dir: string): void {
  const root = fs.realpathSync(dirname(dir));
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(fs.realpathSync(dir)) !== root) throw invalid();
}

export function readConversation(dir: string, sessionId: string): ConversationState {
  assertSessionDirectory(dir);
  const raw = readPrivateSessionFile(join(dir, 'messages.json'));
  if (raw === null) return { revision: null, messages: [], status: 'completed', droppedMessages: 0 };
  try {
    const data: unknown = JSON.parse(raw);
    if (Array.isArray(data)) {
      validateMessages(data);
      return { revision: `legacy:${hash(raw)}`, messages: data, status: 'interrupted', droppedMessages: 0 };
    }
    if (!object(data) || data.version !== 1 || data.sessionId !== sessionId || typeof data.revision !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(data.revision) || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) ||
      !statuses.includes(data.status as RecoveryStatus) || !Number.isSafeInteger(data.droppedMessages) || Number(data.droppedMessages) < 0) throw invalid();
    validateMessages(data.messages);
    const { checksum, ...body } = data;
    if (checksum !== hash(JSON.stringify(body))) throw invalid();
    return data as unknown as ConversationSnapshot;
  } catch { throw invalid(); }
}

export function writeConversation(dir: string, sessionId: string, messages: Message[], options: {
  expectedRevision: string | null; status: RecoveryStatus; cap?: number; signal?: AbortSignal;
}): ConversationSnapshot {
  throwIfCancelled(options.signal);
  assertSessionDirectory(dir);
  const identity = fs.statSync(dir);
  validateMessages(messages);
  if (!statuses.includes(options.status)) throw invalid();
  const retained = retainMessages(messages, options.cap ?? 1000);
  const body = { version: 1 as const, sessionId, revision: randomUUID(), updatedAt: new Date().toISOString(),
    status: options.status, droppedMessages: messages.length - retained.length, messages: retained };
  const serialized = JSON.stringify(body);
  const snapshot = { ...JSON.parse(serialized), checksum: hash(serialized) } as ConversationSnapshot;
  const text = JSON.stringify(snapshot);
  if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new SessionRecoveryError('invalid', 'snapshot exceeds 16 MiB; compact the conversation or start /new.');
  const lock = join(dir, 'messages.lock'), temp = join(dir, `.messages-${randomUUID()}.tmp`);
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new SessionRecoveryError('locked', 'snapshot is locked by another writer; wait for it to finish. Do not remove a live writer’s lock.'); }
  let tempFd: number | undefined;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const previous = readConversation(dir, sessionId);
    if (previous.revision !== options.expectedRevision) throw new SessionRecoveryError('conflict', 'another terminal saved this session; use /resume to reload it or /new before continuing.');
    tempFd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(tempFd, text); fs.fsyncSync(tempFd); fs.closeSync(tempFd); tempFd = undefined;
    throwIfCancelled(options.signal);
    assertSessionDirectory(dir);
    const now = fs.statSync(dir);
    if (now.dev !== identity.dev || now.ino !== identity.ino) throw invalid();
    if (readConversation(dir, sessionId).revision !== options.expectedRevision) throw new SessionRecoveryError('conflict', 'snapshot changed during the save; reload with /resume.');
    fs.renameSync(temp, join(dir, 'messages.json'));
    return snapshot;
  } catch (error) {
    if (error instanceof SessionRecoveryError || options.signal?.aborted) throw error;
    throw new SessionRecoveryError('io', 'snapshot could not be saved; check free disk space and session directory permissions before continuing.');
  } finally {
    if (tempFd !== undefined) fs.closeSync(tempFd);
    fs.closeSync(lockFd);
    try {
      const current = fs.lstatSync(dir);
      if (!current.isSymbolicLink() && current.ino === identity.ino && current.dev === identity.dev) {
        try { fs.unlinkSync(temp); } catch { /* Own temporary file may already have been renamed. */ }
        fs.unlinkSync(lock);
      }
    } catch { /* Never clean another directory's files. */ }
  }
}
