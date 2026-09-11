/** Local approval grants. History is append-only logically, with atomic file replacement. */
import * as fs from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from '../cancellation.js';
import { digest, canonicalJson } from './request.js';
import { ApprovalError, type ApprovalGrant, type ApprovalRequest } from './types.js';

export const MAX_APPROVAL_EVENTS = 5000;
export const MAX_APPROVAL_BYTES = 4 * 1024 * 1024;
export const SESSION_GRANT_TTL = 24 * 60 * 60 * 1000;
export const PROJECT_GRANT_TTL = 30 * SESSION_GRANT_TTL;
type Change = { type: 'grant'; grant: ApprovalGrant } | { type: 'revoke'; projectKey: string; grantId: string } | { type: 'reset'; projectKey: string };
interface GrantEvent { version: 1; id: string; at: number; previous: string | null; change: Change; hash: string }
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 8640000000000000;
const damaged = () => new ApprovalError('invalid or damaged history; saved grants are disabled. Preserve it and inspect with /permissions.');
function validGrant(value: unknown): value is ApprovalGrant {
  if (!obj(value)) return false;
  return Object.keys(value).sort().join() === 'createdAt,expiresAt,id,key,projectKey,scope,tool,version' && value.version === 1 && uuid(value.id) &&
    hex(value.projectKey) && hex(value.key) && typeof value.tool === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value.tool) && value.scope === 'project' &&
    timestamp(value.createdAt) && timestamp(value.expiresAt) &&
    Number(value.expiresAt) > Number(value.createdAt) && Number(value.expiresAt) - Number(value.createdAt) <= PROJECT_GRANT_TTL;
}
function read(file: string): string | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw damaged(); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_APPROVAL_BYTES || stat.mode & 0o022) throw damaged();
    const buffer = Buffer.alloc(stat.size + 1); let count = 0, n: number;
    while (count < buffer.length && (n = fs.readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += n;
    if (count !== stat.size) throw damaged();
    return buffer.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function parse(raw: string | null): GrantEvent[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!obj(value) || Object.keys(value).sort().join() !== 'events,version' || value.version !== 1 || !Array.isArray(value.events) || value.events.length > MAX_APPROVAL_EVENTS) throw damaged();
    let previous: string | null = null; const ids = new Set<string>();
    for (const item of value.events) {
      if (!obj(item) || Object.keys(item).sort().join() !== 'at,change,hash,id,previous,version' || item.version !== 1 || !uuid(item.id) || ids.has(String(item.id)) ||
        !timestamp(item.at) || item.previous !== previous || !obj(item.change)) throw damaged();
      const change = item.change;
      if (change.type === 'grant') {
        if (Object.keys(change).sort().join() !== 'grant,type' || !validGrant(change.grant) || change.grant.id !== item.id || change.grant.createdAt !== item.at) throw damaged();
      } else if (change.type === 'revoke') {
        if (Object.keys(change).sort().join() !== 'grantId,projectKey,type' || !hex(change.projectKey) || !uuid(change.grantId)) throw damaged();
      } else if (change.type === 'reset') {
        if (Object.keys(change).sort().join() !== 'projectKey,type' || !hex(change.projectKey)) throw damaged();
      } else throw damaged();
      const { hash, ...body } = item;
      if (digest(canonicalJson(body)) !== hash) throw damaged();
      previous = String(hash); ids.add(String(item.id));
    }
    return value.events as GrantEvent[];
  } catch { throw damaged(); }
}

