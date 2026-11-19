/**
 * Calliope CLI - Headless Renderer
 *
 * Minimal, no-TTY renderer for agent orchestration.
 * Outputs structured JSON or plain text with no ANSI, no decorations.
 * Designed for piping, CI, scripting, and multi-agent fleet coordination.
 */

import { runTurn } from './runtime/index.js';
import { MAX_CONSECUTIVE_CONTINUATIONS, type TurnOptions, type TurnTotals } from './runtime/turn.js';
import type { RuntimeControl, ControlCheckpoint, ControlReadyCheckpoint, ControlReceipt } from './runtime/control.js';
import type { TurnProgress } from './sessions/turn-progress.js';
import type { TurnRuntimeState } from './sessions/runtime-state.js';
import type { RecoveryStatus } from './sessions/format.js';
import { completionCheckLimit, type CompletionCheck } from './runtime/completion.js';
import { connectDelegatedExecution, executionBinding, type DelegatedExecutionOptions } from './execution/delegated.js';
import { ExecutionGuard } from './execution/guard.js';
import type { AgentExecution } from './execution/guard.js';
import { createSession, readSessionConversation, saveSessionConversation } from './storage.js';
import { cancellationError, isCancellation, throwIfCancelled } from './cancellation.js';
import { createHash } from 'node:crypto';
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
import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from './models/index.js';

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

export const HEADLESS_PROGRESS_PROTOCOL_VERSION = 1;
/** Opt-in original-turn evidence only; does not advertise cold execution resume. */
export const HEADLESS_RUNTIME_STATE_PROTOCOL_VERSION = 1;
/** Explicit phase/effect capture only, without cold execution resume. */
export const HEADLESS_EXECUTION_STATE_PROTOCOL_VERSION = 2;

export interface HeadlessRuntimeStateReceipt extends ControlCheckpoint {
  readonly sessionId: string;
  readonly status: RecoveryStatus;
  readonly progress: Readonly<TurnProgress>;
  readonly runtimeState: Readonly<TurnRuntimeState>;
}

export interface HeadlessProgressReceipt extends ControlReadyCheckpoint {
  readonly progress: Readonly<TurnProgress>;
}

export interface HeadlessQuestionReceipt {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly revision: string;
  readonly checksum: string;
  readonly answerSha256: string;
}

