import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {clearModelCache} from '../src/model-detection.js';
import {projectBudgetPath} from '../src/budget.js';
import {ReservationLedger} from '../src/execution/index.js';
import {RunStore,ExecutionStore,runOrchestrationCommand,type CoordinatorProgress} from '../src/orchestration/index.js';
import {GoalStore,startGoal,approveGoal,resumeGoal,runGoalCommand,type GoalOptions,type GoalInspection} from '../src/goals/index.js';
import {verifiedPlan} from './helpers/coordinator-run.js';
import {workflowSnapshot} from '../src/ui/workflow-progress.js';
import {handleCommand,type CommandContext} from '../src/ui/commands.js';

let root:string,project:string,runs:RunStore,goals:GoalStore,created:GoalInspection|undefined;
let requests:{provider:string;model:string;context:any}[],progress:CoordinatorProgress[],respond:(context:any,signal:AbortSignal)=>Promise<Response>;
let incompatible:boolean;
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const completion=(outputs:unknown[])=>json({id:'toy',object:'chat.completion',model:'team-toy',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({version:1,summary:'Public toy evidence.',outputs,risks:[]})},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});
function plan(){const p=verifiedPlan();p.workspace.allowedTools=['think'];p.workspace.allowedPaths=[{path:'.',access:'read'}];p.limits.tokenBudget=40000;p.limits.costBudgetUsd=0.07;p.limits.timeBudgetMs=120000;
  for(const agent of p.agents){agent.allowedTools=['think'];agent.allowedPaths=[{path:'.',access:'read'}];agent.tokenBudget=agent.parentId?15000:40000;agent.costBudgetUsd=agent.parentId?0.02:0.07;agent.timeBudgetMs=120000;}
  for(const task of p.tasks)delete task.outputs[0]!.path;return p;
}
function reply(context:any){const task=context.task;
  if(task.id==='draft')return completion([{id:'draft',content:JSON.stringify(plan())}]);
  if(task.id==='propose'){expect(context.dependencyArtifacts[0]).toMatchObject({id:'draft',source:{runId:created!.state.planning?.runId??expect.any(String)}});return completion([{id:'proposal',content:JSON.stringify(plan())},{id:'plan-review',content:'Reviewed the public draft; human approval remains required.'}]);}
  return completion(task.outputs.map((output:any)=>({id:output.id,content:'public toy evidence'})));
}
const options=():GoalOptions=>({store:runs,goals,preference:{provider:'deepseek',model:'controller-toy'},team:{version:1,reviewer:{provider:'groq',model:'reviewer-toy'},workers:{provider:'mistral',model:'worker-toy'},maxAttempts:2},limits:{tokenBudget:60000,costBudgetNanos:100000000,timeBudgetMs:180000,planningTokens:12000,planningCostNanos:20000000,planningTimeMs:60000,maxOutputTokens:100},onCreated:view=>{created=view;},onProgress:view=>progress.push(view)});
beforeEach(()=>{
  config.resetConfig();saveHooks([]);clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-team-runtime-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);runs=new RunStore(join(root,'runs'));goals=new GoalStore(join(root,'goals'));requests=[];progress=[];created=undefined;incompatible=false;respond=async(context)=>reply(context);
  for(const provider of config.getProviderNames()){const env=config.getProviderEnvVars(provider);for(const name of [env.apiKey,env.baseUrl])if(name)vi.stubEnv(name,'');}
  for(const provider of ['deepseek','groq','mistral'] as const)config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:`https://${provider}.invalid/v1`});
  config.set('routing',{enabled:true,providerPool:['deepseek','groq','mistral']});
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{const req=new Request(input,init),url=new URL(req.url),provider=url.hostname.split('.')[0]!;
    expect(['deepseek.invalid','groq.invalid','mistral.invalid']).toContain(url.hostname);
    if(url.pathname==='/v1/models')return json({data:[{id:provider==='deepseek'?'controller-toy':provider==='groq'?'reviewer-toy':'worker-toy',context_length:4096,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:!(incompatible&&provider==='mistral'),streaming:true}}]});
    expect(url.pathname).toBe('/v1/chat/completions');const body=await req.json(),context=JSON.parse(body.messages.find((message:any)=>message.role==='user'&&typeof message.content==='string'&&message.content.startsWith('{')).content);requests.push({provider,model:body.model,context});expect(body.max_tokens).toBeLessThanOrEqual(100);return respond(context,init?.signal??req.signal);
  }));
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});

