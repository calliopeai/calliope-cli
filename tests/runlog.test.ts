/**
 * Tests for src/runlog.ts — the append-only audit run log.
 *
 * Covers: redaction, canonicalization, event emission, the tamper-evidence hash
 * chain (write + verify + break detection), chain resumption across opens,
 * reading, rotation, and the on/off switch.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// A temp home so the conf store and default runs dir live under tmp, not the
// real user home. Created before modules load (vi.hoisted).
const { tmpHome } = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'calliope-runlog-test-'));
  return { tmpHome: dir };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

import {
  RunLog,
  redactSecrets,
  canonicalize,
  verifyChain,
  readRunLog,
  rotateRuns,
  runLogPath,
  resolveAuditSettings,
  resetRunLogs,
  RUNLOG_SCHEMA_VERSION,
  type RunLogLine,
} from '../src/runlog.js';

const RUNS_DIR = path.join(tmpHome, '.calliope-cli', 'runs');

let counter = 0;
function freshSession(): string {
  return `session_test_${Date.now()}_${counter++}`;
}

beforeEach(() => {
  resetRunLogs();
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('redactSecrets', () => {
  it('strips values under secret-named keys', () => {
    const out = redactSecrets({ apiKey: 'sk-ant-abc', token: 'xyz', keep: 'ok' }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.keep).toBe('ok');
  });

  it('masks secret-looking string values in place', () => {
    const out = redactSecrets({ note: 'use sk-ant-ABCDEFGHIJKLMNOP123 here' }) as Record<string, unknown>;
    expect(out.note).toContain('[REDACTED]');
    expect(out.note).not.toContain('ABCDEFGHIJKLMNOP');
  });

  it('recurses through nested objects and arrays', () => {
    const out = redactSecrets({
      providers: { anthropic: { apiKey: 'sk-secret', baseUrl: 'https://x' } },
      list: [{ password: 'p' }, 'plain'],
    }) as Record<string, unknown>;
    const providers = out.providers as Record<string, Record<string, unknown>>;
    expect(providers.anthropic.apiKey).toBe('[REDACTED]');
    expect(providers.anthropic.baseUrl).toBe('https://x');
    const list = out.list as Array<Record<string, unknown> | string>;
    expect((list[0] as Record<string, unknown>).password).toBe('[REDACTED]');
    expect(list[1]).toBe('plain');
  });

  it('leaves non-secret primitives untouched', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

describe('canonicalize', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles nested structures deterministically', () => {
    const a = canonicalize({ x: { c: 1, a: [1, { z: 0, y: 9 }] } });
    const b = canonicalize({ x: { a: [1, { y: 9, z: 0 }], c: 1 } });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Writing + hash chain
// ---------------------------------------------------------------------------

describe('RunLog writing', () => {
  it('writes a valid, versioned, chained trace', async () => {
    const session = freshSession();
    const log = RunLog.open(session);
    log.runStart({ session, cwd: '/tmp/proj', provider: 'anthropic', model: 'claude', config: {} });
    log.userPrompt('do the thing');
    log.assistantMessage({ content: 'ok', tokens: { input: 10, output: 5 }, cost: 0.001 });
    log.toolCall({ id: 't1', name: 'shell', args: { command: 'ls' } });
    log.toolResult({ id: 't1', result: 'a\nb', isError: false, durationMs: 12 });
    log.runEnd({ totals: { inputTokens: 10, outputTokens: 5, cost: 0.001, toolCalls: 1, durationMs: 30 }, exitReason: 'completed' });
    await log.flush();

    const lines = readRunLog(runLogPath(session, RUNS_DIR));
    expect(lines).toHaveLength(6);
    expect(lines[0].type).toBe('run_start');
    expect(lines[0].v).toBe(RUNLOG_SCHEMA_VERSION);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(lines[0].prev_hash).toBe('');
    expect(lines[1].prev_hash).toBe(lines[0].hash);
    expect(verifyChain(lines).ok).toBe(true);
  });

  it('redacts credentials in the run_start config snapshot', async () => {
    const session = freshSession();
    const log = RunLog.open(session);
    log.runStart({
      session,
      cwd: '/tmp',
      provider: 'anthropic',
      model: 'claude',
      config: { providers: { anthropic: { apiKey: 'sk-ant-SUPERSECRET-KEY-1234567' } } },
    });
    await log.flush();

    const raw = fs.readFileSync(runLogPath(session, RUNS_DIR), 'utf-8');
    expect(raw).not.toContain('SUPERSECRET');
    expect(raw).toContain('[REDACTED]');
  });

  it('redacts secrets in tool_call args', async () => {
    const session = freshSession();
    const log = RunLog.open(session);
    log.toolCall({ id: 't1', name: 'http', args: { token: 'abc123', url: 'https://x' } });
    await log.flush();
    const lines = readRunLog(runLogPath(session, RUNS_DIR));
    expect((lines[0] as unknown as { args: Record<string, unknown> }).args.token).toBe('[REDACTED]');
    expect((lines[0] as unknown as { args: Record<string, unknown> }).args.url).toBe('https://x');
  });

  it('truncates long tool results', async () => {
    const session = freshSession();
    const log = RunLog.open(session);
    log.toolResult({ id: 't1', result: 'x'.repeat(5000), isError: false, durationMs: 1 }, 100);
    await log.flush();
    const lines = readRunLog(runLogPath(session, RUNS_DIR));
    const result = (lines[0] as unknown as { result: string }).result;
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('truncated');
  });

  it('does not write anything when disabled', async () => {
    const session = freshSession();
    const log = RunLog.open(session, { enabled: false });
    expect(log.enabled).toBe(false);
    log.runStart({ session, cwd: '/tmp', provider: 'p', model: 'm', config: {} });
    log.userPrompt('hi');
    await log.flush();
    expect(fs.existsSync(runLogPath(session, RUNS_DIR))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verification / tamper detection
// ---------------------------------------------------------------------------

describe('verifyChain', () => {
  async function writeTrace(): Promise<{ file: string }> {
    const session = freshSession();
    const log = RunLog.open(session);
    log.runStart({ session, cwd: '/tmp', provider: 'p', model: 'm', config: {} });
    log.userPrompt('one');
    log.assistantMessage({ content: 'two', tokens: { input: 1, output: 1 }, cost: 0 });
    await log.flush();
    return { file: runLogPath(session, RUNS_DIR) };
  }

  it('accepts an untouched trace', async () => {
    const { file } = await writeTrace();
    expect(verifyChain(readRunLog(file)).ok).toBe(true);
  });

  it('detects a mutated payload', async () => {
    const { file } = await writeTrace();
    const lines = readRunLog(file);
    (lines[1] as unknown as { text: string }).text = 'tampered';
    const result = verifyChain(lines);
    expect(result.ok).toBe(false);
    expect(result.brokenAtLine).toBe(2);
    expect(result.reason).toBe('hash mismatch');
  });

  it('detects a deleted line via prev_hash mismatch', async () => {
    const { file } = await writeTrace();
    const lines = readRunLog(file);
    lines.splice(1, 1); // drop the user_prompt
    const result = verifyChain(lines);
    expect(result.ok).toBe(false);
    expect(result.brokenAtLine).toBe(2);
    expect(result.reason).toBe('prev_hash mismatch');
  });

  it('reports ok for an empty trace', () => {
    expect(verifyChain([]).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chain resumption across opens
// ---------------------------------------------------------------------------

describe('RunLog chain resumption', () => {
  it('continues the hash chain when re-opened from disk', async () => {
    const session = freshSession();
    const first = RunLog.open(session);
    first.runStart({ session, cwd: '/tmp', provider: 'p', model: 'm', config: {} });
    first.userPrompt('turn one');
    await first.flush();

    // Drop the cached instance so the next open re-reads from disk.
    resetRunLogs();

    const second = RunLog.open(session);
    second.userPrompt('turn two');
    second.runEnd({ totals: { inputTokens: 0, outputTokens: 0, cost: 0, toolCalls: 0, durationMs: 1 }, exitReason: 'completed' });
    await second.flush();

    const lines = readRunLog(runLogPath(session, RUNS_DIR));
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2, 3]);
    expect(verifyChain(lines).ok).toBe(true);
  });

  it('returns the same instance for repeated opens (shared chain)', () => {
    const session = freshSession();
    const a = RunLog.open(session);
    const b = RunLog.open(session);
    expect(a).toBe(b);
  });

  it('close() flushes and drops the instance from the cache', async () => {
    const session = freshSession();
    const a = RunLog.open(session);
    a.userPrompt('hi');
    await a.close();
    // File was flushed.
    expect(fs.existsSync(runLogPath(session, RUNS_DIR))).toBe(true);
    // A fresh open after close is a new instance that resumes from disk.
    const b = RunLog.open(session);
    expect(b).not.toBe(a);
    b.runEnd({ totals: { inputTokens: 0, outputTokens: 0, cost: 0, toolCalls: 0, durationMs: 1 }, exitReason: 'completed' });
    await b.flush();
    const lines = readRunLog(runLogPath(session, RUNS_DIR));
    expect(lines.map((l) => l.seq)).toEqual([0, 1]);
    expect(verifyChain(lines).ok).toBe(true);
  });

  it('resumes past a corrupt tail line via best-effort scan', async () => {
    const session = freshSession();
    const first = RunLog.open(session);
    first.runStart({ session, cwd: '/tmp', provider: 'p', model: 'm', config: {} });
    first.userPrompt('one');
    await first.flush();

    // Simulate a torn/garbage final line, then re-open.
    fs.appendFileSync(runLogPath(session, RUNS_DIR), 'THIS IS NOT JSON\n');
    resetRunLogs();

    const second = RunLog.open(session);
    second.runEnd({ totals: { inputTokens: 0, outputTokens: 0, cost: 0, toolCalls: 0, durationMs: 1 }, exitReason: 'completed' });
    await second.flush();

    // The parseable lines (skipping the garbage) form an intact chain, and the
    // new event resumed from seq 2 (after the two valid lines).
    const raw = fs.readFileSync(runLogPath(session, RUNS_DIR), 'utf-8').split('\n');
    const valid: RunLogLine[] = [];
    for (const line of raw) {
      const t = line.trim();
      if (!t) continue;
      try { valid.push(JSON.parse(t) as RunLogLine); } catch { /* skip garbage */ }
    }
    expect(valid.map((l) => l.seq)).toEqual([0, 1, 2]);
    expect(verifyChain(valid).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('rotateRuns', () => {
  function makeFile(dir: string, name: string, mtimeSec: number): void {
    const full = path.join(dir, name);
    fs.writeFileSync(full, '{}\n');
    fs.utimesSync(full, mtimeSec, mtimeSec);
  }

  it('keeps only the newest N files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-rotate-'));
    makeFile(dir, 'a.jsonl', 1000);
    makeFile(dir, 'b.jsonl', 2000);
    makeFile(dir, 'c.jsonl', 3000);
    makeFile(dir, 'd.jsonl', 4000);
    makeFile(dir, 'e.jsonl', 5000);

    rotateRuns(dir, 3);

    const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    expect(remaining).toEqual(['c.jsonl', 'd.jsonl', 'e.jsonl']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when under the limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-rotate-'));
    makeFile(dir, 'a.jsonl', 1000);
    rotateRuns(dir, 100);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prunes old sessions when a new one is opened', async () => {
    // Seed 4 old traces with increasing mtimes in the default runs dir.
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    for (let i = 0; i < 4; i++) {
      const f = path.join(RUNS_DIR, `old_${i}.jsonl`);
      fs.writeFileSync(f, '{}\n');
      fs.utimesSync(f, 1000 + i, 1000 + i);
    }
    const session = freshSession();
    RunLog.open(session, { retention: 2 }); // triggers rotateRuns before the new file
    const files = fs.readdirSync(RUNS_DIR).filter((f) => f.startsWith('old_'));
    expect(files.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Reading + settings
// ---------------------------------------------------------------------------

describe('readRunLog', () => {
  it('throws on an unparseable line', async () => {
    const session = freshSession();
    const file = runLogPath(session, RUNS_DIR);
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(file, '{"v":1}\nnot json\n');
    expect(() => readRunLog(file)).toThrow(/unparseable/);
  });

  it('skips blank lines', () => {
    const session = freshSession();
    const file = runLogPath(session, RUNS_DIR);
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    fs.writeFileSync(file, '{"v":1,"seq":0}\n\n\n');
    expect(readRunLog(file)).toHaveLength(1);
  });
});

describe('resolveAuditSettings', () => {
  it('is enabled by default with the tmp-home runs dir', () => {
    const s = resolveAuditSettings();
    expect(s.enabled).toBe(true);
    expect(s.dir).toBe(RUNS_DIR);
    expect(s.retention).toBe(100);
  });

  it('honours explicit overrides', () => {
    const s = resolveAuditSettings({ enabled: false, dir: '/custom', retention: 5 });
    expect(s).toEqual({ enabled: false, dir: '/custom', retention: 5 });
  });

  it('sanitizes path separators out of a session id (no traversal)', () => {
    const p = runLogPath('../../etc/passwd', '/runs');
    // Slashes (the traversal vector) are neutralized; the result stays in /runs.
    expect(p).toBe(path.join('/runs', '.._.._etc_passwd.jsonl'));
    expect(path.dirname(p)).toBe('/runs');
  });
});
