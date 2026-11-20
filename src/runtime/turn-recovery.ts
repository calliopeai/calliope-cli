import { canonicalJson, projectIdentity } from '../approvals/index.js';
import { cancellable, throwIfCancelled } from '../cancellation.js';
import { assertExecutionBinding, type AgentExecution, ExecutionLimitError } from '../execution/index.js';
import { providerTarget } from '../health/target.js';
import { isLocalBackend } from '../local-model.js';
import { isReasoningEffort, type ReasoningEffort } from '../models/index.js';
import { getSessionById, readSessionConversation } from '../storage.js';
import { validSessionExecutionBinding, type SessionExecutionBinding } from '../sessions/execution-binding.js';
import { validateTurnProgress, type TurnProgress } from '../sessions/turn-progress.js';
import { assertRuntimeProgress, validateTurnRuntimeState, type TurnRuntimeState } from '../sessions/runtime-state.js';
import type { Message, LLMProvider } from '../types.js';
import type { RecoveryStatus } from '../sessions/format.js';
import { RuntimeControl, type ControlReadyCheckpoint } from './control.js';
import { validateControlRecovery, type ControlRecoveryState } from './control-recovery.js';
import { MAX_CONSECUTIVE_CONTINUATIONS } from './continuation-limit.js';
import { resolveIterationLimit } from '../iteration-limit.js';
import type { PermissionContext } from './permissions.js';
import type { TurnOptions } from './turn.js';

export const TURN_RECOVERY_PROTOCOL_VERSION = 1;

