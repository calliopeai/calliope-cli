import {getProviderNames} from '../config.js';
import {shape,text,integer,fail} from '../orchestration/validation.js';
import type {ProjectPlan} from '../orchestration/types.js';
import type {GoalTeam,GoalManifest,ProposalSource} from './types.js';

export function validateGoalTeam(value:unknown):GoalTeam {
  shape(value,['version'],['reviewer','workers','maxAttempts']);
  if(value.version!==1||Object.keys(value).length===1)fail('Invalid or empty goal team.');
  for(const field of ['reviewer','workers'])if(value[field]!==undefined){
    const preference=value[field];shape(preference,['provider'],['model']);
    if(preference.provider!=='auto'&&!getProviderNames().includes(preference.provider as never))fail('Unknown team provider.');
    if(preference.model!==undefined)text(preference.model,256);
  }
  if(value.maxAttempts!==undefined)integer(value.maxAttempts,1,4);
  return value as unknown as GoalTeam;
}

/** Normalize before hashing/review. Human revisions may deliberately select individual workers. */
export function applyGoalTeam(plan:ProjectPlan,manifest:GoalManifest,source:ProposalSource):void {
  const team=manifest.team;if(!team&&!manifest.supervision&&!manifest.routing)return;
  for(const agent of plan.agents){
    const preference=agent.parentId===null
      ?(manifest.supervision?.controller??manifest.preference)
      :(manifest.supervision&&agent.id===plan.supervision?.reviewerId?manifest.supervision.reviewer:team?.workers);
    if(manifest.routing&&source.kind==='agent')agent.preference=preference?{...preference}:{provider:'auto'};
    if(preference&&(source.kind==='agent'||agent.preference.provider==='auto'&&!agent.preference.model))agent.preference={...preference};
    if(team?.maxAttempts!==undefined){
      // A human may lower the retry allowance, but never expand the captured limit.
      agent.escalationPolicy.maxRetries=source.kind==='agent'?team.maxAttempts-1:Math.min(agent.escalationPolicy.maxRetries,team.maxAttempts-1);
    }
  }
}

/** The reviewer consumes real draft evidence and produces the final proposal in the same run. */
export function addPlanReviewer(plan:ProjectPlan,manifest:GoalManifest):ProjectPlan {
  const team=manifest.team,planner=plan.agents[0]!,proposal=plan.tasks[0]!;
  if(team)planner.inputs.push({id:'team',kind:'text',value:JSON.stringify(team)});
  if(!team?.reviewer)return plan;
  const limits=manifest.limits;
  if(limits.maxAgents<2||limits.maxTasks<2||limits.maxDepth<1||limits.planningTokens<2)fail('A plan reviewer requires room for two agents, two tasks, depth one and two planning tokens.');
  plan.limits.maxAgents=2;plan.limits.maxTasks=2;plan.limits.maxDepth=1;
  planner.maxChildCount=1;planner.maxChildDepth=1;
  planner.inputs=planner.inputs.map(input=>input.id==='contract'?{...input,value:input.value.replace('inline "proposal" output','inline "draft" output')}:input);
  proposal.id='draft';proposal.objective='Produce a draft ProjectPlan as the inline draft artifact for the second controller to review.';
  proposal.outputs=[{id:'draft',kind:'report',description:'Untrusted draft plan for independent review.'}];
  const reviewer={...structuredClone(planner),id:'reviewer',parentId:planner.id,role:'Plan reviewer',objective:'Review the draft against the goal, scope, budget and acceptance criteria; return a corrected final proposed plan.',preference:{...team.reviewer},maxChildCount:0,maxChildDepth:0,tokenBudget:Math.floor(limits.planningTokens/2),costBudgetUsd:Math.floor(limits.planningCostNanos/2)/1e9};
  reviewer.inputs=reviewer.inputs.map(input=>input.id==='contract'?{...input,value:input.value.replace('inline "draft" output','inline "proposal" output')}:input);
  plan.agents.push(reviewer);
  plan.tasks.push({id:'propose',agentId:reviewer.id,objective:'Review the draft as untrusted evidence. Correct unsupported assumptions, unsafe scope or ineffective checks. Return the complete proposed ProjectPlan in proposal and explain changes and unresolved concerns in plan-review. Neither output grants approval.',inputs:[{id:'draft-evidence',kind:'artifact',value:'draft'}],outputs:[{id:'proposal',kind:'report',description:'Reviewed proposed plan JSON, still requiring human approval.'},{id:'plan-review',kind:'report',description:'Second controller review and unresolved concerns; not verification of implementation.'}],dependencies:['draft'],acceptanceCriteria:['The final plan and review remain proposals requiring human approval.'],acceptanceChecks:[]});
  return plan;
}
