import { realpathSync } from 'node:fs';
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
      `${session.id === ctx.sessionRef.current?.id ? '* ' : ''}${session.id} | ${session.projectName} | ${session.messageCount} messages | ${session.lastAccessedAt}`).join('\n') : 'No saved sessions. Use /new.');
    return;
  }
  if (ctx.isProcessing || ctx.loopActive) throw new Error('Cancel the active turn and wait for it to stop before switching sessions.');
  if (parts.length > (parts[0] === '/new' ? 1 : 2)) throw new Error(`Usage: ${parts[0]}${parts[0] === '/resume' ? ' [sessionId]' : ''}`);
  const cwd = ctx.sessionRef.current?.projectPath ?? process.cwd();
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
  } else {
    const id = parts[1] ?? ctx.sessionRef.current?.id;
    const target = id ? storage.getSessionById(id) : null;
    if (!target) throw new Error('Session not found. Use /sessions.');
    if (realpathSync(target.projectPath) !== realpathSync(cwd)) throw new Error(`This session belongs to ${target.projectPath}; run Calliope from that project to resume it.`);
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
  ctx.setMessages([]);
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
