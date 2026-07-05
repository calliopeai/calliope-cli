/**
 * Calliope CLI - Policy Hook (#189)
 *
 * A pre-tool-call governance seam distinct from the general `hooks.ts` plumbing.
 * The built-in hooks already veto via exit code 42 and pass context through
 * environment variables; a policy *engine* wants the full tool-call JSON and
 * conventional exit semantics. So `policy.command` gets a stronger, purpose-built
 * contract:
 *
 *   - stdin:  JSON `{ id, name, arguments }` for the pending tool call
 *   - exit 0: ALLOW
 *   - exit non-zero: DENY, with stderr used as the human-readable reason
 *   - timeout (default 5s) or spawn failure: DENY (fail closed)
 *
 * This is the Zentinelle integration point — see docs/governance.md. Every
 * decision is surfaced to the caller so it can be logged as a `policy_event`.
 */

import { spawn } from 'child_process';
import * as config from './config.js';
import type { ToolCall } from './types.js';

export type PolicyDecision = 'allow' | 'deny';

export interface PolicyResult {
  decision: PolicyDecision;
  /** 'none' when no policy is configured; 'policy' when the command ran/decided. */
  source: 'none' | 'policy';
  reason?: string;
  durationMs: number;
}

export interface PolicyOptions {
  /** Override the configured command (tests / embedding). */
  command?: string;
  /** Override the configured timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Configured policy command, or undefined when policy enforcement is off. */
export function getPolicyCommand(): string | undefined {
  try {
    const policy = config.get('policy') as { command?: string } | undefined;
    const cmd = policy?.command;
    return typeof cmd === 'string' && cmd.trim().length > 0 ? cmd : undefined;
  } catch {
    return undefined;
  }
}

function getPolicyTimeout(): number {
  try {
    const policy = config.get('policy') as { timeoutMs?: number } | undefined;
    const t = policy?.timeoutMs;
    return typeof t === 'number' && t > 0 ? t : DEFAULT_TIMEOUT_MS;
  } catch {
    return DEFAULT_TIMEOUT_MS;
  }
}

/** True when a policy command is configured (or explicitly provided). */
export function isPolicyEnabled(options: PolicyOptions = {}): boolean {
  return Boolean(options.command ?? getPolicyCommand());
}

/**
 * Evaluate the policy command for a pending tool call. Always resolves (never
 * rejects): any failure to run the command is treated as a DENY so a broken or
 * unreachable policy engine cannot silently wave tools through.
 */
export function evaluatePolicy(toolCall: ToolCall, options: PolicyOptions = {}): Promise<PolicyResult> {
  const command = options.command ?? getPolicyCommand();
  const started = Date.now();

  if (!command) {
    return Promise.resolve({ decision: 'allow', source: 'none', durationMs: 0 });
  }

  const timeoutMs = options.timeoutMs ?? getPolicyTimeout();
  const input = JSON.stringify({
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
  });

  return new Promise<PolicyResult>((resolve) => {
    let settled = false;
    const done = (result: Omit<PolicyResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      resolve({ ...result, durationMs: Date.now() - started });
    };

    // `detached` runs the command in its own process group so the timeout can
    // kill the whole group, not just the shell.
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      // Fail closed: if we cannot even launch the policy, deny.
      done({ decision: 'deny', source: 'policy', reason: `policy spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let stderr = '';
    let timedOut = false;

    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, signal);
      } catch {
        try {
          proc.kill(signal);
        } catch {
          /* already dead */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 2000);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // Fail closed on timeout.
        done({ decision: 'deny', source: 'policy', reason: `policy hook timed out after ${timeoutMs}ms (fail closed)` });
        return;
      }
      if (code === 0) {
        done({ decision: 'allow', source: 'policy' });
      } else {
        done({
          decision: 'deny',
          source: 'policy',
          reason: stderr.trim() || `policy denied (exit ${code ?? 'unknown'})`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      // Fail closed on runtime spawn error (e.g. command not found).
      done({ decision: 'deny', source: 'policy', reason: `policy hook error: ${err.message}` });
    });

    // Feed the tool-call JSON to the policy on stdin, then close it.
    try {
      proc.stdin?.write(input);
      proc.stdin?.end();
    } catch {
      /* if stdin is gone the process will exit on its own; close/error handles it */
    }
  });
}
