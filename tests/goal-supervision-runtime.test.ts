import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {clearModelCache} from '../src/model-detection.js';
import {projectBudgetPath} from '../src/budget.js';
import {ReservationLedger} from '../src/execution/index.js';
import {RunStore,ExecutionStore,replayExecution,controlExecution} from '../src/orchestration/index.js';
import {GoalStore,runGoalCommand,resumeGoal,reviseGoal} from '../src/goals/index.js';
import * as commands from '../src/isolation/process.js';
import {workflowSnapshot,workflowLines} from '../src/ui/workflow-progress.js';
import {handleCommand,type CommandContext} from '../src/ui/commands.js';
import {goalImage,goalSupervision,supervisedGoalPlan} from './helpers/supervised-goal.js';
vi.setConfig({testTimeout:20000});
let root:string,project:string,runs:RunStore,goals:GoalStore,requests:any[],lines:string[],exits:number[],proposed:unknown,decide:(context:any,signal:AbortSignal)=>Promise<unknown>;
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe'}).toString();
const keepGoing=(context:any)=>({version:1,action:'continue',reason:'Review recorded executor evidence.',evidence:context.outcomes.map((o:any)=>o.eventId)});
const replan=(context:any)=>({...keepGoing(context),action:'replan',taskId:'inspect-a',hypothesis:'Correct the retained failing case.',expectedMetric:{name:'failed acceptance checks',direction:'decrease'},strategy:'Use the failed verification evidence to repair the boundary case.'});
const flags=()=>['--supervise','--isolation-image',goalImage,'--planner-provider','deepseek','--planner-model','planner-toy','--controller-provider','deepseek','--controller-model','controller-toy','--worker-provider','deepseek','--worker-model','worker-toy','--supervision-reviewer-provider','deepseek','--supervision-reviewer-model','reviewer-toy','--supervision-output-tokens','100','--attempts','2'];
const options=()=>({cwd:project,store:runs,goals,limits:{tokenBudget:100000,costBudgetNanos:200000000,timeBudgetMs:120000,planningTokens:30000,planningCostNanos:50000000,planningTimeMs:60000,maxOutputTokens:100},write:(line:string)=>lines.push(line)});
const start=async()=>{expect(await runGoalCommand(['Public toy goal.',...flags(),'--json'],options()),lines.at(-1)).toBe(5);return goals.list(project).goals.at(-1)!;};
beforeEach(()=>{
  config.resetConfig();saveHooks([]);clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-goal-supervision-runtime-')));project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.writeFileSync(join(project,'a/seed.txt'),'public toy fixture');git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('add','.');git('commit','-qm','fixture');
  runs=new RunStore(join(root,'runs'));goals=new GoalStore(join(root,'goals'));requests=[];lines=[];exits=[0];proposed=supervisedGoalPlan();decide=async context=>keepGoing(context);
  for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of [names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://goal-supervision.invalid/v1'});config.set('routing',{enabled:true,providerPool:['deepseek']});
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
    const req=new Request(input,init);if(req.url==='https://goal-supervision.invalid/v1/models')return json({data:['planner-toy','worker-toy','controller-toy','reviewer-toy'].map(id=>({id,context_length:8192,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}))});
    expect(req.url).toBe('https://goal-supervision.invalid/v1/chat/completions');const body=await req.json(),context=JSON.parse(body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content);requests.push({context,body});let content:string,tool_calls;
    if(context.kind==='controller-review'){expect(body.tools??[]).toEqual([]);content=JSON.stringify(await decide(context,init?.signal??req.signal));}
    else if(context.task.id==='propose'){expect(body.tools.every((t:any)=>['read_file','list_files','think'].includes(t.function.name))).toBe(true);content=JSON.stringify({version:1,summary:'A supervised proposal, pending human review.',outputs:[{id:'proposal',content:JSON.stringify(proposed)}],risks:[]});}
    else {expect(body.tools.some((t:any)=>t.function.name==='shell')).toBe(false);const first=!body.messages.some((m:any)=>m.role==='tool');content=first?'Write candidate.':'Candidate ready for verification.';if(first)tool_calls=[{id:'write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:context.task.outputs[0].path,content:'public toy candidate'})}}];}
    return json({id:'toy',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content,...(tool_calls?{tool_calls}:{})},finish_reason:tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});
  }));
  vi.spyOn(commands,'assertLocalIsolationImage').mockResolvedValue();
  vi.spyOn(commands,'runIsolatedCommand').mockImplementation(async(image,command)=>{const code=exits.shift()??0;return{version:1,kind:'isolated-command',argv:command.argv,image,exitCode:code,outcome:code?'failed':'passed',stdout:'Synthetic process evidence for public toy tests.',stderr:'',truncated:false,durationMs:1,container:'calliope-check-'+randomUUID(),cleanupConfirmed:true};});
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});

