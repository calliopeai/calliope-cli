import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {clearModelCache} from '../src/model-detection.js';
import {RunStore,prepareRun,changePreparedRun,executeReviewedRun,controlExecution,runOrchestrationCommand,analyzePlan,type ProjectPlan} from '../src/orchestration/index.js';
import {projectBudgetPath} from '../src/budget.js';
import {verifiedPlan} from './helpers/coordinator-run.js';
import * as commands from '../src/isolation/process.js';
import type {CommandEvidence} from '../src/isolation/contracts.js';
let root:string,project:string,runs:RunStore,requests:number,exit:number,toolSteps:{name:string;arguments:Record<string,unknown>}[]|undefined;
const image='sha256:'+'a'.repeat(64),json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe'}).toString();
function plan():ProjectPlan {
  const p=verifiedPlan();p.version=3;p.tasks=p.tasks.slice(0,1);p.agents=p.agents.slice(0,2);p.limits.tokenBudget=40000;p.limits.costBudgetUsd=1;p.limits.timeBudgetMs=60000;
  p.workspace.allowedTools.push('shell');p.workspace.isolation={version:1,image};
  for(const a of p.agents){a.allowedTools.push('shell');a.timeBudgetMs=60000;a.tokenBudget=a.parentId?20000:40000;a.costBudgetUsd=a.parentId?0.5:1;a.preference={provider:'deepseek',model:'isolated-toy'};}
  const task=p.tasks[0]!;task.outputs.push({id:'patch',kind:'patch',description:'Candidate diff.'},{id:'tests',kind:'test_result',description:'Actual verification exit.'});
  task.isolation={patchArtifactId:'patch',commands:[{artifactId:'tests',argv:['node','-e',"require('node:assert').ok(require('node:fs').readFileSync('a/report.txt','utf8').includes('public toy'))"],timeoutMs:3000}]};
  task.acceptanceChecks!.push({id:'real-tests',artifactId:'tests',kind:'command',criteria:['task:0','agent:0']});return p;
}
beforeEach(()=>{
  config.resetConfig();saveHooks([]);clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-isolated-run-')));project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.writeFileSync(join(project,'a/seed.txt'),'public fixture');
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('add','.');git('commit','-qm','fixture');runs=new RunStore(join(root,'runs'));requests=0;exit=0;toolSteps=undefined;
  for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of [names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://isolated.invalid/v1'});config.set('routing',{enabled:true,providerPool:['deepseek']});
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
    const req=new Request(input,init);if(req.url==='https://isolated.invalid/v1/models')return json({data:[{id:'isolated-toy',context_length:4096,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}]});
    expect(req.url).toBe('https://isolated.invalid/v1/chat/completions');requests++;const body=await req.json(),count=body.messages.filter((m:any)=>m.role==='tool').length,task=JSON.parse(body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content).task;
    const step=(toolSteps??[{name:'write_file',arguments:{path:task.outputs[0].path,content:task.id==='second'?'public toy different':'public toy candidate'}}])[count],first=!!step;
    expect(body.tools.every((t:any)=>t.function.name!=='shell')).toBe(true);
    return json({id:'toy',object:'chat.completion',model:'isolated-toy',choices:[{index:0,message:{role:'assistant',content:first?'Writing candidate.':JSON.stringify({version:1,summary:'Candidate written.',outputs:[{id:'tests',content:'forged test pass'},{id:'patch',content:'forged patch'}]}),...(first?{tool_calls:[{id:'tool-'+count,type:'function',function:{name:step.name,arguments:JSON.stringify(step.arguments)}}]}:{})},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});
  }));
  vi.spyOn(commands,'runIsolatedCommand').mockImplementation(async(image,command,mounts)=>{
    const source=mounts.find(m=>m.target==='/project/a')?.source??join(mounts[0]!.source,'a');expect(fs.readFileSync(join(source,'report.txt'),'utf8')).toContain('public toy');expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);
    return {version:1,kind:'isolated-command',argv:command.argv,image,exitCode:exit,outcome:exit?'failed':'passed',stdout:'captured test output',stderr:'',truncated:false,durationMs:1,container:'calliope-check-'+randomUUID(),cleanupConfirmed:true};
  });
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
async function reviewed(p=plan()) {fs.writeFileSync(join(project,'plan.json'),JSON.stringify(p));const prepared=await prepareRun(project,'plan.json',{store:runs});return changePreparedRun(project,prepared.run.id,'approved',{store:runs});}
const artifact=(result:any,id:string)=>{const a=result.execution.state.artifacts[id];return fs.readFileSync(join(runs.root,result.runId,'execution','artifacts',a.path),'utf8');};
it('runs real SDK tool parsing into an isolated worktree and accepts only executor-backed tests and diffs',async()=>{
  const v=await reviewed(),result=await executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});
  expect(result,JSON.stringify(result.execution.state)).toMatchObject({status:'completed',exitCode:0});expect(requests).toBe(2);expect(commands.runIsolatedCommand).toHaveBeenCalledOnce();
  expect(JSON.parse(artifact(result,'tests'))).toMatchObject({kind:'isolated-command',outcome:'passed',exitCode:0});expect(artifact(result,'patch')).toContain('+public toy candidate');expect(artifact(result,'report-a')).toBe('public toy candidate');
  expect(Object.values(result.execution.state.artifacts).every(a=>a.location==='run')).toBe(true);expect(git('status','--porcelain')).toBe('?? plan.json\n');
  expect(result.execution.state.tasks['inspect-a']!.output!.testEvidence).toContain('real-tests');
  const lines:string[]=[];expect(await runOrchestrationCommand('run',['replay',v.run.id,'--json'],{cwd:project,store:new RunStore(runs.root),write:line=>lines.push(line)})).toBe(0);expect(requests).toBe(2);expect(JSON.parse(lines[0]!).version).toBe(2);
});
it('records failed commands as failures and retries explicitly in a new workspace under the original deadline',async()=>{
  exit=1;const v=await reviewed(),first=await executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});
  expect(first.status).toBe('failed');expect(first.execution.state.tasks['inspect-a']).toMatchObject({attempts:1,mutations:true});expect(JSON.parse(artifact(first,'tests')).outcome).toBe('failed');
  await controlExecution(project,v.run.id,'retry','inspect-a',{store:runs});exit=0;
  const next=await executeReviewedRun(project,v.run.id,{store:runs,resume:true,approve:async()=> 'allow'});expect(next.status).toBe('completed');expect(next.execution.header.deadline).toBe(first.execution.header.deadline);expect(requests).toBe(4);
  expect(fs.existsSync(join(runs.root,v.run.id,'execution','worker-inspect-a-1','files','a/report.txt'))).toBe(true);expect(fs.existsSync(join(runs.root,v.run.id,'execution','worker-inspect-a-2','files','a/report.txt'))).toBe(true);
});
it('keeps noninteractive command defaults closed and honors command denial after a permitted isolated edit',async()=>{
  const v=await reviewed(),result=await executeReviewedRun(project,v.run.id,{store:runs,approve:async decision=>decision.request?.tool==='shell'?'reject':'allow'});
  expect(result.status).toBe('denied');expect(commands.runIsolatedCommand).not.toHaveBeenCalled();expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);
});
it('retains a cancellation receipt without executing later checks or claiming completion',async()=>{
  const controller=new AbortController();vi.mocked(commands.runIsolatedCommand).mockImplementation(async(image,command)=>{controller.abort();return {version:1,kind:'isolated-command',argv:command.argv,image,exitCode:130,outcome:'cancelled',stdout:'partial',stderr:'',truncated:false,durationMs:1,container:'calliope-check-'+randomUUID(),cleanupConfirmed:true};});
  const v=await reviewed(),result=await executeReviewedRun(project,v.run.id,{store:runs,signal:controller.signal,approve:async()=> 'allow'});
  expect(result.status).toBe('cancelled');expect(JSON.parse(artifact(result,'tests')).outcome).toBe('cancelled');expect(result.execution.state.tasks['inspect-a']!.output!.testEvidence).toEqual([]);
});
it('rejects malformed plans and unbacked test checks before provider requests',()=>{
  for(const mutate of [
    (p:ProjectPlan)=>{p.workspace.isolation!.image='node:latest';},
    (p:ProjectPlan)=>{p.tasks[0]!.isolation!.commands[0]!.timeoutMs=60001;},
    (p:ProjectPlan)=>{p.tasks[0]!.isolation!.commands[0]!.artifactId='missing';},
    (p:ProjectPlan)=>{p.tasks[0]!.acceptanceChecks!.pop();},
    (p:ProjectPlan)=>{p.agents[1]!.allowedTools=p.agents[1]!.allowedTools.filter(t=>t!=='shell');},
    (p:ProjectPlan)=>{p.tasks[0]!.isolation!.patchArtifactId='tests';},
    (p:ProjectPlan)=>{p.tasks[0]!.isolation!.commands[0]!.argv=['node','line\nbreak'];},
    (p:ProjectPlan)=>{p.tasks[0]!.acceptanceChecks![1]!.expected='0';},
  ]){const p=plan();mutate(p);expect(()=>analyzePlan(p)).toThrow();}expect(requests).toBe(0);
});
it('maps reads, listings and edits into the same guarded workspace',async()=>{
  const p=plan();for(const a of p.agents)a.allowedTools.push('edit_file','list_files');p.workspace.allowedTools.push('edit_file','list_files');
  toolSteps=[{name:'read_file',arguments:{path:'a/seed.txt'}},{name:'list_files',arguments:{path:'a',recursive:true}},{name:'write_file',arguments:{path:'a/report.txt',content:'public toy old'}},{name:'edit_file',arguments:{path:'a/report.txt',old_string:'old',new_string:'candidate'}}];
  const v=await reviewed(p),result=await executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});expect(result.status).toBe('completed');expect(requests).toBe(5);expect(artifact(result,'report-a')).toBe('public toy candidate');expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);
});
it('does not certify a workspace changed during a successful process',async()=>{
  const execute=vi.mocked(commands.runIsolatedCommand).getMockImplementation()!;
  vi.mocked(commands.runIsolatedCommand).mockImplementation(async(...args)=>{const result=await execute(...args);fs.writeFileSync(join(args[2][1]!.source,'report.txt'),'public toy changed after test');return result;});
  const v=await reviewed(),result=await executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});expect(result.status).toBe('failed');
  const receipt=JSON.parse(artifact(result,'tests'));expect(receipt.exitCode).toBe(0);expect(receipt.outcome).toBe('failed');expect(receipt.workspace.before).not.toBe(receipt.workspace.after);
});
function withConsumer(p:ProjectPlan):ProjectPlan {
  const task=structuredClone(p.tasks[0]!);task.id='consume';task.agentId='coordinator';task.dependencies=['inspect-a'];task.inputs=[{id:'report',kind:'artifact',value:'report-a'}];
  task.outputs=[{id:'final',kind:'file',path:'a/final.txt',description:'Combined evidence.'},{id:'final-patch',kind:'patch',description:'Candidate diff.'},{id:'final-tests',kind:'test_result',description:'Process result.'}];
  task.isolation!.patchArtifactId='final-patch';task.isolation!.commands[0]!.artifactId='final-tests';task.acceptanceChecks![0]!.artifactId='final';task.acceptanceChecks![1]!.artifactId='final-tests';p.tasks.push(task);return p;
}
it('copies immutable dependency artifacts into the consumer workspace with their source provenance',async()=>{
  const v=await reviewed(withConsumer(plan())),result=await executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});
  expect(result,JSON.stringify(result.execution.state)).toMatchObject({status:'completed',exitCode:0});expect(requests).toBe(4);expect(artifact(result,'final')).toBe('public toy candidate');
  const worker=join(runs.root,v.run.id,'execution','worker-consume-1','files');expect(fs.readFileSync(join(worker,'a/report.txt'),'utf8')).toBe(artifact(result,'report-a'));expect(fs.existsSync(join(project,'a/final.txt'))).toBe(false);
});
it('stops when dependency artifacts disagree on a path, without requesting a consumer model turn',async()=>{
  const p=withConsumer(plan()),agent=structuredClone(p.agents[1]!);p.agents[1]!.tokenBudget=10000;agent.id='b';agent.tokenBudget=10000;p.agents.push(agent);
  const second=structuredClone(p.tasks[0]!);second.id='second';second.agentId='b';second.outputs[0]!.id='report-b';second.outputs[1]!.id='patch-b';second.outputs[2]!.id='tests-b';second.isolation!.patchArtifactId='patch-b';second.isolation!.commands[0]!.artifactId='tests-b';second.acceptanceChecks![0]!.artifactId='report-b';second.acceptanceChecks![1]!.artifactId='tests-b';p.tasks.push(second);
  p.tasks[1]!.dependencies.push('second');p.tasks[1]!.inputs.push({id:'other',kind:'artifact',value:'report-b'});
  const v=await reviewed(p),result=await executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});expect(result.status).toBe('partial');expect(result.execution.state.tasks.consume!.output!.summary).toContain('disagree');expect(requests).toBe(4);
});
it('binds every command check to the final candidate, even when content changes between commands',async()=>{
  const p=plan(),task=p.tasks[0]!;task.outputs.push({id:'again',kind:'test_result',description:'Second check.'});task.isolation!.commands.push({...task.isolation!.commands[0]!,artifactId:'again'});task.acceptanceChecks!.push({id:'again',artifactId:'again',kind:'command',criteria:['task:0','agent:0']});
  const v=await reviewed(p),result=await executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow',onEvent:event=>{if(event.change.type==='artifact'&&event.change.artifact.id==='tests')fs.writeFileSync(join(runs.root,v.run.id,'execution','worker-inspect-a-1','files','a/report.txt'),'public toy replaced between checks');}});
  expect(result.status).toBe('failed');expect(result.execution.state.tasks['inspect-a']!.output!.testEvidence).not.toContain('real-tests');expect(result.execution.state.tasks['inspect-a']!.output!.testEvidence).toContain('again');
});
it('denies case variants of Git metadata before a worker can redirect its repository identity',async()=>{
  const p=plan();p.agents[1]!.allowedPaths=[{path:'.',access:'write'}];toolSteps=[{name:'write_file',arguments:{path:'.GIT',content:'gitdir: elsewhere'}}];
  const v=await reviewed(p),result=await executeReviewedRun(project,v.run.id,{store:runs,approve:async()=> 'allow'});expect(result.status).toBe('denied');expect(commands.runIsolatedCommand).not.toHaveBeenCalled();expect(fs.readFileSync(join(runs.root,v.run.id,'execution','worker-inspect-a-1','files','.git'),'utf8')).toMatch(/^gitdir: /);
});
