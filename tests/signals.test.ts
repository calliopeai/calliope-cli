import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #158: top-level signal + error handlers must run an idempotent
// shutdown that tears down the API server and the caffeinate sleep guard.
//
// bin.ts runs main() at module load; CALLIOPE_NO_AUTORUN keeps it dormant so we
// can import and exercise the exported shutdown()/registerProcessHandlers().

const stopApiServer = vi.fn(async () => {});
const stopPreventSleep = vi.fn(() => {});

vi.mock('../src/api-server.js', () => ({ stopApiServer }));
vi.mock('../src/prevent-sleep.js', () => ({ stopPreventSleep }));

async function loadBin() {
  vi.resetModules();
  stopApiServer.mockClear();
  stopPreventSleep.mockClear();
  return import('../src/bin.js');
}

describe('bin shutdown lifecycle (#158)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.CALLIOPE_NO_AUTORUN = '1';
    // process.exit is called by shutdown(); stub it so the test process survives.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      return undefined as never;
    }) as never);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    delete process.env.CALLIOPE_NO_AUTORUN;
  });

  // Happy path: cleanup of both subsystems then a clean exit.
  it('runs stopApiServer + stopPreventSleep and exits 0', async () => {
    const bin = await loadBin();
    await bin.shutdown(0);

    expect(stopApiServer).toHaveBeenCalledTimes(1);
    expect(stopPreventSleep).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('passes a non-zero exit code through to process.exit', async () => {
    const bin = await loadBin();
    await bin.shutdown(1);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Idempotency: a second Ctrl-C mid-shutdown must not re-run cleanup.
  it('is idempotent — second shutdown does not double-run cleanup', async () => {
    const bin = await loadBin();
    await bin.shutdown(0);
    await bin.shutdown(0);

    expect(stopApiServer).toHaveBeenCalledTimes(1);
    expect(stopPreventSleep).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('still exits when a cleanup routine throws', async () => {
    stopApiServer.mockRejectedValueOnce(new Error('boom'));
    const bin = await loadBin();

    await bin.shutdown(1);

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('registers SIGINT, SIGTERM and top-level error handlers', async () => {
    const bin = await loadBin();
    const onSpy = vi.spyOn(process, 'on');
    try {
      bin.registerProcessHandlers();
      const events = onSpy.mock.calls.map((c) => c[0]);
      expect(events).toContain('SIGINT');
      expect(events).toContain('SIGTERM');
      expect(events).toContain('unhandledRejection');
      expect(events).toContain('uncaughtException');
    } finally {
      onSpy.mockRestore();
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('unhandledRejection');
      process.removeAllListeners('uncaughtException');
    }
  });

  // Failure path: an unhandledRejection after startup must run cleanup + exit nonzero.
  it('unhandledRejection handler logs, cleans up, and exits non-zero', async () => {
    const bin = await loadBin();
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((ev: string, fn: (...a: unknown[]) => void) => {
      handlers[ev] = fn;
      return process;
    }) as never);
    try {
      bin.registerProcessHandlers();
      handlers['unhandledRejection'](new Error('rejected'));
      // shutdown() awaits dynamic imports; let microtasks flush.
      await new Promise((r) => setTimeout(r, 0));

      expect(errSpy).toHaveBeenCalled();
      expect(stopApiServer).toHaveBeenCalledTimes(1);
      expect(stopPreventSleep).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      onSpy.mockRestore();
    }
  });
});
