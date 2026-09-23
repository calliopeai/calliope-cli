/** Immutable events plus an atomic commit pointer; uncommitted files remain evidence. */
import * as fs from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalPath, digest, projectIdentity } from '../approvals/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { analyzePlan, bindPlan, MAX_PLAN_BYTES, shape, hex, uuid, iso, integer, pathName, fail, text } from './validation.js';
import { OrchestrationError, type EventLink, type OrchestrationEvent, type PreparedRun, type RunChange, type RunInspection, type RunManifest, type PlanAnalysis } from './types.js';
import {validateGoalLink} from '../goals/validation.js';
import type {BoundRun} from '../goals/types.js';
export const MAX_RUNS = 1000, MAX_RUN_EVENTS = 10000, MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const EVENT_BYTES = 4096;
const unavailable = () => new OrchestrationError('unavailable', 'Run records are unavailable or damaged. Preserve the directory and inspect a known backup.');
const signed = <T extends object>(body: T): T & { hash: string } => ({ ...body, hash: digest(canonicalJson(body)) });
function verify(value: Record<string, unknown>): void { const { hash, ...body } = value; if (!hex(hash) || digest(canonicalJson(body)) !== hash) throw unavailable(); }
function read(file: string, max: number): string | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw unavailable(); }
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > max || stat.mode & 0o077) throw unavailable();
    const buffer = Buffer.alloc(stat.size + 1); let size = 0, n: number;
    while (size < buffer.length && (n = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += n;
    if (size !== stat.size) throw unavailable(); return buffer.subarray(0, size).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function parse(raw: string | null): unknown { try { if (raw === null) throw unavailable(); return JSON.parse(raw); } catch { throw unavailable(); } }
function directory(path: string, create = false): fs.Stats {
  if (create) { if (canonicalPath(path) !== path) throw unavailable(); fs.mkdirSync(path, { recursive: true, mode: 0o700 }); }
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || fs.realpathSync(path) !== path) throw unavailable();
  return stat;
}
function sameDirectory(path: string, before: fs.Stats): void { const now = directory(path); if (now.dev !== before.dev || now.ino !== before.ino) throw new OrchestrationError('conflict', 'Run directory changed during the operation.'); }
function writeNew(file: string, value: unknown): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, canonicalJson(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
// POSIX-only: Windows denies FlushFileBuffers on a directory handle opened via 'r' (#382, #384, #388).
function syncDirectory(path: string): void { if (process.platform === 'win32') return; const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function validateRunManifest(value: unknown): RunManifest {
  shape(value, ['version','id','createdAt','project','plan','planHash','source','hash'],['goal']);
  if (value.version!==1&&value.version!==2 || !uuid(value.id) || !iso(value.createdAt) || !hex(value.planHash)) throw unavailable();
  if(value.version===2)validateGoalLink(value.goal);else if(value.goal!==undefined)throw unavailable();
  shape(value.project, ['root','key']); text(value.project.root,4096); if (typeof value.project.root !== 'string' || !isAbsolute(value.project.root) || !hex(value.project.key)) throw unavailable();
  shape(value.source, ['path','sha256',...(value.version===2?['kind']:[])]); pathName(value.source.path); if (!hex(value.source.sha256)||value.version===2&&value.source.kind!=='goal') throw unavailable();
  const analysis = analyzePlan(value.plan); if (analysis.hash !== value.planHash) throw unavailable(); verify(value);
  return value as unknown as RunManifest;
}
export function validateRunEvent(value: unknown): OrchestrationEvent {
  shape(value, ['version','id','runId','at','sequence','previous','change','hash']);
  if (value.version !== 1 || !uuid(value.id) || !uuid(value.runId) || !iso(value.at)) throw unavailable(); integer(value.sequence, 1, MAX_RUN_EVENTS);
  if (value.previous !== null) { shape(value.previous, ['id','hash']); if (!uuid(value.previous.id) || !hex(value.previous.hash)) throw unavailable(); }
  shape(value.change, ['type'], ['manifestHash','source']);
  if (value.change.type === 'prepared') { shape(value.change, ['type','manifestHash']); if (!hex(value.change.manifestHash)) throw unavailable(); }
  else { shape(value.change, ['type','source']); if (!['approved','cancelled'].includes(String(value.change.type)) || !['cli','repl'].includes(String(value.change.source))) throw unavailable(); }
  verify(value); return value as unknown as OrchestrationEvent;
}
/** A pure projection. Approval records intent; they cannot authorize tools or prove task completion. */
export function replayRun(manifest: RunManifest, events: OrchestrationEvent[]): PreparedRun {
  validateRunManifest(manifest); if (!events.length || events.length > MAX_RUN_EVENTS) throw unavailable();
  let previous: OrchestrationEvent | undefined, status: PreparedRun['status'] = 'prepared', approval: PreparedRun['approval'] = 'pending';
  const seen = new Set<string>();
  for (const event of events) {
    validateRunEvent(event);
    if (event.runId !== manifest.id || seen.has(event.id) || event.sequence !== seen.size + 1 || event.at < (previous?.at ?? manifest.createdAt) ||
      (previous ? event.previous?.id !== previous.id || event.previous?.hash !== previous.hash : event.previous !== null)) throw unavailable();
    if (!previous) { if (event.change.type !== 'prepared' || event.change.manifestHash !== manifest.hash) throw unavailable(); }
    else if (event.change.type === 'approved' && status === 'prepared') { status = 'approved'; approval = 'approved'; }
    else if (event.change.type === 'cancelled' && status !== 'cancelled') { status = 'cancelled'; approval = 'revoked'; }
    else throw new OrchestrationError('conflict', 'Invalid run transition; reload the current revision before requesting another action.');
    seen.add(event.id); previous = event;
  }
  return { version: 1, id: manifest.id, project: { ...manifest.project }, planHash: manifest.planHash, revision: previous!.id,
    status, approval, createdAt: manifest.createdAt, updatedAt: previous!.at, eventCount: events.length, executedTasks: 0 };
}

export class RunStore {
  readonly root: string;
  constructor(root = join(homedir(), '.calliope-cli', 'orchestration'), private readonly now = () => new Date().toISOString()) { this.root = resolve(root); }
  private runDir(id: string): string { if (!uuid(id)) fail('Run IDs must be UUIDs.'); return join(this.root, id); }
  private names(): string[] {
    try { directory(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const names: string[] = []; const handle = fs.opendirSync(this.root);
    try { let entry: fs.Dirent | null; while ((entry = handle.readSync())) {
      if (entry.name === 'create.lock') continue;
      if (!uuid(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw unavailable();
      names.push(entry.name); if (names.length > MAX_RUNS) throw new OrchestrationError('limit', 'Run store exceeds 1,000 directories; preserve and archive completed runs.');
    } } finally { handle.closeSync(); }
    return names.sort();
  }
  private inventory(dir: string): void {
    directory(join(dir, 'events')); let count = 0, bytes = 0;
    const handle = fs.opendirSync(join(dir, 'events'));
    try { let entry: fs.Dirent | null; while ((entry = handle.readSync())) {
      if (!entry.name.endsWith('.json') || !uuid(entry.name.slice(0,-5)) || !entry.isFile() || entry.isSymbolicLink()) throw unavailable();
      const stat = fs.lstatSync(join(dir,'events',entry.name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > EVENT_BYTES || stat.mode & 0o077) throw unavailable();
      bytes += stat.size;
      if (++count > MAX_RUN_EVENTS || bytes > MAX_RUN_EVENT_BYTES) throw new OrchestrationError('limit', 'Run event retention limit reached; preserve the run and prepare a new one.');
    } } finally { handle.closeSync(); }
  }
  async read(id: string, cwd: string, signal?: AbortSignal): Promise<RunInspection> {
    throwIfCancelled(signal); const rootBefore = directory(this.root), dir = this.runDir(id), before = directory(dir); this.inventory(dir);
    const manifest = validateRunManifest(parse(read(join(dir,'manifest.json'), MAX_PLAN_BYTES + 8192)));
    const current = projectIdentity(cwd);
    if (manifest.id !== id || manifest.project.root !== current.project || manifest.project.key !== current.projectKey) throw new OrchestrationError('policy-denied', 'Run belongs to another project identity.');
    const head = parse(read(join(dir,'head.json'), 4096)); shape(head, ['version','runId','manifestHash','event','hash']);
    if (head.version !== 1 || head.runId !== id || head.manifestHash !== manifest.hash) throw unavailable(); verify(head);
    shape(head.event, ['id','hash']); if (!uuid(head.event.id) || !hex(head.event.hash)) throw unavailable();
    let link: EventLink | null = head.event as unknown as EventLink; const events: OrchestrationEvent[] = [], seen = new Set<string>();
    while (link) {
      if (events.length % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      throwIfCancelled(signal); if (seen.has(link.id) || events.length >= MAX_RUN_EVENTS) throw unavailable(); seen.add(link.id);
      const event = validateRunEvent(parse(read(join(dir,'events',`${link.id}.json`), EVENT_BYTES)));
      if (event.id !== link.id || event.hash !== link.hash) throw unavailable(); events.push(event); link = event.previous;
    }
    events.reverse(); sameDirectory(this.root,rootBefore); sameDirectory(dir,before);
    if (projectIdentity(cwd).projectKey !== manifest.project.key) throw new OrchestrationError('policy-denied','Project identity changed during inspection.');
    return { manifest, events, run: replayRun(manifest, events), analysis: analyzePlan(manifest.plan) };
  }
  async list(cwd: string, signal?: AbortSignal): Promise<{ runs: PreparedRun[]; unavailable: number }> {
    throwIfCancelled(signal); const runs: PreparedRun[] = []; let unavailable = 0;
    for (const id of this.names()) { throwIfCancelled(signal); try { runs.push((await this.read(id, cwd, signal)).run); } catch (error) {
      throwIfCancelled(signal); if (error instanceof OrchestrationError && error.code === 'policy-denied') continue; unavailable++;
    } }
    return { runs: runs.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), unavailable };
  }
  async prepare(analysis: PlanAnalysis, cwd: string, source: RunManifest['source'], signal?: AbortSignal,binding?:BoundRun): Promise<RunInspection> {
    throwIfCancelled(signal); analysis = analyzePlan(analysis.plan); const project = bindPlan(analysis, cwd);
    directory(this.root, true); const rootIdentity = directory(this.root), lock = join(this.root,'create.lock');
    let fd: number; try { fd = fs.openSync(lock,'wx',0o600); } catch { throw new OrchestrationError('locked','Another run preparation holds create.lock; retry when it finishes.'); }
    try {
      fs.writeFileSync(fd, String(process.pid));
      if (this.names().length >= MAX_RUNS) throw new OrchestrationError('limit','Run store contains 1,000 directories; archive old runs before preparing more.');
      throwIfCancelled(signal); sameDirectory(this.root, rootIdentity);
      if(binding&&(!uuid(binding.id)||!iso(binding.createdAt)))throw new OrchestrationError('invalid','Invalid bound run identity.');if(binding)validateGoalLink(binding.goal);
      const id = binding?.id??randomUUID(), createdAt = binding?.createdAt??this.now(), dir = this.runDir(id);
      const manifest = signed({ version: binding?2 as const:1 as const, id, createdAt, project, plan: analysis.plan, planHash: analysis.hash, source,...(binding?{goal:binding.goal}:{}) }); validateRunManifest(manifest);
      fs.mkdirSync(dir,{mode:0o700}); fs.mkdirSync(join(dir,'events'),{mode:0o700}); writeNew(join(dir,'manifest.json'),manifest);
      this.commit(dir, manifest, [], { type:'prepared', manifestHash:manifest.hash }, null, signal);
      return await this.read(id,cwd,signal);
    } finally { fs.closeSync(fd); try { sameDirectory(this.root,rootIdentity); fs.unlinkSync(lock); } catch { /* Never clean a replacement root. */ } }
  }
  async transition(id: string, cwd: string, expectedRevision: string, change: Exclude<RunChange, {type:'prepared'}>, signal?: AbortSignal): Promise<RunInspection> {
    throwIfCancelled(signal); directory(this.root); const dir = this.runDir(id), before = directory(dir), lock = join(dir,'writer.lock');
    let fd: number; try { fd = fs.openSync(lock,'wx',0o600); } catch { throw new OrchestrationError('locked','Another writer holds this run; retry after it finishes.'); }
    try {
      fs.writeFileSync(fd,String(process.pid)); const prior = await this.read(id,cwd,signal);
      if (prior.run.revision !== expectedRevision) throw new OrchestrationError('conflict','Run revision changed; inspect current state before repeating approval or cancellation.');
      this.commit(dir, prior.manifest, prior.events, change, read(join(dir,'head.json'),4096),signal);
      return await this.read(id,cwd,signal);
    } finally { fs.closeSync(fd); try { sameDirectory(dir,before); fs.unlinkSync(lock); } catch { /* Preserve foreign locks/directories. */ } }
  }
  private commit(dir: string, manifest: RunManifest, events: OrchestrationEvent[], change: RunChange, priorHead: string | null, signal?: AbortSignal): void {
    throwIfCancelled(signal); const before = directory(dir), rootBefore = directory(this.root), eventsBefore = directory(join(dir,'events')); this.inventory(dir);
    // Include orphaned records in admission. Never adopt or erase them on restart.
    const entries = fs.readdirSync(join(dir,'events')); if (entries.length >= MAX_RUN_EVENTS) throw new OrchestrationError('limit','Run event limit reached; existing history is preserved.');
    const previous = events.at(-1), at = [this.now(), previous?.at ?? manifest.createdAt].sort().at(-1)!;
    const event = signed({ version:1 as const, id:randomUUID(), runId:manifest.id, at, sequence:events.length + 1, previous:previous ? {id:previous.id,hash:previous.hash} : null, change });
    replayRun(manifest,[...events,event]);
    const bytes = entries.reduce((sum,name) => sum + fs.lstatSync(join(dir,'events',name)).size,0) + Buffer.byteLength(canonicalJson(event));
    if (bytes > MAX_RUN_EVENT_BYTES) throw new OrchestrationError('limit','Run event byte limit reached; existing history is preserved.');
    const temp = join(dir,`.head-${randomUUID()}.tmp`);
    try {
      writeNew(join(dir,'events',`${event.id}.json`),event); syncDirectory(join(dir,'events'));
      writeNew(temp,signed({version:1,runId:manifest.id,manifestHash:manifest.hash,event:{id:event.id,hash:event.hash}}));
      throwIfCancelled(signal); sameDirectory(this.root,rootBefore); sameDirectory(dir,before); sameDirectory(join(dir,'events'),eventsBefore);
      if (read(join(dir,'head.json'),4096) !== priorHead) throw new OrchestrationError('conflict','Run commit pointer changed; reload before retrying.');
      const current = projectIdentity(manifest.project.root); if (current.projectKey !== manifest.project.key) throw new OrchestrationError('conflict','Project identity changed before commit.');
      fs.renameSync(temp,join(dir,'head.json')); syncDirectory(dir);
    } finally { try { sameDirectory(dir,before); fs.unlinkSync(temp); } catch { /* Already committed, or a replacement directory must be preserved. */ } }
  }
}
