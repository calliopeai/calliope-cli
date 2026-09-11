import { randomUUID } from 'node:crypto';
import { branchSession, selectSession, sessionHistory, compareConversations, exportSession, importSession, writeSessionTransfer, conversationMarkdown, messageText } from '../session-management/index.js';
import * as storage from '../storage.js';
import { completePendingTools } from '../runtime/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { getSystemPromptForProvider } from '../local-model.js';
import { buildMemoryContext } from '../memory.js';
import { RunLog } from '../runlog.js';
import type { CommandContext } from './commands.js';
import type { Message } from '../types.js';

export async function handleSessionCommand(parts: string[], ctx: CommandContext): Promise<void> {
  throwIfCancelled(ctx.signal);
  parts = [parts[0]!.toLowerCase(), ...parts.slice(1)];
  if (parts[0] === '/sessions') {
    if (parts.length !== 1) throw new Error('Usage: /sessions');
    const sessions = storage.listSessions(50);
    ctx.addMessage('system', sessions.length ? sessions.map(session =>
      `${session.id === ctx.sessionRef.current?.id ? '* ' : ''}${session.id}${session.lineage?.name ? ` (${session.lineage.name})` : ''}${session.lineage?.kind === 'safety' ? ' [safety branch]' : ''} | ${session.projectName} | ${session.messageCount} messages | ${session.lastAccessedAt}`).join('\n') : 'No saved sessions. Use /new.');
    return;
  }
  if (ctx.isProcessing || ctx.loopActive) throw new Error('Cancel the active turn and wait for it to stop before switching sessions.');
  const command = parts[0]!;
  if (!['/export', '/import'].includes(command) && (parts.length > (command === '/new' ? 1 : 2) ||
    ['/checkout', '/diff'].includes(command) && parts.length !== 2)) throw new Error(`Usage: ${command}${command === '/new' ? '' : ' [sessionId or name]'}`);
  const cwd = ctx.sessionRef.current?.projectPath ?? process.cwd();
  const active = ctx.sessionRef.current;
  const options = { signal: ctx.signal, mode: ctx.mode };
  const persistCurrent = () => {
    if (!active || !ctx.conversationCursor?.current || ctx.conversationCursor.current.sessionId !== active.id) throw new Error('No active recovery cursor; use /resume or /new.');
    const current = storage.readSessionConversation(active.id);
    if (current.revision === ctx.conversationCursor.current.revision && current.history && JSON.stringify(current.messages) === JSON.stringify(ctx.llmMessages.current)) return current;
    const saved = storage.saveSessionConversation(active.id, ctx.llmMessages.current, { expectedRevision: ctx.conversationCursor.current.revision, status: 'completed', signal: ctx.signal });
    ctx.conversationCursor.current.revision = saved.revision;
    return saved;
  };
  if (command === '/export' || command === '/import') {
    const path = parts.slice(1).join(' ').replace(/^(["'])(.*)\1$/, '$2') || (command === '/export' ? `calliope-session-${Date.now()}.json` : '');
    if (!path) throw new Error('Usage: /import <session.json>');
    if (command === '/import') {
      const imported = await importSession(cwd, path, options);
      ctx.addMessage('system', `Imported private conversation as ${imported.session.id}. Use /checkout ${imported.session.id} to continue; current session remains active.`);
    } else {
      if (!active) throw new Error('No active session; use /new.');
      // Persist in-memory edits (such as undo) before exporting recorded history.
      if (ctx.mode === 'plan') throw new Error('Plan mode: session export writes a file; switch mode before exporting.');
      const state = persistCurrent();
      const file = path.endsWith('.md') ? await writeSessionTransfer(cwd, path, conversationMarkdown(state.messages), options) : await exportSession(cwd, active.id, path, options);
      ctx.addMessage('system', `Exported private conversation to ${file}${path.endsWith('.md') ? ' (readable markdown; use .json for importable history)' : ' (includes recorded history and current tool state)'}.`);
    }
    return;
  }
  if (command === '/replay' || command === '/diff') {
    if (!active) throw new Error('No active session; use /new.');
    if (command === '/replay') {
      const replay = await sessionHistory(active.id, parts[1], ctx.signal);
      const visible = replay.snapshot.messages.filter(message => message.role !== 'system').map(message => `[${message.role}] ${messageText(message)}`).join('\n');
      ctx.addMessage('system', `Recorded conversation at ${replay.snapshot.revision}; ${replay.events.length} events verified. No tools executed.\n${visible.slice(0, 32000)}${visible.length > 32000 ? '\n[Display limited to 32,000 characters; export JSON for the full history.]' : ''}`);
    } else {
      const before = storage.readSessionConversation(selectSession(parts[1]!, cwd).id);
      const diff = compareConversations(before, { revision: ctx.conversationCursor?.current?.revision ?? null, messages: ctx.llmMessages.current, status: 'completed', droppedMessages: 0 });
      ctx.addMessage('system', `Conversation diff: ${diff.commonMessages} common messages, ${diff.removed.length} removed, ${diff.added.length} added. Workspace files are unchanged.\n${JSON.stringify(diff, null, 2).slice(0, 32000)}`);
    }
    return;
  }
  let session: storage.Session;
  let messages: Message[];
  let revision: string | null;
  let notice: string;
  if (parts[0] === '/new') {
    const context = buildMemoryContext(cwd);
    messages = [{ role: 'system', content: getSystemPromptForProvider(ctx.actualProvider) + (context.trim() ? `\n\n--- Project Context ---\n${context}` : '') }];
    throwIfCancelled(ctx.signal);
    session = storage.createSession(cwd);
    const state = storage.saveSessionConversation(session.id, messages, { expectedRevision: null, status: 'completed', signal: ctx.signal });
    revision = state.revision;
    notice = `Started session ${session.id}. Previous sessions remain available with /sessions and /resume.`;
  } else if (command === '/branch') {
    if (!active) throw new Error('No active session; use /new.');
    if (ctx.mode === 'plan') throw new Error('Plan mode: switch mode before creating a branch.');
    const cursor = ctx.conversationCursor?.current;
    if (!cursor || cursor.sessionId !== active.id) throw new Error('No active recovery cursor; use /resume or /new.');
    const branch = await branchSession(active.id, { ...options, name: parts[1], messages: ctx.llmMessages.current, expectedRevision: cursor.revision });
    session = branch.session; messages = branch.state.messages; revision = branch.state.revision;
    notice = `Checked out conversation branch ${session.id}${parts[1] ? ` (${parts[1]})` : ''}. Source: ${active.id}. Workspace files are unchanged.`;
  } else {
    const id = parts[1] ?? ctx.sessionRef.current?.id;
    const target = id ? selectSession(id, cwd) : null;
    if (!target) throw new Error('Session not found. Use /sessions.');
    const state = storage.readSessionConversation(target.id);
    if (state.revision === null) throw new Error('No recovery snapshot exists for this session. The original chat log remains available; tool context cannot be reconstructed safely.');
    messages = state.messages;
    const before = messages.length;
    completePendingTools(messages, 'Session interrupted; tool outcome unknown');
    notice = `Restored ${state.messages.length} messages from ${target.id}.`;
    if (before !== messages.length || state.status === 'active' || state.status === 'interrupted') notice += ' Interrupted work: check the project state before retrying tools; no tool has been replayed.';
    if (state.droppedMessages) notice += ` ${state.droppedMessages} older messages were omitted by retention.`;
    revision = state.revision;
    session = target;
    throwIfCancelled(ctx.signal);
  }
  // All recovery data has been validated before replacing the running client's state.
  storage.setCurrentSessionById(session.id);
  ctx.sessionRef.current = session;
  if (ctx.conversationCursor) ctx.conversationCursor.current = { sessionId: session.id, revision };
  ctx.llmMessages.current = messages;
  ctx.undoStack.current = []; ctx.redoStack.current = [];
  ctx.clearQueued?.();
  const transcriptId = randomUUID();
  ctx.setMessages(messages.filter(message => message.role !== 'system').map((message, index) => ({ id: `${transcriptId}-${index}`, type: message.role, content: messageText(message) })));
  ctx.setStats({ ...ctx.stats, messageCount: messages.length, inputTokens: 0, outputTokens: 0, cost: 0 });
  ctx.ledger?.loadSnapshot(storage.loadIterationLedger(session.id));
  ctx.reloadDefaults?.(session.projectPath);
  ctx.setContextTokens(ctx.estimateContextTokens());
  ctx.addMessage('system', notice);
  const log = RunLog.open(session.id);
  log.policyEvent({ tool: 'session', source: 'session-recovery', decision: 'allow', durationMs: 0,
    reason: `${parts[0]} revision=${revision} messages=${messages.length}` });
  await log.flush();
}
