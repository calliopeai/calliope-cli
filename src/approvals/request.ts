import * as fs from 'node:fs';
import { dirname, basename, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import * as config from '../config.js';
import { loadHooks } from '../hooks.js';
import { scopeManager } from '../scope.js';
import { checkTrust } from '../trust.js';
import { assessToolRisk } from '../risk.js';
import { redactSecrets } from '../runlog.js';
import type { ToolCall } from '../types.js';
import { ApprovalError, type ApprovalRequest } from './types.js';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
/** Stable keys without storing raw tool arguments. Reject lossy/unbounded input. */
export function canonicalJson(value: unknown): string {
  let nodes = 0, bytes = 0;
  const visit = (input: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 32) throw new ApprovalError('operation exceeds validation limits.');
    if (typeof input === 'string') { bytes += Buffer.byteLength(input); if (bytes > 16 * 1024 * 1024) throw new ApprovalError('operation exceeds 16 MiB.'); return input; }
    if (input === null || typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new ApprovalError('operation must contain plain JSON values.');
    return Object.fromEntries(Object.keys(input).sort().filter(key => (input as Record<string, unknown>)[key] !== undefined)
      .map(key => [visit(key, depth + 1), visit((input as Record<string, unknown>)[key], depth + 1)]));
  };
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new ApprovalError('operation exceeds 16 MiB.');
  return json;
}

export function canonicalPath(path: string): string {
  if (!path || path.includes('\0')) throw new ApprovalError('invalid operation path.');
  let current = resolve(path); const suffix: string[] = [];
  for (let count = 0; count < 256; count++) {
    try { fs.lstatSync(current); return join(fs.realpathSync(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ApprovalError('operation path cannot be resolved.');
      // Do not reinterpret a dangling symlink as a new file.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new ApprovalError('operation path is a dangling symlink.'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      const parent = dirname(current); if (parent === current) break;
      suffix.unshift(basename(current)); current = parent;
    }
  }
  throw new ApprovalError('operation path exceeds resolution limits.');
}

export function projectIdentity(cwd: string): { project: string; projectKey: string } {
  const project = fs.realpathSync(cwd), stat = fs.statSync(project);
  if (!stat.isDirectory()) throw new ApprovalError('project is not a directory.');
  return { project, projectKey: digest(canonicalJson({ project, device: stat.dev, inode: stat.ino })) };
}
export const approvalDisplayText = (value: string) => String(redactSecrets(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function describeApproval(call: ToolCall, cwd: string): ApprovalRequest {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(call.name)) throw new ApprovalError('invalid tool name.');
  const { project, projectKey } = projectIdentity(cwd), risk = assessToolRisk(call);
  const args = canonicalJson(call.arguments);
  const path = typeof call.arguments.path === 'string' ? canonicalPath(resolve(project, call.arguments.path)) : undefined;
  const target = path ? relative(project, path) : undefined;
  // General code, shell and plugin tools can merge/publish/send indirectly.
  // Their authority cannot be narrowed to a stable file mutation, so never cache it.
  const reusable = ['read_file', 'list_files', 'write_file', 'edit_file'].includes(call.name) && !!path &&
    target !== '..' && !target?.startsWith(`..${sep}`) && !isAbsolute(target!) && risk.level !== 'critical';
  const policy = { policy: config.get('policy') ?? null, sandbox: config.get('sandboxMode') ?? null,
    scope: scopeManager.snapshot(), hooks: loadHooks(), trust: checkTrust(project) };
  const details = [`Project: ${approvalDisplayText(project)}`];
  if (path) details.push(`Path: ${approvalDisplayText(path)}`);
  if (typeof call.arguments.command === 'string') details.push(`Command: ${approvalDisplayText(call.arguments.command)}`);
  if (typeof call.arguments.operation === 'string') details.push(`Operation: ${approvalDisplayText(call.arguments.operation)}`);
  if (typeof call.arguments.content === 'string') details.push(`Content: ${Buffer.byteLength(call.arguments.content)} bytes; SHA-256 ${digest(call.arguments.content)}`);
  details.push(`Arguments: SHA-256 ${digest(args)} (${Buffer.byteLength(args)} bytes)`);
  return { version: 1, ...{ project, projectKey }, key: digest(canonicalJson({ projectKey, tool: call.name, args, path: path ?? null, policy })),
    tool: call.name, risk: risk.level, reason: approvalDisplayText(risk.reason), details, reusable };
}
