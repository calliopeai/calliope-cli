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

// ============================================================================
// Iteration Ledger
// ============================================================================

export class IterationLedger {
  private entries: LedgerEntry[] = [];
  private failedApproaches: FailedApproach[] = [];
  private currentEntry: Partial<LedgerEntry> | null = null;
  private iterationStart = 0;

  /**
   * Start tracking a new iteration.
   */
  startIteration(iteration: number): void {
    this.currentEntry = {
      iteration,
      timestamp: Date.now(),
      actions: [],
      tokens: { input: 0, output: 0 },
      cost: 0,
    };
    this.iterationStart = Date.now();
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
  }

  /**
   * Record token usage for the current iteration.
   */
  recordTokens(input: number, output: number, cost: number): void {
    if (!this.currentEntry) return;
    this.currentEntry.tokens = { input, output };
    this.currentEntry.cost = cost;
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
      }
    }

    this.currentEntry = null;
  }

  /**
   * Manually record a failed approach (for higher-level failures
   * like "tried approach X but it didn't work").
   */
  recordFailedApproach(description: string, reason: string, tools: string[] = []): void {
    this.failedApproaches.push({
      description,
      reason,
      iteration: this.entries.length,
      tools,
    });
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
   * Get session totals.
   */
  getTotals(): { iterations: number; totalTokens: number; totalCost: number; totalDurationMs: number; failures: number } {
    let totalTokens = 0;
    let totalCost = 0;
    let totalDurationMs = 0;
    let failures = 0;

    for (const entry of this.entries) {
      totalTokens += entry.tokens.input + entry.tokens.output;
      totalCost += entry.cost;
      totalDurationMs += entry.durationMs;
      if (entry.outcome === 'error') failures++;
    }

    return {
      iterations: this.entries.length,
      totalTokens,
      totalCost,
      totalDurationMs,
      failures,
    };
  }

  /**
   * Reset the ledger (e.g. on /clear).
   */
  reset(): void {
    this.entries = [];
    this.failedApproaches = [];
    this.currentEntry = null;
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
