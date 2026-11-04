import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {canonicalJson} from '../approvals/index.js';
import { authorizeSessionAction } from '../session-management/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { ReservationLedger, ExecutionLimitError, manifestHash, validateExecutionManifest, assertExecutionStoreOutsideProject,type ExecutionManifest, type AgentExecution } from '../execution/index.js';
import {ExecutionStore} from './execution-store.js';
import {inspectSpawnAuthority} from '../spawning/authority.js';
import { RunStore, validateRunManifest } from './store.js';
import { type RunManifest, OrchestrationError } from './types.js';
import type { RunActionOptions } from './actions.js';
import {validateParentBudgetLink} from '../execution/authority.js';
import {parentBudgetAuthority} from '../execution/parent-budget.js';

/** Build a bounded runtime contract from the immutable reviewed plan, not worker output. */
export function executionManifestForRun(input:RunManifest,now=Date.now()):ExecutionManifest {
  const manifest=validateRunManifest(input),plan=manifest.plan;
  return validateExecutionManifest({version:1,runId:manifest.id,planHash:manifest.planHash,project:manifest.project,createdAt:now,deadline:now+plan.limits.timeBudgetMs,
    tokenBudget:plan.limits.tokenBudget,costBudgetNanos:Math.floor(plan.limits.costBudgetUsd*1e9),
    accounts:plan.agents.map(agent=>({id:agent.id,parentId:agent.parentId,tokenBudget:agent.tokenBudget,costBudgetNanos:Math.floor(agent.costBudgetUsd*1e9),deadline:now+agent.timeBudgetMs,allowedTools:agent.allowedTools,allowedPaths:agent.allowedPaths}))});
}
/** Library boundary only; preparing a budget never launches a worker or spends tokens. */
export async function prepareAgentExecution(cwd:string,runId:string,agentId:string,maxOutputTokens:number,options:RunActionOptions & {reviewedProviderTargets?:Readonly<Record<string,string>>}={}):Promise<AgentExecution> {
  const store=options.store??new RunStore(),view=await store.read(runId,cwd,options.signal);
  assertExecutionStoreOutsideProject(view.manifest.project.root,store.root);
  if(view.run.status!=='approved')throw new OrchestrationError('policy-denied','Run must be explicitly approved before preparing execution authority.');
  const executionStore=new ExecutionStore(join(store.root,runId),view.manifest),context=executionStore.exists()?executionStore.context():view.manifest;
  if(!context.plan.agents.some(a=>a.id===agentId)||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>100000000)throw new OrchestrationError('invalid','Unknown agent or invalid output limit.');
  const ledger=new ReservationLedger(join(store.root,runId,'budget'));
  const existing=existsSync(ledger.root)?ledger.read(cwd).manifest:undefined;
  const selected=options.parentBudget===undefined?undefined:validateParentBudgetLink(options.parentBudget);
  if(existing&&selected&&canonicalJson(existing.parent??null)!==canonicalJson(selected))throw new OrchestrationError('conflict','An existing run budget cannot change its parent allowance.');
  const parent=selected??existing?.parent;
  await authorizeSessionAction(cwd,'orchestration_budget',{path:cwd,runId,agentId,planHash:view.manifest.planHash,revision:view.run.revision,maxOutputTokens,...(options.reviewedProviderTargets?{providerTargets:options.reviewedProviderTargets}:{}),...(parent?{parentBudget:parent}:{})},options);
  throwIfCancelled(options.signal);const latest=await store.read(runId,cwd,options.signal);
  if(latest.run.revision!==view.run.revision)throw new OrchestrationError('conflict','Run approval changed while authorizing execution.');
  const {goalRunAuthority}=await import('../goals/index.js'),goalAuthority=goalRunAuthority(view.manifest,store.root);
  let manifest=existing??executionManifestForRun(view.manifest,goalAuthority?.createdAt);
  if(parent){
    manifest=validateExecutionManifest({...manifest,version:2,parent});
  }
  if(manifest.runId!==runId||manifest.planHash!==view.manifest.planHash)throw new OrchestrationError('conflict','Budget belongs to another run plan.');
  goalAuthority?.checkBudget(manifest);
  const funding=await parentBudgetAuthority(manifest,cwd,true,options.signal);
  ledger.create(manifest,options.signal);
  const assertAuthority=()=>{
    executionStore.assertApproval({approvalRevision:view.run.revision});goalAuthority?.assertActive();funding?.assertActive();
    if(executionStore.exists()){
      const current=inspectSpawnAuthority(executionStore,ledger);executionStore.assertApproval(current.view.header);
      if(!current.context.plan.agents.some(a=>a.id===agentId))throw new OrchestrationError('policy-denied','Agent is not admitted to the current graph.');
      if(current.view.state.status==='completed')throw new ExecutionLimitError('authority','Agent execution is completed; no new work is authorized.');
      // Explicit stop controls fence handles. Task failures/escalations stay with
      // the coordinator, which must still finalize their original outcomes.
      let agent=current.context.plan.agents.find(a=>a.id===agentId);
      while(agent){
        if(current.view.state.stoppedAgents.includes(agent.id))throw new ExecutionLimitError('authority','Agent execution is stopped; no new work is authorized.');
        agent=current.context.plan.agents.find(a=>a.id===agent!.parentId);
      }
    }
  };
  assertAuthority();return {ledger,manifestHash:manifestHash(manifest),agentId,maxOutputTokens,assertAuthority};
}
