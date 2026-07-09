/**
 * Tests for src/cost.ts — spend + tool-usage reporting over the audit run logs.
 *
 * Covers: cross-session aggregation math (multi-run sums, multi-model +N),
 * cost-desc sorting + grand total, top-tools ranking, the session drill-down
 * (run segmentation + tool_call/tool_result pairing by id + error flags), the
 * --json shapes for both surfaces, broken-chain rows flagged (never dropped),
 * missing/empty dir (clean message, exit 0), and an unknown session id (clear
 * error, nonzero). A final integration check runs against the vendored REAL
 * sample logs and pins the total cost.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const { tmpHome } = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'calliope-cost-test-'));
  return { tmpHome: dir };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

import { RunLog, readRunLog, runLogPath, resetRunLogs } from '../src/runlog.js';
import {
  runCost,
  summarizeDir,
  summarizeFile,
  detailForSession,
  topTools,
  renderReport,
} from '../src/cost.js';

// The vendored real logs (byte-identical copies of ~/Desktop/calliope-cost/samples).
const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cost-samples');

let counter = 0;
function freshDir(): string {
  return fs.mkdtempSync(path.join(tmpHome, `runs-${counter++}-`));
}

/** Write a session trace via the real RunLog writer (valid hash chain). */
async function writeSession(
  dir: string,
  session: string,
  build: (log: RunLog) => void,
): Promise<string> {
  const log = RunLog.open(session, { dir });
  build(log);
  await log.flush();
  return runLogPath(session, dir);
}

function capture(): {
  out: string[];
  err: string[];
  stdout: (s: string) => void;
  stderr: (s: string) => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
}

beforeEach(() => resetRunLogs());
afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe('summarizeFile / summarizeDir', () => {
  it('sums tokens + cost + runs across multiple runs in one session', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_multi', (log) => {
      log.runStart({ session: 'sess_multi', cwd: '/p', provider: 'anthropic', model: 'claude-a', config: {} });
      log.toolCall({ id: 't1', name: 'shell', args: {} });
      log.toolResult({ id: 't1', result: 'ok', isError: false, durationMs: 10 });
      log.runEnd({ totals: { inputTokens: 100, outputTokens: 20, cost: 0.01, toolCalls: 1, durationMs: 50 }, exitReason: 'completed' });
      log.runStart({ session: 'sess_multi', cwd: '/p', provider: 'anthropic', model: 'claude-b', config: {} });
      log.toolCall({ id: 't2', name: 'shell', args: {} });
      log.toolResult({ id: 't2', result: 'ok', isError: false, durationMs: 5 });
      log.toolCall({ id: 't3', name: 'read', args: {} });
      log.toolResult({ id: 't3', result: 'ok', isError: false, durationMs: 7 });
      log.runEnd({ totals: { inputTokens: 200, outputTokens: 30, cost: 0.02, toolCalls: 2, durationMs: 80 }, exitReason: 'completed' });
    });

    const [s] = summarizeDir(dir);
    expect(s!.runs).toBe(2);
    expect(s!.tokensIn).toBe(300);
    expect(s!.tokensOut).toBe(50);
    expect(s!.cost).toBeCloseTo(0.03, 10);
    // Multi-model: distinct {claude-a, claude-b}; show the last + '+N'.
    expect(s!.model).toBe('claude-b');
    expect(s!.extraModels).toBe(1);
    // Top tools by count: shell(2) > read(1).
    expect(s!.topTools).toEqual([{ name: 'shell', count: 2 }, { name: 'read', count: 1 }]);
    expect(s!.chainOk).toBe(true);
    expect(s!.date).toBe(readRunLog(s!.file)[0]!.ts); // first run_start ts
  });

  it('sorts sessions by cost (desc) with a correct grand total', async () => {
    const dir = freshDir();
    const mk = (id: string, cost: number, tin: number, tout: number) =>
      writeSession(dir, id, (log) => {
        log.runStart({ session: id, cwd: '/p', provider: 'openai', model: 'gpt', config: {} });
        log.runEnd({ totals: { inputTokens: tin, outputTokens: tout, cost, toolCalls: 0, durationMs: 1 }, exitReason: 'completed' });
      });
    await mk('sess_cheap', 0.005, 10, 1);
    await mk('sess_pricey', 0.02, 40, 4);
    await mk('sess_mid', 0.01, 20, 2);

    const summaries = summarizeDir(dir);
    expect(summaries.map((s) => s.session)).toEqual(['sess_pricey', 'sess_mid', 'sess_cheap']);

    const cap = capture();
    const code = await runCost(['--dir', dir], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toContain('GRAND TOTAL');
    // Grand total tokens = 70/7, cost = 0.035.
    expect(text).toContain('70/7');
    expect(text).toContain('$0.035000');
    // Ordering: pricey appears before cheap in the rendered body.
    expect(text.indexOf('sess_pricey')).toBeLessThan(text.indexOf('sess_cheap'));
  });

  it('ranks the top 3 tools, ties broken by name', () => {
    const counts = new Map<string, number>([
      ['bravo', 3],
      ['alpha', 3],
      ['charlie', 2],
      ['delta', 1],
      ['echo', 1],
    ]);
    // alpha/bravo tie at 3 -> name asc (alpha first); charlie(2) rounds out top 3.
    expect(topTools(counts, 3)).toEqual([
      { name: 'alpha', count: 3 },
      { name: 'bravo', count: 3 },
      { name: 'charlie', count: 2 },
    ]);
  });

  it('renders "+N" for extra models and "—" when a session used no tools', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_models', (log) => {
      log.runStart({ session: 'sess_models', cwd: '/p', provider: 'openai', model: 'gpt-a', config: {} });
      log.runEnd({ totals: { inputTokens: 1, outputTokens: 1, cost: 0.001, toolCalls: 0, durationMs: 1 }, exitReason: 'completed' });
      log.runStart({ session: 'sess_models', cwd: '/p', provider: 'openai', model: 'gpt-b', config: {} });
      log.runEnd({ totals: { inputTokens: 1, outputTokens: 1, cost: 0.001, toolCalls: 0, durationMs: 1 }, exitReason: 'completed' });
    });
    const text = renderReport(summarizeDir(dir), dir);
    expect(text).toContain('openai/gpt-b +1');
    expect(text).toContain('—'); // empty top-tools cell
  });
});

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

