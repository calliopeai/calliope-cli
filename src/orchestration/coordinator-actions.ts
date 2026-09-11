import {join} from 'node:path';
import {authorizeSessionAction} from '../session-management/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {RunStore} from './store.js';
import {ExecutionStore} from './execution-store.js';
import {artifactSetHash} from './execution-journal.js';
import {readCollectedArtifact,checkArtifactSnapshot} from './verification.js';
import {OrchestrationError} from './types.js';
import type {RunActionOptions} from './actions.js';
import type {ExecutionChange} from './coordinator-types.js';

export async function inspectExecution(cwd:string,runId:string,options:RunActionOptions={}) {
  const runs=options.store??new RunStore(),view=await runs.read(runId,cwd,options.signal),store=new ExecutionStore(join(runs.root,runId),view.manifest);
  return{view,store,execution:store.exists()?store.read():null,owner:store.exists()?store.owner():null};
}
export async function controlExecution(cwd:string,runId:string,action:'retry'|'accept'|'agent-stop'|'agent-retry',target:string,options:RunActionOptions={}) {
  const initial=await inspectExecution(cwd,runId,options);if(!initial.execution)throw new OrchestrationError('unavailable','Run has no execution history.');
  const {view,store}=initial,agentAction=action.startsWith('agent-');
  if(agentAction?!view.manifest.plan.agents.some(a=>a.id===target):!view.manifest.plan.tasks.some(t=>t.id===target))throw new OrchestrationError('invalid','Unknown execution task or agent.');
  if(action==='accept'){
    const task=initial.execution.state.tasks[target]!;if(task.status!=='review_required'||!task.output)throw new OrchestrationError('conflict','Task is not awaiting acceptance.');
    for(const artifact of task.output.artifacts)await readCollectedArtifact(store,artifact,options);
  }
  await authorizeSessionAction(cwd,action==='accept'?'orchestration_accept':action==='agent-stop'?'orchestration_agent_stop':'orchestration_retry',
    {path:cwd,runId,target,action,planHash:view.manifest.planHash,revision:initial.execution.state.revision,...(action==='accept'?{artifactsHash:artifactSetHash(initial.execution.state.tasks[target]!.output!.artifacts),acceptanceCriteria:view.manifest.plan.tasks.find(t=>t.id===target)!.acceptanceCriteria,agentCriteria:view.manifest.plan.agents.find(a=>a.id===initial.execution!.state.tasks[target]!.agentId)!.acceptanceCriteria,evidence:initial.execution.state.tasks[target]!.output}:{})},options);
  throwIfCancelled(options.signal);
  if(action==='agent-stop'){await store.append({type:'agent_stop',agentId:target},options.signal);return store.read();}
  const lease=store.acquire();
  try {
    const current=store.read();store.assertApproval(current.header);
    if(current.state.revision!==initial.execution.state.revision||current.state.ownerId)throw new OrchestrationError('conflict','Execution changed or needs orphan recovery; inspect and resume before applying this decision.');
    if(action==='accept'){
      const output=current.state.tasks[target]!.output!;for(const artifact of output.artifacts)await readCollectedArtifact(store,artifact,options);
      await store.appendBatch([{change:{type:'task_accepted',taskId:target,artifactsHash:artifactSetHash(output.artifacts)}}],options.signal,()=>{lease.check();store.assertApproval(current.header);if(store.read().state.revision!==current.state.revision)throw new OrchestrationError('conflict','Execution changed during acceptance.');for(const artifact of output.artifacts)checkArtifactSnapshot(store,artifact);});
    }else if(action==='retry'){await store.append({type:'task_reset',taskId:target,source:'manual'},options.signal,undefined,()=>{lease.check();store.assertApproval(current.header);});}
    else {
      const descendants=new Set([target]);for(let n=0;n<view.manifest.plan.agents.length;n++)for(const agent of view.manifest.plan.agents)if(agent.parentId&&descendants.has(agent.parentId))descendants.add(agent.id);
      const candidates=view.manifest.plan.tasks.filter(t=>descendants.has(t.agentId)&&['failed','denied','cancelled','unknown'].includes(current.state.tasks[t.id]!.status));
      if(!candidates.length&&!current.state.stoppedAgents.some(id=>descendants.has(id)))throw new OrchestrationError('conflict','Agent has no stopped or retryable task.');
      const changes:ExecutionChange[]=[...candidates.map(task=>({type:'task_reset' as const,taskId:task.id,source:'manual' as const})),...current.state.stoppedAgents.filter(id=>descendants.has(id)).map(agentId=>({type:'agent_reset' as const,agentId}))];
      await store.appendBatch(changes.map(change=>({change})),options.signal,()=>{lease.check();store.assertApproval(current.header);if(store.read().state.revision!==current.state.revision)throw new OrchestrationError('conflict','Execution changed during agent retry.');});
    }
    return store.read();
  }finally{lease.release();}
}
