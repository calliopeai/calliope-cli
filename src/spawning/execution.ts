import {coordinatorProgress} from '../orchestration/progress.js';
import {cancellableDelay,throwIfCancelled,isCancellation,cancellationError} from '../cancellation.js';
import {canonicalJson} from '../approvals/index.js';
import {executeReviewedRun,type CoordinatorOptions} from '../orchestration/coordinator.js';
import {inspectExecution} from '../orchestration/coordinator-actions.js';
import {OrchestrationError} from '../orchestration/types.js';
import type {SpawnAdmission} from './types.js';

/** A successful admission is not successful child work; wait for verified outcomes. */
export async function executeSpawn(cwd:string,admission:SpawnAdmission,options:CoordinatorOptions={}) {
  const runId=admission.proposal.runId,initial=await inspectExecution(cwd,runId,options),store=initial.store;
  const recorded=initial.execution?.state.graph?.admissions.find(a=>a.proposal.hash===admission.proposal.hash);
  if(!initial.execution||!recorded||canonicalJson(recorded)!==canonicalJson(admission))throw new OrchestrationError('conflict','Child graph has not been admitted or differs from its recorded authority.');
  let cursor=initial.execution.events.length,resumed=false,cancelled=false;
  const roots=admission.proposal.agents.filter(agent=>!admission.proposal.agents.some(a=>a.id===agent.parentId));
  const stopChildren=async()=>{if(cancelled)return;cancelled=true;await store.appendBatch(roots.map(agent=>({change:{type:'agent_stop',agentId:agent.id}})));};
  try {
    while(true){
      const view=store.read();options.onProgress?.(coordinatorProgress(store,view));for(const event of view.events.slice(cursor))options.onEvent?.(event);cursor=view.events.length;
      const tasks=admission.proposal.tasks.map(task=>view.state.tasks[task.id]!),owner=store.owner();
      if(options.signal?.aborted){await stopChildren();if(!tasks.some(task=>task.status==='running')||!owner?.alive||Date.now()>=view.header.deadline)throw cancellationError();}
      else if(tasks.every(task=>!['pending','running'].includes(task.status))||(!owner?.alive&&resumed)||Date.now()>=view.header.deadline){
        const status=tasks.every(task=>task.status==='completed')?'completed':tasks.some(task=>task.status==='denied')?'denied':tasks.some(task=>task.status==='cancelled')?'cancelled':tasks.some(task=>['completed','review_required','pending'].includes(task.status))?'partial':'failed';
        return{version:1 as const,type:'orchestration.spawn' as const,runId,proposalHash:admission.proposal.hash,status,execution:view,exitCode:status==='completed'?0:status==='partial'?4:status==='denied'?3:status==='cancelled'?130:1};
      }
      else if(!owner?.alive){
        try{await executeReviewedRun(cwd,runId,{...options,resume:true,onEvent:event=>{if(event.sequence>cursor){options.onEvent?.(event);cursor=event.sequence;}}});resumed=true;continue;}
        catch(error){if(!(error instanceof OrchestrationError&&error.code==='locked'))throw error;}
      }
      await cancellableDelay(100);
    }
  }catch(error){if(options.signal?.aborted||isCancellation(error)){await stopChildren();throwIfCancelled(options.signal);}throw error;}
}
