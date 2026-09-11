import {join,resolve} from 'node:path';
import {canonicalJson} from '../approvals/index.js';
import {ReservationLedger} from '../execution/ledger.js';
import {ExecutionLimitError,type ExecutionManifest} from '../execution/types.js';
import type {RunManifest} from '../orchestration/types.js';
import {GoalStore} from './store.js';
import {validateGoalLink} from './validation.js';
import {plannerPlan} from './contracts.js';
import {permits} from '../orchestration/validation.js';

/** All linked run entry points use this authority, including direct `calliope run`. */
export function goalRunAuthority(manifest:RunManifest,runRoot:string):{createdAt:number;assertActive:()=>void;checkBudget:(budget:ExecutionManifest)=>void}|undefined {
  if(manifest.version!==2)return undefined;const link=validateGoalLink(manifest.goal),goals=new GoalStore(link.root);
  const inspect=()=>{
    const view=goals.read(link.id,manifest.project.root),m=view.manifest,a=link.phase==='planning'?view.state.planning:view.state.execution;
    if(m.hash!==link.manifestHash||m.runsRoot!==resolve(runRoot)||manifest.createdAt!==m.createdAt||!a||a.id!==link.allocationId||a.runId!==manifest.id||a.planHash!==manifest.planHash)throw new ExecutionLimitError('authority','Run does not match its parent goal allocation.');
    if(view.state.revoked||view.state.status==='completed'||link.phase==='planning'&&(view.state.status!=='planning'||view.state.planningFrozen)||link.phase==='execution'&&!view.state.approvedProposalHash)throw new ExecutionLimitError('authority','Parent goal approval is absent, frozen or revoked.');
    if(Date.now()>=a.deadline)throw new ExecutionLimitError('deadline','Original goal allocation deadline expired.');
    const plan=manifest.plan;if(plan.limits.tokenBudget!==a.tokens||Math.floor(plan.limits.costBudgetUsd*1e9)!==a.costNanos||Date.parse(m.createdAt)+plan.limits.timeBudgetMs!==a.deadline)throw new ExecutionLimitError('authority','Run allowance differs from its goal allocation.');
    if(link.phase==='planning'){
      if((m.version===2?canonicalJson(plan)!==canonicalJson(plannerPlan(m)):plan.agents.length!==1||plan.tasks.length!==1)||plan.workspace.allowedTools.some(t=>!['think','read_file','list_files'].includes(t)||!m.workspace.allowedTools.includes(t))||plan.workspace.allowedPaths.some(p=>p.access!=='read'||!permits(m.workspace.allowedPaths,p.path,p.access)))throw new ExecutionLimitError('authority','A planner cannot expand goal scope, mutate or create workers.');
    }else{
      const frozen=view.state.planningSpend!,planner=view.state.planning!,ledger=new ReservationLedger(join(m.runsRoot,planner.runId,'budget')).read(m.project.root);
      if(ledger.projection.exceeded||ledger.manifest.runId!==planner.runId||ledger.manifest.planHash!==planner.planHash||ledger.projection.revision!==frozen.revision||ledger.projection.spent.tokens!==frozen.tokens||ledger.projection.spent.costNanos!==frozen.costNanos)throw new ExecutionLimitError('authority','Frozen planning spend changed or is unavailable.');
    }
    return{view,allocation:a};
  };
  const initial=inspect();
  return{createdAt:Date.parse(initial.view.manifest.createdAt),assertActive:()=>{inspect();},checkBudget:budget=>{
    const {allocation:a}=inspect();if(budget.createdAt!==Date.parse(manifest.createdAt)||budget.deadline!==a.deadline||budget.tokenBudget!==a.tokens||budget.costBudgetNanos!==a.costNanos)throw new ExecutionLimitError('authority','Linked run budget refreshed its goal allowance or deadline.');
    const expected=manifest.plan.agents.map(agent=>({id:agent.id,parentId:agent.parentId,tokenBudget:agent.tokenBudget,costBudgetNanos:Math.floor(agent.costBudgetUsd*1e9),deadline:Date.parse(manifest.createdAt)+agent.timeBudgetMs,allowedTools:agent.allowedTools,allowedPaths:agent.allowedPaths}));
    if(canonicalJson(budget.accounts)!==canonicalJson(expected))throw new ExecutionLimitError('authority','Linked agent accounts differ from the reviewed goal plan.');
  }};
}
