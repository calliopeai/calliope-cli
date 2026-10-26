import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {collectTaskOutput,artifactSetHash,ExecutionStore,changePreparedRun,validateExecutionEvent} from '../src/orchestration/index.js';
import {supervisionEvidence} from '../src/supervision/index.js';
import {canonicalJson,digest} from '../src/approvals/index.js';
import {requestCostNanos} from '../src/execution/index.js';
import {inspectTaskOutcome,recordTaskFeedback,inspectTaskFeedback,taskFeedbackHistory,taskFeedbackCapabilities,type TaskFeedbackRequest} from '../src/improvement/index.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';

let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-feedback-')));vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No inference in task feedback.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});

async function fixture(human=false,charge=false,attributed=true){
  const plan=verifiedPlan();plan.tasks=plan.tasks.slice(0,1);plan.limits.timeBudgetMs=120000;for(const agent of plan.agents)agent.timeBudgetMs=120000;
  if(human){plan.version=1;delete plan.tasks[0]!.acceptanceChecks;}
  const f=await coordinatorRun(root,plan),task=plan.tasks[0]!,owner=randomUUID(),options={store:f.runs,approve:async()=> 'allow' as const};
  await f.store.append({type:'started',ownerId:owner});
  const start=await f.store.append({type:'task_started',taskId:task.id,attempt:1,sessionId:'feedback-session',...(attributed?{requestAttribution:1 as const}:{})});
  if(start.change.type!=='task_started')throw Error('start required');
  const requestId=randomUUID();
  if(charge)await f.authority.ledger.reserve(f.project,f.authority.manifestHash,{id:requestId,agentId:task.agentId,provider:'deepseek',model:'fixture',target:'b'.repeat(64),inputTokens:90,outputTokens:10,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(90,10,1,2),
    attribution:{version:1,kind:'task',eventId:start.id,eventHash:start.hash,taskId:task.id,attempt:1,sessionId:start.change.sessionId}});
  fs.writeFileSync(join(f.project,task.outputs[0]!.path!),'public toy result');
  const result=await collectTaskOutput(f.store,task,'Private worker prose stays out.',options);
  await f.store.append({type:'task_finished',taskId:task.id,status:result.status,output:result.output});
  await f.store.append({type:'finished',ownerId:owner,status:human?'partial':'completed'});
  const observe=()=>inspectTaskOutcome(f.project,f.view.run.id,{taskId:task.id,attempt:1,executionRevision:f.store.read().state.revision},options);
  const observation=await observe();
  const request:TaskFeedbackRequest={version:1,id:randomUUID(),selection:{taskId:task.id,attempt:1,executionRevision:f.store.read().state.revision},observationHash:observation.hash,
    assessment:{decision:'accepted',reason:'The result satisfies my request.'},references:[{kind:'workflow',id:'public-fixture',revision:'a'.repeat(64)}]};
  const record=(value=request,extra={})=>recordTaskFeedback(f.project,f.view.run.id,value,{...options,...extra});
  const inspect=(id=request.id)=>inspectTaskFeedback(f.project,f.view.run.id,id,options);
  return{...f,task,start,result,request,requestId,record,inspect,observe,options};
}

it('records reviewed assessment, persists restart/replay and derives native evidence without changing the task or budget',async()=>{
  const f=await fixture(),before=f.store.read(),budget=f.authority.ledger.read(f.project),result=await f.record();
  expect(result.data).toMatchObject({existing:false,receipt:{version:1,authority:'native-policy-reviewed-assessment',request:f.request,source:{started:{id:f.start.id,hash:f.start.hash}}}});
  expect(f.store.read().events.at(-1)!.version).toBe(12);
  expect(f.store.read().state.tasks).toEqual(before.state.tasks);expect(f.store.read().state.status).toBe(before.state.status);
  expect(f.authority.ledger.read(f.project)).toEqual(budget);expect(fetch).not.toHaveBeenCalled();
  const restarted=new ExecutionStore(join(f.runs.root,f.view.run.id),f.view.manifest);
  expect(restarted.read()).toEqual(f.store.read());
  const observed=await f.inspect();expect(observed.data).toMatchObject({status:'current',observation:{value:{checks:[{passed:true}],measurements:{settledCostNanos:0}}}});
  expect(JSON.stringify(observed)).not.toContain('Private worker prose');
  const history=await taskFeedbackHistory(f.project,f.view.run.id,f.options);
  expect(history.data.receipts).toHaveLength(1);expect(history.data.evidence).toBe('recorded-assessments-not-revalidated');
});

