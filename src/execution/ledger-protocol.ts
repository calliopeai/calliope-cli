/** delegation-ledger/v1: one parent reservation ledger shared with children on other hosts (#415).
 * The parent (or an Astrolift-managed service) serves the existing ReservationLedger; children
 * reserve and settle against it with scoped, fenced bearer tokens. Nothing here widens authority. */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {ExecutionLimitError} from './types.js';
import {uuid,identifier} from './authority.js';

export const LEDGER_PROTOCOL='delegation-ledger/v1';
export const LEDGER_OPERATIONS=['hello','journal','reserve','settle','grant','revoke'] as const;
export type LedgerOperation=typeof LEDGER_OPERATIONS[number];
export const MAX_LEDGER_REQUEST_BYTES=256*1024;

export interface LedgerTokenClaims {
  v:1; run:string; role:'parent'|'child'; exp:number;
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
  if(given.length!==expected.length||!timingSafeEqual(given,expected))throw denied('Ledger token is not valid for this ledger.');
  let claims:LedgerTokenClaims;try{claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{throw denied('Ledger token is malformed.');}
  if(claims?.v!==1||claims.run!==runId||!Number.isSafeInteger(claims.exp)||claims.exp<=now)throw denied('Ledger token expired or belongs to another run.');
  if(claims.role==='child'){
    if(!uuid(claims.grant)||!Number.isSafeInteger(claims.epoch)||!Array.isArray(claims.accounts)||!claims.accounts.length)throw denied('Child ledger token is malformed.');
    for(const account of claims.accounts)identifier(account);
  }else if(claims.role!=='parent')throw denied('Ledger token role is not recognised.');
  return claims;
}

/** Server-only state beside (never inside) the budget directory: signing key and grant epochs. */
export class LedgerServerState {
  constructor(readonly dir:string){}
  private ensure():void {
    try{fs.mkdirSync(this.dir,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const stat=fs.lstatSync(this.dir);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077)throw new ExecutionLimitError('unavailable','Ledger server state directory is not private.');
  }
  secret():Buffer {
    this.ensure();const file=join(this.dir,'server.key');
    try{fs.writeFileSync(file,randomBytes(32),{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const key=fs.readFileSync(file);if(key.length!==32||fs.statSync(file).mode&0o077)throw new ExecutionLimitError('unavailable','Ledger server key is damaged or not private.');return key;
  }
  epochs():Record<string,number> {
    this.ensure();try{return JSON.parse(fs.readFileSync(join(this.dir,'epochs.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw new ExecutionLimitError('unavailable','Ledger grant epochs are damaged.');}
  }
  epoch(grant:string):number {return this.epochs()[grant]??1;}
  /** Revocation is permanent in v1: a revoked grant is never reissued. */
  isRevoked(grant:string):boolean {return (this.epochs()[grant]??1)>1;}
  /** Fencing: every token minted for an earlier epoch of this grant stops working. */
  revoke(grant:string):number {
    const epochs=this.epochs(),next=(epochs[grant]??1)+1;epochs[grant]=next;
    const temp=join(this.dir,`epochs.${process.pid}.tmp`);fs.writeFileSync(temp,JSON.stringify(epochs),{mode:0o600});fs.renameSync(temp,join(this.dir,'epochs.json'));return next;
  }
}
