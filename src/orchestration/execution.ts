import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { authorizeSessionAction } from '../session-management/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { ReservationLedger, manifestHash, validateExecutionManifest, type ExecutionManifest, type AgentExecution } from '../execution/index.js';
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
  if(view.run.status!=='approved')throw new OrchestrationError('policy-denied','Run must be explicitly approved before preparing execution authority.');
  if(!view.manifest.plan.agents.some(a=>a.id===agentId)||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>100000000)throw new OrchestrationError('invalid','Unknown agent or invalid output limit.');
  await authorizeSessionAction(cwd,'orchestration_budget',{path:cwd,runId,agentId,planHash:view.manifest.planHash,revision:view.run.revision,maxOutputTokens},options);
  throwIfCancelled(options.signal);const latest=await store.read(runId,cwd,options.signal);
  if(latest.run.revision!==view.run.revision)throw new OrchestrationError('conflict','Run approval changed while authorizing execution.');
  const ledger=new ReservationLedger(join(store.root,runId,'budget'));
  const manifest=existsSync(ledger.root)?ledger.read(cwd).manifest:executionManifestForRun(view.manifest);
  if(manifest.runId!==runId||manifest.planHash!==view.manifest.planHash)throw new OrchestrationError('conflict','Budget belongs to another run plan.');
  ledger.create(manifest,options.signal);
  return {ledger,manifestHash:manifestHash(manifest),agentId,maxOutputTokens};
}
