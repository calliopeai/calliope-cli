import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

const { spawn, execFileSync } = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock('child_process', () => ({ spawn, execFileSync, execSync: vi.fn() }));
vi.mock('os', async importOriginal => ({ ...await importOriginal<typeof import('os')>(), platform: () => 'darwin' }));
import { ensureImage, executeInSandbox, executeUnsafe } from '../src/sandbox/docker.js';
import { executeInNativeSandbox } from '../src/sandbox/native.js';

function child() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  return proc as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
}

beforeEach(() => { vi.useFakeTimers(); spawn.mockReset(); execFileSync.mockReset().mockReturnValue(Buffer.from('available')); });
afterEach(() => { vi.useRealTimers(); });

describe('sandbox cancellation', () => {
  it('stops an image pull when cancellation arrives', async () => {
    execFileSync.mockImplementation(() => { throw new Error('missing image'); });
    const proc = child();
    spawn.mockReturnValue(proc);
    const controller = new AbortController();
    const result = ensureImage('test-image', controller.signal);
    controller.abort();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(250);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    proc.emit('close', null);
    expect(await result).toBe(false);
  });

  it('waits for container removal and retries after the Docker client closes', async () => {
    const proc = child();
    const firstRemoval = child();
    const finalRemoval = child();
    spawn.mockReturnValueOnce(proc).mockReturnValueOnce(firstRemoval).mockReturnValueOnce(finalRemoval);
    const controller = new AbortController();
    const result = executeInSandbox('bash', 'sleep 100', {}, '/project', controller.signal);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    controller.abort();
    const args = spawn.mock.calls[0]![1] as string[];
    const name = args[args.indexOf('--name') + 1];
    expect(spawn.mock.calls[1]!.slice(0, 2)).toEqual(['docker', ['rm', '--force', name]]);
    proc.emit('close', null);
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(false);
    firstRemoval.stderr.write('No such container');
    firstRemoval.emit('close', 1);
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(settled).toBe(false);
    finalRemoval.emit('close', 0);
    expect(await result).toMatchObject({ success: false, exitCode: 130, sandboxed: true });
  });

  it('attempts container cleanup on timeout and reports failed removal', async () => {
    const proc = child();
    const firstRemoval = child();
    const finalRemoval = child();
    spawn.mockReturnValueOnce(proc).mockReturnValueOnce(firstRemoval).mockReturnValueOnce(finalRemoval);
    const result = executeInSandbox('bash', 'sleep 100', { timeout: 100 }, '/project');
    await vi.advanceTimersByTimeAsync(100);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    firstRemoval.emit('error', new Error('daemon unavailable'));
    proc.emit('close', null);
    await vi.advanceTimersByTimeAsync(0);
    finalRemoval.emit('close', 1);
    expect(await result).toMatchObject({ success: false, exitCode: 124, stderr: expect.stringContaining('Could not confirm removal') });
  });

  it('refuses pre-cancelled unsafe execution without spawning a process', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => executeUnsafe('bash', 'echo bad', 1000, controller.signal)).toThrow('Operation cancelled');
    expect(spawn).not.toHaveBeenCalled();
  });
});


it('cancels native sandbox execution without reporting success', async () => {
  const proc = child();
  spawn.mockReturnValue(proc);
  const controller = new AbortController();
  const result = executeInNativeSandbox('sleep 100', '/project', { signal: controller.signal });
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(spawn.mock.calls[0]![0]).toBe('sandbox-exec');
  expect(spawn.mock.calls[0]![2]).toMatchObject({ detached: process.platform !== 'win32' });
  controller.abort();
  expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  proc.emit('close', null);
  await vi.advanceTimersByTimeAsync(250);
  await assertion;
});
