/**
 * Calliope CLI - Run Logs (audit trail)
 *
 * Append-only JSONL trace of an agent session, written to
 * `~/.calliope-cli/runs/<sessionId>.jsonl` (override with `audit.dir`).
 *
 * Every line is a self-describing event carrying a schema `v`ersion, a monotonic
 * `seq`uence number, an ISO `ts`, the event `type`, a type-specific payload, and
 * a tamper-evidence hash chain: `prev_hash` (the previous line's hash) and `hash`
 * (sha256 of `prev_hash` + the canonical JSON of the line body). No signing keys
 * are needed — any edit, reorder, insertion, or deletion breaks the chain at that
 * line, which `verifyChain` reports. See docs/governance.md.
 *
 * Writes are buffered and appended asynchronously (ordered via an internal
 * promise chain); fsync is not forced per line, so logging never blocks the agent
 * loop. The hash chain is advanced synchronously so ordering is always correct.
 *
 * On by default: the audit trail is the point, and it is local disk. Disable with
 * `audit.enabled = false`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import * as config from './config.js';

// ============================================================================
// Schema
// ============================================================================

/** Run-log schema version. Bump only for breaking payload changes. */
export const RUNLOG_SCHEMA_VERSION = 1;

export type RunLogEventType =
  | 'run_start'
  | 'user_prompt'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'budget_event'
  | 'policy_event'
  | 'run_end';

/** The stable, on-disk shape of a run-log line. */
export interface RunLogLine {
  v: number;
  seq: number;
  ts: string;
  type: RunLogEventType;
  prev_hash: string;
  hash: string;
  // Type-specific payload fields are merged in at the top level.
  [key: string]: unknown;
}

export interface RunStartPayload {
  session: string;
  cwd: string;
  provider: string;
  model: string;
  /** Config snapshot with credentials stripped (never contains apiKey/token values). */
  config: Record<string, unknown>;
  /** How the session was driven: e.g. 'headless', 'acp'. Omitted for the default TUI. */
  mode?: string;
}

export interface AssistantMessagePayload {
  content: string;
  tokens: { input: number; output: number };
  cost: number;
}

export interface ToolCallPayload {
  id: string;
  name: string;
  /** Arguments after a redaction pass for obvious secrets. */
  args: Record<string, unknown>;
}

export interface ToolResultPayload {
  id: string;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface BudgetEventPayload {
  scope: 'run' | 'project';
  kind: 'cost' | 'tokens';
  spent: number;
  cap: number;
  message: string;
}

export interface PolicyEventPayload {
  tool: string;
  decision: 'allow' | 'deny';
  source: string;
  reason?: string;
  durationMs: number;
}

export interface RunEndPayload {
  totals: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    toolCalls: number;
    durationMs: number;
  };
  exitReason: string;
}

// ============================================================================
// Redaction
// ============================================================================

/** Object keys whose values are always credentials — stripped wholesale. */
const SECRET_KEY_RE =
  /(api[-_]?key|token|secret|password|passwd|authorization|credential|access[-_]?key|private[-_]?key|client[-_]?secret|session[-_]?token|bearer)/i;

/** String values that look like well-known secret formats. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const REDACTED = '[REDACTED]';

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(pattern, 'g'), REDACTED);
  }
  return out;
}

/**
 * Deep-copy `value`, replacing anything that looks like a secret with
 * `[REDACTED]`. Keys matching {@link SECRET_KEY_RE} are stripped by key name
 * (so an empty or oddly-formatted API key is still removed); string values
 * matching a known secret format are masked in place. Structure is preserved so
 * the trace stays readable and diffable.
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactSecrets(val);
    }
  }
  return out;
}

// ============================================================================
// Hash chain
// ============================================================================

/**
 * Deterministic JSON with object keys sorted recursively, so a line's canonical
 * form is independent of key insertion order. Arrays keep their order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

function hashBody(prevHash: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash + canonicalize(body)).digest('hex');
}

export interface ChainVerification {
  ok: boolean;
  /** 1-based line number where the chain first breaks, if any. */
  brokenAtLine?: number;
  /** Human-readable reason for the break. */
  reason?: string;
}

/**
 * Recompute the hash chain over parsed lines and report the first break.
 * A line breaks the chain if its `prev_hash` does not match the previous line's
 * `hash`, or if its recomputed `hash` does not match its stored `hash`.
 */
