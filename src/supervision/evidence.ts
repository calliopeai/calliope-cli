import {canonicalJson} from '../approvals/index.js';
import type {ExecutionStore} from '../orchestration/execution-store.js';
import type {CollectedArtifact} from '../orchestration/coordinator-types.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import {readCollectedArtifact} from '../orchestration/verification.js';
import {OrchestrationError} from '../orchestration/types.js';
import {permits} from '../orchestration/validation.js';
import {SessionPolicyError} from '../session-management/index.js';
import {assertSupervisedRetry} from './journal.js';
import type {RetryReceipt} from './types.js';

/** Immutable result references remain complete; artifact excerpts have explicit bounds. */
export async function reviewEvidence(store:ExecutionStore,ids:string[],options:RunActionOptions,readerId?:string) {
  const view=store.read(),plan=store.context(view).plan,reader=readerId?plan.agents.find(a=>a.id===readerId):undefined,outcomes=[];let remaining=32768;
  if(readerId&&!reader)throw new SessionPolicyError();
  for(const id of ids){
    const event=view.events.find(e=>e.id===id);
    if(!event||!['task_finished','task_accepted'].includes(event.change.type))throw new OrchestrationError('invalid','Review evidence must name recorded task outcomes.');
    const change=event.change as Extract<typeof event.change,{type:'task_finished'|'task_accepted'}>;
    const output=change.type==='task_finished'?change.output:view.state.tasks[change.taskId]!.output;
    const artifacts=[];
    for(const artifact of output?.artifacts??[]){
      const sourcePath=plan.tasks.find(t=>t.id===artifact.taskId)!.outputs.find(o=>o.id===artifact.id)!.path;
      if(reader&&sourcePath&&!permits(reader.allowedPaths,sourcePath,'read'))throw new SessionPolicyError();
      const bytes=await readCollectedArtifact(store,artifact,options),length=Math.min(4096,remaining,bytes.length);remaining-=length;
      artifacts.push({id:artifact.id,kind:artifact.kind,sha256:artifact.sha256,source:artifact.source,bytes:bytes.length,excerpt:bytes.subarray(0,length).toString('utf8'),truncated:length<bytes.length});
    }
    outcomes.push({eventId:id,taskId:change.taskId,status:change.type==='task_finished'?change.status:'completed',summary:output?.summary,checks:output?.checks,risks:output?.unresolvedRisks,artifacts});
  }
  return outcomes;
}

/** Only executor receipts with confirmed process cleanup can justify another isolated attempt. */
export async function retryEvidence(store:ExecutionStore,taskId:string,options:RunActionOptions):Promise<{receipts:RetryReceipt[];artifacts:CollectedArtifact[]}> {
  const view=store.read(),plan=store.context(view).plan,state=view.state;
  assertSupervisedRetry(plan,state,view.events,taskId);
  const task=state.tasks[taskId]!,spec=plan.tasks.find(t=>t.id===taskId)!,receipts:RetryReceipt[]=[],artifacts=task.output?.artifacts??[];
  if(task.mutations)for(const artifact of artifacts){
    const bytes=await readCollectedArtifact(store,artifact,options),command=spec.isolation!.commands.find(c=>c.artifactId===artifact.id);
    if(!command)continue;
    let value;try{value=JSON.parse(bytes.toString());}catch{throw new OrchestrationError('invalid','Verification receipt is malformed.');}
    if(value.version!==1||value.kind!=='isolated-command'||canonicalJson(value.argv)!==canonicalJson(command.argv)||value.image!==plan.workspace.isolation!.image||value.cleanupConfirmed!==true||!['passed','failed','timeout'].includes(value.outcome)||!Number.isSafeInteger(value.exitCode)||value.exitCode<0||!/^[a-f0-9]{64}$/.test(value.workspace?.before)||value.workspace.before!==value.workspace.after)
      throw new OrchestrationError('conflict','Verification cleanup or workspace evidence does not permit automatic retry.');
    receipts.push({artifactId:artifact.id,sha256:artifact.sha256,exitCode:value.exitCode,outcome:value.outcome,cleanupConfirmed:true});
  }
  assertSupervisedRetry(plan,state,view.events,taskId,receipts);return{receipts,artifacts};
}
