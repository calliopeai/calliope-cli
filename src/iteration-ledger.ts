/**
 * Iteration Ledger
 *
 * Tracks what the agent attempted each iteration and the outcome.
 * Inspired by autoresearch's results.tsv — every attempt is logged
 * so the agent can learn from failures without repeating them.
 *
 * The ledger provides two key capabilities:
 * 1. Compact iteration summaries for context injection
 * 2. Failed approach tracking to prevent repetition
 */

// ============================================================================
// Types
// ============================================================================

export type LedgerOutcome = 'success' | 'error' | 'partial' | 'blocked' | 'skipped';

export interface LedgerEntry {
  iteration: number;
  timestamp: number;
  /** What the agent attempted (tool calls, approach summary) */
  actions: LedgerAction[];
  /** Overall outcome of this iteration */
  outcome: LedgerOutcome;
  /** Tokens consumed this iteration */
  tokens: { input: number; output: number };
  /** Wall-clock duration in ms */
  durationMs: number;
  /** Cost in USD */
  cost: number;
}

export interface LedgerAction {
  tool: string;
  args: string;        // compact stringified key args (path, command, etc.)
  result: 'ok' | 'error' | 'blocked';
  errorSummary?: string; // first line of error if failed
}

export interface FailedApproach {
  /** What was attempted */
  description: string;
  /** Why it failed */
  reason: string;
  /** Which iteration */
  iteration: number;
  /** Tool calls involved */
  tools: string[];
}

export type LedgerRunKind = 'agent' | 'loop' | 'swarm' | 'council' | 'workflow';

export type LedgerRunStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'stopped';

export interface LedgerRun {
  id: string;
  kind: LedgerRunKind;
  prompt: string;
  status: LedgerRunStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  completionPromise?: string;
  maxIterations?: number | null;
  entryCountAtStart: number;
  entryCountAtEnd?: number;
  errorSummary?: string;
}

export interface IterationLedgerSnapshot {
  version: 1;
  entries: LedgerEntry[];
  failedApproaches: FailedApproach[];
  currentEntry: Partial<LedgerEntry> | null;
  iterationStart: number;
  runs: LedgerRun[];
  nextIterationNumber?: number;
  totalEntryCount?: number;
  totalTokenCount?: number;
  totalCostUsd?: number;
  totalDurationMs?: number;
  totalFailureCount?: number;
  totalFailedApproachCount?: number;
}

// ============================================================================
// Iteration Ledger
// ============================================================================

export class IterationLedger {
  private entries: LedgerEntry[] = [];
  private failedApproaches: FailedApproach[] = [];
  private runs: LedgerRun[] = [];
  private currentEntry: Partial<LedgerEntry> | null = null;
  private iterationStart = 0;
  private nextIterationNumber = 1;
  private totalEntryCount = 0;
  private totalTokenCount = 0;
  private totalCostUsd = 0;
  private totalDurationMs = 0;
  private totalFailureCount = 0;
  private totalFailedApproachCount = 0;
  private retentionLimit = 0;
  private onChange?: (ledger: IterationLedger) => void;

  constructor(snapshot?: IterationLedgerSnapshot | null) {
    if (snapshot) {
      this.loadSnapshot(snapshot);
    }
  }

  /**
   * Register a callback invoked whenever the ledger changes.
   */
  setOnChange(onChange?: (ledger: IterationLedger) => void): void {
    this.onChange = onChange;
  }

  /**
   * Serialize the ledger for storage.
   */
  toSnapshot(): IterationLedgerSnapshot {
    return {
      version: 1,
      entries: this.entries.map(entry => ({
        ...entry,
        actions: entry.actions.map(action => ({ ...action })),
        tokens: { ...entry.tokens },
      })),
      failedApproaches: this.failedApproaches.map(approach => ({
        ...approach,
        tools: [...approach.tools],
      })),
      currentEntry: this.currentEntry
        ? {
            ...this.currentEntry,
            actions: this.currentEntry.actions?.map(action => ({ ...action })),
            tokens: this.currentEntry.tokens ? { ...this.currentEntry.tokens } : undefined,
          }
        : null,
      iterationStart: this.iterationStart,
      runs: this.runs.map(run => ({ ...run })),
      nextIterationNumber: this.nextIterationNumber,
      totalEntryCount: this.totalEntryCount,
      totalTokenCount: this.totalTokenCount,
      totalCostUsd: this.totalCostUsd,
      totalDurationMs: this.totalDurationMs,
      totalFailureCount: this.totalFailureCount,
      totalFailedApproachCount: this.totalFailedApproachCount,
    };
  }

