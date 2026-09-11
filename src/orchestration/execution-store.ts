import * as fs from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,canonicalPath,digest,projectIdentity} from '../approvals/index.js';
import {throwIfCancelled,cancellableDelay} from '../cancellation.js';
import {ExecutionLimitError} from '../execution/types.js';
import {OrchestrationError,type RunManifest} from './types.js';
import {validateRunManifest} from './store.js';
import {hex,integer,iso,shape,uuid} from './validation.js';
import {journalHash,replayExecution,validateExecutionHeader,MAX_EXECUTION_BYTES,MAX_EXECUTION_EVENTS,MAX_EXECUTION_EVENT_BYTES} from './execution-journal.js';
import type {ExecutionChange,ExecutionEvent,ExecutionHeader,ExecutionInspection,ExecutionJournal,ExecutionLease} from './coordinator-types.js';

const unavailable=()=>new OrchestrationError('unavailable','Execution records are damaged or unavailable. Preserve the run and restore verified evidence; no new work is authorized.');
export function privateDirectory(path:string):fs.Stats {
  const stat=fs.lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077||canonicalPath(path)!==path)throw unavailable();return stat;
}
export function readArtifactBytes(file:string,max=1024*1024,privateFile=false):Buffer {
  if(canonicalPath(file)!==file)throw unavailable();const parent=fs.statSync(dirname(file));
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>max||privateFile&&stat.mode&0o077)throw unavailable();
    const bytes=Buffer.alloc(stat.size+1);let count=0,n:number;while(count<bytes.length&&(n=fs.readSync(fd,bytes,count,bytes.length-count,null))>0)count+=n;
    const after=fs.statSync(dirname(file)),current=fs.lstatSync(file),final=fs.fstatSync(fd);if(count!==stat.size||current.dev!==stat.dev||current.ino!==stat.ino||final.size!==stat.size||final.mtimeMs!==stat.mtimeMs||final.ctimeMs!==stat.ctimeMs||parent.dev!==after.dev||parent.ino!==after.ino||canonicalPath(file)!==file)throw unavailable();return bytes.subarray(0,count);
  }finally{fs.closeSync(fd);}
}
function writeNew(file:string,data:string|Buffer):void{const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function syncDir(path:string):void{const fd=fs.openSync(path,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function parsed(file:string,max=MAX_EXECUTION_BYTES):unknown {try{return JSON.parse(readArtifactBytes(file,max,true).toString());}catch{throw unavailable();}}
function exists(file:string):boolean{try{fs.lstatSync(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw unavailable();}}

/** One coordinator process owns a run; short append locks also serialize control commands. */
export class ExecutionStore {
  readonly root:string;readonly manifest:RunManifest;
  constructor(runDirectory:string,manifest:RunManifest,private readonly onEvent?:(event:ExecutionEvent)=>void){this.root=join(resolve(runDirectory),'execution');this.manifest=JSON.parse(canonicalJson(validateRunManifest(manifest)));}
  exists():boolean{return exists(this.root);}
  private identity():fs.Stats {
    if(projectIdentity(this.manifest.project.root).projectKey!==this.manifest.project.key)throw new ExecutionLimitError('authority','Project identity changed during coordinator execution.');
    privateDirectory(dirname(this.root));return privateDirectory(this.root);
  }
  assertApproval(header:ExecutionHeader):void {
    const head=parsed(join(dirname(this.root),'head.json'),4096);shape(head,['version','runId','manifestHash','event','hash']);shape(head.event,['id','hash']);const {hash,...body}=head;
    if(hash!==digest(canonicalJson(body))||head.runId!==this.manifest.id||head.manifestHash!==this.manifest.hash||head.event.id!==header.approvalRevision)
      throw new ExecutionLimitError('authority','Run approval was revoked or changed; coordinator execution stopped.');
  }
  create(header:ExecutionHeader,signal?:AbortSignal):ExecutionInspection {
    throwIfCancelled(signal);validateExecutionHeader(header,this.manifest);privateDirectory(dirname(this.root));if(canonicalPath(this.root)!==this.root)throw unavailable();this.assertApproval(header);
    if(this.exists()){const saved=this.read();if(canonicalJson(saved.header)!==canonicalJson(header))throw new OrchestrationError('conflict','Execution belongs to another approval or deadline.');return saved;}
    try{fs.mkdirSync(this.root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST'){const saved=this.read();if(canonicalJson(saved.header)!==canonicalJson(header))throw new OrchestrationError('conflict','Execution belongs to another approval or deadline.');return saved;}throw error;}
    fs.mkdirSync(join(this.root,'artifacts'),{mode:0o700});throwIfCancelled(signal);
    const journal:ExecutionJournal={version:1,header,events:[],hash:journalHash(header,[])};writeNew(join(this.root,'history.json'),JSON.stringify(journal));syncDir(this.root);syncDir(dirname(this.root));return this.read();
  }
  read():ExecutionInspection {
    this.identity();const value=parsed(join(this.root,'history.json'));shape(value,['version','header','events','hash']);if(value.version!==1||!Array.isArray(value.events)||!hex(value.hash))throw unavailable();
    const header=validateExecutionHeader(value.header,this.manifest),events=value.events as ExecutionEvent[];
    if(value.hash!==journalHash(header,events))throw unavailable();return{header,events,state:replayExecution(header,this.manifest,events)};
  }
  owner():{id:string;pid:number;alive:boolean}|null {
    this.identity();const file=join(this.root,'owner.json');if(!exists(file))return null;const value=parsed(file,4096);shape(value,['version','id','pid','createdAt']);if(value.version!==1||!uuid(value.id)||!iso(value.createdAt))throw unavailable();integer(value.pid,1,2147483647);
    let alive=true;try{process.kill(value.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else if((error as NodeJS.ErrnoException).code!=='EPERM')throw unavailable();}
    return{id:value.id,pid:value.pid,alive};
  }
  acquire():ExecutionLease {
    const election=join(this.root,'owner.lock');this.identity();let lock:number;
    try{lock=fs.openSync(election,'wx',0o600);}catch{throw new OrchestrationError('locked','Coordinator ownership is being changed. Preserve stale locks until their owner is confirmed stopped.');}
    const lockIdentity=fs.fstatSync(lock);
    try{fs.writeFileSync(lock,String(process.pid));return this.acquireExclusive();}
    finally{fs.closeSync(lock);const stat=fs.lstatSync(election);if(stat.dev===lockIdentity.dev&&stat.ino===lockIdentity.ino)fs.unlinkSync(election);}
  }
  private acquireExclusive():ExecutionLease {
    const before=this.identity(),file=join(this.root,'owner.json'),prior=this.owner();
    if(prior?.alive)throw new OrchestrationError('locked','A coordinator process already owns this run.');
    // Reclaim only a confirmed dead process; an expired timer alone is not evidence of death.
    if(prior){const current=this.owner();if(current?.id!==prior.id||current.alive)throw new OrchestrationError('locked','Coordinator ownership changed.');fs.unlinkSync(file);}
    const id=randomUUID();try{writeNew(file,JSON.stringify({version:1,id,pid:process.pid,createdAt:new Date().toISOString()}));}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new OrchestrationError('locked','Another coordinator acquired this run.');throw error;}syncDir(this.root);
    const check=()=>{const after=this.identity(),owner=this.owner();if(before.dev!==after.dev||before.ino!==after.ino||owner?.id!==id||owner.pid!==process.pid)throw new ExecutionLimitError('authority','Coordinator ownership changed; no work is authorized.');};
    return{id,check,release:()=>{check();fs.unlinkSync(file);syncDir(this.root);}};
  }
  async append(change:ExecutionChange,signal?:AbortSignal,eventId=randomUUID(),beforeCommit?:()=>void):Promise<ExecutionEvent> {
    return(await this.appendBatch([{change,eventId}],signal,beforeCommit))[0]!;
  }
  /** A control decision applies all selected resets or none; individual immutable events remain replayable. */
  async appendBatch(changes:{change:ExecutionChange;eventId?:string}[],signal?:AbortSignal,beforeCommit?:()=>void):Promise<ExecutionEvent[]> {
    if(!changes.length||changes.length>1280)throw new OrchestrationError('limit','Invalid execution event batch size.');
    const before=this.identity(),lock=join(this.root,'writer.lock');let fd:number|undefined;
    for(let n=0;n<=50;n++){throwIfCancelled(signal);try{fd=fs.openSync(lock,'wx',0o600);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw unavailable();if(n===50)throw new OrchestrationError('locked','Execution journal has another writer.');await cancellableDelay(10,signal);}}
    const lockIdentity=fs.fstatSync(fd!),file=join(this.root,'history.json'),temp=join(this.root,randomUUID()+'.tmp');
    try {
      fs.writeFileSync(fd!,String(process.pid));const raw=readArtifactBytes(file,MAX_EXECUTION_BYTES,true),prior=this.read();
      if(prior.events.length>=MAX_EXECUTION_EVENTS)throw new OrchestrationError('limit','Execution event retention reached; preserve the run.');
      const at=[new Date().toISOString(),prior.events.at(-1)?.at??prior.header.createdAt].sort().at(-1)!;
      const events=[...prior.events],added:ExecutionEvent[]=[];
      for(const entry of changes){const body={version:1 as const,id:entry.eventId??randomUUID(),runId:this.manifest.id,sequence:events.length+1,at,previous:events.at(-1)?.hash??prior.state.revision,change:structuredClone(entry.change)},event={...body,hash:digest(canonicalJson(body))};events.push(event);added.push(event);}
      replayExecution(prior.header,this.manifest,events);const next=JSON.stringify({version:1,header:prior.header,events,hash:journalHash(prior.header,events)});
      const settlement=changes.every(({change:c})=>['task_finished','agent_finished','escalated','finished'].includes(c.type)||c.type==='tool'&&c.stage==='finished'),reserve=4*this.manifest.plan.limits.maxConcurrent+1;
      if(!settlement&&(events.length+reserve>MAX_EXECUTION_EVENTS||Buffer.byteLength(next)+reserve*MAX_EXECUTION_EVENT_BYTES>MAX_EXECUTION_BYTES))throw new OrchestrationError('limit','Execution retention leaves room only for active task outcomes; preserve this run.');
      if(Buffer.byteLength(next)>MAX_EXECUTION_BYTES)throw new OrchestrationError('limit','Execution history exceeded its byte limit; preserve the run.');
      writeNew(temp,next);throwIfCancelled(signal);const after=this.identity();if(before.dev!==after.dev||before.ino!==after.ino||!readArtifactBytes(file,MAX_EXECUTION_BYTES,true).equals(raw))throw new OrchestrationError('conflict','Execution history changed before commit.');
      beforeCommit?.();fs.renameSync(temp,file);syncDir(this.root);for(const event of added)this.onEvent?.(event);return added;
    }finally{fs.closeSync(fd!);try{const after=this.identity();if(before.dev===after.dev&&before.ino===after.ino){fs.rmSync(temp,{force:true});const current=fs.lstatSync(lock);if(current.ino===lockIdentity.ino&&current.dev===lockIdentity.dev)fs.unlinkSync(lock);}}catch{/* Preserve foreign state. */}}
  }
  writeArtifact(eventId:string,content:string,signal?:AbortSignal):string {
    this.identity();if(!uuid(eventId)||Buffer.byteLength(content)>1024*1024)throw new OrchestrationError('limit','Artifact size or ID is invalid.');const dir=join(this.root,'artifacts');privateDirectory(dir);throwIfCancelled(signal);
    const listing=fs.opendirSync(dir);let bytes=Buffer.byteLength(content),count=1;try{let entry:fs.Dirent|null;while((entry=listing.readSync())){if(!entry.isFile()||!entry.name.endsWith('.txt')||!uuid(entry.name.slice(0,-4)))throw unavailable();bytes+=fs.lstatSync(join(dir,entry.name)).size;if(++count>10000||bytes>64*1024*1024)throw new OrchestrationError('limit','Run artifact retention reached; preserve existing evidence.');}}finally{listing.closeSync();}
    const path=eventId+'.txt';writeNew(join(dir,path),content);syncDir(dir);return path;
  }
}
