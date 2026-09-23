import * as fs from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {canonicalJson,canonicalPath} from '../approvals/index.js';
import {throwIfCancelled,cancellableDelay} from '../cancellation.js';
import {ExecutionLimitError} from '../execution/types.js';
import {OrchestrationError} from '../orchestration/types.js';
import {privateDirectory,readArtifactBytes} from '../orchestration/execution-store.js';
import {shape,uuid,hex,iso,integer,MAX_PLAN_BYTES} from '../orchestration/validation.js';
import {signed,validateGoalManifest,validateGoalProposal,assertGoalProject,MAX_GOAL_BYTES,MAX_GOAL_EVENTS,MAX_GOAL_EVENT_BYTES} from './validation.js';
import {goalHistoryHash,replayGoal} from './journal.js';
import type {GoalManifest,GoalProposal,GoalInspection,GoalChange,GoalEvent,GoalOwner,GoalProjection,PlanningSpend} from './types.js';

const unavailable=()=>new OrchestrationError('unavailable','Goal records are damaged or unavailable. Preserve the directory; no new allocation is authorized.');
function exists(path:string):boolean{try{fs.lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw unavailable();}}
function readJson(path:string,max:number):unknown{try{return JSON.parse(readArtifactBytes(path,max,true).toString());}catch{throw unavailable();}}
function writeNew(path:string,bytes:string):void{const fd=fs.openSync(path,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
// POSIX-only: Windows denies FlushFileBuffers on a directory handle opened via 'r' (#382, #384, #388).
function sync(path:string):void{if(process.platform==='win32')return;const fd=fs.openSync(path,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function outside(project:string,path:string):boolean{const rel=relative(project,path);return isAbsolute(rel)||rel==='..'||rel.startsWith('../');}
function checkExecution(manifest:GoalManifest,state:GoalProjection,proposal:GoalProposal|null):void {
  if(state.execution&&(!proposal||proposal.hash!==state.approvedProposalHash||proposal.planHash!==state.execution.planHash||proposal.plan.limits.tokenBudget!==state.execution.tokens||Math.floor(proposal.plan.limits.costBudgetUsd*1e9)!==state.execution.costNanos||Date.parse(manifest.createdAt)+proposal.plan.limits.timeBudgetMs!==state.execution.deadline))throw unavailable();
}

/** Goal allocations are durable grants, separate from provider request reservations. */
export class GoalStore {
  readonly root:string;
  constructor(root=join(homedir(),'.calliope-cli','goals'),private readonly onEvent?:(event:GoalEvent)=>void){this.root=resolve(root);}
  directory(id:string):string{if(!uuid(id))throw new OrchestrationError('invalid','Goal IDs must be UUIDs.');return join(this.root,id);}
  private identity(id:string,manifest?:GoalManifest):fs.Stats {
    privateDirectory(this.root);const stat=privateDirectory(this.directory(id));
    if(manifest){assertGoalProject(manifest);if(!outside(manifest.project.root,this.root)||!outside(manifest.project.root,manifest.runsRoot)||canonicalPath(manifest.runsRoot)!==manifest.runsRoot)throw new OrchestrationError('policy-denied','Goal and run authority stores must remain outside the worker project scope without aliases.');}return stat;
  }
  private names():string[]{
    if(!exists(this.root))return[];privateDirectory(this.root);const names:string[]=[],dir=fs.opendirSync(this.root);
    try{let item:fs.Dirent|null;while((item=dir.readSync())){if(item.name==='create.lock')continue;if(!uuid(item.name)||!item.isDirectory()||item.isSymbolicLink())throw unavailable();names.push(item.name);if(names.length>1000)throw new OrchestrationError('limit','Goal retention reached; preserve and archive finished goals.');}}finally{dir.closeSync();}return names;
  }
  create(input:GoalManifest,signal?:AbortSignal):GoalInspection {
    throwIfCancelled(signal);const manifest=validateGoalManifest(JSON.parse(canonicalJson(input)));assertGoalProject(manifest);
    if(canonicalPath(this.root)!==this.root||canonicalPath(manifest.runsRoot)!==manifest.runsRoot||!outside(manifest.project.root,this.root)||!outside(manifest.project.root,manifest.runsRoot))throw new OrchestrationError('policy-denied','Goal and run authority stores must remain outside worker scope without aliases.');
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});const before=privateDirectory(this.root),lock=join(this.root,'create.lock');let fd:number;try{fd=fs.openSync(lock,'wx',0o600);}catch{throw new OrchestrationError('locked','Another process is creating a goal.');}const lockStat=fs.fstatSync(fd);
    try{fs.writeFileSync(fd,String(process.pid));if(this.names().length>=1000)throw new OrchestrationError('limit','Goal retention reached.');const dir=this.directory(manifest.id);if(exists(dir))throw new OrchestrationError('conflict','Goal already exists; inspect its original history.');fs.mkdirSync(dir,{mode:0o700});fs.mkdirSync(join(dir,'proposals'),{mode:0o700});this.identity(manifest.id,manifest);
      writeNew(join(dir,'manifest.json'),canonicalJson(manifest));writeNew(join(dir,'history.json'),JSON.stringify({version:1,goalId:manifest.id,manifestHash:manifest.hash,events:[],hash:goalHistoryHash(manifest,[])}));sync(dir);sync(this.root);return this.read(manifest.id,manifest.project.root);
    }finally{fs.closeSync(fd);try{const after=privateDirectory(this.root),stat=fs.lstatSync(lock);if(before.dev===after.dev&&before.ino===after.ino&&stat.dev===lockStat.dev&&stat.ino===lockStat.ino)fs.unlinkSync(lock);}catch{/* Preserve foreign state. */}}
  }
  read(id:string,cwd?:string):GoalInspection {
    const dir=this.directory(id);this.identity(id);const manifest=validateGoalManifest(readJson(join(dir,'manifest.json'),MAX_PLAN_BYTES));if(manifest.id!==id)throw unavailable();this.identity(id,manifest);if(cwd)assertGoalProject(manifest,cwd);
    const journal=readJson(join(dir,'history.json'),MAX_GOAL_BYTES);shape(journal,['version','goalId','manifestHash','events','hash']);if(journal.version!==1||journal.goalId!==id||journal.manifestHash!==manifest.hash||!Array.isArray(journal.events))throw unavailable();
    const events=journal.events as GoalEvent[],state=replayGoal(manifest,events);if(journal.hash!==goalHistoryHash(manifest,events))throw unavailable();
    const proposal=state.proposalHash?this.proposal(manifest,state.proposalHash,state.planningSpend??undefined):null;
    checkExecution(manifest,state,proposal);
    return{manifest,events,state,proposal};
  }
  list(cwd:string):{goals:GoalInspection[];unavailable:number}{const goals:GoalInspection[]=[];let damaged=0;for(const id of this.names())try{goals.push(this.read(id,cwd));}catch(error){if(error instanceof OrchestrationError&&error.code==='policy-denied')continue;damaged++;}return{goals:goals.sort((a,b)=>a.manifest.createdAt.localeCompare(b.manifest.createdAt)||a.manifest.id.localeCompare(b.manifest.id)),unavailable:damaged};}
  proposal(manifest:GoalManifest,hash:string,spend?:PlanningSpend):GoalProposal {if(!hex(hash))throw unavailable();this.identity(manifest.id,manifest);privateDirectory(join(this.directory(manifest.id),'proposals'));const value=validateGoalProposal(readJson(join(this.directory(manifest.id),'proposals',hash+'.json'),MAX_PLAN_BYTES+8192),manifest,spend);if(value.hash!==hash)throw unavailable();return value;}
  writeProposal(input:GoalProposal,spend:PlanningSpend,signal?:AbortSignal):GoalProposal {
    throwIfCancelled(signal);const current=this.read(input.goalId),proposal=validateGoalProposal(input,current.manifest,spend),dir=join(this.directory(input.goalId),'proposals');privateDirectory(dir);
    if(current.state.execution||current.state.revoked)throw new OrchestrationError('conflict','Goal no longer accepts proposals.');const file=join(dir,proposal.hash+'.json');if(exists(file))return this.proposal(current.manifest,proposal.hash,spend);
    let count=0,bytes=Buffer.byteLength(JSON.stringify(proposal));const listing=fs.opendirSync(dir);try{let entry:fs.Dirent|null;while((entry=listing.readSync())){if(!entry.isFile()||!entry.name.endsWith('.json')||!hex(entry.name.slice(0,-5)))throw unavailable();bytes+=fs.lstatSync(join(dir,entry.name)).size;if(++count>=64||bytes>64*1024*1024)throw new OrchestrationError('limit','Proposal retention reached; preserve prior evidence.');}}finally{listing.closeSync();}
    writeNew(file,JSON.stringify(proposal));sync(dir);return this.proposal(current.manifest,proposal.hash,spend);
  }
  async append(id:string,change:GoalChange,options:{signal?:AbortSignal;expectedRevision?:string;beforeCommit?:()=>void}={}):Promise<GoalEvent> {
    const dir=this.directory(id),before=this.identity(id),lock=join(dir,'writer.lock');let fd:number|undefined;
    for(let n=0;n<=50;n++){throwIfCancelled(options.signal);try{fd=fs.openSync(lock,'wx',0o600);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw unavailable();if(n===50)throw new OrchestrationError('locked','Goal journal has another writer.');await cancellableDelay(10,options.signal);}}
    const lockStat=fs.fstatSync(fd!),file=join(dir,'history.json'),temp=join(dir,randomUUID()+'.tmp');
    try{fs.writeFileSync(fd!,String(process.pid));const raw=readArtifactBytes(file,MAX_GOAL_BYTES,true),prior=this.read(id);if(options.expectedRevision&&prior.state.revision!==options.expectedRevision)throw new OrchestrationError('conflict','Goal changed during review.');
      if(prior.events.length>=MAX_GOAL_EVENTS)throw new OrchestrationError('limit','Goal event retention reached.');const event=signed({version:1 as const,id:randomUUID(),goalId:id,sequence:prior.events.length+1,at:[new Date().toISOString(),prior.events.at(-1)?.at??prior.manifest.createdAt].sort().at(-1)!,previous:prior.state.revision,change:structuredClone(change)});
      const events=[...prior.events,event],state=replayGoal(prior.manifest,events),proposal=state.proposalHash?this.proposal(prior.manifest,state.proposalHash,state.planningSpend??undefined):null;checkExecution(prior.manifest,state,proposal);
      if(change.type==='planning_finished'&&proposal&&(proposal.source.kind!=='agent'||proposal.source.runId!==state.planning?.runId))throw new OrchestrationError('conflict','Initial proposal does not originate from the allocated planner.');
      if(change.type==='proposal_revised'&&proposal?.source.kind!=='human')throw new OrchestrationError('conflict','Revised proposals require explicit human source provenance.');
      const bytes=JSON.stringify({version:1,goalId:id,manifestHash:prior.manifest.hash,events,hash:goalHistoryHash(prior.manifest,events)});if(Buffer.byteLength(bytes)>MAX_GOAL_BYTES)throw new OrchestrationError('limit','Goal history exceeded its byte limit.');
      if(!['planning_finished','execution_finished','execution_interrupted','cancelled'].includes(change.type)&&(events.length+4>MAX_GOAL_EVENTS||Buffer.byteLength(bytes)+4*MAX_GOAL_EVENT_BYTES>MAX_GOAL_BYTES))throw new OrchestrationError('limit','Goal retention leaves room only for final outcomes and cancellation.');
      writeNew(temp,bytes);throwIfCancelled(options.signal);const after=this.identity(id,prior.manifest);if(before.dev!==after.dev||before.ino!==after.ino||!raw.equals(readArtifactBytes(file,MAX_GOAL_BYTES,true)))throw new OrchestrationError('conflict','Goal changed before commit.');options.beforeCommit?.();fs.renameSync(temp,file);sync(dir);this.onEvent?.(event);return event;
    }finally{fs.closeSync(fd!);try{const after=this.identity(id);if(before.dev===after.dev&&before.ino===after.ino){fs.rmSync(temp,{force:true});const stat=fs.lstatSync(lock);if(stat.dev===lockStat.dev&&stat.ino===lockStat.ino)fs.unlinkSync(lock);}}catch{/* Preserve foreign state. */}}
  }
  owner(id:string):{id:string;pid:number;alive:boolean}|null {
    this.identity(id);const file=join(this.directory(id),'owner.json');if(!exists(file))return null;const owner=readJson(file,4096);shape(owner,['version','id','pid','createdAt']);if(owner.version!==1||!uuid(owner.id)||!iso(owner.createdAt))throw unavailable();integer(owner.pid,1,2147483647);let alive=true;try{process.kill(owner.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else if((error as NodeJS.ErrnoException).code!=='EPERM')throw unavailable();}return{id:owner.id,pid:owner.pid,alive};
  }
  acquire(id:string):GoalOwner {
    const manifest=this.read(id).manifest,dir=this.directory(id),before=this.identity(id,manifest),election=join(dir,'owner.lock');let fd:number;try{fd=fs.openSync(election,'wx',0o600);}catch{throw new OrchestrationError('locked','Goal ownership is being changed; preserve stale locks until their process is confirmed stopped.');}
    const lockStat=fs.fstatSync(fd);try{fs.writeFileSync(fd,String(process.pid));const prior=this.owner(id),file=join(dir,'owner.json');if(prior?.alive)throw new OrchestrationError('locked','Another process owns this goal.');if(prior){const latest=this.owner(id);if(latest?.id!==prior.id||latest.alive)throw new OrchestrationError('locked','Goal owner changed.');fs.unlinkSync(file);}
      const ownerId=randomUUID();writeNew(file,JSON.stringify({version:1,id:ownerId,pid:process.pid,createdAt:new Date().toISOString()}));sync(dir);
      const check=()=>{const after=this.identity(id,manifest),owner=this.owner(id);if(before.dev!==after.dev||before.ino!==after.ino||owner?.id!==ownerId||owner.pid!==process.pid)throw new ExecutionLimitError('authority','Goal ownership changed.');};
      return{id:ownerId,check,release:()=>{check();fs.unlinkSync(file);sync(dir);}};
    }finally{fs.closeSync(fd);try{const after=this.identity(id,manifest),stat=fs.lstatSync(election);if(before.dev===after.dev&&before.ino===after.ino&&stat.dev===lockStat.dev&&stat.ino===lockStat.ino)fs.unlinkSync(election);}catch{/* Preserve foreign state. */}}
  }
}