  /**
   * Configure in-memory/session retention for entries, failures, and runs.
   * A value of 0 disables pruning.
   */
  setRetentionLimit(limit: number): void {
    const normalized = Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : 0;

    if (normalized === this.retentionLimit) {
      return;
    }

    this.retentionLimit = normalized;
    this.touch();
  }

  /**
   * Get the current retention limit.
   */
  getRetentionLimit(): number {
    return this.retentionLimit;
  }

  /**
   * Load a snapshot and recover any interrupted work.
   */
  loadSnapshot(
    snapshot?: IterationLedgerSnapshot | null,
    options: { recoverInterrupted?: boolean } = {}
  ): void {
    if (!snapshot) {
      this.entries = [];
      this.failedApproaches = [];
      this.runs = [];
      this.currentEntry = null;
      this.iterationStart = 0;
      this.nextIterationNumber = 1;
      this.totalEntryCount = 0;
      this.totalTokenCount = 0;
      this.totalCostUsd = 0;
      this.totalDurationMs = 0;
      this.totalFailureCount = 0;
      this.totalFailedApproachCount = 0;
      return;
    }

    this.entries = Array.isArray(snapshot.entries)
      ? snapshot.entries.map(entry => ({
          ...entry,
          actions: Array.isArray(entry.actions) ? entry.actions.map(action => ({ ...action })) : [],
          tokens: entry.tokens ? { ...entry.tokens } : { input: 0, output: 0 },
        }))
      : [];

    this.failedApproaches = Array.isArray(snapshot.failedApproaches)
      ? snapshot.failedApproaches.map(approach => ({
          ...approach,
          tools: Array.isArray(approach.tools) ? [...approach.tools] : [],
        }))
      : [];

    this.runs = Array.isArray(snapshot.runs)
      ? snapshot.runs.map(run => ({ ...run }))
      : [];

    this.currentEntry = snapshot.currentEntry && typeof snapshot.currentEntry === 'object' && !Array.isArray(snapshot.currentEntry)
      ? {
          ...snapshot.currentEntry,
          actions: Array.isArray(snapshot.currentEntry.actions)
            ? snapshot.currentEntry.actions.map(action => ({ ...action }))
            : [],
          tokens: snapshot.currentEntry.tokens ? { ...snapshot.currentEntry.tokens } : { input: 0, output: 0 },
        }
      : null;

    this.iterationStart = typeof snapshot.iterationStart === 'number' ? snapshot.iterationStart : 0;
    const maxKnownIteration = Math.max(
      0,
      ...this.entries.map(entry => entry.iteration),
      typeof this.currentEntry?.iteration === 'number' ? this.currentEntry.iteration : 0,
    );
    this.totalEntryCount = typeof snapshot.totalEntryCount === 'number'
      ? snapshot.totalEntryCount
      : maxKnownIteration;
    this.nextIterationNumber = typeof snapshot.nextIterationNumber === 'number'
      ? snapshot.nextIterationNumber
      : maxKnownIteration + 1;
    this.totalTokenCount = typeof snapshot.totalTokenCount === 'number'
      ? snapshot.totalTokenCount
      : this.entries.reduce((sum, entry) => sum + entry.tokens.input + entry.tokens.output, 0);
    this.totalCostUsd = typeof snapshot.totalCostUsd === 'number'
      ? snapshot.totalCostUsd
      : this.entries.reduce((sum, entry) => sum + entry.cost, 0);
    this.totalDurationMs = typeof snapshot.totalDurationMs === 'number'
      ? snapshot.totalDurationMs
      : this.entries.reduce((sum, entry) => sum + entry.durationMs, 0);
    this.totalFailureCount = typeof snapshot.totalFailureCount === 'number'
      ? snapshot.totalFailureCount
      : this.entries.reduce((sum, entry) => sum + (entry.outcome === 'error' ? 1 : 0), 0);
    this.totalFailedApproachCount = typeof snapshot.totalFailedApproachCount === 'number'
      ? snapshot.totalFailedApproachCount
      : this.failedApproaches.length;

    if (options.recoverInterrupted !== false) {
      this.recoverInterruptedState();
    }

    this.pruneRetainedState();
  }