it('replays identical requests without another event and refuses conflicting id reuse',async()=>{
  const f=await fixture(),first=await f.record(),before=f.store.read();
  expect((await f.record()).data).toEqual({...first.data,existing:true});expect(f.store.read()).toEqual(before);
  await expect(f.record({...f.request,assessment:{decision:'rejected',reason:'Different assessment.'}})).rejects.toMatchObject({code:'conflict'});
  expect(f.store.read()).toEqual(before);
});

it('requires fresh native permission for both new and repeated requests and refuses plan-mode mutation',async()=>{
  const f=await fixture(),before=f.store.read();
  for(const options of [{approve:undefined},{approve:async()=> 'reject' as const},{mode:'plan' as const}]){
    await expect(f.record(f.request,options)).rejects.toThrow();expect(f.store.read()).toEqual(before);
  }
  await f.record();const saved=f.store.read();
  await expect(f.record(f.request,{approve:async()=> 'reject' as const})).rejects.toThrow();expect(f.store.read()).toEqual(saved);
});

it('keeps the reviewed request immutable while the caller awaits confirmation',async()=>{
  const f=await fixture(),expected=structuredClone(f.request);
  const result=await f.record(f.request,{approve:async()=>{f.request.assessment.decision='rejected';return 'allow' as const;}});
  expect(result.data.receipt.request).toEqual(expected);
});

it.each(['id','task','attempt','revision','observation','reward','trust','reference','reason'] as const)('refuses malformed or foreign %s with no writes',async kind=>{
  const f=await fixture(),request=structuredClone(f.request),before=f.store.read(),budget=f.authority.ledger.read(f.project);
  if(kind==='id')request.id='not-a-uuid';
  if(kind==='task')request.selection.taskId='foreign';
  if(kind==='attempt')request.selection.attempt=2;
  if(kind==='revision')request.selection.executionRevision='f'.repeat(64);
  if(kind==='observation')request.observationHash='f'.repeat(64);
  if(kind==='reward')Object.assign(request,{reward:100});
  if(kind==='trust')Object.assign(request,{trusted:true});
  if(kind==='reference')request.references.push({...request.references[0]!});
  if(kind==='reason')request.assessment.reason='\x1b[2J hidden';
  await expect(f.record(request)).rejects.toThrow();
  expect(f.store.read()).toEqual(before);expect(f.authority.ledger.read(f.project)).toEqual(budget);
});

it.each(['deny','artifact','revision','owner','revoked','cancel','accounting'] as const)('rechecks %s changes during approval before committing feedback',async kind=>{
  const f=await fixture(false,kind==='accounting'),budget=f.authority.ledger.read(f.project),aborter=new AbortController();let release:(()=>void)|undefined;
  const approve=async()=>{
    if(kind==='deny')return 'reject' as const;
    if(kind==='artifact')fs.writeFileSync(join(f.project,f.task.outputs[0]!.path!),'changed after review');
    if(kind==='revision')await f.store.append({type:'agent_stop',agentId:'a'});
    if(kind==='owner'){const lease=f.store.acquire();release=lease.release;}
    if(kind==='revoked')await changePreparedRun(f.project,f.view.run.id,'cancelled',f.options);
    if(kind==='cancel')aborter.abort();
    if(kind==='accounting')await f.authority.ledger.settle(f.project,f.authority.manifestHash,{requestId:f.requestId,outcome:'success',usage:{inputTokens:3,outputTokens:1}});
    return 'allow' as const;
  };
  try{await expect(f.record(f.request,{approve,signal:aborter.signal})).rejects.toThrow();}
  finally{release?.();}
  expect(f.store.read().events.some(e=>e.change.type==='task_feedback_recorded')).toBe(false);
  if(kind!=='accounting')expect(f.authority.ledger.read(f.project)).toEqual(budget);
});

it('does not turn a positive assessment into native acceptance, and marks changed outcomes stale',async()=>{
  const f=await fixture(true);await f.record();
  expect(f.store.read().state.tasks[f.task.id]!.status).toBe('review_required');
  await f.store.append({type:'task_accepted',taskId:f.task.id,artifactsHash:artifactSetHash(f.result.output.artifacts)});
  expect((await f.inspect()).data.status).toBe('stale');
});

