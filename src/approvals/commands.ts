import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ApprovalStore } from './store.js';
import { projectIdentity } from './request.js';
import { ApprovalError } from './types.js';
import { isCancellation, throwIfCancelled } from '../cancellation.js';
import { RunLog } from '../runlog.js';

export const APPROVAL_USAGE = 'calliope permissions [list | reset | revoke <id>] [--json]';
export async function permissionsCommand(args: string[], options: { cwd?: string; sessionId?: string; store?: ApprovalStore; signal?: AbortSignal } = {}) {
  const base = { version: 1 as const, type: 'permissions' as const, localOnly: true as const };
  const failure = (code: string, message: string, exitCode: number) => ({ report: { ...base, error: { code, message } }, exitCode });
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }));
    if (!(positionals.length === 0 || positionals.length === 1 && ['list', 'reset'].includes(positionals[0]!) || positionals.length === 2 && positionals[0] === 'revoke'))
      return failure('invalid-arguments', APPROVAL_USAGE, 2);
  } catch { return failure('invalid-arguments', APPROVAL_USAGE, 2); }
  try {
    throwIfCancelled(options.signal);
    const action = positionals[0] ?? 'list', { project, projectKey } = projectIdentity(options.cwd ?? process.cwd());
    const store = options.store ?? new ApprovalStore();
    if (action !== 'list') {
      const log = RunLog.open(options.sessionId ?? `permissions_${randomUUID()}`);
      try {
        store.revoke(projectKey, action === 'revoke' ? positionals[1] : undefined, options.signal);
        log.policyEvent({ tool: 'permissions', decision: 'allow', source: 'user', durationMs: 0, reason: `${action} project=${projectKey}${positionals[1] ? ` grant=${positionals[1]}` : ''}` });
      } finally { await log.flush(); }
    }
    return { report: { ...base, action, project, ...store.list(projectKey, options.sessionId) }, exitCode: 0 };
  } catch (error) {
    if (options.signal?.aborted || isCancellation(error)) return failure('cancelled', 'Approval operation cancelled.', 130);
    return failure('records-unavailable', error instanceof ApprovalError ? error.message : 'Approval records unavailable; check the project and local file permissions.', 1);
  }
}
export async function runPermissions(args: string[], options: Parameters<typeof permissionsCommand>[1] & { write?: (text: string) => void } = {}): Promise<number> {
  const { report, exitCode } = await permissionsCommand(args, options);
  const text = args.includes('--json') ? JSON.stringify(report) : 'error' in report ? report.error.message :
    `${report.project}: ${report.grants.length} saved approvals${report.disabled ? ' (reuse disabled: history limit reached)' : ''}\n` +
    report.grants.map(grant => `${grant.id} | ${grant.scope} | ${grant.tool} | expires ${new Date(grant.expiresAt).toISOString()} | fingerprint ${grant.key}`).join('\n');
  (options.write ?? ((text: string) => { process.stdout.write(text); }))(text + '\n');
  return exitCode;
}
