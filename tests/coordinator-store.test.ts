import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {ExecutionStore,analyzePlan,collectTaskOutput,replayExecution,changePreparedRun,workerReport,workerSummary,readCollectedArtifact,validateExecutionEvent,validateExecutionHeader,validateCollectedArtifact,validateTaskOutput,controlExecution,readArtifactBytes} from '../src/orchestration/index.js';
import {canonicalJson,digest} from '../src/approvals/index.js';
import {simulateWindowsDirectoryFsyncDenial} from './helpers/windows-fsync.js';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-coordinator-store-')));fs.chmodSync(root,0o700);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No provider call');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
it('validates versioned acceptance checks without weakening legacy plans',()=>{
  const plan=verifiedPlan();expect(analyzePlan(plan).plan).toEqual(plan);
  for(const mutate of [(p:any)=>delete p.tasks[0].acceptanceChecks,(p:any)=>p.tasks[0].acceptanceChecks[0].criteria=['task:99'],(p:any)=>p.tasks[0].acceptanceChecks[0].artifactId='foreign',(p:any)=>p.tasks[0].acceptanceChecks[0].kind='shell',(p:any)=>p.version=1,(p:any)=>p.tasks[0].acceptanceChecks[0].expected='']){const value=structuredClone(plan);mutate(value);expect(()=>analyzePlan(value)).toThrow();}
});
it('rejects incompatible acceptance predicates and artifact inputs outside consumer scope',()=>{
  const invalid=[(p:any)=>p.tasks[0].acceptanceChecks.push(p.tasks[0].acceptanceChecks[0]),(p:any)=>p.tasks[0].acceptanceChecks[0].criteria=['agent:99'],(p:any)=>p.tasks[0].acceptanceChecks[0].kind='exists',(p:any)=>p.tasks[0].acceptanceChecks[0].kind='sha256',(p:any)=>p.tasks[0].acceptanceChecks[0].kind='json',
    (p:any)=>{p.tasks[1].inputs=[{id:'input',kind:'artifact',value:'report-a'}];p.tasks[1].dependencies=['inspect-a'];}];
  for(const mutate of invalid){const p=verifiedPlan();mutate(p);expect(()=>analyzePlan(p)).toThrow();}
});
it('collects inline artifacts and verifies exact JSON, digest and existence predicates from bytes',async()=>{
  const p=verifiedPlan(),spec=p.tasks[0]!.outputs[0]!;delete spec.path;const content='{"b":2,"a":1}',hash=createHash('sha256').update(content).digest('hex');
  p.tasks[0]!.acceptanceChecks=[{id:'json',artifactId:spec.id,kind:'json',expected:'{"a":1,"b":2}',criteria:['task:0']},{id:'hash',artifactId:spec.id,kind:'sha256',expected:hash,criteria:['agent:0']},{id:'exists',artifactId:spec.id,kind:'exists',criteria:['task:0']}];
  const {store,view}=await coordinatorRun(root,p);await store.append({type:'started',ownerId:randomUUID()});await store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:'toy'});
  const result=await collectTaskOutput(store,view.manifest.plan.tasks[0]!,JSON.stringify({version:1,summary:'Report',outputs:[{id:spec.id,content}]}));expect(result.status).toBe('completed');expect(result.output.testEvidence).toEqual(['json','hash','exists']);
  const artifact=result.output.artifacts[0]!;expect(artifact).toMatchObject({location:'run',sha256:hash});expect((await readCollectedArtifact(store,artifact)).toString()).toBe(content);
  fs.writeFileSync(join(store.root,'artifacts',artifact.path),'changed');await expect(readCollectedArtifact(store,artifact)).rejects.toThrow(/changed/);
  await expect(readCollectedArtifact(store,{...artifact,path:'../foreign'})).rejects.toThrow();
});
it('does not accept malformed worker output, fabricated metadata or absent evidence',async()=>{
  const p=verifiedPlan(),task=p.tasks[0]!;delete task.outputs[0]!.path;
  for(const report of [{version:9,summary:'Bad',outputs:[]},{version:1,summary:'Bad',outputs:[{id:'foreign',content:'x'}]},{version:1,summary:'Bad',outputs:[{id:'report-a',content:'one'},{id:'report-a',content:'two'}]},{version:1,summary:'Bad',outputs:[],risks:[123]}]){const result=workerReport(JSON.stringify(report),task);expect(result.outputs.size).toBe(0);expect(result.risks.length).toBeGreaterThan(0);}
  expect(workerReport('x'.repeat(1024*1024+1),task).risks).toContain('Worker report exceeded its size limit.');expect(workerSummary('')).toContain('no summary');
  const {store,view}=await coordinatorRun(root,p);await store.append({type:'started',ownerId:randomUUID()});await store.append({type:'task_started',taskId:task.id,attempt:1,sessionId:'toy'});
  const result=await collectTaskOutput(store,view.manifest.plan.tasks[0]!,'I passed every test.');expect(result.status).toBe('failed');expect(result.output.artifacts).toEqual([]);expect(result.output.testEvidence).toEqual([]);
});
it('accepts a valid report wrapped in model prose and a fenced JSON block',()=>{
  const task=structuredClone(verifiedPlan().tasks[0]!);delete task.outputs[0]!.path;const report='Verification complete:\n\n```json\n'+JSON.stringify({version:1,summary:'Read-back complete.',outputs:[{id:'report-a',content:'public toy'}]})+'\n```';
  const parsed=workerReport(report,task);expect(parsed.outputs.get('report-a')).toBe('public toy');expect(parsed.risks).toEqual([]);
});
it('rejects mismatched tool evidence and agent lifecycle events independently of runtime callbacks',async()=>{
  const {store}=await coordinatorRun(root);await store.append({type:'started',ownerId:randomUUID()});await store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:'toy'});
  const call={type:'tool' as const,taskId:'inspect-a',callId:'call',name:'write_file',path:'a/report.txt',mutating:true};
  await expect(store.append({...call,stage:'finished',success:true})).rejects.toThrow(/matching/);await expect(store.append({...call,stage:'started',success:false,mutating:false})).rejects.toThrow(/classification/);
  await store.append({...call,stage:'started',success:false});await expect(store.append({...call,stage:'started',success:false})).rejects.toThrow(/Duplicate/);
  await expect(store.append({...call,stage:'finished',success:true,path:'b/report.txt'})).rejects.toThrow();await store.append({...call,stage:'finished',success:true});await expect(store.append({...call,stage:'finished',success:true})).rejects.toThrow(/matching/);
  await expect(store.append({type:'agent_started',agentId:'b',taskId:'inspect-a'})).rejects.toThrow(/assigned/);await store.append({type:'agent_started',agentId:'a',taskId:'inspect-a'});await expect(store.append({type:'agent_started',agentId:'a',taskId:'inspect-a'})).rejects.toThrow(/lifecycle/);
  expect(store.read().state.tasks['inspect-a']!.changedFiles).toEqual(['a/report.txt']);
});
it('detects malformed provenance, output claims and broken event ancestry',async()=>{
  const {store,view,project}=await coordinatorRun(root);await store.append({type:'started',ownerId:randomUUID()});await store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:'toy'});fs.writeFileSync(join(project,'a/report.txt'),'public toy');const result=await collectTaskOutput(store,view.manifest.plan.tasks[0]!,'Report');const artifact=result.output.artifacts[0]!,saved=store.read();
  for(const change of [{confidence:0.5},{path:'b/report.txt'},{bytes:-1},{source:{runId:view.run.id,eventId:'fake'}},{location:'run'}])expect(()=>validateCollectedArtifact({...artifact,...change},view.manifest)).toThrow();
  for(const change of [{version:2},{status:'invented'},{changedFiles:['outside']},{testEvidence:['fabricated']},{artifacts:[artifact,artifact]},{checks:[{...result.output.checks[0],observedHash:'0'.repeat(64)}]}])expect(()=>validateTaskOutput({...result.output,...change},view.manifest)).toThrow();
  for(const change of [{version:2},{runId:randomUUID()},{deadline:0}])expect(()=>validateExecutionHeader({...saved.header,...change},view.manifest)).toThrow();
  for(const change of [{version:2},{sequence:0},{change:{type:'made_up'}},{hash:'0'.repeat(64)}])expect(()=>validateExecutionEvent({...saved.events[0],...change},view.manifest)).toThrow();
  const altered=structuredClone(saved.events);altered[1]!.previous='0'.repeat(64);const {hash,...body}=altered[1]!;altered[1]!.hash=digest(canonicalJson(body));expect(()=>replayExecution(saved.header,view.manifest,altered)).toThrow(/ancestry/);
  await expect(store.append({type:'task_finished',taskId:'inspect-a',status:'review_required',output:result.output})).rejects.toThrow(/status/);
});
it('applies group retries atomically and refuses decisions that outlive their approval',async()=>{
  const {store,project,runs,view}=await coordinatorRun(root);await store.append({type:'started',ownerId:randomUUID()});
  for(const id of ['inspect-a','inspect-b'])await store.append({type:'task_started',taskId:id,attempt:1,sessionId:id});
  // Orphan both attempts, then exhaust only B. A is still retryable.
  await store.append({type:'started',ownerId:randomUUID()});await store.append({type:'task_reset',taskId:'inspect-b',source:'manual'});await store.append({type:'task_started',taskId:'inspect-b',attempt:2,sessionId:'second'});const owner=randomUUID();await store.append({type:'started',ownerId:owner});await store.append({type:'finished',ownerId:owner,status:'failed'});
  const before=store.read();await expect(controlExecution(project,view.run.id,'agent-retry','coordinator',{store:runs})).rejects.toThrow(/retry/);expect(store.read()).toEqual(before);
  await expect(controlExecution(project,view.run.id,'retry','missing',{store:runs})).rejects.toThrow(/Unknown/);
  await expect(controlExecution(project,view.run.id,'retry','inspect-a',{store:runs,confirmation:'mutating',approve:async()=>{await changePreparedRun(project,view.run.id,'cancelled',{store:runs});return 'allow';}})).rejects.toThrow(/revoked/);expect(store.read()).toEqual(before);
});
it('checks content at the atomic commit boundary and preserves existing evidence on cancellation or unsafe storage',async()=>{
  const {store}=await coordinatorRun(root),before=store.read();await expect(store.appendBatch([{change:{type:'started',ownerId:randomUUID()}}],undefined,()=>{throw new Error('changed authority');})).rejects.toThrow('changed authority');expect(store.read()).toEqual(before);
  await expect(store.appendBatch([])).rejects.toThrow(/batch/);await expect(store.append({type:'started',ownerId:randomUUID()},AbortSignal.abort())).rejects.toThrow();
  const file=join(root,'public');fs.writeFileSync(file,'content',{mode:0o644});expect(()=>readArtifactBytes(file,3)).toThrow();expect(()=>readArtifactBytes(file,20,true)).toThrow();fs.symlinkSync(file,join(root,'alias'));expect(()=>readArtifactBytes(join(root,'alias'))).toThrow();
  expect(()=>store.writeArtifact('bad','content')).toThrow();fs.writeFileSync(join(store.root,'artifacts','foreign'),'untrusted');expect(()=>store.writeArtifact(randomUUID(),'content')).toThrow();
  const history=join(store.root,'history.json');fs.chmodSync(history,0o644);expect(()=>store.read()).toThrow();
});
it('permits a single live coordinator and keeps ownership checks bound to the same process and project',async()=>{
  const {store}=await coordinatorRun(root),lease=store.acquire();expect(store.owner()).toMatchObject({id:lease.id,pid:process.pid,alive:true});expect(()=>store.acquire()).toThrow(/owns/);lease.check();
  lease.release();expect(store.owner()).toBeNull();expect(()=>lease.check()).toThrow();const next=store.acquire();expect(next.id).not.toBe(lease.id);next.release();
});
it('replays collected evidence and refuses task completion without verified criteria',async()=>{
  const {store,project,view}=await coordinatorRun(root),lease=store.acquire();await store.append({type:'started',ownerId:lease.id});await store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:randomUUID()});
  fs.writeFileSync(join(project,'a/report.txt'),'public toy report');const collected=await collectTaskOutput(store,view.manifest.plan.tasks[0]!,'Report ready.');expect(collected.status).toBe('completed');
  const invalid=structuredClone(collected.output);invalid.checks=[];invalid.testEvidence=[];await expect(store.append({type:'task_finished',taskId:'inspect-a',status:'completed',output:invalid})).rejects.toThrow(/verified/);
  await store.append({type:'task_finished',taskId:'inspect-a',status:'completed',output:collected.output});const saved=store.read();expect(saved.state.tasks['inspect-a']!.status).toBe('completed');expect(replayExecution(saved.header,view.manifest,saved.events)).toEqual(saved.state);
  expect(new ExecutionStore(join(root,'runs',view.run.id),view.manifest).read()).toEqual(saved);expect(fetch).not.toHaveBeenCalled();lease.release();
});
it('enforces readiness, conflict and retry limits in the journal independently of the scheduler',async()=>{
  const plan=verifiedPlan();plan.limits.maxConcurrent=1;const {store}=await coordinatorRun(root,plan),lease=store.acquire();await store.append({type:'started',ownerId:lease.id});
  await expect(store.append({type:'task_started',taskId:'verify',attempt:1,sessionId:randomUUID()})).rejects.toThrow(/ready/);
  await store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:randomUUID()});await expect(store.append({type:'task_started',taskId:'inspect-b',attempt:1,sessionId:randomUUID()})).rejects.toThrow(/concurrency/);
  await expect(store.append({type:'finished',ownerId:lease.id,status:'completed'})).rejects.toThrow(/active|unverified/);lease.release();
  const next=store.acquire();await store.append({type:'started',ownerId:next.id});expect(store.read().state.tasks['inspect-a']!.status).toBe('unknown');
  await expect(store.append({type:'task_reset',taskId:'inspect-a',source:'automatic'})).rejects.toThrow(/retry/);await store.append({type:'task_reset',taskId:'inspect-a',source:'manual'});await store.append({type:'task_started',taskId:'inspect-a',attempt:2,sessionId:randomUUID()});next.release();
});
it('detects revoked approval and never recreates missing or damaged execution history',async()=>{
  const {store,project,runs,view}=await coordinatorRun(root);store.assertApproval(store.read().header);await changePreparedRun(project,view.run.id,'cancelled',{store:runs});expect(()=>store.assertApproval(store.read().header)).toThrow(/revoked/);
  const file=join(store.root,'history.json'),header=store.read().header;fs.writeFileSync(file,'{');expect(()=>store.read()).toThrow();expect(()=>store.create(header)).toThrow();fs.unlinkSync(file);expect(()=>store.read()).toThrow();
});
it('preserves prior journal state when atomic commit fails and does not reuse a foreign lock',async()=>{
  const {store}=await coordinatorRun(root),before=store.read();vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw new Error('disk failure');});await expect(store.append({type:'started',ownerId:randomUUID()})).rejects.toThrow('disk failure');expect(store.read()).toEqual(before);
  const lock=join(store.root,'writer.lock');fs.writeFileSync(lock,'foreign');const controller=new AbortController(),pending=store.append({type:'started',ownerId:randomUUID()},controller.signal);controller.abort();await expect(pending).rejects.toThrow();expect(fs.readFileSync(lock,'utf8')).toBe('foreign');
});
it('creates and appends the execution journal on Windows, where its directories cannot be fsynced (#388)',async()=>{
  const restore=simulateWindowsDirectoryFsyncDenial();
  try{
    const {store}=await coordinatorRun(root);await store.append({type:'agent_stop',agentId:'a'});
    expect(store.read().state.stoppedAgents).toEqual(['a']);
  }finally{restore();}
});
