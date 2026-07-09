/**
 * Calliope CLI - Replay (#189)
 *
 * `calliope replay <path|sessionId>` renders a run-log trace read-only to stdout:
 * chronological, human-readable, per-event timestamps, tool call/result pairing,
 * running cost accumulation, and a hash-chain verification result at the end.
 * `--json` emits the parsed events plus the verification for machine consumption.
 *
 * Exit codes: 0 = ok, 4 = hash chain broken, 1 = trace not found / unreadable.
 * Plain text only (no Ink), like the headless renderer.
 */

import * as fs from 'fs';
import {
  readRunLog,
  verifyChain,
  runLogPath,
  resolveAuditSettings,
  type RunLogLine,
  type ChainVerification,
} from './runlog.js';

export interface ReplayOptions {
  json?: boolean;
  /** Injectable writers (tests); default to process streams. */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/**
 * Resolve a replay target to a file path. Accepts either a direct path to a
 * `.jsonl` trace or a bare session id (resolved under the audit dir). Returns
 * null when nothing matches.
 */
export function resolveReplayTarget(pathOrSessionId: string): string | null {
  if (fs.existsSync(pathOrSessionId) && fs.statSync(pathOrSessionId).isFile()) {
    return pathOrSessionId;
  }
  const { dir } = resolveAuditSettings();
  const candidate = runLogPath(pathOrSessionId, dir);
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function shortTime(ts: string): string {
  // Render the time portion; fall back to the raw value if it isn't ISO.
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : ts;
}

function preview(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

function compactArgs(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

/**
 * Render a trace as human-readable text. Pure: returns the full string so it can
 * be asserted in tests or written to any stream.
 */
export function renderReplay(lines: RunLogLine[], verification: ChainVerification): string {
  const out: string[] = [];
  // Map tool-call id -> name for pairing results back to their calls.
  const toolNames = new Map<string, string>();
  let cumulativeCost = 0;

  out.push(`Run log — ${lines.length} event${lines.length === 1 ? '' : 's'}`);
  out.push('─'.repeat(60));

  for (const line of lines) {
    const t = shortTime(line.ts);
    switch (line.type) {
      case 'run_start': {
        const p = line as unknown as { session: string; cwd: string; provider: string; model: string };
        out.push(`[${t}] ▶ run start  session=${p.session}`);
        out.push(`         cwd=${p.cwd}`);
        out.push(`         provider=${p.provider} model=${p.model}`);
        break;
      }
      case 'user_prompt': {
        out.push(`[${t}] › user: ${preview(String((line as { text?: unknown }).text ?? ''))}`);
        break;
      }
      case 'assistant_message': {
        const p = line as unknown as { content: string; tokens?: { input: number; output: number }; cost?: number };
        cumulativeCost += p.cost ?? 0;
        const tok = p.tokens ? ` [${p.tokens.input}→${p.tokens.output} tok]` : '';
        const cost = typeof p.cost === 'number' ? ` $${p.cost.toFixed(4)}` : '';
        out.push(`[${t}] ‹ assistant${tok}${cost}: ${preview(String(p.content ?? ''))}`);
        break;
      }
      case 'tool_call': {
        const p = line as unknown as { id: string; name: string; args: Record<string, unknown> };
        toolNames.set(p.id, p.name);
        out.push(`[${t}]   ⚙ ${p.name}(${compactArgs(p.args ?? {})})  #${p.id}`);
        break;
      }
      case 'tool_result': {
        const p = line as unknown as { id: string; result: string; isError: boolean; durationMs: number };
        const name = toolNames.get(p.id) ?? '?';
        const flag = p.isError ? '✗' : '✓';
        out.push(`[${t}]   ${flag} ${name} #${p.id} (${p.durationMs}ms): ${preview(String(p.result ?? ''), 160)}`);
        break;
      }
      case 'budget_event': {
        const p = line as unknown as { message: string };
        out.push(`[${t}] ‖ budget: ${p.message}`);
        break;
      }
      case 'policy_event': {
        const p = line as unknown as { tool: string; decision: string; reason?: string };
        const reason = p.reason ? ` — ${p.reason}` : '';
        out.push(`[${t}] ⛨ policy: ${p.decision.toUpperCase()} ${p.tool}${reason}`);
        break;
      }
      case 'run_end': {
        const p = line as unknown as { totals: { inputTokens: number; outputTokens: number; cost: number; toolCalls: number; durationMs: number }; exitReason: string };
        const tt = p.totals;
        out.push(`[${t}] ■ run end  reason=${p.exitReason}`);
        out.push(`         tokens=${tt.inputTokens}→${tt.outputTokens} cost=$${tt.cost.toFixed(4)} tools=${tt.toolCalls} duration=${tt.durationMs}ms`);
        break;
      }
      default: {
        out.push(`[${t}] ${line.type}`);
      }
    }
  }

  out.push('─'.repeat(60));
  out.push(`Cumulative assistant cost: $${cumulativeCost.toFixed(4)}`);
  if (verification.ok) {
    out.push('Hash chain: OK');
  } else {
    out.push(`Hash chain: BROKEN at line ${verification.brokenAtLine} (${verification.reason})`);
  }
  return out.join('\n');
}

/** Machine-readable render: events, verification, and a small summary. */
export function renderReplayJson(lines: RunLogLine[], verification: ChainVerification): string {
  let cost = 0;
  let toolCalls = 0;
  for (const line of lines) {
    if (line.type === 'assistant_message') cost += (line as { cost?: number }).cost ?? 0;
    if (line.type === 'tool_call') toolCalls += 1;
  }
  return JSON.stringify({
    events: lines,
    verification,
    summary: { eventCount: lines.length, cumulativeCost: cost, toolCalls },
  });
}

/**
 * CLI entry: resolve the target, verify, render, and return an exit code.
 * 0 = ok, 4 = chain broken, 1 = not found / unreadable.
 */
export function runReplay(pathOrSessionId: string | undefined, options: ReplayOptions = {}): number {
  const write = options.stdout ?? ((s: string) => process.stdout.write(s));
  const writeErr = options.stderr ?? ((s: string) => process.stderr.write(s));

  if (!pathOrSessionId) {
    writeErr('replay: missing <path|sessionId>\nUsage: calliope replay <path|sessionId> [--json]\n');
    return 1;
  }

  const filePath = resolveReplayTarget(pathOrSessionId);
  if (!filePath) {
    writeErr(`replay: run log not found: ${pathOrSessionId}\n`);
    return 1;
  }

  let lines: RunLogLine[];
  try {
    lines = readRunLog(filePath);
  } catch (err) {
    writeErr(`replay: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const verification = verifyChain(lines);
  const rendered = options.json
    ? renderReplayJson(lines, verification)
    : renderReplay(lines, verification);
  write(rendered + '\n');

  return verification.ok ? 0 : 4;
}
