/** Canonical permission resolution for terminal, headless and editor clients. */
import { describeApproval, type ApprovalChoice, type ApprovalStore } from '../approvals/index.js';
import type { Mode, ToolCall } from '../types.js';
import { redactSecrets, type PolicyEventPayload } from '../runlog.js';
import { assessToolRisk, requiresConfirmation } from '../risk.js';
import { checkHooksAllow } from '../hooks.js';
import { evaluatePolicy, isPolicyEnabled } from '../policy.js';
import { checkToolBoundary } from '../tools.js';
import { cancellable, isCancellation, throwIfCancelled } from '../cancellation.js';
import { permissionReason, type PermissionDecision, type PermissionLayer } from './types.js';

const PLAN_TOOLS = new Set(['think', 'ask_question', 'create_plan', 'read_file', 'list_files', 'brain_search', 'brain_entity']);
export const MUTATING_TOOLS = new Set(['shell', 'write_file', 'edit_file', 'git', 'execute_code', 'configure', 'session_branch', 'session_import', 'orchestration_prepare', 'orchestration_approve', 'orchestration_cancel', 'orchestration_budget']);
for(const tool of ['orchestration_execute','orchestration_retry','orchestration_accept','orchestration_agent_stop','orchestration_spawn'])MUTATING_TOOLS.add(tool);
for(const tool of ['orchestration_goal_plan','orchestration_goal_approve','orchestration_goal_resume','orchestration_goal_cancel','orchestration_goal_revise'])MUTATING_TOOLS.add(tool);
for(const tool of ['orchestration_workspace','orchestration_improve','orchestration_improvement_rollback','orchestration_evidence_recovery'])MUTATING_TOOLS.add(tool);

for(const tool of ['brain_init','brain_write','brain_reverse','brain_reindex'])MUTATING_TOOLS.add(tool);

export interface PermissionContext {
  cwd: string;
  mode?: Mode;
  /** Explicit client defaults: terminal risk toggle, headless none, ACP mutations. */
  confirmation: 'none' | 'risk' | 'mutating' | 'interactive';
  sessionId?: string;
  approvals?: ApprovalStore;
  signal?: AbortSignal;
  /** A coordinator's immutable authority can only narrow project policy. */
  authority?: (call:ToolCall,cwd:string)=>string|undefined;
  approve?: (decision: PermissionDecision) => Promise<ApprovalChoice>;
  audit?: (event: PolicyEventPayload) => void;
}