export interface TurnRecoveryRequest {
  provider: Exclude<LLMProvider, 'auto'>;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  target: string;
  maxOutputTokens: number;
}
export interface TurnRecoveryPolicy {
  confirmation: PermissionContext['confirmation'];
  mode: Exclude<TurnOptions['mode'], undefined> | null;
  parallel: boolean;
  continueOnLength: boolean;
  disableCompression: boolean;
  measuredInputReservation: boolean;
  inheritScope: boolean;
  maxRetries: number;
  maxProviderRetries: number | null;
}
export interface TurnRecoveryProof {
  version: 1;
  checkpoint: ControlReadyCheckpoint;
  project: { project: string; projectKey: string };
  executionBinding: SessionExecutionBinding;
  status: RecoveryStatus;
  progress: TurnProgress;
  runtimeState: TurnRuntimeState;
  request: TurnRecoveryRequest;
  policy: TurnRecoveryPolicy;
  controls: ControlRecoveryState;
  nextIteration: number;
}
export interface TurnRecoveryInput {
  version: 1;
  cwd: string;
  checkpoint: ControlReadyCheckpoint;
  controls: ControlRecoveryState;
  request: TurnRecoveryRequest;
  policy: TurnRecoveryPolicy;
  /** The host reconciles original request history to distinguish an admitted from a completed iteration. */
  nextIteration: number;
  admit: (proof: Readonly<TurnRecoveryProof>, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}
interface Description {
  readonly sessionId: string;
  readonly checkpoint: Readonly<ControlReadyCheckpoint>;
  readonly control: RuntimeControl;
  readonly request: Readonly<TurnRecoveryRequest>;
  readonly policy: Readonly<TurnRecoveryPolicy>;
  readonly startedAt: number;
  readonly deadline: number | null;
  readonly iterationLimit: number | null;
  readonly completionLimit: number;
}
declare const recoveryBrand: unique symbol;
export interface PreparedTurnRecovery extends Description { readonly [recoveryBrand]: 'prepared' }
export interface ActiveTurnRecovery extends Description { readonly [recoveryBrand]: 'active' }
export interface RecoveredTurn {
  checkpoint: ControlReadyCheckpoint;
  project: { project: string; projectKey: string };
  executionBinding: SessionExecutionBinding;
  messages: Message[];
  progress: TurnProgress;
  runtimeState: TurnRuntimeState & { version: 2 };
  request: TurnRecoveryRequest;
  policy: TurnRecoveryPolicy;
  nextIteration: number;
}
interface Entry { state: RecoveredTurn; controls: ControlRecoveryState; control: RuntimeControl; used: boolean }
const prepared = new WeakMap<PreparedTurnRecovery, Entry>();
const active = new WeakMap<ActiveTurnRecovery, Entry>();
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new ExecutionLimitError('authority', message);
}
function completeTools(messages: Message[]): void {
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') pending.delete(message.toolCallId!);
    else {
      ensure(!pending.size, 'Original tool results require reconciliation before recovery.');
      pending = new Set(message.toolCalls?.map(call => call.id));
    }
  }
  ensure(!pending.size, 'Original tool results require reconciliation before recovery.');
}
function load(cwd: string, checkpoint: ControlReadyCheckpoint): Omit<RecoveredTurn, 'request' | 'policy' | 'nextIteration'> & { status: RecoveryStatus } {
  const metadata = getSessionById(checkpoint.sessionId);
  ensure(metadata && validSessionExecutionBinding(metadata.executionBinding), 'Recovery requires its original bound session.');
  const project = projectIdentity(cwd);
  ensure(canonicalJson(projectIdentity(metadata.projectPath)) === canonicalJson(project), 'Original recovery workspace changed.');
  const saved = readSessionConversation(checkpoint.sessionId);
  ensure(saved.revision === checkpoint.revision && 'checksum' in saved && saved.checksum === checkpoint.checksum,
    'Original recovery checkpoint changed; reconcile the retained state.');
  ensure(saved.droppedMessages === 0 && (saved.status === 'active' || saved.status === 'interrupted'),
    'Original recovery conversation is terminal or incomplete.');
  validateTurnProgress(saved.progress);
  validateTurnRuntimeState(saved.runtimeState);
  assertRuntimeProgress(saved.runtimeState, saved.progress);
  const runtime = saved.runtimeState;
  ensure(runtime.version === 2 && runtime.effect.kind === 'quiescent' && runtime.execution.activeEffects.length === 0 &&
      (runtime.execution.phase === 'ready' || runtime.execution.phase === 'context_recorded'),
    'Original pending effects require reconciliation before recovery.');
  ensure(runtime.responseUsageComplete, 'Original unreported usage requires reconciliation before recovery.');
  ensure(runtime.continuations <= MAX_CONSECUTIVE_CONTINUATIONS, 'Original continuation allowance is exhausted.');
  ensure(saved.progress.completionLimit === 0 || saved.progress.completionChecks < saved.progress.completionLimit,
    'Original verification allowance is exhausted.');
  ensure(runtime.startedAt <= Date.now() && (runtime.deadline === null || Date.now() < runtime.deadline),
    'Original recovery clock is unavailable or expired.');
  completeTools(saved.messages);
  const last = saved.messages.at(-1);
  ensure(last?.role !== 'assistant' || !!last.toolCalls?.length,
    'Original response completion requires verification reconciliation.');
  return { checkpoint: structuredClone(checkpoint), project, executionBinding: structuredClone(metadata.executionBinding),
    messages: structuredClone(saved.messages), progress: structuredClone(saved.progress), runtimeState: structuredClone(runtime), status: saved.status };
}
function assertUnchanged(state: RecoveredTurn, cwd: string): void {
  const current = load(cwd, state.checkpoint);
  ensure(canonicalJson(current.project) === canonicalJson(state.project) &&
    canonicalJson(current.executionBinding) === canonicalJson(state.executionBinding) &&
    canonicalJson(current.progress) === canonicalJson(state.progress) &&
    canonicalJson(current.runtimeState) === canonicalJson(state.runtimeState), 'Original recovery evidence changed.');
  ensure(providerTarget(state.request.provider).key === state.request.target, 'Original recovery provider target changed.');
}
function description(entry: Entry): Description {
  return { sessionId: entry.state.checkpoint.sessionId, control: entry.control, request: Object.freeze(structuredClone(entry.state.request)),
    checkpoint: Object.freeze(structuredClone(entry.state.checkpoint)),
    policy: Object.freeze(structuredClone(entry.state.policy)),
    startedAt: entry.state.runtimeState.startedAt, deadline: entry.state.runtimeState.deadline,
    iterationLimit: entry.state.progress.iterationLimit, completionLimit: entry.state.progress.completionLimit };
}

