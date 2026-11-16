import { invalid, object } from './format.js';

/** Consumed turn allowance evidence, never authority to resume execution. */
export interface TurnProgress {
  version: 1;
  turnId: string;
  iterationLimit: number | null;
  completionLimit: number;
  iterations: number;
  completionChecks: number;
}

export function validateTurnProgress(value: unknown): asserts value is TurnProgress {
  if (!object(value) || Object.keys(value).sort().join() !== 'completionChecks,completionLimit,iterationLimit,iterations,turnId,version' ||
      value.version !== 1 || typeof value.turnId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.turnId)) throw invalid();
  for (const key of ['completionLimit', 'iterations', 'completionChecks'] as const)
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) throw invalid();
  if (value.iterationLimit !== null && (!Number.isSafeInteger(value.iterationLimit) || Number(value.iterationLimit) < 0) ||
      Number(value.completionLimit) > 8 || Number(value.completionChecks) > Number(value.completionLimit) ||
      Number(value.completionChecks) > Number(value.iterations) || value.iterationLimit !== null && Number(value.iterations) > Number(value.iterationLimit)) throw invalid();
}

export function assertTurnProgress(previous: TurnProgress | undefined, next: TurnProgress | undefined): void {
  if (next !== undefined) validateTurnProgress(next);
  if (previous && (!next || previous.turnId !== next.turnId || previous.iterationLimit !== next.iterationLimit ||
      previous.completionLimit !== next.completionLimit || previous.iterations > next.iterations || previous.completionChecks > next.completionChecks))
    throw invalid();
}
