import {beforeEach,afterEach,it as test,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {clearModelCache} from '../src/model-detection.js';
import {projectBudgetPath} from '../src/budget.js';
import {ReservationLedger} from '../src/execution/index.js';
import {RunStore,ExecutionStore,analyzePlan,changePreparedRun,executeReviewedRun,replayExecution,validateExecutionEvent,controlExecution,prepareAgentExecution,type ProjectPlan} from '../src/orchestration/index.js';
import {GoalStore,signed,newGoalManifest,plannerPlan,allocatePlan,startGoal,approveGoal,resumeGoal,inspectGoal,cancelGoal,reviseGoal,runGoalCommand,formatGoal,type GoalOptions,type GoalInspection} from '../src/goals/index.js';
import {handleCommand,type CommandContext} from '../src/ui/commands.js';
import {verifiedPlan} from './helpers/coordinator-run.js';

let root:string,project:string,runs:RunStore,goals:GoalStore,created:GoalInspection|undefined,requests:any[],proposed:unknown;
let respond:(task:any,body:any,signal:AbortSignal)=>Promise<Response>;
// Full-suite/coverage process contention must not expire the test harness before its bounded scenario.
const it=(name:string,run:()=>Promise<void>)=>test(name,run,20000);
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function completion(content:string,tools?:unknown[]) {return json({id:'toy',object:'chat.completion',model:'goal-toy',choices:[{index:0,message:{role:'assistant',content,...(tools?{tool_calls:tools}:{})},finish_reason:tools?'tool_calls':'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});}
function reply(task:any,body:any) {
  if(task.id==='propose')return completion(JSON.stringify({version:1,summary:'Public toy proposal.',outputs:[{id:'proposal',content:typeof proposed==='string'?proposed:JSON.stringify(proposed)}],risks:[]}));
  if(!body.messages.some((m:any)=>m.role==='tool'))return completion('Writing evidence.',[{id:'call-'+task.id,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:task.outputs[0].path,content:'public toy artifact for '+task.id})}}]);
  return completion('Recorded toy artifact.');
}
function plan():ProjectPlan {const p=verifiedPlan();p.limits.tokenBudget=30000;p.limits.costBudgetUsd=0.06;p.limits.timeBudgetMs=60000;for(const a of p.agents){a.tokenBudget=a.parentId?10000:30000;a.costBudgetUsd=a.parentId?0.02:0.06;a.timeBudgetMs=60000;}return p;}
const options=():GoalOptions=>({store:runs,goals,limits:{tokenBudget:50000,costBudgetNanos:100000000,timeBudgetMs:120000,planningTokens:10000,planningCostNanos:20000000,planningTimeMs:60000,maxOutputTokens:100},preference:{provider:'deepseek',model:'goal-toy'},onCreated:view=>{created=view;}});
const start=()=>startGoal(project,'Inspect the public toy project and record evidence.',options());
async function planningHistory(){const goal=goals.read(created!.manifest.id),run=await runs.read(goal.state.planning!.runId,project),store=new ExecutionStore(join(runs.root,run.run.id),run.manifest);return{goal,run,store,...store.read()};}
beforeEach(()=>{
  config.resetConfig();saveHooks([]);clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-goal-runtime-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.mkdirSync(join(project,'b'));runs=new RunStore(join(root,'runs'));goals=new GoalStore(join(root,'goals'));created=undefined;requests=[];proposed=plan();respond=async(task,body)=>reply(task,body);
  for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of[names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://goal.invalid/v1'});config.set('routing',{enabled:true,providerPool:['deepseek']});
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{const req=new Request(input,init);if(new URL(req.url).pathname==='/v1/models')return json({data:[{id:'goal-toy',context_length:4096,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}]});
    expect(req.url).toBe('https://goal.invalid/v1/chat/completions');const body=await req.json(),context=body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')),task=JSON.parse(context.content).task;requests.push({task:task.id,body});return respond(task,body,init?.signal??req.signal);
  }));
});
it('repairs an inherited retry violation through the SDK, keeps rejected bytes and freezes only the final agent proposal',async()=>{
  const bad=plan();bad.agents[0]!.escalationPolicy.maxRetries=0;bad.agents[1]!.escalationPolicy.maxRetries=1;
  respond=async(task,body)=>{proposed=requests.length===1?bad:plan();return reply(task,body);};
  const result=await startGoal(project,'Inspect the public toy project.',{...options(),planningRepairs:1});
  expect(result.status).toBe('review_required');expect(result.goal.manifest).toMatchObject({version:4,planningRepair:{version:1,maxRetries:1}});expect(result.goal.state.execution).toBeNull();
  const h=await planningHistory(),checks=h.events.filter(e=>e.change.type==='proposal_validated');
  expect(checks).toHaveLength(2);expect(checks[0]).toMatchObject({version:4,change:{valid:false,diagnostics:[{path:'agents[1].escalationPolicy.maxRetries',parentPath:'agents[0].escalationPolicy.maxRetries',actual:1,limit:0}]}});expect(checks[1]).toMatchObject({version:4,change:{valid:true,diagnostics:[]}});
  expect(h.state.tasks.propose).toMatchObject({attempts:2,status:'review_required'});expect(h.events.filter(e=>e.change.type==='task_reset')).toHaveLength(1);
  const artifacts=h.events.filter(e=>e.change.type==='artifact').map(e=>(e.change as any).artifact);
  expect(artifacts).toHaveLength(2);expect(artifacts[0].sha256).not.toBe(artifacts[1].sha256);
  expect(JSON.parse(fs.readFileSync(join(h.store.root,'artifacts',artifacts[0].path),'utf8'))).toEqual(bad);
  expect(result.goal.proposal!.source).toEqual({kind:'agent',runId:h.run.run.id,artifactId:'proposal',artifactHash:artifacts[1].sha256,eventId:artifacts[1].source.eventId});
  const feedback=JSON.parse(requests[1].body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content).previousAttempts[0];expect(feedback.summary).toContain('agents[1].escalationPolicy.maxRetries');expect(feedback.summary).toContain('Actual 1; limit 0');
  expect(h.goal.state.planningSpend?.tokens).toBe(20);const ledger=new ReservationLedger(join(runs.root,h.run.run.id,'budget')).read(project);expect(ledger.manifest.createdAt).toBe(Date.parse(h.goal.manifest.createdAt));expect(ledger.manifest.deadline).toBe(h.goal.state.planning!.deadline);
  expect(replayExecution(h.header,h.run.manifest,h.events)).toEqual(h.state);
  expect((await resumeGoal(project,h.goal.manifest.id,{goals:new GoalStore(goals.root),store:new RunStore(runs.root)})).goal.proposal).toEqual(result.goal.proposal);expect(requests).toHaveLength(2);
});
it('bounds repeated malformed plans and retains all attempts without allocating execution',async()=>{
  proposed='{';await expect(startGoal(project,'Public malformed draft.',{...options(),planningRepairs:2})).rejects.toThrow(/usable proposal/);
  const h=await planningHistory();expect(requests).toHaveLength(3);expect(h.state.tasks.propose).toMatchObject({attempts:3,status:'failed',escalation:'human'});expect(h.goal.state).toMatchObject({planningFrozen:true,status:'failed',execution:null,planningSpend:{tokens:30}});
  expect(h.events.filter(e=>e.change.type==='proposal_validated')).toHaveLength(3);expect(h.events.filter(e=>e.change.type==='artifact')).toHaveLength(3);
  await resumeGoal(project,h.goal.manifest.id,options());expect(requests).toHaveLength(3);
});
it('repairs missing and oversized reports only within the original attempt count',async()=>{
  respond=async(task,body)=>requests.length===1?completion('x'.repeat(1024*1024+1)):reply(task,body);
  const result=await startGoal(project,'Public missing report.',{...options(),planningRepairs:1});expect(result.status).toBe('review_required');expect(requests).toHaveLength(2);
  const h=await planningHistory();expect(h.events.filter(e=>e.change.type==='proposal_validated')).toHaveLength(1);expect(h.state.tasks.propose!.attempts).toBe(2);
});
it('validates and repairs both planning stages before a reviewer consumes the accepted draft',async()=>{
  const counts:Record<string,number>={};respond=async(task,body)=>{counts[task.id]=(counts[task.id]??0)+1;return completion(JSON.stringify({version:1,summary:'Public reviewed draft.',outputs:task.outputs.map((o:any)=>({id:o.id,content:o.id==='plan-review'?'Reviewed the supplied draft.':counts[task.id]===1?'{':JSON.stringify(plan())})),risks:[]}));};
  const result=await startGoal(project,'Public reviewed proposal.',{...options(),planningRepairs:1,team:{version:1,reviewer:{provider:'deepseek',model:'goal-toy'}}});
  expect(result.status).toBe('review_required');expect(requests.map(r=>r.task)).toEqual(['draft','draft','propose','propose']);const h=await planningHistory();expect(h.state.tasks.draft!.attempts).toBe(2);expect(h.state.tasks.propose!.attempts).toBe(2);expect(h.goal.state.planningSpend!.tokens).toBe(40);
  const context=JSON.parse(requests[2].body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content);expect(JSON.parse(context.dependencyArtifacts[0].content)).toEqual(plan());expect(result.goal.proposal!.source).toMatchObject({kind:'agent',artifactId:'proposal'});
});
it('cancels after a rejected artifact without issuing a repair and retains the paid attempt',async()=>{
  proposed='{';const controller=new AbortController();await expect(startGoal(project,'Cancel rejected plan.',{...options(),planningRepairs:2,signal:controller.signal,onRunEvent:e=>{if(e.change.type==='proposal_validated')controller.abort();}})).rejects.toThrow();
  const h=await planningHistory();expect(requests).toHaveLength(1);expect(h.goal.state).toMatchObject({status:'cancelled',planningFrozen:true,execution:null,planningSpend:{tokens:10}});expect(h.events.filter(e=>e.change.type==='task_reset')).toHaveLength(0);
});
it('denies a repair when the original planning budget cannot admit another request',async()=>{
  respond=async()=>json({id:'toy',object:'chat.completion',model:'goal-toy',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({version:1,summary:'Invalid draft.',outputs:[{id:'proposal',content:'{'}],risks:[]})},finish_reason:'stop'}],usage:{prompt_tokens:4000,completion_tokens:100,total_tokens:4100}});
  const opts=options();await expect(startGoal(project,'Bounded public draft.',{...opts,planningRepairs:2,limits:{...opts.limits,planningTokens:6000}})).rejects.toThrow();
  const h=await planningHistory();expect(requests).toHaveLength(1);expect(h.goal.state).toMatchObject({status:'denied',planningFrozen:true,execution:null});expect(h.goal.state.planningSpend!.tokens).toBe(4100);
});
it('never retries a policy-denied planner tool and does not create files',async()=>{
  respond=async()=>completion('Forbidden mutation.',[{id:'denied',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'forbidden.txt',content:'toy'})}}]);
  await expect(startGoal(project,'Read only planner.',{...options(),planningRepairs:2})).rejects.toThrow();const h=await planningHistory();expect(requests).toHaveLength(1);expect(h.state.tasks.propose!.status).toBe('denied');expect(fs.existsSync(join(project,'forbidden.txt'))).toBe(false);
});
it('keeps headless envelopes stable and exposes immutable proposal diagnostics',async()=>{
  proposed='{';const lines:string[]=[];const code=await runGoalCommand(['Public draft.','--planning-repairs','1','--json'],{...options(),cwd:project,write:line=>lines.push(line)});
  expect(code).toBe(1);const records=lines.map(line=>JSON.parse(line));expect(records.every(r=>r.version===1)).toBe(true);const validations=records.filter(r=>r.type==='orchestration.goal.run_event'&&r.data.change.type==='proposal_validated');expect(validations).toHaveLength(2);expect(validations.every(r=>r.data.version===4&&r.data.change.valid===false)).toBe(true);
});
it('validates direct run entry points and resumes the same unfinished planning allocation without replenishment',async()=>{
  const m=newGoalManifest(project,'Direct public planner.',runs.root,{...options(),planningRepairs:1});goals.create(m);created=goals.read(m.id);
  const p=plannerPlan(m),analysis=analyzePlan(p),allocation=allocatePlan(m,p,'planning');await goals.append(m.id,{type:'planning_allocated',allocation});
  const binding={id:allocation.runId,createdAt:m.createdAt,goal:{version:1 as const,root:goals.root,id:m.id,manifestHash:m.hash,allocationId:allocation.id,phase:'planning' as const}};
  const prepared=await runs.prepare(analysis,project,{kind:'goal',path:'planning.json',sha256:analysis.hash},undefined,binding);await changePreparedRun(project,prepared.run.id,'approved',{store:runs});
  const controller=new AbortController();proposed='{';await executeReviewedRun(project,allocation.runId,{store:runs,maxOutputTokens:100,signal:controller.signal,onEvent:e=>{if(e.change.type==='task_finished')controller.abort();}});
  let h=await planningHistory();expect(h.state.tasks.propose).toMatchObject({status:'failed',attempts:1});expect(h.goal.state.planningFrozen).toBe(false);const budget=new ReservationLedger(join(runs.root,h.run.run.id,'budget')).read(project).manifest;
  proposed=plan();const result=await resumeGoal(project,m.id,{...options(),goals:new GoalStore(goals.root),store:new RunStore(runs.root)});expect(result.status).toBe('review_required');h=await planningHistory();expect(h.state.tasks.propose!.attempts).toBe(2);expect(requests).toHaveLength(2);
  expect(h.goal.state.planning).toEqual(allocation);expect(h.goal.manifest).toEqual(m);expect(new ReservationLedger(join(runs.root,h.run.run.id,'budget')).read(project).manifest).toEqual(budget);
});
it('rejects altered, duplicate and unchecked proposal validation histories on deterministic replay',async()=>{
  const result=await startGoal(project,'Public valid draft.',{...options(),planningRepairs:1}),h=await planningHistory(),at=h.events.findIndex(e=>e.change.type==='proposal_validated'),check=h.events[at]!;
  const rebuild=(events:any[])=>{let previous=h.events[0]!.previous;return events.map((e,i)=>{const {hash,...body}=e;const next=signed({...body,sequence:i+1,previous});previous=next.hash;return next;});};
  expect(result.status).toBe('review_required');
  for(const change of [{...check.change,goalManifestHash:'f'.repeat(64)},{...check.change,diagnostics:[{path:'../../key',message:'Invalid'}]},{...check.change,valid:false,diagnostics:[]},{...check.change,valid:false,diagnostics:[{path:'$',message:'Rejected',actual:Infinity}]}]){const {hash,...body}=check;expect(()=>validateExecutionEvent(signed({...body,change}),h.run.manifest,h.header)).toThrow();}
  const noCheck=h.events.filter((_,i)=>i!==at);expect(()=>replayExecution(h.header,h.run.manifest,rebuild(noCheck))).toThrow(/unchecked/);
  const duplicate=[...h.events.slice(0,at+1),{...check,id:randomUUID()},...h.events.slice(at+1)];expect(()=>replayExecution(h.header,h.run.manifest,rebuild(duplicate))).toThrow(/one immutable/);
  const rejected=h.events.map((e,i)=>i===at?{...e,change:{...e.change,valid:false,diagnostics:[{path:'$',message:'Rejected'}]}}:e);expect(()=>replayExecution(h.header,h.run.manifest,rebuild(rejected))).toThrow(/rejected/);
  const wrongHash=h.events.map((e,i)=>i===at?{...e,change:{...e.change,artifactHash:'f'.repeat(64)}}:e);expect(()=>replayExecution(h.header,h.run.manifest,rebuild(wrongHash))).toThrow(/immutable/);
  const late=[...h.events.slice(0,at),{...check,at:new Date(h.header.deadline).toISOString()}];expect(()=>replayExecution(h.header,h.run.manifest,rebuild(late))).toThrow(/unexpired/);
  const stopped=[...h.events.slice(0,at),{...check,id:randomUUID(),version:1,change:{type:'agent_stop',agentId:'planner'}},check];expect(()=>replayExecution(h.header,h.run.manifest,rebuild(stopped))).toThrow(/active/);
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});

