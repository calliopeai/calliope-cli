import { realpathSync } from 'node:fs';
import * as storage from '../storage.js';
import type { Message } from '../types.js';
import { eventLink, replaySessionHistory, readSessionEvent, readToolState, installToolState, stateHash, writeConversation, MAX_SNAPSHOT_MESSAGES,
  SessionRecoveryError, validateMessages, toolStateHash, type ConversationState, type HistoryReplay } from '../sessions/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { RunLog } from '../runlog.js';
import { authorizeSessionAction, type SessionActionOptions } from './permissions.js';

export function selectSession(selector: string, cwd: string): storage.Session {
  let session = storage.getSessionById(selector);
  if (!session) {
    const matches = storage.listSessions(10000).filter(item => item.lineage?.name === selector && item.projectPath === cwd);
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous branch name; use its session ID from /sessions.' : 'Session not found; use /sessions.');
    session = matches[0]!;
  }
  if (realpathSync(session.projectPath) !== realpathSync(cwd)) throw new Error(`Session belongs to ${session.projectPath}; open Calliope in that project.`);
  return session;
}

export async function sessionHistory(id: string, revision?: string, signal?: AbortSignal): Promise<HistoryReplay> {
  throwIfCancelled(signal);
  const dir = storage.getSessionDirById(id);
  if (!dir) throw new Error('Session not found; use /sessions.');
  const head = revision ? eventLink(readSessionEvent(dir, undefined, revision)) : storage.readSessionConversation(id).history;
  if (!head) throw new Error('This legacy snapshot has no recorded history yet; resume and save it first.');
  return replaySessionHistory(dir, id, head, signal);
}

export async function branchSession(id: string, options: SessionActionOptions & { name?: string; kind?: 'manual' | 'safety'; messages?: Message[]; expectedRevision?: string | null } = {}): Promise<{ session: storage.Session; state: ConversationState }> {
  if (options.name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(options.name)) throw new Error('Branch names use 1–64 letters, numbers, dots, underscores or hyphens.');
  if (options.messages) {
    validateMessages(options.messages);
    if (options.expectedRevision === undefined) throw new Error('Branching unsaved messages requires the current saved revision.');
  }
  const messages = options.messages ? structuredClone(options.messages) : undefined;
  const source = storage.getSessionById(id);
  if (!source) throw new Error('Source session not found.');
  await authorizeSessionAction(source.projectPath, 'session_branch', { source: id, kind: options.kind ?? 'manual', path: source.projectPath }, options);
  const replay = await sessionHistory(id, undefined, options.signal);
  if (options.expectedRevision !== undefined && replay.snapshot.revision !== options.expectedRevision) throw new SessionRecoveryError('conflict', 'another terminal saved this session; use /resume before branching.');
  const files = readToolState(storage.getSessionDirById(id)!);
  throwIfCancelled(options.signal);
  const session = storage.createSession(source.projectPath, { activate: false, lineage: {
    version: 1, toolStateHash: toolStateHash(files), kind: options.kind ?? 'manual', ...(options.name ? { name: options.name } : {}), sessionId: id,
    revision: replay.snapshot.revision, stateHash: stateHash(replay.snapshot), at: new Date().toISOString(),
  } });
  const dir = storage.getSessionDirById(session.id)!;
  const log = options.runlog ?? RunLog.open(id);
  try {
    installToolState(dir, files, options.signal);
    const state = writeConversation(dir, session.id, messages ?? replay.snapshot.messages, { expectedRevision: null, status: replay.snapshot.status, signal: options.signal, cap: MAX_SNAPSHOT_MESSAGES, droppedMessages: messages && JSON.stringify(messages) !== JSON.stringify(replay.snapshot.messages) ? 0 : replay.snapshot.droppedMessages });
    storage.updateSessionSummary(session.id, state);
    log.policyEvent({ tool: 'session_branch', source: 'session-history', decision: 'allow', durationMs: 0,
      reason: `kind=${options.kind ?? 'manual'} destination=${session.id} sourceRevision=${replay.snapshot.revision} revision=${state.revision} toolStateHash=${session.lineage!.toolStateHash}` });
    return { session: { ...session, messageCount: state.messages.length }, state };
  } catch (error) {
    log.policyEvent({ tool: 'session_branch', source: 'session-history', decision: 'deny', durationMs: 0, reason: `Incomplete inactive branch preserved: ${session.id}` });
    throw error;
  } finally { await log.flush(); }
}

export function compareConversations(before: ConversationState, after: ConversationState) {
  let commonMessages = 0;
  while (commonMessages < Math.min(before.messages.length, after.messages.length) &&
    JSON.stringify(before.messages[commonMessages]) === JSON.stringify(after.messages[commonMessages])) commonMessages++;
  return { version: 1, before: before.revision, after: after.revision, commonMessages,
    removed: before.messages.slice(commonMessages), added: after.messages.slice(commonMessages),
    status: { before: before.status, after: after.status } };
}
