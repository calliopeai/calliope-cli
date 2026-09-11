/** A separate versioned headless contract; existing audit `calliope replay` is unchanged. */
import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import * as storage from '../storage.js';
import { isCancellation, throwIfCancelled } from '../cancellation.js';
import { SessionRecoveryError, readToolOutputs } from '../sessions/index.js';
import { branchSession, compareConversations, selectSession, sessionHistory } from './actions.js';
import { exportSession, importSession } from './transfer.js';
import { SessionPolicyError, type SessionActionOptions } from './permissions.js';
import { conversationMarkdown } from './presentation.js';

export const SESSION_USAGE = 'calliope session list | status <id|name> | replay <id|name> [revision] | branch <id|name> [name] | diff <before> <after> | outputs <id|name> [output-id] | export <id|name> <file.json> | import <file.json> [--json]';
export interface SessionReport {
  version: 1; type: 'session'; action: string; localOnly: true;
  data?: unknown;
  error?: { code: 'invalid-arguments' | 'cancelled' | 'policy-denied' | 'invalid-session' | 'operation-failed'; message: string };
}
export async function sessionCommand(args: string[], options: SessionActionOptions & { cwd?: string } = {}): Promise<{ report: SessionReport; exitCode: number }> {
  let action = 'unknown';
  const failure = (code: NonNullable<SessionReport['error']>['code'], message: string, exitCode: number) => ({ exitCode,
    report: { version: 1 as const, type: 'session' as const, action, localOnly: true as const, error: { code, message } } });
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }));
    action = positionals[0] ?? 'list';
    const count = positionals.length ? positionals.length - 1 : 0;
    const arities: Record<string, number[]> = { list: [0], status: [1], replay: [1, 2], outputs: [1, 2], branch: [1, 2], diff: [2], export: [2], import: [1] };
    if (!Object.hasOwn(arities, action) || !arities[action]!.includes(count) || positionals.some(value => value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)))
      return failure('invalid-arguments', SESSION_USAGE, 2);
  } catch { return failure('invalid-arguments', SESSION_USAGE, 2); }
  try {
    throwIfCancelled(options.signal);
    const cwd = realpathSync(options.cwd ?? process.cwd());
    let data: unknown;
    if (action === 'list') data = { sessions: storage.listSessions(10000).filter(session => session.projectPath === cwd) };
    else if (action === 'import') {
      const imported = await importSession(cwd, positionals[1]!, options);
      data = { session: imported.session, revision: imported.state.revision, status: imported.state.status, messageCount: imported.state.messages.length };
    } else {
      const session = selectSession(positionals[1]!, cwd);
      if (action === 'status') {
        const state = storage.readSessionConversation(session.id);
        data = { session, revision: state.revision, status: state.status, messageCount: state.messages.length, droppedMessages: state.droppedMessages, history: state.history ?? null };
      } else if (action === 'outputs') {
        const saved = readToolOutputs(storage.getSessionDirById(session.id)!);
        const record = positionals[2] ? saved.records.find(record => record.id === positionals[2]) : undefined;
        if (positionals[2] && !record) throw new Error('Tool output not retained.');
        data = { sessionId: session.id, dropped: saved.dropped, ...(record ? { record } : { records: saved.records.map(({ content: _content, ...record }) => record) }) };
      } else if (action === 'replay') {
        const replay = await sessionHistory(session.id, positionals[2], options.signal);
        data = { sessionId: session.id, ...replay };
      } else if (action === 'branch') {
        const branch = await branchSession(session.id, { ...options, name: positionals[2] });
        data = { session: branch.session, revision: branch.state.revision };
      } else if (action === 'diff') data = compareConversations(storage.readSessionConversation(session.id), storage.readSessionConversation(selectSession(positionals[2]!, cwd).id));
      else data = { path: await exportSession(cwd, session.id, positionals[2]!, options) };
    }
    return { report: { version: 1, type: 'session', action, localOnly: true, data }, exitCode: 0 };
  } catch (error) {
    if (options.signal?.aborted || isCancellation(error)) return failure('cancelled', 'Session operation cancelled; existing history is preserved.', 130);
    if (error instanceof SessionPolicyError) return failure('policy-denied', error.message, 3);
    if (error instanceof SessionRecoveryError) return failure('invalid-session', error.message, 1);
    // Errors from host I/O or untrusted data must not echo private payloads to CI.
    return failure('operation-failed', 'Session operation failed; check the session ID, project, file path and audit log, then retry.', 1);
  }
}

export async function runSessionCommand(args: string[], options: SessionActionOptions & { cwd?: string; write?: (text: string) => void } = {}): Promise<number> {
  const { report, exitCode } = await sessionCommand(args, options);
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  if (args.includes('--json')) write(JSON.stringify(report) + '\n');
  else if (report.error) write(report.error.message + '\n');
  else if (report.action === 'replay') {
    const replay = report.data as Awaited<ReturnType<typeof sessionHistory>>;
    write(`Recorded conversation ${replay.snapshot.revision}; ${replay.events.length} events verified. No tools executed.\n${conversationMarkdown(replay.snapshot.messages)}`);
  } else write(JSON.stringify(report.data, null, 2) + '\n');
  return exitCode;
}
