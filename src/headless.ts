/**
 * Calliope CLI - Headless Renderer
 *
 * Minimal, no-TTY renderer for agent orchestration.
 * Outputs structured JSON or plain text with no ANSI, no decorations.
 * Designed for piping, CI, scripting, and multi-agent fleet coordination.
 */

import { runTurn } from './runtime/index.js';
import { createSession, saveSessionConversation } from './storage.js';
import { cancellationError, isCancellation, throwIfCancelled } from './cancellation.js';
import * as config from './config.js';
import { selectProvider, ProviderUnavailableError } from './providers/index.js';
import { getTools } from './tools.js';
import { DEFAULT_MODELS } from './types.js';
import { getSystemPromptForProvider } from './local-model.js';
import * as memory from './memory.js';
import { resolveIterationLimit } from './iteration-limit.js';
import { RunLog } from './runlog.js';
import { formatBudgetHalt } from './budget.js';
import { resolvePreferences, type ResolvedPreference } from './preferences/index.js';
import type { Message, LLMProvider } from './types.js';

// ============================================================================
// Types
// ============================================================================

export interface HeadlessEvent {
  type: 'message' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'done';
  timestamp: string;
  data: Record<string, unknown>;
}

export type HeadlessOutputMode = 'json' | 'text';

export interface HeadlessOptions {
  signal?: AbortSignal;
  provider?: LLMProvider;
  model?: string;
  prompt?: string;
  outputMode?: HeadlessOutputMode;
  maxIterations?: number;
  maxRetries?: number;
  cwd?: string;
}

// ============================================================================
// Output
// ============================================================================

