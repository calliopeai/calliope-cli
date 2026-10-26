import {canonicalJson,describeApproval} from '../approvals/index.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {inspectExecution} from '../orchestration/coordinator-actions.js';
import {readRunAccounting} from '../orchestration/accounting.js';
import {checkArtifactSnapshot} from '../orchestration/verification.js';
import {OrchestrationError} from '../orchestration/types.js';
import {uuid} from '../orchestration/validation.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import type {ExecutionEvent,ExecutionInspection} from '../orchestration/coordinator-types.js';
import {inspectTaskOutcome} from './task-outcomes.js';
import {feedbackEventRef,MAX_TASK_FEEDBACK,taskFeedbackOutcomeHash,validateTaskFeedbackRequest,type TaskFeedbackRequest,type TaskFeedbackRecord} from './task-feedback-contract.js';

export function taskFeedbackCapabilities(){return {version:1,kind:'task.feedback-capabilities',owner:'calliope-cli',
  operations:['record','inspect','history'],authority:'native-policy-reviewed-assessment',storage:'native-execution-journal',
  maxRecords:MAX_TASK_FEEDBACK,changesTaskOutcome:false,awardsReward:false,mayCallModel:false} as const;}
const entries=(view:ExecutionInspection)=>view.events.filter((e):e is ExecutionEvent&{change:{type:'task_feedback_recorded';feedback:TaskFeedbackRecord}}=>e.change.type==='task_feedback_recorded');
const receipt=(event:ReturnType<typeof entries>[number])=>({event:feedbackEventRef(event),...structuredClone(event.change.feedback)});
async function publicValue<T>(value:T){
  const {sanitizeBrainValue}=await import('../brain/access.js');
  const clean=sanitizeBrainValue(value);return {data:clean,redacted:canonicalJson(clean)!==canonicalJson(value)};
}
export async function taskFeedbackHistory(cwd:string,runId:string,options:RunActionOptions={}){
  const current=await inspectExecution(cwd,runId,options);
  if(!current.execution)throw new OrchestrationError('unavailable','No native execution history.');
  return publicValue({version:1,kind:'task.feedback-history',runId,executionRevision:current.execution.state.revision,
    evidence:'recorded-assessments-not-revalidated',receipts:entries(current.execution).map(receipt)});
}
export async function inspectTaskFeedback(cwd:string,runId:string,feedbackId:string,options:RunActionOptions={}){
  if(!uuid(feedbackId))throw new OrchestrationError('invalid','Invalid task feedback identity.');
  const current=await inspectExecution(cwd,runId,options),event=current.execution&&entries(current.execution).find(e=>e.change.feedback.request.id===feedbackId);
  if(!event)throw new OrchestrationError('unavailable','No task feedback has this identity.');
  const request=event.change.feedback.request;
  const observation=await inspectTaskOutcome(cwd,runId,{...request.selection,executionRevision:current.execution!.state.revision},options);
  return publicValue({version:1,kind:'task.feedback-observation',receipt:receipt(event),
    status:taskFeedbackOutcomeHash(observation.value)===event.change.feedback.outcomeHash?'current':'stale',observation});
}
export async function recordTaskFeedback(cwd:string,runId:string,input:TaskFeedbackRequest,options:RunActionOptions={}){
  validateTaskFeedbackRequest(input);const request=structuredClone(input);
  const {hasBrainSecrets}=await import('../brain/access.js');
  if(hasBrainSecrets(request))throw new OrchestrationError('policy-denied','Task feedback contains credential material.');
  const current=await inspectExecution(cwd,runId,options),{store}=current;
  if(!current.execution)throw new OrchestrationError('unavailable','No native execution history.');
  store.assertApproval(current.execution.header);
  if(current.owner?.alive||current.execution.state.ownerId)throw new OrchestrationError('conflict','Stop or recover the active coordinator before recording feedback.');
  const duplicate=()=>entries(store.read()).find(e=>e.change.feedback.request.id===request.id);
  const prior=duplicate();
  if(prior&&canonicalJson(prior.change.feedback.request)!==canonicalJson(request))throw new OrchestrationError('conflict','Task feedback ID already binds another assessment.');
  if(!prior&&entries(current.execution).length>=MAX_TASK_FEEDBACK)throw new OrchestrationError('limit','Task feedback retention limit reached; preserve the run.');
  let observation:Awaited<ReturnType<typeof inspectTaskOutcome>>|undefined;
  if(!prior){
    observation=await inspectTaskOutcome(cwd,runId,request.selection,options);
    if(!observation.value.finished||observation.hash!==request.observationHash)throw new OrchestrationError('conflict','Task feedback requires its exact completed native observation.');
  }
  const operation={id:request.id,name:'orchestration_task_feedback',arguments:{path:cwd,runId,request,
    scope:'record operator-reviewed assessment only; no task outcome, reward, inference or execution changes'}};
  const permissionKey=describeApproval(operation,cwd).key;
  const checkPermission=()=>{if(describeApproval(operation,cwd).key!==permissionKey)throw new OrchestrationError('policy-denied','Feedback permission context changed; review the current request again.');};
  await authorizeSessionAction(cwd,operation.name,operation.arguments,
    {...options,confirmation:options.confirmation??'mutating'});
  throwIfCancelled(options.signal);checkPermission();
  if(!prior){
    observation=await inspectTaskOutcome(cwd,runId,request.selection,options);
    if(!observation.value.finished||observation.hash!==request.observationHash)throw new OrchestrationError('conflict','Native task evidence changed during feedback review.');
  }
  const lease=store.acquire();
  try{
    lease.check();checkPermission();const before=store.read();store.assertApproval(before.header);
    if(before.state.ownerId)throw new OrchestrationError('conflict','Execution became active during feedback review.');
    const existing=duplicate();
    if(existing){
      if(canonicalJson(existing.change.feedback.request)!==canonicalJson(request))throw new OrchestrationError('conflict','Task feedback ID already binds another assessment.');
      return publicValue({existing:true,receipt:receipt(existing)});
    }
    store.assertRevision(request.selection.executionRevision);
    const value=observation!.value,finished=value.finished!;
    const feedback:TaskFeedbackRecord={version:1,authority:'native-policy-reviewed-assessment',request,source:value.source,
      outcomeHash:taskFeedbackOutcomeHash(value),finished,accepted:value.accepted};
    const nativeFinished=before.events.find(e=>e.id===finished.id);
    if(!nativeFinished||nativeFinished.change.type!=='task_finished')throw new OrchestrationError('conflict','Native task outcome disappeared.');
    const artifacts=nativeFinished.change.output.artifacts;
    const event=await store.append({type:'task_feedback_recorded',feedback},options.signal,undefined,()=>{
      lease.check();checkPermission();store.assertApproval(before.header);store.assertRevision(request.selection.executionRevision);
      for(const artifact of artifacts)checkArtifactSnapshot(store,artifact);
      const accounting=readRunAccounting(store),revision=accounting.status==='available'&&accounting.attribution?.status==='available'?accounting.attribution.revision:null;
      if(revision!==value.accounting.revision)throw new OrchestrationError('conflict','Native task accounting changed during feedback admission.');
    });
    return publicValue({existing:false,receipt:receipt(event as ReturnType<typeof entries>[number])});
  }finally{lease.release();}
}
