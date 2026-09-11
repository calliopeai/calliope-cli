import {canonicalJson,digest} from '../approvals/index.js';
import {analyzePlan,array,hex,id,integer,iso,pathName,permits,shape,strings,text,uuid,fail} from './validation.js';
import {OrchestrationError,type RunManifest} from './types.js';
import type {CollectedArtifact,ExecutionEvent,ExecutionHeader,ExecutionProjection,TaskOutput,RunPlanContext} from './coordinator-types.js';
import {validateSpawnAdmission,extendPlan} from '../spawning/validation.js';

export const MAX_EXECUTION_EVENTS=10000,MAX_EXECUTION_BYTES=32*1024*1024,MAX_EXECUTION_EVENT_BYTES=128*1024;
export const journalHash=(header:ExecutionHeader,events:ExecutionEvent[])=>digest(canonicalJson({header,events:events.map(e=>e.hash)}));
export function validateExecutionHeader(value:unknown,manifest:RunManifest):ExecutionHeader {
  shape(value,['version','runId','manifestHash','approvalRevision','createdAt','deadline']);
  if(value.version!==1||value.runId!==manifest.id||value.manifestHash!==manifest.hash||!uuid(value.approvalRevision)||!iso(value.createdAt))fail('Execution header does not match its reviewed run.');
  integer(value.deadline,Date.parse(value.createdAt)+1,Date.parse(value.createdAt)+manifest.plan.limits.timeBudgetMs);
  return value as unknown as ExecutionHeader;
}
export function validateCollectedArtifact(value:unknown,manifest:RunPlanContext):CollectedArtifact {
  shape(value,['id','taskId','agentId','kind','location','path','sha256','bytes','createdAt','source','confidence']);
  const task=manifest.plan.tasks.find(t=>t.id===value.taskId&&t.agentId===value.agentId),spec=task?.outputs.find(o=>o.id===value.id);
  if(!task||!spec||spec.kind!==value.kind||!hex(value.sha256)||!iso(value.createdAt)||value.confidence!==1)fail('Invalid collected artifact provenance.');
  pathName(value.path);integer(value.bytes,0,1024*1024);shape(value.source,['runId','eventId']);
  if(value.source.runId!==manifest.id||!uuid(value.source.eventId))fail('Artifact requires a source event in this run.');
  if(value.location==='project') {
    if(manifest.plan.workspace.isolation)fail('Isolated artifacts must be retained as immutable run snapshots.');
    if(value.path!==spec.path||!permits(manifest.plan.agents.find(a=>a.id===task.agentId)!.allowedPaths,value.path,'write'))fail('Artifact exceeds the reviewed output scope.');
  }else if(value.location!=='run'||spec.path!==undefined&&!manifest.plan.workspace.isolation||value.path!==value.source.eventId+'.txt')fail('Invalid run artifact location.');
  return value as unknown as CollectedArtifact;
}
export function validateTaskOutput(value:unknown,manifest:RunPlanContext):TaskOutput {
  shape(value,['version','taskId','agentId','status','summary','changedFiles','artifacts','testEvidence','unresolvedRisks','recommendedNextAction','checks']);
  const task=manifest.plan.tasks.find(t=>t.id===value.taskId&&t.agentId===value.agentId);if(value.version!==1||!task||!['success','partial','failed','denied','cancelled'].includes(String(value.status)))fail('Invalid task output.');
  text(value.summary);text(value.recommendedNextAction);strings(value.changedFiles,256);strings(value.testEvidence,200);strings(value.unresolvedRisks,100);array(value.artifacts,100);array(value.checks,200);
  const agent=manifest.plan.agents.find(a=>a.id===task.agentId)!;
  for(const path of value.changedFiles){pathName(path);if(!permits(agent.allowedPaths,path,'write'))fail('Changed file exceeds task authority.');}
  const artifacts=value.artifacts.map(a=>validateCollectedArtifact(a,manifest));if(new Set(artifacts.map(a=>a.id)).size!==artifacts.length||artifacts.some(a=>a.taskId!==task.id))fail('Output artifacts belong to another task.');
  const checkIds=new Set<string>();for(const check of value.checks){
    shape(check,['id','artifactId','kind','criteria','passed','observedHash']);const spec=task.acceptanceChecks?.find(c=>c.id===check.id);
    if(!spec||checkIds.has(spec.id)||check.artifactId!==spec.artifactId||check.kind!==spec.kind||canonicalJson(check.criteria)!==canonicalJson(spec.criteria)||typeof check.passed!=='boolean'||check.observedHash!==null&&!hex(check.observedHash))fail('Verification evidence differs from the reviewed check.');
    const artifact=artifacts.find(a=>a.id===spec.artifactId);if(check.observedHash!==(artifact?.sha256??null)||check.passed&&!artifact)fail('Verification evidence requires the collected artifact.');checkIds.add(spec.id);
  }
  const output=value as unknown as TaskOutput;
  if(canonicalJson(output.testEvidence)!==canonicalJson(output.checks.filter(c=>c.passed).map(c=>c.id)))fail('Test evidence must name checks actually recorded as passing.');
  return output;
}
export function mechanicallyVerified(output:TaskOutput,manifest:RunPlanContext):boolean {
  const task=manifest.plan.tasks.find(t=>t.id===output.taskId)!,agent=manifest.plan.agents.find(a=>a.id===task.agentId)!;
  if(task.outputs.some(o=>!output.artifacts.some(a=>a.id===o.id))||output.checks.length!==(task.acceptanceChecks?.length??0)||output.checks.some(c=>!c.passed))return false;
  const covered=new Set(output.checks.flatMap(c=>c.criteria));
  return task.acceptanceCriteria.every((_,i)=>covered.has('task:'+i))&&agent.acceptanceCriteria.every((_,i)=>covered.has('agent:'+i));
}
export function validateExecutionEvent(value:unknown,manifest:RunManifest,header?:ExecutionHeader):ExecutionEvent {
  shape(value,['version','id','runId','sequence','at','previous','change','hash']);
  if(![1,2].includes(value.version as number)||!uuid(value.id)||value.runId!==manifest.id||!iso(value.at)||!hex(value.previous)||!hex(value.hash))fail('Invalid execution event.');integer(value.sequence,1,MAX_EXECUTION_EVENTS);
  shape(value.change,['type'],['ownerId','taskId','attempt','sessionId','callId','name','path','stage','mutating','success','artifact','status','output','source','artifactsHash','agentId','target','admission']);const c=value.change;
  if(value.version!==(c.type==='graph_admitted'?2:1))fail('Execution event version does not match its change.');
  if(c.type==='graph_admitted'){shape(c,['type','admission']);if(!header)fail('A graph admission requires its original execution header.');validateSpawnAdmission(c.admission,manifest,header,manifest.plan);}
  else if(c.type==='started'){shape(c,['type','ownerId']);if(!uuid(c.ownerId))fail('Invalid coordinator owner.');}
  else if(c.type==='task_started'){shape(c,['type','taskId','attempt','sessionId']);integer(c.attempt,1,4);text(c.sessionId,128);if(!/^[a-zA-Z0-9_-]+$/.test(c.sessionId))fail('Invalid agent session.');}
  else if(c.type==='agent_started'||c.type==='agent_finished'||c.type==='escalated'){
    shape(c,['type','agentId','taskId',...(c.type==='agent_finished'?['status']:c.type==='escalated'?['target']:[])]);
    const task=manifest.plan.tasks.find(t=>t.id===c.taskId&&t.agentId===c.agentId);if(!task)fail('Agent event does not match its assigned task.');
    if(c.type==='agent_finished'&&!['completed','review_required','failed','denied','cancelled','unknown'].includes(String(c.status)))fail('Invalid agent outcome.');
    if(c.type==='escalated'&&c.target!==manifest.plan.agents.find(a=>a.id===task.agentId)!.escalationPolicy.onFailure)fail('Escalation differs from the reviewed policy.');
  }
  else if(c.type==='tool'){shape(c,['type','taskId','callId','name','path','stage','mutating','success']);text(c.callId,256);text(c.name,128);if(c.path!==null)pathName(c.path);if(!['started','finished'].includes(String(c.stage))||typeof c.mutating!=='boolean'||typeof c.success!=='boolean'||c.stage==='started'&&c.success)fail('Invalid tool evidence.');}
  else if(c.type==='artifact'){shape(c,['type','artifact']);const a=validateCollectedArtifact(c.artifact,manifest);if(a.source.eventId!==value.id)fail('Artifact event ID does not match its provenance.');}
  else if(c.type==='task_finished'){shape(c,['type','taskId','status','output']);if(!['completed','review_required','failed','denied','cancelled','unknown'].includes(String(c.status)))fail('Invalid task outcome.');if(validateTaskOutput(c.output,manifest).taskId!==c.taskId)fail('Task result ID differs.');}
  else if(c.type==='task_reset'){shape(c,['type','taskId','source']);if(!['automatic','manual'].includes(String(c.source)))fail('Invalid retry authority.');}
  else if(c.type==='task_accepted'){shape(c,['type','taskId','artifactsHash']);if(!hex(c.artifactsHash))fail('Invalid accepted artifacts.');}
  else if(c.type==='agent_stop'||c.type==='agent_reset'){shape(c,['type','agentId']);if(!manifest.plan.agents.some(a=>a.id===c.agentId))fail('Unknown agent.');}
  else if(c.type==='finished'){shape(c,['type','ownerId','status']);if(!uuid(c.ownerId)||!['completed','partial','failed','denied','cancelled'].includes(String(c.status)))fail('Invalid execution outcome.');}
  else fail('Unknown execution event.');
  if('taskId' in c&&!manifest.plan.tasks.some(t=>t.id===c.taskId))fail('Unknown task.');
  const {hash,...body}=value;if(digest(canonicalJson(body))!==hash||Buffer.byteLength(JSON.stringify(value))>MAX_EXECUTION_EVENT_BYTES)fail('Execution event hash or size is invalid.');
  return value as unknown as ExecutionEvent;
}
export const artifactSetHash=(artifacts:CollectedArtifact[])=>digest(canonicalJson(artifacts));
export function agentStopped(state:ExecutionProjection,manifest:RunPlanContext,agentId:string):boolean {
  let current=manifest.plan.agents.find(a=>a.id===agentId);for(let n=0;current&&n<256;n++){if(state.stoppedAgents.includes(current.id)||Object.values(state.tasks).some(t=>t.agentId===current!.id&&t.escalation))return true;current=manifest.plan.agents.find(a=>a.id===current!.parentId);}return false;
}
export function replayExecution(header:ExecutionHeader,manifest:RunManifest,events:ExecutionEvent[]):ExecutionProjection {
  validateExecutionHeader(header,manifest);array(events,MAX_EXECUTION_EVENTS);let analysis=analyzePlan(manifest.plan);
  const state:ExecutionProjection={version:1,runId:manifest.id,revision:journalHash(header,[]),status:'ready',ownerId:null,deadline:header.deadline,tasks:Object.create(null),artifacts:Object.create(null),stoppedAgents:[]};
  for(const task of manifest.plan.tasks)state.tasks[task.id]={id:task.id,agentId:task.agentId,status:'pending',attempts:0,sessionId:null,output:null,artifactIds:[],changedFiles:[],mutations:false,escalation:null};
  const seen=new Set<string>(),agentEvents=new Set<string>(),toolStarts=new Map<string,string>();let last=header.createdAt;
  const conflict=(message:string):never=>{throw new OrchestrationError('conflict',message);};
  const active=()=>{if(state.status!=='running'||!state.ownerId)conflict('Coordinator is not active.');};
  for(const event of events){
    validateExecutionEvent(event,manifest,header);if(seen.has(event.id)||event.sequence!==seen.size+1||event.previous!==state.revision||event.at<last)fail('Broken execution event ancestry.');seen.add(event.id);last=event.at;
    const c=event.change,task='taskId' in c?state.tasks[c.taskId]!:undefined;
    if(c.type==='graph_admitted'){
      const admission=c.admission;if(state.status==='completed'||Date.parse(event.at)>=header.deadline||Date.parse(event.at)<admission.grant.at||admission.grant.grant.accounts.some(a=>Date.parse(event.at)>=a.deadline)||agentStopped(state,manifest,admission.proposal.parentId))conflict('Child graph cannot join a completed, stopped or expired run.');
      const p=admission.proposal;manifest={...manifest,plan:extendPlan(manifest.plan,{version:p.version,parentId:p.parentId,agents:p.agents,tasks:p.tasks})};analysis=analyzePlan(manifest.plan);
      for(const task of p.tasks)state.tasks[task.id]={id:task.id,agentId:task.agentId,status:'pending',attempts:0,sessionId:null,output:null,artifactIds:[],changedFiles:[],mutations:false,escalation:null};
      state.graph={version:1,plan:manifest.plan,hash:analysis.hash,admissions:[...(state.graph?.admissions??[]),admission]};state.version=2;
    }else if(c.type==='started'){
      if(state.status==='completed'||Date.parse(event.at)>=header.deadline)conflict('Execution is complete or its original deadline expired.');
      for(const t of Object.values(state.tasks))if(t.status==='running')t.status='unknown';state.ownerId=c.ownerId;state.status='running';
    }else if(c.type==='task_started'){
      active();const spec=manifest.plan.tasks.find(t=>t.id===c.taskId)!,agent=manifest.plan.agents.find(a=>a.id===spec.agentId)!;
      if(task!.status!=='pending'||agentStopped(state,manifest,agent.id)||c.attempt!==task!.attempts+1||c.attempt>agent.escalationPolicy.maxRetries+1||Date.parse(event.at)>=Math.min(header.deadline,Date.parse(header.createdAt)+agent.timeBudgetMs)||spec.dependencies.some(d=>!['completed','review_required'].includes(state.tasks[d]!.status)))conflict('Task is not ready or exceeds its retry/deadline limit.');
      if(Object.values(state.tasks).filter(t=>t.status==='running').length>=manifest.plan.limits.maxConcurrent)conflict('Run concurrency limit reached.');
      for(const t of Object.values(state.tasks).filter(t=>t.status==='running'))if(analysis.conflicts.some(pair=>pair.tasks.includes(t.id)&&pair.tasks.includes(c.taskId)))conflict('Concurrent task scopes conflict.');
      task!.status='running';task!.attempts=c.attempt;task!.sessionId=c.sessionId;
    }else if(c.type==='agent_started'||c.type==='agent_finished'){
      active();const key=c.type+':'+c.taskId+':'+task!.attempts;
      if(agentEvents.has(key)||c.type==='agent_started'&&task!.status!=='running'||c.type==='agent_finished'&&(task!.status!==c.status||!agentEvents.has('agent_started:'+c.taskId+':'+task!.attempts)))conflict('Agent lifecycle event does not match its task attempt.');agentEvents.add(key);
    }else if(c.type==='escalated'){
      active();if(task!.escalation||!['failed','denied','unknown'].includes(task!.status))conflict('Escalation requires a terminal unsuccessful task.');task!.escalation=c.target;
    }else if(c.type==='tool'){
      active();if(task!.status!=='running')conflict('Tool evidence requires an active task.');
      const agent=manifest.plan.agents.find(a=>a.id===manifest.plan.tasks.find(t=>t.id===c.taskId)!.agentId)!;
      if(c.mutating!==(['write_file','edit_file'].includes(c.name)||!!manifest.plan.workspace.isolation&&c.name==='shell'))fail('Tool mutation classification differs from the executor.');
      const key=c.taskId+':'+task!.attempts+':'+c.callId,scope=canonicalJson({name:c.name,path:c.path,mutating:c.mutating});
      if(c.stage==='started'){if(toolStarts.has(key))conflict('Duplicate tool start.');toolStarts.set(key,scope);}else{if(toolStarts.get(key)!==scope)conflict('Tool result has no matching start.');toolStarts.set(key,'finished');}
      if(!agent.allowedTools.includes(c.name)||c.path!==null&&!permits(agent.allowedPaths,c.path,c.mutating?'write':'read')){if(c.success)fail('Successful tool evidence exceeds agent authority.');}
      if(c.mutating){task!.mutations=true;if(c.success&&c.path&&!task!.changedFiles.includes(c.path)){if(task!.changedFiles.length>=256)conflict('Task changed-file limit reached.');task!.changedFiles.push(c.path);}}
    }else if(c.type==='artifact'){
      active();const t=state.tasks[c.artifact.taskId]!;if(t.status!=='running'||t.artifactIds.includes(c.artifact.id))conflict('Artifact needs a running task and unique ID.');state.artifacts[c.artifact.id]=c.artifact;t.artifactIds.push(c.artifact.id);
    }else if(c.type==='task_finished'){
      active();if(task!.status!=='running')conflict('Task is not running.');
      if(c.output.artifacts.some(a=>canonicalJson(state.artifacts[a.id])!==canonicalJson(a))||canonicalJson(c.output.artifacts.map(a=>a.id))!==canonicalJson(task!.artifactIds)||canonicalJson(c.output.changedFiles)!==canonicalJson(task!.changedFiles))fail('Task output is not backed by recorded evidence.');
      const expectedStatus=c.status==='completed'?'success':c.status==='review_required'?'partial':c.status==='unknown'?'failed':c.status;if(c.output.status!==expectedStatus)fail('Task result status differs from its evidence.');
      if(c.status==='completed'&&(!mechanicallyVerified(c.output,manifest)||c.output.status!=='success'))fail('Task completion requires verified acceptance evidence.');
      task!.status=c.status;task!.output=c.output;
    }else if(c.type==='task_reset'){
      const spec=manifest.plan.tasks.find(t=>t.id===c.taskId)!,agent=manifest.plan.agents.find(a=>a.id===spec.agentId)!;
      if(!['failed','denied','cancelled','unknown'].includes(task!.status)||task!.attempts>agent.escalationPolicy.maxRetries||manifest.plan.tasks.some(t=>t.dependencies.includes(c.taskId)&&state.tasks[t.id]!.attempts>0)||c.source==='automatic'&&(task!.mutations||task!.status!=='failed'))conflict('Task retry requires remaining budget and safe, unused prior output.');
      task!.status='pending';task!.output=null;task!.artifactIds=[];task!.changedFiles=[];task!.mutations=false;task!.escalation=null;
    }else if(c.type==='task_accepted'){
      if(state.ownerId||task!.status!=='review_required'||!task!.output||task!.output.checks.some(check=>!check.passed)||artifactSetHash(task!.output.artifacts)!==c.artifactsHash||manifest.plan.tasks.find(t=>t.id===c.taskId)!.outputs.some(o=>!task!.artifactIds.includes(o.id)))conflict('Task is not eligible for human acceptance.');
      task!.status='completed';task!.output={...task!.output!,status:'success',unresolvedRisks:task!.output!.unresolvedRisks.filter(r=>r!=='Natural-language acceptance criteria still require human review.'),recommendedNextAction:'Human acceptance recorded.'};if(Object.values(state.tasks).every(t=>t.status==='completed'))state.status='completed';
    }else if(c.type==='agent_stop'){if(!state.stoppedAgents.includes(c.agentId))state.stoppedAgents.push(c.agentId);}
    else if(c.type==='agent_reset'){if(state.ownerId)conflict('Stop the coordinator before resetting an agent.');state.stoppedAgents=state.stoppedAgents.filter(a=>a!==c.agentId);}
    else if(c.type==='finished'){
      active();if(c.ownerId!==state.ownerId||Object.values(state.tasks).some(t=>t.status==='running')||c.status==='completed'&&!Object.values(state.tasks).every(t=>t.status==='completed'))conflict('Coordinator cannot finish with active or unverified work.');state.status=c.status;state.ownerId=null;
    }
    state.revision=event.hash;
  }
  return state;
}
