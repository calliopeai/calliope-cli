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

const hashBytes=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
export function workerSummary(value:string):string {return approvalDisplayText(value).slice(0,8192).trim()||'The worker returned no summary.';}
/** Worker prose is a claim; it never supplies authoritative hashes, test passes or event IDs. */
export function workerReport(content:string,task:ProjectTask):{summary:string;outputs:Map<string,string>;risks:string[]} {
  const outputs=new Map<string,string>(),risks:string[]=[];let summary=workerSummary(content);
  if(content.length>1024*1024)return{summary,outputs,risks:['Worker report exceeded its size limit.']};
  const raw=content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');let value:unknown;
  try{value=JSON.parse(raw);}catch{return{summary,outputs,risks};}
  try {
    shape(value,['version','summary','outputs'],['risks']);if(value.version!==1)throw new Error();text(value.summary);array(value.outputs,100);summary=value.summary;
    if(value.risks!==undefined){array(value.risks,100);for(const risk of value.risks){text(risk);risks.push(risk);}}
    for(const output of value.outputs){shape(output,['id','content']);id(output.id);if(typeof output.content!=='string'||Buffer.byteLength(output.content)>1024*1024||approvalDisplayText(output.content)!==output.content||outputs.has(output.id)||!task.outputs.some(o=>o.id===output.id&&!o.path))throw new Error();outputs.set(output.id,output.content);}
  }catch {outputs.clear();risks.push('Worker report was malformed or contained unsafe text; its claims were not accepted.');}
  return{summary,outputs,risks};
}
export async function readCollectedArtifact(store:ExecutionStore,artifact:CollectedArtifact,options:RunActionOptions={}):Promise<Buffer> {
  validateCollectedArtifact(artifact,store.manifest);
  throwIfCancelled(options.signal);const file=artifact.location==='project'?resolve(store.manifest.project.root,artifact.path):join(store.root,'artifacts',artifact.path);
  if(canonicalPath(file)!==file)throw new OrchestrationError('conflict','Artifact path changed or became an alias.');
  if(artifact.location==='project')await authorizeSessionAction(store.manifest.project.root,'read_file',{path:file,operation:'orchestration-verification',runId:store.manifest.id,artifactId:artifact.id},options);
  throwIfCancelled(options.signal);return checkArtifactSnapshot(store,artifact);
}
/** Recheck already-authorized content synchronously at the journal commit boundary. */
export function checkArtifactSnapshot(store:ExecutionStore,artifact:CollectedArtifact):Buffer {
  validateCollectedArtifact(artifact,store.manifest);
  const file=artifact.location==='project'?resolve(store.manifest.project.root,artifact.path):join(store.root,'artifacts',artifact.path),bytes=readArtifactBytes(file,1024*1024,artifact.location==='run');
  if(hashBytes(bytes)!==artifact.sha256||bytes.length!==artifact.bytes)throw new OrchestrationError('conflict','Artifact changed after collection; recorded output cannot be used.');return bytes;
}
export async function collectTaskOutput(store:ExecutionStore,task:ProjectTask,content:string,options:RunActionOptions={}):Promise<{output:TaskOutput;status:TaskStatus}> {
  const claim=workerReport(content,task),artifacts:CollectedArtifact[]=[],contents=new Map<string,Buffer>(),risks=[...claim.risks];
  for(const spec of task.outputs){
    throwIfCancelled(options.signal);const eventId=randomUUID();let path:string,bytes:Buffer;
    try {
      if(spec.path){path=spec.path;const file=resolve(store.manifest.project.root,path);await authorizeSessionAction(store.manifest.project.root,'read_file',{path:file,operation:'orchestration-artifact',runId:store.manifest.id,taskId:task.id},options);throwIfCancelled(options.signal);bytes=readArtifactBytes(file);}
      else {const content=claim.outputs.get(spec.id);if(content===undefined){risks.push(`Missing declared artifact: ${spec.id}.`);continue;}path=store.writeArtifact(eventId,content,options.signal);bytes=Buffer.from(content);}
    }catch(error){throwIfCancelled(options.signal);if(error instanceof OrchestrationError&&error.code==='limit')throw error;risks.push(`Artifact ${spec.id} could not be collected under current policy and scope.`);continue;}
    const artifact:CollectedArtifact={id:spec.id,taskId:task.id,agentId:task.agentId,kind:spec.kind,location:spec.path?'project':'run',path,sha256:hashBytes(bytes),bytes:bytes.length,createdAt:new Date().toISOString(),source:{runId:store.manifest.id,eventId},confidence:1};
    await store.append({type:'artifact',artifact},options.signal,eventId);artifacts.push(artifact);contents.set(spec.id,bytes);
  }
  const checks=(task.acceptanceChecks??[]).map(check=>{
    const bytes=contents.get(check.artifactId),artifact=artifacts.find(a=>a.id===check.artifactId);let passed=false;
    if(bytes){if(check.kind==='exists')passed=true;else if(check.kind==='contains')passed=bytes.toString('utf8').includes(check.expected!);else if(check.kind==='sha256')passed=artifact!.sha256===check.expected;else try{passed=canonicalJson(JSON.parse(bytes.toString()))===canonicalJson(JSON.parse(check.expected!));}catch{/* Invalid JSON is failed evidence. */}}
    return{id:check.id,artifactId:check.artifactId,kind:check.kind,criteria:check.criteria,passed,observedHash:artifact?.sha256??null};
  });
  const state=store.read().state.tasks[task.id]!,output:TaskOutput={version:1,taskId:task.id,agentId:task.agentId,status:'partial',summary:claim.summary,changedFiles:[...state.changedFiles],artifacts,testEvidence:checks.filter(c=>c.passed).map(c=>c.id),unresolvedRisks:risks.slice(0,100),recommendedNextAction:'Review the remaining acceptance criteria.',checks};
  const complete=mechanicallyVerified(output,store.manifest),failed=artifacts.length!==task.outputs.length||checks.some(c=>!c.passed);
  if(complete){output.status='success';output.recommendedNextAction='Continue with dependency-ready work.';}
  else if(failed){output.status='failed';output.recommendedNextAction='Inspect failed or missing evidence before retrying.';}
  else output.unresolvedRisks=[...risks.slice(0,99),'Natural-language acceptance criteria still require human review.'];
  return{output,status:complete?'completed':failed?'failed':'review_required'};
}