it('runs a real mixed-provider SDK pipeline, feeds failed-check evidence into bounded retries, and resumes/replays without spending again',async()=>{
  respond=async context=>context.task.id==='inspect-a'&&!context.previousAttempts?completion([{id:'report-a',content:'missing the predicate'}]):reply(context);
  const pending=await startGoal(project,'Inspect the public toy project.',options());expect(pending.status).toBe('review_required');
  expect(requests.map(req=>[req.provider,req.context.task.id])).toEqual([['deepseek','draft'],['groq','propose']]);
  const id=pending.goal.manifest.id,planningId=pending.goal.state.planning!.runId;
  expect(pending.goal.state.planningSpend!.tokens).toBe(20);expect(pending.goal.proposal!.source).toMatchObject({artifactId:'proposal',runId:planningId});
  const planningView=await runs.read(planningId,project),planning=new ExecutionStore(join(runs.root,planningId),planningView.manifest).read();
  expect(planning.state.artifacts['plan-review']!.agentId).toBe('reviewer');expect(planning.state.tasks.draft!.status).toBe('review_required');
  const done=await approveGoal(project,id,pending.goal.proposal!.hash,options());expect(done.status).toBe('completed');
  expect(requests.filter(req=>req.context.task.id.startsWith('inspect')).every(req=>req.provider==='mistral'&&req.model==='worker-toy')).toBe(true);expect(requests.at(-1)).toMatchObject({provider:'deepseek',model:'controller-toy',context:{task:{id:'verify'}}});
  const retried=requests.find(req=>req.context.previousAttempts);expect(retried!.context.previousAttempts[0]).toMatchObject({status:'failed',checks:[{id:'output-check',passed:false}]});
  expect(done.execution!.state.tasks['inspect-a']!.attempts).toBe(2);expect(done.execution!.events.filter(event=>event.change.type==='task_reset')).toHaveLength(1);
  const ledger=new ReservationLedger(join(runs.root,done.goal.state.execution!.runId,'budget')).read(project);expect(Object.keys(ledger.projection.requests)).toHaveLength(4);
  expect(progress.map(workflowSnapshot).some(view=>view.agents.some(agent=>agent.label.includes('mistral:worker-toy')))).toBe(true);expect(workflowSnapshot(progress.at(-1)!).summary).toContain('3/3 done');
  const count=requests.length,lines:string[]=[];expect((await resumeGoal(project,id,{...options(),goals:new GoalStore(goals.root)})).status).toBe('completed');
  expect(await runGoalCommand(['replay',id,'--json'],{...options(),cwd:project,write:line=>lines.push(line)})).toBe(0);expect(JSON.parse(lines.at(-1)!).data.goal.manifest.version).toBe(2);expect(requests).toHaveLength(count);
},30000);
it('stops a read-only task loop at its attempt limit and never starts dependent verification',async()=>{
  respond=async context=>context.task.id==='inspect-a'?completion([{id:'report-a',content:'still missing'}]):reply(context);
  const pending=await startGoal(project,'Public toy loop.',options()),done=await approveGoal(project,pending.goal.manifest.id,pending.goal.proposal!.hash,options());
  expect(done.status).toBe('partial');expect(done.execution!.state.tasks['inspect-a']).toMatchObject({attempts:2,status:'failed',escalation:'parent'});expect(requests.some(req=>req.context.task.id==='verify')).toBe(false);
  const snapshots:CoordinatorProgress[]=[];expect(await runOrchestrationCommand('agents',['stop','a','--run',done.goal.state.execution!.runId,'--json'],{cwd:project,store:runs,onProgress:value=>snapshots.push(value),write:()=>{}})).toBe(0);expect(workflowSnapshot(snapshots.at(-1)!).agents.find(agent=>agent.id==='a')!.label).toContain('stopped');
},30000);
it('denies reviewer writes, retains its original allocation, and does not produce executable authority',async()=>{
  respond=async context=>context.task.id==='propose'?json({id:'toy',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'',tool_calls:[{id:'bad-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'unauthorized.txt',content:'toy'})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:7,completion_tokens:3}}):reply(context);
  await expect(startGoal(project,'Public read-only planning.',options())).rejects.toThrow();const state=goals.read(created!.manifest.id);expect(state.proposal).toBeNull();expect(state.state.execution).toBeNull();expect(state.state.planningFrozen).toBe(true);expect(fs.existsSync(join(project,'unauthorized.txt'))).toBe(false);
},30000);
it('cancels the second controller and retains unknown charges without retrying it',async()=>{
  let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});respond=async(context,signal)=>{if(context.task.id!=='propose')return reply(context);started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const controller=new AbortController(),pending=startGoal(project,'Cancellable public plan.',{...options(),signal:controller.signal}),rejected=expect(pending).rejects.toThrow();await began;controller.abort();await rejected;
  const goal=goals.read(created!.manifest.id),ledger=new ReservationLedger(join(runs.root,goal.state.planning!.runId,'budget')).read(project);expect(goal.state).toMatchObject({status:'cancelled',execution:null,planningFrozen:true});expect(Object.values(ledger.projection.requests).some(request=>request.state==='unknown')).toBe(true);expect(requests).toHaveLength(2);
},30000);
it('rejects incompatible discovered workers before inference and exposes the failure instead of swapping models',async()=>{
  const pending=await startGoal(project,'Public compatibility check.',options());incompatible=true;clearModelCache();const done=await approveGoal(project,pending.goal.manifest.id,pending.goal.proposal!.hash,options());expect(done.status).toBe('failed');expect(requests).toHaveLength(2);
},30000);
it('wires team flags, headless contracts and REPL progress into the same execution path',async()=>{
  const lines:string[]=[],opts=options();delete opts.team;
  expect(await runGoalCommand(['Public toy.','--planner-provider','deepseek','--planner-model','controller-toy','--reviewer-provider','groq','--reviewer-model','reviewer-toy','--worker-provider','mistral','--worker-model','worker-toy','--attempts','2','--json'],{...opts,cwd:project,write:line=>lines.push(line)})).toBe(5);
  const report=JSON.parse(lines.at(-1)!);expect(report.version).toBe(1);expect(report.data.goal.manifest.team).toEqual(options().team);expect(report.data.goal.manifest.preference).toEqual(opts.preference);
  const snapshots:CoordinatorProgress[]=[],messages:string[]=[],context={sessionRef:{current:{projectPath:project}},provider:'deepseek',model:'controller-toy',mode:'work',confirmMode:false,approve:async()=> 'reject',onWorkflowProgress:(value:CoordinatorProgress)=>snapshots.push(value),addMessage:(_type:string,text:string)=>messages.push(text)} as unknown as CommandContext;
  // Policy rejects before provider requests; this proves REPL presentation doesn't grant execution authority.
  await handleCommand('/orchestrate Public goal --reviewer-provider groq --reviewer-model reviewer-toy --worker-provider mistral --worker-model worker-toy --attempts 2 --planning-tokens 12000 --planning-cost 0.02 --max-output-tokens 100',context);
  expect(messages.length).toBeGreaterThan(0);expect(snapshots.some(value=>value.context.plan.agents.some(agent=>agent.id==='reviewer'))).toBe(true);
},30000);

it('refreshes accounted reservations while a worker response is pending without an execution event',async()=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  respond=async context=>{if(context.task.id==='inspect-a')await held;return reply(context);};
  const pending=await startGoal(project,'Inspect public accounting fixture.',options());let observed=false;
  const done=await approveGoal(project,pending.goal.manifest.id,pending.goal.proposal!.hash,{...options(),onProgress:value=>{
    progress.push(value);if(value.execution.state.tasks['inspect-a']?.status==='running'&&requests.some(r=>r.context.task.id==='inspect-a')&&value.accounting?.status==='available'&&value.accounting.accounts.a!.requests.pending===1){observed=true;release();}
  }});
  expect(observed).toBe(true);expect(done.status).toBe('completed');const final=progress.at(-1)!.accounting;
  expect(final).toMatchObject({status:'available',run:{accounted:{tokens:30},requests:{pending:0,settled:3}}});
},30000);