it('keeps unknown charges unknown and derives late settlement without awarding a reward',async()=>{
  const f=await fixture(false,true);await f.record();
  expect((await f.inspect()).data.observation.value.measurements.settledCostNanos).toBeNull();
  await f.authority.ledger.settle(f.project,f.authority.manifestHash,{requestId:f.requestId,outcome:'success',usage:{inputTokens:3,outputTokens:1}});
  const observed=await f.inspect();expect(observed.data.status).toBe('current');
  expect(observed.data.observation.value.measurements.settledCostNanos).toBe(5000);
  expect(observed.data.receipt).not.toHaveProperty('reward');
});

it('preserves unavailable legacy accounting rather than treating it as zero cost',async()=>{
  const f=await fixture(false,false,false);await f.record();
  expect((await f.inspect()).data.observation.value.measurements.settledCostNanos).toBeNull();
});

it.each(['artifact','accounting','policy'] as const)('rechecks %s while a feedback write is queued behind the native writer',async kind=>{
  const f=await fixture(false,kind==='accounting'),lock=join(f.store.root,'writer.lock');
  fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  let entered=false;const original=ExecutionStore.prototype.append;
  vi.spyOn(ExecutionStore.prototype,'append').mockImplementation(function(this:ExecutionStore,...args){
    if(args[0].type==='task_feedback_recorded')entered=true;
    return original.apply(this,args);
  });
  const pending=f.record().then(value=>({value}),error=>({error}));
  try{
    await vi.waitFor(()=>expect(entered).toBe(true));
    if(kind==='artifact')fs.writeFileSync(join(f.project,f.task.outputs[0]!.path!),'changed while queued');
    else if(kind==='policy')config.set('policy',{command:'exit 17'});
    else await f.authority.ledger.settle(f.project,f.authority.manifestHash,{requestId:f.requestId,outcome:'success',usage:{inputTokens:3,outputTokens:1}});
  }finally{fs.unlinkSync(lock);}
  expect(await pending).toHaveProperty('error');
  expect(f.store.read().events.some(e=>e.change.type==='task_feedback_recorded')).toBe(false);
});

it('rejects configured credentials on write and redacts notes that later become a credential',async()=>{
  const f=await fixture(),secret='private-feedback-token-0123456789';
  config.setProviderCred('anthropic',{apiKey:secret});
  await expect(f.record({...f.request,assessment:{decision:'accepted',reason:secret}})).rejects.toMatchObject({code:'policy-denied'});
  config.setProviderCred('anthropic',{apiKey:'different-feedback-token-0123456789'});
  await f.record({...f.request,assessment:{decision:'accepted',reason:secret}});
  config.setProviderCred('anthropic',{apiKey:secret});
  const result=await f.inspect();expect(result.redacted).toBe(true);expect(JSON.stringify(result)).not.toContain(secret);
});

it('advertises only operator-reviewed records, not learning or reward authority',()=>{
  expect(taskFeedbackCapabilities()).toMatchObject({version:1,operations:['record','inspect','history'],awardsReward:false,changesTaskOutcome:false,mayCallModel:false,maxRecords:64});
});

it('independently rejects forged source identities when replaying an appended receipt',async()=>{
  const f=await fixture();await f.record();const event=f.store.read().events.at(-1)!;
  if(event.change.type!=='task_feedback_recorded')throw Error('feedback required');
  const base=event.change.feedback,saved=f.store.read();
  for(const field of ['runId','manifestHash','planHash','approvalRevision','taskId','agentId','attempt','sessionId','configurationHash','graphHash','started','finished'] as const){
    const value=structuredClone(base);value.request.id=randomUUID();value.request.selection.executionRevision=saved.state.revision;value.source.executionRevision=saved.state.revision;
    if(field==='finished')value.finished.id=randomUUID();
    else if(field==='started')value.source.started.id=randomUUID();
    else if(field==='attempt')value.source.attempt=2;
    else if(['runId','approvalRevision'].includes(field))Object.assign(value.source,{[field]:randomUUID()});
    else Object.assign(value.source,{[field]:['taskId','agentId','sessionId'].includes(field)?'foreign':'f'.repeat(64)});
    await expect(f.store.append({type:'task_feedback_recorded',feedback:value})).rejects.toThrow();
    expect(f.store.read()).toEqual(saved);
  }
  expect(()=>validateExecutionEvent({...event,version:11},f.view.manifest,saved.header)).toThrow();
});

