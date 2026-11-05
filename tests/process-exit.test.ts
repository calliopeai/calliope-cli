/** The killed-process check behind calliopeai/calliope-cli#481, under the condition that broke it. */
import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { reapedOrSigkilled } from './helpers/process-exit.js';

const started: ChildProcess[] = [], strays: number[] = [];
afterEach(() => {
  for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
  for (const child of started.splice(0)) child.kill('SIGKILL');
});

const state = (pid: number) => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
};

/**
 * A running `sleep` whose parent never waits for it: sh forks it, then execs a
 * second `sleep`. A killed hook process is in the same position once its shell
 * is gone and a PID 1 that never reaps (a Python runner) has adopted it.
 */
async function unreapedChild(): Promise<number> {
  const parent = spawn('sh', ['-c', 'sleep 30 & echo $!; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(parent);
  const pid = Number(String((await once(parent.stdout!, 'data'))[0]).trim());
  strays.push(pid);
  // Act only after the exec, so the shell can never be the one that reaps it.
  await vi.waitFor(() => expect(readFileSync(`/proc/${parent.pid}/comm`, 'utf8')).toBe('sleep\n'), { timeout: 5000, interval: 10 });
  return pid;
}

it.skipIf(process.platform === 'win32')('counts a process as running until it is killed and reaped', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>console.log('ignored'));console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(child);
  await once(child.stdout!, 'data');
  child.kill('SIGTERM');
  await once(child.stdout!, 'data');
  expect(reapedOrSigkilled(child.pid!)).toBe(false);
  child.kill('SIGKILL');
  await vi.waitFor(() => expect(reapedOrSigkilled(child.pid!)).toBe(true), { timeout: 5000, interval: 10 });
});

it.skipIf(process.platform !== 'linux')('counts a SIGKILLed process that its parent never reaps as killed', async () => {
  const pid = await unreapedChild();
  expect(reapedOrSigkilled(pid)).toBe(false);
  process.kill(pid, 'SIGKILL');
  await vi.waitFor(() => expect(reapedOrSigkilled(pid)).toBe(true), { timeout: 5000, interval: 10 });
  // The zombie still answers kill(pid, 0), so an ESRCH-only check reports it as surviving.
  expect(state(pid)).toBe('Z');
  expect(() => process.kill(pid, 0)).not.toThrow();
});

it.skipIf(process.platform !== 'linux')('does not count an unreaped process that another signal ended', async () => {
  const pid = await unreapedChild();
  process.kill(pid, 'SIGTERM');
  await vi.waitFor(() => expect(state(pid)).toBe('Z'), { timeout: 5000, interval: 10 });
  expect(reapedOrSigkilled(pid)).toBe(false);
});
