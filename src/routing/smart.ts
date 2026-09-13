import {approvalDisplayText} from '../approvals/request.js';
import {getProviderNames} from '../config.js';
import type {HealthProvider} from '../health/index.js';
import type {ModelInfo} from '../models/index.js';

export interface SmartTarget {provider:HealthProvider;model?:string}
/** The operator supplies eligible models; price or a model name is not quality evidence. */
export interface SmartRoutingPolicy {
  version:1;profile:'cost'|'balanced'|'speed';pool:SmartTarget[];escalationPool?:SmartTarget[];
}
export interface SmartRoutingSelection {
  policy:SmartRoutingPolicy;stage:'initial'|'escalation';evidenceId?:string;
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;
function invalid():never {throw new Error('Invalid Smart routing policy: use version 1, a cost/balanced/speed profile and 1–32 unique provider/model targets per pool.');}
export function validateSmartPolicy(value:unknown):SmartRoutingPolicy {
  if(!object(value)||value.version!==1||!['cost','balanced','speed'].includes(value.profile as string)||Object.keys(value).some(key=>!['version','profile','pool','escalationPool'].includes(key)))invalid();
  for(const pool of [value.pool,...(value.escalationPool===undefined?[]:[value.escalationPool])]){
    if(!Array.isArray(pool)||pool.length<1||pool.length>32)invalid();
    const seen=new Set<string>();
    for(const target of pool){
      if(!object(target)||!getProviderNames().includes(target.provider as HealthProvider)||Object.keys(target).some(key=>!['provider','model'].includes(key))||target.model!==undefined&&(typeof target.model!=='string'||!target.model.trim()||target.model.length>256||approvalDisplayText(target.model)!==target.model||/[\x00-\x1f\x7f]/.test(target.model)))invalid();
      const key=JSON.stringify([target.provider,target.model??null]);if(seen.has(key))invalid();seen.add(key);
    }
  }
  return structuredClone(value) as unknown as SmartRoutingPolicy;
}
export function validateSmartSelection(value:unknown):SmartRoutingSelection {
  if(!object(value)||Object.keys(value).some(key=>!['policy','stage','evidenceId'].includes(key))||!['initial','escalation'].includes(value.stage as string))invalid();
  const policy=validateSmartPolicy(value.policy);
  if(value.stage==='escalation'?!policy.escalationPool||typeof value.evidenceId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.evidenceId):value.evidenceId!==undefined)invalid();
  return {policy,stage:value.stage as SmartRoutingSelection['stage'],...(value.evidenceId?{evidenceId:value.evidenceId as string}:{})};
}
export function smartPool(selection:SmartRoutingSelection):SmartTarget[] {
  return selection.stage==='escalation'?selection.policy.escalationPool!:selection.policy.pool;
}
export function smartTargetMatches(pool:SmartTarget[],provider:string,model:Pick<ModelInfo,'id'|'aliases'>):boolean {
  return pool.some(target=>target.provider===provider&&(target.model===undefined||target.model===model.id||model.aliases?.includes(target.model)));
}
/** Descendant policies can narrow an approved pool, never introduce another target. */
export function smartPolicyWithin(child:SmartRoutingPolicy,parent:SmartRoutingPolicy):boolean {
  const within=(targets:SmartTarget[],allowed:SmartTarget[])=>targets.every(target=>allowed.some(a=>a.provider===target.provider&&(a.model===undefined||a.model===target.model)));
  return within(child.pool,parent.pool)&&(!child.escalationPool||!!parent.escalationPool&&within(child.escalationPool,parent.escalationPool));
}
export function smartScore(profile:SmartRoutingPolicy['profile'],scores:{support:number;health:number;latency:number;cost:number}):number {
  const {support,health,latency,cost}=scores;
  return profile==='cost'?support*.25+health*.25+latency*.05+cost*.45:profile==='speed'?support*.3+health*.25+latency*.4+cost*.05:support*.4+health*.35+latency*.15+cost*.1;
}
