import { cancellable, throwIfCancelled } from '../cancellation.js';

export const CONTROL_CHECKPOINT_PROTOCOL_VERSION = 1;

export interface ControlCheckpoint { readonly revision: string; readonly checksum: string }
export interface ControlReadyCheckpoint extends ControlCheckpoint { readonly sessionId: string }
export interface ControlReceipt extends ControlCheckpoint {
  readonly sessionId: string;
  readonly requestId: string;
  readonly kind: 'paused' | 'resumed' | 'steered';
}
export interface SteeringIntent {
  readonly requestId: string;
  readonly sessionId: string;
  readonly revision: string;
  readonly text: string;
}
type Pending<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function pending<T>(): Pending<T> {
  let resolve!: Pending<T>['resolve'], reject!: Pending<T>['reject'];
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // An operator may disconnect before reading a terminal receipt. Keep the
  // original rejected promise available without an unhandled process rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function identifier(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    throw new Error('Control request ID is invalid.');
}
type Pause = { id: string; paused: Pending<ControlReceipt>; receipt?: ControlReceipt;
  resume?: Pending<ControlReceipt> };
type Steering = { intent: SteeringIntent; result: Pending<ControlReceipt>; applied: boolean };

export interface ControlBoundary {
  sessionId: string;
  signal?: AbortSignal;
  checkpoint: () => Promise<ControlCheckpoint>;
  validate: () => void | Promise<void>;
  steer: (text: string) => void;
  committed?: (receipt: ControlReceipt, signal?: AbortSignal) => void | Promise<void>;
}

/** One live turn's cooperative control. It is not a process-recovery journal. */
export class RuntimeControl {
  #sessionId?: string;
  #checkpoint?: ControlCheckpoint;
  #phase: 'running' | 'pausing' | 'paused' | 'stopped' = 'running';
  #pause?: Pause;
  #pauses = new Map<string, Pause>();
  #steering = new Map<string, Steering>();
  #changes = new Set<() => void>();
  #version = 0;
  #bound = false;

