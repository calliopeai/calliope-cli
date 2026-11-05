/** Native parent execution slots. Lost connections never release an admission. */
import {dirname,join} from 'node:path';
import {ReservationLedger} from '../execution/ledger.js';
import {parentTaskCapacity} from '../execution/parent-budget.js';
import {canonicalJson,digest} from '../approvals/index.js';
import {ExecutionLimitError} from '../execution/types.js';
import type {ExecutionStore} from './execution-store.js';
import type {ExecutionProjection,RunPlanContext} from './coordinator-types.js';
import {shape,hex,uuid,id,text,integer,fail} from './validation.js';

export type RemoteTaskAdmission = {
  version:1;id:string;runId:string;manifestHash:string;
  startEventId:string;startEventHash:string;sessionId:string;agentId:string;deadline:number;
} & ({kind?:'task';taskId:string;attempt:number}|{kind:'supervision';role:'controller'|'reviewer';round:number});
type AdmissionInput = RemoteTaskAdmission extends infer A ? A extends RemoteTaskAdmission ? Omit<A,'id'> : never : never;
export function remoteTaskAdmission(value:AdmissionInput):RemoteTaskAdmission {
  return validateRemoteTaskAdmission({...value,id:digest(canonicalJson(value))});
}
export function validateRemoteTaskAdmission(value:unknown):RemoteTaskAdmission {
  shape(value,['version','id','runId','manifestHash','startEventId','startEventHash','sessionId','agentId','deadline'],['kind','taskId','attempt','role','round']);
  if(value.version!==1||!hex(value.id)||!uuid(value.runId)||!hex(value.manifestHash)||!uuid(value.startEventId)||!hex(value.startEventHash))fail('Invalid remote task admission.');
  if(value.kind==='supervision'){
    shape(value,['version','id','runId','manifestHash','startEventId','startEventHash','sessionId','agentId','deadline','kind','role','round']);
    if(value.role!=='controller'&&value.role!=='reviewer')fail('Invalid remote supervision role.');integer(value.round,1,64);
  }else{
    shape(value,['version','id','runId','manifestHash','startEventId','startEventHash','sessionId','agentId','deadline','taskId','attempt'],['kind']);
    if(value.kind!==undefined&&value.kind!=='task')fail('Invalid remote admission kind.');id(value.taskId);integer(value.attempt,1,4);
  }
  id(value.agentId);text(value.sessionId,128);integer(value.deadline,1,8640000000000000);
  const {id:hash,...body}=value;if(hash!==digest(canonicalJson(body)))fail('Remote task admission hash changed.');
  return JSON.parse(canonicalJson(value)) as RemoteTaskAdmission;
}
export function activeRemoteTasks(state:ExecutionProjection):RemoteTaskAdmission[] {
  return Object.values(state.remoteTasks??{}).filter(item=>item.status==='active').map(item=>item.admission);
}
export function occupiedExecutionSlots(state:ExecutionProjection):number {
  return Object.values(state.tasks).filter(task=>task.status==='running').length+activeRemoteTasks(state).length+(state.supervision?.active?1:0);
}
export function remoteScopesConflict(state:ExecutionProjection,context:RunPlanContext,agentId:string):boolean {
  const agent=context.plan.agents.find(item=>item.id===agentId);if(!agent)return true;
  const overlaps=(otherId:string)=>{const other=context.plan.agents.find(item=>item.id===otherId);return !other||agent.allowedPaths.some(a=>other.allowedPaths.some(b=>(a.access==='write'||b.access==='write')&&(a.path==='.'||b.path==='.'||a.path===b.path||a.path.startsWith(b.path+'/')||b.path.startsWith(a.path+'/'))));};
  return !!state.supervision?.active&&overlaps(state.supervision.active.agentId)||activeRemoteTasks(state).some(other=>overlaps(other.agentId))||Object.values(state.tasks).some(task=>task.status==='running'&&overlaps(task.agentId));
}
export async function admitRemoteTask(store:ExecutionStore,input:unknown,assertActive:()=>void,signal?:AbortSignal):Promise<void> {
  const admission=validateRemoteTaskAdmission(input);
  await store.transaction(async prior=>{
    assertActive();const existing=prior.state.remoteTasks?.[admission.id];
    if(existing){if(canonicalJson(existing.admission)!==canonicalJson(admission)||existing.status!=='active')throw new ExecutionLimitError('authority','Remote task admission is no longer active.');await parentTaskCapacity(new ReservationLedger(join(dirname(store.root),'budget')).read(store.manifest.project.root).manifest,store.manifest.project.root,admission,false,signal);return [];}
    const context=store.context(prior),agent=context.plan.agents.find(item=>item.id===admission.agentId);
    if(!agent||admission.runId===context.id||prior.state.status==='completed'||admission.deadline>Math.min(prior.header.deadline,Date.parse(prior.header.createdAt)+agent.timeBudgetMs)||Date.now()>=admission.deadline)throw new ExecutionLimitError('authority','Remote task has no current parent execution authority.');
    if(occupiedExecutionSlots(prior.state)>=context.plan.limits.maxConcurrent)throw new ExecutionLimitError('limit','Parent execution concurrency is full.');
    if(remoteScopesConflict(prior.state,context,admission.agentId))throw new ExecutionLimitError('limit','Parent execution scopes are busy.');
    await parentTaskCapacity(new ReservationLedger(join(dirname(store.root),'budget')).read(store.manifest.project.root).manifest,store.manifest.project.root,admission,false,signal);
    return [{change:{type:'remote_task_admitted',admission}}];
  },signal,assertActive);
}
export async function releaseRemoteTask(store:ExecutionStore,input:unknown,signal?:AbortSignal):Promise<void> {
  const admission=validateRemoteTaskAdmission(input);
  await store.transaction(async prior=>{
    const existing=prior.state.remoteTasks?.[admission.id];
    if(!existing||canonicalJson(existing.admission)!==canonicalJson(admission))throw new ExecutionLimitError('authority','Remote task release has no matching admission.');
    return existing.status==='released'?[]:[{change:{type:'remote_task_released',admissionId:admission.id}}];
  },signal);
  await parentTaskCapacity(new ReservationLedger(join(dirname(store.root),'budget')).read(store.manifest.project.root).manifest,store.manifest.project.root,admission,true,signal);
}
