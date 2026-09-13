import { randomUUID } from 'node:crypto';
import { MAX_CONTENT_LENGTH, type StreamCallback } from './types.js';
import { StreamInterruptedError, StreamProtocolError, ProviderRefusalError } from '../errors.js';

/** Metadata only: no response text, tool arguments or provider-private reasoning. */
export interface StreamAttemptEvent {
  version: 1;
  id: string;
  attempt: number;
  state: 'started' | 'completed' | 'failed' | 'cancelled' | 'retrying';
  emittedChars: number;
  delayMs?: number;
}

export const MAX_STREAM_ATTEMPTS = 3;
export function validateStreamAttemptEvent(value: unknown): StreamAttemptEvent {
  if (!value || typeof value !== 'object') throw new StreamProtocolError('Invalid stream attempt event.');
  const event = value as StreamAttemptEvent;
  if (event.version !== 1 || typeof event.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(event.id) ||
    !Number.isSafeInteger(event.attempt) || event.attempt < 1 || event.attempt > MAX_STREAM_ATTEMPTS ||
    !['started','completed','failed','cancelled','retrying'].includes(event.state) || !Number.isSafeInteger(event.emittedChars) || event.emittedChars < 0 || event.emittedChars > MAX_CONTENT_LENGTH ||
    event.state === 'started' && event.emittedChars !== 0 ||
    (event.state === 'retrying' ? !Number.isFinite(event.delayMs) || event.delayMs! < 0 || event.delayMs! > 30000 : event.delayMs !== undefined) ||
    Object.keys(event).some(key => !['version','id','attempt','state','emittedChars','delayMs'].includes(key))) throw new StreamProtocolError('Invalid stream attempt event.');
  return event;
}

export class StreamAttempt {
  readonly id = randomUUID();
  private active = true;
  private waiting = false;
  private chars = 0;
  constructor(readonly attempt: number, private readonly output: StreamCallback,
    private readonly event?: (event: StreamAttemptEvent) => void, private readonly signal?: AbortSignal) { this.emit('started'); }
  private emit(state: StreamAttemptEvent['state'], delayMs?: number): void {
    const event = validateStreamAttemptEvent({ version: 1, id: this.id, attempt: this.attempt, state, emittedChars: this.chars, ...(delayMs === undefined ? {} : { delayMs }) });
    this.event?.(event);
  }
  push = (token: string): void => {
    if (!this.active || this.signal?.aborted) return;
    if (typeof token !== 'string') throw new StreamProtocolError('Provider emitted a non-text stream chunk.');
    if (this.chars + token.length > MAX_CONTENT_LENGTH) throw new StreamProtocolError('Response stream exceeds the local size limit; request less output.');
    this.chars += token.length;
    if (token) this.output(token);
  };
  finish(state: 'completed' | 'failed' | 'cancelled'): void {
    if (this.active || state === 'cancelled' && this.waiting) { this.active = false; this.waiting = false; this.emit(state); }
  }
  retry(delayMs: number): void { this.waiting = true; this.emit('retrying', delayMs); }
  failure(error: unknown, canReset: boolean): unknown {
    if (error instanceof ProviderRefusalError) return error;
    return this.chars && !canReset ? new StreamInterruptedError() : error;
  }
}