export class ApprovalStore {
  private session = new Map<string, ApprovalGrant>();
  readonly dir: string;
  constructor(dir = join(homedir(), '.calliope-cli', 'approvals'), private readonly now = () => Date.now()) { this.dir = resolve(dir); }
  private directory(create = false): void {
    if (create) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.dir)) {
      try { fs.lstatSync(this.dir); throw damaged(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    }
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022 || fs.realpathSync(this.dir) !== join(fs.realpathSync(dirname(this.dir)), basename(this.dir))) throw damaged();
  }
  private history(): GrantEvent[] { this.directory(); return parse(read(join(this.dir, 'history.json'))); }
  private append(change: Change, signal?: AbortSignal): void {
    throwIfCancelled(signal); this.directory(true);
    const identity = fs.statSync(this.dir), file = join(this.dir, 'history.json'), lock = file + '.lock', temp = join(this.dir, `${randomUUID()}.tmp`);
    let fd: number;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw new ApprovalError('another writer holds history.json.lock; retry after it finishes.'); }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: this.now() }));
      const raw = read(file), events = parse(raw);
      // Reserve one final record for revocation. At the hard limit all reuse is disabled.
      if (events.length >= MAX_APPROVAL_EVENTS - (change.type === 'grant' ? 1 : 0)) throw new ApprovalError('history limit reached; saved approvals are disabled. Preserve the history before archiving it.');
      const body = { version: 1 as const, id: change.type === 'grant' ? change.grant.id : randomUUID(), at: change.type === 'grant' ? change.grant.createdAt : this.now(), previous: events.at(-1)?.hash ?? null, change };
      const text = JSON.stringify({ version: 1, events: [...events, { ...body, hash: digest(canonicalJson(body)) }] });
      if (Buffer.byteLength(text) > MAX_APPROVAL_BYTES) throw new ApprovalError('history exceeds 4 MiB; preserve it before archiving.');
      const output = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(output, text); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      throwIfCancelled(signal); this.directory();
      const current = fs.statSync(this.dir);
      if (current.ino !== identity.ino || current.dev !== identity.dev || read(file) !== raw) throw new ApprovalError('history changed during save; reload and retry.');
      fs.renameSync(temp, file);
    } finally {
      fs.closeSync(fd);
      try {
        const current = fs.lstatSync(this.dir);
        if (!current.isSymbolicLink() && current.ino === identity.ino && current.dev === identity.dev) {
          try { fs.unlinkSync(temp); } catch { /* Own file may be committed. */ }
          fs.unlinkSync(lock);
        }
      } catch { /* Never clean another directory. */ }
    }
  }
  list(projectKey: string, sessionId?: string): { grants: ApprovalGrant[]; events: number; disabled: boolean } {
    const events = this.history(), active = new Map<string, ApprovalGrant>();
    for (const { change } of events) {
      if (change.type === 'grant') active.set(change.grant.id, change.grant);
      else if (change.type === 'revoke') { if (active.get(change.grantId)?.projectKey === change.projectKey) active.delete(change.grantId); }
      else for (const [id, grant] of active) if (grant.projectKey === change.projectKey) active.delete(id);
    }
    const now = this.now();
    for (const [id, grant] of this.session) if (grant.expiresAt <= now) this.session.delete(id);
    const grants = [...active.values(), ...this.session.values()].filter(grant => grant.projectKey === projectKey && grant.expiresAt > now && grant.createdAt <= now &&
      (grant.scope === 'project' || grant.sessionId === sessionId));
    return { grants: structuredClone(grants), events: events.length, disabled: events.length >= MAX_APPROVAL_EVENTS - 1 };
  }
  find(request: ApprovalRequest, sessionId?: string): ApprovalGrant | undefined {
    if (!request.reusable) return undefined;
    const view = this.list(request.projectKey, sessionId);
    return view.disabled ? undefined : view.grants.find(grant => grant.key === request.key);
  }
  grant(request: ApprovalRequest, scope: 'session' | 'project', sessionId?: string, signal?: AbortSignal): ApprovalGrant {
    throwIfCancelled(signal);
    if (!request.reusable || !hex(request.key) || !hex(request.projectKey) || scope === 'session' && !sessionId) throw new ApprovalError('operation cannot receive a reusable grant.');
    const at = this.now();
    const grant: ApprovalGrant = { version: 1, id: randomUUID(), key: request.key, projectKey: request.projectKey, tool: request.tool, scope,
      ...(scope === 'session' ? { sessionId } : {}), createdAt: at, expiresAt: at + (scope === 'session' ? SESSION_GRANT_TTL : PROJECT_GRANT_TTL) };
    if (scope === 'project') this.append({ type: 'grant', grant }, signal);
    else {
      if (this.list(request.projectKey, sessionId).disabled) throw new ApprovalError('history limit reached; saved approvals are disabled. Preserve the history before archiving it.');
      if (this.session.size >= 1000) throw new ApprovalError('session grant limit reached; reset approvals before adding more.');
      this.session.set(grant.id, structuredClone(grant));
    }
    return grant;
  }
  revoke(projectKey: string, id?: string, signal?: AbortSignal): void {
    throwIfCancelled(signal);
    if (!hex(projectKey) || id !== undefined && !uuid(id)) throw new ApprovalError('invalid grant selector.');
    this.append(id ? { type: 'revoke', projectKey, grantId: id } : { type: 'reset', projectKey }, signal);
    for (const [key, grant] of this.session) if (grant.projectKey === projectKey && (!id || grant.id === id)) this.session.delete(key);
  }
  clearSession(sessionId: string): void { for (const [id, grant] of this.session) if (grant.sessionId === sessionId) this.session.delete(id); }
}
