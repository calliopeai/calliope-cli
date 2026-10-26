import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {canonicalJson,digest} from '../src/approvals/index.js';
import {collectTaskOutput,artifactSetHash,type ExecutionEvent} from '../src/orchestration/index.js';
import {requestCostNanos,type RequestReservation} from '../src/execution/index.js';
import {inspectTaskOutcome,taskOutcomeCapabilities} from '../src/improvement/index.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-task-outcomes-')));vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No inference in task observations.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
async function fixture(human=false,retained=false){
 const plan=verifiedPlan();plan.tasks=plan.tasks.slice(0,1);if(retained)delete plan.tasks[0]!.outputs[0]!.path;if(human){plan.version=1;delete plan.tasks[0]!.acceptanceChecks;}
 const f=await coordinatorRun(root,plan),task=plan.tasks[0]!,owner=randomUUID(),options={store:f.runs,approve:async()=> 'allow' as const};
 await f.store.append({type:'started',ownerId:owner});
 const start=(attempt=1,attributed=false)=>f.store.append({type:'task_started',taskId:task.id,attempt,sessionId:'session-'+attempt,...(attributed?{requestAttribution:1 as const}:{})});
 async function finish(text='public toy result'){
  if(task.outputs[0]!.path)fs.writeFileSync(join(f.project,task.outputs[0]!.path),text);
  const result=await collectTaskOutput(f.store,task,JSON.stringify({version:1,summary:'Private worker prose stays out.',outputs:retained?[{id:task.outputs[0]!.id,content:text}]:[]}),options);
  await f.store.append({type:'task_finished',taskId:task.id,status:result.status,output:result.output});return result;
 }
 async function stop(status:'completed'|'partial'|'failed'='completed'){await f.store.append({type:'finished',ownerId:owner,status});}
 const inspect=(attempt=1,executionRevision=f.store.read().state.revision)=>inspectTaskOutcome(f.project,f.view.run.id,{taskId:task.id,attempt,executionRevision},options);
 return {...f,task,owner,options,start,finish,stop,inspect};
}
const request=(event:ExecutionEvent,agentId:string):RequestReservation=>{
 if(event.change.type!=='task_started')throw Error('Start required');
 return {id:randomUUID(),agentId,provider:'deepseek',model:'public-toy',target:'b'.repeat(64),inputTokens:90,outputTokens:10,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(90,10,1,2),
  attribution:{version:1,kind:'task',eventId:event.id,eventHash:event.hash,taskId:event.change.taskId,attempt:event.change.attempt,sessionId:event.change.sessionId}};
};