function emit(event: HeadlessEvent, mode: HeadlessOutputMode): void {
  if (mode === 'json') {
    process.stdout.write(JSON.stringify(event) + '\n');
  } else {
    // Plain text mode
    switch (event.type) {
      case 'message':
        process.stdout.write(String(event.data.content || '') + '\n');
        break;
      case 'tool_call':
        process.stdout.write(`[tool:${event.data.name}] ${JSON.stringify(event.data.arguments)}\n`);
        break;
      case 'tool_result':
        process.stdout.write(String(event.data.result || '') + '\n');
        break;
      case 'error':
        process.stderr.write(`ERROR: ${event.data.message}\n`);
        break;
      case 'status':
        process.stderr.write(`STATUS: ${event.data.message}\n`);
        break;
      case 'done':
        // Silence
        break;
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

// ============================================================================
// Headless Runner
// ============================================================================

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const signal = options.signal;
  const outputMode = options.outputMode || 'json';
  const maxIterations = resolveIterationLimit(options.maxIterations ?? config.get('maxIterations'));
  const maxRetries = options.maxRetries ?? 3;
  const cwd = options.cwd || process.cwd();
  let preference: ResolvedPreference;
  try { preference = resolvePreferences(cwd, { turn: { ...(options.provider !== undefined ? { provider: options.provider } : {}), ...(options.model !== undefined ? { model: options.model } : {}) } }); }
  catch (error) { emit({ type: 'error', timestamp: now(), data: { message: error instanceof Error ? error.message : String(error) } }, outputMode); return 2; }
  const { provider, model } = preference;
  for (const warning of preference.warnings) emit({ type: 'status', timestamp: now(), data: { message: warning } }, outputMode);

  // Build prompt from stdin or --prompt flag
  let prompt = options.prompt || '';

  try {
    throwIfCancelled(signal);
    if (!prompt && !process.stdin.isTTY) {
      prompt = await new Promise<string>((resolve, reject) => {
        const input = process.stdin;
        const chunks: Buffer[] = [];
        const cleanup = () => {
          input.removeListener('data', data);
          input.removeListener('end', end);
          input.removeListener('error', fail);
          signal?.removeEventListener('abort', abort);
        };
        const data = (chunk: Buffer | string) => chunks.push(Buffer.from(chunk));
        const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8').trim()); };
        const fail = (error: Error) => { cleanup(); reject(error); };
        const abort = () => { input.pause(); fail(cancellationError()); };
        input.on('data', data);
        input.once('end', end);
        input.once('error', fail);
        signal?.addEventListener('abort', abort, { once: true });
        if (input.readableEnded) end();
      });
    }
  } catch (error) {
    if (signal?.aborted || isCancellation(error)) {
      emit({ type: 'done', timestamp: now(), data: { reason: 'cancelled' } }, outputMode);
      return 130;
    }
    emit({ type: 'error', timestamp: now(), data: { message: String(error) } }, outputMode);
    return 1;
  }

  if (!prompt) {
    emit({
      type: 'error',
      timestamp: now(),
      data: { message: 'No prompt provided. Use --prompt or pipe to stdin.' },
    }, outputMode);
    return 1;
  }

  // Resolve the provider so 'auto' picks up a local backend correctly, then
  // select the compact-vs-full system prompt for it (feature 5).
  //
  // An explicitly-requested-but-unconfigured provider is a hard, actionable
  // failure: print the fix to stderr and exit 2 rather than silently switching
  // providers (#217). 'auto'-with-no-keys throws a plain Error instead — keep
  // the old lenient fallback so chat() below surfaces that as a normal error.
  let resolvedProvider: LLMProvider;
  try {
    resolvedProvider = selectProvider(provider);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      emit({ type: 'error', timestamp: now(), data: { message: err.message } }, outputMode);
      return 2;
    }
    resolvedProvider = provider;
  }

  // Build messages
  const systemPrompt = getSystemPromptForProvider(resolvedProvider);
  const memoryContext = memory.buildMemoryContext(cwd);
  const fullPrompt = memoryContext.trim()
    ? systemPrompt + '\n\n--- Project Context ---\n' + memoryContext
    : systemPrompt;

  const messages: Message[] = [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: prompt },
  ];


  emit({
    type: 'status',
    timestamp: now(),
    data: {
      message: 'Starting headless session; selecting a route',
      provider: resolvedProvider,
      model: model || DEFAULT_MODELS[resolvedProvider],
    },
  }, outputMode);

  // ---- Governance (#189): audit run log, budget caps, policy hook ----------
  let sessionId: string;
  try { sessionId = createSession(cwd, { activate: false }).id; }
  catch { emit({ type: 'error', timestamp: now(), data: { message: 'Session recovery directory could not be created; check disk space and permissions.' } }, outputMode); return 1; }
  let revision: string | null = null;
  emit({ type: 'status', timestamp: now(), data: { message: `Session: ${sessionId}`, sessionId } }, outputMode);
  const runlog = RunLog.open(sessionId);
  if (runlog.enabled) emit({ type: 'status', timestamp: now(), data: { message: `Run log: ${runlog.filePath}` } }, outputMode);
  try {
    const result = await runTurn({
      client: 'headless',
      onCheckpoint: (history, status) => {
        const saved = saveSessionConversation(sessionId, history, { expectedRevision: revision, status });
        revision = saved.revision;
        runlog.sessionCheckpoint({ revision: saved.revision, status, messageCount: saved.messages.length, checksum: saved.checksum });
      },
      sessionId, cwd, provider, model, prompt,
      preferenceSources: preference.sources,
      messages: { current: messages }, signal, maxIterations, maxRetries,
      runlog, confirmation: 'none', tools: getTools,
      onResponse: response => {
        if (!response.toolCalls?.length) emit({ type: 'message', timestamp: now(), data: { role: 'assistant', content: response.content } }, outputMode);
      },
      onToolStart: call => emit({ type: 'tool_call', timestamp: now(), data: { id: call.id, name: call.name, arguments: call.arguments } }, outputMode),
      onToolResult: (call, toolResult) => emit({ type: 'tool_result', timestamp: now(), data: { toolCallId: call.id, name: call.name, result: toolResult.result, isError: !!toolResult.isError } }, outputMode),
      onToolRetry: (_call, attempt, toolResult) => { process.stderr.write(`[retry ${attempt}/${maxRetries}] tool failed: ${toolResult.result}\n`); },
      onWarning: message => emit({ type: 'status', timestamp: now(), data: { message } }, outputMode),
      onRoute: decision => emit({ type: 'status', timestamp: now(), data: { message: decision.reason, routing: decision, provider: decision.selected?.provider, model: decision.selected?.model } }, outputMode),
    });
    if (result.budget?.exceeded) {
      const message = formatBudgetHalt(result.budget);
      emit({ type: 'status', timestamp: now(), data: { message } }, outputMode);
      process.stderr.write(message + '\n');
    }
    emit({ type: 'done', timestamp: now(), data: { iterations: result.iterations, reason: result.reason } }, outputMode);
    return result.reason === 'cancelled' ? 130 : result.reason === 'budget' ? 3 : result.reason === 'completed' ? 0 : 4;
  } catch (error) {
    emit({ type: 'error', timestamp: now(), data: { message: error instanceof Error ? error.message : String(error) } }, outputMode);
    return 1;
  }
}
