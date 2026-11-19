import { isCancellation } from '../cancellation.js';
import { StreamProtocolError } from '../errors.js';
import type { LLMResponse } from '../types.js';

/** Complete response facts carried out of an interrupted adapter, never execution authority. */
export class CompletedResponseInterruptedError extends Error {
  constructor(readonly response: LLMResponse, cause: unknown) {
    super('A completed provider response was interrupted.', { cause });
    this.name = 'CompletedResponseInterruptedError';
  }
}

/** A parser/schema failure cannot attest completion, even after an earlier terminal frame. */
export function isRetainableResponseInterruption(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;
  let identified = false, sawTypeError = false, codedTransport = false;
  while (current instanceof Error && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    if (current instanceof TypeError) sawTypeError = true;
    if (current instanceof StreamProtocolError || current instanceof SyntaxError) return false;
    if (isCancellation(current)) identified = true;
    if (current.name === 'APIConnectionError' || current.name === 'APIConnectionTimeoutError') identified = true;
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && ['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) { identified = true; codedTransport = true; }
    current = current.cause;
  }
  return identified && !(current instanceof Error) && (!sawTypeError || codedTransport);
}

/** Unknown post-terminal faults hold the reservation; only identified interruption retains facts. */
export function interruptCompletedResponse(response: LLMResponse, cause: unknown): never {
  if (cause instanceof StreamProtocolError) throw cause;
  if (isRetainableResponseInterruption(cause)) throw new CompletedResponseInterruptedError(response, cause);
  throw new StreamProtocolError('Provider stream was invalid after completion; its reservation remains charged.');
}

/** Unknown SDK/parser failures are not transport retry permission in accounted capture mode. */
export function throwUnverifiedStreamFailure(error: unknown): never {
  if (error instanceof StreamProtocolError || isRetainableResponseInterruption(error)) throw error;
  const status = error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
  // Preserve the SDK's explicit HTTP error path and the existing status-based retry policy.
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) throw error;
  throw new StreamProtocolError('Provider stream could not be validated; its reservation remains charged.');
}
