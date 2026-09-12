import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {clearModelCache} from '../src/model-detection.js';
import {executeReviewedRun,prepareRun,changePreparedRun,prepareAgentExecution,controlExecution,inspectExecution,runOrchestrationCommand,agentPreference,RunStore,ExecutionStore,type ProjectPlan} from '../src/orchestration/index.js';
import {verifiedPlan} from './helpers/coordinator-run.js';
import {projectBudgetPath} from '../src/budget.js';
import {inspectSpawn,admitSpawn,executeSpawn,spawnCommand,type SpawnInput} from '../src/spawning/index.js';
vi.setConfig({testTimeout:20000}); // Durable multi-agent runs include fsync and instrumented SDK calls; deadline tests retain their own explicit clocks.
let root:string,project:string,runs:RunStore,requests:any[],respond:(task:any,body:any,signal:AbortSignal)=>Promise<Response>;
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
function reply(task:any,body:any) {
  const first=!body.messages.some((m:any)=>m.role==='tool');
  return json({id:'toy',object:'chat.completion',model:'coordinator-toy',choices:[{index:0,message:{role:'assistant',content:first?'Writing evidence.':'Recorded public toy artifact.',...(first?{tool_calls:[{id:'call-'+task.id,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:task.outputs[0].path,content:'public toy artifact for '+task.id})}}]}:{})},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});
}
beforeEach(()=>{
  config.resetConfig();saveHooks([]);clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-coordinator-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.mkdirSync(join(project,'b'));runs=new RunStore(join(root,'runs'));requests=[];
  for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of[names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://coordinator.invalid/v1'});config.set('routing',{enabled:true,providerPool:['deepseek']});respond=async(task,body)=>reply(task,body);
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{const req=new Request(input,init);if(new URL(req.url).pathname==='/v1/models')return json({data:[{id:'coordinator-toy',context_length:4096,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}]});
    expect(req.url).toBe('https://coordinator.invalid/v1/chat/completions');const body=await req.json();expect(body.max_tokens).toBeLessThanOrEqual(100);const context=body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{'));const task=JSON.parse(context.content).task;requests.push({task:task.id,body});return respond(task,body,init?.signal??req.signal);
  }));
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
const plan=()=>{const p=verifiedPlan();p.limits.tokenBudget=30000;p.limits.costBudgetUsd=1;for(const a of p.agents){a.tokenBudget=a.parentId?10000:30000;a.costBudgetUsd=a.parentId?0.2:1;a.preference={provider:'deepseek',model:'coordinator-toy'};}return p;};
const reviewed=async(p:ProjectPlan=plan())=>{fs.writeFileSync(join(project,'plan.json'),JSON.stringify(p));const v=await prepareRun(project,'plan.json',{store:runs});return changePreparedRun(project,v.run.id,'approved',{store:runs});};
const spawnPlan=()=>{const p=plan();p.limits.maxConcurrent=3;p.limits.tokenBudget=p.agents[0]!.tokenBudget=40000;p.limits.timeBudgetMs=120000;for(const a of p.agents)a.timeBudgetMs=a.parentId?60000:120000;return p;};
function childInput(p:ProjectPlan):SpawnInput {
  const agent=structuredClone(p.agents[1]!),task=structuredClone(p.tasks[0]!);agent.id='c';agent.allowedPaths=[{path:'c',access:'write'}];task.id='inspect-c';task.agentId='c';task.outputs[0]!.id='report-c';task.outputs[0]!.path='c/report.txt';task.acceptanceChecks![0]!.artifactId='report-c';
  fs.mkdirSync(join(project,'c'));const input:SpawnInput={version:1,parentId:'coordinator',agents:[agent],tasks:[task]};fs.writeFileSync(join(project,'children.json'),JSON.stringify(input));return input;
}
it('adopts approved children while independent workers are still running and verifies all added artifacts',async()=>{
  const p=spawnPlan(),v=await reviewed(p);childInput(p);
  let release!:()=>void,started!:()=>void,childStarted!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;}),childBegan=new Promise<void>(resolve=>{childStarted=resolve;});
  respond=async(task,body)=>{if(task.id==='inspect-a'){started();await held;}if(task.id==='inspect-c')childStarted();return reply(task,body);};
  const running=executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});await began;
  const preview=await inspectSpawn(project,v.run.id,'children.json',{store:runs}),accepted=await admitSpawn(project,v.run.id,preview.proposal,preview.proposal.hash,{store:runs});
  try{await childBegan;expect(requests.some(r=>r.task==='inspect-c')).toBe(true);}finally{release();}
  const [result,child]=await Promise.all([running,executeSpawn(project,accepted.admission,{store:runs})]);expect(result.status).toBe('completed');expect(child.status).toBe('completed');expect(result.execution.state.tasks['inspect-c']!.output!.testEvidence).toEqual(['output-check']);expect(requests).toHaveLength(8);
  expect(result.execution.state.graph!.admissions).toHaveLength(1);expect(result.execution.events.filter(e=>e.change.type==='graph_admitted')).toHaveLength(1);expect(result.execution.header.deadline).toBe(preview.deadline);
  const lines:string[]=[];await runOrchestrationCommand('agents',['--tree','--run',v.run.id,'--json'],{cwd:project,store:runs,write:line=>lines.push(line)});expect(JSON.parse(lines[0]!).data.agents.map((a:any)=>a.id)).toContain('c');
},20000);
it('cancels a waiting spawned subtree, retains its charged request, and permits a bounded explicit retry',async()=>{
  const p=spawnPlan(),v=await reviewed(p);childInput(p);
  let ready!:()=>void,release!:()=>void,childReady!:()=>void;const began=new Promise<void>(r=>{ready=r;}),held=new Promise<void>(r=>{release=r;}),childBegan=new Promise<void>(r=>{childReady=r;});
  respond=async(task,body,signal)=>{if(task.id==='inspect-a'){ready();await held;}if(task.id==='inspect-c'){childReady();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}return reply(task,body);};
  const running=executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});await began;const preview=await inspectSpawn(project,v.run.id,'children.json',{store:runs}),accepted=await admitSpawn(project,v.run.id,preview.proposal,preview.proposal.hash,{store:runs}),controller=new AbortController();
  const waiting=executeSpawn(project,accepted.admission,{store:runs,signal:controller.signal});const cancelled=expect(waiting).rejects.toMatchObject({name:'AbortError'});await childBegan;controller.abort();await cancelled;release();const first=await running;
  expect(first.status).toBe('partial');expect(first.execution.state.tasks['inspect-c']!.status).toBe('cancelled');expect(first.execution.state.tasks['inspect-a']!.status).toBe('completed');
  const authority=await prepareAgentExecution(project,v.run.id,'c',100,{store:runs}),before=authority.ledger.read(project);expect(Object.values(before.projection.requests).some(r=>r.reservation.agentId==='c'&&r.state==='unknown')).toBe(true);
  await controlExecution(project,v.run.id,'agent-retry','c',{store:runs});respond=async(task,body)=>reply(task,body);const second=await executeReviewedRun(project,v.run.id,{store:runs,resume:true,approve:async()=> 'allow'});expect(second.status,JSON.stringify({tasks:second.execution.state.tasks,events:second.execution.events.slice(-8)})).toBe('completed');expect(second.execution.header).toEqual(first.execution.header);expect(second.execution.state.tasks['inspect-c']!.attempts).toBe(2);expect(authority.ledger.read(project).projection.childGrants).toEqual(before.projection.childGrants);
},20000);
it('requires a reviewed child hash in headless mode and emits actual execution results after approval',async()=>{
  const p=spawnPlan(),v=await reviewed(p);childInput(p);const authority=await prepareAgentExecution(project,v.run.id,'coordinator',100,{store:runs}),budget=authority.ledger.read(project).manifest,store=new ExecutionStore(join(runs.root,v.run.id),v.manifest);
  store.create({version:1,runId:v.run.id,manifestHash:v.manifest.hash,approvalRevision:v.run.revision,createdAt:new Date(budget.createdAt).toISOString(),deadline:budget.deadline});const lines:string[]=[],options={cwd:project,store:runs,write:(line:string)=>lines.push(line)};
  expect(await runOrchestrationCommand('agents',['spawn','children.json','--run',v.run.id,'--json'],options)).toBe(5);expect(requests).toEqual([]);const hash=JSON.parse(lines[0]!).data.proposal.hash;
  lines.length=0;expect(await runOrchestrationCommand('agents',['spawn','children.json','--run',v.run.id,'--approve',hash,'--allow-mutations','--json'],options)).toBe(0);const rows=lines.map(line=>JSON.parse(line));expect(rows.every(row=>row.version===1)).toBe(true);expect(rows.at(-1).data.status).toBe('completed');expect(rows.at(-1).data.execution.state.tasks['inspect-c'].output.testEvidence).toEqual(['output-check']);expect(requests).toHaveLength(8);
  lines.length=0;expect(await spawnCommand(['spawn','--resume',hash,'--run',v.run.id,'--json'],options)).toBe(0);expect(requests).toHaveLength(8);
},20000);
it('executes independent agents in parallel, verifies their artifacts, and only then runs dependencies',async()=>{
  const view=await reviewed(),started=new Set<string>();let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  respond=async(task,body)=>{if(['inspect-a','inspect-b'].includes(task.id)&&!body.messages.some((m:any)=>m.role==='tool')){started.add(task.id);if(started.size===2)release();await held;}if(task.id==='verify')expect(fs.existsSync(join(project,'a/report.txt'))&&fs.existsSync(join(project,'b/report.txt'))).toBe(true);return reply(task,body);};
  const events:any[]=[];const result=await executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow',onEvent:e=>events.push(e)});
  expect(result).toMatchObject({version:2,status:'completed',exitCode:0});expect(requests).toHaveLength(6);expect(started.size).toBe(2);
  expect(Object.values(result.execution.state.tasks).every(t=>t.status==='completed'&&t.output?.testEvidence[0]==='output-check')).toBe(true);
  expect(events.filter(e=>e.change.type==='artifact')).toHaveLength(3);expect(events.at(-1).change).toMatchObject({type:'finished',status:'completed'});
  expect(events.filter(e=>e.change.type==='agent_started')).toHaveLength(3);expect(events.filter(e=>e.change.type==='agent_finished')).toHaveLength(3);
  const store=new ExecutionStore(join(runs.root,view.run.id),view.manifest);expect(store.owner()).toBeNull();expect(store.read()).toEqual(result.execution);
  await expect(executeReviewedRun(project,view.run.id,{store:runs})).rejects.toThrow(/history/);
});
it('inherits the nearest provider/model choice without attaching a different provider model',()=>{
  const p=plan();p.agents[1]!.preference={provider:'auto'};expect(agentPreference(p,'a')).toEqual({provider:'deepseek',model:'coordinator-toy'});
  p.agents[1]!.preference={provider:'auto',model:'toy-child'};expect(agentPreference(p,'a')).toEqual({provider:'deepseek',model:'toy-child'});
  p.agents[1]!.preference={provider:'google'};expect(agentPreference(p,'a')).toEqual({provider:'google'});
  p.agents[1]!.preference={provider:'auto'};p.agents[0]!.preference={provider:'auto'};expect(agentPreference(p,'a')).toEqual({});
});
it('serializes overlapping write grants even when tasks have no dependencies',async()=>{
  const p=plan();p.agents[2]!.allowedPaths.push({path:'a',access:'write'});const view=await reviewed(p);let aFinished=false;
  respond=async(task,body)=>{if(task.id==='inspect-b')expect(aFinished).toBe(true);return reply(task,body);};
  const result=await executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow',onEvent:e=>{if(e.change.type==='task_finished'&&e.change.taskId==='inspect-a')aFinished=true;}});
  expect(result.status).toBe('completed');expect(requests.map(r=>r.task)).toEqual(['inspect-a','inspect-a','inspect-b','inspect-b','verify','verify']);
});
it('retries a failed provider attempt only within original limits and records escalation after exhaustion',async()=>{
  const view=await reviewed();respond=async()=>new Response(JSON.stringify({error:{message:'synthetic provider failure',type:'invalid_request_error'}}),{status:400,headers:{'content-type':'application/json'}});
  const result=await executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow'});
  expect(result.status).toBe('failed');expect(requests.length).toBeLessThanOrEqual(4);
  for(const id of ['inspect-a','inspect-b'])expect(result.execution.state.tasks[id]).toMatchObject({status:'failed',attempts:2,escalation:'parent'});
  expect(result.execution.state.tasks.verify!.attempts).toBe(0);expect(result.execution.events.filter(e=>e.change.type==='escalated')).toHaveLength(2);
});
it('does not automatically retry an unsuccessful mutation and honors stop escalation',async()=>{
  const p=plan();p.limits.maxConcurrent=1;p.agents[1]!.escalationPolicy.onFailure='stop';p.tasks[0]!.acceptanceChecks![0]!.expected='absent evidence';const view=await reviewed(p);
  const result=await executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow'});
  expect(result).toMatchObject({status:'failed',exitCode:1});expect(result.execution.state.tasks['inspect-a']).toMatchObject({attempts:1,mutations:true,escalation:'stop'});expect(requests).toHaveLength(2);expect(result.execution.state.tasks['inspect-b']!.attempts).toBe(0);
});
it('detects artifact changes made after collection before recording completion',async()=>{
  const view=await reviewed();const result=await executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow',onEvent:event=>{if(event.change.type==='artifact'&&event.change.artifact.taskId==='inspect-a')fs.writeFileSync(join(project,event.change.artifact.path),'changed after collection');}});
  expect(result.status).toBe('partial');expect(result.execution.state.tasks['inspect-a']).toMatchObject({status:'failed',attempts:1});expect(result.execution.state.tasks.verify!.attempts).toBe(0);
});
it('keeps the run ID and original deadline on resume and requires an explicit reset for unknown work',async()=>{
  const view=await reviewed(),authority=await prepareAgentExecution(project,view.run.id,'coordinator',100,{store:runs}),budget=authority.ledger.read(project).manifest,store=new ExecutionStore(join(runs.root,view.run.id),view.manifest);
  store.create({version:1,runId:view.run.id,manifestHash:view.manifest.hash,approvalRevision:view.run.revision,createdAt:new Date(budget.createdAt).toISOString(),deadline:budget.deadline});
  await store.append({type:'started',ownerId:randomUUID()});await store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:'orphan-session'});
  const first=await executeReviewedRun(project,view.run.id,{store:runs,resume:true,approve:async()=> 'allow'});expect(first.status).toBe('partial');expect(first.execution.state.tasks['inspect-a']).toMatchObject({status:'unknown',attempts:1,escalation:'parent'});expect(requests.map(r=>r.task)).toEqual(['inspect-b','inspect-b']);
  await controlExecution(project,view.run.id,'retry','inspect-a',{store:runs});const second=await executeReviewedRun(project,view.run.id,{store:runs,resume:true,approve:async()=> 'allow'});
  expect(second.status).toBe('completed');expect(second.runId).toBe(view.run.id);expect(second.execution.header).toEqual(first.execution.header);expect(second.execution.state.tasks['inspect-a']!.attempts).toBe(2);expect(second.execution.state.tasks['inspect-b']!.attempts).toBe(1);
});
it('records human acceptance only against unchanged artifacts and reviewable criteria',async()=>{
  const p=plan();for(const task of p.tasks)task.acceptanceChecks=[];const view=await reviewed(p);await executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow'});
  const file=join(project,'a/report.txt'),before=fs.readFileSync(file);fs.writeFileSync(file,'changed');await expect(controlExecution(project,view.run.id,'accept','inspect-a',{store:runs})).rejects.toThrow(/changed/);fs.writeFileSync(file,before);
  await expect(controlExecution(project,view.run.id,'accept','inspect-a',{store:runs,confirmation:'mutating'})).rejects.toThrow(/policy/);
  const decisions:any[]=[];for(const task of p.tasks)await controlExecution(project,view.run.id,'accept',task.id,{store:runs,confirmation:'mutating',approve:async decision=>{decisions.push(decision);return 'allow';}});
  const state=(await inspectExecution(project,view.run.id,{store:runs})).execution!.state;expect(state.status).toBe('completed');expect(decisions).toHaveLength(3);expect(state.tasks['inspect-a']!.output!.unresolvedRisks).toEqual([]);
  await expect(controlExecution(project,view.run.id,'accept','inspect-a',{store:runs})).rejects.toThrow(/awaiting/);
});
it('cancels a stopped agent while letting independent work finish and permits a bounded manual retry',async()=>{
  const view=await reviewed();let ready!:()=>void;const began=new Promise<void>(resolve=>{ready=resolve;});
  respond=async(task,body,signal)=>{if(task.id==='inspect-a'){ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}return reply(task,body);};
  const running=executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow'});await began;await controlExecution(project,view.run.id,'agent-stop','a',{store:runs});const result=await running;expect(result.status).toBe('partial');expect(result.execution.state.tasks['inspect-a']!.status).toBe('cancelled');expect(result.execution.state.tasks['inspect-b']!.status).toBe('completed');
  await controlExecution(project,view.run.id,'agent-retry','a',{store:runs});respond=async(task,body)=>reply(task,body);expect((await executeReviewedRun(project,view.run.id,{store:runs,resume:true,approve:async()=> 'allow'})).status).toBe('completed');
});
it('enforces child deadlines and leaves their unknown requests charged',async()=>{
  const p=plan();p.agents[1]!.timeBudgetMs=300;p.agents[2]!.timeBudgetMs=300;const view=await reviewed(p);
  respond=async(_task,_body,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  const result=await executeReviewedRun(project,view.run.id,{store:runs});expect(result).toMatchObject({status:'denied',exitCode:3});expect(requests.length).toBeLessThanOrEqual(2);expect(result.execution.state.tasks.verify!.attempts).toBe(0);
});
it('reports deadline denial when child admission expires before its start event',async()=>{
  const p=plan();p.agents[1]!.timeBudgetMs=300;p.agents[2]!.timeBudgetMs=300;const view=await reviewed(p);
  vi.useFakeTimers({toFake:['Date']});
  try {
    const result=await executeReviewedRun(project,view.run.id,{store:runs,onEvent:event=>{
      if(event.change.type==='started')vi.setSystemTime(Date.now()+1000);
    }});
    expect(result).toMatchObject({status:'denied',exitCode:3});
    expect(requests).toHaveLength(0);
    expect(result.execution.events.some(event=>event.change.type==='task_started')).toBe(false);
    expect(result.execution.state.ownerId).toBeNull();
  }finally{vi.useRealTimers();}
});
it('dismisses a stopped child approval without approving its write or stopping its sibling',async()=>{
  const view=await reviewed();let ready!:()=>void,approvalSignal:AbortSignal|undefined;const began=new Promise<void>(resolve=>{ready=resolve;});
  const running=executeReviewedRun(project,view.run.id,{store:runs,approve:async(decision,signal)=>{
    if(JSON.stringify(decision.request).includes('a/report.txt')){approvalSignal=signal;ready();return new Promise(resolve=>signal!.addEventListener('abort',()=>resolve('cancelled'),{once:true}));}return 'allow';
  }});
  await began;await controlExecution(project,view.run.id,'agent-stop','a',{store:runs});const result=await running;
  expect(approvalSignal?.aborted).toBe(true);expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);expect(result.execution.state.tasks['inspect-a']!.status).toBe('cancelled');expect(result.execution.state.tasks['inspect-b']!.status).toBe('completed');expect(result.exitCode).toBe(4);
});
it('executes plan commands with versioned JSON events and replays without provider calls',async()=>{
  const p=plan();fs.writeFileSync(join(project,'plan.json'),JSON.stringify(p));const lines:string[]=[],options={cwd:project,store:runs,write:(line:string)=>lines.push(line)};
  expect(await runOrchestrationCommand('run',['plan.json','--allow-mutations','--max-output-tokens','90','--json'],options)).toBe(0);
  const records=lines.map(line=>JSON.parse(line));expect(records.every(r=>r.version===2)).toBe(true);const result=records.at(-1).data,id=result.runId;expect(result.status).toBe('completed');expect(requests.every(r=>r.body.max_tokens===90)).toBe(true);
  const emitted=records.filter(r=>r.type==='orchestration.event');expect(emitted.map(r=>r.event)).toEqual(result.execution.events);expect(new Set(emitted.map(r=>r.event.id)).size).toBe(emitted.length);
  const count=requests.length;for(const [ns,args]of [['run',['replay',id]],['run',['status']],['run',['--json']],['agents',['--tree','--run',id]],['tasks',['graph',id]]] as const){lines.length=0;expect(await runOrchestrationCommand(ns,[...args,'--json'],options)).toBe(0);expect(JSON.parse(lines[0]!).version).toBe(2);}expect(requests).toHaveLength(count);
});
it('returns stable command errors, safe mutation defaults and permission-aware cancellation',async()=>{
  const view=await reviewed(),lines:string[]=[],options={cwd:project,store:runs,write:(line:string)=>lines.push(line)};
  for(const args of [['execute'],['execute',view.run.id,'--max-output-tokens','0'],['accept',view.run.id],['status',view.run.id,'--allow-mutations'],['execute',view.run.id,'--tree']]){lines.length=0;expect(await runOrchestrationCommand('run',[...args,'--json'],options)).toBe(2);expect(JSON.parse(lines.at(-1)!).error.code).toBe('invalid');}
  expect(await runOrchestrationCommand('run',['execute',view.run.id,'--json'],options)).toBe(3);expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);
  lines.length=0;expect(await runOrchestrationCommand('run',['cancel',view.run.id,'--json'],options)).toBe(0);expect(JSON.parse(lines[0]!).data.status).toBe('cancellation-requested');
  expect(await runOrchestrationCommand('run',['resume',view.run.id,'--json'],options)).toBe(3);
  expect(await runOrchestrationCommand('run',['resume',view.run.id,'--json'],{...options,signal:AbortSignal.abort()})).toBe(130);
});
it('never interprets unverified prose as completed acceptance',async()=>{
  const p=plan();for(const task of p.tasks)task.acceptanceChecks=[];const view=await reviewed(p),result=await executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow'});
  expect(result.status).toBe('partial');expect(result.exitCode).toBe(4);expect(Object.values(result.execution.state.tasks).every(t=>t.status==='review_required')).toBe(true);
  expect(Object.values(result.execution.state.tasks).every(t=>t.output?.status==='partial'&&t.output.testEvidence.length===0)).toBe(true);
});
it('denies non-interactive mutations and never lets plan approval bypass project policy',async()=>{
  const view=await reviewed(),result=await executeReviewedRun(project,view.run.id,{store:runs});expect(result.status).toBe('denied');expect(result.exitCode).toBe(3);expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);expect(requests.length).toBe(2);
  const next=await reviewed();config.set('policy',{command:'exit 17'});await expect(executeReviewedRun(project,next.run.id,{store:runs,approve:async()=> 'allow'})).rejects.toThrow(/policy/);expect(requests.length).toBe(2);
});
it('cancels every active provider call, waits for cleanup and retains unknown request spend',async()=>{
  const view=await reviewed(),signals:AbortSignal[]=[];let ready!:()=>void;const began=new Promise<void>(resolve=>{ready=resolve;});
  respond=async(_task,_body,signal)=>{signals.push(signal);if(signals.length===2)ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const controller=new AbortController(),running=executeReviewedRun(project,view.run.id,{store:runs,signal:controller.signal,approve:async()=> 'allow'});await began;controller.abort();const result=await running;
  expect(result.status).toBe('cancelled');expect(result.exitCode).toBe(130);expect(signals.every(s=>s.aborted)).toBe(true);expect(result.execution.state.tasks['inspect-a']!.status).toBe('cancelled');expect(result.execution.state.tasks['inspect-b']!.status).toBe('cancelled');
  const {ReservationLedger}=await import('../src/execution/index.js');expect(new ReservationLedger(join(runs.root,view.run.id,'budget')).read(project).projection.spent.tokens).toBe(8392);
});
it('propagates approval revocation from another command to active agents',async()=>{
  const view=await reviewed();let ready!:()=>void;const began=new Promise<void>(resolve=>{ready=resolve;});respond=async(_task,_body,signal)=>{ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const running=executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow'});await began;await changePreparedRun(project,view.run.id,'cancelled',{store:runs});expect((await running).status).toBe('cancelled');expect(requests.length).toBeLessThanOrEqual(2);
});
