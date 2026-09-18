/** Operator-reviewed evidence complements discovery; it never changes live model identity. */
import * as fs from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {canonicalJson,digest} from '../approvals/index.js';
import {getProviderNames} from '../config.js';
import type {HealthProvider} from '../health/types.js';
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
export interface FullContextBillingProfile {
  version:2; provider:HealthProvider; model:string; target:string;
  checkedAt:number; expiresAt:number; sources:string[];
  prices:{input:number;output:number};
  capabilities:{chat?:boolean;tools?:boolean;streaming?:boolean};
  limits:{contextLength:number;maxOutputTokens:number};
  admission:'reviewed-full-context-v1';
}
export type ReviewedBillingProfile=BillingProfile|FullContextBillingProfile;
export interface BillingEvidence {profile:ReviewedBillingProfile;hash:string}
export interface InputCount {version:1;method:'anthropic-count-tokens';requestHash:string;inputTokens:number;at:number}
export interface CountedQuoteEvidence {version:1;profileHash:string;profile:BillingProfile;count:InputCount;multiplier:2;slackTokens:1024}
export interface FullContextQuoteEvidence {
  version:2;profileHash:string;profile:FullContextBillingProfile;quotedAt:number;
  live:{discoveredAt:number;contextLength:number|null;maxOutputTokens:number|null;capabilities:FullContextBillingProfile['capabilities'];prices:{input:number|null;output:number|null}};
  requirements:{tools:boolean;streaming:boolean};measuredInput?:boolean;
}
export type QuoteEvidence=CountedQuoteEvidence|FullContextQuoteEvidence;
export const billingFile = ():string => resolve(process.env.CALLIOPE_BILLING_FILE || join(homedir(),'.calliope-cli','billing.json'));

