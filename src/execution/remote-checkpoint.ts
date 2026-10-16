/** Verified parent history survives a child restart; it never grants admission locally. */
import * as fs from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,digest} from '../approvals/index.js';
import {validateExecutionManifest,assertExecutionStoreOutsideProject} from './authority.js';
import {MAX_RESERVATION_BYTES,replayReservations} from './ledger.js';
import {ExecutionLimitError,type ExecutionManifest,type ReservationEvent} from './types.js';
import {recoverDeadWriterLock} from './writer-recovery.js';

export interface RemoteJournal {manifest:ExecutionManifest;events:ReservationEvent[]}
const damaged=()=>new ExecutionLimitError('unavailable','Verified parent history is unavailable or damaged; preserve it and restore a verified backup.');
export function verifiedJournal(value:unknown):RemoteJournal {
  const next=value as RemoteJournal;
  if(!next||!Array.isArray(next.events))throw damaged();
  const manifest=validateExecutionManifest(next.manifest);
  replayReservations(manifest,next.events);
  return structuredClone({manifest,events:next.events});
}
export function extendsJournal(previous:RemoteJournal,next:RemoteJournal):boolean {
  return canonicalJson(previous.manifest)===canonicalJson(next.manifest)&&previous.events.length<=next.events.length&&previous.events.every((event,i)=>event.hash===next.events[i]!.hash);
}
const conflict=()=>new ExecutionLimitError('conflict','Parent ledger history was rewritten or rolled back; execution stopped.');
function directory(path:string):fs.Stats {
  const stat=fs.lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077||fs.realpathSync(path)!==path)throw damaged();
  return stat;
}
function exists(path:string):boolean {
  try{fs.lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
function readFile(file:string):string {
  const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink())throw damaged();
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino||stat.nlink!==1||stat.mode&0o077||stat.size>MAX_RESERVATION_BYTES)throw damaged();
    const buffer=Buffer.alloc(stat.size+1);let size=0,n:number;
    while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;
    if(size!==stat.size)throw damaged();return buffer.subarray(0,size).toString('utf8');
  }finally{fs.closeSync(fd);}
}
function syncDir(path:string):void {
  if(process.platform==='win32')return;
  const fd=fs.openSync(path,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export class RemoteLedgerCheckpoint {
  readonly root:string;
  private readonly dir:string;
  constructor(root:string){this.root=resolve(root);this.dir=join(this.root,'verified-parent');}
  read():RemoteJournal|undefined {
    try{
      if(!exists(this.root))return undefined;directory(this.root);
      if(!exists(this.dir))return undefined;directory(this.dir);
      const value=JSON.parse(readFile(join(this.dir,'history.json')));
      if(value?.version!==1||typeof value.hash!=='string'||value.hash!==digest(canonicalJson(value.journal)))throw damaged();
      return verifiedJournal(value.journal);
    }catch{throw damaged();}
  }
  save(next:RemoteJournal,current?:RemoteJournal):RemoteJournal {
    assertExecutionStoreOutsideProject(next.manifest.project.root,this.root);
    if(!exists(this.root))fs.mkdirSync(this.root,{mode:0o700});directory(this.root);
    let fresh=false;
    try{fs.mkdirSync(this.dir,{mode:0o700});fresh=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const before=directory(this.dir),lock=join(this.dir,'writer.lock');
    let fd:number;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(!recoverDeadWriterLock(lock))throw new ExecutionLimitError('locked','Verified parent history is being updated; retry without resetting it.');
      fd=fs.openSync(lock,'wx',0o600);
    }
    let temp:string|undefined;
    try{
      fs.writeFileSync(fd,String(process.pid));fs.fsyncSync(fd);
      let selected=next;
      for(const saved of [current,fresh?undefined:this.read()]){
        if(!saved)continue;
        if(extendsJournal(selected,saved))selected=saved;
        else if(!extendsJournal(saved,selected))throw conflict();
      }
      const raw=JSON.stringify({version:1,journal:selected,hash:digest(canonicalJson(selected))});
      if(Buffer.byteLength(raw)>MAX_RESERVATION_BYTES)throw new ExecutionLimitError('limit','Verified parent history reached its byte limit; existing reservations remain charged.');
      temp=join(this.dir,`history.${randomUUID()}.tmp`);
      const output=fs.openSync(temp,'wx',0o600);
      try{fs.writeFileSync(output,raw);fs.fsyncSync(output);}finally{fs.closeSync(output);}
      const after=directory(this.dir);
      if(before.dev!==after.dev||before.ino!==after.ino)throw conflict();
      fs.renameSync(temp,join(this.dir,'history.json'));temp=undefined;syncDir(this.dir);syncDir(this.root);syncDir(dirname(this.root));
      return selected;
    }finally{
      if(temp)fs.unlinkSync(temp);
      const held=fs.fstatSync(fd);fs.closeSync(fd);
      const actual=fs.lstatSync(lock);if(held.ino===actual.ino&&held.dev===actual.dev)fs.unlinkSync(lock);
    }
  }
}