describe('detailForSession', () => {
  it('segments runs and pairs tool durations + error flags by id', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_detail', (log) => {
      log.runStart({ session: 'sess_detail', cwd: '/p', provider: 'anthropic', model: 'claude', config: {} });
      log.toolCall({ id: 'a', name: 'shell', args: {} });
      log.toolResult({ id: 'a', result: 'ok', isError: false, durationMs: 12 });
      log.toolCall({ id: 'b', name: 'read', args: {} });
      log.toolResult({ id: 'b', result: 'boom', isError: true, durationMs: 34 });
      log.runEnd({ totals: { inputTokens: 50, outputTokens: 8, cost: 0.004, toolCalls: 2, durationMs: 99 }, exitReason: 'completed' });
    });

    const detail = detailForSession(dir, 'sess_detail')!;
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]!.toolCount).toBe(2);
    expect(detail.runs[0]!.cost).toBeCloseTo(0.004, 10);
    expect(detail.runs[0]!.exitReason).toBe('completed');

    expect(detail.timeline).toHaveLength(2);
    expect(detail.timeline[0]).toMatchObject({ tool: 'shell', durationMs: 12, isError: false });
    expect(detail.timeline[1]).toMatchObject({ tool: 'read', durationMs: 34, isError: true });

    expect(detail.totals).toMatchObject({ runs: 1, tokensIn: 50, tokensOut: 8 });
    expect(detail.totals.cost).toBeCloseTo(0.004, 10);
  });

  it('leaves durationMs null for a tool_call with no matching result', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_unpaired', (log) => {
      log.runStart({ session: 'sess_unpaired', cwd: '/p', provider: 'anthropic', model: 'claude', config: {} });
      log.toolCall({ id: 'x', name: 'shell', args: {} });
      // no tool_result for x
      log.runEnd({ totals: { inputTokens: 1, outputTokens: 1, cost: 0.001, toolCalls: 1, durationMs: 5 }, exitReason: 'completed' });
    });
    const detail = detailForSession(dir, 'sess_unpaired')!;
    expect(detail.timeline[0]).toMatchObject({ tool: 'shell', durationMs: null, isError: false });
  });

  it('renders a human drill-down with the timeline and error marker', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_render', (log) => {
      log.runStart({ session: 'sess_render', cwd: '/p', provider: 'anthropic', model: 'claude', config: {} });
      log.toolCall({ id: 'e', name: 'writeFile', args: {} });
      log.toolResult({ id: 'e', result: 'denied', isError: true, durationMs: 3 });
      log.runEnd({ totals: { inputTokens: 5, outputTokens: 2, cost: 0.002, toolCalls: 1, durationMs: 9 }, exitReason: 'completed' });
    });
    const cap = capture();
    const code = await runCost(['sess_render', '--dir', dir], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toContain('Session sess_render');
    expect(text).toContain('Tool timeline:');
    expect(text).toContain('writeFile');
    expect(text).toContain('✗ error');
    expect(text).toContain('Hash chain: OK');
  });

  it('reports "(no tool calls)" for a session with no tools', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_notools', (log) => {
      log.runStart({ session: 'sess_notools', cwd: '/p', provider: 'openai', model: 'gpt', config: {} });
      log.runEnd({ totals: { inputTokens: 1, outputTokens: 1, cost: 0.001, toolCalls: 0, durationMs: 1 }, exitReason: 'completed' });
    });
    const cap = capture();
    await runCost(['sess_notools', '--dir', dir], { stdout: cap.stdout, stderr: cap.stderr });
    expect(cap.out.join('')).toContain('Tool timeline: (no tool calls)');
  });
});

