import { isCancellation, throwIfCancelled } from './cancellation.js';

/** Owns one active turn; replacement waits for the previous turn's cleanup. */
export class TurnController {
  private active?: { controller: AbortController; done: Promise<void>; companion?:Promise<void>; closing?:boolean };
  private replacement = 0;

  get busy(): boolean { return this.active !== undefined; }

  cancel(): void { this.replacement++; this.active?.controller.abort(); }

  /** One control operation may join the active turn and shares its cancellation. */
  join(work:(signal:AbortSignal)=>Promise<void>):Promise<void> {
    const active=this.active;if(!active)return this.run(work);
    if(active.companion||active.closing)return Promise.reject(new Error('A child admission is already running or the active turn is finishing'));
    const done=Promise.resolve().then(()=>{throwIfCancelled(active.controller.signal);return work(active.controller.signal);}).catch(error=>{if(!isCancellation(error))throw error;}).finally(()=>{if(active.companion===done)active.companion=undefined;});
    active.companion=done;return done;
  }

  run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.active) return Promise.reject(new Error('A turn is already running'));
    const controller = new AbortController();
    const active:NonNullable<TurnController['active']> = { controller, done: Promise.resolve() };
    this.active = active;
    active.done = Promise.resolve().then(() => { throwIfCancelled(controller.signal); return work(controller.signal); }).catch(error => {
      controller.abort();
      if (!isCancellation(error)) throw error;
    }).finally(async () => {
      active.closing=true;
      if(active.companion)await active.companion.catch(()=>{});
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