it('reads a real ordinary task with native checks, exact authority and unknown legacy costs without writes',async()=>{
 const f=await fixture(),start=await f.start();await f.finish();await f.stop();const before=f.store.read(),budget=f.authority.ledger.read(f.project);
 const observed=await f.inspect();expect(observed.hash).toBe(digest(canonicalJson(observed.value)));
 expect(observed.value).toMatchObject({status:'completed',executorStatus:'completed',accepted:null,source:{runId:f.view.run.id,taskId:f.task.id,attempt:1,sessionId:'session-1',started:{id:start.id,hash:start.hash}},measurements:{settledCostNanos:null},accounting:{charge:null}});
 expect(observed.value.checks).toHaveLength(1);expect(observed.value.checks[0]!.passed).toBe(true);
 expect(observed.value.artifacts[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);expect(observed.value.source.configurationHash).toMatch(/^[a-f0-9]{64}$/);
 expect(JSON.stringify(observed)).not.toContain('Private worker prose');expect(JSON.stringify(observed)).not.toContain(f.project);
 expect(await f.inspect()).toEqual(observed);expect(f.store.read()).toEqual(before);expect(f.authority.ledger.read(f.project)).toEqual(budget);expect(fetch).not.toHaveBeenCalled();
});

it('distinguishes executor evidence from a later human acceptance',async()=>{
 const f=await fixture(true);await f.start();const result=await f.finish();expect(result.status).toBe('review_required');await f.stop('partial');
 const before=await f.inspect();expect(before.value.status).toBe('review_required');
 const acceptance=await f.store.append({type:'task_accepted',taskId:f.task.id,artifactsHash:artifactSetHash(result.output.artifacts)});
 const after=await f.inspect();expect(after.value).toMatchObject({status:'completed',executorStatus:'review_required',accepted:{id:acceptance.id,hash:acceptance.hash}});
 expect(after.value.finished).toEqual(before.value.finished);expect(after.value.source.started).toEqual(before.value.source.started);
 expect(after.hash).not.toBe(before.hash);expect(after.value.interpretation).toBe('native-attempt-evidence-not-user-assessment-or-reward');
});

it('retains interrupted unknown attempts without inventing success, duration or settled cost',async()=>{
 const f=await fixture();await f.start();await f.store.append({type:'interruption_recovered',ownerId:f.owner,source:'cli'});
 const observed=await f.inspect();expect(observed.value).toMatchObject({status:'unknown',executorStatus:'unknown',finished:null,accepted:null,checks:[],artifacts:[],measurements:{durationMs:null,settledCostNanos:null}});
});

it.each(['settled','unknown','pending'] as const)('binds %s accounting to the exact attempt and preserves the ledger',async mode=>{
 const f=await fixture(),start=await f.start(1,true),r=request(start,f.task.agentId);
 await f.authority.ledger.reserve(f.project,f.authority.manifestHash,r);
 if(mode!=='pending')await f.authority.ledger.settle(f.project,f.authority.manifestHash,{requestId:r.id,outcome:mode==='settled'?'success':'cancelled',...(mode==='settled'?{usage:{inputTokens:3,outputTokens:1}}:{})});
 await f.finish();await f.stop();const before=f.authority.ledger.read(f.project),observed=await f.inspect();
 expect(observed.value.accounting.charge).toMatchObject({source:{eventId:start.id,attempt:1},requests:{[mode]:1},usageComplete:mode==='settled'});
 expect(observed.value.measurements.settledCostNanos).toBe(mode==='settled'?5000:null);expect(f.authority.ledger.read(f.project)).toEqual(before);
});

it('separates retry attempts without replacing the failed evidence',async()=>{
 const f=await fixture(false,true);await f.start();await f.finish('missing expected content');
 await f.store.append({type:'task_reset',taskId:f.task.id,source:'manual'});await f.start(2);await f.finish();await f.stop();
 const first=await f.inspect(1),second=await f.inspect(2);
 expect(first.value.status).toBe('failed');expect(second.value.status).toBe('completed');
 expect(first.value.checks[0]!.passed).toBe(false);expect(second.value.checks[0]!.passed).toBe(true);
 expect(first.value.source.started.id).not.toBe(second.value.source.started.id);expect(first.value.artifacts[0]!.sha256).not.toBe(second.value.artifacts[0]!.sha256);
});

it.each(['active','stale','missing','artifact','cancelled'] as const)('refuses %s observation input or evidence',async mode=>{
 const f=await fixture();await f.start();const result=await f.finish();if(mode!=='active')await f.stop();
 if(mode==='artifact'){const a=result.output.artifacts[0]!;fs.writeFileSync(join(a.location==='run'?join(f.store.root,'artifacts'):f.project,a.path),'changed');}
 if(mode==='cancelled')await expect(inspectTaskOutcome(f.project,f.view.run.id,{taskId:f.task.id,attempt:1,executionRevision:f.store.read().state.revision},{...f.options,signal:AbortSignal.abort()})).rejects.toThrow();
 else await expect(f.inspect(mode==='missing'?2:1,mode==='stale'?'f'.repeat(64):undefined)).rejects.toThrow();
});

it('does not advertise external feedback import, assessment or reward authority',()=>{
 expect(taskOutcomeCapabilities()).toEqual({version:1,owner:'calliope-cli',operations:['inspect'],semantics:'exact-native-attempt-observation',artifactValidation:'retained-bytes',assessment:false,reward:false,mayCallModel:false});
});

it('refuses a historical live-file artifact overwritten by a later retry',async()=>{
 const f=await fixture();await f.start();await f.finish('missing expected content');
 await f.store.append({type:'task_reset',taskId:f.task.id,source:'manual'});await f.start(2);await f.finish();await f.stop();
 await expect(f.inspect(1)).rejects.toThrow('Artifact changed after collection');expect((await f.inspect(2)).value.status).toBe('completed');
});
