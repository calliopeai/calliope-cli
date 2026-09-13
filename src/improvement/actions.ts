import {coordinatorProgress} from '../orchestration/progress.js';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {canonicalJson,digest} from '../approvals/index.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {assertExecutionStoreOutsideProject} from '../execution/index.js';
import {inspectRun} from '../orchestration/actions.js';
import {inspectExecution,controlExecution} from '../orchestration/coordinator-actions.js';
import {executeReviewedRun,type CoordinatorOptions} from '../orchestration/coordinator.js';
import {readArtifactBytes} from '../orchestration/execution-store.js';
import {readCollectedArtifact} from '../orchestration/verification.js';
import {shape} from '../orchestration/validation.js';
import {OrchestrationError} from '../orchestration/types.js';
import {projectImprovementHistory} from './projection.js';
import type {ImprovementCycle} from './types.js';

export function improvementProposalHash(cycle:ImprovementCycle):string {
  return digest(canonicalJson({version:1,runId:cycle.runId,manifestHash:cycle.source.manifestHash,decision:cycle.source.decision,proposal:cycle.proposedChange,deadline:cycle.budget.deadline}));
}
/** Inspection may outlive execution; it cannot reset a clock, approval or reservation. */
export async function inspectImprovements(cwd:string,runId:string|undefined,options:CoordinatorOptions={}) {
  const initial=await inspectRun(cwd,runId,options),current=await inspectExecution(cwd,initial.run.id,options);
  assertExecutionStoreOutsideProject(current.view.manifest.project.root,join(current.store.root,'..','..'));
  if(!current.execution)throw new OrchestrationError('unavailable','This run has no execution evidence.');
  const history=projectImprovementHistory(current.view.manifest,current.execution,current.store.context(current.execution)),seen=new Set<string>();let total=0;
  for(const cycle of history.cycles)for(const outcome of [...cycle.baseline,...cycle.results])for(const artifact of outcome.artifacts){
    throwIfCancelled(options.signal);if(seen.has(artifact.source.eventId))continue;seen.add(artifact.source.eventId);
    total+=artifact.bytes;if(total>64*1024*1024)throw new OrchestrationError('limit','Improvement evidence exceeds the 64 MiB inspection bound.');
    await readCollectedArtifact(current.store,artifact,options);
  }
  const base=join(current.store.root,'workspace-base.json');
  if(fs.existsSync(base)){
    let value;try{value=JSON.parse(readArtifactBytes(base,16384,true).toString());}catch{throw new OrchestrationError('unavailable','Retained worktree base is damaged.');}
    shape(value,['version','project','planHash','commit','hash']);const {hash,...body}=value;
    if(value.version!==1||value.project!==current.view.manifest.project.root||value.planHash!==current.view.manifest.planHash||typeof value.commit!=='string'||!/^[a-f0-9]{40,64}$/.test(value.commit)||hash!==digest(canonicalJson(body)))throw new OrchestrationError('conflict','Retained worktree base differs from this run.');
    for(const cycle of history.cycles)cycle.rollback.baseCommit=value.commit;
  }
  throwIfCancelled(options.signal);return{...current,history};
}
export async function proposeImprovement(cwd:string,runId:string|undefined,options:CoordinatorOptions={}) {
  const initial=await inspectImprovements(cwd,runId,options),s=initial.execution!.state.supervision;
  if(!s)throw new OrchestrationError('invalid','Improvement proposals require a reviewed version-4 supervised run.');
  if(initial.owner?.alive||initial.execution!.state.ownerId)throw new OrchestrationError('conflict','Stop or recover the active coordinator before requesting a separate improvement review.');
  if(s.decisionId){const cycle=initial.history.cycles.find(c=>c.id===s.decisionId);if(cycle&&s.review)return{cycle,proposalHash:improvementProposalHash(cycle),existing:true};}
  if(s.phase==='halted')await controlExecution(cwd,initial.view.run.id,'controller-retry',initial.store.context().plan.supervision!.controllerId,options);
  await executeReviewedRun(cwd,initial.view.run.id,{...options,resume:true,proposalOnly:true});
  const current=await inspectImprovements(cwd,initial.view.run.id,options),cycle=current.history.cycles.find(c=>c.id===current.execution!.state.supervision?.decisionId);
  if(!cycle||!current.execution!.state.supervision?.review||current.execution!.state.supervision.phase!=='decision')throw new OrchestrationError('unavailable','The bounded review produced no improvement proposal; inspect its recorded stop, failure or exhausted limits.');
  return{cycle,proposalHash:improvementProposalHash(cycle),existing:false};
}
export async function runImprovement(cwd:string,runId:string|undefined,cycleId:string,approvedHash:string,options:CoordinatorOptions={}) {
  const current=await inspectImprovements(cwd,runId,options),cycle=current.history.cycles.find(c=>c.id===cycleId);
  if(!cycle||cycle.status!=='proposed'||current.execution!.state.supervision?.decisionId!==cycleId)throw new OrchestrationError('conflict','Select the current unapplied improvement proposal.');
  if(improvementProposalHash(cycle)!==approvedHash)throw new OrchestrationError('policy-denied','Improvement execution requires its exact reviewed proposal hash.');
  await authorizeSessionAction(cwd,'orchestration_improve',{path:cwd,runId:cycle.runId,cycleId,proposalHash:approvedHash,decision:cycle.proposedChange,budget:cycle.budget,scope:'isolated execution under the original reviewed plan'},options);
  if(current.store.read().state.revision!==current.execution!.state.revision)throw new OrchestrationError('conflict','The improvement changed during approval; inspect its current proposal.');
  if(current.execution!.state.supervision?.phase==='halted')await controlExecution(cwd,cycle.runId,'controller-retry',current.store.context().plan.supervision!.controllerId,options);
  return executeReviewedRun(cwd,cycle.runId,{...options,resume:true,proposalOnly:false,expectedDecisionId:cycleId,expectedProposalHash:approvedHash});
}
/** Retire a strategy and stop its continuation. Artifacts, task outcomes and allocations remain immutable. */
export async function withdrawImprovement(cwd:string,runId:string|undefined,cycleId:string,options:CoordinatorOptions={}) {
  const current=await inspectImprovements(cwd,runId,options),cycle=current.history.cycles.find(c=>c.id===cycleId);
  if(!cycle)throw new OrchestrationError('invalid','Unknown improvement cycle.');
  if(cycle.withdrawal)return{cycle,alreadyWithdrawn:true};
  if(current.execution!.state.supervision?.decisionId&&current.execution!.state.supervision.decisionId!==cycleId)throw new OrchestrationError('conflict','Resolve the current pending decision before withdrawing an older improvement.');
  await authorizeSessionAction(cwd,'orchestration_improvement_rollback',{path:cwd,runId:cycle.runId,cycleId,scope:'withdraw strategy, stop future continuation and retain all source/patch/test evidence',decision:cycle.proposedChange,rollback:cycle.rollback},options);
  const lease=current.store.acquire();
  try{
    const before=current.store.read();if(before.state.ownerId||before.state.revision!==current.execution!.state.revision)throw new OrchestrationError('conflict','Execution changed or is active; inspect or stop it before rollback.');
    await current.store.append({type:'supervision_withdrawn',decisionId:cycleId,source:options.source==='repl'?'repl':'cli'},options.signal,undefined,lease.check);
  }finally{lease.release();}
  const next=await inspectImprovements(cwd,cycle.runId,options);options.onProgress?.(coordinatorProgress(next.store,next.execution!));
  return{cycle:next.history.cycles.find(c=>c.id===cycleId)!,alreadyWithdrawn:false};
}
