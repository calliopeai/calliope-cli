import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson,approvalDisplayText,canonicalPath} from '../approvals/index.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {OrchestrationError,type ProjectTask} from './types.js';
import {array,id,shape,text} from './validation.js';
import {ExecutionStore,readArtifactBytes} from './execution-store.js';
import {mechanicallyVerified,validateCollectedArtifact} from './execution-journal.js';
import type {RunActionOptions} from './actions.js';
import type {CollectedArtifact,TaskOutput,TaskStatus} from './coordinator-types.js';
import type {WorkerWorktree,CommandEvidence} from '../isolation/index.js';

const hashBytes=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const contextForTask=(store:ExecutionStore,taskId:string)=>store.manifest.plan.tasks.some(t=>t.id===taskId)?store.manifest:store.context();
export function workerSummary(value:string):string {return approvalDisplayText(value).slice(0,8192).trim()||'The worker returned no summary.';}
/** Worker prose is a claim; it never supplies authoritative hashes, test passes or event IDs. */
export function workerReport(content:string,task:ProjectTask):{summary:string;outputs:Map<string,string>;risks:string[]} {
  const outputs=new Map<string,string>(),risks:string[]=[];let summary=workerSummary(content);
  if(content.length>1024*1024)return{summary,outputs,risks:['Worker report exceeded its size limit.']};
  const raw=content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');let value:unknown;
  try{value=JSON.parse(raw);}catch{return{summary,outputs,risks};}
  if (task.id === 'propose' && value && typeof value === 'object' && !Array.isArray(value) &&
      Object.hasOwn(value, 'agents') && Object.hasOwn(value, 'tasks') && Object.hasOwn(value, 'limits')) {
    outputs.set('proposal', raw);
    return {summary:'Raw ProjectPlan proposal captured for validation.', outputs, risks};
  }
  try {
    shape(value,['version','summary','outputs'],['risks']);if(value.version!==1)throw new Error();text(value.summary);array(value.outputs,100);summary=value.summary;
    if(value.risks!==undefined){array(value.risks,100);for(const risk of value.risks){text(risk);risks.push(risk);}}
    for(const output of value.outputs){shape(output,['id','content']);id(output.id);if(typeof output.content!=='string'||Buffer.byteLength(output.content)>1024*1024||approvalDisplayText(output.content)!==output.content||outputs.has(output.id)||!task.outputs.some(o=>o.id===output.id&&!o.path))throw new Error();outputs.set(output.id,output.content);}
  }catch {outputs.clear();risks.push('Worker report was malformed or contained unsafe text; its claims were not accepted.');}
  return{summary,outputs,risks};
}
export async function readCollectedArtifact(store:ExecutionStore,artifact:CollectedArtifact,options:RunActionOptions={}):Promise<Buffer> {
  validateCollectedArtifact(artifact,contextForTask(store,artifact.taskId));
  throwIfCancelled(options.signal);const file=artifact.location==='project'?resolve(store.manifest.project.root,artifact.path):join(store.root,'artifacts',artifact.path);
  if(canonicalPath(file)!==file)throw new OrchestrationError('conflict','Artifact path changed or became an alias.');
  const sourcePath=contextForTask(store,artifact.taskId).plan.tasks.find(t=>t.id===artifact.taskId)!.outputs.find(o=>o.id===artifact.id)!.path;
  if(sourcePath)await authorizeSessionAction(store.manifest.project.root,'read_file',{path:resolve(store.manifest.project.root,sourcePath),operation:'orchestration-verification',runId:store.manifest.id,artifactId:artifact.id},options);
  throwIfCancelled(options.signal);return checkArtifactSnapshot(store,artifact);
}
/** Recheck already-authorized content synchronously at the journal commit boundary. */
export function checkArtifactSnapshot(store:ExecutionStore,artifact:CollectedArtifact):Buffer {
  validateCollectedArtifact(artifact,contextForTask(store,artifact.taskId));
  const file=artifact.location==='project'?resolve(store.manifest.project.root,artifact.path):join(store.root,'artifacts',artifact.path),bytes=readArtifactBytes(file,1024*1024,artifact.location==='run');
  if(hashBytes(bytes)!==artifact.sha256||bytes.length!==artifact.bytes)throw new OrchestrationError('conflict','Artifact changed after collection; recorded output cannot be used.');return bytes;
}
export async function collectTaskOutput(store:ExecutionStore,task:ProjectTask,content:string,options:RunActionOptions&{workspace?:WorkerWorktree;executorOutputs?:Map<string,string>}={}):Promise<{output:TaskOutput;status:TaskStatus}> {
  options.workspace?.assertVerified(options.signal);
  const taskContext=contextForTask(store,task.id),verifiedWorkspaceHash=options.workspace?.snapshot(taskContext.plan.agents.find(a=>a.id===task.agentId)!.allowedPaths,options.signal);
  const claim=workerReport(content,task),prior=store.read().state,artifacts:CollectedArtifact[]=prior.tasks[task.id]!.artifactIds.map(id=>prior.artifacts[id]!),contents=new Map<string,Buffer>(),risks=[...claim.risks];
  for(const spec of task.outputs){
    const existing=artifacts.find(a=>a.id===spec.id);if(existing){contents.set(spec.id,checkArtifactSnapshot(store,existing));continue;}
    throwIfCancelled(options.signal);const eventId=randomUUID();let path:string,bytes:Buffer;
    try {
      if(spec.path){path=spec.path;const file=resolve(store.manifest.project.root,path);await authorizeSessionAction(store.manifest.project.root,'read_file',{path:file,operation:'orchestration-artifact',runId:store.manifest.id,taskId:task.id},options);throwIfCancelled(options.signal);options.workspace?.assertIdentity();bytes=readArtifactBytes(options.workspace?resolve(options.workspace.filesRoot,path):file);if(options.workspace)path=store.writeArtifact(eventId,bytes,options.signal);}
      else {const reserved=task.isolation&&(spec.id===task.isolation.patchArtifactId||task.isolation.commands.some(c=>c.artifactId===spec.id));const content=reserved?options.executorOutputs?.get(spec.id):claim.outputs.get(spec.id);if(content===undefined){risks.push(`Missing declared artifact: ${spec.id}.`);continue;}path=store.writeArtifact(eventId,content,options.signal);bytes=Buffer.from(content);}
    }catch(error){throwIfCancelled(options.signal);if(error instanceof OrchestrationError&&error.code==='limit')throw error;risks.push(`Artifact ${spec.id} could not be collected under current policy and scope.`);continue;}
    const artifact:CollectedArtifact={id:spec.id,taskId:task.id,agentId:task.agentId,kind:spec.kind,location:spec.path&&!options.workspace?'project':'run',path,sha256:hashBytes(bytes),bytes:bytes.length,createdAt:new Date().toISOString(),source:{runId:store.manifest.id,eventId},confidence:1};
    await store.append({type:'artifact',artifact},options.signal,eventId);artifacts.push(artifact);contents.set(spec.id,bytes);
  }
  const checks=(task.acceptanceChecks??[]).map(check=>{
    const bytes=contents.get(check.artifactId),artifact=artifacts.find(a=>a.id===check.artifactId);let passed=false;
    if(bytes){if(check.kind==='command'){try{const receipt=JSON.parse(bytes.toString()) as CommandEvidence&{workspace:{before:string;after:string|null}};passed=receipt.version===1&&receipt.kind==='isolated-command'&&receipt.outcome==='passed'&&receipt.exitCode===0&&receipt.cleanupConfirmed&&/^[a-f0-9]{64}$/.test(receipt.workspace.before)&&receipt.workspace.before===receipt.workspace.after&&receipt.workspace.after===verifiedWorkspaceHash;}catch{/* Malformed executor evidence is never a pass. */}}else if(check.kind==='exists')passed=true;else if(check.kind==='contains')passed=bytes.toString('utf8').includes(check.expected!);else if(check.kind==='sha256')passed=artifact!.sha256===check.expected;else try{passed=canonicalJson(JSON.parse(bytes.toString()))===canonicalJson(JSON.parse(check.expected!));}catch{/* Invalid JSON is failed evidence. */}}
    return{id:check.id,artifactId:check.artifactId,kind:check.kind,criteria:check.criteria,passed,observedHash:artifact?.sha256??null};
  });
  const state=store.read().state.tasks[task.id]!,output:TaskOutput={version:1,taskId:task.id,agentId:task.agentId,status:'partial',summary:claim.summary,changedFiles:[...state.changedFiles],artifacts,testEvidence:checks.filter(c=>c.passed).map(c=>c.id),unresolvedRisks:risks.slice(0,100),recommendedNextAction:'Review the remaining acceptance criteria.',checks};
  const complete=mechanicallyVerified(output,contextForTask(store,task.id)),failed=artifacts.length!==task.outputs.length||checks.some(c=>!c.passed);
  options.workspace?.assertVerified(options.signal);
  if(complete){output.status='success';output.recommendedNextAction='Continue with dependency-ready work.';}
  else if(failed){
    // A mutation may be real and mechanically verified even when the model
    // omitted a non-file report/receipt. Preserve those checks for supervised
    // evidence repair instead of treating the workspace as an unverified
    // failure. Human acceptance still requires every declared artifact.
    const missing=task.outputs.some(spec=>!artifacts.some(a=>a.id===spec.id));
    if(missing&&checks.length>0&&checks.every(check=>check.passed)&&state.mutations){
      output.status='partial';
      output.recommendedNextAction='Request the missing patch or verification receipt; do not repeat the mutation until evidence is complete.';
      return{output,status:'review_required'};
    }
    output.status='failed';output.recommendedNextAction='Inspect failed or missing evidence before retrying.';
  }
  else output.unresolvedRisks=[...risks.slice(0,99),'Natural-language acceptance criteria still require human review.'];
  const policyDenied=risks.some(r=>/current policy and scope|permission denied/i.test(r));
  return{output,status:policyDenied?'denied':complete?'completed':failed?'failed':'review_required'};
}
/** Retain only independently collected files/receipts, never truncated worker claims. */
export async function collectStoppedTaskOutput(store:ExecutionStore,task:ProjectTask,options:RunActionOptions&{workspace:WorkerWorktree;executorOutputs:Map<string,string>}):Promise<TaskOutput> {
  const {output}=await collectTaskOutput(store,task,'',options);
  const mechanicallyReady=output.checks.length>0&&output.checks.every(check=>check.passed)&&output.artifacts.length===task.outputs.length;
  return {...output,status:mechanicallyReady?'partial':'failed',summary:'Worker output was truncated; retained workspace evidence was collected independently.',
    unresolvedRisks:[...output.unresolvedRisks.slice(0,99),mechanicallyReady?'The incomplete worker report still requires human acceptance.':'The incomplete worker report was not accepted as success.'],
    recommendedNextAction:mechanicallyReady?'Review and accept the retained patch and verification receipts.':'Review the retained patch and verification receipts before a bounded retry; increase --max-output-tokens if needed for the worker report.'};
}
/** Retain completed process evidence even when cancellation stops later collection. */
export async function recordExecutorArtifact(store:ExecutionStore,task:ProjectTask,id:string,content:string):Promise<void> {
  if(!task.isolation?.commands.some(c=>c.artifactId===id))throw new OrchestrationError('invalid','Executor result is not declared by this task.');
  const eventId=randomUUID(),path=store.writeArtifact(eventId,content),bytes=Buffer.from(content);
  await store.append({type:'artifact',artifact:{id,taskId:task.id,agentId:task.agentId,kind:'test_result',location:'run',path,sha256:hashBytes(bytes),bytes:bytes.length,createdAt:new Date().toISOString(),source:{runId:store.manifest.id,eventId},confidence:1}},undefined,eventId);
}
