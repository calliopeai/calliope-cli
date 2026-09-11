/** Canonical permission resolution for terminal, headless and editor clients. */
import type { Mode, ToolCall } from '../types.js';
import type { PolicyEventPayload } from '../runlog.js';
import { assessToolRisk, requiresConfirmation } from '../risk.js';
import { checkHooksAllow } from '../hooks.js';
import { evaluatePolicy, isPolicyEnabled } from '../policy.js';
import { checkToolBoundary } from '../tools.js';
import { cancellable, isCancellation, throwIfCancelled } from '../cancellation.js';
import { permissionReason, type PermissionDecision, type PermissionLayer } from './types.js';

const PLAN_TOOLS = new Set(['think', 'ask_question', 'create_plan', 'read_file', 'list_files']);
export const MUTATING_TOOLS = new Set(['shell', 'write_file', 'edit_file', 'git', 'execute_code', 'configure', 'session_branch', 'session_import']);

export interface PermissionContext {
  cwd: string;
  mode?: Mode;
  /** Explicit client defaults: terminal risk toggle, headless none, ACP mutations. */
  confirmation: 'none' | 'risk' | 'mutating';
  signal?: AbortSignal;
  approve?: (decision: PermissionDecision) => Promise<'allow' | 'reject' | 'cancelled'>;
  audit?: (event: PolicyEventPayload) => void;
}

export async function resolvePermission(call: ToolCall, context: PermissionContext): Promise<PermissionDecision> {
  const started = Date.now();
  const record = (decision: PermissionDecision['decision'], layer: PermissionLayer, detail: string): PermissionDecision => {
    const result = { decision, layer, reason: permissionReason(layer, detail), durationMs: Date.now() - started };
    context.audit?.({ tool: call.name, toolCallId: call.id, decision, source: layer, reason: result.reason, durationMs: result.durationMs });
    return result;
  };
  try {
    throwIfCancelled(context.signal);
    if (context.mode === 'plan' && !PLAN_TOOLS.has(call.name)) {
      return record('deny', 'mode', 'Plan mode: Tool not executed. Describe what this would do.');
    }
    const risk = assessToolRisk(call);
    const needsConfirmation = context.confirmation === 'risk'
      ? call.name !== 'think' && requiresConfirmation(risk, false)
      : context.confirmation === 'mutating' && (MUTATING_TOOLS.has(call.name) || risk.requiresConfirmation);
    if (needsConfirmation) {
      const pending = record('confirm', 'confirmation', `${risk.level} risk: ${risk.reason}. User confirmation required.`);
      if (!context.approve) return pending;
      const answer = await cancellable(context.approve(pending), context.signal);
      throwIfCancelled(context.signal);
      if (answer === 'cancelled') return record('cancelled', 'confirmation', 'Permission request cancelled');
      if (answer !== 'allow') return record('deny', 'confirmation', 'Permission denied by user');
    }

    const boundary = checkToolBoundary(call, context.cwd);
    if (boundary) return record('deny', boundary.layer, boundary.reason);
    const hook = await cancellable(checkHooksAllow('pre-tool', { tool: call.name, toolArgs: call.arguments }), context.signal);
    throwIfCancelled(context.signal);
    if (!hook.allowed) return record('deny', 'hook', `Blocked by hook: ${hook.reason || 'no reason given'}`);
    if (isPolicyEnabled()) {
      const policy = await cancellable(evaluatePolicy(call), context.signal);
      throwIfCancelled(context.signal);
      if (policy.decision === 'deny') return record('deny', 'policy', `Policy denied: ${policy.reason || 'no reason given'}`);
      return record('allow', 'policy', policy.reason || 'Policy allowed execution');
    }
    return record('allow', 'default', 'All applicable checks passed');
  } catch (error) {
    if (context.signal?.aborted || isCancellation(error)) {
      record('cancelled', 'cancellation', 'Operation cancelled');
      throw error;
    }
    return record('deny', 'resolver', `Permission check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
