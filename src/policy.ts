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
  signal?: AbortSignal;
  /** Override the configured command (tests / embedding). */
  command?: string;
  /** Override the configured judgment rules file (tests / embedding). */
  judgment?: string;
  /** Override the configured timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
/**
 * A judged decision waits on a provider, not a local script: observed round
 * trips run from about one second to over six. The spawn default would deny
 * healthy calls, so the built-in source gets a latency-matched default that an
 * operator can still lower with `policy.timeoutMs`.
 */
const DEFAULT_JUDGMENT_TIMEOUT_MS = 30000;

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

/**
 * Built-in judgment classifier, an opt-in alternative to spawning `command`.
 * Off unless an operator sets `policy.judgment` to a rules file.
 */
export function getPolicyJudgment(): string | undefined {
  try {
    const policy = config.get('policy') as { judgment?: string } | undefined;
    const rules = policy?.judgment;
    return typeof rules === 'string' && rules.trim().length > 0 ? rules : undefined;
  } catch {
    return undefined;
  }
}

function getPolicyTimeout(fallback: number = DEFAULT_TIMEOUT_MS): number {
  try {
    const policy = config.get('policy') as { timeoutMs?: number } | undefined;
    const t = policy?.timeoutMs;
    return typeof t === 'number' && t > 0 ? t : fallback;
  } catch {
    return fallback;
  }
}

/** True when either policy source is configured (or explicitly provided). */
export function isPolicyEnabled(options: PolicyOptions = {}): boolean {
  return Boolean(options.command ?? getPolicyCommand()) || Boolean(options.judgment ?? getPolicyJudgment());
}

/**
 * Judge the tool call in process against the configured rules file. Mirrors the
 * spawned engine's stance exactly: the timeout and every failure deny, and the
 * configured provider is explicit so an operator knows which backend is spending.
 */
async function evaluateJudgmentPolicy(toolCall: ToolCall, rulesPath: string, timeoutMs: number, started: number, options: PolicyOptions): Promise<PolicyResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const deny = (reason: string): PolicyResult => ({ decision: 'deny', source: 'policy', reason, durationMs: Date.now() - started });
  try {
    if (options.signal?.aborted) return deny('Policy evaluation cancelled');
    const { judgeToolCall, validateJudgmentEngine } = await import('./judgment/policy.js');
    const settings = (config.get('policy') ?? {}) as { judgmentProvider?: string; judgmentModel?: string };
    const { judgeProvider, judgeModel } = {
      judgeProvider: settings.judgmentProvider === undefined ? undefined : validateJudgmentEngine(settings.judgmentProvider),
      judgeModel: typeof settings.judgmentModel === 'string' && settings.judgmentModel.trim() ? settings.judgmentModel : undefined,
    };
    const { verdict } = await judgeToolCall({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments }, {
      rulesPath, signal: controller.signal, ...(judgeProvider ? { provider: judgeProvider } : {}), ...(judgeModel ? { model: judgeModel } : {}),
    });
    if (verdict.decision === 'allow') return { decision: 'allow', source: 'policy', durationMs: Date.now() - started };
    return deny(verdict.reason ?? 'policy denied');
  } catch (error) {
    if (timedOut) return deny(`policy judgment timed out after ${timeoutMs}ms (fail closed)`);
    if (options.signal?.aborted) return deny('Policy evaluation cancelled');
    return deny(`policy judgment could not decide: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Evaluate the policy command for a pending tool call. Always resolves (never
 * rejects): any failure to run the command is treated as a DENY so a broken or
 * unreachable policy engine cannot silently wave tools through.
 */
export function evaluatePolicy(toolCall: ToolCall, options: PolicyOptions = {}): Promise<PolicyResult> {
  const command = options.command ?? getPolicyCommand();
  const judgment = options.judgment ?? getPolicyJudgment();
  const started = Date.now();

  if (options.signal?.aborted) return Promise.resolve({decision:'deny',source:'policy',reason:'Policy evaluation cancelled',durationMs:0});
  // Two configured sources are an ambiguous security control, so deny rather
  // than silently pick one.
  if (command && judgment) {
    return Promise.resolve({ decision: 'deny', source: 'policy', reason: 'policy.command and policy.judgment are both set; configure exactly one (fail closed)', durationMs: 0 });
  }
  if (judgment) return evaluateJudgmentPolicy(toolCall, judgment, options.timeoutMs ?? getPolicyTimeout(DEFAULT_JUDGMENT_TIMEOUT_MS), started, options);
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
    let timedOut = false, cancelled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    proc.stderr?.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(0,65536);
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
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 2000);
      signalGroup('SIGTERM');
    }, timeoutMs);

    const abort = () => { cancelled = true; signalGroup('SIGKILL'); };
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal?.removeEventListener('abort',abort); if (cancelled || timedOut) { try { if (proc.pid) process.kill(-proc.pid,'SIGKILL'); } catch { /* Group already exited. */ } } };
    proc.on('close', (code) => {
      cleanup();
      if (cancelled) { done({decision:'deny',source:'policy',reason:'Policy evaluation cancelled'}); return; }
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
      cleanup();
      // Fail closed on runtime spawn error (e.g. command not found).
      done({ decision: 'deny', source: 'policy', reason: `policy hook error: ${err.message}` });
    });

    options.signal?.addEventListener('abort',abort,{once:true});
    if (options.signal?.aborted) abort();
    proc.stdin?.on?.('error', () => { /* Process close/error owns the decision. */ });
    // Feed the tool-call JSON to the policy on stdin, then close it.
    try {
      proc.stdin?.write(input);
      proc.stdin?.end();
    } catch {
      /* if stdin is gone the process will exit on its own; close/error handles it */
    }
  });
}
