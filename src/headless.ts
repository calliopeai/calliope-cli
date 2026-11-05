/**
 * Calliope CLI - Headless Renderer
 *
 * Minimal, no-TTY renderer for agent orchestration.
 * Outputs structured JSON or plain text with no ANSI, no decorations.
 * Designed for piping, CI, scripting, and multi-agent fleet coordination.
 */

import { runTurn } from './runtime/index.js';
import { MAX_CONSECUTIVE_CONTINUATIONS, type TurnTotals } from './runtime/turn.js';
import { connectDelegatedExecution, executionBinding, type DelegatedExecutionOptions } from './execution/delegated.js';
import { ExecutionGuard } from './execution/guard.js';
import type { AgentExecution } from './execution/guard.js';
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
  type: 'message' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'done' | 'budget_exceeded';
  timestamp: string;
  /** Which hard cap stopped the run (budget_exceeded only). */
  kind?: HeadlessCapKind;
  data: Record<string, unknown>;
}

export type HeadlessCapKind = 'cost' | 'time';

/** Exit code when a hard cap stops the run; shared with configured budget caps. */
export const BUDGET_EXIT_CODE = 3;
/** A --max-cost or --max-time cap stopped the run (5 is planning-review). */
export const CAP_EXIT_CODE = 6;

export type HeadlessOutputMode = 'json' | 'text';

