import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import type {PermissionDecision} from '../src/runtime/types.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {collectTaskOutput,ExecutionStore,changePreparedRun} from '../src/orchestration/index.js';
import {supervisionEvidence} from '../src/supervision/index.js';
import {requestImprovementReview,inspectImprovementReviews,dismissImprovementReview,inspectImprovements,improvementProposalHash,improvementReviewCapabilities,projectImprovementReviews,type ImprovementReviewRequest} from '../src/improvement/index.js';
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-review-requests-')));vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Review requests must not infer.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
async function fixture(pending=false){
  const p=verifiedPlan();p.version=4;p.tasks=p.tasks.slice(0,1);p.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
  p.limits.timeBudgetMs=60000;for(const a of p.agents)a.timeBudgetMs=60000;
  const task=p.tasks[0]!;delete task.outputs[0]!.path;task.outputs.push({id:'patch',kind:'patch',description:'Retained candidate.'});task.isolation={patchArtifactId:'patch',commands:[]};
  p.supervision={version:1,controllerId:'coordinator',maxRounds:3,maxStalledRounds:2,maxOutputTokens:10,principle:'speed',allowedActions:['retry','replan','decompose']};
  const f=await coordinatorRun(root,p),ownerId=randomUUID();await f.store.append({type:'started',ownerId,...(pending?{proposalOnly:true as const}:{})});
  await f.store.append({type:'task_started',taskId:task.id,attempt:1,sessionId:'fixture-worker'});
  const result=await collectTaskOutput(f.store,task,JSON.stringify({version:1,summary:'Failing fixture.',outputs:[{id:'report-a',content:'missing check'}]}),{executorOutputs:new Map([['patch','retained patch']])});
  await f.store.append({type:'task_finished',taskId:task.id,status:'failed',output:result.output});
  const evidence=supervisionEvidence(f.store.read().events);
  await f.store.append({type:'supervision_started',round:1,role:'controller',agentId:'coordinator',sessionId:'controller-fixture',evidenceIds:evidence.ids,evidenceHash:evidence.hash});
  await f.store.append({type:'supervision_decided',round:1,role:'controller',agentId:'coordinator',sessionId:'controller-fixture',decision:pending?{version:1,action:'retry',reason:'Review evidence.',evidence:evidence.ids,taskId:task.id,hypothesis:'Repair the report.',expectedMetric:{name:'failed checks',direction:'decrease'}}:{version:1,action:'stop',reason:'Review required.',evidence:evidence.ids}});
  if(!pending)await f.store.append({type:'supervision_halted',round:1,outcome:'stop',reason:'Review required.'});
  await f.store.append({type:'finished',ownerId,status:'failed'});
  const options={store:f.runs,approve:async()=> 'allow' as const},view=await inspectImprovements(f.project,f.view.run.id,options),cycle=view.history.cycles[0];
  const request:ImprovementReviewRequest={version:1,action:pending?'run':'propose',executionRevision:f.store.read().state.revision,cycleId:cycle?.id??null,proposalHash:cycle?improvementProposalHash(cycle):null,reason:'Please review the retained failed task.'};
  return{...f,options,request,call:(requestOverride=request,extra={})=>requestImprovementReview(f.project,f.view.run.id,requestOverride,{...options,...extra})};
}
it.each([false,true])('persists exact requests and deduplicates lost acknowledgements without granting authority (pending=%s)',async pending=>{
  const f=await fixture(pending),before=f.store.read(),budget=f.authority.ledger.read(f.project),first=await f.call();
  expect(first.existing).toBe(false);expect(first.reviews.requests[0]).toMatchObject({id:first.requestId,status:'pending',request:f.request});
  const saved=f.store.read();expect(saved.events.at(-1)?.version).toBe(9);expect(saved.header).toEqual(before.header);
  expect({...saved.state,revision:before.state.revision}).toEqual(before.state);
  expect(f.authority.ledger.read(f.project)).toEqual(budget);expect(fetch).not.toHaveBeenCalled();
  const duplicate=await f.call();expect(duplicate.existing).toBe(true);expect(duplicate.requestId).toBe(first.requestId);expect(f.store.read()).toEqual(saved);
  expect(await inspectImprovementReviews(f.project,f.view.run.id,f.options)).toEqual(first.reviews);
  expect(new ExecutionStore(join(f.runs.root,f.view.run.id),f.view.manifest).read()).toEqual(saved);
  await expect(f.call({...f.request,reason:'Different request'})).rejects.toThrow();expect(f.store.read()).toEqual(saved);
});
it('dismisses only the current exact request and retains its history without applying or withdrawing a strategy',async()=>{
  const f=await fixture(true),first=await f.call(),before=f.store.read();
  await expect(dismissImprovementReview(f.project,f.view.run.id,first.requestId,f.request.executionRevision,f.options)).rejects.toThrow();
  await expect(dismissImprovementReview(f.project,f.view.run.id,randomUUID(),before.state.revision,f.options)).rejects.toThrow();
  await expect(dismissImprovementReview(f.project,f.view.run.id,first.requestId,before.state.revision,{...f.options,approve:async()=> 'reject'})).rejects.toThrow();
  expect(f.store.read()).toEqual(before);
  const result=await dismissImprovementReview(f.project,f.view.run.id,first.requestId,before.state.revision,f.options);
  expect(result.requests[0]).toMatchObject({status:'dismissed',dismissal:{id:expect.any(String)}});
  expect({...f.store.read().state,revision:before.state.revision}).toEqual(before.state);
  await expect(f.call()).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('refuses malformed, stale, foreign-proposal and denied requests without appending evidence',async()=>{
  const f=await fixture(true),before=f.store.read();
  for(const request of [{...f.request,executionRevision:'0'.repeat(64)},{...f.request,cycleId:randomUUID()},{...f.request,proposalHash:'0'.repeat(64)},{...f.request,reason:'x'.repeat(1025)},{...f.request,approved:true},{...f.request,action:'execute'}])await expect(f.call(request as ImprovementReviewRequest)).rejects.toThrow();
  await expect(f.call(f.request,{approve:async()=> 'reject'})).rejects.toThrow();
  await expect(f.call(f.request,{approve:undefined})).rejects.toThrow();
  const foreign=join(root,'foreign');fs.mkdirSync(foreign);await expect(requestImprovementReview(foreign,f.view.run.id,f.request,f.options)).rejects.toThrow();
  expect(f.store.read()).toEqual(before);expect(fetch).not.toHaveBeenCalled();
});
it('rechecks native revision and approval after authorization and refuses live ownership',async()=>{
  const f=await fixture(),before=f.store.read(),lease=f.store.acquire();
  try{await expect(f.call()).rejects.toThrow(/active|coordinator/);}finally{lease.release();}
  expect(f.store.read()).toEqual(before);
  await expect(f.call(f.request,{approve:async(permission:PermissionDecision)=>{if(permission.request?.tool==='orchestration_improvement_review_request')await f.store.append({type:'agent_stop',agentId:'a'});return 'allow';}})).rejects.toThrow(/changed/);
  const changed=f.store.read();expect(changed.events.filter(e=>e.change.type==='improvement_review_requested')).toHaveLength(0);
  const request={...f.request,executionRevision:changed.state.revision};
  await expect(f.call(request,{approve:async(permission:PermissionDecision)=>{if(permission.request?.tool==='orchestration_improvement_review_request')await changePreparedRun(f.project,f.view.run.id,'revoked',{store:f.runs});return 'allow';}})).rejects.toThrow();
  expect(f.store.read()).toEqual(changed);
});
it('allows only one concurrent append and reports later execution changes as stale, never as approval',async()=>{
  const f=await fixture(),results=await Promise.allSettled([f.call(),f.call()]);
  expect(results.some(r=>r.status==='fulfilled')).toBe(true);
  const saved=f.store.read();expect(saved.events.filter(e=>e.change.type==='improvement_review_requested')).toHaveLength(1);
  await f.store.append({type:'agent_stop',agentId:'a'});
  expect((await inspectImprovementReviews(f.project,f.view.run.id,f.options)).requests[0]?.status).toBe('stale');
  expect(projectImprovementReviews(saved,saved.header.deadline).requests[0]?.status).toBe('expired');
  expect(fetch).not.toHaveBeenCalled();
});
it('requests withdrawal without withdrawing the native cycle and does not expire that request',async()=>{
  const f=await fixture(true),request={...f.request,action:'rollback' as const},before=f.store.read();
  const result=await f.call(request);expect(result.reviews.requests[0]?.request.action).toBe('rollback');
  expect({...f.store.read().state,revision:before.state.revision}).toEqual(before.state);
  expect(projectImprovementReviews(f.store.read(),before.header.deadline+1).requests[0]?.status).toBe('pending');
  expect(fetch).not.toHaveBeenCalled();
});
it('advertises a separate request-only contract without touching native state',()=>{
  expect(improvementReviewCapabilities()).toEqual({version:1,kind:'improvement.review-capabilities',owner:'calliope-cli',operations:['request','inspect','dismiss'],actions:['propose','run','rollback'],authority:'request-only-no-execution',storage:'native-execution-journal',maxRequests:64});
  expect(fetch).not.toHaveBeenCalled();
});
it('validates replay independently and bounds request retention without removing original evidence',async()=>{
  const f=await fixture(),original=f.store.read();
  await expect(f.store.append({type:'improvement_review_requested',request:{...f.request,action:'run',cycleId:randomUUID(),proposalHash:'a'.repeat(64)}})).rejects.toThrow();
  await expect(f.store.append({type:'improvement_review_dismissed',requestId:randomUUID(),executionRevision:original.state.revision})).rejects.toThrow();
  expect(f.store.read()).toEqual(original);
  for(let i=0;i<64;i++){
    const request={...f.request,executionRevision:f.store.read().state.revision};
    const event=await f.store.append({type:'improvement_review_requested',request});
    await f.store.append({type:'improvement_review_dismissed',requestId:event.id,executionRevision:event.hash});
  }
  const retained=f.store.read();expect(retained.events.slice(0,original.events.length)).toEqual(original.events);
  await expect(f.store.append({type:'improvement_review_requested',request:{...f.request,executionRevision:retained.state.revision}})).rejects.toThrow('retention');
  expect(f.store.read()).toEqual(retained);expect(fetch).not.toHaveBeenCalled();
},15000);