export async function resolvePermission(call: ToolCall, context: PermissionContext): Promise<PermissionDecision> {
  const started = Date.now(), initialSessionId = context.sessionId;
  const record = (decision: PermissionDecision['decision'], layer: PermissionLayer, detail: string): PermissionDecision => {
    const result = { decision, layer, reason: permissionReason(layer, String(redactSecrets(detail))), durationMs: Date.now() - started };
    context.audit?.({ tool: call.name, toolCallId: call.id, decision, source: layer, reason: result.reason, durationMs: result.durationMs });
    return result;
  };
  try {
    throwIfCancelled(context.signal);
    if (context.mode === 'plan' && !PLAN_TOOLS.has(call.name)) {
      return record('deny', 'mode', 'Plan mode: Tool not executed. Describe what this would do.');
    }
    let policyAllowed = false, policyReason = '';
    const gates = async (): Promise<PermissionDecision | undefined> => {
      const authority = context.authority?.(call,context.cwd);
      if (authority) return record('deny','scope',authority);
      if (context.mode === 'plan' && !PLAN_TOOLS.has(call.name)) return record('deny', 'mode', 'Plan mode: Tool not executed. Describe what this would do.');
      if (context.sessionId !== initialSessionId) return record('deny', 'confirmation', 'Session changed during approval; retry in the active session.');
      const boundary = checkToolBoundary(call, context.cwd);
      if (boundary) return record('deny', boundary.layer, boundary.reason);
      const hook = await checkHooksAllow('pre-tool', { tool: call.name, toolArgs: call.arguments }, { signal: context.signal });
      throwIfCancelled(context.signal);
      if (!hook.allowed) return record('deny', 'hook', `Blocked by hook: ${hook.reason || 'no reason given'}`);
      policyAllowed = isPolicyEnabled();
      if (policyAllowed) {
        const policy = await evaluatePolicy(call, { signal: context.signal });
        throwIfCancelled(context.signal);
        if (policy.decision === 'deny') return record('deny', 'policy', `Policy denied: ${policy.reason || 'no reason given'}`);
        policyReason = policy.reason || 'Policy allowed execution';
      }
      return undefined;
    };
    const risk = assessToolRisk(call);
    const needsConfirmation = context.confirmation === 'interactive' ? ['medium', 'high', 'critical'].includes(risk.level)
      : context.confirmation === 'risk' ? call.name !== 'think' && requiresConfirmation(risk, false)
      : context.confirmation === 'mutating' && (MUTATING_TOOLS.has(call.name) || risk.requiresConfirmation);
    const denied = await gates(); if (denied) return denied;
    if (needsConfirmation) {
      const request = describeApproval(call, context.cwd);
      const cached = context.approvals?.find(request, context.sessionId);
      let answer: ApprovalChoice = 'allow';
      if (!cached) {
        const pending = record('confirm', 'confirmation', `${risk.level} risk: ${risk.reason}. User confirmation required.`);
        pending.request = structuredClone(request);
        if (!context.approve) return pending;
        answer = await cancellable(context.approve(pending), context.signal);
        throwIfCancelled(context.signal);
        if (answer === 'cancelled') return record('cancelled', 'confirmation', 'Permission request cancelled');
        if (!['allow', 'allow_session', 'allow_project'].includes(answer)) return record('deny', 'confirmation', 'Permission denied by user');
        if (answer !== 'allow' && (!context.approvals || !request.reusable || answer === 'allow_session' && !context.sessionId))
          return record('deny', 'confirmation', 'This operation requires approval once; a reusable grant is unavailable.');
      }
      if (describeApproval(call, context.cwd).key !== request.key) return record('deny', 'confirmation', 'Operation, project or policy changed during approval; retry with the current scope.');
      const deniedAfterWait = await gates(); if (deniedAfterWait) return deniedAfterWait;
      if (describeApproval(call, context.cwd).key !== request.key) return record('deny', 'confirmation', 'Operation, project or policy changed during checks; retry.');
      if (context.sessionId !== initialSessionId) return record('deny', 'confirmation', 'Session changed during checks; retry in the active session.');
      if (cached && context.approvals?.find(request, context.sessionId)?.id !== cached.id)
        return record('deny', 'confirmation', 'Saved approval expired or was revoked; retry for a new decision.');
      const grant = cached ?? (answer === 'allow_session' || answer === 'allow_project'
        ? context.approvals!.grant(request, answer === 'allow_session' ? 'session' : 'project', context.sessionId, context.signal) : undefined);
      context.audit?.({ tool: call.name, toolCallId: call.id, decision: 'allow', source: 'confirmation',
        reason: grant ? `${cached ? 'Reused' : 'Saved'} ${grant.scope} approval ${grant.id}; expires ${new Date(grant.expiresAt).toISOString()}` : 'Approved once by user',
        durationMs: Date.now() - started, operationKey: request.key, ...(grant ? { grantId: grant.id, grantScope: grant.scope, grantExpiresAt: grant.expiresAt } : {}) });
    }
    return record('allow', policyAllowed ? 'policy' : 'default', policyAllowed ? policyReason : 'All applicable checks passed');
  } catch (error) {
    if (context.signal?.aborted || isCancellation(error)) {
      record('cancelled', 'cancellation', 'Operation cancelled');
      throw error;
    }
    return record('deny', 'resolver', `Permission check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
