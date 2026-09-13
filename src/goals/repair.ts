import {join} from 'node:path';
import {ReservationLedger} from '../execution/ledger.js';
import {ExecutionLimitError} from '../execution/types.js';
import {throwIfCancelled} from '../cancellation.js';
import {analyzePlan,bindPlan} from '../orchestration/validation.js';
import {OrchestrationError,type PlanDiagnostic,type ProjectTask} from '../orchestration/types.js';
import type {ExecutionStore} from '../orchestration/execution-store.js';
import type {TaskOutput,TaskStatus} from '../orchestration/coordinator-types.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import {readCollectedArtifact,checkArtifactSnapshot,workerSummary} from '../orchestration/verification.js';
import {GoalStore} from './store.js';
import {goalRunAuthority} from './authority.js';
import {proposePlan} from './contracts.js';

/** Validate data before recording a planning outcome, including direct run/resume entry points. */
export async function validatePlanningArtifact(store:ExecutionStore,task:ProjectTask,collected:{status:TaskStatus;output:TaskOutput},options:RunActionOptions,assertActive:()=>void):Promise<void> {
  const link=store.manifest.goal!,goal=new GoalStore(link.root).read(link.id,store.manifest.project.root);
  const authority=goalRunAuthority(store.manifest,goal.manifest.runsRoot)!;authority.assertActive();
  if(!goal.manifest.planningRepair)throw new OrchestrationError('conflict','Planning repair is absent from the original goal authority.');
  const artifact=collected.output.artifacts.find(a=>a.id===(task.id==='draft'?'draft':'proposal'));
  if(!artifact)return; // Missing or malformed worker reports already fail collection.
  const bytes=await readCollectedArtifact(store,artifact,options),ledger=new ReservationLedger(join(goal.manifest.runsRoot,store.manifest.id,'budget')).read(store.manifest.project.root);
  authority.checkBudget(ledger.manifest);
  if(ledger.projection.exceeded)throw new ExecutionLimitError('budget','Planning usage exceeded its request reservation.');
  let diagnostics:PlanDiagnostic[]=[];
  try {
    let value:unknown;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new OrchestrationError('invalid','Planner artifact is not a valid JSON plan.');}
    const proposal=proposePlan(goal.manifest,value,{kind:'agent',runId:store.manifest.id,artifactId:artifact.id,artifactHash:artifact.sha256,eventId:artifact.source.eventId},{...ledger.projection.spent,revision:ledger.projection.revision});
    bindPlan(analyzePlan(proposal.plan),store.manifest.project.root);
  }catch(error){
    if(!(error instanceof OrchestrationError)||!['invalid','limit'].includes(error.code))throw error;
    diagnostics=error.diagnostics??[{path:'$',message:workerSummary(error.message).slice(0,1024)}];
  }
  const valid=diagnostics.length===0;
  await store.append({type:'proposal_validated',taskId:task.id,artifactId:artifact.id,artifactHash:artifact.sha256,goalManifestHash:goal.manifest.hash,valid,diagnostics},options.signal,undefined,()=>{throwIfCancelled(options.signal);assertActive();authority.assertActive();checkArtifactSnapshot(store,artifact);});
  if(!valid){
    const feedback=workerSummary('Proposal rejected: '+diagnostics.map(d=>d.path+': '+d.message+(d.parentPath?' Parent authority: '+d.parentPath+'.':'')+(d.actual===undefined?'':` Actual ${d.actual}; limit ${d.limit}.`)).join(' '));
    collected.status='failed';collected.output={...collected.output,status:'failed',summary:feedback,unresolvedRisks:[feedback],recommendedNextAction:'Return a corrected complete proposal within the same scope, remaining planning budget and original deadline. Human approval is still required.'};
  }
}
