import { describe, expect, it, vi } from 'vitest';
import { RuntimeControl, type ControlRecoveryState, type ControlReceipt } from '../src/runtime/index.js';

const sessionId = 'session-original';
const checksum = 'a'.repeat(64);
function boundary(signal?: AbortSignal) {
  let revision = 0;
  return {
    sessionId, signal,
    checkpoint: vi.fn(async () => ({ revision: `revision-${++revision}`, checksum })),
    validate: vi.fn(async () => {}),
    steer: vi.fn(),
    committed: vi.fn(async (_receipt: ControlReceipt) => {}),
  };
}

async function history(paused = false): Promise<ControlRecoveryState> {
  const control = new RuntimeControl(), b = boundary();
  control.bind(sessionId);
  const waiting = control.pause('original-pause');
  const running = control.boundary(b, true);
  const receipt = await waiting;
  if (paused) {
    control.stop(new Error('Original runner stopped'));
    await expect(running).rejects.toThrow('stopped');
    return structuredClone<ControlRecoveryState>({ version: 1, sessionId, checkpoint: control.state.checkpoint!, phase: 'paused',
      pauses: [{ paused: receipt, resumed: null }], steering: [] });
  }
  const resume = control.resume(receipt);
  await running;
  const resumed = await resume;
  const intent = { sessionId, requestId: 'original-steering', revision: resumed.revision, text: 'Keep the original acceptance criteria.' };
  const steering = control.steer(intent);
  await control.boundary(b, true);
  const steered = await steering;
  expect(b.steer).toHaveBeenCalledExactlyOnceWith(intent.text);
  return structuredClone<ControlRecoveryState>({ version: 1, sessionId, checkpoint: control.state.checkpoint!, phase: 'running',
    pauses: [{ paused: receipt, resumed }], steering: [{ intent, receipt: steered }] });
}

