import {canonicalJson,digest} from '../approvals/index.js';
import {getProviderNames} from '../config.js';
import {HealthStore,providerTarget,summarizeHealth,type HealthEvent,type HealthProvider,type HealthSettings} from '../health/index.js';
import type {ExecutionProjection} from '../orchestration/coordinator-types.js';
import type {ProjectPlan} from '../orchestration/types.js';
import {array,fail,hex,integer,shape} from '../orchestration/validation.js';
import type {SupervisionHealthEvidence,SupervisionProviderHealth} from './types.js';

type HealthSource={read:()=>HealthEvent[];settings:HealthSettings};
const providersIn=(plan:ProjectPlan,state:ExecutionProjection):HealthProvider[]=>{
  const providers=new Set<HealthProvider>(),all=getProviderNames();
  for(const agent of plan.agents){
    if(agent.preference.provider==='auto'){
      const targets=[...(agent.routing?.pool??[]),...(agent.routing?.escalationPool??[])];
      if(targets.length)for(const target of targets)providers.add(target.provider);else for(const provider of all)providers.add(provider);
    }else providers.add(agent.preference.provider as HealthProvider);
    for(const policy of [agent.routing,agent.childRouting])for(const target of [...(policy?.pool??[]),...(policy?.escalationPool??[])])providers.add(target.provider);
  }
  for(const route of Object.values(state.routes??{}))providers.add(route.route.provider as HealthProvider);
  return [...providers].sort();
};

/** Capture no endpoints, credentials, upstream text or model content. */
export function supervisionHealthEvidence(plan:ProjectPlan,state:ExecutionProjection,options:{source?:HealthSource;now?:number}={}):SupervisionHealthEvidence {
  const now=options.now??Date.now(),observedAt=new Date(now).toISOString();
  try{
    const source=options.source??new HealthStore(),events=source.read(),providers=providersIn(plan,state),targets=providers.map(provider=>providerTarget(provider));
    const relevant=events.filter(event=>targets.some(target=>event.provider===target.provider&&event.target===target.key));
    const snapshots=targets.map(target=>summarizeHealth(events,target,source.settings,now) as SupervisionProviderHealth);
    return{version:1,observedAt,status:'available',historyHash:digest(canonicalJson(relevant.map(({id,sha256})=>({id,sha256})))),eventCount:relevant.length,providers:snapshots};
  }catch{return{version:1,observedAt,status:'unavailable',historyHash:null,eventCount:0,providers:[],reason:'local-health-history-unavailable'};}
}

const rate=(value:unknown)=>value===null||typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
const iso=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const instant=(value:unknown)=>value===null||iso(value);
export function validateSupervisionHealthEvidence(value:unknown):SupervisionHealthEvidence {
  shape(value,['version','observedAt','status','historyHash','eventCount','providers'],['reason']);
  if(value.version!==1||!iso(value.observedAt)||!['available','unavailable'].includes(String(value.status)))fail('Invalid supervision health evidence.');
  integer(value.eventCount,0,10000);array(value.providers,32);
  if(value.status==='unavailable'){
    if(value.historyHash!==null||value.eventCount!==0||value.providers.length||value.reason!=='local-health-history-unavailable')fail('Invalid unavailable supervision health evidence.');
    return value as unknown as SupervisionHealthEvidence;
  }
  if(!hex(value.historyHash)||value.reason!==undefined)fail('Invalid available supervision health evidence.');
  const names=getProviderNames(),seen=new Set<string>();
  for(const item of value.providers){
    shape(item,['provider','target','sampleCount','latencyMs','timeoutRate','retryRate','errorRate','lastSuccessAt','lastFailure','discovery','lastSuccessfulConformanceAt','capabilities','quarantine','importedEvents']);
    if(typeof item.provider!=='string'||!names.includes(item.provider as HealthProvider)||!hex(item.target)||seen.has(item.provider))fail('Invalid supervision provider health target.');seen.add(item.provider);
    integer(item.sampleCount,0,10000);integer(item.importedEvents,0,10000);if(item.latencyMs!==null)integer(item.latencyMs,0,86400000);
    if(!rate(item.timeoutRate)||!rate(item.retryRate)||!rate(item.errorRate)||!instant(item.lastSuccessAt)||!instant(item.lastSuccessfulConformanceAt))fail('Invalid supervision provider health metrics.');
    if(item.lastFailure!==null){shape(item.lastFailure,['at','kind','httpStatus']);if(!iso(item.lastFailure.at)||!['authentication','quota','rate_limit','timeout','network','server','invalid_request','response','unknown'].includes(String(item.lastFailure.kind))||item.lastFailure.httpStatus!==null&&(typeof item.lastFailure.httpStatus!=='number'||!Number.isSafeInteger(item.lastFailure.httpStatus)||item.lastFailure.httpStatus<100||item.lastFailure.httpStatus>599))fail('Invalid supervision provider failure.');}
    shape(item.discovery,['status','at','modelCount']);if(!['success','error','timeout','cancelled','unknown'].includes(String(item.discovery.status))||!instant(item.discovery.at)||item.discovery.modelCount!==null&&(typeof item.discovery.modelCount!=='number'||!Number.isSafeInteger(item.discovery.modelCount)||item.discovery.modelCount<0||item.discovery.modelCount>1000000))fail('Invalid supervision provider discovery.');
    shape(item.capabilities,['tools','streaming','cancellation','usage']);if(Object.values(item.capabilities).some(capability=>capability!=='unknown'&&typeof capability!=='boolean'))fail('Invalid supervision provider capabilities.');
    shape(item.quarantine,['active','reason','expiresAt','failures']);if(typeof item.quarantine.active!=='boolean'||item.quarantine.reason!==null&&!['authentication','quota','rate_limit','timeout','network','server','invalid_request','response','unknown'].includes(String(item.quarantine.reason))||!instant(item.quarantine.expiresAt))fail('Invalid supervision provider quarantine.');integer(item.quarantine.failures,0,100);
  }
  return value as unknown as SupervisionHealthEvidence;
}
