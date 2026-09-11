import { randomUUID } from 'node:crypto';
import { withScope } from '../scope.js';
import { resolvePermission, type PermissionContext } from '../runtime/permissions.js';
import { RunLog } from '../runlog.js';
import { throwIfCancelled } from '../cancellation.js';

export type SessionActionOptions = Pick<PermissionContext, 'signal' | 'approve' | 'mode'> & {
  confirmation?: PermissionContext['confirmation']; runlog?: RunLog;
};
export class SessionPolicyError extends Error { constructor() { super('Session operation denied by policy; inspect its audit record before retrying.'); this.name = 'SessionPolicyError'; } }

/** Operation arguments contain scope and digests, never conversation or tool content. */
export async function authorizeSessionAction(cwd: string, name: string, args: Record<string, unknown>, options: SessionActionOptions = {}): Promise<void> {
  throwIfCancelled(options.signal);
  const log = options.runlog ?? RunLog.open(`session_action_${randomUUID()}`);
  const id = randomUUID();
  log.toolCall({ id, name, args });
  try {
    const decision = await withScope(cwd, () => resolvePermission({ id, name, arguments: args }, {
      cwd, signal: options.signal, mode: options.mode, confirmation: options.confirmation ?? 'none', approve: options.approve,
      audit: event => log.policyEvent(event),
    }));
    if (decision.decision !== 'allow') throw new SessionPolicyError();
    throwIfCancelled(options.signal);
    log.toolResult({ id, result: 'Permission allowed; operation not yet committed.', isError: false, durationMs: 0 });
  } catch (error) {
    log.toolResult({ id, result: 'Session permission denied or cancelled.', isError: true, durationMs: 0 });
    throw error;
  } finally { await log.flush(); }
}
