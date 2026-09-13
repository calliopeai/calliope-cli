import {throwIfCancelled} from '../cancellation.js';
import {SessionPolicyError} from '../session-management/index.js';
import {inspectExecution} from '../orchestration/coordinator-actions.js';
import {mechanicallyVerified} from '../orchestration/execution-journal.js';
import {readCollectedArtifact,checkArtifactSnapshot} from '../orchestration/verification.js';
import {RunStore} from '../orchestration/store.js';
import {OrchestrationError} from '../orchestration/types.js';
import type {ExecutionInspection,CollectedArtifact} from '../orchestration/coordinator-types.js';
import {GoalStore} from './store.js';
import {assertGoalRunBinding,readGoalAccounting,type GoalAccounting} from './accounting.js';
import type {GoalOptions} from './actions.js';

export interface GoalMetrics {
  version:1;kind:'goal.metrics';goalId:string;goalRevision:string;executionRevision:string|null;accounting:GoalAccounting;
  tasks:{total:number;mechanicallyVerified:number;humanAccepted:number;unverified:number;successRate:number|null}|null;
  attempts:{started:number;finishedOutcomes:number;failedOutcomes:number;cancelledOutcomes:number;deniedOutcomes:number;unknownOutcomes:number}|null;
  checks:{passed:number;total:number;passRate:number|null;scope:'recorded-acceptance-checks-across-all-attempts'}|null;
  recovery:{samples:number;meanMs:number|null;openFailures:number;scope:'recorded-failure-to-mechanical-completion'}|null;
  evidence:{status:'verified'|'unavailable'|'not-executed'|'no-mechanical-result';artifactEventIds:string[];checkedBytes:number};
  costPerVerifiedTask:{value:number|null;unit:'nano-usd';numerator:number|null;denominator:number;reason:string};
  limitations:string;
}
function observations(execution:ExecutionInspection):Pick<GoalMetrics,'attempts'|'checks'|'recovery'> {
  const attempts={started:0,finishedOutcomes:0,failedOutcomes:0,cancelledOutcomes:0,deniedOutcomes:0,unknownOutcomes:0},failed=new Map<string,number>();let passed=0,total=0,recovered=0,recoveryMs=0;
  for(const event of execution.events){const c=event.change;if(c.type==='task_started')attempts.started++;
    if(c.type!=='task_finished')continue;attempts.finishedOutcomes++;passed+=c.output.checks.filter(v=>v.passed).length;total+=c.output.checks.length;
    if(c.status==='failed'){attempts.failedOutcomes++;if(!failed.has(c.taskId))failed.set(c.taskId,Date.parse(event.at));}
    if(c.status==='cancelled')attempts.cancelledOutcomes++;if(c.status==='denied')attempts.deniedOutcomes++;if(c.status==='unknown')attempts.unknownOutcomes++;
    if(c.status==='completed'&&failed.has(c.taskId)){recoveryMs+=Date.parse(event.at)-failed.get(c.taskId)!;recovered++;failed.delete(c.taskId);}
  }
  return{attempts,checks:{passed,total,passRate:total?passed/total:null,scope:'recorded-acceptance-checks-across-all-attempts'},recovery:{samples:recovered,meanMs:recovered?recoveryMs/recovered:null,openFailures:failed.size,scope:'recorded-failure-to-mechanical-completion'}};
}

