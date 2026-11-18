import { invalid, object } from './format.js';
import type { TurnProgress } from './turn-progress.js';
import { validateExecutionState, type TurnExecutionState } from './execution-state.js';

/** Checkpoint evidence only. Native ownership and the original ledger still authorize execution. */
interface TurnRuntimeBase {
  turnId: string;
  startedAt: number;
  deadline: number | null;
  maxCostUsd: number | null;
  continuations: number;
  responseUsageComplete: boolean;
  totals: { inputTokens: number; outputTokens: number; estimatedCostUsd: number; toolCalls: number };
  effect: { kind: 'quiescent' } | { kind: 'provider' | 'tool' | 'question' | 'verification'; id: string };
}

export type TurnRuntimeState = TurnRuntimeBase & (
  | { version: 1 }
  | { version: 2; execution: TurnExecutionState }
);

export function validateTurnRuntimeState(value: unknown): asserts value is TurnRuntimeState {
  if (!object(value) || Object.keys(value).sort().join() !== (value.version === 2
      ? 'continuations,deadline,effect,execution,maxCostUsd,responseUsageComplete,startedAt,totals,turnId,version'
      : 'continuations,deadline,effect,maxCostUsd,responseUsageComplete,startedAt,totals,turnId,version') ||
      value.version !== 1 && value.version !== 2 || typeof value.turnId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.turnId) ||
      !Number.isSafeInteger(value.startedAt) || Number(value.startedAt) < 0 ||
      value.deadline !== null && (!Number.isSafeInteger(value.deadline) || Number(value.deadline) < Number(value.startedAt)) ||
      value.maxCostUsd !== null && (typeof value.maxCostUsd !== 'number' || !Number.isFinite(value.maxCostUsd) || value.maxCostUsd <= 0) ||
      !Number.isSafeInteger(value.continuations) || Number(value.continuations) < 0 || Number(value.continuations) > 4 ||
      typeof value.responseUsageComplete !== 'boolean' || !object(value.totals) ||
      Object.keys(value.totals).sort().join() !== 'estimatedCostUsd,inputTokens,outputTokens,toolCalls' || !object(value.effect)) throw invalid();
  if (value.version === 2) validateExecutionState(value.execution);
  for (const key of ['inputTokens', 'outputTokens', 'toolCalls'] as const)
    if (!Number.isSafeInteger(value.totals[key]) || Number(value.totals[key]) < 0) throw invalid();
  if (typeof value.totals.estimatedCostUsd !== 'number' || !Number.isFinite(value.totals.estimatedCostUsd) || value.totals.estimatedCostUsd < 0) throw invalid();
  if (value.effect.kind === 'quiescent') {
    if (Object.keys(value.effect).join() !== 'kind') throw invalid();
  } else if (typeof value.effect.kind !== 'string' || !['provider', 'tool', 'question', 'verification'].includes(value.effect.kind) ||
      Object.keys(value.effect).sort().join() !== 'id,kind' || typeof value.effect.id !== 'string' ||
      value.effect.id.length < 1 || Buffer.byteLength(value.effect.id) > 1024 || /[\x00-\x1f\x7f]/.test(value.effect.id)) throw invalid();
  if (value.version === 2) {
    const state = value.execution as TurnExecutionState;
    const kind = state.phase === 'ready' || state.phase === 'context_recorded' ? 'quiescent' : state.phase === 'provider_pending' || state.phase === 'response_recorded' ? 'provider'
      : state.phase === 'verification_pending' ? 'verification' : state.phase === 'question_pending' ? 'question' : 'tool';
    const representativeId = value.effect.id;
    if (value.effect.kind !== kind || state.activeEffects.length &&
        !state.activeEffects.some(effect => effect.id === representativeId)) throw invalid();
  }
}

export function assertTurnRuntimeState(previous: TurnRuntimeState | undefined, next: TurnRuntimeState | undefined): void {
  if (next !== undefined) validateTurnRuntimeState(next);
  if (!previous) return;
  if (!next || previous.version !== next.version || previous.turnId !== next.turnId || previous.startedAt !== next.startedAt || previous.deadline !== next.deadline ||
      previous.maxCostUsd !== next.maxCostUsd || !previous.responseUsageComplete && next.responseUsageComplete ||
      (['inputTokens', 'outputTokens', 'estimatedCostUsd', 'toolCalls'] as const).some(key => previous.totals[key] > next.totals[key])) throw invalid();
}

export function assertRuntimeProgress(state: TurnRuntimeState | undefined, progress: TurnProgress | undefined): void {
  if (state && (!progress || state.turnId !== progress.turnId)) throw invalid();
}