it('binds historical feedback to the strategy active at that attempt, including withdrawal restoration',async()=>{
  const p=verifiedPlan();p.version=4;p.tasks=p.tasks.slice(0,1);p.limits.timeBudgetMs=120000;p.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
  for(const agent of p.agents){agent.timeBudgetMs=120000;agent.escalationPolicy.maxRetries=3;}
  const task=p.tasks[0]!;delete task.outputs[0]!.path;task.outputs.push({id:'patch',kind:'patch',description:'Retained candidate.'});task.isolation={patchArtifactId:'patch',commands:[]};
  p.supervision={version:1,controllerId:'coordinator',maxRounds:4,maxStalledRounds:4,maxOutputTokens:10,principle:'speed',allowedActions:['replan']};
  const f=await coordinatorRun(root,p),owner=randomUUID(),options={store:f.runs,approve:async()=> 'allow' as const};await f.store.append({type:'started',ownerId:owner});
  async function finish(attempt:number,content:string){
    await f.store.append({type:'task_started',taskId:task.id,attempt,sessionId:'strategy-'+attempt});
    const result=await collectTaskOutput(f.store,task,JSON.stringify({version:1,summary:'Result.',outputs:[{id:'report-a',content}]}),{executorOutputs:new Map([['patch','retained patch']])});
    await f.store.append({type:'task_finished',taskId:task.id,status:result.status,output:result.output});
  }
  async function decision(round:number,strategy?:string){
    const evidence=supervisionEvidence(f.store.read().events),sessionId='controller-'+round;
    await f.store.append({type:'supervision_started',round,role:'controller',agentId:'coordinator',sessionId,evidenceIds:evidence.ids,evidenceHash:evidence.hash});
    const event=await f.store.append({type:'supervision_decided',round,role:'controller',agentId:'coordinator',sessionId,decision:strategy?
      {version:1,action:'replan',reason:'Inspect evidence.',evidence:evidence.ids,taskId:task.id,hypothesis:'Repair the report.',expectedMetric:{name:'failed checks',direction:'decrease'},strategy}:
      {version:1,action:'continue',reason:'Checks passed.',evidence:evidence.ids}});
    await f.store.append({type:'supervision_applied',round,decisionId:event.id,receipts:[]});return{event,evidence};
  }
  await finish(1,'missing');const first=await decision(1,'Use first strategy.');
  await finish(2,'missing');const second=await decision(2,'Use second strategy.');
  await f.store.append({type:'finished',ownerId:owner,status:'failed'});
  await f.store.append({type:'supervision_withdrawn',decisionId:second.event.id,source:'cli'});
  await f.store.append({type:'supervision_reset',source:'cli'});
  const newOwner=randomUUID();await f.store.append({type:'started',ownerId:newOwner});
  await finish(3,'public toy result');await decision(3);await f.store.append({type:'finished',ownerId:newOwner,status:'completed'});
  for(const attempt of [2,3]){
    const observed=await inspectTaskOutcome(f.project,f.view.run.id,{taskId:task.id,attempt,executionRevision:f.store.read().state.revision},options);
    expect(observed.value.source.configurationHash).toBe(digest(canonicalJson({task,agent:p.agents.find(a=>a.id===task.agentId),strategy:{decisionId:first.event.id,strategy:'Use first strategy.',evidence:first.evidence.ids}})));
    const request:TaskFeedbackRequest={version:1,id:randomUUID(),selection:{taskId:task.id,attempt,executionRevision:f.store.read().state.revision},observationHash:observed.hash,assessment:{decision:'accepted',reason:'Reviewed historical attempt.'},references:[]};
    await recordTaskFeedback(f.project,f.view.run.id,request,options);
    expect((await inspectTaskFeedback(f.project,f.view.run.id,request.id,options)).data.status).toBe('current');
  }
});

it('bounds retained feedback and keeps the original budget and execution state',async()=>{
  const f=await fixture(),budget=f.authority.ledger.read(f.project);
  for(let i=0;i<64;i++){
    const observation=await f.observe();await f.record({...f.request,id:randomUUID(),selection:{...f.request.selection,executionRevision:f.store.read().state.revision},observationHash:observation.hash});
  }
  const before=f.store.read(),observation=await f.observe();
  await expect(f.record({...f.request,id:randomUUID(),selection:{...f.request.selection,executionRevision:before.state.revision},observationHash:observation.hash})).rejects.toThrow('retention');
  expect(f.store.read()).toEqual(before);expect(f.authority.ledger.read(f.project)).toEqual(budget);
},30000);
