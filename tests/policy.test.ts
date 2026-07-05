/**
 * Tests for src/policy.ts — the pre-tool policy hook.
 *
 * child_process is mocked so no real process is spawned. Covers: no-policy
 * pass-through, allow (exit 0), deny (non-zero + stderr reason), fail-closed on
 * timeout, fail-closed on spawn error, stdin delivery of the tool-call JSON, and
 * config-driven enablement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// -- Mocks (declared before importing the module under test) ----------------

let policyConfig: { command?: string; timeoutMs?: number } | undefined;
vi.mock('../src/config.js', () => ({
  default: {},
  get: (key: string) => (key === 'policy' ? policyConfig : undefined),
}));

const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { evaluatePolicy, isPolicyEnabled, getPolicyCommand } from '../src/policy.js';
import type { ToolCall } from '../src/types.js';

// -- Fake child process -----------------------------------------------------

interface FakeProc extends EventEmitter {
  pid: number;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = 2147483646; // negative-group kill will ESRCH; harmless
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => proc.emit('close', null));
  return proc;
}

const toolCall: ToolCall = { id: 't1', name: 'shell', arguments: { command: 'rm -rf /' } };

beforeEach(() => {
  policyConfig = undefined;
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('getPolicyCommand / isPolicyEnabled', () => {
  it('is disabled when no command configured', () => {
    policyConfig = undefined;
    expect(getPolicyCommand()).toBeUndefined();
    expect(isPolicyEnabled()).toBe(false);
  });

  it('ignores a blank command', () => {
    policyConfig = { command: '   ' };
    expect(getPolicyCommand()).toBeUndefined();
    expect(isPolicyEnabled()).toBe(false);
  });

  it('is enabled when a command is configured', () => {
    policyConfig = { command: '/usr/local/bin/policy' };
    expect(getPolicyCommand()).toBe('/usr/local/bin/policy');
    expect(isPolicyEnabled()).toBe(true);
  });

  it('honours an explicit command override', () => {
    expect(isPolicyEnabled({ command: 'x' })).toBe(true);
  });
});

describe('evaluatePolicy', () => {
  it('allows immediately when no policy is configured', async () => {
    const result = await evaluatePolicy(toolCall);
    expect(result.decision).toBe('allow');
    expect(result.source).toBe('none');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('allows on exit code 0 and feeds the tool-call JSON on stdin', async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const p = evaluatePolicy(toolCall, { command: 'allow.sh' });
    proc.emit('close', 0);
    const result = await p;

    expect(result.decision).toBe('allow');
    expect(result.source).toBe('policy');
    const written = proc.stdin.write.mock.calls[0][0] as string;
    expect(JSON.parse(written)).toEqual({ id: 't1', name: 'shell', arguments: { command: 'rm -rf /' } });
    expect(proc.stdin.end).toHaveBeenCalled();
  });

  it('denies on non-zero exit with stderr as the reason', async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const p = evaluatePolicy(toolCall, { command: 'deny.sh' });
    proc.stderr.emit('data', Buffer.from('destructive command blocked'));
    proc.emit('close', 3);
    const result = await p;

    expect(result.decision).toBe('deny');
    expect(result.reason).toBe('destructive command blocked');
  });

  it('denies with a synthesized reason when stderr is empty', async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const p = evaluatePolicy(toolCall, { command: 'deny.sh' });
    proc.emit('close', 1);
    const result = await p;

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('exit 1');
  });

  it('fails closed (deny) on timeout', async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
    // Make the group-signal throw so the code falls back to proc.kill(), which
    // emits 'close' — simulating the process dying from the timeout signal.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no such process group');
    });

    const p = evaluatePolicy(toolCall, { command: 'hang.sh', timeoutMs: 20 });
    const result = await p;

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('timed out');
    expect(proc.kill).toHaveBeenCalled();
  });

  it('fails closed (deny) when the process errors', async () => {
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const p = evaluatePolicy(toolCall, { command: 'missing.sh' });
    proc.emit('error', new Error('spawn ENOENT'));
    const result = await p;

    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('ENOENT');
  });

  it('fails closed (deny) when spawn throws synchronously', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('cannot spawn');
    });
    const result = await evaluatePolicy(toolCall, { command: 'x' });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('cannot spawn');
  });

  it('uses the configured command when no override is given', async () => {
    policyConfig = { command: 'configured.sh' };
    const proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);

    const p = evaluatePolicy(toolCall);
    proc.emit('close', 0);
    await p;

    expect(spawnMock).toHaveBeenCalledWith('sh', ['-c', 'configured.sh'], expect.anything());
  });
});
