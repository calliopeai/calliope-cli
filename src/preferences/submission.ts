import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from '../cancellation.js';
import { parseOnce } from './once.js';
import { applyTurnPreference } from './resolve.js';
import type { ResolvedPreference } from './types.js';

export interface Submission {
  id: string;
  text: string;
  prompt: string;
  base: ResolvedPreference;
  selection: ResolvedPreference;
}

export function createSubmission(text: string, base: ResolvedPreference): Submission {
  if (!text.trim() || text.length > 1024 * 1024) throw new Error('A prompt must contain 1–1048576 characters');
  const once = parseOnce(text);
  if (!once && text.trimStart().startsWith('/')) throw new Error('Queue a prompt or use /once; other commands must run outside the queue');
  return { id: randomUUID(), text, prompt: once?.prompt ?? text, base: applyTurnPreference(base), selection: applyTurnPreference(base, once?.preference) };
}

/** Preserve pending work on failure/cancellation; never combine independent turns. */
export async function drainSubmissions(first: Submission, options: {
  run: (submission: Submission) => Promise<boolean>;
  next: () => Submission | undefined;
  signal?: AbortSignal;
}): Promise<'empty' | 'stopped' | 'limit'> {
  let submission: Submission | undefined = first;
  for (let count = 0; count < 100; count++) {
    throwIfCancelled(options.signal);
    if (!await options.run(submission)) return 'stopped';
    throwIfCancelled(options.signal);
    if (count === 99) return 'limit';
    submission = options.next();
    if (!submission) return 'empty';
  }
  return 'limit';
}