/** The trusted host must establish original ownership before the delegated execution connection opens. */
export async function prepareTurnRecovery(input: TurnRecoveryInput): Promise<PreparedTurnRecovery> {
  ensure(input?.version === 1 && typeof input.admit === 'function', 'Recovery requires explicit original host admission.');
  const captured = structuredClone({ cwd: input.cwd, checkpoint: input.checkpoint, controls: input.controls,
    request: input.request, policy: input.policy, nextIteration: input.nextIteration });
  validateControlRecovery(captured.controls);
  ensure(captured.controls.sessionId === captured.checkpoint.sessionId &&
    captured.controls.checkpoint.revision === captured.checkpoint.revision &&
    captured.controls.checkpoint.checksum === captured.checkpoint.checksum, 'Recovery controls belong to another checkpoint.');
  const request = captured.request;
  const policy = captured.policy;
  ensure(policy && ['none', 'risk', 'mutating', 'interactive'].includes(policy.confirmation) &&
    (policy.mode === null || ['plan', 'hybrid', 'work'].includes(policy.mode)) &&
    ['parallel', 'continueOnLength', 'disableCompression', 'measuredInputReservation', 'inheritScope'].every(key => typeof policy[key as keyof TurnRecoveryPolicy] === 'boolean') &&
    Number.isSafeInteger(policy.maxRetries) && policy.maxRetries >= 0 &&
    (policy.maxProviderRetries === null || Number.isSafeInteger(policy.maxProviderRetries) && policy.maxProviderRetries >= 0),
    'Recovery requires the original explicit execution policy.');
  ensure(request && typeof request.provider === 'string' && !isLocalBackend(request.provider) &&
    typeof request.model === 'string' && !!request.model.trim() && Buffer.byteLength(request.model) <= 512 &&
    (request.reasoningEffort === null || isReasoningEffort(request.reasoningEffort)) &&
    typeof request.target === 'string' && /^[a-f0-9]{64}$/.test(request.target) &&
    Number.isSafeInteger(request.maxOutputTokens) && request.maxOutputTokens > 0 &&
    providerTarget(request.provider).key === request.target,
    'Recovery requires the original explicit supported provider request.');
  const saved = load(captured.cwd, captured.checkpoint);
  const state: RecoveredTurn = { ...saved, request, policy, nextIteration: captured.nextIteration };
  const current = state.progress.iterations;
  ensure(Number.isSafeInteger(state.nextIteration) && state.nextIteration > 0 &&
    (state.nextIteration === current && current > 0 || state.nextIteration === current + 1) &&
    (state.progress.iterationLimit === null || state.nextIteration <= state.progress.iterationLimit) &&
    (state.runtimeState.execution.phase !== 'context_recorded' || state.nextIteration === current),
    'Recovery cannot replenish or guess original iteration allowance.');
  const proof: TurnRecoveryProof = { version: 1, checkpoint: state.checkpoint, project: state.project,
    executionBinding: state.executionBinding, status: saved.status, progress: state.progress,
    runtimeState: state.runtimeState, request: state.request, policy: state.policy,
    controls: captured.controls, nextIteration: state.nextIteration };
  throwIfCancelled(input.signal);
  try {
    const acknowledgment: unknown = await cancellable(Promise.resolve(input.admit(Object.freeze(structuredClone(proof)), input.signal)), input.signal);
    ensure(acknowledgment === undefined, 'Original recovery admission returned an invalid acknowledgment.');
  } catch {
    throwIfCancelled(input.signal);
    throw new ExecutionLimitError('authority', 'Original recovery admission was not acknowledged.');
  }
  throwIfCancelled(input.signal);
  assertUnchanged(state, captured.cwd);
  const control = RuntimeControl.fromCheckpoint(captured.controls);
  const entry: Entry = { state, control, controls: captured.controls, used: false };
  const value = Object.freeze(description(entry)) as PreparedTurnRecovery;
  prepared.set(value, entry);
  return value;
}

