import {coordinatorProgress} from '../orchestration/progress.js';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {canonicalJson,digest} from '../approvals/index.js';
import {throwIfCancelled,isCancellation,cancellationError} from '../cancellation.js';
import {authorizeSessionAction,SessionPolicyError} from '../session-management/index.js';
import {ReservationLedger} from '../execution/ledger.js';
import {ExecutionLimitError} from '../execution/types.js';
import {assertLocalIsolationImage} from '../isolation/process.js';
import {PROVIDER_REFUSAL_MESSAGE} from '../errors.js';
import {RunStore,ExecutionStore,analyzePlan,bindPlan,changePreparedRun,loadRunPlan,executeReviewedRun,inspectExecution,readCollectedArtifact,workerSummary,OrchestrationError} from '../orchestration/index.js';
import type {CoordinatorOptions,ExecutionEvent,ExecutionInspection,ProjectPlan,RunInspection} from '../orchestration/index.js';
import {GoalStore} from './store.js';
import {newGoalManifest,plannerPlan,allocatePlan,proposePlan,type GoalConfiguration} from './contracts.js';
import {validateGoalProposal} from './validation.js';
import type {GoalInspection,GoalEvent,GoalAllocation,GoalOwner,GoalStatus,PlanningSpend,GoalProposal} from './types.js';

