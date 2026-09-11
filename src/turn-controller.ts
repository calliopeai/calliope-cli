import { isCancellation, throwIfCancelled } from './cancellation.js';

/** Owns one active turn; replacement waits for the previous turn's cleanup. */
export class TurnController {
  private active?: { controller: AbortController; done: Promise<void> };
  private replacement = 0;

  get busy(): boolean { return this.active !== undefined; }

  cancel(): void { this.replacement++; this.active?.controller.abort(); }

  run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.active) return Promise.reject(new Error('A turn is already running'));
    const controller = new AbortController();
    const active = { controller, done: Promise.resolve() };
    this.active = active;
    active.done = Promise.resolve().then(() => { throwIfCancelled(controller.signal); return work(controller.signal); }).catch(error => {
      if (!isCancellation(error)) throw error;
    }).finally(() => {
      if (this.active === active) this.active = undefined;
    });
    return active.done;
  }

  async replace(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const replacement = ++this.replacement;
    const previous = this.active;
    previous?.controller.abort();
    if (previous) await previous.done.catch(() => {});
    if (replacement !== this.replacement) return;
    await this.run(work);
  }
}