/** @internal Reserve the original controller before asynchronous client preflight. */
export function claimTurnRecovery(value: PreparedTurnRecovery): ActiveTurnRecovery {
  const entry = prepared.get(value);
  ensure(entry && !entry.used, 'Original recovery preparation is unavailable or already consumed.');
  entry.control.assertRestoration(entry.controls);
  entry.used = true;
  const claimed = Object.freeze(description(entry)) as ActiveTurnRecovery;
  active.set(claimed, { ...entry, used: false });
  return claimed;
}

/** @internal A data packet cannot substitute for the prepared host admission and original ledger. */
export function takeTurnRecovery(value: PreparedTurnRecovery | ActiveTurnRecovery, cwd: string, execution: AgentExecution | undefined): RecoveredTurn {
  const claimed = prepared.has(value as PreparedTurnRecovery) ? claimTurnRecovery(value as PreparedTurnRecovery) : value as ActiveTurnRecovery;
  const entry = active.get(claimed);
  ensure(entry && !entry.used, 'Original recovery invocation is unavailable or already consumed.');
  entry.control.assertRestoration(entry.controls);
  entry.used = true;
  try {
    assertUnchanged(entry.state, cwd);
    assertExecutionBinding(entry.state.executionBinding, execution, true);
    ensure(execution?.maxOutputTokens === entry.state.request.maxOutputTokens, 'Original recovery output allowance changed.');
    return structuredClone(entry.state);
  } catch (error) {
    entry.control.stop(new Error('Original recovery admission ended before runtime initialization.'));
    throw error;
  }
}

export function turnRecoveryPolicy(options: TurnOptions): TurnRecoveryPolicy {
  return { confirmation: options.confirmation, mode: options.mode ?? null, parallel: options.parallel ?? false,
    continueOnLength: options.continueOnLength ?? false, disableCompression: options.disableCompression ?? false,
    measuredInputReservation: options.measuredInputReservation ?? false, inheritScope: options.inheritScope ?? false,
    maxRetries: options.maxRetries ?? 0, maxProviderRetries: options.maxProviderRetries ?? null };
}

export function assertTurnRecoveryOptions(options: TurnOptions, state: RecoveredTurn): void {
  ensure(options.sessionId === state.checkpoint.sessionId && options.prompt === '' && options.messages.current.length === 0,
    'Recovery must reopen the original conversation without a replacement prompt.');
  ensure(options.provider === state.request.provider && options.model === state.request.model &&
    (options.reasoningEffort ?? null) === state.request.reasoningEffort &&
    canonicalJson(turnRecoveryPolicy(options)) === canonicalJson(state.policy), 'Original recovery request or policy changed.');
  ensure(options.retainRuntimeState === true && options.runtimeStateVersion === 2 &&
    typeof options.onCheckpoint === 'function' && typeof options.onRuntimeStateCommitted === 'function' &&
    typeof options.onTurnProgressCommitted === 'function' && typeof options.onControlReady === 'function',
    'Recovery requires original saved-state and host acknowledgment callbacks.');
  ensure(options.maxIterations === undefined || resolveIterationLimit(options.maxIterations) === (state.progress.iterationLimit ?? Infinity),
    'Original recovery iteration limit changed.');
  ensure((state.progress.completionLimit > 0 ? typeof options.completionCheck === 'function' : options.completionCheck === undefined) &&
    (options.maxCompletionChecks === undefined || options.maxCompletionChecks === state.progress.completionLimit),
    'Original recovery completion requirement changed.');
  ensure(options.runtimeClock === undefined || options.runtimeClock.startedAt === state.runtimeState.startedAt &&
    options.runtimeClock.deadline === state.runtimeState.deadline, 'Original recovery clock changed.');
  ensure(options.maxCostPerRun === undefined || Number.isFinite(options.maxCostPerRun) && options.maxCostPerRun > 0,
    'Recovery cost limits must remain finite and positive.');
}
