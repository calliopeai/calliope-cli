import {agentStopped} from '../orchestration/execution-journal.js';
import {analyzePlan} from '../orchestration/validation.js';
import {OrchestrationError,type ProjectPlan} from '../orchestration/types.js';
import type {ExecutionInspection} from '../orchestration/coordinator-types.js';
import {assertSupervisedRetry} from './journal.js';

export interface SupervisionAvailability {
  version:1;executionRevision:string;observedAt:number;
  remainingCapacity:{agents:number;tasks:number};
  retryCapacity:{available:number;policy:'allowed'|'blocked';reason:string|null};
  retryTasks:{id:string;actions:('retry'|'replan')[];status:'blocked'|'possible';reason:string|null}[];
  childParents:{id:string;status:'blocked'|'possible';reason:string|null;remainingChildren:number;remainingDepth:number;deadline:number}[];
  limitations:string;
}

/** Preliminary checks of recorded state, never an approval or an admission receipt. */
export function supervisionAvailability(input:ProjectPlan,view:ExecutionInspection,observedAt:number):SupervisionAvailability {
  const createdAt=Date.parse(view.header.createdAt),{state,events}=view;
  if(![createdAt,observedAt,state.deadline].every(n=>Number.isSafeInteger(n)&&n>=0)||observedAt<createdAt||state.deadline<createdAt)throw new OrchestrationError('invalid','Invalid supervision availability clock.');
  const {plan,depths,hash}=analyzePlan(input),policy=plan.supervision;
  if(state.graph&&state.graph.hash!==hash)throw new OrchestrationError('conflict','Availability requires the current reviewed graph.');
  if(!policy)throw new OrchestrationError('invalid','Availability requires a supervised plan.');
  const capacity={agents:plan.limits.maxAgents-plan.agents.length,tasks:plan.limits.maxTasks-plan.tasks.length};
  const deadline=(id:string)=>Math.min(state.deadline,createdAt+plan.agents.find(a=>a.id===id)!.timeBudgetMs);
  const closed=state.status==='completed'?'The run is completed.':observedAt>=state.deadline?'The original run deadline expired.':null;
  const actions=policy.allowedActions.filter((action):action is 'retry'|'replan'=>action==='retry'||action==='replan');
  const retryTasks=plan.tasks.map(task=>{
    let reason=closed??(!actions.length?'The reviewed policy does not permit retry or replan.':agentStopped(state,{plan},task.agentId)?'This agent or an ancestor is stopped or escalated.':observedAt>=deadline(task.agentId)?'The original task agent deadline expired.':null);
    if(!reason)try{assertSupervisedRetry(plan,state,events,task.id);}catch(error){if(!(error instanceof OrchestrationError))throw error;reason=error.message;}
    return{id:task.id,actions:[...actions],status:reason?'blocked' as const:'possible' as const,reason};
  });
  const childParents=plan.agents.map(agent=>{
    const remainingChildren=agent.maxChildCount-plan.agents.filter(a=>a.parentId===agent.id).length;
    const remainingDepth=Math.min(agent.maxChildDepth,plan.limits.maxDepth-depths[agent.id]!);
    const reason=closed??(!policy.allowedActions.includes('decompose')?'The reviewed policy does not permit decomposition.':agentStopped(state,{plan},agent.id)?'This agent or an ancestor is stopped or escalated.':observedAt>=deadline(agent.id)?'The original parent deadline expired.':capacity.agents===0?'The reviewed agent count is exhausted.':capacity.tasks===0?'The reviewed task count is exhausted.':remainingChildren===0?'The parent child count is exhausted.':remainingDepth===0?'The parent child depth is exhausted.':null);
    return{id:agent.id,status:reason?'blocked' as const:'possible' as const,reason,remainingChildren,remainingDepth,deadline:deadline(agent.id)};
  });
  const retryCapacity={available:retryTasks.filter(task=>task.status==='possible').length,
    policy:actions.length?'allowed' as const:'blocked' as const,
    reason:actions.length?null:'The reviewed policy does not permit retry or replan.'};
  return{version:1,executionRevision:state.revision,observedAt,remainingCapacity:capacity,retryCapacity,retryTasks,childParents,
    limitations:'Possible means only these recorded state checks passed. It grants no authority. Application still requires current ownership, permissions, original deadlines, verified artifact/cleanup evidence, exact child contracts and scopes, dependencies, remaining budgets and child grants. Never approve a blocked action; revise the draft or stop if no valid action meets the reviewed goal.'};
}
