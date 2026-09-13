import {approvalDisplayText} from '../approvals/index.js';
import {getProviderNames} from '../config.js';
import {smartPool,smartTargetMatches,type SmartRoutingPolicy,type SmartRoutingSelection} from '../routing/smart.js';
import type {RoutingDecision} from '../routing/types.js';
import type {ExecutionEvent,RunPlanContext} from './coordinator-types.js';
import type {ExecutionStore} from './execution-store.js';
import {shape,text,uuid,fail} from './validation.js';

export interface RecordedAgentRoute {
  version:1;decisionId:string;provider:string;model:string;reason:string;
  profile:SmartRoutingPolicy['profile'];stage:SmartRoutingSelection['stage'];evidenceId?:string;
}
/** Only a recorded failed check with immutable evidence opens the escalation pool. */
export function taskSmartSelection(policy:SmartRoutingPolicy,events:ExecutionEvent[],taskId?:string):SmartRoutingSelection {
  const last=taskId?[...events].reverse().find(event=>event.change.type==='task_finished'&&event.change.taskId===taskId):undefined;
  const c=last?.change;
  return policy.escalationPool&&c?.type==='task_finished'&&c.status==='failed'&&c.output.checks.some(check=>!check.passed&&check.observedHash!==null&&c.output.artifacts.some(artifact=>artifact.id===check.artifactId&&artifact.sha256===check.observedHash))
    ?{policy,stage:'escalation',evidenceId:last!.id}:{policy,stage:'initial'};
}
export function validateRecordedRoute(value:unknown,context:RunPlanContext,agentId:string):RecordedAgentRoute {
  shape(value,['version','decisionId','provider','model','reason','profile','stage'],['evidenceId']);
  const agent=context.plan.agents.find(a=>a.id===agentId),policy=agent?.routing;
  if(value.version!==1||!uuid(value.decisionId)||!policy||value.profile!==policy.profile||!['initial','escalation'].includes(String(value.stage)))fail('Route evidence requires the reviewed agent Smart policy.');
  text(value.provider,64);text(value.model,256);text(value.reason,4096);
  if(!getProviderNames().includes(value.provider as never))fail('Unknown routed provider.');
  if(value.stage==='escalation'?!policy.escalationPool||!uuid(value.evidenceId):value.evidenceId!==undefined)fail('Escalated routing requires recorded verification evidence.');
  const preference=agent!.preference;
  if(preference.provider!=='auto'&&preference.provider!==value.provider||preference.model&&preference.model!==value.model)fail('Routing evidence changed an explicit agent pin.');
  if(!preference.model&&(preference.provider==='auto'||smartPool({policy,stage:value.stage as SmartRoutingSelection['stage']}).some(t=>t.provider===preference.provider))&&!smartTargetMatches(smartPool({policy,stage:value.stage as SmartRoutingSelection['stage']}),value.provider,{id:value.model}))fail('Routing evidence exceeds the reviewed model pool.');
  return value as unknown as RecordedAgentRoute;
}
/** Await the event before dispatch so failure to record cannot send a paid request. */
export async function recordAgentRoute(store:ExecutionStore,agentId:string,sessionId:string,decision:RoutingDecision,signal:AbortSignal,assertActive:()=>void,taskId?:string):Promise<void> {
  if(!decision.selected||!decision.smart)return;
  const route:RecordedAgentRoute={version:1,decisionId:decision.id,provider:decision.selected.provider,model:decision.selected.model,reason:approvalDisplayText(decision.reason).slice(0,4096),...decision.smart};
  await store.append({type:'agent_routed',agentId,sessionId,...(taskId?{taskId}:{}),route},signal,undefined,assertActive);
}