export interface HeadlessOptions {
  /** Opt-in checkpoint evidence for future fenced recovery; does not enable resume. */
  retainRuntimeState?: boolean;
  /** Explicit phase/effect capture, without replacement execution authority. */
  runtimeStateVersion?: 1 | 2;
  /** Acknowledge each saved runtime checkpoint before the next effect; not recovery authority. */
  onRuntimeStateCommitted?: (receipt: HeadlessRuntimeStateReceipt, signal?: AbortSignal) => Promise<void>;
  /** Correlated response facts under the original delegated ledger, not replacement authority. */
  onProviderResponseReceived?: TurnOptions['onProviderResponseReceived'];
  /** Trusted workspace transport; task text cannot configure this capability. */
  toolRuntime?: TurnOptions['toolRuntime'];
  signal?: AbortSignal;
  /** Check external acceptance evidence and keep failed criteria in this same turn. */
  completionCheck?: CompletionCheck;
  maxCompletionChecks?: number;
  /** Control this original live turn; state and receipts do not recover a terminated process. */
  control?: RuntimeControl;
  onControlCommitted?: (receipt: ControlReceipt, signal?: AbortSignal) => Promise<void>;
  /** Acknowledge the first saved control checkpoint before any provider inference. */
  onControlReady?: (checkpoint: ControlReadyCheckpoint, signal?: AbortSignal) => Promise<void>;
  /** Acknowledge retained allowance before provider or verification work begins. */
  onTurnProgressCommitted?: (receipt: HeadlessProgressReceipt, signal?: AbortSignal) => Promise<void>;
  /** Answer an authorized host question in this same session, allowance and clock. Not a tool approval. */
  answerQuestion?: TurnOptions['answerQuestion'];
  /** Acknowledge the original conversation's saved answer before further execution. */
  onQuestionCommitted?: (receipt: HeadlessQuestionReceipt, signal?: AbortSignal) => Promise<void>;
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
  /** Explicit effort, subject to the provider's live capability checks. */
  reasoningEffort?: ReasoningEffort;
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

/** A requested effort is never silently dropped; the flag wins over its environment default. */
export function parseHeadlessEffort(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ReasoningEffort | undefined {
  const flag = '--reasoning-effort';
  const found = args.map((value, index) => ({ value, index })).filter(({ value }) => value === flag || value.startsWith(flag + '='));
  if (found.length > 1) throw new Error(`${flag} may be specified only once`);
  const item = found[0];
  const raw = item ? (item.value === flag ? args[item.index + 1] : item.value.slice(flag.length + 1))?.trim() : env.CALLIOPE_REASONING_EFFORT?.trim();
  if (!item && !raw) return undefined;
  if (!isReasoningEffort(raw)) throw new Error(`${item ? flag : 'CALLIOPE_REASONING_EFFORT'} must be one of ${REASONING_EFFORTS.join(', ')}`);
  return raw;
}

// ============================================================================
// Headless Runner
// ============================================================================

interface RunClock { started: number; timedOut: boolean }
const headlessControls = new WeakSet<RuntimeControl>();

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const control = options.control;
  if (control) {
    if (headlessControls.has(control) || control.state.sessionId || control.state.phase === 'stopped') {
      emit({ type: 'error', timestamp: now(), data: { message: 'Execution controller already belongs to a headless invocation or turn.' } }, options.outputMode || 'json');
      return 2;
    }
    // Reserve before asynchronous preflight. A rejected second invocation must
    // not end another invocation's pending pause or stop its original turn.
    headlessControls.add(control);
  }
  try { return await runHeadlessWithClock({ ...options }); }
  finally {
    if (control && !control.state.sessionId)
      control.stop(new Error('Headless run ended before runtime admission.'));
  }
}

async function runHeadlessWithClock(options: HeadlessOptions): Promise<number> {
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
  const providerResponseWriter = options.onProviderResponseReceived;
  if (providerResponseWriter !== undefined &&
      (typeof providerResponseWriter !== 'function' || options.retainRuntimeState !== true || !options.ledger)) {
    emit({ type: 'error', timestamp: now(), data: { message: 'Headless provider checkpoints require runtime capture, the original delegated ledger and a host callback.' } }, outputMode);
    return 2;
  }
  if (options.retainRuntimeState !== undefined && typeof options.retainRuntimeState !== 'boolean') {
    emit({ type: 'error', timestamp: now(), data: { message: 'Runtime state capture requires an explicit boolean.' } }, outputMode);
    return 2;
  }
  if (options.onRuntimeStateCommitted !== undefined &&
      (typeof options.onRuntimeStateCommitted !== 'function' || options.retainRuntimeState !== true)) {
    emit({ type: 'error', timestamp: now(), data: { message: 'Runtime checkpoint acknowledgment requires capture and a host callback.' } }, outputMode);
    return 2;
  }
  if (options.runtimeStateVersion !== undefined &&
      (options.retainRuntimeState !== true || ![1, 2].includes(options.runtimeStateVersion))) {
    emit({ type: 'error', timestamp: now(), data: { message: 'Runtime state version requires capture and version 1 or 2.' } }, outputMode);
    return 2;
  }
  try { completionCheckLimit(options.completionCheck, options.maxCompletionChecks); }
  catch {
    emit({ type: 'error', timestamp: now(), data: { message: 'Completion verification requires a host callback and 1 to 8 checks.' } }, outputMode);
    return 2;
  }
  if (options.onControlReady !== undefined && typeof options.onControlReady !== 'function') {
    emit({ type: 'error', timestamp: now(), data: { message: 'Initial control acknowledgment requires a host callback.' } }, outputMode);
    return 2;
  }
  if (options.onTurnProgressCommitted !== undefined && typeof options.onTurnProgressCommitted !== 'function') {
    emit({ type: 'error', timestamp: now(), data: { message: 'Turn allowance acknowledgment requires a host callback.' } }, outputMode);
    return 2;
  }
  if ((options.onControlCommitted || options.onControlReady) && !options.control) {
    emit({ type: 'error', timestamp: now(), data: { message: 'Control acknowledgment requires an execution controller.' } }, outputMode);
    return 2;
  }
  if (options.reasoningEffort !== undefined && !isReasoningEffort(options.reasoningEffort)) {
    emit({ type: 'error', timestamp: now(), data: { message: 'Invalid headless reasoning effort' } }, outputMode);
    return 2;
  }
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
  // A hosted workspace is not a filesystem grant to this SDK process. Its
  // caller supplies initial context through the prompt or the declared tools.
  const memoryContext = options.toolRuntime ? '' : contextGuard ? memory.buildMemoryContext(cwd, { allowPath: file => !contextGuard.check({ id: 'context', name: 'read_file', arguments: { path: file } }) }) : memory.buildMemoryContext(cwd);
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
  let savedQuestion: ReturnType<typeof saveSessionConversation> | undefined;
  let savedControl: ControlCheckpoint | undefined;
  let savedProgress: ReturnType<typeof saveSessionConversation> | undefined;
  emit({ type: 'status', timestamp: now(), data: { message: `Session: ${sessionId}`, sessionId } }, outputMode);
  const runlog = RunLog.open(sessionId);
  if (runlog.enabled) emit({ type: 'status', timestamp: now(), data: { message: `Run log: ${runlog.filePath}` } }, outputMode);
  try {
    const result = await runTurn({
      ...(providerResponseWriter ? { onProviderResponseReceived: providerResponseWriter } : {}),
      ...(options.retainRuntimeState ? { retainRuntimeState: true, runtimeStateVersion: options.runtimeStateVersion, runtimeClock: { startedAt: clock.started,
        deadline: options.maxTime === undefined ? null : Math.floor(clock.started + options.maxTime * 1000) } } : {}),
      captureToolOutput: true,
      client: 'headless',
      onSafetyBranch: async () => {
        const { branchSession } = await import('./session-management/index.js');
        const branch = await branchSession(sessionId, { kind: 'safety', signal, runlog });
        emit({ type: 'status', timestamp: now(), data: { message: `Recovery conversation branch: ${branch.session.id}`, sessionId: branch.session.id } }, outputMode);
      },
      retainTurnProgress: !!(options.control || options.completionCheck || options.onTurnProgressCommitted),
      onCheckpoint: (history, status, progress, runtimeState) => {
        const saved = saveSessionConversation(sessionId, history, { expectedRevision: revision, status, progress,
          ...(runtimeState ? { runtimeState } : {}) });
        revision = saved.revision;
        if (progress) savedProgress = saved;
        if (options.onQuestionCommitted) savedQuestion = saved;
        if (options.control || options.completionCheck) savedControl = { revision: saved.revision, checksum: saved.checksum };
        runlog.sessionCheckpoint({ revision: saved.revision, status, messageCount: saved.messages.length, checksum: saved.checksum });
      },
      onRuntimeStateCommitted: options.onRuntimeStateCommitted ? async (runtimeState, progress, receiptSignal) => {
        if (!savedProgress || JSON.stringify(savedProgress.progress) !== JSON.stringify(progress) ||
            JSON.stringify(savedProgress.runtimeState) !== JSON.stringify(runtimeState))
          throw new Error('Runtime checkpoint evidence is unavailable.');
        const proof = Object.freeze({ sessionId, revision: savedProgress.revision, checksum: savedProgress.checksum,
          status: savedProgress.status, progress: Object.freeze(structuredClone(progress)),
          runtimeState: Object.freeze(structuredClone(runtimeState)) });
        const result: unknown = await options.onRuntimeStateCommitted!(proof, receiptSignal);
        if (result !== undefined) throw new Error('Invalid runtime checkpoint acknowledgment.');
        const current = readSessionConversation(sessionId);
        if (current.revision !== proof.revision || !('checksum' in current) || current.checksum !== proof.checksum)
          throw new Error('Runtime checkpoint changed before acknowledgment.');
      } : undefined,
      onTurnProgressCommitted: options.onTurnProgressCommitted ? async (progress, progressSignal) => {
        if (!savedProgress || JSON.stringify(savedProgress.progress) !== JSON.stringify(progress))
          throw new Error('Turn allowance checkpoint is unavailable.');
        const proof = Object.freeze({ sessionId, revision: savedProgress.revision, checksum: savedProgress.checksum,
          progress: Object.freeze(structuredClone(progress)) });
        const result = await options.onTurnProgressCommitted!(proof, progressSignal);
        if (result !== undefined) throw new Error('Invalid turn allowance acknowledgment.');
        const current = readSessionConversation(sessionId);
        if (current.revision !== proof.revision || !('checksum' in current) || current.checksum !== proof.checksum)
          throw new Error('Turn allowance checkpoint changed during acknowledgment.');
      } : undefined,
      continueOnLength: true,
      onContinue: ({ reason, attempt, max }) => {
        const message = `[continue ${attempt}/${max}] ${reason === 'length' ? 'output length limit reached' : 'empty model reply'}; asking the model to continue`;
        emit({ type: 'status', timestamp: now(), data: { message, continuing: true, reason, attempt, max } }, outputMode);
        process.stderr.write(message + '\n');
      },
      sessionId, cwd, provider, model, prompt, execution,
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      preferenceSources: preference.sources,
      messages: { current: messages }, signal, maxIterations, maxRetries,
      control: options.control,
      controlSnapshot: options.control || options.completionCheck ? () => {
        if (!savedControl) throw new Error('Execution control checkpoint is unavailable.');
        return savedControl;
      } : undefined,
      maxCompletionChecks: options.maxCompletionChecks,
      completionCheck: options.completionCheck ? async (proposal, completionSignal) => {
        const verdict = await options.completionCheck!(proposal, completionSignal);
        const saved = readSessionConversation(sessionId);
        if (saved.revision !== proposal.revision || !('checksum' in saved) || saved.checksum !== proposal.checksum)
          throw new Error('Conversation changed during completion verification.');
        return verdict;
      } : undefined,
      onControlReady: options.onControlReady ? async (proof, readySignal) => {
        const acknowledgment = await options.onControlReady!(proof, readySignal);
        const saved = readSessionConversation(sessionId);
        if (saved.revision !== proof.revision || !('checksum' in saved) || saved.checksum !== proof.checksum)
          throw new Error('Initial conversation changed during acknowledgment.');
        return acknowledgment;
      } : undefined,
      onControlCommitted: options.control ? async (receipt, controlSignal) => {
        await options.onControlCommitted?.(receipt, controlSignal);
        const current = readSessionConversation(sessionId);
        if (current.revision !== receipt.revision)
          throw new Error('Conversation changed during execution control; reload before continuing.');
        emit({ type: 'status', timestamp: now(), data: { control: receipt } }, outputMode);
      } : undefined,
      answerQuestion: options.answerQuestion,
      onQuestionCommitted: options.onQuestionCommitted ? async (call, toolResult, questionSignal) => {
        const message = savedQuestion?.messages.at(-1);
        if (toolResult.isError || !savedQuestion || message?.role !== 'tool' || message.toolCallId !== call.id || message.content !== toolResult.result) {
          throw new Error('Question answer was not saved in the original conversation; delivery was not acknowledged.');
        }
        const receipt: HeadlessQuestionReceipt = Object.freeze({ sessionId, toolCallId: call.id,
          revision: savedQuestion.revision, checksum: savedQuestion.checksum,
          answerSha256: createHash('sha256').update(toolResult.result).digest('hex') });
        await options.onQuestionCommitted!(receipt, questionSignal);
        if (readSessionConversation(sessionId).revision !== receipt.revision) {
          throw new Error('Conversation changed while question delivery was being acknowledged; reload before continuing.');
        }
      } : undefined,
      ...(options.maxCost !== undefined ? { maxCostPerRun: options.maxCost } : {}),
      runlog, confirmation: 'none', tools: getTools, toolRuntime: options.toolRuntime,
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
    if (!stoppedBy && (result.reason === 'length' || result.reason === 'empty_response' || result.reason === 'invalid_tool_arguments')) {
      const message = `Run gave up: ${result.reason === 'length' ? 'output length limit reached' : result.reason === 'invalid_tool_arguments' ? 'malformed tool arguments' : 'empty model replies'} (${result.reason}) after ${MAX_CONSECUTIVE_CONTINUATIONS} consecutive continuations.`;
      emit({ type: 'error', timestamp: now(), data: { message, reason: result.reason } }, outputMode);
      process.stderr.write(message + '\n');
    }
    emit({ type: 'done', timestamp: now(), data: { iterations: result.iterations, reason: stoppedBy ? 'budget' : result.reason,
      ...(result.verification && !stoppedBy ? { verification: result.verification } : {}), ...summary(result.totals, stoppedBy) } }, outputMode);
    if (stoppedBy) return CAP_EXIT_CODE;
    return result.reason === 'cancelled' ? 130 : result.reason === 'budget' ? BUDGET_EXIT_CODE : result.reason === 'completed' ? 0 : 4;
  } catch (error) {
    emit({ type: 'error', timestamp: now(), data: { message: error instanceof Error ? error.message : String(error) } }, outputMode);
    return 1;
  }
}