export function verifyChain(lines: RunLogLine[]): ChainVerification {
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Reconstruct the body (everything except the chain fields).
    const { prev_hash, hash, ...body } = line;
    if (prev_hash !== prev) {
      return { ok: false, brokenAtLine: i + 1, reason: 'prev_hash mismatch' };
    }
    const expected = hashBody(prev_hash, body);
    if (expected !== hash) {
      return { ok: false, brokenAtLine: i + 1, reason: 'hash mismatch' };
    }
    prev = hash;
  }
  return { ok: true };
}

// ============================================================================
// Paths + rotation
// ============================================================================

export interface AuditSettings {
  enabled: boolean;
  dir: string;
  retention: number;
}

const DEFAULT_RUNS_DIR = path.join(os.homedir(), '.calliope-cli', 'runs');
const DEFAULT_RETENTION = 100;

/** Resolve audit settings from config, with optional explicit overrides. */
export function resolveAuditSettings(overrides: Partial<AuditSettings> = {}): AuditSettings {
  let stored: { enabled?: boolean; dir?: string; retention?: number } | undefined;
  try {
    stored = config.get('audit');
  } catch {
    stored = undefined;
  }
  const enabled =
    overrides.enabled ?? stored?.enabled ?? true; // ON by default
  const dir = overrides.dir ?? stored?.dir ?? DEFAULT_RUNS_DIR;
  const retentionRaw = overrides.retention ?? stored?.retention ?? DEFAULT_RETENTION;
  const retention = Number.isFinite(retentionRaw) && retentionRaw > 0
    ? Math.floor(retentionRaw)
    : DEFAULT_RETENTION;
  return { enabled, dir, retention };
}

/** Return the run-log file path for a session id under the given (or default) dir. */
export function runLogPath(sessionId: string, dir = DEFAULT_RUNS_DIR): string {
  // Session ids are internally generated (`session_<ts>_<rand>`), but guard
  // against path traversal from any externally-supplied id all the same.
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dir, `${safe}.jsonl`);
}

/**
 * Keep only the most recent `retention` run-log files in `dir` (by mtime),
 * deleting the rest. Best-effort: a delete failure is ignored.
 */
export function rotateRuns(dir: string, retention: number): void {
  if (retention <= 0) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return;
  }
  if (entries.length <= retention) return;

  const withMtime = entries
    .map((f) => {
      const full = path.join(dir, f);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  for (const { full } of withMtime.slice(retention)) {
    try {
      fs.unlinkSync(full);
    } catch {
      /* best effort */
    }
  }
}

// ============================================================================
// Reading
// ============================================================================

/**
 * Parse a run-log file into lines. Blank lines are skipped; an unparseable line
 * throws (a corrupt trace should be visible, not silently truncated). Callers
 * that want tolerance can catch.
 */
export function readRunLog(filePath: string): RunLogLine[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines: RunLogLine[] = [];
  const rawLines = content.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.trim();
    if (!raw) continue;
    try {
      lines.push(JSON.parse(raw) as RunLogLine);
    } catch {
      throw new Error(`runlog: unparseable JSON on line ${i + 1} of ${filePath}`);
    }
  }
  return lines;
}

// ============================================================================
// RunLog (writer)
// ============================================================================

/** Per-file instance cache so multiple turns share one hash chain. */
const cache = new Map<string, RunLog>();

export class RunLog {
  readonly sessionId: string;
  readonly filePath: string;
  readonly enabled: boolean;
  private seq = 0;
  private prevHash = '';
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(sessionId: string, filePath: string, enabled: boolean) {
    this.sessionId = sessionId;
    this.filePath = filePath;
    this.enabled = enabled;
  }

  /**
   * Open (or reuse) the run log for a session. If a trace already exists on disk
   * the hash chain is resumed from its last valid line. Multiple opens for the
   * same file return the same instance so a session's turns share one chain.
   */
  static open(sessionId: string, overrides: Partial<AuditSettings> = {}): RunLog {
    const settings = resolveAuditSettings(overrides);
    const filePath = runLogPath(sessionId, settings.dir);

    const existing = cache.get(filePath);
    if (existing) return existing;

    const log = new RunLog(sessionId, filePath, settings.enabled);
    if (settings.enabled) {
      try {
        fs.mkdirSync(settings.dir, { recursive: true });
      } catch {
        /* if the dir can't be made, writes below will no-op via the catch */
      }
      // Rotate old sessions before this new one lands (cheap: once per open).
      if (!fs.existsSync(filePath)) {
        rotateRuns(settings.dir, settings.retention);
      } else {
        log.resumeChain();
      }
    }
    cache.set(filePath, log);
    return log;
  }

