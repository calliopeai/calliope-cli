import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { authorizeSessionAction } from '../session-management/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { ReservationLedger, manifestHash, validateExecutionManifest, assertExecutionStoreOutsideProject,type ExecutionManifest, type AgentExecution } from '../execution/index.js';
import {ExecutionStore} from './execution-store.js';
import {inspectSpawnAuthority} from '../spawning/authority.js';
import { RunStore, validateRunManifest } from './store.js';
import { type RunManifest, OrchestrationError } from './types.js';
import type { RunActionOptions } from './actions.js';

/** Build a bounded runtime contract from the immutable reviewed plan, not worker output. */
export function executionManifestForRun(input:RunManifest,now=Date.now()):ExecutionManifest {
  const manifest=validateRunManifest(input),plan=manifest.plan;
  return validateExecutionManifest({version:1,runId:manifest.id,planHash:manifest.planHash,project:manifest.project,createdAt:now,deadline:now+plan.limits.timeBudgetMs,
    tokenBudget:plan.limits.tokenBudget,costBudgetNanos:Math.floor(plan.limits.costBudgetUsd*1e9),
    accounts:plan.agents.map(agent=>({id:agent.id,parentId:agent.parentId,tokenBudget:agent.tokenBudget,costBudgetNanos:Math.floor(agent.costBudgetUsd*1e9),deadline:now+agent.timeBudgetMs,allowedTools:agent.allowedTools,allowedPaths:agent.allowedPaths}))});
}
/** Library boundary only; preparing a budget never launches a worker or spends tokens. */
export async function prepareAgentExecution(cwd:string,runId:string,agentId:string,maxOutputTokens:number,options:RunActionOptions={}):Promise<AgentExecution> {
  const store=options.store??new RunStore(),view=await store.read(runId,cwd,options.signal);
  assertExecutionStoreOutsideProject(view.manifest.project.root,store.root);
  if(view.run.status!=='approved')throw new OrchestrationError('policy-denied','Run must be explicitly approved before preparing execution authority.');
  const executionStore=new ExecutionStore(join(store.root,runId),view.manifest),context=executionStore.exists()?executionStore.context():view.manifest;
  if(!context.plan.agents.some(a=>a.id===agentId)||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>100000000)throw new OrchestrationError('invalid','Unknown agent or invalid output limit.');
  await authorizeSessionAction(cwd,'orchestration_budget',{path:cwd,runId,agentId,planHash:view.manifest.planHash,revision:view.run.revision,maxOutputTokens},options);
  throwIfCancelled(options.signal);const latest=await store.read(runId,cwd,options.signal);
  if(latest.run.revision!==view.run.revision)throw new OrchestrationError('conflict','Run approval changed while authorizing execution.');
  const ledger=new ReservationLedger(join(store.root,runId,'budget'));
  const {goalRunAuthority}=await import('../goals/index.js'),goalAuthority=goalRunAuthority(view.manifest,store.root);
  const manifest=existsSync(ledger.root)?ledger.read(cwd).manifest:executionManifestForRun(view.manifest,goalAuthority?.createdAt);
  if(manifest.runId!==runId||manifest.planHash!==view.manifest.planHash)throw new OrchestrationError('conflict','Budget belongs to another run plan.');
  goalAuthority?.checkBudget(manifest);
  ledger.create(manifest,options.signal);
  const assertAuthority=()=>{goalAuthority?.assertActive();if(executionStore.exists()){const current=inspectSpawnAuthority(executionStore,ledger);executionStore.assertApproval(current.view.header);if(!current.context.plan.agents.some(a=>a.id===agentId))throw new OrchestrationError('policy-denied','Agent is not admitted to the current graph.');}};
  assertAuthority();return {ledger,manifestHash:manifestHash(manifest),agentId,maxOutputTokens,assertAuthority};
}