  /**
   * Start tracking a new iteration.
   */
  startIteration(iteration = this.nextIterationNumber): void {
    if (this.currentEntry) {
      this.endIteration('error');
    }
    this.currentEntry = {
      iteration,
      timestamp: Date.now(),
      actions: [],
      tokens: { input: 0, output: 0 },
      cost: 0,
    };
    this.iterationStart = Date.now();
    this.nextIterationNumber = Math.max(this.nextIterationNumber, iteration + 1);
    this.touch();
  }

  /**
   * Record a tool call and its outcome within the current iteration.
   */
  recordAction(
    tool: string,
    args: Record<string, unknown>,
    result: 'ok' | 'error' | 'blocked',
    errorSummary?: string,
  ): void {
    if (!this.currentEntry) return;

    // Extract compact arg summary (path, command, or first string arg)
    const argSummary = compactArgs(tool, args);

    this.currentEntry.actions!.push({
      tool,
      args: argSummary,
      result,
      errorSummary: errorSummary?.split('\n')[0]?.substring(0, 120),
    });
    this.touch();
  }

  /**
   * Record token usage for the current iteration.
   */
  recordTokens(input: number, output: number, cost: number): void {
    if (!this.currentEntry) return;
    this.currentEntry.tokens = { input, output };
    this.currentEntry.cost = cost;
    this.touch();
  }

  /**
   * End the current iteration and compute its outcome.
   */
  endIteration(outcome?: LedgerOutcome): void {
    if (!this.currentEntry) return;

    const entry: LedgerEntry = {
      iteration: this.currentEntry.iteration!,
      timestamp: this.currentEntry.timestamp!,
      actions: this.currentEntry.actions || [],
      outcome: outcome || inferOutcome(this.currentEntry.actions || []),
      tokens: this.currentEntry.tokens || { input: 0, output: 0 },
      durationMs: Date.now() - this.iterationStart,
      cost: this.currentEntry.cost || 0,
    };

    this.entries.push(entry);
    this.totalEntryCount = Math.max(this.totalEntryCount + 1, entry.iteration);
    this.totalTokenCount += entry.tokens.input + entry.tokens.output;
    this.totalCostUsd += entry.cost;
    this.totalDurationMs += entry.durationMs;
    if (entry.outcome === 'error') {
      this.totalFailureCount++;
    }

    // Auto-detect failed approaches from error patterns
    if (entry.outcome === 'error') {
      const errorActions = entry.actions.filter(a => a.result === 'error');
      if (errorActions.length > 0) {
        const tools = errorActions.map(a => a.tool);
        const description = errorActions
          .map(a => `${a.tool}(${a.args})`)
          .join(', ');
        const reason = errorActions
          .map(a => a.errorSummary)
          .filter(Boolean)
          .join('; ') || 'unknown error';

        this.failedApproaches.push({
          description,
          reason,
          iteration: entry.iteration,
          tools,
        });
        this.totalFailedApproachCount++;
      }
    }

    this.currentEntry = null;
    this.touch();
  }

  /**
   * Manually record a failed approach (for higher-level failures
   * like "tried approach X but it didn't work").
   */
  recordFailedApproach(description: string, reason: string, tools: string[] = []): void {
    this.failedApproaches.push({
      description,
      reason,
      iteration: Math.max(this.totalEntryCount, this.entries[this.entries.length - 1]?.iteration || 0),
      tools,
    });
    this.totalFailedApproachCount++;
    this.touch();
  }

  /**
   * Start tracking a higher-level run, such as a loop or standalone agent turn.
   */
  startRun(
    kind: LedgerRunKind,
    prompt: string,
    options: {
      completionPromise?: string;
      maxIterations?: number | null;
    } = {}
  ): string {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    this.runs.push({
      id: runId,
      kind,
      prompt: truncate(prompt.replace(/\s+/g, ' ').trim(), 160),
      status: 'running',
      startedAt: now,
      updatedAt: now,
      completedAt: undefined,
      completionPromise: options.completionPromise,
      maxIterations: options.maxIterations,
      entryCountAtStart: this.totalEntryCount,
    });

    this.touch();
    return runId;
  }