export interface HeadlessOptions {
  signal?: AbortSignal;
  provider?: LLMProvider;
  model?: string;
  prompt?: string;
  outputMode?: HeadlessOutputMode;
  maxIterations?: number;
  maxRetries?: number;
  /** Hard spend cap in USD for this run (--max-cost / CALLIOPE_MAX_COST). */
  maxCost?: number;
  /** Hard wall-clock cap in seconds for this run (--max-time / CALLIOPE_MAX_TIME). */
  maxTime?: number;
  cwd?: string;
  /** Run as a delegated child admitted through a parent's served ledger (#415). */
  ledger?: DelegatedExecutionOptions;
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
      case 'budget_exceeded':
        process.stderr.write(`BUDGET: ${event.data.message}\n`);
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

/**
 * Parse `--max-cost <usd>` / `--max-time <seconds>`, falling back to
 * CALLIOPE_MAX_COST / CALLIOPE_MAX_TIME. A flag wins over its env var; an empty
 * env var is unset. Invalid values throw: silently dropping a cap would let a
 * run overspend while the caller believes it is bounded.
 */
export function parseHeadlessCaps(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { maxCost?: number; maxTime?: number } {
  const read = (flag: string, variable: string): number | undefined => {
    const index = args.indexOf(flag);
    const source = index === -1 ? variable : flag;
    const raw = index === -1 ? env[variable]?.trim() || undefined : args[index + 1];
    if (index === -1 && raw === undefined) return undefined;
    const value = raw === undefined || raw.startsWith('--') ? NaN : Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${source} must be a positive number (got ${raw === undefined ? 'no value' : JSON.stringify(raw)})`);
    return value;
  };
  const maxCost = read('--max-cost', 'CALLIOPE_MAX_COST');
  const maxTime = read('--max-time', 'CALLIOPE_MAX_TIME');
  return { ...(maxCost !== undefined ? { maxCost } : {}), ...(maxTime !== undefined ? { maxTime } : {}) };
}

// ============================================================================
// Headless Runner
// ============================================================================

interface RunClock { started: number; timedOut: boolean }

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const clock: RunClock = { started: Date.now(), timedOut: false };
  if (options.maxTime === undefined) return run(options, options.signal, clock);
  // The time cap aborts like cancellation; `clock.timedOut` tells the two apart.
  const deadline = new AbortController();
  const timer = setTimeout(() => { clock.timedOut = true; deadline.abort(); }, Math.min(options.maxTime * 1000, 2 ** 31 - 1));
  try { return await run(options, options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal, clock); }
  finally { clearTimeout(timer); }
}

async function run(options: HeadlessOptions, signal: AbortSignal | undefined, clock: RunClock): Promise<number> {
  const outputMode = options.outputMode || 'json';
  const summary = (totals: TurnTotals | undefined, stoppedBy: HeadlessCapKind | null) => ({
    costUsd: totals?.cost ?? 0, inputTokens: totals?.inputTokens ?? 0, outputTokens: totals?.outputTokens ?? 0,
    elapsedMs: Date.now() - clock.started, stoppedBy, limits: { maxCost: options.maxCost, maxTime: options.maxTime },
  });
  const timeCapHit = () => clock.timedOut && !options.signal?.aborted;
  const capExceeded = (kind: HeadlessCapKind, totals: TurnTotals | undefined, message: string): void => {
    const elapsedMs = Date.now() - clock.started;
    emit({ type: 'budget_exceeded', kind, timestamp: now(), data: {
      cap: kind === 'cost' ? options.maxCost : options.maxTime,
      spent: kind === 'cost' ? totals?.cost ?? 0 : elapsedMs / 1000,
      costUsd: totals?.cost ?? 0, elapsedMs, message } }, outputMode);
    if (outputMode === 'json') process.stderr.write(message + '\n');
  };
  const timeMessage = () => `Time cap reached: ${((Date.now() - clock.started) / 1000).toFixed(1)}s of ${options.maxTime}s. Halting.`;
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
    if (timeCapHit()) {
      capExceeded('time', undefined, timeMessage());
      emit({ type: 'done', timestamp: now(), data: { reason: 'budget', ...summary(undefined, 'time') } }, outputMode);
      return CAP_EXIT_CODE;
    }
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

  // ---- Delegated child (#415): every request is admitted by the parent's ledger --
  let execution: AgentExecution | undefined;
  if (options.ledger) {
    try {
      execution = await connectDelegatedExecution(cwd, options.ledger);
      emit({ type: 'status', timestamp: now(), data: { message: `Delegated child ${options.ledger.agentId}: admitted through the parent ledger` } }, outputMode);
    } catch (error) {
      emit({ type: 'error', timestamp: now(), data: { message: `Parent ledger refused this child: ${(error as Error).message}` } }, outputMode);
      return 1;
    }
  }

  // Build messages
  const systemPrompt = getSystemPromptForProvider(resolvedProvider);
  const contextGuard = execution ? new ExecutionGuard(execution, cwd) : undefined;
  const memoryContext = contextGuard ? memory.buildMemoryContext(cwd, { allowPath: file => !contextGuard.check({ id: 'context', name: 'read_file', arguments: { path: file } }) }) : memory.buildMemoryContext(cwd);
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
  try { sessionId = createSession(cwd, { activate: false, ...(execution ? { executionBinding: executionBinding(execution) } : {}) }).id; }
  catch { emit({ type: 'error', timestamp: now(), data: { message: 'Session recovery directory could not be created; check disk space and permissions.' } }, outputMode); return 1; }
  let revision: string | null = null;
  emit({ type: 'status', timestamp: now(), data: { message: `Session: ${sessionId}`, sessionId } }, outputMode);
  const runlog = RunLog.open(sessionId);
  if (runlog.enabled) emit({ type: 'status', timestamp: now(), data: { message: `Run log: ${runlog.filePath}` } }, outputMode);
  try {
    const result = await runTurn({
      captureToolOutput: true,
      client: 'headless',
      onSafetyBranch: async () => {
        const { branchSession } = await import('./session-management/index.js');
        const branch = await branchSession(sessionId, { kind: 'safety', signal, runlog });
        emit({ type: 'status', timestamp: now(), data: { message: `Recovery conversation branch: ${branch.session.id}`, sessionId: branch.session.id } }, outputMode);
      },
      onCheckpoint: (history, status) => {
        const saved = saveSessionConversation(sessionId, history, { expectedRevision: revision, status });
        revision = saved.revision;
        runlog.sessionCheckpoint({ revision: saved.revision, status, messageCount: saved.messages.length, checksum: saved.checksum });
      },
      continueOnLength: true,
      onContinue: ({ reason, attempt, max }) => {
        const message = `[continue ${attempt}/${max}] ${reason === 'length' ? 'output length limit reached' : 'empty model reply'}; asking the model to continue`;
        emit({ type: 'status', timestamp: now(), data: { message, continuing: true, reason, attempt, max } }, outputMode);
        process.stderr.write(message + '\n');
      },
      sessionId, cwd, provider, model, prompt, execution,
      preferenceSources: preference.sources,
      messages: { current: messages }, signal, maxIterations, maxRetries,
      ...(options.maxCost !== undefined ? { maxCostPerRun: options.maxCost } : {}),
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
    // A configured budget cap tighter than --max-cost keeps its own (status) reporting.
    const stoppedBy: HeadlessCapKind | null = result.reason === 'cancelled' && timeCapHit() ? 'time'
      : result.reason === 'budget' && result.budget?.scope === 'run' && result.budget.kind === 'cost' && options.maxCost !== undefined && result.budget.cap === options.maxCost ? 'cost' : null;
    if (stoppedBy) capExceeded(stoppedBy, result.totals, stoppedBy === 'time' ? timeMessage() : formatBudgetHalt(result.budget!));
    else if (result.budget?.exceeded) {
      const message = formatBudgetHalt(result.budget);
      emit({ type: 'status', timestamp: now(), data: { message } }, outputMode);
      process.stderr.write(message + '\n');
    }
    if (!stoppedBy && (result.reason === 'length' || result.reason === 'empty_response')) {
      const message = `Run gave up: ${result.reason === 'length' ? 'output length limit reached' : 'empty model replies'} (${result.reason}) after ${MAX_CONSECUTIVE_CONTINUATIONS} consecutive continuations.`;
      emit({ type: 'error', timestamp: now(), data: { message, reason: result.reason } }, outputMode);
      process.stderr.write(message + '\n');
    }
    emit({ type: 'done', timestamp: now(), data: { iterations: result.iterations, reason: stoppedBy ? 'budget' : result.reason, ...summary(result.totals, stoppedBy) } }, outputMode);
    if (stoppedBy) return CAP_EXIT_CODE;
    return result.reason === 'cancelled' ? 130 : result.reason === 'budget' ? BUDGET_EXIT_CODE : result.reason === 'completed' ? 0 : 4;
  } catch (error) {
    emit({ type: 'error', timestamp: now(), data: { message: error instanceof Error ? error.message : String(error) } }, outputMode);
    return 1;
  }
}
