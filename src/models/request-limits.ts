import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMProvider } from '../types.js';

interface RequestModelLimits {
  provider: LLMProvider;
  model: string;
  contextLength?: number;
  maxOutputTokens?: number;
  assertCurrent: () => void;
}

const limits = new AsyncLocalStorage<RequestModelLimits | undefined>();

/** Trusted request host only; does not mutate discovery or grant model eligibility. */
export function withRequestModelLimits<T>(value: RequestModelLimits | undefined, action: () => T): T {
  return limits.run(value, action);
}

export function requestModelLimits(provider: LLMProvider, model: string): Readonly<RequestModelLimits> | undefined {
  const current = limits.getStore();
  if (!current || current.provider !== provider || current.model !== model) return undefined;
  current.assertCurrent();
  return current;
}
