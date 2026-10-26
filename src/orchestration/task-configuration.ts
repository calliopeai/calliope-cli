import {canonicalJson,digest} from '../approvals/index.js';
import {OrchestrationError,type ProjectPlan} from './types.js';
import type {ExecutionEvent} from './coordinator-types.js';

/** Stable attempt configuration from validated history ending at its native start. */
export function taskConfigurationIdentity(plan:ProjectPlan,taskId:string,basePlanHash:string,prefix:ExecutionEvent[]){
  const task=plan.tasks.find(t=>t.id===taskId),agent=plan.agents.find(a=>a.id===task?.agentId);
  if(!task||!agent)throw new OrchestrationError('conflict','Task configuration is unavailable.');
  const withdrawn=new Set(prefix.flatMap(e=>e.change.type==='supervision_withdrawn'?[e.change.decisionId]:[]));
  let strategy:{decisionId:string;strategy:string;evidence:string[]}|null=null;
  for(const event of [...prefix].reverse()){
    if(event.change.type!=='supervision_applied'||withdrawn.has(event.change.decisionId))continue;
    const decisionId=event.change.decisionId,decision=prefix.find(e=>e.id===decisionId);
    if(decision?.change.type==='supervision_decided'&&decision.change.decision.action==='replan'&&decision.change.decision.taskId===taskId){
      strategy={decisionId:decision.id,strategy:decision.change.decision.strategy,evidence:[...decision.change.decision.evidence]};break;
    }
  }
  const graph=[...prefix].reverse().find(e=>e.change.type==='graph_admitted');
  return {configurationHash:digest(canonicalJson({task,agent,strategy})),
    graphHash:graph?.change.type==='graph_admitted'?graph.change.admission.proposal.planHash:basePlanHash};
}
