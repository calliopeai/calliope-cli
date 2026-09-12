import {isReasoningEffort} from '../models/index.js';
import {fail,id,integer,permits,planJson,shape,strings,text,uuid} from '../orchestration/validation.js';
import type {ProjectPlan} from '../orchestration/types.js';
import {extendPlan,validateSpawnInput} from '../spawning/validation.js';
import type {SupervisionPolicy,SupervisionDecision,SupervisionAction} from './types.js';

export const MAX_SUPERVISION_ROUNDS=64,MAX_SUPERVISION_DECISION_BYTES=64*1024;
const actions=['retry','replan','decompose'];
const principles=['speed','robustness','stability','security','performance','cost'];

export function validateSupervisionPolicy(value:unknown,plan:ProjectPlan):SupervisionPolicy {
  shape(value,['version','controllerId','maxRounds','maxStalledRounds','maxOutputTokens','principle','allowedActions'],['reviewerId','reasoningEffort']);
  if(value.version!==1)fail('Unsupported supervision policy version.');
  id(value.controllerId);
  const controller=plan.agents.find(agent=>agent.id===value.controllerId);
  if(!controller||controller.parentId!==null)fail('Supervision must use the reviewed root coordinator account.');
  integer(value.maxRounds,1,MAX_SUPERVISION_ROUNDS);
  integer(value.maxStalledRounds,1,value.maxRounds);
  integer(value.maxOutputTokens,1,Math.min(8192,controller.tokenBudget));
  if(!principles.includes(String(value.principle)))fail('Unknown supervision optimization principle.');
  strings(value.allowedActions,actions.length);
  if(value.allowedActions.some(action=>!actions.includes(action)))fail('Unknown supervised action.');
  if(value.allowedActions.length&&!plan.workspace.isolation)fail('Automatic supervised work requires isolated candidates.');
  if(value.reviewerId!==undefined){
    id(value.reviewerId);
    const reviewer=plan.agents.find(agent=>agent.id===value.reviewerId);
    if(!reviewer||reviewer.id===controller.id)fail('The supervision reviewer needs a distinct reviewed agent account.');
    if(value.maxOutputTokens>reviewer.tokenBudget)fail('The reviewer output cap exceeds its original token allowance.');
  }
  if(value.reasoningEffort!==undefined){
    shape(value.reasoningEffort,[],['controller','reviewer']);
    if(!Object.keys(value.reasoningEffort).length||Object.values(value.reasoningEffort).some(effort=>!isReasoningEffort(effort)))fail('Unknown or empty supervision reasoning effort.');
    if(value.reasoningEffort.reviewer!==undefined&&value.reviewerId===undefined)fail('Reviewer effort requires a reviewed reviewer account.');
  }
  for(const agentId of [value.controllerId,value.reviewerId].filter(id=>id!==undefined)){
    const agent=plan.agents.find(a=>a.id===agentId)!;
    if(plan.tasks.some(task=>task.outputs.some(output=>output.path&&!permits(agent.allowedPaths,output.path,'read'))))fail('Controller and reviewer read scopes must cover the reviewed task artifacts.');
  }
  return JSON.parse(planJson(value)) as SupervisionPolicy;
}

/** Validate data and evidence references here; admission rechecks live graph state and authority. */
export function validateSupervisionDecision(value:unknown,policy:SupervisionPolicy,plan:ProjectPlan,evidenceIds:ReadonlySet<string>):SupervisionDecision {
  const raw=planJson(value);
  if(Buffer.byteLength(raw)>MAX_SUPERVISION_DECISION_BYTES)fail('Supervision decision exceeds its byte limit.');
  shape(value,['version','action','reason','evidence'],['taskId','strategy','children','hypothesis','expectedMetric']);
  if(value.version!==1||!['continue','stop',...actions].includes(String(value.action)))fail('Unknown supervision decision or version.');
  text(value.reason);strings(value.evidence,128,1);
  if(value.evidence.some(ref=>!uuid(ref)||!evidenceIds.has(ref)))fail('Controller decisions require recorded evidence from this review.');
  const base=['version','action','reason','evidence'];
  if(value.action==='continue'||value.action==='stop')shape(value,base);
  else {
    if(!policy.allowedActions.includes(value.action as SupervisionAction))fail('The reviewed supervision policy does not permit this action.');
    const improvement=['hypothesis','expectedMetric'];
    shape(value,[...base,...improvement,...(value.action==='decompose'?['children']:value.action==='replan'?['taskId','strategy']:['taskId'])]);
    text(value.hypothesis);shape(value.expectedMetric,['name','direction']);text(value.expectedMetric.name,128);
    if(!['increase','decrease'].includes(String(value.expectedMetric.direction)))fail('An improvement metric needs an explicit direction.');
    if(value.action==='decompose'){
      extendPlan(plan,validateSpawnInput(value.children));
      // A structurally valid graph still needs current policy and a recorded ledger grant.
    }else {
      id(value.taskId);
      if(!plan.tasks.some(task=>task.id===value.taskId))fail('Supervision cannot revise an unknown task.');
      if(value.action==='replan')text(value.strategy);
    }
  }
  return JSON.parse(raw) as SupervisionDecision;
}
