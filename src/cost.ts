/**
 * Calliope CLI - Cost reporting (#235)
 *
 * `calliope cost` summarizes spend and tool usage across the audit run logs —
 * a read-only sibling of `calliope replay`. It reuses the run-log parsing, the
 * runs-dir path resolution, and the hash-chain verification from ./runlog.js;
 * it never re-implements parsing or the chain check.
 *
 *   calliope cost                 table across all sessions (sorted by cost)
 *   calliope cost <sessionId>     drill-down: per-run rows + tool timeline
 *   --json                        machine-readable output for both surfaces
 *   --dir <path>                  override the runs dir (default: audit.dir)
 *
 * Chain verification stays replay's job (replay exits 4 on a break). Cost only
 * *annotates* a session that fails verification — a CHAIN BROKEN marker in the
 * table and `chainOk: false` in --json — and never drops it silently. The
 * report itself always exits 0; exit 1 is reserved for a bad flag or an unknown
 * session id.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readRunLog,
  verifyChain,
  runLogPath,
  resolveAuditSettings,
  type RunLogLine,
} from './runlog.js';

/** Injectable writers (tests); default to the process streams. */
export interface CostOptions {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface ToolCount {
  name: string;
  count: number;
}

/** One row of the cross-session report. */
export interface SessionSummary {
  session: string;
  file: string;
  /** First `run_start` timestamp (session start). */
  date: string;
  /** Provider of the most recent `run_start`. */
  provider: string;
  /** Model of the most recent `run_start`. */
  model: string;
  /** Distinct models used beyond `model` (0 when a single model was used). */
  extraModels: number;
  /** Number of `run_end` events. */
  runs: number;
  /** Up to the top 3 tools by call count. */
  topTools: ToolCount[];
  tokensIn: number;
  tokensOut: number;
  cost: number;
  chainOk: boolean;
  /** 1-based line where the chain first breaks (present only when !chainOk). */
  brokenAtLine?: number;
}

export interface GrandTotal {
  sessions: number;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

/** One `run_start`…`run_end` segment in the drill-down. */
export interface RunRow {
  start: string;
  model: string;
  toolCount: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  exitReason: string;
}

/** One tool call, paired with its result (by id) for duration + error flag. */
export interface TimelineEntry {
  ts: string;
  tool: string;
  durationMs: number | null;
  isError: boolean;
}

export interface SessionDetail {
  session: string;
  file: string;
  provider: string;
  model: string;
  chainOk: boolean;
  brokenAtLine?: number;
  runs: RunRow[];
  timeline: TimelineEntry[];
  totals: { runs: number; tokensIn: number; tokensOut: number; cost: number };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** List `.jsonl` run-log files in `dir`, sorted. Returns [] when dir is absent. */
export function listSessionFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Top `n` tools by count; ties broken by name ascending (stable + deterministic). */
export function topTools(counts: Map<string, number>, n = 3): ToolCount[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

/** Aggregate a single session file into a report row (chain verified). */
export function summarizeFile(file: string): SessionSummary {
  const fallbackId = path.basename(file, '.jsonl');
  let lines: RunLogLine[];
  try {
    lines = readRunLog(file);
  } catch {
    // Unreadable trace: surface it as a broken row rather than dropping it.
    return {
      session: fallbackId,
      file,
      date: '',
      provider: 'unknown',
      model: 'unknown',
      extraModels: 0,
      runs: 0,
      topTools: [],
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      chainOk: false,
      brokenAtLine: 1,
    };
  }

  const chain = verifyChain(lines);
  let sessionId = '';
  let runStartTs = '';
  let firstTs = '';
  let provider = 'unknown';
  let model = 'unknown';
  const models = new Set<string>();
  let runs = 0;
  const toolCounts = new Map<string, number>();
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;

  for (const line of lines) {
    if (!firstTs && typeof line.ts === 'string') firstTs = line.ts;
    switch (line.type) {
      case 'run_start': {
        const p = line as unknown as { session?: string; provider?: string; model?: string };
        if (!runStartTs) runStartTs = line.ts;
        if (!sessionId && typeof p.session === 'string' && p.session) sessionId = p.session;
        provider = p.provider ?? 'unknown';
        model = p.model ?? 'unknown';
        models.add(model);
        break;
      }
      case 'run_end': {
        const t = (line as unknown as {
          totals?: { inputTokens?: number; outputTokens?: number; cost?: number };
        }).totals;
        runs += 1;
        tokensIn += Number(t?.inputTokens ?? 0);
        tokensOut += Number(t?.outputTokens ?? 0);
        cost += Number(t?.cost ?? 0);
        break;
      }
      case 'tool_call': {
        const name = String((line as unknown as { name?: string }).name ?? 'unknown');
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        break;
      }
    }
  }

  const summary: SessionSummary = {
    session: sessionId || fallbackId,
    file,
    date: runStartTs || firstTs,
    provider,
    model,
    extraModels: models.size > 0 ? models.size - 1 : 0,
    runs,
    topTools: topTools(toolCounts, 3),
    tokensIn,
    tokensOut,
    cost,
    chainOk: chain.ok,
  };
  if (!chain.ok) summary.brokenAtLine = chain.brokenAtLine;
  return summary;
}

/** Summaries for every session in `dir`, sorted by cost (desc), then id (asc). */
export function summarizeDir(dir: string): SessionSummary[] {
  return listSessionFiles(dir)
    .map(summarizeFile)
    .sort((a, b) => b.cost - a.cost || a.session.localeCompare(b.session));
}

/** Fold session rows into a grand total. */
export function grandTotal(summaries: SessionSummary[]): GrandTotal {
  return summaries.reduce(
    (acc, s) => {
      acc.runs += s.runs;
      acc.tokensIn += s.tokensIn;
      acc.tokensOut += s.tokensOut;
      acc.cost += s.cost;
      return acc;
    },
    { sessions: summaries.length, runs: 0, tokensIn: 0, tokensOut: 0, cost: 0 },
  );
}

/**
 * Resolve a session id to its file. Tries the direct filename first (reusing
 * `runLogPath`'s id sanitization), then scans for a file whose basename or
 * `run_start.session` matches — so the id shown in the report always resolves.
 */
function findSessionFile(dir: string, id: string): string | null {
  const direct = runLogPath(id, dir);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  for (const file of listSessionFiles(dir)) {
    if (path.basename(file, '.jsonl') === id) return file;
    try {
      const rs = readRunLog(file).find((l) => l.type === 'run_start') as unknown as
        | { session?: string }
        | undefined;
      if (rs && rs.session === id) return file;
    } catch {
      /* skip an unreadable file while searching */
    }
  }
  return null;
}

/** Build the per-run + timeline drill-down for one session, or null if absent. */
export function detailForSession(dir: string, id: string): SessionDetail | null {
  const file = findSessionFile(dir, id);
  if (!file) return null;

  let lines: RunLogLine[];
  try {
    lines = readRunLog(file);
  } catch {
    return {
      session: id,
      file,
      provider: 'unknown',
      model: 'unknown',
      chainOk: false,
      brokenAtLine: 1,
      runs: [],
      timeline: [],
      totals: { runs: 0, tokensIn: 0, tokensOut: 0, cost: 0 },
    };
  }

  const chain = verifyChain(lines);

  // Pair each tool_result to its tool_call by id, for durations + error flags.
  const resultById = new Map<string, { durationMs: number; isError: boolean }>();
  for (const line of lines) {
    if (line.type === 'tool_result') {
      const p = line as unknown as { id?: string; durationMs?: number; isError?: boolean };
      if (typeof p.id === 'string') {
        resultById.set(p.id, { durationMs: Number(p.durationMs ?? 0), isError: Boolean(p.isError) });
      }
    }
  }

  const timeline: TimelineEntry[] = [];
  const runs: RunRow[] = [];
  let sessionId = '';
  let provider = 'unknown';
  let model = 'unknown';
  let cur: { start: string; model: string; toolCount: number } | null = null;

  const closeDangling = (): void => {
    if (cur) {
      // A run_start with no matching run_end (e.g. a session still in flight).
      runs.push({
        start: cur.start,
        model: cur.model,
        toolCount: cur.toolCount,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        exitReason: '—',
      });
      cur = null;
    }
  };

  for (const line of lines) {
    switch (line.type) {
      case 'run_start': {
        const p = line as unknown as { session?: string; provider?: string; model?: string };
        closeDangling();
        if (!sessionId && typeof p.session === 'string' && p.session) sessionId = p.session;
        provider = p.provider ?? 'unknown';
        model = p.model ?? 'unknown';
        cur = { start: line.ts, model, toolCount: 0 };
        break;
      }
      case 'tool_call': {
        const p = line as unknown as { id?: string; name?: string };
        const name = String(p.name ?? 'unknown');
        if (cur) cur.toolCount += 1;
        const r = typeof p.id === 'string' ? resultById.get(p.id) : undefined;
        timeline.push({
          ts: line.ts,
          tool: name,
          durationMs: r ? r.durationMs : null,
          isError: r ? r.isError : false,
        });
        break;
      }
      case 'run_end': {
        const p = line as unknown as {
          totals?: { inputTokens?: number; outputTokens?: number; cost?: number; toolCalls?: number };
          exitReason?: string;
        };
        const t = p.totals;
        runs.push({
          start: cur?.start ?? line.ts,
          model: cur?.model ?? model,
          toolCount: cur ? cur.toolCount : Number(t?.toolCalls ?? 0),
          tokensIn: Number(t?.inputTokens ?? 0),
          tokensOut: Number(t?.outputTokens ?? 0),
          cost: Number(t?.cost ?? 0),
          exitReason: String(p.exitReason ?? 'unknown'),
        });
        cur = null;
        break;
      }
    }
  }
  closeDangling();

  const totals = runs.reduce(
    (acc, r) => {
      acc.tokensIn += r.tokensIn;
      acc.tokensOut += r.tokensOut;
      acc.cost += r.cost;
      return acc;
    },
    { runs: runs.length, tokensIn: 0, tokensOut: 0, cost: 0 },
  );

  const detail: SessionDetail = {
    session: sessionId || path.basename(file, '.jsonl'),
    file,
    provider,
    model,
    chainOk: chain.ok,
    runs,
    timeline,
    totals,
  };
  if (!chain.ok) detail.brokenAtLine = chain.brokenAtLine;
  return detail;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

/** `2026-07-06T02:54:09.241Z` -> `2026-07-06`. */
function shortDate(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts);
  return m ? m[1]! : ts || '—';
}

/** `2026-07-06T02:54:09.241Z` -> `2026-07-06 02:54:09`. */
function dateTime(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? `${m[1]} ${m[2]}` : ts;
}

/** `2026-07-06T02:54:09.241Z` -> `02:54:09`. */
function shortTime(ts: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : ts;
}

function providerModel(s: { provider: string; model: string; extraModels: number }): string {
  const base = `${s.provider}/${s.model}`;
  return s.extraModels > 0 ? `${base} +${s.extraModels}` : base;
}

function toolsCell(tools: ToolCount[]): string {
  return tools.length ? tools.map((t) => `${t.name}(${t.count})`).join(', ') : '—';
}

/** Left-align columns into `header · separator · rows`. */
function renderRows(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, 0, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map(fmt)];
}

export function renderReport(summaries: SessionSummary[], dir: string): string {
  const anyBroken = summaries.some((s) => !s.chainOk);
  const headers = ['SESSION', 'DATE', 'PROVIDER/MODEL', 'RUNS', 'TOP TOOLS', 'TOKENS IN/OUT', 'COST'];
  if (anyBroken) headers.push('STATUS');

  const rows = summaries.map((s) => {
    const row = [
      s.session,
      shortDate(s.date),
      providerModel(s),
      String(s.runs),
      toolsCell(s.topTools),
      `${s.tokensIn}/${s.tokensOut}`,
      usd(s.cost),
    ];
    if (anyBroken) row.push(s.chainOk ? 'ok' : 'CHAIN BROKEN');
    return row;
  });

  const gt = grandTotal(summaries);
  const totalRow = ['GRAND TOTAL', '', '', String(gt.runs), '', `${gt.tokensIn}/${gt.tokensOut}`, usd(gt.cost)];
  if (anyBroken) totalRow.push('');

  // Widths span every row (body + total) so the total aligns under the columns.
  const widths = headers.map((h, i) =>
    Math.max(h.length, 0, ...[...rows, totalRow].map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');

  const title = `Cost report — ${summaries.length} session${summaries.length === 1 ? '' : 's'} · ${dir}`;
  return [title, '', fmt(headers), sep, ...rows.map(fmt), sep, fmt(totalRow)].join('\n');
}

export function renderReportJson(summaries: SessionSummary[], dir: string): string {
  return JSON.stringify({
    dir,
    sessions: summaries.map((s) => {
      const row: Record<string, unknown> = {
        session: s.session,
        date: s.date,
        provider: s.provider,
        model: s.model,
        extraModels: s.extraModels,
        runs: s.runs,
        topTools: s.topTools,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        cost: s.cost,
        chainOk: s.chainOk,
      };
      if (!s.chainOk) row.brokenAtLine = s.brokenAtLine;
      return row;
    }),
    grandTotal: grandTotal(summaries),
  });
}

export function renderDetail(d: SessionDetail): string {
  const out: string[] = [];
  out.push(`Session ${d.session}`);
  out.push(`Provider/model: ${d.provider}/${d.model}`);
  out.push(
    `Runs: ${d.totals.runs} · tokens ${d.totals.tokensIn}/${d.totals.tokensOut} · cost ${usd(d.totals.cost)}`,
  );
  out.push(d.chainOk ? 'Hash chain: OK' : `Hash chain: BROKEN at line ${d.brokenAtLine}`);
  out.push('');

  if (d.runs.length) {
    const headers = ['START', 'MODEL', 'TOOLS', 'TOKENS IN/OUT', 'COST', 'EXIT'];
    const rows = d.runs.map((r) => [
      dateTime(r.start),
      r.model,
      String(r.toolCount),
      `${r.tokensIn}/${r.tokensOut}`,
      usd(r.cost),
      r.exitReason,
    ]);
    out.push('Runs:');
    out.push(...renderRows(headers, rows).map((l) => '  ' + l));
    out.push('');
  }

  if (d.timeline.length) {
    const headers = ['TIME', 'TOOL', 'DURATION', 'RESULT'];
    const rows = d.timeline.map((t) => [
      shortTime(t.ts),
      t.tool,
      t.durationMs === null ? 'n/a' : `${t.durationMs}ms`,
      t.isError ? '✗ error' : '✓',
    ]);
    out.push('Tool timeline:');
    out.push(...renderRows(headers, rows).map((l) => '  ' + l));
  } else {
    out.push('Tool timeline: (no tool calls)');
  }

  return out.join('\n');
}

export function renderDetailJson(d: SessionDetail): string {
  const obj: Record<string, unknown> = {
    session: d.session,
    provider: d.provider,
    model: d.model,
    chainOk: d.chainOk,
  };
  if (!d.chainOk) obj.brokenAtLine = d.brokenAtLine;
  obj.runs = d.runs;
  obj.timeline = d.timeline;
  obj.totals = d.totals;
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const USAGE = 'Usage: calliope cost [<sessionId>] [--json] [--dir <path>]\n';

/**
 * CLI entry: parse flags, resolve the runs dir (reusing audit path resolution),
 * and print either the cross-session report or a single-session drill-down.
 * Returns an exit code: 0 = ok, 1 = bad flag / unknown session id.
 */
export async function runCost(args: string[], options: CostOptions = {}): Promise<number> {
  const write = options.stdout ?? ((s: string) => void process.stdout.write(s));
  const writeErr = options.stderr ?? ((s: string) => void process.stderr.write(s));

  let json = false;
  let dirOverride: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      json = true;
    } else if (a === '--dir') {
      const v = args[++i];
      if (v === undefined) {
        writeErr('cost: --dir requires a path\n');
        return 1;
      }
      dirOverride = v;
    } else if (a === '-h' || a === '--help') {
      write(USAGE);
      return 0;
    } else if (a.startsWith('-')) {
      writeErr(`cost: unknown option ${a}\n${USAGE}`);
      return 1;
    } else {
      positionals.push(a);
    }
  }

  const dir = dirOverride ?? resolveAuditSettings().dir;
  const sessionId = positionals[0];

  // Drill-down for a specific session id.
  if (sessionId !== undefined) {
    const detail = detailForSession(dir, sessionId);
    if (!detail) {
      writeErr(`cost: session not found: ${sessionId} (looked in ${dir})\n`);
      return 1;
    }
    write((json ? renderDetailJson(detail) : renderDetail(detail)) + '\n');
    return 0;
  }

  // Cross-session report.
  const summaries = summarizeDir(dir);
  if (summaries.length === 0) {
    if (json) {
      write(
        JSON.stringify({
          dir,
          sessions: [],
          grandTotal: { sessions: 0, runs: 0, tokensIn: 0, tokensOut: 0, cost: 0 },
        }) + '\n',
      );
    } else {
      write(`No run logs found in ${dir}\n`);
    }
    return 0;
  }

  write((json ? renderReportJson(summaries, dir) : renderReport(summaries, dir)) + '\n');
  return 0;
}