// ---------------------------------------------------------------------------
// --json shapes
// ---------------------------------------------------------------------------

describe('--json output', () => {
  it('emits a machine report with sessions + grandTotal', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_json', (log) => {
      log.runStart({ session: 'sess_json', cwd: '/p', provider: 'openai', model: 'gpt', config: {} });
      log.toolCall({ id: 't', name: 'shell', args: {} });
      log.toolResult({ id: 't', result: 'ok', isError: false, durationMs: 4 });
      log.runEnd({ totals: { inputTokens: 12, outputTokens: 3, cost: 0.006, toolCalls: 1, durationMs: 7 }, exitReason: 'completed' });
    });
    const cap = capture();
    const code = await runCost(['--dir', dir, '--json'], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.dir).toBe(dir);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0]).toMatchObject({
      session: 'sess_json',
      provider: 'openai',
      model: 'gpt',
      runs: 1,
      tokensIn: 12,
      tokensOut: 3,
      chainOk: true,
      topTools: [{ name: 'shell', count: 1 }],
    });
    expect(parsed.sessions[0].cost).toBeCloseTo(0.006, 10);
    expect(parsed.grandTotal).toMatchObject({ sessions: 1, runs: 1, tokensIn: 12, tokensOut: 3 });
  });

  it('emits a machine drill-down with runs + timeline + totals', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_json2', (log) => {
      log.runStart({ session: 'sess_json2', cwd: '/p', provider: 'anthropic', model: 'claude', config: {} });
      log.toolCall({ id: 'q', name: 'grep', args: {} });
      log.toolResult({ id: 'q', result: 'ok', isError: false, durationMs: 15 });
      log.runEnd({ totals: { inputTokens: 9, outputTokens: 2, cost: 0.003, toolCalls: 1, durationMs: 20 }, exitReason: 'completed' });
    });
    const cap = capture();
    const code = await runCost(['sess_json2', '--dir', dir, '--json'], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.session).toBe('sess_json2');
    expect(parsed.chainOk).toBe(true);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.timeline).toEqual([{ ts: expect.any(String), tool: 'grep', durationMs: 15, isError: false }]);
    expect(parsed.totals).toMatchObject({ runs: 1, tokensIn: 9, tokensOut: 2 });
  });
});

// ---------------------------------------------------------------------------
// Broken chain — flagged, never dropped
// ---------------------------------------------------------------------------

