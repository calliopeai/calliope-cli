import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { bindProcessCancellation } from '../src/process-cancellation.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancellable, cancellableDelay, cancellationError } from '../src/cancellation.js';
import { withRetry } from '../src/errors.js';
import { TurnController } from '../src/turn-controller.js';

afterEach(() => vi.useRealTimers());

describe('cancellable execution', () => {
  it('does not start a request that was cancelled before dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    await expect(withRetry(request, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels a pending request without retrying and handles a late rejection', async () => {
    const controller = new AbortController();
    let fail!: (error: Error) => void;
    const request = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
    const run = withRetry(request, { signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    fail(new Error('late socket close'));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('cancels retry backoff and removes its timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue(new Error('network unavailable'));
    const onRetry = vi.fn();
    const run = withRetry(request, { signal: controller.signal, onRetry });
    const assertion = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not retry SDK cancellation even without a signal', async () => {
    const error = new Error('Request was aborted');
    error.name = 'APIUserAbortError';
    const request = vi.fn().mockRejectedValue(error);
    await expect(withRetry(request)).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('cleans up completed waits and rejects an already cancelled promise', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(cancellable(Promise.resolve(42), controller.signal)).resolves.toBe(42);
    await cancellableDelay(1, controller.signal);
    expect(remove).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(cancellable(Promise.resolve(1), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => cancellableDelay(1, controller.signal)).toThrow('Operation cancelled');
    await expect(cancellable(Promise.reject(new Error('failure')))).rejects.toThrow('failure');
  });
});

describe('turn ownership', () => {
  it('bounds joined admissions, propagates cancellation, and waits for their cleanup before replacement',async()=>{
    const turns=new TurnController(),events:string[]=[];let clean!:()=>void;
    const parent=turns.run(signal=>cancellableDelay(10000,signal));await Promise.resolve();
    const child=turns.join(async signal=>{try{await cancellableDelay(10000,signal);}finally{await new Promise<void>(resolve=>{clean=resolve;});events.push('child cleaned');}});
    await Promise.resolve();await expect(turns.join(async()=>{})).rejects.toThrow(/already running/);
    const replacement=turns.replace(async()=>{events.push('replacement');});await vi.waitFor(()=>expect(clean).toBeTypeOf('function'));expect(turns.busy).toBe(true);expect(events).toEqual([]);clean();await Promise.all([parent,child,replacement]);expect(events).toEqual(['child cleaned','replacement']);expect(turns.busy).toBe(false);
    await turns.join(async()=>{});expect(turns.busy).toBe(false);
  });
  it('retains ownership until a joined command completes and rejects additions during cleanup',async()=>{
    const turns=new TurnController();let finish!:()=>void;const parent=turns.run(async()=>{}),child=turns.join(()=>new Promise<void>(resolve=>{finish=resolve;}));await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    expect(turns.busy).toBe(true);await expect(turns.join(async()=>{})).rejects.toThrow(/finishing/);finish();await Promise.all([parent,child]);expect(turns.busy).toBe(false);
    let release!:()=>void;const run=turns.run(()=>new Promise<void>(resolve=>{release=resolve;}));await expect(turns.join(async()=>{throw new Error('admission failed');})).rejects.toThrow('admission failed');release();await run;
  });
  it('rejects overlapping turns and waits for cleanup before replacement', async () => {
    const turns = new TurnController();
    const events: string[] = [];
    let clean!: () => void;
    const first = turns.run(async signal => {
      try { await cancellable(new Promise<void>(() => {}), signal); }
      finally {
        await new Promise<void>(resolve => { clean = resolve; });
        events.push('cleaned');
      }
    });
    await Promise.resolve();
    expect(turns.busy).toBe(true);
    await expect(turns.run(async () => {})).rejects.toThrow('already running');
    const next = turns.replace(async signal => {
      expect(signal.aborted).toBe(false);
      events.push('next');
    });
    await vi.waitFor(() => expect(clean).toBeTypeOf('function'));
    expect(events).toEqual([]);
    clean();
    await Promise.all([first, next]);
    expect(events).toEqual(['cleaned', 'next']);
    expect(turns.busy).toBe(false);
  });

  it('keeps only the latest pending replacement and permits recovery after errors', async () => {
    const turns = new TurnController();
    const first = turns.run(async signal => { await cancellableDelay(10000, signal); });
    await Promise.resolve();
    const stale = vi.fn(async () => {});
    const latest = vi.fn(async () => {});
    await Promise.all([first, turns.replace(stale), turns.replace(latest)]);
    expect(stale).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    await expect(turns.run(async () => { throw new Error('broken'); })).rejects.toThrow('broken');
    await turns.run(async () => { throw cancellationError(); });
    expect(turns.busy).toBe(false);
  });
});


describe('cancelling pending replacement', () => {
  it('does not start a replacement after a subsequent cancel', async () => {
    const turns = new TurnController();
    let clean!: () => void;
    const first = turns.run(async signal => {
      try { await cancellableDelay(10000, signal); }
      finally { await new Promise<void>(resolve => { clean = resolve; }); }
    });
    await Promise.resolve();
    const work = vi.fn(async () => {});
    const replacement = turns.replace(work);
    await vi.waitFor(() => expect(clean).toBeTypeOf('function'));
    turns.cancel();
    clean();
    await Promise.all([first, replacement]);
    expect(work).not.toHaveBeenCalled();
    expect(turns.busy).toBe(false);
  });
});


it('retains process ownership through escalation after the parent closes', async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const controller = new AbortController();
  const done = bindProcessCancellation(child as unknown as ChildProcess, controller.signal);
  let stopped = false;
  void done.then(() => { stopped = true; });
  controller.abort();
  child.emit('close', null);
  await vi.advanceTimersByTimeAsync(249);
  expect(stopped).toBe(false);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  await vi.advanceTimersByTimeAsync(1);
  await done;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(stopped).toBe(true);
});
