import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function makeProcess() {
  return {
    unref: vi.fn(),
    on: vi.fn(),
    kill: vi.fn(),
  };
}

const originalPlatform = process.platform;

describe('prevent-sleep', () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(async () => {
    const mod = await import('../src/prevent-sleep.js');
    mod.resetPreventSleepForTests();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('should ref-count repeated start/stop calls', async () => {
    const proc = makeProcess();
    spawnMock.mockReturnValue(proc);

    const mod = await import('../src/prevent-sleep.js');
    mod.startPreventSleep();
    mod.startPreventSleep();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'caffeinate',
      ['-di', '-t', '300'],
      { stdio: 'ignore' },
    );

    mod.stopPreventSleep();
    expect(proc.kill).not.toHaveBeenCalled();

    mod.stopPreventSleep();
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('should do nothing outside macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const mod = await import('../src/prevent-sleep.js');
    mod.startPreventSleep();

    expect(spawnMock).not.toHaveBeenCalled();

    mod.stopPreventSleep();
  });
});