export interface GoalOptions extends Omit<CoordinatorOptions,'onEvent'>,GoalConfiguration {
  goals?:GoalStore;onGoalEvent?:(event:GoalEvent)=>void;onRunEvent?:(event:ExecutionEvent)=>void;onCreated?:(goal:GoalInspection)=>void;
}
export interface GoalResult {version:1;type:'orchestration.goal';goal:GoalInspection;status:GoalStatus;execution:ExecutionInspection|null;owners:{goal:ReturnType<GoalStore['owner']>;execution:ReturnType<ExecutionStore['owner']>};interrupted:boolean;exitCode:number}
const goalStore=(options:GoalOptions)=>new GoalStore(options.goals?.root,options.onGoalEvent);
function runStore(goal:GoalInspection,options:GoalOptions):RunStore {if(options.store&&options.store.root!==goal.manifest.runsRoot)throw new OrchestrationError('conflict','Goal is bound to its original run store.');return options.store??new RunStore(goal.manifest.runsRoot);}
const outcome=(error:unknown)=>isCancellation(error)?'cancelled':error instanceof SessionPolicyError||error instanceof ExecutionLimitError||error instanceof OrchestrationError&&error.code==='policy-denied'?'denied':'failed';
function assertLinkedRun(goal:GoalInspection,allocation:GoalAllocation,view:RunInspection,goals:GoalStore):void {
  const expected={version:1,root:goals.root,id:goal.manifest.id,manifestHash:goal.manifest.hash,allocationId:allocation.id,phase:allocation.phase};
  if(view.manifest.version!==2||view.manifest.id!==allocation.runId||view.manifest.planHash!==allocation.planHash||canonicalJson(view.manifest.goal)!==canonicalJson(expected)||view.manifest.createdAt!==goal.manifest.createdAt)throw new OrchestrationError('conflict','Run evidence differs from its parent goal allocation.');
}
const code=(status:GoalStatus)=>status==='completed'?0:status==='review_required'?5:status==='partial'?4:status==='denied'?3:status==='cancelled'?130:['created','planning','approved','running'].includes(status)?0:1;
function validateOptions(options:GoalOptions):void {if(options.maxOutputTokens!==undefined&&(!Number.isSafeInteger(options.maxOutputTokens)||options.maxOutputTokens<1||options.maxOutputTokens>100000000))throw new OrchestrationError('invalid','Invalid goal output cap.');}
async function result(cwd:string,id:string,options:GoalOptions):Promise<GoalResult> {
  const goals=goalStore(options),goal=goals.read(id,cwd),runs=runStore(goal,options),owners:GoalResult['owners']={goal:goals.owner(id),execution:null};let execution:ExecutionInspection|null=null,status=goal.state.status;
  if(goal.state.execution&&existsSync(join(runs.root,goal.state.execution.runId))){const inspected=await inspectExecution(cwd,goal.state.execution.runId,{store:runs,signal:options.signal});assertLinkedRun(goal,goal.state.execution,inspected.view,goals);execution=inspected.execution;if(execution)options.onProgress?.(coordinatorProgress(inspected.store,execution));owners.execution=inspected.owner;
    // A read may report newer child evidence (for example explicit task acceptance) without rewriting history.
    if(!goal.state.revoked&&execution&&(execution.state.status==='completed'||!['failed','denied','cancelled'].includes(status)||goal.events.at(-1)?.change.type!=='execution_interrupted')){if(execution.state.status==='ready')status='approved';else status=execution.state.status;}
    if(inspected.view.run.status==='cancelled')status='cancelled';
  }
  const interrupted=status==='planning'&&!owners.goal?.alive||execution?.state.status==='running'&&!owners.execution?.alive;
  return{version:1,type:'orchestration.goal',goal,status,execution,owners,interrupted,exitCode:code(status)};
}
export async function inspectGoal(cwd:string,id:string,options:GoalOptions={}):Promise<GoalResult>{throwIfCancelled(options.signal);return result(cwd,id,options);}
interface GoalContext {goals:GoalStore;owner:GoalOwner;signal:AbortSignal;assert:()=>GoalInspection;options:GoalOptions}
async function owned<T>(cwd:string,id:string,options:GoalOptions,work:(context:GoalContext)=>Promise<T>):Promise<T> {
  validateOptions(options);
  const goals=goalStore(options),initial=goals.read(id,cwd),owner=goals.acquire(id),controller=new AbortController();let stopped:unknown;
  const abort=()=>{stopped??=cancellationError();controller.abort();};options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const assert=()=>{throwIfCancelled(controller.signal);owner.check();const view=goals.read(id,cwd);if(view.state.revoked)throw cancellationError();if(Date.now()>=view.manifest.deadline)throw new ExecutionLimitError('deadline','Original goal deadline expired.');return view;};
  const observe=()=>{try{assert();}catch(error){stopped??=error;controller.abort();}},timer=setInterval(observe,100),deadline=setTimeout(observe,Math.max(0,initial.manifest.deadline-Date.now()));
  const bound={...options,signal:controller.signal,approve:options.approve?(decision:Parameters<NonNullable<GoalOptions['approve']>>[0],signal?:AbortSignal)=>options.approve!(decision,signal??controller.signal):undefined};
  try{assert();return await work({goals,owner,signal:controller.signal,assert,options:bound});}catch(error){throw stopped??error;}
  finally{clearInterval(timer);clearTimeout(deadline);controller.abort();options.signal?.removeEventListener('abort',abort);owner.release();}
}
function planningSpend(goal:GoalInspection):PlanningSpend|null {
  if(!goal.state.planning)return null;const root=join(goal.manifest.runsRoot,goal.state.planning.runId,'budget');if(!existsSync(root))return null;
  const value=new ReservationLedger(root).read(goal.manifest.project.root);if(value.manifest.runId!==goal.state.planning.runId||value.manifest.planHash!==goal.state.planning.planHash)throw new OrchestrationError('conflict','Planning ledger belongs to another allocation.');
  if(value.projection.exceeded)throw new ExecutionLimitError('budget','Planning usage exceeded its request reservation.');return{...value.projection.spent,revision:value.projection.revision};
}
async function ensureRun(cwd:string,goal:GoalInspection,allocation:GoalAllocation,plan:ProjectPlan,context:GoalContext):Promise<RunInspection> {
  const runs=runStore(goal,context.options),analysis=analyzePlan(plan);if(analysis.hash!==allocation.planHash)throw new OrchestrationError('conflict','Allocated plan changed before run creation.');bindPlan(analysis,cwd);
  const binding={id:allocation.runId,createdAt:goal.manifest.createdAt,goal:{version:1 as const,root:context.goals.root,id:goal.manifest.id,manifestHash:goal.manifest.hash,allocationId:allocation.id,phase:allocation.phase}};
  let view:RunInspection;const internal={...context.options,store:runs,confirmation:'none' as const};
  if(existsSync(join(runs.root,allocation.runId))){view=await runs.read(allocation.runId,cwd,context.signal);assertLinkedRun(goal,allocation,view,context.goals);}
  else{await authorizeSessionAction(cwd,'orchestration_prepare',{path:cwd,goalId:goal.manifest.id,allocationId:allocation.id,runId:allocation.runId,planHash:analysis.hash,agents:plan.agents.length,tasks:plan.tasks.length},internal);context.assert();view=await runs.prepare(analysis,cwd,{kind:'goal',path:`goals/${goal.manifest.id}/${allocation.phase}.json`,sha256:analysis.hash},context.signal,binding);}
  context.assert();if(view.run.status==='cancelled')throw cancellationError();if(view.run.status==='prepared')view=await changePreparedRun(cwd,view.run.id,'approved',internal);context.assert();return view;
}
async function planGoal(cwd:string,id:string,options:GoalOptions):Promise<GoalResult> {
  await owned(cwd,id,options,async context=>{
    let view=context.assert();if(view.state.planningFrozen)return;if(!['created','planning'].includes(view.state.status))throw new OrchestrationError('conflict','Goal is not awaiting planning.');
    if(view.manifest.supervision){await assertLocalIsolationImage(view.manifest.supervision.image,context.signal);context.assert();}
    const plan=plannerPlan(view.manifest);
    if(!view.state.planning){const allocation=allocatePlan(view.manifest,plan,'planning');await context.goals.append(id,{type:'planning_allocated',allocation},{signal:context.signal,expectedRevision:view.state.revision,beforeCommit:()=>context.assert()});view=context.assert();}
    try{
      const run=await ensureRun(cwd,view,view.state.planning!,plan,context),runs=runStore(view,options),executionStore=new ExecutionStore(join(runs.root,run.run.id),run.manifest),execution=await executeReviewedRun(cwd,run.run.id,{...context.options,store:runs,confirmation:'none',resume:executionStore.exists(),maxOutputTokens:Math.min(view.manifest.limits.maxOutputTokens,options.maxOutputTokens??view.manifest.limits.maxOutputTokens),onEvent:options.onRunEvent});
      context.assert();const task=execution.execution.state.tasks.propose!,artifact=task.output?.artifacts.find(a=>a.id==='proposal'),spend=planningSpend(view);
      if(execution.status==='cancelled')throw cancellationError();if(!artifact||!spend||!['review_required','completed'].includes(task.status))throw new OrchestrationError(execution.status==='denied'?'policy-denied':'unavailable',task.output?.summary===PROVIDER_REFUSAL_MESSAGE?`Planner stopped: ${PROVIDER_REFUSAL_MESSAGE}`:'Planner did not produce a usable proposal; inspect its recorded session and budget.');
      const bytes=await readCollectedArtifact(executionStore,artifact,context.options);let value:unknown;try{value=JSON.parse(bytes.toString());}catch{throw new OrchestrationError('invalid','Planner artifact is not a valid JSON plan.');}
      const proposal=proposePlan(view.manifest,value,{kind:'agent',runId:run.run.id,artifactId:artifact.id,artifactHash:artifact.sha256,eventId:artifact.source.eventId},spend);bindPlan(analyzePlan(proposal.plan),cwd);context.assert();context.goals.writeProposal(proposal,spend,context.signal);
      await context.goals.append(id,{type:'planning_finished',status:'review_required',spend,proposalHash:proposal.hash,reason:'Plan structure, bounds and provenance validated; human approval is required.'},{signal:context.signal,expectedRevision:view.state.revision,beforeCommit:()=>{context.assert();if(canonicalJson(planningSpend(view))!==canonicalJson(spend))throw new OrchestrationError('conflict','Planning spend changed before proposal freeze.');}});
    }catch(error){
      const current=context.goals.read(id,cwd);if(!current.state.planningFrozen){let spend:PlanningSpend|null=null;try{spend=planningSpend(current);}catch{/* Damaged/overrun spend cannot authorize execution. */}
        await context.goals.append(id,{type:'planning_finished',status:context.signal.aborted?'cancelled':outcome(error),spend,proposalHash:null,reason:workerSummary(error instanceof Error?error.message:'Planning failed.')},{beforeCommit:context.owner.check});}
      throw error;
    }
  });return result(cwd,id,options);
}
export async function startGoal(cwd:string,goal:string,options:GoalOptions={}):Promise<GoalResult> {
  throwIfCancelled(options.signal);validateOptions(options);const runs=options.store??new RunStore(),goals=goalStore(options),manifest=newGoalManifest(cwd,goal,runs.root,options);
  await authorizeSessionAction(cwd,'orchestration_goal_plan',{path:cwd,goalHash:digest(goal),limits:manifest.limits,workspace:manifest.workspace,preference:manifest.preference,...(manifest.routing?{routing:manifest.routing}:{}),...(manifest.team?{team:manifest.team}:{}),...(manifest.supervision?{supervision:manifest.supervision}:{})},options);throwIfCancelled(options.signal);const created=goals.create(manifest,options.signal);options.onCreated?.(created);
  return planGoal(cwd,manifest.id,{...options,store:runs,goals});
}
export async function approveGoal(cwd:string,id:string,proposalHash:string,options:GoalOptions={}):Promise<GoalResult> {
  await owned(cwd,id,options,async context=>{
    const view=context.assert();if(view.state.status!=='review_required'||!view.proposal||view.proposal.hash!==proposalHash||view.state.execution)throw new OrchestrationError('conflict','Approval must name the current, unallocated proposal hash.');
    validateGoalProposal(view.proposal,view.manifest,view.state.planningSpend!);bindPlan(analyzePlan(view.proposal.plan),cwd);
    await authorizeSessionAction(cwd,'orchestration_goal_approve',{path:cwd,operation:`Approve goal ${id}, proposal ${proposalHash}: ${view.proposal.plan.tasks.length} tasks, ${view.proposal.plan.limits.tokenBudget} tokens, $${view.proposal.plan.limits.costBudgetUsd}, original deadline ${new Date(view.manifest.deadline).toISOString()}. File mutations still require their own permission.`,goalId:id,proposalHash,revision:view.state.revision,plan:view.proposal.plan,planningSpend:view.state.planningSpend,deadline:view.manifest.deadline},{...context.options,confirmation:options.source==='repl'?'mutating':options.confirmation});
    context.assert();const allocation=allocatePlan(view.manifest,view.proposal.plan,'execution');
    await context.goals.append(id,{type:'execution_allocated',allocation,proposalHash,source:options.source??'cli'},{signal:context.signal,expectedRevision:view.state.revision,beforeCommit:()=>{context.assert();if(canonicalJson(planningSpend(view))!==canonicalJson(view.state.planningSpend))throw new OrchestrationError('conflict','Planning spend changed during approval.');}});
  });return resumeGoal(cwd,id,options);
}
export async function resumeGoal(cwd:string,id:string,options:GoalOptions={}):Promise<GoalResult> {
  throwIfCancelled(options.signal);const initial=goalStore(options).read(id,cwd);if(initial.state.revoked||initial.state.status==='completed')return result(cwd,id,options);if(!initial.state.execution){if(initial.state.planningFrozen)return result(cwd,id,options);return planGoal(cwd,id,options);}
  const current=await result(cwd,id,options);if(current.status==='completed')return current;
  await owned(cwd,id,options,async context=>{
    const view=context.assert(),a=view.state.execution!,proposal=view.proposal!;const run=await ensureRun(cwd,view,a,proposal.plan,context),runs=runStore(view,options),store=new ExecutionStore(join(runs.root,run.run.id),run.manifest);
    if(store.exists()&&store.read().state.status==='completed'){const execution=store.read(),tasks=Object.values(execution.state.tasks);await context.goals.append(id,{type:'execution_finished',runId:a.runId,revision:execution.state.revision,status:'completed',completed:tasks.filter(t=>t.status==='completed').length,total:tasks.length},{signal:context.signal,beforeCommit:()=>context.assert()});return;}
    await authorizeSessionAction(cwd,'orchestration_goal_resume',{path:cwd,goalId:id,runId:a.runId,proposalHash:proposal.hash,revision:view.state.revision},context.options);context.assert();await context.goals.append(id,{type:'execution_started',runId:a.runId},{signal:context.signal,beforeCommit:()=>context.assert()});
    try {
      const execution=await executeReviewedRun(cwd,run.run.id,{...context.options,store:runs,confirmation:'none',resume:store.exists(),maxOutputTokens:Math.min(view.manifest.limits.maxOutputTokens,options.maxOutputTokens??view.manifest.limits.maxOutputTokens),onEvent:options.onRunEvent}),tasks=Object.values(execution.execution.state.tasks);
      await context.goals.append(id,{type:'execution_finished',runId:a.runId,revision:execution.execution.state.revision,status:execution.status as 'completed'|'partial'|'failed'|'denied'|'cancelled',completed:tasks.filter(t=>t.status==='completed').length,total:tasks.length},{beforeCommit:context.owner.check});
    } catch(error) {
      await context.goals.append(id,{type:'execution_interrupted',runId:a.runId,status:context.signal.aborted?'cancelled':outcome(error),reason:workerSummary(error instanceof Error?error.message:'Execution interrupted; inspect its original run before retrying.')},{beforeCommit:context.owner.check});throw error;
    }
  });return result(cwd,id,options);
}
export async function cancelGoal(cwd:string,id:string,options:GoalOptions={}):Promise<GoalResult> {
  const goals=goalStore(options),view=goals.read(id,cwd);if((await result(cwd,id,options)).status==='completed')throw new OrchestrationError('conflict','Completed goals cannot be cancelled.');await authorizeSessionAction(cwd,'orchestration_goal_cancel',{path:cwd,goalId:id,manifestHash:view.manifest.hash,revision:view.state.revision},options);throwIfCancelled(options.signal);await goals.append(id,{type:'cancelled',source:options.source??'cli'},{signal:options.signal});return result(cwd,id,options);
}
export async function reviseGoal(cwd:string,id:string,path:string,options:GoalOptions={}):Promise<GoalResult> {
  await owned(cwd,id,options,async context=>{const view=context.assert();if(!['review_required','failed','denied','cancelled'].includes(view.state.status)||!view.state.planningFrozen||view.state.execution||!view.state.planningSpend)throw new OrchestrationError('conflict','Only frozen, unallocated planning can be revised.');const loaded=await loadRunPlan(cwd,path,false,context.options),proposal=proposePlan(view.manifest,loaded.analysis.plan,{kind:'human',path:loaded.source.path,sha256:loaded.source.sha256},view.state.planningSpend);
    await authorizeSessionAction(cwd,'orchestration_goal_revise',{path:cwd,goalId:id,previousProposalHash:view.state.proposalHash,proposalHash:proposal.hash,source:loaded.source},context.options);context.assert();context.goals.writeProposal(proposal,view.state.planningSpend,context.signal);await context.goals.append(id,{type:'proposal_revised',proposalHash:proposal.hash},{signal:context.signal,expectedRevision:view.state.revision,beforeCommit:()=>context.assert()});});return result(cwd,id,options);
}