it('connects the public CLI through planning, exact approval, isolated retries, both review roles and HUD replay',async()=>{
  exits=[1,0];decide=async context=>context.outcomes[0].status==='failed'?replan(context):keepGoing(context);
  const goal=await start(),id=goal.manifest.id,proposal=goals.read(id).proposal!;expect(goal.manifest.version).toBe(3);expect(requests.map(r=>r.body.model)).toEqual(['planner-toy']);expect(commands.runIsolatedCommand).not.toHaveBeenCalled();
  expect(await runGoalCommand(['approve',id,'b'.repeat(64),'--allow-mutations','--json'],options())).toBe(1);expect(requests).toHaveLength(1);
  const hud:string[]=[];expect(await runGoalCommand(['approve',id,proposal.hash,'--allow-mutations','--json'],{...options(),onProgress:value=>hud.push(...workflowLines([workflowSnapshot(value)],'agents'))}),lines.at(-1)).toBe(0);
  const done=JSON.parse(lines.at(-1)!).data;expect(done.status).toBe('completed');expect(requests.map(r=>r.body.model)).toEqual(['planner-toy','worker-toy','worker-toy','controller-toy','reviewer-toy','worker-toy','worker-toy','controller-toy','reviewer-toy']);
  expect(done.execution.state.tasks['inspect-a'].attempts).toBe(2);expect(done.execution.state.supervision.rounds).toBe(2);expect(hud.some(row=>row.includes('reviewing round'))).toBe(true);expect(hud.some(row=>row.includes('worker-toy'))).toBe(true);expect(hud.some(row=>row.includes('robustness'))).toBe(true);
  const execution=done.goal.state.execution,run=await runs.read(execution.runId,project),saved=new ExecutionStore(join(runs.root,execution.runId),run.manifest).read();expect(replayExecution(saved.header,run.manifest,saved.events)).toEqual(saved.state);
  const ledger=new ReservationLedger(join(runs.root,execution.runId,'budget')).read(project);expect(ledger.manifest.createdAt).toBe(Date.parse(goal.manifest.createdAt));expect(ledger.manifest.deadline).toBe(execution.deadline);
  const count=requests.length;expect((await resumeGoal(project,id,{goals:new GoalStore(goals.root),store:new RunStore(runs.root)})).status).toBe('completed');expect(await runGoalCommand(['replay',id,'--json'],options())).toBe(0);expect(requests).toHaveLength(count);expect(git('status','--porcelain')).toBe('');
  for(const line of lines){const event=JSON.parse(line);expect(event.version).toBe(1);expect(event.type).toMatch(/^orchestration\.goal/);}expect(commands.assertLocalIsolationImage).toHaveBeenCalledTimes(1);
});
it('shows supervision and exact commands before REPL approval and preserves individual permission gates',async()=>{
  const seen:string[]=[];expect(await runGoalCommand(['Public toy goal.',...flags()],{...options(),source:'repl',approve:async decision=>{seen.push(decision.request.tool);if(decision.request.tool==='orchestration_goal_approve'){expect(lines.at(-1)).toContain('controller deepseek:controller-toy');expect(lines.at(-1)).toContain('execution reviewer deepseek:reviewer-toy');expect(lines.at(-1)).toContain('check.js');expect(lines.at(-1)).toContain(goalImage);}return 'allow';}}),lines.at(-1)).toBe(0);
  expect(seen).toContain('orchestration_goal_approve');expect(seen).toContain('write_file');expect(seen).toContain('shell');expect(lines.at(-1)).toContain('completed');
});
it('keeps a missing-image goal resumable without allocating or spending planning budget',async()=>{
  vi.mocked(commands.assertLocalIsolationImage).mockRejectedValueOnce(new Error('Prepare the exact local image.'));
  expect(await runGoalCommand(['Public toy goal.',...flags(),'--json'],options())).toBe(1);expect(fetch).not.toHaveBeenCalled();const goal=goals.list(project).goals[0]!;expect(goal.state.planning).toBeNull();expect(goal.state.status).toBe('created');expect(goals.owner(goal.manifest.id)).toBeNull();
  expect(await runGoalCommand(['resume',goal.manifest.id,'--json'],options()),lines.at(-1)).toBe(5);const resumed=goals.read(goal.manifest.id);expect(resumed.manifest).toEqual(goal.manifest);expect(requests).toHaveLength(1);expect(commands.assertLocalIsolationImage).toHaveBeenCalledTimes(2);
});
it('rejects project policy and pre-cancellation before image admission or provider discovery',async()=>{
  config.set('policy',{command:'exit 17'});expect(await runGoalCommand(['Public toy goal.',...flags(),'--json'],options())).toBe(3);expect(goals.list(project).goals).toHaveLength(0);expect(commands.assertLocalIsolationImage).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  expect(await runGoalCommand(['Public toy goal.',...flags(),'--json'],{...options(),signal:AbortSignal.abort()})).toBe(130);expect(fetch).not.toHaveBeenCalled();
});
it('denies verification independently after plan approval, retaining isolated artifacts and failed scope evidence',async()=>{
  const goal=await start(),id=goal.manifest.id,proposal=goals.read(id).proposal!;
  expect(await runGoalCommand(['approve',id,proposal.hash,'--json'],{...options(),approve:async d=>d.request.tool==='shell'?'reject':'allow'})).toBe(3);expect(commands.runIsolatedCommand).not.toHaveBeenCalled();expect(git('status','--porcelain')).toBe('');expect(JSON.parse(lines.at(-1)!).data.execution.state.tasks['inspect-a'].attempts).toBe(1);
});
it('freezes an unsupervised planner proposal and permits a bounded human correction without more inference',async()=>{
  const malformed=supervisedGoalPlan();malformed.version=3;delete malformed.supervision;proposed=malformed;
  expect(await runGoalCommand(['Public toy goal.',...flags(),'--json'],options())).toBe(2);const goal=goals.list(project).goals[0]!,id=goal.manifest.id;expect(goal.state.planningFrozen).toBe(true);expect(goal.state.status).toBe('failed');
  fs.writeFileSync(join(project,'revision.json'),JSON.stringify(supervisedGoalPlan()));const revised=await reviseGoal(project,id,'revision.json',options());expect(revised.status).toBe('review_required');expect(revised.goal.manifest).toEqual(goal.manifest);expect(requests).toHaveLength(1);
  fs.writeFileSync(join(project,'revision.json'),JSON.stringify(malformed));await expect(reviseGoal(project,id,'revision.json',options())).rejects.toThrow('version 4');expect(goals.read(id).proposal!.hash).toBe(revised.goal.proposal!.hash);
});
it('cancels a controller, retains its request reservation, and resumes under the same goal clock',async()=>{
  const goal=await start(),id=goal.manifest.id;let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});decide=async(_context,signal)=>{ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const abort=new AbortController(),running=runGoalCommand(['approve',id,goals.read(id).proposal!.hash,'--allow-mutations','--json'],{...options(),signal:abort.signal});await started;abort.abort();expect(await running).toBe(130);
  const saved=goals.read(id),allocation=saved.state.execution!,budget=new ReservationLedger(join(runs.root,allocation.runId,'budget')).read(project);expect(Object.values(budget.projection.requests).some(r=>r.reservation.agentId==='coordinator'&&r.state==='unknown')).toBe(true);expect(goals.owner(id)).toBeNull();
  await controlExecution(project,allocation.runId,'controller-retry','coordinator',{store:runs});decide=async context=>keepGoing(context);expect(await runGoalCommand(['resume',id,'--allow-mutations','--json'],options()),lines.at(-1)).toBe(0);expect(goals.read(id).state.execution).toEqual(allocation);expect(goals.read(id).manifest.deadline).toBe(goal.manifest.deadline);
});
it('routes slash-command supervision through the same persisted settings',async()=>{
  const ctx={sessionRef:{current:{projectPath:project}},provider:'deepseek',model:'planner-toy',mode:'work',addMessage:(_role:string,line:string)=>lines.push(line)} as unknown as CommandContext;
  await handleCommand('/orchestrate "Public toy goal." '+flags().join(' ')+' --max-output-tokens 100',ctx);expect(lines.at(-1)).toContain('review_required');const id=/Goal ([a-f0-9-]{36})/.exec(lines.at(-1)!)![1]!;
  expect(new GoalStore().read(id).manifest.supervision).toEqual(goalSupervision());expect(requests.map(r=>r.body.model)).toEqual(['planner-toy']);
});
