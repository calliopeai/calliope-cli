/** Private portable conversations. Digests detect damage; they do not establish trust. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from '../cancellation.js';
import { assertSessionDirectory, hash, invalid, object, readPrivateSessionFile, MAX_SNAPSHOT_BYTES, SessionRecoveryError } from './format.js';
import { appendSessionEvents, replayEvents, MAX_HISTORY_BYTES, type EventLink, type HistoryReplay, type SessionEvent } from './history.js';
import { installToolState, validateToolState, MAX_TOOL_STATE_BYTES, type ToolStateFile } from './tool-state.js';

export const MAX_BUNDLE_BYTES = MAX_HISTORY_BYTES + MAX_TOOL_STATE_BYTES + 1024 * 1024;
export interface SessionBundle {
  version: 1;
  kind: 'calliope-session';
  createdAt: string;
  source: { sessionId: string; revision: string; stateHash: string };
  head: EventLink;
  events: SessionEvent[];
  toolState: ToolStateFile[];
  checksum: string;
}

export function makeBundle(replay: HistoryReplay, toolState: ToolStateFile[]): SessionBundle {
  const body = { version: 1 as const, kind: 'calliope-session' as const, createdAt: new Date().toISOString(),
    source: { sessionId: replay.snapshot.sessionId, revision: replay.snapshot.revision, stateHash: replay.events.at(-1)!.stateHash },
    head: replay.snapshot.history!, events: replay.events, toolState: validateToolState(toolState) };
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) + 80 > MAX_BUNDLE_BYTES) throw invalid();
  return JSON.parse(JSON.stringify({ ...body, checksum: hash(serialized) }));
}

/** Validate the complete projection before creating any destination files. */
export async function parseBundle(text: string, signal?: AbortSignal): Promise<{ bundle: SessionBundle; replay: HistoryReplay }> {
  throwIfCancelled(signal);
  if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES) throw invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (!object(value) || Object.keys(value).sort().join() !== 'checksum,createdAt,events,head,kind,source,toolState,version' ||
    value.version !== 1 || value.kind !== 'calliope-session' || typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
    !object(value.source) || Object.keys(value.source).sort().join() !== 'revision,sessionId,stateHash' ||
    typeof value.source.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.source.sessionId) ||
    !object(value.head) || Object.keys(value.head).sort().join() !== 'hash,id,sessionId' || !Array.isArray(value.events)) throw invalid();
  const { checksum, ...body } = value;
  if (checksum !== hash(JSON.stringify(body))) throw invalid();
  const bundle = value as unknown as SessionBundle;
  validateToolState(bundle.toolState);
  const replay = await replayEvents(bundle.events, bundle.head, bundle.source.sessionId, signal);
  if (replay.events.length !== bundle.events.length || replay.snapshot.revision !== bundle.source.revision ||
    replay.events.at(-1)!.stateHash !== bundle.source.stateHash || Buffer.byteLength(JSON.stringify(replay.snapshot)) > MAX_SNAPSHOT_BYTES) throw invalid();
  return { bundle, replay };
}

/** Fresh inactive destinations only. messages.json is the final commit marker. */
export async function installBundle(dir: string, sessionId: string, text: string, signal?: AbortSignal): Promise<HistoryReplay> {
  const { bundle } = await parseBundle(text, signal);
  const replay = await replayEvents(bundle.events, bundle.head, sessionId, signal);
  assertSessionDirectory(dir);
  const identity = fs.statSync(dir), lock = join(dir, 'messages.lock'), temp = join(dir, `.messages-${randomUUID()}.tmp`);
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new SessionRecoveryError('locked', 'destination is locked; retry into a new session.'); }
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    if (readPrivateSessionFile(join(dir, 'messages.json')) !== null) throw new SessionRecoveryError('conflict', 'import requires a new inactive session.');
    installToolState(dir, bundle.toolState, signal);
    appendSessionEvents(dir, replay.events, signal);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(replay.snapshot)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    throwIfCancelled(signal);
    assertSessionDirectory(dir);
    const current = fs.statSync(dir);
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw invalid();
    // linkSync creates the commit marker exclusively, even against a non-cooperating writer.
    fs.linkSync(temp, join(dir, 'messages.json'));
    return replay;
  } catch (error) {
    if (error instanceof SessionRecoveryError || signal?.aborted) throw error;
    throw new SessionRecoveryError('io', 'import could not be committed; its inactive partial session is preserved. Retry into a new session.');
  } finally {
    fs.closeSync(lockFd);
    try {
      const current = fs.lstatSync(dir);
      if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
        try { fs.unlinkSync(temp); } catch { /* Own temporary file may not exist. */ }
        fs.unlinkSync(lock);
      }
    } catch { /* Preserve files if the destination was replaced. */ }
  }
}
