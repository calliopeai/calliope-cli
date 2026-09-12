import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {collectTaskOutput,replayExecution,ExecutionStore,type ExecutionChange} from '../src/orchestration/index.js';
import {supervisionEvidence,reviewEvidence,assertSupervisedRetry,assertSupervisionProposal,type SupervisionDecision} from '../src/supervision/index.js';
import {canonicalJson,digest} from '../src/approvals/index.js';
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-supervision-journal-')));vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No inference during replay.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
async function fixture(reviewer=false){
  const p=verifiedPlan();p.version=4;p.tasks=p.tasks.slice(0,1);p.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
  const task=p.tasks[0]!;delete task.outputs[0]!.path;task.outputs.push({id:'patch',kind:'patch',description:'Retained candidate.'});task.isolation={patchArtifactId:'patch',commands:[]};
  p.supervision={version:1,controllerId:'coordinator',...(reviewer?{reviewerId:'b'}:{}),maxRounds:3,maxStalledRounds:2,maxOutputTokens:10,principle:'speed',allowedActions:['retry','replan','decompose']};
  const current=await coordinatorRun(root,p),ownerId=randomUUID();await current.store.append({type:'started',ownerId});
  const finish=async(content='public toy')=>{const attempt=current.store.read().state.tasks['inspect-a']!.attempts+1;await current.store.append({type:'task_started',taskId:'inspect-a',attempt,sessionId:'worker-'+attempt});
    const collected=await collectTaskOutput(current.store,task,JSON.stringify({version:1,summary:'Recorded report.',outputs:[{id:'report-a',content}]}),{executorOutputs:new Map([['patch','retained patch']])});
    return current.store.append({type:'task_finished',taskId:'inspect-a',status:collected.status as 'failed'|'completed',output:collected.output});};
  const start=async(round=1,role:'controller'|'reviewer'='controller')=>{const evidence=supervisionEvidence(current.store.read().events);return current.store.append({type:'supervision_started',round,role,agentId:role==='controller'?'coordinator':'b',sessionId:role+'-'+round,evidenceIds:evidence.ids,evidenceHash:evidence.hash});};
  const decide=async(action:SupervisionDecision['action']='continue',role:'controller'|'reviewer'='controller')=>{const s=current.store.read().state.supervision!,decision={version:1,action,reason:'Inspect actual evidence.',evidence:[...s.evidenceIds],...(action==='retry'?{taskId:'inspect-a',hypothesis:'Another bounded attempt corrects the failed evidence.',expectedMetric:{name:'failed checks',direction:'decrease'}}:{})} as SupervisionDecision;
    return current.store.append({type:'supervision_decided',round:s.rounds,role,agentId:role==='controller'?'coordinator':'b',sessionId:role+'-'+s.rounds,decision});};
  const apply=async()=>{const s=current.store.read().state.supervision!;return current.store.append({type:'supervision_applied',round:s.rounds,decisionId:s.decisionId!,receipts:[]});};
  return{...current,ownerId,finish,start,decide,apply};
}

it('requires final review and independently rejects forged evidence, roles, sessions and repeated decisions',async()=>{
  const f=await fixture(true);await f.finish();const before=f.store.read();
  await expect(f.store.append({type:'finished',ownerId:f.ownerId,status:'completed'})).rejects.toThrow('final recorded');
  const fake=randomUUID();await expect(f.store.append({type:'supervision_started',round:1,role:'controller',agentId:'coordinator',sessionId:'controller-1',evidenceIds:[fake],evidenceHash:digest(canonicalJson([fake]))})).rejects.toThrow('evidence changed');expect(f.store.read()).toEqual(before);
  const started=await f.start();expect(started.version).toBe(3);
  await expect(f.store.append({type:'task_started',taskId:'inspect-a',attempt:2,sessionId:'unsafe'})).rejects.toThrow('controller decision');
  await expect(f.start()).rejects.toThrow('duplicated');
  await expect(f.decide('continue','reviewer')).rejects.toThrow('active evidence');
  const decision={version:1,action:'continue',reason:'Review.',evidence:[fake]};await expect(f.store.append({type:'supervision_decided',round:1,role:'controller',agentId:'coordinator',sessionId:'controller-1',decision} as ExecutionChange)).rejects.toThrow('recorded evidence');
  await f.decide();expect(f.store.read().state.supervision?.phase).toBe('draft-ready');await f.start(1,'reviewer');await f.decide('continue','reviewer');const applied=await f.apply();await expect(f.store.append(applied.change)).rejects.toThrow('unapplied');
  await f.store.append({type:'finished',ownerId:f.ownerId,status:'completed'});const saved=f.store.read();expect(replayExecution(saved.header,f.view.manifest,saved.events)).toEqual(saved.state);expect(fetch).not.toHaveBeenCalled();
});