describe('acknowledged original control history', () => {
  it('replays completed receipts without applying steering or writing another checkpoint', async () => {
    const saved = await history(), control = RuntimeControl.fromCheckpoint(saved), b = boundary();
    control.bind(sessionId);
    await expect(control.pause('original-pause')).resolves.toEqual(saved.pauses[0]!.paused);
    await expect(control.resume(saved.pauses[0]!.paused)).resolves.toEqual(saved.pauses[0]!.resumed);
    await expect(control.steer(saved.steering[0]!.intent)).resolves.toEqual(saved.steering[0]!.receipt);
    await control.boundary(b, true);
    expect(b.checkpoint).not.toHaveBeenCalled();
    expect(b.committed).not.toHaveBeenCalled();
    expect(b.steer).not.toHaveBeenCalled();
    expect(() => control.steer({ ...saved.steering[0]!.intent, text: 'Different work' })).toThrow('different intent');
  });

  it('retains the exact original paused receipt and commits only its subsequent resume', async () => {
    const saved = await history(true), control = RuntimeControl.fromCheckpoint(saved), b = boundary();
    control.bind(sessionId);
    const running = control.boundary(b, true);
    await Promise.resolve();
    expect(control.state.phase).toBe('paused');
    expect(b.checkpoint).not.toHaveBeenCalled();
    expect(b.committed).not.toHaveBeenCalled();
    expect(() => control.resume({ ...saved.pauses[0]!.paused, checksum: 'b'.repeat(64) })).toThrow('exact paused');
    const resumed = control.resume(saved.pauses[0]!.paused);
    await running;
    await expect(resumed).resolves.toMatchObject({ sessionId, requestId: 'original-pause', kind: 'resumed' });
    expect(b.checkpoint).toHaveBeenCalledTimes(1);
    expect(b.committed).toHaveBeenCalledTimes(1);
    expect(b.committed.mock.calls[0]![0].kind).toBe('resumed');
    expect(control.state.phase).toBe('running');
  });

  it('keeps recovered controls unbound before and after a wrong-session bind', async () => {
    const saved = await history(), control = RuntimeControl.fromCheckpoint(saved), b = boundary();
    const intent = { ...saved.steering[0]!.intent, requestId: 'fresh-before-bind', revision: saved.checkpoint.revision };
    const held = async () => {
      await expect(control.boundary(b, true)).rejects.toThrow('active turn');
      expect(() => control.steer(intent)).toThrow('current session');
    };
    await held();
    expect(() => control.bind('fresh-session')).toThrow('another session');
    await held();
    expect(b.checkpoint).not.toHaveBeenCalled();
    expect(b.validate).not.toHaveBeenCalled();
    expect(b.committed).not.toHaveBeenCalled();
    expect(b.steer).not.toHaveBeenCalled();
    control.bind(sessionId);
    const accepted = control.steer(intent);
    await control.boundary(b, true);
    await expect(accepted).resolves.toMatchObject({ sessionId, requestId: intent.requestId, kind: 'steered' });
    expect(b.steer).toHaveBeenCalledExactlyOnceWith(intent.text);
    expect(() => control.bind(sessionId)).toThrow('already bound');
  });

  it('detaches the retained state and receipt objects from later caller mutations', async () => {
    const saved = await history(true), receipt = structuredClone(saved.pauses[0]!.paused);
    const control = RuntimeControl.fromCheckpoint(saved);
    saved.sessionId = 'another-session';
    Object.assign(saved.checkpoint, { revision: 'mutated-revision' });
    Object.assign(saved.pauses[0]!.paused, { checksum: 'b'.repeat(64) });
    control.bind(sessionId);
    await expect(control.pause('original-pause')).resolves.toEqual(receipt);
    expect(control.state.checkpoint).toEqual({ revision: receipt.revision, checksum: receipt.checksum });
    control.stop(new Error('Finished fixture'));
  });

  it('can abort a recovered pause without creating new receipts or applying steering', async () => {
    const abort = new AbortController(), control = RuntimeControl.fromCheckpoint(await history(true)), b = boundary(abort.signal);
    control.bind(sessionId);
    const running = control.boundary(b, true);
    abort.abort();
    await expect(running).rejects.toThrow();
    expect(b.checkpoint).not.toHaveBeenCalled();
    expect(b.committed).not.toHaveBeenCalled();
    expect(b.steer).not.toHaveBeenCalled();
    control.stop(new Error('Finished fixture'));
  });

  it('keeps historical control IDs within the original capacity', async () => {
    const saved = await history();
    saved.pauses = [];
    saved.steering = Array.from({ length: 128 }, (_, i) => ({
      intent: { ...saved.steering[0]!.intent, requestId: `steered-${i}` },
      receipt: { ...saved.steering[0]!.receipt, requestId: `steered-${i}` },
    }));
    const control = RuntimeControl.fromCheckpoint(saved);
    control.bind(sessionId);
    expect(() => control.pause('new-pause')).toThrow('another pause');
    expect(() => control.steer({ ...saved.steering[0]!.intent, requestId: 'new-steering', revision: saved.checkpoint.revision })).toThrow('current session');
  });

  it.each<[string, (saved: ControlRecoveryState) => void]>([
    ['another session receipt', saved => { Object.assign(saved.pauses[0]!.paused, { sessionId: 'other' }); }],
    ['running with an open pause', saved => { saved.pauses[0]!.resumed = null; }],
    ['paused without an open pause', saved => { saved.phase = 'paused'; }],
    ['non-string phase', saved => { Object.assign(saved, { phase: Object('running') }); }],
    ['duplicate request IDs', saved => { Object.assign(saved.steering[0]!.intent, { requestId: saved.pauses[0]!.paused.requestId }); Object.assign(saved.steering[0]!.receipt, { requestId: saved.pauses[0]!.paused.requestId }); }],
    ['wrong resumed request', saved => { Object.assign(saved.pauses[0]!.resumed!, { requestId: 'other' }); }],
    ['wrong receipt kind', saved => { Object.assign(saved.pauses[0]!.resumed!, { kind: 'paused' }); }],
    ['unbound steering receipt', saved => { Object.assign(saved.steering[0]!.receipt, { requestId: 'other' }); }],
    ['damaged checkpoint', saved => { Object.assign(saved.checkpoint, { checksum: 'damaged' }); }],
    ['unexpected fields', saved => { Object.assign(saved, { grant: true }); }],
    ['empty steering text', saved => { Object.assign(saved.steering[0]!.intent, { text: ' ' }); }],
  ])('holds invalid retained history: %s', async (_, change) => {
    const saved = await history();
    change(saved);
    expect(() => RuntimeControl.fromCheckpoint(saved)).toThrow('original session remains held');
  });
  it.each(['steering-only', 'mixed'] as const)('refuses oversized retained history: %s', async kind => {
    const saved = await history(), pause = saved.pauses[0]!, steer = saved.steering[0]!;
    saved.pauses = kind === 'mixed' ? Array.from({ length: 64 }, (_, i) => ({
      paused: { ...pause.paused, requestId: `pause-${i}` },
      resumed: { ...pause.resumed!, requestId: `pause-${i}` },
    })) : [];
    saved.steering = Array.from({ length: kind === 'mixed' ? 65 : 129 }, (_, i) => ({
      intent: { ...steer.intent, requestId: `steer-${i}` },
      receipt: { ...steer.receipt, requestId: `steer-${i}` },
    }));
    expect(saved.pauses.length + saved.steering.length).toBe(129);
    if (kind === 'mixed') {
      expect(saved.pauses.length).toBeLessThan(129);
      expect(saved.steering.length).toBeLessThan(129);
    }
    expect(() => RuntimeControl.fromCheckpoint(saved)).toThrow('original session remains held');
  });

});