  get state() {
    return Object.freeze({ phase: this.#phase, sessionId: this.#sessionId,
      checkpoint: this.#checkpoint && Object.freeze({ ...this.#checkpoint }) });
  }

  pause(requestId: string): Promise<ControlReceipt> {
    identifier(requestId);
    const previous = this.#pauses.get(requestId);
    if (previous) return previous.paused.promise;
    if (this.#phase === 'stopped' || this.#pause || this.#steering.has(requestId)
        || this.#pauses.size + this.#steering.size >= 128)
      throw new Error('This turn cannot accept another pause request.');
    const entry: Pause = { id: requestId, paused: pending<ControlReceipt>() };
    this.#pauses.set(requestId, entry); this.#pause = entry; this.#phase = 'pausing';
    this.#changed();
    return entry.paused.promise;
  }

  resume(receipt: ControlReceipt): Promise<ControlReceipt> {
    const entry = this.#pauses.get(receipt.requestId);
    if (!entry?.receipt || receipt.kind !== 'paused' || receipt.sessionId !== this.#sessionId
        || receipt.revision !== entry.receipt.revision || receipt.checksum !== entry.receipt.checksum)
      throw new Error('Resume requires the exact paused conversation receipt.');
    if (entry.resume) return entry.resume.promise;
    if (this.#phase !== 'paused' || this.#pause !== entry)
      throw new Error('This pause is no longer resumable.');
    entry.resume = pending<ControlReceipt>();
    this.#changed();
    return entry.resume.promise;
  }

  steer(intent: SteeringIntent): Promise<ControlReceipt> {
    identifier(intent.requestId);
    const previous = this.#steering.get(intent.requestId);
    if (previous) {
      const old = previous.intent;
      if (old.sessionId !== intent.sessionId || old.revision !== intent.revision || old.text !== intent.text)
        throw new Error('The steering request ID already belongs to a different intent.');
      return previous.result.promise;
    }
    if (!this.#bound || this.#phase === 'stopped' || this.#pauses.has(intent.requestId)
        || intent.sessionId !== this.#sessionId
        || intent.revision !== this.#checkpoint?.revision || typeof intent.text !== 'string'
        || !intent.text.trim() || intent.text.includes('\0') || Buffer.byteLength(intent.text, 'utf8') > 16 * 1024
        || this.#pauses.size + this.#steering.size >= 128)
      throw new Error('Steering requires the current session, revision and bounded text.');
    this.#steering.set(intent.requestId, { intent: Object.freeze({ ...intent }),
      result: pending<ControlReceipt>(), applied: false });
    this.#changed();
    return this.#steering.get(intent.requestId)!.result.promise;
  }

  /** @internal Called once by the canonical runtime, never by a host adapter. */
  bind(sessionId: string): void {
    if (this.#bound || this.#phase === 'stopped') throw new Error('Control is already bound to a turn.');
    this.#bound = true; this.#sessionId = sessionId;
  }

  /** @internal The existing conversation writer supplies this proof. */
  observe(proof: ControlCheckpoint): void {
    if (!proof || typeof proof.revision !== 'string' || !proof.revision
        || typeof proof.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(proof.checksum))
      throw new Error('Execution control requires a saved conversation checkpoint.');
    this.#checkpoint = Object.freeze({ revision: proof.revision, checksum: proof.checksum });
  }

  #changed(): void {
    this.#version++;
    for (const wake of this.#changes) wake();
    this.#changes.clear();
  }

  async #change(version: number, signal?: AbortSignal): Promise<void> {
    if (version !== this.#version) return;
    let wake!: () => void;
    const changed = new Promise<void>(resolve => { wake = resolve; this.#changes.add(wake); });
    try { await cancellable(changed, signal); }
    finally { this.#changes.delete(wake); }
  }

  async #receipt(kind: ControlReceipt['kind'], requestId: string, boundary: ControlBoundary): Promise<ControlReceipt> {
    const proof = await boundary.checkpoint();
    this.observe(proof);
    const receipt = Object.freeze({ revision: proof.revision, checksum: proof.checksum,
      sessionId: boundary.sessionId, requestId, kind });
    await cancellable(Promise.resolve(boundary.committed?.(receipt, boundary.signal)), boundary.signal);
    throwIfCancelled(boundary.signal);
    return receipt;
  }

  /** @internal Only enter when all active work has settled or is explicitly parked. */
  async boundary(boundary: ControlBoundary, allowSteering: boolean): Promise<void> {
    throwIfCancelled(boundary.signal);
    if (!this.#bound || boundary.sessionId !== this.#sessionId || this.#phase === 'stopped')
      throw new Error('Control boundary does not belong to this active turn.');
    const pause = this.#pause;
    if (pause) {
      pause.receipt = await this.#receipt('paused', pause.id, boundary);
      this.#phase = 'paused'; pause.paused.resolve(pause.receipt);
      while (!pause.resume) {
        if (this.state.phase === 'stopped') throw new Error('Turn control has stopped.');
        await this.#change(this.#version, boundary.signal);
      }
      await boundary.validate();
      throwIfCancelled(boundary.signal);
      const receipt = await this.#receipt('resumed', pause.id, boundary);
      this.#phase = 'running'; this.#pause = undefined; pause.resume.resolve(receipt);
    }
    if (allowSteering) for (const entry of this.#steering.values()) {
      if (entry.applied) continue;
      await boundary.validate(); throwIfCancelled(boundary.signal);
      boundary.steer(entry.intent.text);
      const receipt = await this.#receipt('steered', entry.intent.requestId, boundary);
      entry.applied = true; entry.result.resolve(receipt);
    }
  }

  /** @internal A question wait cannot change the snapshot until control resumes. */
  async parked<T>(operation: Promise<T>, boundary: ControlBoundary): Promise<T> {
    const failed = new AbortController();
    let failure: { error: unknown } | undefined;
    const done = Promise.resolve(operation).then(value => ({ value }), error => {
      failure = { error }; failed.abort(); return failure;
    });
    const parkedBoundary = { ...boundary, signal: boundary.signal
      ? AbortSignal.any([boundary.signal, failed.signal]) : failed.signal };
    try {
      while (true) {
        const version = this.#version;
        await this.boundary(parkedBoundary, false);
        const waiting = new AbortController();
        const signal = AbortSignal.any([parkedBoundary.signal, waiting.signal]);
        const change = this.#change(version, signal).then(() => null);
        let result: Awaited<typeof done> | null;
        try { result = await Promise.race([done, change]); }
        finally { waiting.abort(); await change.catch(() => {}); }
        if (result === null) continue;
        await this.boundary(parkedBoundary, false);
        if ('error' in result) throw result.error;
        return result.value;
      }
    } catch (error) {
      if (failure) throw failure.error;
      throw error;
    }
  }

  /** @internal End the same turn; pending controls never become new dispatches. */
  stop(error: unknown): void {
    this.#phase = 'stopped';
    this.#pause?.paused.reject(error); this.#pause?.resume?.reject(error);
    for (const entry of this.#steering.values()) if (!entry.applied) entry.result.reject(error);
    this.#changed();
  }
}
