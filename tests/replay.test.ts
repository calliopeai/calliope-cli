/**
 * Tests for src/replay.ts — read-only run-log rendering.
 *
 * Covers: target resolution (path + session id), human + JSON rendering, cost
 * accumulation, tool call/result pairing, broken-chain detection, and the exit
 * codes (0 ok, 4 broken, 1 not found).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome } = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'calliope-replay-test-'));
  return { tmpHome: dir };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

import { RunLog, readRunLog, verifyChain, runLogPath, resetRunLogs } from '../src/runlog.js';
import { runReplay, renderReplay, renderReplayJson, resolveReplayTarget } from '../src/replay.js';

const RUNS_DIR = path.join(tmpHome, '.calliope-cli', 'runs');

let counter = 0;
function freshSession(): string {
  return `session_replay_${Date.now()}_${counter++}`;
}

/** Write a small, complete trace and return its session id + file path. */
async function writeTrace(): Promise<{ session: string; file: string }> {
  const session = freshSession();
  const log = RunLog.open(session);
  log.runStart({ session, cwd: '/tmp/proj', provider: 'anthropic', model: 'claude', config: {} });
  log.userPrompt('list the files');
  log.assistantMessage({ content: 'calling shell', tokens: { input: 20, output: 8 }, cost: 0.002 });
  log.toolCall({ id: 'tc1', name: 'shell', args: { command: 'ls -la' } });
  log.toolResult({ id: 'tc1', result: 'total 0\nfile.txt', isError: false, durationMs: 9 });
  log.assistantMessage({ content: 'done', tokens: { input: 30, output: 4 }, cost: 0.003 });
  log.runEnd({ totals: { inputTokens: 50, outputTokens: 12, cost: 0.005, toolCalls: 1, durationMs: 42 }, exitReason: 'completed' });
  await log.flush();
  return { session, file: runLogPath(session, RUNS_DIR) };
}

function capture(): { out: string[]; err: string[]; stdout: (s: string) => void; stderr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
}

beforeEach(() => resetRunLogs());
afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('resolveReplayTarget', () => {
  it('resolves a direct file path', async () => {
    const { file } = await writeTrace();
    expect(resolveReplayTarget(file)).toBe(file);
  });

  it('resolves a bare session id under the audit dir', async () => {
    const { session, file } = await writeTrace();
    expect(resolveReplayTarget(session)).toBe(file);
  });

  it('returns null for an unknown target', () => {
    expect(resolveReplayTarget('does-not-exist')).toBeNull();
  });
});

describe('renderReplay', () => {
  it('renders events chronologically with pairing and cost accumulation', async () => {
    const { file } = await writeTrace();
    const lines = readRunLog(file);
    const text = renderReplay(lines, verifyChain(lines));

    expect(text).toContain('run start');
    expect(text).toContain('user: list the files');
    expect(text).toContain('shell');
    expect(text).toContain('#tc1'); // tool call/result pairing id
    expect(text).toContain('run end');
    // cost accumulation = 0.002 + 0.003
    expect(text).toContain('Cumulative assistant cost: $0.0050');
    expect(text).toContain('Hash chain: OK');
  });

  it('reports a broken chain with the line number', async () => {
    const { file } = await writeTrace();
    const lines = readRunLog(file);
    (lines[1] as unknown as { text: string }).text = 'tampered';
    const text = renderReplay(lines, verifyChain(lines));
    expect(text).toContain('Hash chain: BROKEN at line 2');
  });

  it('renders budget, policy, error-result, and unknown event types', () => {
    // Synthetic lines — renderReplay is pure and does not verify hashes.
    const lines = [
      { v: 1, seq: 0, ts: '2026-07-05T10:00:00.000Z', type: 'policy_event', tool: 'shell', decision: 'deny', reason: 'blocked', prev_hash: '', hash: 'a' },
      { v: 1, seq: 1, ts: '2026-07-05T10:00:01.000Z', type: 'tool_result', id: 'x', result: 'boom', isError: true, durationMs: 3, prev_hash: 'a', hash: 'b' },
      { v: 1, seq: 2, ts: '2026-07-05T10:00:02.000Z', type: 'budget_event', scope: 'run', kind: 'cost', spent: 2, cap: 1, message: 'Run cost cap reached', prev_hash: 'b', hash: 'c' },
      { v: 1, seq: 3, ts: '2026-07-05T10:00:03.000Z', type: 'mystery', prev_hash: 'c', hash: 'd' },
    ] as unknown as Parameters<typeof renderReplay>[0];

    const text = renderReplay(lines, { ok: true });
    expect(text).toContain('policy: DENY shell');
    expect(text).toContain('blocked');
    expect(text).toContain('✗'); // errored tool result
    expect(text).toContain('budget: Run cost cap reached');
    expect(text).toContain('mystery'); // default branch
  });
});

describe('renderReplayJson', () => {
  it('emits parseable JSON with events, verification, and summary', async () => {
    const { file } = await writeTrace();
    const lines = readRunLog(file);
    const parsed = JSON.parse(renderReplayJson(lines, verifyChain(lines)));
    expect(parsed.events).toHaveLength(lines.length);
    expect(parsed.verification.ok).toBe(true);
    expect(parsed.summary.toolCalls).toBe(1);
    expect(parsed.summary.cumulativeCost).toBeCloseTo(0.005);
  });
});

describe('runReplay exit codes', () => {
  it('returns 0 and prints a trace for a valid file', async () => {
    const { file } = await writeTrace();
    const cap = capture();
    const code = runReplay(file, { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('Hash chain: OK');
  });

  it('resolves and replays by session id', async () => {
    const { session } = await writeTrace();
    const cap = capture();
    const code = runReplay(session, { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
  });

  it('returns 4 when the hash chain is broken', async () => {
    const { file } = await writeTrace();
    const lines = readRunLog(file);
    (lines[2] as unknown as { cost: number }).cost = 999; // tamper
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const cap = capture();
    const code = runReplay(file, { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(4);
    expect(cap.out.join('')).toContain('BROKEN');
  });

  it('returns 1 for a missing target', () => {
    const cap = capture();
    const code = runReplay('nope', { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('not found');
  });

  it('returns 1 when no target is given', () => {
    const cap = capture();
    const code = runReplay(undefined, { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('Usage');
  });

  it('returns 1 for an unreadable (corrupt) trace', () => {
    const file = path.join(RUNS_DIR, 'corrupt.jsonl');
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(file, 'not json at all\n');
    const cap = capture();
    const code = runReplay(file, { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(1);
  });

  it('emits JSON output with --json', async () => {
    const { file } = await writeTrace();
    const cap = capture();
    const code = runReplay(file, { json: true, stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.verification.ok).toBe(true);
  });
});
