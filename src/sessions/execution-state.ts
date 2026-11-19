import { invalid, object } from './format.js';

export type ExecutionPhase = 'ready' | 'provider_pending' | 'response_recorded' | 'context_recorded' | 'tools_pending' | 'question_pending' | 'verification_pending';
export interface RuntimeEffect { kind: 'provider' | 'tool' | 'question' | 'verification'; id: string }
/** Phase facts are checkpoint evidence. They do not admit a replacement owner. */
export interface TurnExecutionState {
  phase: ExecutionPhase;
  activeEffects: RuntimeEffect[];
}

export function validateExecutionState(value: unknown): asserts value is TurnExecutionState {
  if (!object(value) || Object.keys(value).sort().join() !== 'activeEffects,phase' ||
      typeof value.phase !== 'string' || !['ready', 'provider_pending', 'response_recorded', 'context_recorded', 'tools_pending', 'question_pending', 'verification_pending'].includes(value.phase) ||
      !Array.isArray(value.activeEffects)) throw invalid();
  const ids = new Set<string>();
  for (const effect of value.activeEffects) {
    if (!object(effect) || Object.keys(effect).sort().join() !== 'id,kind' ||
        typeof effect.kind !== 'string' || !['provider', 'tool', 'question', 'verification'].includes(effect.kind) ||
        typeof effect.id !== 'string' || !effect.id || Buffer.byteLength(effect.id) > 1024 || /[\x00-\x1f\x7f]/.test(effect.id) || ids.has(effect.id)) throw invalid();
    ids.add(effect.id);
    const expected = value.phase === 'provider_pending' ? 'provider' : value.phase === 'verification_pending' ? 'verification'
      : value.phase === 'question_pending' ? 'question' : value.phase === 'tools_pending' ? 'tool' : null;
    if (effect.kind !== expected) throw invalid();
  }
  if ((value.phase === 'provider_pending' || value.phase === 'verification_pending' || value.phase === 'question_pending') && value.activeEffects.length !== 1 ||
      (value.phase === 'ready' || value.phase === 'response_recorded' || value.phase === 'context_recorded') && value.activeEffects.length !== 0) throw invalid();
}
