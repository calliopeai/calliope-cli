import {join} from 'node:path';
import {authorizeSessionAction} from '../session-management/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {RunStore} from './store.js';
import {ExecutionStore} from './execution-store.js';
import {artifactSetHash} from './execution-journal.js';
import {readCollectedArtifact,checkArtifactSnapshot} from './verification.js';
import {OrchestrationError} from './types.js';
import type {RunActionOptions} from './actions.js';
import type {CoordinatorOptions} from './coordinator.js';
import type {ExecutionChange} from './coordinator-types.js';
import {ReservationLedger} from '../execution/index.js';
import {inspectSpawnAuthority} from '../spawning/authority.js';

export async function inspectExecution(cwd:string,runId:string,options:RunActionOptions={}) {
  const runs=options.store??new RunStore(),view=await runs.read(runId,cwd,options.signal),store=new ExecutionStore(join(runs.root,runId),view.manifest);
  return{view,store,execution:store.exists()?store.read():null,owner:store.exists()?store.owner():null};
}
export async function controlExecution(cwd:string,runId:string,action:'retry'|'accept'|'agent-stop'|'agent-retry',target:string,options:RunActionOptions&Pick<CoordinatorOptions,'onProgress'>={}) {
  const initial=await inspectExecution(cwd,runId,options);if(!initial.execution)throw new OrchestrationError('unavailable','Run has no execution history.');
  const {view,store}=initial,agentAction=action.startsWith('agent-'),context=store.context(initial.execution);
  const finish=()=>{const execution=store.read();options.onProgress?.({context:store.context(execution),execution});return execution;};
  const goalAuthority=view.manifest.version===2&&action!=='agent-stop'?(await import('../goals/index.js')).goalRunAuthority(view.manifest,(options.store??new RunStore()).root):undefined;
  const assertAuthority=()=>{store.assertApproval(initial.execution!.header);goalAuthority?.assertActive();const authority=inspectSpawnAuthority(store,new ReservationLedger(join(store.root,'..','budget')));if(action==='accept'&&authority.pending.length)throw new OrchestrationError('conflict','Recover pending child admission before accepting the run.');};
  if(agentAction?!context.plan.agents.some(a=>a.id===target):!context.plan.tasks.some(t=>t.id===target))throw new OrchestrationError('invalid','Unknown execution task or agent.');
  if(action==='accept'){
    const task=initial.execution.state.tasks[target]!;if(task.status!=='review_required'||!task.output)throw new OrchestrationError('conflict','Task is not awaiting acceptance.');
    for(const artifact of task.output.artifacts)await readCollectedArtifact(store,artifact,options);
  }
  await authorizeSessionAction(cwd,action==='accept'?'orchestration_accept':action==='agent-stop'?'orchestration_agent_stop':'orchestration_retry',
    {path:cwd,runId,target,action,planHash:initial.execution.state.graph?.hash??view.manifest.planHash,revision:initial.execution.state.revision,...(action==='accept'?{artifactsHash:artifactSetHash(initial.execution.state.tasks[target]!.output!.artifacts),acceptanceCriteria:context.plan.tasks.find(t=>t.id===target)!.acceptanceCriteria,agentCriteria:context.plan.agents.find(a=>a.id===initial.execution!.state.tasks[target]!.agentId)!.acceptanceCriteria,evidence:initial.execution.state.tasks[target]!.output}:{})},options);
  throwIfCancelled(options.signal);
  if(action==='agent-stop'){await store.append({type:'agent_stop',agentId:target},options.signal);return finish();}
  const lease=store.acquire();
  try {
    const current=store.read();assertAuthority();
    if(current.state.revision!==initial.execution.state.revision||current.state.ownerId)throw new OrchestrationError('conflict','Execution changed or needs orphan recovery; inspect and resume before applying this decision.');
    if(action==='accept'){
      const output=current.state.tasks[target]!.output!;for(const artifact of output.artifacts)await readCollectedArtifact(store,artifact,options);
      await store.appendBatch([{change:{type:'task_accepted',taskId:target,artifactsHash:artifactSetHash(output.artifacts)}}],options.signal,()=>{lease.check();assertAuthority();if(store.read().state.revision!==current.state.revision)throw new OrchestrationError('conflict','Execution changed during acceptance.');for(const artifact of output.artifacts)checkArtifactSnapshot(store,artifact);});
    }else if(action==='retry'){await store.append({type:'task_reset',taskId:target,source:'manual'},options.signal,undefined,()=>{lease.check();store.assertApproval(current.header);goalAuthority?.assertActive();});}
    else {
      const descendants=new Set([target]);for(let n=0;n<context.plan.agents.length;n++)for(const agent of context.plan.agents)if(agent.parentId&&descendants.has(agent.parentId))descendants.add(agent.id);
      const candidates=context.plan.tasks.filter(t=>descendants.has(t.agentId)&&['failed','denied','cancelled','unknown'].includes(current.state.tasks[t.id]!.status));
      if(!candidates.length&&!current.state.stoppedAgents.some(id=>descendants.has(id)))throw new OrchestrationError('conflict','Agent has no stopped or retryable task.');
      const changes:ExecutionChange[]=[...candidates.map(task=>({type:'task_reset' as const,taskId:task.id,source:'manual' as const})),...current.state.stoppedAgents.filter(id=>descendants.has(id)).map(agentId=>({type:'agent_reset' as const,agentId}))];
      await store.appendBatch(changes.map(change=>({change})),options.signal,()=>{lease.check();store.assertApproval(current.header);goalAuthority?.assertActive();if(store.read().state.revision!==current.state.revision)throw new OrchestrationError('conflict','Execution changed during agent retry.');});
    }
    return finish();
  }finally{lease.release();}
}
