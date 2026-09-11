/** Private recovery snapshots. Audit events must contain only their revision/hash. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import { throwIfCancelled } from '../cancellation.js';
import { makeEvent, eventLink, appendSessionEvents, readSessionEvent, stateHash, type SessionEvent } from './history.js';
import { MAX_SNAPSHOT_BYTES, assertSessionDirectory, hash, invalid, object, readPrivateSessionFile, retainMessages, SessionRecoveryError, statuses, validateMessages, type ConversationState, type ConversationSnapshot, type RecoveryStatus } from './format.js';

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
    if (data.history !== undefined) {
      if (!object(data.history) || data.history.id !== data.revision || typeof data.history.hash !== 'string' || typeof data.history.sessionId !== 'string') throw invalid();
      const event = readSessionEvent(dir, data.history.sessionId, data.revision);
      if (event.hash !== data.history.hash || event.stateHash !== stateHash(data as unknown as ConversationState)) throw invalid();
    }
    return data as unknown as ConversationSnapshot;
  } catch { throw invalid(); }
}

export function writeConversation(dir: string, sessionId: string, messages: Message[], options: {
  expectedRevision: string | null; status: RecoveryStatus; cap?: number; signal?: AbortSignal; droppedMessages?: number;
}): ConversationSnapshot {
  throwIfCancelled(options.signal);
  assertSessionDirectory(dir);
  const identity = fs.statSync(dir);
  validateMessages(messages);
  if (!statuses.includes(options.status) || options.droppedMessages !== undefined && (!Number.isSafeInteger(options.droppedMessages) || options.droppedMessages < 0)) throw invalid();
  const retained = retainMessages(messages, options.cap ?? 1000);
  const body = { version: 1 as const, sessionId, revision: randomUUID(), updatedAt: new Date().toISOString(),
    status: options.status, droppedMessages: (options.droppedMessages ?? 0) + messages.length - retained.length, messages: retained };
  const serialized = JSON.stringify(body);
  let snapshot = { ...JSON.parse(serialized), checksum: hash(serialized) } as ConversationSnapshot;
  if (Buffer.byteLength(JSON.stringify(snapshot)) + 256 > MAX_SNAPSHOT_BYTES) throw new SessionRecoveryError('invalid', 'snapshot exceeds 16 MiB; compact the conversation or start /new.');
  const lock = join(dir, 'messages.lock'), temp = join(dir, `.messages-${randomUUID()}.tmp`);
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new SessionRecoveryError('locked', 'snapshot is locked by another writer; wait for it to finish. Do not remove a live writer’s lock.'); }
  let tempFd: number | undefined;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const previous = readConversation(dir, sessionId);
    if (previous.revision !== options.expectedRevision) throw new SessionRecoveryError('conflict', 'another terminal saved this session; use /resume to reload it or /new before continuing.');
    const events: SessionEvent[] = [];
    let parent = previous.history ?? null;
    if (!parent && previous.revision !== null) {
      const anchor = makeEvent(sessionId, null, previous, null);
      events.push(anchor); parent = eventLink(anchor);
    }
    const event = makeEvent(sessionId, parent ? previous : null, snapshot, parent, body.revision, body.updatedAt);
    events.push(event);
    const committed = { ...JSON.parse(serialized), history: eventLink(event) };
    snapshot = { ...committed, checksum: hash(JSON.stringify(committed)) };
    appendSessionEvents(dir, events, options.signal);
    const text = JSON.stringify(snapshot);
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
