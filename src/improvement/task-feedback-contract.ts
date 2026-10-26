import {canonicalJson,digest} from '../approvals/index.js';
import {array,hex,id,shape,text,uuid,fail} from '../orchestration/validation.js';
import {OrchestrationError,type RunManifest} from '../orchestration/types.js';
import type {ExecutionEvent,ExecutionHeader,ExecutionProjection} from '../orchestration/coordinator-types.js';
import type {inspectTaskOutcome,TaskOutcomeSelection} from './task-outcomes.js';
import {taskConfigurationIdentity} from '../orchestration/task-configuration.js';

export interface TaskFeedbackRequest {
  version:1;id:string;selection:TaskOutcomeSelection;observationHash:string;
  assessment:{decision:'accepted'|'rejected'|'corrected';reason:string};
  references:{kind:'workflow'|'skill'|'policy';id:string;revision:string}[];
}
export type TaskObservation=Awaited<ReturnType<typeof inspectTaskOutcome>>['value'];
export interface TaskFeedbackRecord {
  version:1;authority:'native-policy-reviewed-assessment';request:TaskFeedbackRequest;
  source:TaskObservation['source'];outcomeHash:string;
  finished:NonNullable<TaskObservation['finished']>;accepted:TaskObservation['accepted'];
}
export const MAX_TASK_FEEDBACK=64;
export const feedbackEventRef=(event:ExecutionEvent)=>({id:event.id,hash:event.hash,at:event.at,sequence:event.sequence});
/** Ignore journal growth and late billing; bind the assessment to the actual native outcome. */
export function taskFeedbackOutcomeHash(value:TaskObservation):string {
  const {executionRevision,...source}=value.source;
  return digest(canonicalJson({source,status:value.status,executorStatus:value.executorStatus,finished:value.finished,
    accepted:value.accepted,checks:value.checks,artifacts:value.artifacts}));
}
export function validateTaskFeedbackRequest(value:unknown):asserts value is TaskFeedbackRequest {
  shape(value,['version','id','selection','observationHash','assessment','references']);
  if(value.version!==1||!uuid(value.id)||!hex(value.observationHash))fail('Invalid task feedback identity.');
  shape(value.selection,['taskId','attempt','executionRevision']);id(value.selection.taskId);
  if(!Number.isSafeInteger(value.selection.attempt)||Number(value.selection.attempt)<1||Number(value.selection.attempt)>4||!hex(value.selection.executionRevision))fail('Invalid task feedback selection.');
  shape(value.assessment,['decision','reason']);
  if(!['accepted','rejected','corrected'].includes(String(value.assessment.decision)))fail('Invalid task feedback assessment.');
  text(value.assessment.reason,1024);array(value.references,16);const seen=new Set<string>();
  for(const ref of value.references){
    shape(ref,['kind','id','revision']);text(ref.id,128);
    if(!['workflow','skill','policy'].includes(String(ref.kind))||!hex(ref.revision))fail('Invalid task feedback version reference.');
    const key=ref.kind+':'+ref.id;if(seen.has(key))fail('Duplicate task feedback reference.');seen.add(key);
  }
}
export function validateTaskFeedbackRecord(value:unknown):asserts value is TaskFeedbackRecord {
  shape(value,['version','authority','request','source','outcomeHash','finished','accepted']);
  if(value.version!==1||value.authority!=='native-policy-reviewed-assessment'||!hex(value.outcomeHash))fail('Invalid task feedback receipt.');
  validateTaskFeedbackRequest(value.request);
  shape(value.source,['runId','manifestHash','planHash','approvalRevision','executionRevision','taskId','agentId','attempt','sessionId','started','configurationHash','graphHash']);
  const s=value.source;
  if(!uuid(s.runId)||!uuid(s.approvalRevision)||![s.manifestHash,s.planHash,s.executionRevision,s.configurationHash,s.graphHash].every(hex))fail('Invalid task feedback source.');
  id(s.taskId);id(s.agentId);text(s.sessionId,128);
  if(!Number.isSafeInteger(s.attempt)||Number(s.attempt)<1||Number(s.attempt)>4)fail('Invalid task feedback attempt.');
  for(const ref of [s.started,value.finished,...(value.accepted===null?[]:[value.accepted])]){
    shape(ref,['id','hash','at','sequence']);
    if(!uuid(ref.id)||!hex(ref.hash)||!Number.isFinite(Date.parse(String(ref.at)))||!Number.isSafeInteger(ref.sequence)||Number(ref.sequence)<1)fail('Invalid task feedback event reference.');
  }
}
export function validateTaskFeedbackEvent(record:TaskFeedbackRecord,manifest:RunManifest,header:ExecutionHeader,state:ExecutionProjection,prior:ExecutionEvent[]):void {
  const conflict=(message:string):never=>{throw new OrchestrationError('conflict',message);};
  const {source:s,request:r}=record;
  if(state.ownerId||r.selection.executionRevision!==state.revision||s.executionRevision!==state.revision)conflict('Task feedback requires the exact inactive execution revision.');
  if(s.runId!==manifest.id||s.manifestHash!==header.manifestHash||s.planHash!==manifest.planHash||s.approvalRevision!==header.approvalRevision||
    s.taskId!==r.selection.taskId||s.attempt!==r.selection.attempt)conflict('Task feedback belongs to another native source.');
  const starts=prior.filter(e=>e.change.type==='task_started'&&e.change.taskId===s.taskId);
  const start=starts.find(e=>e.change.type==='task_started'&&e.change.attempt===s.attempt)??conflict('Task feedback start is missing.'),next=starts.find(e=>e.sequence>start.sequence);
  if(start.change.type!=='task_started'||canonicalJson(feedbackEventRef(start))!==canonicalJson(s.started)||start.change.sessionId!==s.sessionId||
    manifest.plan.tasks.find(t=>t.id===s.taskId)?.agentId!==s.agentId)conflict('Task feedback start identity changed.');
  const configuration=taskConfigurationIdentity(manifest.plan,s.taskId,manifest.planHash,prior.filter(e=>e.sequence<=start.sequence));
  if(configuration.configurationHash!==s.configurationHash||configuration.graphHash!==s.graphHash)conflict('Task feedback configuration identity changed.');
  const events=prior.filter(e=>e.sequence>=start.sequence&&(!next||e.sequence<next.sequence));
  const finished=events.filter(e=>e.change.type==='task_finished'&&e.change.taskId===s.taskId).at(-1);
  const accepted=finished?events.find(e=>e.change.type==='task_accepted'&&e.change.taskId===s.taskId&&e.sequence>finished.sequence):undefined;
  if(!finished||canonicalJson(feedbackEventRef(finished))!==canonicalJson(record.finished)||canonicalJson(accepted?feedbackEventRef(accepted):null)!==canonicalJson(record.accepted))conflict('Task feedback outcome identity changed.');
  const existing=prior.filter(e=>e.change.type==='task_feedback_recorded');
  if(existing.length>=MAX_TASK_FEEDBACK||existing.some(e=>e.change.type==='task_feedback_recorded'&&e.change.feedback.request.id===r.id))conflict('Task feedback retention or idempotency limit reached.');
}