it('plans through the SDK, requires exact proposal approval, executes verified work and preserves both budgets across restart',async()=>{
  const events:any[]=[],first=await startGoal(project,'Inspect the public toy project.',{...options(),onGoalEvent:event=>events.push(event)}),g=first.goal;
  expect(first).toMatchObject({status:'review_required',exitCode:5,execution:null});expect(requests.map(r=>r.task)).toEqual(['propose']);expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);
  expect(g.proposal).toMatchObject({knowledgeStatus:'proposed',confidence:null,inferred:true,source:{kind:'agent',runId:g.state.planning!.runId,artifactId:'proposal'}});
  expect(g.proposal!.plan.agents[0]!.preference).toEqual({provider:'deepseek',model:'goal-toy'});expect(g.state.planningSpend?.tokens).toBe(10);
  expect(events.map(e=>e.change.type)).toEqual(['planning_allocated','planning_finished']);
  await expect(approveGoal(project,g.manifest.id,'a'.repeat(64),options())).rejects.toThrow(/current/);
  await expect(prepareAgentExecution(project,g.state.planning!.runId,'planner',100,{store:runs})).rejects.toThrow(/frozen/);
  const done=await approveGoal(project,g.manifest.id,g.proposal!.hash,{...options(),approve:async()=> 'allow'});
  expect(done).toMatchObject({status:'completed',exitCode:0});expect(requests).toHaveLength(7);expect(Object.values(done.execution!.state.tasks).every(t=>t.output?.testEvidence.length===1)).toBe(true);
  const allocation=done.goal.state.execution!,ledger=new ReservationLedger(join(runs.root,allocation.runId,'budget')).read(project);
  expect(ledger.manifest.createdAt).toBe(Date.parse(g.manifest.createdAt));expect(ledger.manifest.deadline).toBe(allocation.deadline);expect(done.goal.manifest).toEqual(g.manifest);
  const restart=await resumeGoal(project,g.manifest.id,{store:new RunStore(runs.root),goals:new GoalStore(goals.root)});expect(restart.status).toBe('completed');expect(requests).toHaveLength(7);expect(goals.owner(g.manifest.id)).toBeNull();
  expect(restart.goal.proposal!.knowledgeStatus).toBe('proposed');
});
it('denies execution mutations by default and a later explicit bounded retry uses the same allocation',async()=>{
  const first=await start(),id=first.goal.manifest.id,denied=await approveGoal(project,id,first.goal.proposal!.hash,options());
  expect(denied.status).toBe('denied');expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);
  const allocation=denied.goal.state.execution!;for(const agent of ['a','b'])await controlExecution(project,allocation.runId,'agent-retry',agent,{store:runs});
  const done=await resumeGoal(project,id,{...options(),approve:async()=> 'allow'});expect(done.status).toBe('completed');expect(done.goal.state.execution).toEqual(allocation);
});
it('freezes malformed planner output and permits a human correction without another planning request',async()=>{
  proposed='{';await expect(start()).rejects.toThrow(/valid JSON/);const id=created!.manifest.id,failed=goals.read(id,project);expect(failed.state).toMatchObject({status:'failed',planningFrozen:true,planningSpend:{tokens:10}});
  expect((await resumeGoal(project,id,options())).status).toBe('failed');expect(requests).toHaveLength(1);
  fs.writeFileSync(join(project,'revised.json'),JSON.stringify(plan()));const revised=await reviseGoal(project,id,'revised.json',options());expect(revised.status).toBe('review_required');expect(revised.goal.proposal).toMatchObject({inferred:false,source:{kind:'human',path:'revised.json'},knowledgeStatus:'proposed'});
  expect(revised.goal.manifest).toEqual(failed.manifest);expect(revised.goal.state.planningSpend).toEqual(failed.state.planningSpend);expect(requests).toHaveLength(1);
});
it('invalidates a prior proposal hash after human revision and rejects scope expansion',async()=>{
  const first=await start(),id=first.goal.manifest.id,p=plan();p.goal='A revised public toy goal.';fs.writeFileSync(join(project,'revision.json'),JSON.stringify(p));const revised=await reviseGoal(project,id,'revision.json',options());
  expect(revised.goal.proposal!.hash).not.toBe(first.goal.proposal!.hash);await expect(approveGoal(project,id,first.goal.proposal!.hash,options())).rejects.toThrow(/current/);
  p.workspace.allowedTools.push('shell');fs.writeFileSync(join(project,'expanded.json'),JSON.stringify(p));await expect(reviseGoal(project,id,'expanded.json',options())).rejects.toThrow();expect(goals.read(id).state.proposalHash).toBe(revised.goal.proposal!.hash);expect(requests).toHaveLength(1);
});
it('records policy denial before execution starts and keeps the one approved allocation for resume',async()=>{
  const first=await start(),id=first.goal.manifest.id;const onGoalEvent=(event:any)=>{if(event.change.type==='execution_started')config.set('policy',{command:'exit 17'});};
  await expect(approveGoal(project,id,first.goal.proposal!.hash,{...options(),onGoalEvent})).rejects.toThrow(/policy/);
  const failed=await inspectGoal(project,id,options());expect(failed.status).toBe('denied');expect(failed.goal.events.at(-1)!.change.type).toBe('execution_interrupted');expect(requests).toHaveLength(1);
  config.set('policy',{});const done=await resumeGoal(project,id,{...options(),approve:async()=> 'allow'});expect(done.status).toBe('completed');expect(done.goal.state.execution).toEqual(failed.goal.state.execution);
});
it('cancels a running planner, waits for transport abort and preserves unknown request spend',async()=>{
  let ready!:()=>void,wireSignal:AbortSignal|undefined;const began=new Promise<void>(resolve=>{ready=resolve;});respond=async(_task,_body,signal)=>{wireSignal=signal;ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const pending=start();const rejected=expect(pending).rejects.toThrow();await began;const id=created!.manifest.id;await cancelGoal(project,id,options());await rejected;
  const saved=goals.read(id);expect(wireSignal!.aborted).toBe(true);expect(saved.state).toMatchObject({status:'cancelled',revoked:true,planningFrozen:true,planningSpend:{tokens:4196}});expect(goals.owner(id)).toBeNull();
  expect((await resumeGoal(project,id,options())).status).toBe('cancelled');expect(requests).toHaveLength(1);
});
it('revokes linked worker authority and direct retry or acceptance after explicit goal cancellation',async()=>{
  const first=await start(),id=first.goal.manifest.id;let ready!:()=>void;const began=new Promise<void>(resolve=>{ready=resolve;});respond=async(_task,_body,signal)=>{ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const pending=approveGoal(project,id,first.goal.proposal!.hash,{...options(),approve:async()=> 'allow'}),settled=pending.then(value=>value.status,()=> 'cancelled');await began;await cancelGoal(project,id,options());expect(await settled).toBe('cancelled');
  const saved=await inspectGoal(project,id,options());expect(saved.status).toBe('cancelled');expect(saved.execution!.state.status).toBe('cancelled');expect(goals.owner(id)).toBeNull();
  await expect(controlExecution(project,saved.goal.state.execution!.runId,'retry','inspect-a',{store:runs})).rejects.toThrow(/revoked/);
  expect(saved.goal.state.execution!.tokens+saved.goal.state.planningSpend!.tokens).toBeLessThanOrEqual(saved.goal.manifest.limits.tokenBudget);
});
it('cancels a waiting REPL plan approval without allocating workers',async()=>{
  const first=await start(),id=first.goal.manifest.id;let ready!:()=>void,approvalSignal:AbortSignal|undefined;const began=new Promise<void>(resolve=>{ready=resolve;});
  const pending=approveGoal(project,id,first.goal.proposal!.hash,{...options(),source:'repl',approve:async(_decision,signal)=>{approvalSignal=signal;ready();return new Promise(resolve=>signal!.addEventListener('abort',()=>resolve('cancelled'),{once:true}));}}),rejected=expect(pending).rejects.toThrow();
  await began;await cancelGoal(project,id,options());await rejected;expect(approvalSignal!.aborted).toBe(true);expect(goals.read(id).state.execution).toBeNull();expect(requests).toHaveLength(1);
});
it('denies project policy before creating goal state and rejects aborted input without discovery',async()=>{
  config.set('policy',{command:'exit 17'});await expect(start()).rejects.toThrow(/policy/);expect(created).toBeUndefined();expect(fs.existsSync(goals.root)).toBe(false);expect(fetch).not.toHaveBeenCalled();
  await expect(startGoal(project,'Public toy goal.',{...options(),signal:AbortSignal.abort()})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('streams versioned goal and child events, reviews the exact plan and keeps headless reads free of inference',async()=>{
  const lines:string[]=[],opts={...options(),cwd:project,write:(line:string)=>lines.push(line)};
  expect(await runGoalCommand(['Inspect','public','toy','evidence.','--json'],opts)).toBe(5);
  const records=lines.map(line=>JSON.parse(line)),first=records.at(-1).data,id=first.goal.manifest.id;
  expect(records.every(record=>record.version===1)).toBe(true);expect(records.map(record=>record.type)).toContain('orchestration.goal.run_event');expect(records.filter(record=>record.type==='orchestration.goal.event').map(record=>record.data)).toEqual(first.goal.events);
  expect(requests).toHaveLength(1);lines.length=0;
  expect(await runGoalCommand(['approve',id,first.goal.proposal.hash,'--allow-mutations','--max-output-tokens','90','--json'],opts)).toBe(0);
  const done=JSON.parse(lines.at(-1)!).data;expect(done.status).toBe('completed');expect(JSON.parse(lines[0]!).type).toBe('orchestration.goal.review');expect(requests.slice(1).every(r=>r.body.max_tokens===90)).toBe(true);
  for(const args of [['status',id],['proposal',id],['replay',id],['list']]){lines.length=0;expect(await runGoalCommand([...args,'--json'],opts)).toBe(0);expect(JSON.parse(lines[0]!).version).toBe(1);}expect(requests).toHaveLength(7);
  expect(formatGoal(done,'replay')).toContain('execution_finished');expect(formatGoal(done,'proposal')).toContain('acceptanceChecks');
});
it('rejects malformed command flags before creating or spending and reports cancellation and policy exits',async()=>{
  const lines:string[]=[],opts={...options(),cwd:project,write:(line:string)=>lines.push(line)};
  for(const args of [[],['--unknown'],['goal','--tokens','0'],['goal','--cost','1e2'],['goal','--cost','-1'],['goal','--cost','0.1234567891'],['goal','--time-ms','no'],['goal','--max-output-tokens','100000001'],['goal','--tokens','9007199254740992'],['goal','--allow-mutations'],['status'],['status','id','--tokens','2'],['approve','id'],['list','extra'],['list','--max-output-tokens','1'],['goal\x00'],['goal','--provider','invalid']]){
    lines.length=0;expect(await runGoalCommand([...args,'--json'],opts),JSON.stringify(args)).toBe(2);expect(JSON.parse(lines.at(-1)!).error.code).toBe('invalid');
  }
  expect(created).toBeUndefined();expect(fetch).not.toHaveBeenCalled();
  expect(await runGoalCommand(['toy','--json'],{...opts,signal:AbortSignal.abort()})).toBe(130);
  config.set('policy',{command:'exit 17'});expect(await runGoalCommand(['toy','--json'],opts)).toBe(3);expect(fetch).not.toHaveBeenCalled();
});
it('captures exact decimal and read-only CLI bounds, including literal goal words after --',async()=>{
  const lines:string[]=[],opts={...options(),cwd:project,write:(line:string)=>lines.push(line)};
  expect(await runGoalCommand(['--tokens','50000','--planning-tokens','10000','--cost','0.100000001','--planning-cost','0.02','--time-ms','60000','--planning-time-ms','20000','--max-agents','4','--max-tasks','4','--max-depth','2','--max-concurrent','2','--provider','deepseek','--model','goal-toy','--read-path','a','--json','--','status'],opts)).toBe(2);
  const goal=goals.read(created!.manifest.id);expect(goal.manifest.goal).toBe('status');expect(goal.manifest.limits.costBudgetNanos).toBe(100000001);expect(goal.state.status).toBe('failed');expect(goal.manifest.workspace.allowedPaths).toEqual([{path:'a',access:'read'}]);
  expect(requests).toHaveLength(1);expect(requests[0].body.tools.every((tool:any)=>['read_file','list_files','think'].includes(tool.function.name))).toBe(true);
});
it('supports revision and cancellation commands while retaining evidence and useful text',async()=>{
  const first=await start(),id=first.goal.manifest.id,lines:string[]=[],opts={...options(),cwd:project,write:(line:string)=>lines.push(line)};fs.writeFileSync(join(project,'reviewed.json'),JSON.stringify(plan()));
  expect(await runGoalCommand(['revise',id,'reviewed.json','--json'],opts)).toBe(5);expect(JSON.parse(lines.at(-1)!).data.goal.proposal.source.kind).toBe('human');
  expect(await runGoalCommand(['cancel',id,'--json'],opts)).toBe(0);expect(JSON.parse(lines.at(-1)!).data.status).toBe('cancellation-requested');
  lines.length=0;expect(await runGoalCommand(['status',id],opts)).toBe(0);expect(lines[0]).toContain('Cancellation requested');expect(requests).toHaveLength(1);
  expect(await runGoalCommand(['resume',id,'--json'],opts)).toBe(130);
});
it('shows the complete plan before REPL approval and gives each tool its own approval decision',async()=>{
  const lines:string[]=[],decisions:string[]=[],opts={...options(),cwd:project,source:'repl' as const,write:(line:string)=>lines.push(line),approve:async(decision:any)=>{decisions.push(decision.request.tool);if(decision.request.tool==='orchestration_goal_approve'){expect(lines.at(-1)).toContain('acceptanceChecks');expect(decision.request.details.join('\n')).toContain('proposal');}return 'allow' as const;}};
  expect(await runGoalCommand(['Plan the public toy work.'],opts)).toBe(0);expect(decisions).toContain('orchestration_goal_approve');expect(decisions.filter(d=>d==='write_file')).toHaveLength(3);expect(lines.at(-1)).toContain('completed');
});
it('connects the slash command to goal planning and exposes the returned review ID without auto-approval',async()=>{
  const lines:string[]=[],ctx={sessionRef:{current:{projectPath:project}},provider:'deepseek',model:'goal-toy',mode:'work',addMessage:(_role:string,line:string)=>lines.push(line)} as unknown as CommandContext;
  await handleCommand('/ORCHESTRATE "Inspect public toy evidence." --max-output-tokens 100',ctx);expect(lines.at(-1)).toContain('review_required');const id=/Goal ([a-f0-9-]{36})/.exec(lines.at(-1)!)![1]!;
  try{expect(new GoalStore().read(id).manifest.preference).toEqual({provider:'deepseek',model:'goal-toy'});await handleCommand(`/orchestrate status ${id}`,ctx);expect(lines.at(-1)).toContain(id);expect(requests).toHaveLength(1);}finally{fs.rmSync(new GoalStore().directory(id),{recursive:true,force:true});}
});
it('resumes a durable allocation after interruption without replacing its run ID or deadline',async()=>{
  const first=await start(),id=first.goal.manifest.id;
  await expect(approveGoal(project,id,first.goal.proposal!.hash,{...options(),onGoalEvent:event=>{if(event.change.type==='execution_allocated')throw new Error('Interrupted after allocation.');}})).rejects.toThrow(/Interrupted/);
  const allocated=goals.read(id);expect(allocated.state.status).toBe('approved');expect(fs.existsSync(join(runs.root,allocated.state.execution!.runId))).toBe(false);
  const done=await resumeGoal(project,id,{...options(),approve:async()=> 'allow'});expect(done.status).toBe('completed');expect(done.goal.state.execution).toEqual(allocated.state.execution);expect(done.goal.manifest.deadline).toBe(first.goal.manifest.deadline);
});
it('fails closed for a partially created execution directory and never allocates another budget',async()=>{
  const first=await start(),id=first.goal.manifest.id;
  await expect(approveGoal(project,id,first.goal.proposal!.hash,{...options(),onGoalEvent:event=>{if(event.change.type==='execution_allocated')fs.mkdirSync(join(runs.root,event.change.allocation.runId),{mode:0o700});}})).rejects.toThrow();
  const allocated=goals.read(id).state.execution!;await expect(resumeGoal(project,id,options())).rejects.toThrow();expect(goals.read(id).state.execution).toEqual(allocated);expect(requests).toHaveLength(1);
});
it('rejects stale approval after a concurrent cancellation and never refreshes an expired goal clock',async()=>{
  const first=await start(),id=first.goal.manifest.id;
  await expect(approveGoal(project,id,first.goal.proposal!.hash,{...options(),source:'repl',approve:async()=>{await cancelGoal(project,id,options());return 'allow';}})).rejects.toThrow();expect(goals.read(id).state.execution).toBeNull();
  const second=await start();const original=second.goal.manifest;const now=vi.spyOn(Date,'now').mockReturnValue(original.deadline+1);
  try{await expect(approveGoal(project,original.id,second.goal.proposal!.hash,options())).rejects.toThrow(/deadline/);expect((await inspectGoal(project,original.id,options())).goal.manifest).toEqual(original);}finally{now.mockRestore();}
  expect(requests).toHaveLength(2);
});
it('reports later human acceptance from the linked execution without creating fresh work',async()=>{
  const p=plan();for(const task of p.tasks)task.acceptanceChecks=[];proposed=p;const first=await start(),id=first.goal.manifest.id,partial=await approveGoal(project,id,first.goal.proposal!.hash,{...options(),approve:async()=> 'allow'});
  expect(partial.status).toBe('partial');for(const task of p.tasks)await controlExecution(project,partial.goal.state.execution!.runId,'accept',task.id,{store:runs});
  const completed=await resumeGoal(project,id,options());expect(completed.status).toBe('completed');expect(completed.goal.state.status).toBe('partial');expect(requests).toHaveLength(7);
});
it('rejects invalid embedding output caps before creating a goal or allocating its execution',async()=>{
  await expect(startGoal(project,'Toy.',{...options(),maxOutputTokens:NaN})).rejects.toThrow(/cap/);expect(created).toBeUndefined();const first=await start();await expect(approveGoal(project,first.goal.manifest.id,first.goal.proposal!.hash,{...options(),maxOutputTokens:0})).rejects.toThrow(/cap/);expect(goals.read(first.goal.manifest.id).state.execution).toBeNull();
});
