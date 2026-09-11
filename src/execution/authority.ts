import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalJson, canonicalPath, digest, projectIdentity } from '../approvals/index.js';
import type { ToolCall } from '../types.js';
import { ExecutionLimitError, type ExecutionAccount, type ExecutionManifest, type ExecutionPath } from './types.js';

export const MAX_EXECUTION_ACCOUNTS = 256;
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function invalid(): never { throw new ExecutionLimitError('invalid','Invalid execution authority or budget record.'); }
export function shape(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype ||
    required.some(key => !Object.hasOwn(v,key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key) || (v as Record<string,unknown>)[key] === undefined)) invalid();
}
export function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) invalid();
}
export function identifier(v: unknown): asserts v is string { if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v)) invalid(); }
export function pathName(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !v || v.length > 1024 || isAbsolute(v) || /[\\\x00-\x1f\x7f:*?\[\]{}]/.test(v) || v !== '.' && v.split('/').some(p => !p || p === '.' || p === '..')) invalid();
}
export const covers = (parent: string, child: string): boolean => parent === '.' || parent === child || child.startsWith(parent+'/');
export const permits = (grants: ExecutionPath[], path: string, access: 'read' | 'write'): boolean => grants.some(g => covers(g.path,path) && (access === 'read' || g.access === 'write'));
export function validateExecutionManifest(value: unknown): ExecutionManifest {
  shape(value,['version','runId','planHash','project','createdAt','deadline','tokenBudget','costBudgetNanos','accounts']);
  if (value.version !== 1 || !uuid(value.runId) || !hex(value.planHash)) invalid();
  shape(value.project,['root','key']);
  if (typeof value.project.root !== 'string' || value.project.root.length > 4096 || !isAbsolute(value.project.root) || !hex(value.project.key)) invalid();
  integer(value.createdAt,1,8640000000000000); integer(value.deadline,value.createdAt+1,Math.min(8640000000000000,value.createdAt+86400000));
  integer(value.tokenBudget,1,100000000); integer(value.costBudgetNanos,0,1e13);
  if (!Array.isArray(value.accounts) || !value.accounts.length || value.accounts.length > MAX_EXECUTION_ACCOUNTS) invalid();
  const ids = new Set<string>();
  for (const account of value.accounts) {
    shape(account,['id','parentId','tokenBudget','costBudgetNanos','deadline','allowedTools','allowedPaths']); identifier(account.id);
    if (account.parentId !== null) identifier(account.parentId);
    if (ids.has(account.id)) invalid(); ids.add(account.id);
    integer(account.tokenBudget,1,value.tokenBudget); integer(account.costBudgetNanos,0,value.costBudgetNanos); integer(account.deadline,value.createdAt+1,value.deadline);
    if (!Array.isArray(account.allowedTools) || account.allowedTools.length > 256 || new Set(account.allowedTools).size !== account.allowedTools.length || account.allowedTools.some(t => typeof t !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(t))) invalid();
    if (!Array.isArray(account.allowedPaths) || account.allowedPaths.length > 256) invalid(); const paths = new Set<string>();
    for (const grant of account.allowedPaths) { shape(grant,['path','access']); pathName(grant.path); if (!['read','write'].includes(String(grant.access)) || paths.has(grant.path)) invalid(); paths.add(grant.path); }
  }
  const manifest = value as unknown as ExecutionManifest;
  if (manifest.accounts.filter(a => a.parentId === null).length !== 1) invalid();
  for (const account of manifest.accounts) {
    const lineage = accountLineage(manifest,account.id); if (lineage.length > 9) invalid();
    const parent = lineage[1];
    if (parent && (account.tokenBudget > parent.tokenBudget || account.costBudgetNanos > parent.costBudgetNanos || account.deadline > parent.deadline ||
      account.allowedTools.some(t => !parent.allowedTools.includes(t)) || account.allowedPaths.some(g => !permits(parent.allowedPaths,g.path,g.access)))) invalid();
    const children = manifest.accounts.filter(a => a.parentId === account.id);
    if (children.reduce((n,a) => n+a.tokenBudget,0) > account.tokenBudget || children.reduce((n,a) => n+a.costBudgetNanos,0) > account.costBudgetNanos) invalid();
  }
  return JSON.parse(canonicalJson(manifest)) as ExecutionManifest;
}
export const manifestHash = (value: ExecutionManifest): string => digest(canonicalJson(value));
export function accountLineage(manifest: ExecutionManifest, agentId: string): ExecutionAccount[] {
  const lineage: ExecutionAccount[] = [], seen = new Set<string>(); let id: string | null = agentId;
  while (id !== null) {
    if (seen.has(id) || seen.size >= MAX_EXECUTION_ACCOUNTS) invalid(); seen.add(id);
    const account = manifest.accounts.find(a => a.id === id); if (!account) invalid(); lineage.push(account); id = account.parentId;
  }
  return lineage;
}
export function checkExecutionIdentity(manifest: ExecutionManifest, cwd: string): void {
  const current = projectIdentity(cwd);
  if (current.project !== manifest.project.root || current.projectKey !== manifest.project.key) throw new ExecutionLimitError('authority','Execution belongs to a different or replaced project.');
}
/** Shell, network and extensible tools need an enclosing sandbox with these exact grants. */
export function executionToolDenial(manifest: ExecutionManifest, agentId: string, call: ToolCall, cwd: string, now = Date.now()): string | undefined {
  checkExecutionIdentity(manifest,cwd); const account = accountLineage(manifest,agentId)[0]!;
  if (now >= Math.min(manifest.deadline,account.deadline)) return 'Agent deadline expired.';
  if (!account.allowedTools.includes(call.name)) return 'Tool is outside the declared agent authority.';
  if (['think','ask_question','create_plan'].includes(call.name)) return undefined;
  if (!['read_file','write_file','edit_file','list_files'].includes(call.name)) return 'This tool requires containment that enforces the agent path and network grants; execution is unavailable.';
  const arg = call.arguments.path ?? (call.name === 'list_files' ? '.' : undefined);
  if (typeof arg !== 'string' || !arg || arg.length > 4096) return 'Tool requires a bounded path inside the agent scope.';
  const absolute = resolve(cwd,arg), canonical = canonicalPath(absolute), rel = relative(manifest.project.root,canonical) || '.';
  if (canonical !== absolute || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return 'Tool path resolves outside the project or through a symlink alias.';
  const access = call.name === 'write_file' || call.name === 'edit_file' ? 'write' : 'read';
  if (!permits(account.allowedPaths,rel,access)) return `Tool path is outside the agent ${access} scope.`;
  return undefined;
}
