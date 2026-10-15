/** Exact native attempt evidence for reviewed feedback, without assigning rewards. */
import {join} from 'node:path';
import {canonicalJson,digest} from '../approvals/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {assertExecutionStoreOutsideProject} from '../execution/index.js';
import {inspectExecution} from '../orchestration/coordinator-actions.js';
import {replayExecution} from '../orchestration/execution-journal.js';
import {readCollectedArtifact} from '../orchestration/verification.js';
import {readRunAccounting} from '../orchestration/accounting.js';
import {workerAttemptContext} from '../orchestration/worker-context.js';
import {id,shape} from '../orchestration/validation.js';
import {OrchestrationError} from '../orchestration/types.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import type {ExecutionEvent} from '../orchestration/coordinator-types.js';

export interface TaskOutcomeSelection {taskId:string;attempt:number;executionRevision:string}
const ref=(event:ExecutionEvent)=>({id:event.id,hash:event.hash,at:event.at,sequence:event.sequence});
function conflict(message:string):never{throw new OrchestrationError('conflict',message);}
export function taskOutcomeCapabilities(){return {version:1,owner:'calliope-cli',operations:['inspect'],
  semantics:'exact-native-attempt-observation',artifactValidation:'retained-bytes',assessment:false,reward:false,mayCallModel:false} as const;}

export async function inspectTaskOutcome(cwd:string,runId:string,selection:TaskOutcomeSelection,options:RunActionOptions={}) {
  shape(selection,['taskId','attempt','executionRevision']);id(selection.taskId);
  if(!Number.isSafeInteger(selection.attempt)||selection.attempt<1||typeof selection.executionRevision!=='string'||!/^[a-f0-9]{64}$/.test(selection.executionRevision))
    throw new OrchestrationError('invalid','Select the exact task attempt and execution revision.');
  const current=await inspectExecution(cwd,runId,options),{store,view,execution}=current;
  assertExecutionStoreOutsideProject(view.manifest.project.root,join(store.root,'..','..'));
  if(!execution||execution.state.revision!==selection.executionRevision||execution.state.ownerId||current.owner?.alive)
    conflict('Stop or recover active execution and refresh its exact task evidence.');
  const starts=execution.events.filter((event):event is ExecutionEvent&{change:Extract<ExecutionEvent['change'],{type:'task_started'}>}=>
    event.change.type==='task_started'&&event.change.taskId===selection.taskId);
  const start=starts.find(event=>event.change.attempt===selection.attempt);
  if(!start)throw new OrchestrationError('unavailable','No native task start has this attempt identity.');
  const next=starts.find(event=>event.sequence>start.sequence);
  const events=execution.events.filter(event=>event.sequence>=start.sequence&&(!next||event.sequence<next.sequence));
  const prefixEvents=execution.events.slice(0,start.sequence);
  const prefix={header:execution.header,events:prefixEvents,state:replayExecution(execution.header,view.manifest,prefixEvents)};
  const context=store.context(prefix),task=context.plan.tasks.find(t=>t.id===selection.taskId)!;
  const agent=context.plan.agents.find(a=>a.id===task.agentId)!;
  const attempt=workerAttemptContext(context.plan,task,prefix).attempt;
  const finished=events.filter((event):event is ExecutionEvent&{change:Extract<ExecutionEvent['change'],{type:'task_finished'}>}=>
    event.change.type==='task_finished'&&event.change.taskId===task.id).at(-1);
  const accepted=finished?events.find(event=>event.change.type==='task_accepted'&&event.change.taskId===task.id&&event.sequence>finished.sequence):undefined;
  const output=finished?.change.output;let bytes=0;
  for(const artifact of output?.artifacts??[]){
    throwIfCancelled(options.signal);bytes+=artifact.bytes;
    if(bytes>64*1024*1024)throw new OrchestrationError('limit','Selected attempt evidence exceeds the 64 MiB inspection bound.');
    await readCollectedArtifact(store,artifact,options);
  }
  const accounting=readRunAccounting(store,execution);
  const attribution=accounting.status==='available'?accounting.attribution:undefined;
  const charge=attribution?.status==='available'&&attribution.executionRevision===execution.state.revision?attribution.groups[start.id]??null:null;
  const tools=events.filter(event=>event.change.type==='tool'&&event.change.taskId===task.id&&event.change.stage==='finished');
  const value={version:1 as const,kind:'task.outcome-observation' as const,
    interpretation:'native-attempt-evidence-not-user-assessment-or-reward' as const,
    source:{runId:view.run.id,manifestHash:view.manifest.hash,planHash:view.manifest.planHash,approvalRevision:execution.header.approvalRevision,
      executionRevision:execution.state.revision,taskId:task.id,agentId:task.agentId,attempt:attempt.number,sessionId:start.change.sessionId,
      started:ref(start),configurationHash:digest(canonicalJson({task,agent,strategy:prefix.state.supervision?.strategies[task.id]??null})),
      graphHash:prefix.state.graph?.hash??view.manifest.planHash},
    status:accepted?'completed' as const:finished?.change.status??'unknown' as const,
    executorStatus:finished?.change.status??'unknown' as const,finished:finished?ref(finished):null,accepted:accepted?ref(accepted):null,
    checks:structuredClone(output?.checks??[]),
    artifacts:(output?.artifacts??[]).map(a=>({id:a.id,taskId:a.taskId,agentId:a.agentId,kind:a.kind,sha256:a.sha256,bytes:a.bytes,source:{...a.source}})),
    measurements:{durationMs:finished?Date.parse(finished.at)-Date.parse(start.at):null,
      toolCalls:tools.length,toolFailures:tools.filter(e=>e.change.type==='tool'&&!e.change.success).length,
      settledCostNanos:charge?.status==='available'&&charge.usageComplete?charge.accounted.costNanos:null},
    accounting:{basis:'native-reservations-and-settlements' as const,revision:attribution?.status==='available'?attribution.revision:null,charge:charge?structuredClone(charge):null}};
  store.assertRevision(selection.executionRevision);throwIfCancelled(options.signal);
  return {value,hash:digest(canonicalJson(value))};
}
