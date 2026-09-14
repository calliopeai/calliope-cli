import {canonicalJson,digest} from '../approvals/index.js';
import {analyzePlan,fail} from '../orchestration/validation.js';
import type {ProjectPlan} from '../orchestration/types.js';
import {validateSupervisionDecision} from './contracts.js';
import type {SupervisionDecision} from './types.js';

export interface SupervisionDraftEffect {
  version:1;draftHash:string;action:SupervisionDecision['action'];
  retryTaskIds:string[];newAgentIds:string[];newTaskIds:string[];
  maxConcurrent:number;summary:string;
}

/** Describes the validated structural action, never a grant or a prediction of success. */
export function supervisionDraftEffect(input:unknown,plan:ProjectPlan,evidenceIds:ReadonlySet<string>):SupervisionDraftEffect {
  const checked=analyzePlan(plan).plan;
  if(!checked.supervision)fail('A draft effect requires a supervised plan.');
  const draft=validateSupervisionDecision(input,checked.supervision,checked,evidenceIds);
  const retry=draft.action==='retry'||draft.action==='replan',decompose=draft.action==='decompose';
  const summary=retry
    ? 'Requests one new attempt of the named existing task; creates no agents or tasks. Other tasks are not retried by this decision.'+(draft.action==='replan'?' Strategy text guides that attempt; references to later work do not schedule later actions.':'')
    : decompose?'Requests admission of the named new agents and tasks within existing limits. Ready tasks remain subject to dependencies, conflicts and maxConcurrent.'
    : draft.action==='continue'?'Requests executor acceptance and scheduling checks; creates no agents, tasks or retries and cannot declare completion.'
    : 'Requests that supervision stop; creates no agents, tasks or retries and does not claim the goal is complete.';
  return{version:1,draftHash:digest(canonicalJson(draft)),action:draft.action,retryTaskIds:retry?[draft.taskId]:[],
    newAgentIds:decompose?draft.children.agents.map(a=>a.id):[],newTaskIds:decompose?draft.children.tasks.map(t=>t.id):[],maxConcurrent:checked.limits.maxConcurrent,summary};
}