  /**
   * Finish a higher-level run and capture its final status.
   */
  finishRun(
    runId: string,
    status: Exclude<LedgerRunStatus, 'running'>,
    options: {
      errorSummary?: string;
    } = {}
  ): void {
    const run = this.runs.find(entry => entry.id === runId);
    if (!run) return;

    const now = Date.now();
    run.status = status;
    run.updatedAt = now;
    run.completedAt = now;
    run.entryCountAtEnd = this.totalEntryCount;
    run.errorSummary = options.errorSummary
      ? truncate(options.errorSummary.replace(/\s+/g, ' ').trim(), 200)
      : run.errorSummary;

    this.touch();
  }

  /**
   * Get a compact context string for injection into the agent's messages.
   * Shows recent iterations and failed approaches so the agent avoids repetition.
   */
  getContextSummary(maxEntries = 10): string {
    const parts: string[] = [];

    // Recent iteration history
    const recent = this.entries.slice(-maxEntries);
    if (recent.length > 0) {
      parts.push('## Iteration History');
      for (const entry of recent) {
        const actionSummary = entry.actions
          .map(a => `${a.tool}(${a.args})${a.result === 'error' ? ' FAILED' : ''}`)
          .join(', ');
        const duration = entry.durationMs < 1000
          ? `${entry.durationMs}ms`
          : `${(entry.durationMs / 1000).toFixed(1)}s`;
        parts.push(`  #${entry.iteration} [${entry.outcome}] ${duration} — ${actionSummary}`);
      }
    }

    // Failed approaches
    if (this.failedApproaches.length > 0) {
      parts.push('');
      parts.push('## Failed Approaches (do NOT repeat these)');
      for (const fa of this.failedApproaches.slice(-5)) {
        parts.push(`  - ${fa.description} — FAILED: ${fa.reason}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Get failed approaches as a system message for context injection.
   * Returns null if there are no failed approaches.
   */
  getFailedApproachesMessage(): string | null {
    if (this.failedApproaches.length === 0) return null;

    const lines = this.failedApproaches.slice(-5).map(
      fa => `- ${fa.description} — FAILED: ${fa.reason}`
    );

    return [
      '[Previous failed approaches — avoid repeating these:',
      ...lines,
      ']',
    ].join('\n');
  }

  /**
   * Check if a tool call pattern matches a previously failed approach.
   */
  hasFailedBefore(tool: string, args: Record<string, unknown>): FailedApproach | undefined {
    const argStr = compactArgs(tool, args);
    const signature = `${tool}(${argStr})`;
    return this.failedApproaches.find(fa => fa.description.includes(signature));
  }

  /**
   * Get all entries (for debugging/display).
   */
  getEntries(): readonly LedgerEntry[] {
    return this.entries;
  }

  /**
   * Get failed approaches recorded for this session.
   */
  getFailedApproaches(): readonly FailedApproach[] {
    return this.failedApproaches;
  }

  /**
   * Get recent run records.
   */
  getRuns(limit?: number): readonly LedgerRun[] {
    if (!limit || limit <= 0) return this.runs;
    return this.runs.slice(-limit);
  }

  /**
   * Get the latest run, optionally filtered by kind or status.
   */
  getLatestRun(kind?: LedgerRunKind): LedgerRun | undefined {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      if (!kind || this.runs[i].kind === kind) {
        return this.runs[i];
      }
    }
    return undefined;
  }

  /**
   * Get an active run, optionally filtered by kind.
   */
  getActiveRun(kind?: LedgerRunKind): LedgerRun | undefined {
    return this.runs.find(run => run.status === 'running' && (!kind || run.kind === kind));
  }

  /**
   * Get the next global iteration number for session-wide logging.
   */
  getNextIterationNumber(): number {
    return this.nextIterationNumber;
  }

  /**
   * Get session totals across the full session, including pruned history.
   */
  getTotals(): { iterations: number; totalTokens: number; totalCost: number; totalDurationMs: number; failures: number } {
    return {
      iterations: this.totalEntryCount,
      totalTokens: this.totalTokenCount,
      totalCost: this.totalCostUsd,
      totalDurationMs: this.totalDurationMs,
      failures: this.totalFailureCount,
    };
  }

  /**
   * Get the total number of failed approaches recorded across the full session.
   */
  getFailedApproachCount(): number {
    return this.totalFailedApproachCount;
  }

  /**
   * Reset the ledger (e.g. on /clear).
   */
  reset(): void {
    this.entries = [];
    this.failedApproaches = [];
    this.runs = [];
    this.currentEntry = null;
    this.iterationStart = 0;
    this.nextIterationNumber = 1;
    this.totalEntryCount = 0;
    this.totalTokenCount = 0;
    this.totalCostUsd = 0;
    this.totalDurationMs = 0;
    this.totalFailureCount = 0;
    this.totalFailedApproachCount = 0;
    this.touch();
  }

  /**
   * Recover interrupted state from a persisted snapshot.
   * Returns true if anything was recovered.
   */
  recoverInterruptedState(reason = 'Previous session ended before completion'): boolean {
    let recovered = false;
    const now = Date.now();

    if (this.currentEntry && typeof this.currentEntry.iteration === 'number' && typeof this.currentEntry.timestamp === 'number') {
      const recoveredEntry: LedgerEntry = {
        iteration: this.currentEntry.iteration,
        timestamp: this.currentEntry.timestamp,
        actions: this.currentEntry.actions || [],
        outcome: 'error',
        tokens: this.currentEntry.tokens || { input: 0, output: 0 },
        durationMs: this.iterationStart > 0 ? Math.max(0, now - this.iterationStart) : 0,
        cost: this.currentEntry.cost || 0,
      };
      this.entries.push(recoveredEntry);
      this.totalEntryCount = Math.max(this.totalEntryCount + 1, this.currentEntry.iteration);
      this.nextIterationNumber = Math.max(this.nextIterationNumber, this.currentEntry.iteration + 1);
      this.totalTokenCount += recoveredEntry.tokens.input + recoveredEntry.tokens.output;
      this.totalCostUsd += recoveredEntry.cost;
      this.totalDurationMs += recoveredEntry.durationMs;
      this.totalFailureCount++;
      this.currentEntry = null;
      this.iterationStart = 0;
      recovered = true;
    }

    for (const run of this.runs) {
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.updatedAt = now;
        run.completedAt = now;
        run.entryCountAtEnd = this.totalEntryCount;
        if (!run.errorSummary) {
          run.errorSummary = truncate(reason, 200);
        }
        recovered = true;
      }
    }

    return recovered;
  }

  private touch(): void {
    this.pruneRetainedState();
    this.onChange?.(this);
  }

  private pruneRetainedState(): void {
    if (this.retentionLimit <= 0) {
      return;
    }

    if (this.entries.length > this.retentionLimit) {
      this.entries = this.entries.slice(-this.retentionLimit);
    }

    if (this.failedApproaches.length > this.retentionLimit) {
      this.failedApproaches = this.failedApproaches.slice(-this.retentionLimit);
    }

    if (this.runs.length > this.retentionLimit) {
      const activeRuns = this.runs.filter(run => run.status === 'running');
      const finishedRuns = this.runs.filter(run => run.status !== 'running');
      const maxFinished = Math.max(0, this.retentionLimit - activeRuns.length);
      this.runs = [...finishedRuns.slice(-maxFinished), ...activeRuns]
        .sort((a, b) => a.startedAt - b.startedAt);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function compactArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'shell':
      return truncate(String(args.command || ''), 60);
    case 'read_file':
    case 'write_file':
    case 'list_files':
      return truncate(String(args.path || ''), 60);
    case 'think':
      return truncate(String(args.thought || ''), 40);
    case 'web_search':
      return truncate(String(args.query || ''), 40);
    case 'execute_code':
      return `${args.language || 'unknown'}`;
    default: {
      const first = Object.values(args)[0];
      return first ? truncate(String(first), 40) : '';
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + '...' : s;
}

function inferOutcome(actions: LedgerAction[]): LedgerOutcome {
  if (actions.length === 0) return 'skipped';
  const hasError = actions.some(a => a.result === 'error');
  const hasBlocked = actions.some(a => a.result === 'blocked');
  const allOk = actions.every(a => a.result === 'ok');
  if (allOk) return 'success';
  if (hasError && !allOk) return actions.every(a => a.result === 'error') ? 'error' : 'partial';
  if (hasBlocked) return 'blocked';
  return 'partial';
}