it('resumes a committed decision without another model call and does not reset failed task attempts',async()=>{
  const f=await fixture();await f.finish('failed evidence');await f.start();await f.decide('retry');
  const saved=f.store.read(),restarted=new ExecutionStore(join(f.runs.root,f.view.run.id),f.view.manifest);expect(restarted.read()).toEqual(saved);
  await restarted.append({type:'started',ownerId:randomUUID()});expect(restarted.read().state.supervision?.phase).toBe('decision');await f.apply();expect(restarted.read().state.tasks['inspect-a']).toMatchObject({status:'pending',attempts:1});
  await f.finish();await f.start(2);await f.decide();await f.apply();expect(f.store.read().state.tasks['inspect-a']).toMatchObject({status:'completed',attempts:2});expect(fetch).not.toHaveBeenCalled();
});

it('marks an interrupted provider call for explicit recovery and retains round and stalled counters',async()=>{
  const f=await fixture();await f.finish('failed');await f.start();const saved=f.store.read(),ownerId=randomUUID();
  await f.store.append({type:'started',ownerId});expect(f.store.read().state.supervision).toMatchObject({rounds:1,stalledRounds:1,phase:'halted',halt:{outcome:'interrupted'}});
  await expect(f.store.append({type:'supervision_reset',source:'cli'})).rejects.toThrow('inactive');
  await f.store.append({type:'finished',ownerId,status:'failed'});await f.store.append({type:'supervision_reset',source:'repl'});
  expect(f.store.read().header).toEqual(saved.header);expect(f.store.read().state.supervision).toMatchObject({rounds:1,stalledRounds:1,phase:'ready',forceReview:true});
  await f.store.append({type:'started',ownerId:randomUUID()});await f.start(2);await f.store.append({type:'supervision_halted',round:2,outcome:'failed',reason:'Controller failed.'});const state=f.store.read().state;
  await f.store.append({type:'finished',ownerId:state.ownerId!,status:'failed'});await f.store.append({type:'supervision_reset',source:'cli'});await f.store.append({type:'started',ownerId:randomUUID()});await expect(f.start(3)).rejects.toThrow('stalled-round');
});

it('rejects late controller results and actions using the original account and run deadlines',async()=>{
  const f=await fixture();await f.finish();await f.start();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.store.read().header.deadline+1);
  await expect(f.decide()).rejects.toThrow('original deadline');
});

it('does not infer safe retries from task status when effects, consumers or receipts are uncertain',async()=>{
  const f=await fixture();await f.finish('failed');const {state,events}=f.store.read(),plan=f.view.manifest.plan;
  expect(()=>assertSupervisedRetry(plan,state,events,'inspect-a',[])).not.toThrow();
  for(const changes of [{status:'denied'},{attempts:4},{escalation:'parent'}])expect(()=>assertSupervisedRetry(plan,{...state,tasks:{...state.tasks,'inspect-a':{...state.tasks['inspect-a']!,...changes} as any}},events,'inspect-a',[])).toThrow();
  expect(()=>assertSupervisedRetry(plan,{...state,stoppedAgents:['coordinator']},events,'inspect-a',[])).toThrow('stopped');
  const mutated=structuredClone(state);mutated.tasks['inspect-a']!.mutations=true;
  expect(()=>assertSupervisedRetry(plan,mutated,events,'inspect-a',[])).toThrow('verification and patch');
  const started={...events[0]!,change:{type:'tool',taskId:'inspect-a',callId:'uncertain',name:'write_file',stage:'started'}} as any;
  expect(()=>assertSupervisedRetry(plan,mutated,[...events,started],'inspect-a')).toThrow('Uncertain');
  expect(()=>assertSupervisionProposal({source:{kind:'supervision',eventId:randomUUID()}} as any,state)).toThrow('recorded controller decision');
});

it('bounds evidence excerpts, detects changed snapshots and refuses non-outcome references',async()=>{
  const f=await fixture(),event=await f.finish('public toy '+ 'x'.repeat(10000));
  const evidence=await reviewEvidence(f.store,[event.id],{});expect(evidence[0]!.artifacts[0]).toMatchObject({bytes:10011,truncated:true});expect(evidence[0]!.artifacts[0]!.excerpt).toHaveLength(4096);
  await expect(reviewEvidence(f.store,[f.store.read().events[0]!.id],{})).rejects.toThrow('outcomes');
  const artifact=f.store.read().state.artifacts['report-a']!;fs.writeFileSync(join(f.store.root,'artifacts',artifact.path),'changed');await expect(reviewEvidence(f.store,[event.id],{})).rejects.toThrow('changed');
});