/** Revalidate final artifact bytes under current policy before a completed task enters the cost denominator. */
export async function inspectGoalMetrics(cwd:string,id:string,options:GoalOptions={}):Promise<GoalMetrics> {
  throwIfCancelled(options.signal);const goals=options.goals??new GoalStore(),goal=goals.read(id,cwd),runs=options.store??new RunStore(goal.manifest.runsRoot);
  if(runs.root!==goal.manifest.runsRoot)throw new OrchestrationError('conflict','Goal metrics require the original run store.');
  const accounting=readGoalAccounting(goal,goals,undefined,options.signal),metric:GoalMetrics={version:1,kind:'goal.metrics',goalId:id,goalRevision:goal.state.revision,executionRevision:null,accounting,tasks:null,attempts:null,checks:null,recovery:null,evidence:{status:'not-executed',artifactEventIds:[],checkedBytes:0},costPerVerifiedTask:{value:null,unit:'nano-usd',numerator:accounting.status==='available'?accounting.accounted!.costNanos:null,denominator:0,reason:'No mechanically verified execution task is available.'},limitations:'The numerator includes all planning, worker retry and controller/reviewer charges once. Accounted costs are not invoices. Human acceptance is separate from mechanical verification. Task counts change with decomposition; these observations do not establish causal improvement or cross-run comparability. Recovery and check counts describe recorded executor observations, not test assertions or fresh reproduction.'};
  if(!goal.state.execution)return metric;
  try {
    const current=await inspectExecution(cwd,goal.state.execution.runId,{...options,store:runs});assertGoalRunBinding(goal,goal.state.execution,current.view.manifest,goals);
    const execution=current.execution;if(!execution){metric.evidence.status='unavailable';return metric;}
    const context=current.store.context(execution),states=Object.values(execution.state.tasks),accepted=new Set<string>();
    metric.executionRevision=execution.state.revision;Object.assign(metric,observations(execution));
    for(const event of execution.events){const c=event.change;if(c.type==='task_accepted')accepted.add(c.taskId);if(c.type==='task_reset')accepted.delete(c.taskId);}
    let human=0,unavailable=false;const seen=new Set<string>(),verifiedTasks=new Set<string>(),proofs:CollectedArtifact[]=[];
    for(const task of states){
      throwIfCancelled(options.signal);if(task.status!=='completed')continue;if(accepted.has(task.id)){human++;continue;}
      if(!task.output||!mechanicallyVerified(task.output,context)){unavailable=true;continue;}
      let intact=true;
      for(const artifact of task.output.artifacts){
        if(seen.has(artifact.source.eventId))continue;
        if(metric.evidence.checkedBytes+artifact.bytes>64*1024*1024)throw new OrchestrationError('limit','Goal metrics exceed the 64 MiB evidence inspection limit.');
        if(seen.size%32===0)await new Promise<void>(resolve=>setImmediate(resolve));throwIfCancelled(options.signal);
        try{await readCollectedArtifact(current.store,artifact,options);seen.add(artifact.source.eventId);proofs.push(artifact);metric.evidence.artifactEventIds.push(artifact.source.eventId);metric.evidence.checkedBytes+=artifact.bytes;}
        catch(error){throwIfCancelled(options.signal);if(error instanceof SessionPolicyError||error instanceof OrchestrationError&&['policy-denied','limit'].includes(error.code))throw error;intact=false;unavailable=true;}
      }
      if(intact)verifiedTasks.add(task.id);
    }
    for(const artifact of proofs){throwIfCancelled(options.signal);try{checkArtifactSnapshot(current.store,artifact);}catch{unavailable=true;verifiedTasks.delete(artifact.taskId);}}
    const verified=verifiedTasks.size;
    metric.tasks={total:states.length,mechanicallyVerified:verified,humanAccepted:human,unverified:states.length-verified-human,successRate:!unavailable&&states.length?verified/states.length:null};
    metric.evidence.status=unavailable?'unavailable':verified?'verified':'no-mechanical-result';metric.costPerVerifiedTask.denominator=verified;
    // A revision mismatch is an incomplete observation, not permission to reread until something passes.
    const latest=readGoalAccounting(goal,goals,undefined,options.signal),phase=accounting.status!=='unavailable'?accounting.phases.execution:undefined;
    const stable=accounting.status==='available'&&latest.status==='available'&&latest.revision===accounting.revision&&phase?.status==='available'&&phase.executionRevision===execution.state.revision&&current.store.read().state.revision===execution.state.revision;
    const eligible=stable&&accounting.usageComplete&&!unavailable&&verified>0;
    metric.costPerVerifiedTask.value=eligible?accounting.accounted!.costNanos/verified:null;
    metric.costPerVerifiedTask.reason=eligible?'Fully accounted goal charges, including planning and all reviews/retries, divided by final mechanically verified tasks at these revisions.':!stable?'Goal, execution or budget evidence is missing, inconsistent or changed during inspection.':unavailable?'A final artifact is unavailable or changed after collection.':!accounting.usageComplete?'Active execution, unresolved usage or pending child admission prevents a final cost measurement.':'No mechanically verified execution task is available.';
    return metric;
  }catch(error){
    throwIfCancelled(options.signal);if(error instanceof SessionPolicyError||error instanceof OrchestrationError&&['policy-denied','limit'].includes(error.code))throw error;
    metric.evidence.status='unavailable';metric.costPerVerifiedTask.value=null;metric.costPerVerifiedTask.reason='Execution or artifact evidence is unavailable or inconsistent; preserve the goal and linked runs.';return metric;
  }
}
