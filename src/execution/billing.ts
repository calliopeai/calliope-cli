/** Operator-reviewed evidence complements discovery; it never changes live model identity. */
import * as fs from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {canonicalJson,digest} from '../approvals/index.js';
import type {RouteCandidate} from '../routing/index.js';
import {assertExecutionStoreOutsideProject,hex,integer,invalid,shape} from './authority.js';
import {ExecutionLimitError} from './types.js';

export interface BillingProfile {
  provider:'anthropic'; model:string; target:string;
  checkedAt:number; expiresAt:number; sources:string[];
  prices:{input:number;output:number};
  capabilities:{tools?:boolean;streaming?:boolean};
  admission:'provider-count-v1';
}
export interface BillingEvidence {profile:BillingProfile;hash:string}
export interface InputCount {version:1;method:'anthropic-count-tokens';requestHash:string;inputTokens:number;at:number}
export interface QuoteEvidence {version:1;profileHash:string;profile:BillingProfile;count:InputCount;multiplier:2;slackTokens:1024}
export const billingFile = ():string => resolve(process.env.CALLIOPE_BILLING_FILE || join(homedir(),'.calliope-cli','billing.json'));

export function validateBillingProfile(value:unknown):BillingProfile {
  shape(value,['provider','model','target','checkedAt','expiresAt','sources','prices','capabilities','admission']);
  if(value.provider!=='anthropic'||value.admission!=='provider-count-v1'||typeof value.model!=='string'||!value.model||value.model.length>512||/[\x00-\x20\x7f]/.test(value.model)||!hex(value.target))invalid();
  integer(value.checkedAt,1,8640000000000000);integer(value.expiresAt,value.checkedAt+1,Math.min(8640000000000000,value.checkedAt+7*86400000));
  if(!Array.isArray(value.sources)||!value.sources.length||value.sources.length>8)invalid();
  for(const source of value.sources){
    if(typeof source!=='string'||source.length>2048)invalid();
    let url:URL;try{url=new URL(source);}catch{invalid();}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)invalid();
  }
  shape(value.prices,['input','output']);
  for(const price of Object.values(value.prices))if(typeof price!=='number'||!Number.isFinite(price)||price<0||price>1000000)invalid();
  shape(value.capabilities,[],['tools','streaming']);
  if(Object.values(value.capabilities).some(v=>typeof v!=='boolean'))invalid();
  return JSON.parse(canonicalJson(value)) as BillingProfile;
}
export function validateInputCount(value:unknown):InputCount {
  shape(value,['version','method','requestHash','inputTokens','at']);
  if(value.version!==1||value.method!=='anthropic-count-tokens'||!hex(value.requestHash))invalid();
  integer(value.inputTokens,1,100000000);integer(value.at,1,8640000000000000);
  return value as unknown as InputCount;
}
export function validateQuoteEvidence(value:unknown):QuoteEvidence {
  shape(value,['version','profileHash','profile','count','multiplier','slackTokens']);
  if(value.version!==1||!hex(value.profileHash)||value.multiplier!==2||value.slackTokens!==1024)invalid();
  const profile=validateBillingProfile(value.profile);if(digest(canonicalJson(profile))!==value.profileHash)invalid();
  validateInputCount(value.count);return value as unknown as QuoteEvidence;
}
export function assertBillingCurrent(evidence:BillingEvidence,route:RouteCandidate,now=Date.now()):void {
  const p=validateBillingProfile(evidence.profile);
  if(evidence.hash!==digest(canonicalJson(p))||p.provider!==route.provider||p.model!==route.model||p.target!==route.target||p.checkedAt>now+1000||p.expiresAt<=now)
    throw new ExecutionLimitError('authority','Billing evidence is expired or does not match the live provider/model/endpoint.');
}
export function readBillingEvidence(route:RouteCandidate|undefined,project:string,file=billingFile()):BillingEvidence|undefined {
  if(!route)return undefined;
  let fd:number;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw new ExecutionLimitError('authority','Cannot safely open local billing evidence.');}
  try{
    assertExecutionStoreOutsideProject(project,dirname(file));
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>131072||stat.nlink!==1||(stat.mode&0o022))throw new Error();
    const bytes=Buffer.alloc(131073),length=fs.readSync(fd,bytes,0,bytes.length,0);
    if(length>131072)throw new Error();
    const data:unknown=JSON.parse(bytes.subarray(0,length).toString('utf8'));
    shape(data,['version','profiles']);if(data.version!==1||!Array.isArray(data.profiles)||data.profiles.length>64)invalid();
    const profiles=data.profiles.map(validateBillingProfile),ids=new Set<string>();
    for(const p of profiles){const id=JSON.stringify([p.provider,p.model,p.target]);if(ids.has(id))invalid();ids.add(id);}
    const profile=profiles.find(p=>p.provider===route.provider&&p.model===route.model&&p.target===route.target);
    if(!profile)return undefined;
    const evidence={profile,hash:digest(canonicalJson(profile))};assertBillingCurrent(evidence,route);return evidence;
  }catch(error){if(error instanceof ExecutionLimitError&&error.code==='authority')throw error;throw new ExecutionLimitError('authority','Local billing evidence is malformed, unsafe or oversized.');}
  finally{fs.closeSync(fd);}
}
