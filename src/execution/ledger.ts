/** Reservations are charged before dispatch; unknown outcomes never restore capacity. */
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalPath, digest } from '../approvals/index.js';
import { cancellableDelay, throwIfCancelled } from '../cancellation.js';
import { accountLineage, checkExecutionIdentity, hex, identifier, integer, invalid, manifestHash, shape, uuid, validateExecutionManifest } from './authority.js';
import { ExecutionLimitError, type ExecutionManifest, type RequestReservation, type RequestSettlement, type ReservationEvent, type ReservationProjection,type ChildGrant } from './types.js';
import {validateChildGrant,applyChildGrant,assertChildCapacity,effectiveExecutionManifest} from './child-grants.js';
import {recoverDeadWriterLock} from './writer-recovery.js';

export const MAX_RESERVATION_EVENTS = 10000, MAX_RESERVATION_BYTES = 16 * 1024 * 1024;
const unavailable = () => new ExecutionLimitError('unavailable','Execution budget history is unavailable or damaged; preserve it and restore a verified backup. No request was authorized.');
export function requestCostNanos(input: number, output: number, inputPrice: number, outputPrice: number): number {
  integer(input,0,100000000); integer(output,0,100000000);
  for (const price of [inputPrice,outputPrice]) if (!Number.isFinite(price) || price < 0 || price > 1000000) invalid();
  // Round each price up to a nano-dollar per token; never round a reservation down.
  const nanos = input * Math.ceil(inputPrice * 1000) + output * Math.ceil(outputPrice * 1000); integer(nanos); return nanos;
}
function reservation(value: unknown): asserts value is RequestReservation {
  shape(value,['id','agentId','provider','model','target','inputTokens','outputTokens','costNanos','inputPrice','outputPrice'],['limits']);
  if (!uuid(value.id) || !hex(value.target)) invalid(); identifier(value.agentId);
  if (typeof value.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.provider) || typeof value.model !== 'string' || !value.model || value.model.length > 256 || /[\x00-\x1f\x7f]/.test(value.model)) invalid();
  integer(value.inputTokens,1,100000000); integer(value.outputTokens,1,100000000); integer(value.costNanos);
  if (value.costNanos !== requestCostNanos(value.inputTokens,value.outputTokens,value.inputPrice as number,value.outputPrice as number)) invalid();
  if(value.limits!==undefined){shape(value.limits,[],['tokens','costNanos']);for(const cap of Object.values(value.limits))integer(cap);}
}
function settlement(value: unknown): asserts value is RequestSettlement {
  shape(value,['requestId','outcome'],['usage']); if (!uuid(value.requestId) || !['success','error','cancelled','invalid-usage'].includes(String(value.outcome))) invalid();
  if (value.usage !== undefined) { shape(value.usage,['inputTokens','outputTokens']); integer(value.usage.inputTokens,0,100000000); integer(value.usage.outputTokens,0,100000000); }
}
function validateEvent(value: unknown): asserts value is ReservationEvent {
  shape(value,['version','id','at','previous','change','hash']); if (![1,2].includes(value.version as number) || !uuid(value.id) || !hex(value.previous) || !hex(value.hash)) invalid(); integer(value.at,1,8640000000000000);
  shape(value.change,['type'],['reservation','settlement','grant']);if(value.version!==(value.change.type==='child_grant'?2:1))invalid();
  if (value.change.type === 'reserve') { shape(value.change,['type','reservation']); reservation(value.change.reservation); }
  else if (value.change.type === 'settle') { shape(value.change,['type','settlement']); settlement(value.change.settlement); }
  else if(value.change.type==='child_grant'){shape(value.change,['type','grant']);validateChildGrant(value.change.grant);}else invalid();
  const {hash,...body} = value; if (hash !== digest(canonicalJson(body))) throw unavailable();
}
/** Pure replay includes unresolved reservations in every ancestor's spend. */
export function replayReservations(input: ExecutionManifest, events: ReservationEvent[]): ReservationProjection {
  const base = validateExecutionManifest(input), initial = manifestHash(base);let manifest=base;
  if (!Array.isArray(events) || events.length > MAX_RESERVATION_EVENTS) throw unavailable();
  const state: ReservationProjection = {version:1,runId:manifest.runId,manifestHash:initial,revision:initial,spent:{tokens:0,costNanos:0},accounts:{},requests:{},exceeded:false};
  for (const account of manifest.accounts) Object.defineProperty(state.accounts,account.id,{value:{tokens:0,costNanos:0},enumerable:true});
  const ids = new Set<string>(); let at = manifest.createdAt;
  const apply = (agentId:string,tokens:number,costNanos:number) => {
    state.spent.tokens += tokens; state.spent.costNanos += costNanos;
    for (const account of accountLineage(manifest,agentId)) { state.accounts[account.id]!.tokens += tokens; state.accounts[account.id]!.costNanos += costNanos; }
    integer(state.spent.tokens); integer(state.spent.costNanos);
  };
  for (const event of events) {
    validateEvent(event); if (ids.has(event.id) || event.previous !== state.revision || event.at < at) throw unavailable(); ids.add(event.id); at = event.at;
    if(event.change.type==='child_grant'){
      manifest=applyChildGrant(base,manifest,state,{grant:event.change.grant,eventId:event.id,eventHash:event.hash,at:event.at});
    }else if (event.change.type === 'reserve') {
      const next = event.change.reservation, lineage = accountLineage(manifest,next.agentId), tokens = next.inputTokens + next.outputTokens;
      if (state.exceeded || Object.hasOwn(state.requests,next.id) || event.at >= manifest.deadline || lineage.some(a => event.at >= a.deadline)) throw new ExecutionLimitError('deadline','Execution cannot admit this request after a deadline or budget violation.');
      if (state.spent.tokens + tokens > manifest.tokenBudget || state.spent.costNanos + next.costNanos > manifest.costBudgetNanos ||
        next.limits?.tokens!==undefined && state.spent.tokens+tokens>next.limits.tokens || next.limits?.costNanos!==undefined && state.spent.costNanos+next.costNanos>next.limits.costNanos ||
        lineage.some(a => state.accounts[a.id]!.tokens + tokens > a.tokenBudget || state.accounts[a.id]!.costNanos + next.costNanos > a.costBudgetNanos))
        throw new ExecutionLimitError('budget','Request reservation exceeds the available agent, ancestor or run budget.');
      if(state.childGrants?.length)assertChildCapacity(manifest,state,next.agentId,tokens,next.costNanos);
      apply(next.agentId,tokens,next.costNanos); state.requests[next.id] = {reservation:structuredClone(next),state:'pending'};
    } else {
      const result = event.change.settlement, entry = state.requests[result.requestId];
      if (!entry || entry.state !== 'pending') throw new ExecutionLimitError('conflict','Request was already settled or was never reserved.');
      if (result.outcome === 'invalid-usage') {entry.state='exceeded';state.exceeded=true;}
      else if (result.outcome !== 'success' || !result.usage) entry.state = 'unknown';
      else {
        const r = entry.reservation, usage = result.usage, cost = requestCostNanos(usage.inputTokens,usage.outputTokens,r.inputPrice,r.outputPrice);
        if (usage.inputTokens > r.inputTokens || usage.outputTokens > r.outputTokens || cost > r.costNanos) {
          entry.state = 'exceeded'; state.exceeded = true;
          apply(r.agentId,Math.max(usage.inputTokens+usage.outputTokens,r.inputTokens+r.outputTokens)-(r.inputTokens+r.outputTokens),Math.max(cost,r.costNanos)-r.costNanos);
        } else { entry.state = 'settled'; apply(r.agentId,usage.inputTokens+usage.outputTokens-r.inputTokens-r.outputTokens,cost-r.costNanos); }
      }
    }
    state.revision = event.hash;
  }
  return state;
}
interface Journal { version:1; manifest:ExecutionManifest; events:ReservationEvent[]; hash:string }
function decode(raw: string): Journal {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw unavailable(); }
  shape(value,['version','manifest','events','hash']); if (value.version !== 1 || !Array.isArray(value.events) || value.events.length > MAX_RESERVATION_EVENTS || !hex(value.hash)) throw unavailable();
  const manifest = validateExecutionManifest(value.manifest), events = value.events as ReservationEvent[];
  for (const event of events) validateEvent(event);
  if (digest(canonicalJson({manifest:manifestHash(manifest),events:events.map(event => event.hash)})) !== value.hash) throw unavailable();
  return {version:1,manifest,events,hash:value.hash};
}
function encode(manifest:ExecutionManifest,events:ReservationEvent[]): string {
  const raw = JSON.stringify({version:1,manifest,events,hash:digest(canonicalJson({manifest:manifestHash(manifest),events:events.map(event=>event.hash)}))});
  if (Buffer.byteLength(raw) > MAX_RESERVATION_BYTES) throw new ExecutionLimitError('limit','Budget history reached its byte limit; existing reservations remain charged.'); return raw;
}
function directory(path: string): fs.Stats {
  const stat = fs.lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || fs.realpathSync(path) !== path) throw unavailable(); return stat;
}
function sameDirectory(path:string,before:fs.Stats): void { const current=directory(path); if(current.dev!==before.dev || current.ino!==before.ino) throw new ExecutionLimitError('conflict','Budget directory changed during the operation.'); }
function read(file:string): string {
  let fd:number; try { fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK); } catch {throw unavailable();}
  try {const stat=fs.fstatSync(fd); if(!stat.isFile() || stat.mode&0o077 || stat.size>MAX_RESERVATION_BYTES)throw unavailable();
    const buffer=Buffer.alloc(stat.size+1);let size=0,n:number;while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;
    if(size!==stat.size)throw unavailable();return buffer.subarray(0,size).toString('utf8');
  }finally{fs.closeSync(fd);}
}
function writeNew(file:string,raw:string):void {const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncDir(path:string):void {const fd=fs.openSync(path,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}

export class ReservationLedger {
  readonly root:string;
  constructor(root:string,private readonly now=Date.now){this.root=resolve(root);}
  /** Explicit creation only. A missing journal inside an existing directory never resets spend. */
  create(input:ExecutionManifest,signal?:AbortSignal):ReservationProjection {
    throwIfCancelled(signal);const manifest=validateExecutionManifest(input);checkExecutionIdentity(manifest,manifest.project.root);
    if(this.now()>=manifest.deadline)throw new ExecutionLimitError('deadline','Run deadline expired.');
    if(canonicalPath(this.root)!==this.root)throw unavailable();
    // The caller owns creation of the private run directory; never create arbitrary ancestors.
    directory(dirname(this.root));
    try{fs.mkdirSync(this.root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const existing=this.read(manifest.project.root);if(existing.projection.manifestHash!==manifestHash(manifest))throw new ExecutionLimitError('conflict','Budget history belongs to another execution contract.');return existing.projection;}
    const before=directory(this.root);throwIfCancelled(signal);writeNew(join(this.root,'history.json'),encode(manifest,[]));sameDirectory(this.root,before);syncDir(this.root);syncDir(dirname(this.root));
    return replayReservations(manifest,[]);
  }
  read(cwd:string):{manifest:ExecutionManifest;events:ReservationEvent[];projection:ReservationProjection} {
    directory(this.root);const journal=decode(read(join(this.root,'history.json')));checkExecutionIdentity(journal.manifest,cwd);
    return {...journal,projection:replayReservations(journal.manifest,journal.events)};
  }
  async reserve(cwd:string,expectedManifest:string,value:RequestReservation,signal?:AbortSignal):Promise<ReservationProjection> {
    reservation(value);return this.append(cwd,expectedManifest,{type:'reserve',reservation:structuredClone(value)},signal);
  }
  async grantChildren(cwd:string,expectedManifest:string,grant:ChildGrant,signal?:AbortSignal,beforeCommit?:()=>void):Promise<ReservationProjection> {
    validateChildGrant(grant);return this.append(cwd,expectedManifest,{type:'child_grant',grant:structuredClone(grant)},signal,beforeCommit);
  }
  /** Settlement is allowed after cancellation/deadline so known spend can still be recorded. */
  async settle(cwd:string,expectedManifest:string,value:RequestSettlement):Promise<ReservationProjection> {
    settlement(value);return this.append(cwd,expectedManifest,{type:'settle',settlement:structuredClone(value)});
  }
  private async append(cwd:string,expectedManifest:string,change:ReservationEvent['change'],signal?:AbortSignal,beforeCommit?:()=>void):Promise<ReservationProjection> {
    throwIfCancelled(signal);const before=directory(this.root),file=join(this.root,'history.json'),lock=join(this.root,'writer.lock');let fd:number|undefined;
    for(let attempt=0;attempt<=50;attempt++){
      throwIfCancelled(signal);sameDirectory(this.root,before);
      try{fd=fs.openSync(lock,'wx',0o600);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw unavailable();recoverDeadWriterLock(lock);if(attempt===50)throw new ExecutionLimitError('locked','Budget writer is busy; no request was authorized.');await cancellableDelay(10,signal);}
    }
    const identity=fs.fstatSync(fd!);let temp:string|undefined;
    try{
      fs.writeFileSync(fd!,String(process.pid));await new Promise<void>(resolve=>setImmediate(resolve));throwIfCancelled(signal);sameDirectory(this.root,before);
      const raw=read(file),journal=decode(raw),current=replayReservations(journal.manifest,journal.events);checkExecutionIdentity(journal.manifest,cwd);
      if(current.manifestHash!==expectedManifest)throw new ExecutionLimitError('conflict','Execution contract changed; request denied.');
      if(change.type==='child_grant'){const prior=current.childGrants?.find(r=>r.grant.id===change.grant.id);if(prior){if(canonicalJson(prior.grant)!==canonicalJson(change.grant))throw new ExecutionLimitError('conflict','Child grant identity already belongs to another proposal.');beforeCommit?.();throwIfCancelled(signal);return current;}}
      // Leave enough room to settle every pending reservation.
      const pending=Object.values(current.requests).filter(r=>r.state==='pending').length;
      if(journal.events.length+(change.type!=='settle'?pending+2:1)>MAX_RESERVATION_EVENTS)throw new ExecutionLimitError('limit','Budget history reached its event limit; pending reservations remain charged.');
      const body={version:change.type==='child_grant'?2 as const:1 as const,id:randomUUID(),at:Math.max(this.now(),journal.events.at(-1)?.at??journal.manifest.createdAt),previous:current.revision,change};
      const event={...body,hash:digest(canonicalJson(body))},events=[...journal.events,event],next=replayReservations(journal.manifest,events),output=encode(journal.manifest,events);
      temp=join(this.root,`${randomUUID()}.tmp`);writeNew(temp,output);throwIfCancelled(signal);sameDirectory(this.root,before);checkExecutionIdentity(journal.manifest,cwd);
      const effective=effectiveExecutionManifest(journal.manifest,next);
      if(change.type==='reserve'&&this.now()>=Math.min(effective.deadline,...accountLineage(effective,change.reservation.agentId).map(a=>a.deadline))||change.type==='child_grant'&&change.grant.accounts.some(a=>this.now()>=a.deadline))throw new ExecutionLimitError('deadline','Agent deadline expired before reservation or grant commit.');
      if(read(file)!==raw)throw new ExecutionLimitError('conflict','Budget history changed before commit.');beforeCommit?.();throwIfCancelled(signal);fs.renameSync(temp,file);temp=undefined;syncDir(this.root);return next;
    }finally{
      fs.closeSync(fd!);try{sameDirectory(this.root,before);if(temp)fs.unlinkSync(temp);const current=fs.lstatSync(lock);if(current.ino===identity.ino&&current.dev===identity.dev)fs.unlinkSync(lock);}catch{/* Preserve foreign directories and locks. */}
    }
  }
}
