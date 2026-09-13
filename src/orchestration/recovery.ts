import {join} from 'node:path';
import {digest} from '../approvals/index.js';
import {throwIfCancelled,isCancellation} from '../cancellation.js';
import {ExecutionGuard,ExecutionLimitError,ReservationLedger} from '../execution/index.js';
import {readPinnedWorktreeBase,WorkerWorktree,worktreeGit,verifyInWorktree} from '../isolation/index.js';
import {authorizeSessionAction,SessionPolicyError} from '../session-management/index.js';
import {inspectExecution} from './coordinator-actions.js';
import {prepareAgentExecution} from './execution.js';
import {agentStopped} from './execution-journal.js';
import {collectStoppedTaskOutput,checkArtifactSnapshot,workerSummary} from './verification.js';
import {permits} from './validation.js';
import {OrchestrationError} from './types.js';
import type {CoordinatorOptions} from './coordinator.js';
import type {TaskOutput} from './coordinator-types.js';

/** One evidence-only recovery of a legacy cutoff; no model call, retry or new clock. */
export async function recoverTaskEvidence(cwd:string,runId:string,taskId:string,options:CoordinatorOptions={}) {
  const initial=await inspectExecution(cwd,runId,options),{store,view}=initial,prior=initial.execution;
  if(!prior)throw new OrchestrationError('unavailable','Run has no execution history.');
  const context=store.context(prior),task=context.plan.tasks.find(t=>t.id===taskId),state=prior.state.tasks[taskId];
  if(!task)throw new OrchestrationError('invalid','Unknown execution task.');
  const outcome=[...prior.events].reverse().find(e=>e.change.type==='task_finished'&&e.change.taskId===taskId);
  if(prior.state.ownerId||!task.isolation||state?.status!=='failed'||!state.mutations||state.output?.summary!=='Worker stopped: length.'||state.artifactIds.length||!outcome)
    throw new OrchestrationError('conflict','Recovery requires an inactive isolated cutoff attempt without receipts.');
  const agent=context.plan.agents.find(a=>a.id===task.agentId)!,workspaceRoot=join(store.root,`worker-${task.id}-${state.attempts}`);
  // Read first: a missing ledger or baseline is not permission to recreate it.
  new ReservationLedger(join(store.root,'..','budget')).read(cwd);
  const base=readPinnedWorktreeBase(store.root,view.manifest.project.root,view.manifest.planHash);
  const workspace=new WorkerWorktree(workspaceRoot,view.manifest.project.root,base);
  const operation=`Recover evidence for run ${runId}, task ${taskId}, attempt ${state.attempts}\nOriginal outcome: ${outcome.id}\nWorktree: ${workspace.filesRoot}\nBaseline: ${base}\nPaths: ${agent.allowedPaths.map(p=>p.path+' ('+p.access+')').join(', ')}\nImage: ${context.plan.workspace.isolation!.image}\nCommands: ${task.isolation.commands.map(c=>JSON.stringify(c.argv)).join('; ')}\nNo model calls; original budgets and deadlines remain in force.`;
  await authorizeSessionAction(cwd,'orchestration_evidence_recovery',{path:cwd,operation,runId,taskId,outcomeId:outcome.id,revision:prior.state.revision,planHash:view.manifest.planHash,workspace:workspace.filesRoot,base,attempt:state.attempts,commands:task.isolation.commands,paths:agent.allowedPaths}, {...options,confirmation:'mutating'});
  const authority=await prepareAgentExecution(cwd,runId,agent.id,1,options),lease=store.acquire(),controller=new AbortController();
  let began=false,timedOut=false,authorityFailure:unknown,eventCursor=prior.events.length;
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const assertAuthority=()=>{
    lease.check();authority.assertAuthority?.();store.assertApproval(prior.header);
    const current=store.read();
    if(agentStopped(current.state,store.context(current),agent.id)||began&&(current.state.ownerId!==lease.id||current.state.tasks[taskId]?.status!=='running'))throw new ExecutionLimitError('authority','Evidence recovery ownership or agent authority changed.');
    if(!began&&current.state.revision!==prior.state.revision)throw new OrchestrationError('conflict','Execution changed before evidence recovery.');
  };
  let timer:ReturnType<typeof setInterval>|undefined,deadline:ReturnType<typeof setTimeout>|undefined;
  const notify=()=>{const execution=store.read();for(const event of execution.events)if(event.sequence>eventCursor){options.onEvent?.(event);eventCursor=event.sequence;}options.onProgress?.({context:store.context(execution),execution,manifest:view.manifest});return execution;};
  const append=async(change:Parameters<typeof store.append>[0],verify=false)=>{
    await store.append(change,undefined,undefined,()=>{lease.check();if(verify){throwIfCancelled(controller.signal);assertAuthority();if(change.type==='task_finished')for(const artifact of change.output.artifacts)checkArtifactSnapshot(store,artifact);}});notify();
  };
  try {
    const guard=new ExecutionGuard({...authority,workspace,assertAuthority},cwd);
    deadline=setTimeout(()=>{timedOut=true;controller.abort();},Math.max(0,guard.deadline-Date.now()));
    timer=setInterval(()=>{try{guard.assertActive(controller.signal);}catch(error){authorityFailure??=error;controller.abort();}},100);
    guard.assertActive(controller.signal);
    const patch=await workspace.patch(controller.signal),changed=(await worktreeGit(workspace.filesRoot,['diff','--cached','--name-only','--no-renames','-z',base,'--'],controller.signal)).split('\0').filter(Boolean);
    if(changed.some(path=>!state.changedFiles.includes(path)||!permits(agent.allowedPaths,path,'write')))throw new OrchestrationError('conflict','Retained workspace includes unrecorded or unauthorized changes; preserve it for manual inspection.');
    const snapshot=workspace.snapshot(agent.allowedPaths,controller.signal);
    await authorizeSessionAction(cwd,'orchestration_evidence_recovery',{path:cwd,operation:operation+`\nPatch SHA-256: ${digest(patch)}\nWorkspace SHA-256: ${snapshot}`,runId,taskId,outcomeId:outcome.id,revision:prior.state.revision,workspace:workspace.filesRoot,base,patchHash:digest(patch),snapshot,commands:task.isolation.commands}, {...options,signal:controller.signal,confirmation:'mutating'});
    guard.assertActive(controller.signal);
    if(workspace.snapshot(agent.allowedPaths,controller.signal)!==snapshot||await workspace.patch(controller.signal)!==patch)throw new OrchestrationError('conflict','Retained workspace changed during recovery approval.');
    await store.appendBatch([{change:{type:'started',ownerId:lease.id}},{change:{type:'task_recovery_started',taskId,outcomeId:outcome.id}}],controller.signal,()=>guard.assertActive(controller.signal));
    began=true;notify();
    const recoveryOptions={...options,signal:controller.signal,workspace};
    const executorOutputs=await verifyInWorktree(store,task,workspace,guard,{...recoveryOptions,expectedWorkspaceHash:snapshot});
    if(workspace.snapshot(agent.allowedPaths,controller.signal)!==snapshot||executorOutputs.get(task.isolation.patchArtifactId)!==patch)throw new OrchestrationError('conflict','Retained workspace changed during recovery verification.');
    const output=await collectStoppedTaskOutput(store,task,{...recoveryOptions,executorOutputs});
    output.summary='Recovered current retained workspace evidence after a worker output cutoff; the original report remains incomplete.';
    await append({type:'task_finished',taskId,status:'failed',output},true);began=false;
    await append({type:'finished',ownerId:lease.id,status:'failed'});return notify();
  }catch(error){
    const failure=timedOut?new ExecutionLimitError('deadline','Original evidence recovery deadline expired.'):authorityFailure??error;
    if(began){
      const status=options.signal?.aborted?'cancelled':timedOut||authorityFailure?'denied':isCancellation(failure)?'cancelled':failure instanceof SessionPolicyError||failure instanceof ExecutionLimitError?'denied':'failed';
      const current=store.read().state,t=current.tasks[taskId]!;
      const output:TaskOutput={version:1,taskId,agentId:agent.id,status,summary:workerSummary(failure instanceof Error?failure.message:'Evidence recovery failed.'),changedFiles:[...t.changedFiles],artifacts:t.artifactIds.map(id=>current.artifacts[id]!),testEvidence:[],checks:[],unresolvedRisks:['Evidence recovery did not complete; inspect the retained workspace and any process receipts.'],recommendedNextAction:'Preserve this attempt; its one evidence recovery was consumed. No worker success was accepted.'};
      await append({type:'task_finished',taskId,status,output});began=false;await append({type:'finished',ownerId:lease.id,status});
    }
    throw failure;
  }finally{clearInterval(timer);clearTimeout(deadline);controller.abort();options.signal?.removeEventListener('abort',abort);lease.release();}
}
