import { realpathSync } from 'node:fs';
import * as storage from '../storage.js';
import { makeBundle, readToolState, toolStateHash, parseBundle, installBundle, type ConversationState } from '../sessions/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { RunLog } from '../runlog.js';
import { sessionHistory, selectSession } from './actions.js';
import { authorizeSessionAction, type SessionActionOptions } from './permissions.js';
import { readSessionTransfer, writeSessionTransfer } from './files.js';

export async function exportSession(cwd: string, id: string, path: string, options: SessionActionOptions = {}): Promise<string> {
  const session = selectSession(id, cwd), log = options.runlog ?? RunLog.open(session.id);
  const replay = await sessionHistory(session.id, undefined, options.signal);
  const bundle = makeBundle(replay, readToolState(storage.getSessionDirById(session.id)!));
  return writeSessionTransfer(cwd, path, JSON.stringify(bundle) + '\n', { ...options, runlog: log });
}

export async function importSession(cwd: string, path: string, options: SessionActionOptions = {}): Promise<{ session: storage.Session; state: ConversationState }> {
  const root = realpathSync(cwd), text = await readSessionTransfer(root, path, options);
  const { bundle } = await parseBundle(text, options.signal);
  await authorizeSessionAction(root, 'session_import', { path: root, source: bundle.source, checksum: bundle.checksum }, options);
  throwIfCancelled(options.signal);
  const session = storage.createSession(root, { activate: false, lineage: { version: 1, toolStateHash: toolStateHash(bundle.toolState), kind: 'import', ...bundle.source, at: new Date().toISOString() } });
  const log = RunLog.open(session.id);
  try {
    const replay = await installBundle(storage.getSessionDirById(session.id)!, session.id, text, options.signal);
    storage.updateSessionSummary(session.id, replay.snapshot);
    log.policyEvent({ tool: 'session_import', source: 'session-history', decision: 'allow', durationMs: 0,
      reason: `source=${bundle.source.sessionId} revision=${bundle.source.revision} checksum=${bundle.checksum}` });
    return { session: { ...session, messageCount: replay.snapshot.messages.length }, state: replay.snapshot };
  } catch (error) {
    log.policyEvent({ tool: 'session_import', source: 'session-history', decision: 'deny', durationMs: 0, reason: 'Import failed; inactive partial session preserved.' });
    if (options.signal?.aborted) throw error;
    throw new Error(`Import failed; inactive partial session ${session.id} was preserved. Retry into a new session.`);
  } finally { await log.flush(); }
}
