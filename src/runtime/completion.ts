import type { ControlCheckpoint } from './control.js';

export const COMPLETION_CHECK_PROTOCOL_VERSION = 1;

export interface CompletionProposal extends ControlCheckpoint {
  readonly sessionId: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly content: string;
}
export type CompletionVerdict =
  | { readonly accepted: true; readonly evidenceSha256: string }
  | { readonly accepted: false; readonly feedback: string };
export type CompletionCheck = (proposal: CompletionProposal, signal?: AbortSignal) => Promise<CompletionVerdict>;
export interface CompletionVerification extends ControlCheckpoint {
  readonly sessionId: string;
  readonly evidenceSha256: string;
  readonly checks: number;
}

export function completionCheckLimit(check: CompletionCheck | undefined, limit: number | undefined): number {
  if (check === undefined && limit === undefined) return 0;
  if (typeof check !== 'function') throw new Error('Completion checks require a host verifier.');
  const count = limit ?? 3;
  if (!Number.isSafeInteger(count) || count < 1 || count > 8)
    throw new Error('Completion checks must be bounded from 1 to 8.');
  return count;
}

export function completionVerdict(value: unknown): CompletionVerdict {
  if (!value || typeof value !== 'object') throw new Error('Completion verifier returned an invalid verdict.');
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort().join(',');
  if (result.accepted === true && keys === 'accepted,evidenceSha256' &&
      typeof result.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(result.evidenceSha256))
    return Object.freeze({ accepted: true, evidenceSha256: result.evidenceSha256 });
  if (result.accepted === false && keys === 'accepted,feedback' && typeof result.feedback === 'string' &&
      result.feedback.trim() && !result.feedback.includes('\0') && Buffer.byteLength(result.feedback, 'utf8') <= 16 * 1024)
    return Object.freeze({ accepted: false, feedback: result.feedback });
  throw new Error('Completion verifier returned an invalid verdict.');
}