describe('broken chain', () => {
  async function writeTampered(dir: string, session: string): Promise<string> {
    const file = await writeSession(dir, session, (log) => {
      log.runStart({ session, cwd: '/p', provider: 'openai', model: 'gpt', config: {} });
      log.userPrompt('hello');
      log.runEnd({ totals: { inputTokens: 5, outputTokens: 1, cost: 0.009, toolCalls: 0, durationMs: 3 }, exitReason: 'completed' });
    });
    // Tamper a payload without recomputing its hash — breaks the chain at line 2.
    const lines = readRunLog(file);
    (lines[1] as unknown as { text: string }).text = 'tampered';
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  it('flags a tampered session in summarizeFile (not dropped)', async () => {
    const dir = freshDir();
    const file = await writeTampered(dir, 'sess_broken');
    const s = summarizeFile(file);
    expect(s.chainOk).toBe(false);
    expect(s.brokenAtLine).toBe(2);
    // Still aggregated (cost recorded), not silently excluded.
    expect(s.cost).toBeCloseTo(0.009, 10);
  });

  it('marks the row CHAIN BROKEN in the report and chainOk:false in --json', async () => {
    const dir = freshDir();
    await writeTampered(dir, 'sess_broken2');

    const human = capture();
    await runCost(['--dir', dir], { stdout: human.stdout, stderr: human.stderr });
    const text = human.out.join('');
    expect(text).toContain('sess_broken2');
    expect(text).toContain('CHAIN BROKEN');
    expect(text).toContain('STATUS'); // status column appears only when broken

    const json = capture();
    await runCost(['--dir', dir, '--json'], { stdout: json.stdout, stderr: json.stderr });
    const parsed = JSON.parse(json.out.join(''));
    expect(parsed.sessions[0].chainOk).toBe(false);
    expect(parsed.sessions[0].brokenAtLine).toBe(2);
  });

  it('flags a broken chain in the drill-down too', async () => {
    const dir = freshDir();
    await writeTampered(dir, 'sess_broken3');
    const cap = capture();
    await runCost(['sess_broken3', '--dir', dir], { stdout: cap.stdout, stderr: cap.stderr });
    expect(cap.out.join('')).toContain('Hash chain: BROKEN at line 2');
  });
});

// ---------------------------------------------------------------------------
// Empty / missing dir + unknown session + flag handling
// ---------------------------------------------------------------------------

describe('runCost edge cases', () => {
  it('prints a clean message and exits 0 for a missing dir', async () => {
    const cap = capture();
    const code = await runCost(['--dir', path.join(tmpHome, 'no-such-dir')], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('No run logs found in');
  });

  it('exits 0 with an empty JSON report for a missing dir in --json', async () => {
    const cap = capture();
    const code = await runCost(['--dir', path.join(tmpHome, 'no-such-dir'), '--json'], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.sessions).toEqual([]);
    expect(parsed.grandTotal).toMatchObject({ sessions: 0, cost: 0 });
  });

  it('prints a clean message and exits 0 for an existing-but-empty dir', async () => {
    const dir = freshDir(); // exists, no .jsonl files
    const cap = capture();
    const code = await runCost(['--dir', dir], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('No run logs found in');
  });

  it('exits 1 with a clear error for an unknown session id', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_known', (log) => {
      log.runStart({ session: 'sess_known', cwd: '/p', provider: 'openai', model: 'gpt', config: {} });
      log.runEnd({ totals: { inputTokens: 1, outputTokens: 1, cost: 0.001, toolCalls: 0, durationMs: 1 }, exitReason: 'completed' });
    });
    const cap = capture();
    const code = await runCost(['sess_missing', '--dir', dir], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('session not found: sess_missing');
  });

  it('exits 1 when --dir has no value', async () => {
    const cap = capture();
    const code = await runCost(['--dir'], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('--dir requires a path');
  });

  it('exits 1 for an unknown option', async () => {
    const cap = capture();
    const code = await runCost(['--bogus'], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('unknown option');
  });

  it('prints usage for --help and exits 0', async () => {
    const cap = capture();
    const code = await runCost(['--help'], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('Usage: calliope cost');
  });
});

// ---------------------------------------------------------------------------
// Robustness — unreadable files + id resolution by scan
// ---------------------------------------------------------------------------

describe('runCost robustness', () => {
  it('lists an unreadable file as CHAIN BROKEN instead of crashing the report', async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'corrupt.jsonl'), 'not valid json at all\n');
    const cap = capture();
    const code = await runCost(['--dir', dir], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toContain('corrupt');
    expect(text).toContain('CHAIN BROKEN');
  });

  it('drills into an unreadable file without crashing', async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'corrupt2.jsonl'), 'garbage\n');
    const cap = capture();
    const code = await runCost(['corrupt2', '--dir', dir, '--json'], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.chainOk).toBe(false);
    expect(parsed.runs).toEqual([]);
  });

  it('shows a dangling run_start (session still in flight) with exitReason —', async () => {
    const dir = freshDir();
    await writeSession(dir, 'sess_inflight', (log) => {
      log.runStart({ session: 'sess_inflight', cwd: '/p', provider: 'openai', model: 'gpt', config: {} });
      log.runEnd({ totals: { inputTokens: 5, outputTokens: 1, cost: 0.003, toolCalls: 0, durationMs: 4 }, exitReason: 'completed' });
      log.runStart({ session: 'sess_inflight', cwd: '/p', provider: 'openai', model: 'gpt', config: {} });
      // no run_end — the second run is still in flight
    });
    const detail = detailForSession(dir, 'sess_inflight')!;
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[1]).toMatchObject({ exitReason: '—', cost: 0, tokensIn: 0, tokensOut: 0 });
  });

  it('resolves a session by scanning when the filename differs from the id', async () => {
    const dir = freshDir();
    const file = await writeSession(dir, 'inner_id', (log) => {
      log.runStart({ session: 'inner_id', cwd: '/p', provider: 'openai', model: 'gpt', config: {} });
      log.runEnd({ totals: { inputTokens: 3, outputTokens: 1, cost: 0.002, toolCalls: 0, durationMs: 2 }, exitReason: 'completed' });
    });
    // Rename so the direct runLogPath('inner_id') lookup misses and the scan runs.
    fs.renameSync(file, path.join(dir, 'renamed_trace.jsonl'));
    const detail = detailForSession(dir, 'inner_id');
    expect(detail).not.toBeNull();
    expect(detail!.session).toBe('inner_id');
    expect(detail!.totals.cost).toBeCloseTo(0.002, 10);
  });
});