  /** Resume seq/prev_hash from the last valid line of an existing trace. */
  private resumeChain(): void {
    let lines: RunLogLine[];
    try {
      lines = readRunLog(this.filePath);
    } catch {
      // Corrupt tail: fall back to a best-effort scan for the last valid line.
      lines = [];
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8').split('\n');
        for (const line of raw) {
          const t = line.trim();
          if (!t) continue;
          try {
            lines.push(JSON.parse(t) as RunLogLine);
          } catch {
            /* skip torn line */
          }
        }
      } catch {
        return;
      }
    }
    const last = lines[lines.length - 1];
    if (last && typeof last.hash === 'string' && typeof last.seq === 'number') {
      this.prevHash = last.hash;
      this.seq = last.seq + 1;
    }
  }

  /** Build the next line, advance the chain synchronously, enqueue the write. */
  private append(type: RunLogEventType, payload: Record<string, unknown>): void {
    if (!this.enabled) return;
    const body: Record<string, unknown> = {
      v: RUNLOG_SCHEMA_VERSION,
      seq: this.seq,
      ts: new Date().toISOString(),
      type,
      ...payload,
    };
    const hash = hashBody(this.prevHash, body);
    const line: RunLogLine = { ...(body as object), prev_hash: this.prevHash, hash } as RunLogLine;
    this.prevHash = hash;
    this.seq += 1;

    const text = JSON.stringify(line) + '\n';
    this.writeTail = this.writeTail
      .then(() => fs.promises.appendFile(this.filePath, text))
      .catch(() => {
        /* logging must never throw into the agent loop; drop on I/O error */
      });
  }

  runStart(payload: RunStartPayload): void {
    this.append('run_start', {
      ...payload,
      config: redactSecrets(payload.config) as Record<string, unknown>,
    });
  }

  userPrompt(text: string): void {
    this.append('user_prompt', { text });
  }

  assistantMessage(payload: AssistantMessagePayload): void {
    this.append('assistant_message', { ...payload });
  }

  toolCall(payload: ToolCallPayload): void {
    this.append('tool_call', {
      id: payload.id,
      name: payload.name,
      args: redactSecrets(payload.args) as Record<string, unknown>,
    });
  }

  toolResult(payload: ToolResultPayload, maxResultChars = 2000): void {
    const result = payload.result.length > maxResultChars
      ? payload.result.slice(0, maxResultChars) + `\n... [truncated ${payload.result.length - maxResultChars} chars]`
      : payload.result;
    this.append('tool_result', {
      id: payload.id,
      result,
      isError: payload.isError,
      durationMs: payload.durationMs,
    });
  }

  budgetEvent(payload: BudgetEventPayload): void {
    this.append('budget_event', { ...payload });
  }

  policyEvent(payload: PolicyEventPayload): void {
    this.append('policy_event', { ...payload });
  }

  runEnd(payload: RunEndPayload): void {
    this.append('run_end', { ...payload });
  }

  /** Await all buffered writes. */
  flush(): Promise<void> {
    return this.writeTail;
  }

  /** Flush and drop this instance from the shared cache. */
  async close(): Promise<void> {
    await this.flush();
    cache.delete(this.filePath);
  }
}

/**
 * Record a supply-chain integrity violation (#137) as a `policy_event` in a
 * dedicated `security` audit trace. Called when an installed skill or plugin
 * fails hash re-verification at load time: the artifact is refused AND the
 * tamper is surfaced in the audit trail, so it is not lost to a transient
 * console warning that scrolls away.
 *
 * `subject` identifies the artifact (e.g. `skill:foo`, `plugin:bar`). Self-gates
 * on the audit setting: when audit is disabled the underlying RunLog no-ops, so
 * "log a policy_event if audit is on" needs no extra branch at the call site.
 * Never throws — auditing must never break the load path it observes.
 *
 * Returns the RunLog so callers/tests can await `.flush()`, or null if the
 * trace could not be opened.
 */
export function auditIntegrityViolation(
  subject: string,
  reason: string,
  overrides: Partial<AuditSettings> = {},
): RunLog | null {
  try {
    const log = RunLog.open('security', overrides);
    log.policyEvent({
      tool: subject,
      decision: 'deny',
      source: 'integrity',
      reason,
      durationMs: 0,
    });
    return log;
  } catch {
    return null;
  }
}

/**
 * Clear the in-memory instance cache (tests only). Does not touch disk.
 */
export function resetRunLogs(): void {
  cache.clear();
}
