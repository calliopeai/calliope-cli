import {randomUUID} from 'node:crypto';
import {dirname} from 'node:path';
import {canonicalJson,describeApproval,digest} from '../approvals/index.js';
import {cancellableDelay,throwIfCancelled} from '../cancellation.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {withScope} from '../scope.js';
import type {ToolCall} from '../types.js';
import type {RunActionOptions} from './actions.js';
import type {ExecutionInspection} from './coordinator-types.js';
import {inspectExecution} from './coordinator-actions.js';
import {agentStopped} from './execution-journal.js';
import type {ExecutionStore} from './execution-store.js';
import {validateQuestionRequest,validateQuestionAnswer,type ExecutionQuestionRequest} from './question-contract.js';
import {OrchestrationError} from './types.js';
import {hex,shape,uuid} from './validation.js';

function pendingQuestion(store:ExecutionStore,execution:ExecutionInspection,id:string) {
  const q=execution.state.questions?.[id],owner=store.owner();
  if(!q||q.status!=='pending'||!owner?.alive||owner.id!==q.ownerId||execution.state.ownerId!==q.ownerId)throw new OrchestrationError('conflict','Question has no live waiting coordinator; inspect its task before recovery.');
  const task=execution.state.tasks[q.taskId]!,context=store.context(execution),agent=context.plan.agents.find(a=>a.id===task.agentId)!;
  if(task.status!=='running'||task.sessionId!==q.sessionId||task.attempts!==q.attempt||agentStopped(execution.state,context,agent.id)||Date.now()>=Math.min(execution.header.deadline,Date.parse(execution.header.createdAt)+agent.timeBudgetMs))throw new OrchestrationError('conflict','Question task stopped or its original deadline expired.');
  store.assertApproval(execution.header);
  return q;
}

/** The coordinator retains its lease and active task slot throughout this wait. */
export async function waitForExecutionAnswer(store:ExecutionStore,taskId:string,call:ToolCall,signal:AbortSignal|undefined,assertAuthority:()=>void):Promise<string> {
  throwIfCancelled(signal);assertAuthority();
  if(call.name!=='ask_question')throw new OrchestrationError('invalid','Only ask_question can wait for a question answer.');
  shape(call.arguments,['question'],['options','context']);
  const state=store.read().state,task=state.tasks[taskId];
  if(!task?.sessionId||!state.ownerId)throw new OrchestrationError('conflict','Question has no active task session.');
  const request:ExecutionQuestionRequest={id:randomUUID(),ownerId:state.ownerId,attempt:task.attempts,sessionId:task.sessionId,callId:call.id,
    text:call.arguments.question as string,options:(call.arguments.options??[]) as string[],context:(call.arguments.context??null) as string|null};
  validateQuestionRequest(request);
  await store.append({type:'question_asked',taskId,request},signal,undefined,assertAuthority);
  for(;;){
    throwIfCancelled(signal);assertAuthority();
    const execution=store.read(),q=execution.state.questions?.[request.id];
    if(q?.status==='answered'&&q.answer!==null)return q.answer;
    pendingQuestion(store,execution,request.id);
    await cancellableDelay(100,signal);
  }
}

/** Answer one inspected request under current policy and the journal writer lock. */
export async function answerExecutionQuestion(cwd:string,runId:string,questionId:string,revision:string,answer:string,options:RunActionOptions={}) {
  if(!uuid(questionId)||!hex(revision))throw new OrchestrationError('invalid','Answer requires the exact question ID and inspected execution revision.');
  validateQuestionAnswer(answer);
  const initial=await inspectExecution(cwd,runId,options),{store,view}=initial;
  if(!initial.execution)throw new OrchestrationError('unavailable','Run has no execution history.');
  if(initial.execution.state.revision!==revision)throw new OrchestrationError('conflict','Execution changed; inspect the pending question again.');
  const q=pendingQuestion(store,initial.execution,questionId);
  const goalAuthority=view.manifest.version===2?(await import('../goals/index.js')).goalRunAuthority(view.manifest,dirname(dirname(store.root))):undefined;
  const permissionCall={id:questionId,name:'orchestration_answer',arguments:{path:cwd,runId,questionId,revision,taskId:q.taskId,sessionId:q.sessionId,attempt:q.attempt,callId:q.callId,ownerId:q.ownerId,
    planHash:initial.execution.state.graph?.hash??view.manifest.planHash,questionHash:digest(canonicalJson(q)),answerHash:digest(answer)}};
  const permissionKey=()=>withScope(cwd,()=>describeApproval(permissionCall,cwd).key),approvedKey=permissionKey();
  const assertAuthority=()=>{
    throwIfCancelled(options.signal);goalAuthority?.assertActive();
    const current=store.read();
    if(current.state.revision!==revision)throw new OrchestrationError('conflict','Execution changed during the answer decision.');
    pendingQuestion(store,current,questionId);
    if(permissionKey()!==approvedKey)throw new OrchestrationError('policy-denied','Question answer scope or policy changed before commit.');
  };
  await authorizeSessionAction(cwd,permissionCall.name,permissionCall.arguments,{...options,confirmation:options.confirmation??'mutating'});
  await store.append({type:'question_answered',taskId:q.taskId,questionId,answer},options.signal,undefined,assertAuthority);
  return store.read();
}
