/** delegation-ledger/v1: one parent reservation ledger shared with children on other hosts (#415).
 * The parent (or an Astrolift-managed service) serves the existing ReservationLedger; children
 * reserve and settle against it with scoped, fenced bearer tokens. Nothing here widens authority. */
import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {ExecutionLimitError} from './types.js';
import {uuid,identifier,hex} from './authority.js';
import {privateDirectory,readArtifactBytes} from '../orchestration/execution-store.js';
import {recoverDeadWriterLock} from './writer-recovery.js';

export const LEDGER_PROTOCOL='delegation-ledger/v1';
export const LEDGER_OPERATIONS=['hello','journal','execution','reserve','settle','grant','revoke'] as const;
export type LedgerOperation=typeof LEDGER_OPERATIONS[number];
export const MAX_LEDGER_REQUEST_BYTES=256*1024;

export interface LedgerTokenClaims {
  v:1|2; run:string; role:'parent'|'child'; exp:number;
  /** v2 parent tokens: immutable subtree scope. v1 servers reject this version. */
  owner?:string;
  /** Reviewed-host audience. Raw ledger endpoints cannot accept these credentials. */
  authority?:string;
  /** Child tokens only: the grant they came from, its fencing epoch and the accounts they may charge. */
  grant?:string; epoch?:number; accounts?:string[];
}
const b64=(value:Buffer|string)=>Buffer.from(value).toString('base64url');
const sign=(secret:Buffer,body:string)=>createHmac('sha256',secret).update(body).digest();
const denied=(message:string)=>new ExecutionLimitError('authority',message);

export function mintLedgerToken(secret:Buffer,claims:LedgerTokenClaims):string {
  const body=b64(JSON.stringify(claims));return `${body}.${b64(sign(secret,body))}`;
}
/** Signature, expiry and run binding; the server separately checks the grant's current epoch. */
export function verifyLedgerToken(secret:Buffer,token:unknown,runId:string,now=Date.now()):LedgerTokenClaims {
  if(typeof token!=='string'||token.length>8192)throw denied('Ledger token is missing.');
  const [body,mac,extra]=token.split('.');if(!body||!mac||extra!==undefined)throw denied('Ledger token is malformed.');
  const expected=sign(secret,body),given=Buffer.from(mac,'base64url');
  // Only the canonical encoding counts: base64url ignores a final character's padding bits.
  if(b64(given)!==mac||given.length!==expected.length||!timingSafeEqual(given,expected))throw denied('Ledger token is not valid for this ledger.');
  let claims:LedgerTokenClaims;try{claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{throw denied('Ledger token is malformed.');}
  if(!claims||![1,2].includes(claims.v)||claims.run!==runId||!Number.isSafeInteger(claims.exp)||claims.exp<=now)throw denied('Ledger token expired or belongs to another run.');
  if(claims.authority!==undefined&&(!hex(claims.authority)||claims.v!==2))throw denied('Ledger token authority binding is malformed.');
  if(claims.role==='child'){
    if(claims.v===2&&!claims.authority||claims.owner!==undefined||!uuid(claims.grant)||!Number.isSafeInteger(claims.epoch)||Number(claims.epoch)<1||!Array.isArray(claims.accounts)||!claims.accounts.length)throw denied('Child ledger token is malformed.');
    for(const account of claims.accounts)identifier(account);
  }else if(claims.role==='parent'){
    if(claims.v===2){try{identifier(claims.owner);}catch{throw denied('Parent ledger token has no valid owner scope.');}}
    else if(claims.owner!==undefined)throw denied('Scoped parent tokens require version 2.');
    if(claims.grant!==undefined||claims.epoch!==undefined||claims.accounts!==undefined)throw denied('Parent ledger token is malformed.');
  }else throw denied('Ledger token role is not recognised.');
  return claims;
}

/** Server-only state beside (never inside) the budget directory: signing key and grant epochs. */
export class LedgerServerState {
  constructor(readonly dir:string){}
  private ensure():void {
    try{fs.mkdirSync(this.dir,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    try{privateDirectory(this.dir);}catch{throw new ExecutionLimitError('unavailable','Ledger server state directory is not private.');}
  }
  secret():Buffer {
    this.ensure();const file=join(this.dir,'server.key');let created=false;
    if(!fs.existsSync(file)&&fs.existsSync(join(this.dir,'epochs.json')))throw new ExecutionLimitError('unavailable','Ledger server key is missing; restore the verified server state.');
    try{fs.writeFileSync(file,randomBytes(32),{mode:0o600,flag:'wx'});created=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    if(created)try{fs.writeFileSync(join(this.dir,'epochs.json'),'{}',{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    this.epochs();
    try{const key=readArtifactBytes(file,32,true);if(key.length===32)return key;}catch{/* Preserve invalid state. */}
    throw new ExecutionLimitError('unavailable','Ledger server key is damaged or not private.');
  }
  epochs():Record<string,number> {
    this.ensure();const file=join(this.dir,'epochs.json');
    try{
      const value:unknown=JSON.parse(readArtifactBytes(file,1024*1024,true).toString());
      if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=10000&&Object.entries(value).every(([id,epoch])=>uuid(id)&&Number.isSafeInteger(epoch)&&Number(epoch)>=1))return value as Record<string,number>;
    }catch{/* Preserve invalid state. */}
    throw new ExecutionLimitError('unavailable','Ledger grant epochs are damaged.');
  }
  epoch(grant:string):number {return this.epochs()[grant]??1;}
  /** Revocation is permanent in v1: a revoked grant is never reissued. */
  isRevoked(grant:string):boolean {return (this.epochs()[grant]??1)>1;}
  /** Fencing: every token minted for an earlier epoch of this grant stops working. */
  revoke(grant:string):number {
    if(!uuid(grant))throw denied('Invalid child grant.');this.ensure();
    const lock=join(this.dir,'writer.lock');let fd:number;
    try{fd=fs.openSync(lock,'wx',0o600);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(!recoverDeadWriterLock(lock))throw new ExecutionLimitError('locked','Ledger grant state has another writer.');
      try{fd=fs.openSync(lock,'wx',0o600);}catch{throw new ExecutionLimitError('locked','Ledger grant state has another writer.');}
    }
    const identity=fs.fstatSync(fd),temp=join(this.dir,`epochs.${randomUUID()}.tmp`);
    try{
      fs.writeFileSync(fd,String(process.pid));const epochs=this.epochs(),next=(epochs[grant]??1)+1;
      if(!Number.isSafeInteger(next)||!Object.hasOwn(epochs,grant)&&Object.keys(epochs).length>=10000)throw new ExecutionLimitError('limit','Ledger revocation retention reached.');
      epochs[grant]=next;const output=fs.openSync(temp,'wx',0o600);
      try{fs.writeFileSync(output,JSON.stringify(epochs));fs.fsyncSync(output);}finally{fs.closeSync(output);}
      fs.renameSync(temp,join(this.dir,'epochs.json'));
      if(process.platform!=='win32'){const directory=fs.openSync(this.dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
      return next;
    }finally{
      fs.closeSync(fd);const current=fs.lstatSync(lock);
      if(current.dev===identity.dev&&current.ino===identity.ino){fs.rmSync(temp,{force:true});fs.unlinkSync(lock);}
    }
  }
}