export function validateBillingProfile(value:unknown):ReviewedBillingProfile {
  const full=!!value&&typeof value==='object'&&'version'in value&&value.version===2;
  shape(value,['provider','model','target','checkedAt','expiresAt','sources','prices','capabilities','admission',...(full?['version','limits']:[])]);
  if((full?(!getProviderNames().includes(value.provider as HealthProvider)||value.admission!=='reviewed-full-context-v1'):(value.provider!=='anthropic'||value.admission!=='provider-count-v1'))||typeof value.model!=='string'||!value.model||value.model.length>512||/[\x00-\x20\x7f]/.test(value.model)||!hex(value.target))invalid();
  integer(value.checkedAt,1,8640000000000000);integer(value.expiresAt,value.checkedAt+1,Math.min(8640000000000000,value.checkedAt+7*86400000));
  if(!Array.isArray(value.sources)||!value.sources.length||value.sources.length>8)invalid();
  for(const source of value.sources){
    if(typeof source!=='string'||source.length>2048)invalid();
    let url:URL;try{url=new URL(source);}catch{invalid();}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)invalid();
  }
  shape(value.prices,['input','output']);
  for(const price of Object.values(value.prices))if(typeof price!=='number'||!Number.isFinite(price)||price<0||price>1000000)invalid();
  shape(value.capabilities,[],[...(full?['chat']:[]),'tools','streaming']);
  if(Object.values(value.capabilities).some(v=>typeof v!=='boolean'))invalid();
  if(full){shape(value.limits,['contextLength','maxOutputTokens']);integer(value.limits.contextLength,1,100000000);integer(value.limits.maxOutputTokens,1,100000000);}
  return JSON.parse(canonicalJson(value)) as ReviewedBillingProfile;
}
export function validateInputCount(value:unknown):InputCount {
  shape(value,['version','method','requestHash','inputTokens','at']);
  if(value.version!==1||value.method!=='anthropic-count-tokens'||!hex(value.requestHash))invalid();
  integer(value.inputTokens,1,100000000);integer(value.at,1,8640000000000000);
  return value as unknown as InputCount;
}
/** Conservative bounds are reconstructed from recorded evidence during replay. */
export function fullContextTerms(proof:FullContextQuoteEvidence) {
  const {profile,live,requirements}=proof;
  for(const key of ['chat',...(requirements.tools?['tools']:[]),...(requirements.streaming?['streaming']:[])] as const){
    const k=key as keyof FullContextBillingProfile['capabilities'];
    if(live.capabilities[k]===false||(live.capabilities[k]??profile.capabilities[k])!==true)throw new ExecutionLimitError('authority','Live discovery or reviewed metadata did not confirm the required model capabilities.');
  }
  return{inputTokens:Math.max(profile.limits.contextLength,live.contextLength??0),maxOutputTokens:Math.min(profile.limits.maxOutputTokens,live.maxOutputTokens??100000000),inputPrice:Math.max(profile.prices.input,live.prices.input??0),outputPrice:Math.max(profile.prices.output,live.prices.output??0)};
}
export function validateQuoteEvidence(value:unknown):QuoteEvidence {
  shape(value,['version','profileHash','profile'],['count','multiplier','slackTokens','quotedAt','live','requirements','measuredInput']);
  if(!hex(value.profileHash))invalid();const profile=validateBillingProfile(value.profile);if(digest(canonicalJson(profile))!==value.profileHash)invalid();
  if(value.version===1){
    shape(value,['version','profileHash','profile','count','multiplier','slackTokens']);
    if(profile.admission!=='provider-count-v1'||value.multiplier!==2||value.slackTokens!==1024)invalid();validateInputCount(value.count);
  }else if(value.version===2){
    shape(value,['version','profileHash','profile','quotedAt','live','requirements'],['measuredInput']);if(profile.admission!=='reviewed-full-context-v1')invalid();
    if(value.measuredInput!==undefined&&typeof value.measuredInput!=='boolean')invalid();
    integer(value.quotedAt,Math.max(1,profile.checkedAt-1000),profile.expiresAt-1);
    shape(value.live,['discoveredAt','contextLength','maxOutputTokens','capabilities','prices']);integer(value.live.discoveredAt,Math.max(1,value.quotedAt-300000),value.quotedAt+1000);
    for(const key of ['contextLength','maxOutputTokens'])if(value.live[key]!==null)integer(value.live[key],1,100000000);
    shape(value.live.capabilities,[],['chat','tools','streaming']);if(Object.values(value.live.capabilities).some(v=>typeof v!=='boolean'))invalid();
    shape(value.live.prices,['input','output']);for(const p of Object.values(value.live.prices))if(p!==null&&(typeof p!=='number'||!Number.isFinite(p)||p<0||p>1000000))invalid();
    shape(value.requirements,['tools','streaming']);if(Object.values(value.requirements).some(v=>typeof v!=='boolean'))invalid();
    fullContextTerms(value as unknown as FullContextQuoteEvidence);
  }else invalid();
  return JSON.parse(canonicalJson(value)) as QuoteEvidence;
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
    shape(data,['version','profiles']);if(![1,2].includes(data.version as number)||!Array.isArray(data.profiles)||data.profiles.length>64)invalid();
    const profiles=data.profiles.map(validateBillingProfile),ids=new Set<string>();
    if(data.version===1&&profiles.some(p=>p.admission!=='provider-count-v1'))invalid();
    for(const p of profiles){const id=JSON.stringify([p.provider,p.model,p.target]);if(ids.has(id))invalid();ids.add(id);}
    const profile=profiles.find(p=>p.provider===route.provider&&p.model===route.model&&p.target===route.target);
    if(!profile)return undefined;
    const evidence={profile,hash:digest(canonicalJson(profile))};assertBillingCurrent(evidence,route);return evidence;
  }catch(error){if(error instanceof ExecutionLimitError&&error.code==='authority')throw error;throw new ExecutionLimitError('authority','Local billing evidence is malformed, unsafe or oversized.');}
  finally{fs.closeSync(fd);}
}

/** Size coordinator output before admission; the request guard rechecks all evidence. */
export function reviewedOutputLimit(route:RouteCandidate,project:string):number|null {
  const profile=readBillingEvidence(route,project)?.profile;
  return profile?.admission==='reviewed-full-context-v1'
    ?Math.min(route.maxOutputTokens??profile.limits.maxOutputTokens,profile.limits.maxOutputTokens)
    :route.maxOutputTokens;
}