// ---------------------------------------------------------------------------
// Integration — the vendored REAL sample logs (read-only)
// ---------------------------------------------------------------------------

describe('real samples integration', () => {
  it('totals cost across the three real samples to 0.050429', async () => {
    const cap = capture();
    const code = await runCost(['--dir', SAMPLES_DIR, '--json'], { stdout: cap.stdout, stderr: cap.stderr });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));

    expect(parsed.sessions).toHaveLength(3);
    // Computed from run_end totals — pins compatibility with real on-disk logs.
    expect(parsed.grandTotal.cost).toBeCloseTo(0.050429, 6);
    expect(Math.abs(parsed.grandTotal.cost - 0.050429)).toBeLessThan(1e-6);
    // Real samples are chain-intact and sorted most-expensive first.
    expect(parsed.sessions.every((s: { chainOk: boolean }) => s.chainOk)).toBe(true);
    expect(parsed.sessions[0].session).toBe('session_1783462600102_zdilt3');
  });

  it('drills into a real multi-run session with paired tool durations', async () => {
    const cap = capture();
    const code = await runCost(['session_1783462600102_zdilt3', '--dir', SAMPLES_DIR, '--json'], {
      stdout: cap.stdout,
      stderr: cap.stderr,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.runs).toHaveLength(4);
    expect(parsed.timeline).toHaveLength(7);
    expect(parsed.timeline.some((t: { durationMs: number | null }) => t.durationMs !== null)).toBe(true);
    expect(parsed.totals.cost).toBeCloseTo(0.025172, 6);
  });
});
