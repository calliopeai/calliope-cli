/** Shared project accounting at the existing budget path; all writers retain history. */
import * as fs from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,canonicalPath,digest} from '../approvals/index.js';
import {cancellableDelay,throwIfCancelled} from '../cancellation.js';
import {ExecutionLimitError} from './types.js';
import {hex,integer,shape,uuid} from './authority.js';

type Change={type:'import'|'charge';costNanos:number}|{type:'reserve';requestId:string;runId:string;costNanos:number;capNanos:number}|{type:'settle';requestId:string;costNanos:number|null;invalid?:true}|{type:'reset'};
interface Event {version:1;id:string;at:string;previous:string|null;change:Change;hash:string}
interface State {spentNanos:number;blocked:boolean;requests:Map<string,{costNanos:number;settled:boolean}>;events:Event[];legacyUpdatedAt?:string}
const MAX_EVENTS=10000,MAX_BYTES=8*1024*1024;
const damaged=()=>new ExecutionLimitError('unavailable','Project budget history is damaged or unavailable; no further request is authorized. Preserve it for recovery.');
export function dollarsToNanos(value:number):number {if(!Number.isFinite(value)||value<0)throw damaged();const n=Math.ceil(value*1e9);integer(n);return n;}
function replay(events:Event[]):State {
  if(events.length>MAX_EVENTS)throw damaged();const state:State={spentNanos:0,blocked:false,requests:new Map(),events};let previous:string|null=null,lastAt='';const ids=new Set<string>();
  for(const event of events){
    shape(event,['version','id','at','previous','change','hash']);if(event.version!==1||!uuid(event.id)||ids.has(event.id)||typeof event.at!=='string'||!Number.isFinite(Date.parse(event.at))||event.at<lastAt||event.previous!==previous||!hex(event.hash))throw damaged();
    const {hash,...body}=event;if(digest(canonicalJson(body))!==hash)throw damaged();ids.add(event.id);previous=hash;lastAt=event.at;
    const change=event.change;shape(change,['type'],['costNanos','requestId','runId','capNanos','invalid']);
    if(change.type==='import'||change.type==='charge'){
      shape(change,['type','costNanos']);integer(change.costNanos);if(change.type==='import'&&state.events[0]!==event)throw damaged();state.spentNanos+=change.costNanos;
    }else if(change.type==='reserve'){
      shape(change,['type','requestId','runId','costNanos','capNanos']);if(!uuid(change.requestId)||!uuid(change.runId)||state.requests.has(change.requestId))throw damaged();integer(change.costNanos);integer(change.capNanos);
      if(state.blocked||state.spentNanos+change.costNanos>change.capNanos)throw new ExecutionLimitError('budget','Request reservation exceeds the shared project cost budget.');
      state.spentNanos+=change.costNanos;state.requests.set(change.requestId,{costNanos:change.costNanos,settled:false});
    }else if(change.type==='settle'){
      shape(change,['type','requestId','costNanos'],['invalid']);if(change.invalid!==undefined&&change.invalid!==true)throw damaged();if(!uuid(change.requestId))throw damaged();if(change.costNanos!==null)integer(change.costNanos);
      const request=state.requests.get(change.requestId);if(!request||request.settled)throw new ExecutionLimitError('conflict','Project reservation is unknown or already settled.');
      request.settled=true;if(change.invalid)state.blocked=true;if(change.costNanos!==null){state.spentNanos+=(change.invalid?Math.max(change.costNanos,request.costNanos):change.costNanos)-request.costNanos;if(change.costNanos>request.costNanos)state.blocked=true;}
    }else if(change.type==='reset'){
      shape(change,['type']);if([...state.requests.values()].some(r=>!r.settled))throw new ExecutionLimitError('conflict','Pending project reservations cannot be reset.');state.spentNanos=0;state.blocked=false;
    }else throw damaged();integer(state.spentNanos);
  }
  return state;
}
function readRaw(file:string):string|null {
  let fd:number;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw damaged();}
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.mode&0o022||stat.size>MAX_BYTES)throw damaged();const buf=Buffer.alloc(stat.size+1);let size=0,n:number;while(size<buf.length&&(n=fs.readSync(fd,buf,size,buf.length-size,null))>0)size+=n;if(size!==stat.size)throw damaged();return buf.subarray(0,size).toString('utf8');}finally{fs.closeSync(fd);}
}
function parse(raw:string|null):{state:State;legacy:boolean} {
  if(raw===null)return{state:replay([]),legacy:false};let value:unknown;try{value=JSON.parse(raw);}catch{throw damaged();}
  if(!value||typeof value!=='object')throw damaged();
  if(!('version' in value)){
    shape(value,['spentUsd','updatedAt']);if(typeof value.spentUsd!=='number'||typeof value.updatedAt!=='string'||!Number.isFinite(Date.parse(value.updatedAt)))throw damaged();const costNanos=dollarsToNanos(value.spentUsd);
    return{state:{spentNanos:costNanos,blocked:false,requests:new Map(),events:[],legacyUpdatedAt:value.updatedAt},legacy:true};
  }
  const record:unknown=value;shape(record,['version','events','spentUsd','updatedAt']);if(record.version!==2||!Array.isArray(record.events))throw damaged();
  const state=replay(record.events as Event[]);if(record.spentUsd!==state.spentNanos/1e9||record.updatedAt!==(state.events.at(-1)?.at??new Date(0).toISOString()))throw damaged();return{state,legacy:false};
}
function encode(state:State):string {
  const raw=JSON.stringify({version:2,events:state.events,spentUsd:state.spentNanos/1e9,updatedAt:state.events.at(-1)?.at??new Date(0).toISOString()});if(Buffer.byteLength(raw)>MAX_BYTES)throw new ExecutionLimitError('limit','Project budget history reached its byte limit; preserve the history.');return raw;
}
function event(events:Event[],change:Change):Event {const body={version:1 as const,id:randomUUID(),at:[new Date().toISOString(),events.at(-1)?.at??''].sort().at(-1)!,previous:events.at(-1)?.hash??null,change};return{...body,hash:digest(canonicalJson(body))};}
function directory(dir:string,create=false):fs.Stats {
  if(canonicalPath(dir)!==dir)throw damaged();if(create)fs.mkdirSync(dir,{recursive:true,mode:0o700});const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o022)throw damaged();return stat;
}
function writeNew(file:string,raw:string):void {const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function initialized(file:string):boolean {
  try { const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==9)throw damaged(); }
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw damaged();}
  if(readRaw(file)!=='version=2')throw damaged();return true;
}
export class ProjectSpendLedger {
  readonly file:string;
  constructor(file:string){this.file=resolve(file);}
  read():{spentUsd:number;updatedAt:string;blocked:boolean;events:Event[]} {
    const dir=dirname(this.file);if(canonicalPath(dir)!==dir)throw damaged();if(fs.existsSync(dir))directory(dir);
    const raw=readRaw(this.file),marked=initialized(this.file+'.initialized');if(raw===null&&marked)throw damaged();const {state}=parse(raw);
    return{spentUsd:state.spentNanos/1e9,updatedAt:state.events.at(-1)?.at??state.legacyUpdatedAt??new Date(0).toISOString(),blocked:state.blocked,events:state.events};
  }
  async reserve(requestId:string,runId:string,costNanos:number,capNanos:number,signal?:AbortSignal):Promise<void>{await this.updateAsync({type:'reserve',requestId,runId,costNanos,capNanos},signal);}
  async settle(requestId:string,costNanos:number|null,invalid=false):Promise<void>{await this.updateAsync({type:'settle',requestId,costNanos,...(invalid?{invalid:true as const}:{})});}
  charge(cost:number):number {return this.updateSync({type:'charge',costNanos:dollarsToNanos(cost)}).spentNanos/1e9;}
  reset():void {this.updateSync({type:'reset'});}
  private async updateAsync(change:Change,signal?:AbortSignal):Promise<void>{for(let n=0;;n++){throwIfCancelled(signal);try{this.update(change,signal);return;}catch(error){if(!(error instanceof ExecutionLimitError)||error.code!=='locked'||n>=50)throw error;await cancellableDelay(10,signal);}}}
  private updateSync(change:Change):State {for(let n=0;;n++){try{return this.update(change);}catch(error){if(!(error instanceof ExecutionLimitError)||error.code!=='locked'||n>=50)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}}
  private update(change:Change,signal?:AbortSignal):State {
    throwIfCancelled(signal);const dir=dirname(this.file),before=directory(dir,true),lock=this.file+'.lock',marker=this.file+'.initialized';let fd:number;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new ExecutionLimitError('locked','Project budget has another writer.');throw damaged();}
    const identity=fs.fstatSync(fd),temp=join(dir,`${randomUUID()}.tmp`);
    try{
      fs.writeFileSync(fd,String(process.pid));const raw=readRaw(this.file),marked=initialized(marker);if(raw===null&&marked)throw damaged();const prior=parse(raw);let events=prior.state.events;
      if(prior.legacy)events=[event([],{type:'import',costNanos:prior.state.spentNanos})];
      const pending=[...prior.state.requests.values()].filter(r=>!r.settled).length;
      if(events.length+(change.type==='reserve'?pending+2:1)>MAX_EVENTS)throw new ExecutionLimitError('limit','Project budget history reached its event limit; pending reservations remain charged.');
      const next=replay([...events,event(events,change)]),output=encode(next);writeNew(temp,output);throwIfCancelled(signal);const after=directory(dir);
      if(before.dev!==after.dev||before.ino!==after.ino||readRaw(this.file)!==raw)throw new ExecutionLimitError('conflict','Project budget changed before commit.');
      if(!marked)writeNew(marker,'version=2');fs.renameSync(temp,this.file);const directoryFd=fs.openSync(dir,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}return next;
    }finally{fs.closeSync(fd);try{const after=directory(dir);if(before.dev===after.dev&&before.ino===after.ino){fs.rmSync(temp,{force:true});const lockStat=fs.lstatSync(lock);if(lockStat.dev===identity.dev&&lockStat.ino===identity.ino)fs.unlinkSync(lock);}}catch{/* Preserve foreign or damaged directories. */}}
  }
}
