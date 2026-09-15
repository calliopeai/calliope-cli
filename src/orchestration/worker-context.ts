import {OrchestrationError,type ProjectPlan,type ProjectTask} from './types.js';
import type {ExecutionEvent,ExecutionInspection,TaskStatus} from './coordinator-types.js';

export interface WorkerAttemptDescriptor {
  version:1;number:number;phase:'initial'|'retry';maxAttempts:number;
  startedEventId:string;previous:{number:number;startedEventId:string;outcomeEventId:string|null;status:Exclude<TaskStatus,'pending'|'running'>}[];
}
export interface WorkerPreviousAttempt {
  eventId:string;status:Exclude<TaskStatus,'pending'|'running'>;summary:string;
  checks:{id:string;passed:boolean}[];risks:string[];
}

/** Keep controller-wide evidence in the journal while exposing only this task's outcomes to its worker. */
export function workerRetryEvidenceIds(previousAttempts:WorkerPreviousAttempt[],strategyEvidence?:string[]):string[] {
  const outcomes=previousAttempts.map(attempt=>attempt.eventId);
  if(!outcomes.length||strategyEvidence===undefined)return outcomes;
  const cited=new Set(strategyEvidence),selected=outcomes.filter(id=>cited.has(id));
  if(!selected.length)throw new OrchestrationError('conflict','Supervision retry evidence does not include an authoritative outcome for this task.');
  return selected;
}

/** Bind model-facing attempt state to the executor's current journal projection. */
export function workerAttemptContext(plan:ProjectPlan,task:ProjectTask,inspection:ExecutionInspection):{attempt:WorkerAttemptDescriptor;previousAttempts:WorkerPreviousAttempt[]} {
  const state=inspection.state.tasks[task.id],agent=plan.agents.find(value=>value.id===task.agentId);
  if(!state||!agent||state.status!=='running'||state.attempts<1)throw new OrchestrationError('conflict','Worker attempt context requires the current running task.');
  const starts=inspection.events.filter((event):event is ExecutionEvent&{change:Extract<ExecutionEvent['change'],{type:'task_started'}>}=>event.change.type==='task_started'&&event.change.taskId===task.id),started=starts.at(-1);
  if(starts.length!==state.attempts||!started||started.change.attempt!==state.attempts||started.change.sessionId!==state.sessionId)throw new OrchestrationError('conflict','Worker attempt context differs from the current task-start event.');
  const finished=inspection.events.filter((event):event is ExecutionEvent&{change:Extract<ExecutionEvent['change'],{type:'task_finished'}>}=>event.change.type==='task_finished'&&event.change.taskId===task.id);
  if(starts.some((event,index)=>event.change.attempt!==index+1)||finished.some(event=>event.sequence>started.sequence))throw new OrchestrationError('conflict','Worker attempt history differs from the current attempt number.');
  const prior=starts.slice(0,-1).map((start,index)=>({start,outcome:finished.filter(event=>event.sequence>start.sequence&&event.sequence<starts[index+1]!.sequence).at(-1)}));
  const maxAttempts=agent.escalationPolicy.maxRetries+1;
  if(state.attempts>maxAttempts)throw new OrchestrationError('conflict','Worker attempt exceeds the reviewed retry limit.');
  const previousAttempts=prior.filter((value):value is typeof value&{outcome:NonNullable<typeof value.outcome>}=>!!value.outcome).map(({outcome})=>({eventId:outcome.id,status:outcome.change.status,summary:outcome.change.output.summary.slice(0,1024),checks:outcome.change.output.checks.map(check=>({id:check.id,passed:check.passed})),risks:outcome.change.output.unresolvedRisks.slice(0,8).map(risk=>risk.slice(0,512))}));
  const previous=prior.map(({start,outcome})=>({number:start.change.attempt,startedEventId:start.id,outcomeEventId:outcome?.id??null,status:outcome?.change.status??'unknown'}));
  return{attempt:{version:1,number:state.attempts,phase:state.attempts===1?'initial':'retry',maxAttempts,startedEventId:started.id,previous},previousAttempts};
}
