import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {clearModelCache} from '../src/model-detection.js';
import {RunStore,ExecutionStore,prepareRun,changePreparedRun,executeReviewedRun,controlExecution,runOrchestrationCommand,replayExecution,type ProjectPlan} from '../src/orchestration/index.js';
import {ReservationLedger} from '../src/execution/index.js';
import {projectBudgetPath} from '../src/budget.js';
import {verifiedPlan} from './helpers/coordinator-run.js';
import * as commands from '../src/isolation/process.js';
import {workflowSnapshot,workflowLines} from '../src/ui/workflow-progress.js';
import {inspectImprovements,proposeImprovement,runImprovement,withdrawImprovement,runImprovementCommand,improvementProposalHash,projectImprovementHistory,improvementFeedback} from '../src/improvement/index.js';
import {reviewEvidence} from '../src/supervision/index.js';
vi.setConfig({testTimeout:20000}); // Multiple real Git worktrees and durable journals per recovery scenario.
let root:string,project:string,runs:RunStore,requests:any[],verificationExits:number[],controllerTool:boolean,decide:(context:any,signal:AbortSignal)=>Promise<unknown>;
const image='sha256:'+'a'.repeat(64),json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe'}).toString();
function plan():ProjectPlan {
  const p=verifiedPlan();p.version=4;p.tasks=p.tasks.slice(0,1);p.agents=p.agents.slice(0,2);p.limits.tokenBudget=100000;p.limits.costBudgetUsd=1;p.limits.timeBudgetMs=60000;
  p.workspace.allowedTools.push('shell');p.workspace.isolation={version:1,image};
  for(const a of p.agents){a.allowedTools.push('shell');a.timeBudgetMs=60000;a.tokenBudget=a.parentId?25000:100000;a.costBudgetUsd=a.parentId?0.25:1;a.preference={provider:'deepseek',model:a.parentId?'worker-toy':'controller-toy'};}
  const task=p.tasks[0]!;task.outputs.push({id:'patch',kind:'patch',description:'Candidate diff.'},{id:'tests',kind:'test_result',description:'Verification result.'});
  task.isolation={patchArtifactId:'patch',commands:[{artifactId:'tests',argv:['node','check.js'],timeoutMs:3000}]};
  task.acceptanceChecks!.push({id:'real-tests',artifactId:'tests',kind:'command',criteria:['task:0','agent:0']});
  p.supervision={version:1,controllerId:'coordinator',maxRounds:4,maxStalledRounds:2,maxOutputTokens:100,principle:'robustness',allowedActions:['retry','replan','decompose']};return p;
}
const keepGoing=(context:any)=>({version:1,action:'continue',reason:'Inspect the executor acceptance checks.',evidence:context.outcomes.map((o:any)=>o.eventId)});
const retry=(context:any,action='replan')=>({...keepGoing(context),action,taskId:'inspect-a',hypothesis:'Correct the failed boundary case.',expectedMetric:{name:'failed acceptance checks',direction:'decrease'},...(action==='replan'?{strategy:'Use the retained failing test and patch to repair the boundary case.'}:{})});
beforeEach(()=>{
  config.resetConfig();saveHooks([]);clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-supervision-')));project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.writeFileSync(join(project,'a/seed.txt'),'public fixture');
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('add','.');git('commit','-qm','fixture');runs=new RunStore(join(root,'runs'));requests=[];verificationExits=[0];controllerTool=false;decide=async context=>keepGoing(context);
  for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of [names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://supervision.invalid/v1'});config.set('routing',{enabled:true,providerPool:['deepseek']});
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
    const req=new Request(input,init);if(req.url==='https://supervision.invalid/v1/models')return json({data:['worker-toy','controller-toy','reviewer-toy'].map(id=>({id,context_length:4096,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}))});
    expect(req.url).toBe('https://supervision.invalid/v1/chat/completions');const body=await req.json(),context=JSON.parse(body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content);requests.push({context,body});
    let content:string,tool_calls;
    if(context.kind==='controller-review'){expect(body.tools??[]).toEqual([]);const decision=await decide(context,init?.signal??req.signal);content=typeof decision==='string'?decision:JSON.stringify(decision);}
    else {
      const first=!body.messages.some((m:any)=>m.role==='tool');content=first?'Writing candidate.':'Candidate ready for independent verification.';
      if(first)tool_calls=[{id:'write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:context.task.outputs[0].path,content:'public toy candidate'})}}];
    }
    if(context.kind==='controller-review'&&controllerTool)tool_calls=[{id:'unauthorized',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'forbidden.txt',content:'must not execute'})}}];
    return json({id:'toy',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content,...(tool_calls?{tool_calls}:{})},finish_reason:tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});
  }));
  vi.spyOn(commands,'runIsolatedCommand').mockImplementation(async(image,command)=>{const exit=verificationExits.shift()??0;return{version:1,kind:'isolated-command',argv:command.argv,image,exitCode:exit,outcome:exit?'failed':'passed',stdout:'retained boundary test evidence',stderr:'',truncated:false,durationMs:1,container:'calliope-check-'+randomUUID(),cleanupConfirmed:true};});
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
async function reviewed(p=plan()){fs.writeFileSync(join(project,'plan.json'),JSON.stringify(p));const view=await prepareRun(project,'plan.json',{store:runs});return changePreparedRun(project,view.run.id,'approved',{store:runs});}
const execute=(id:string,extra={})=>executeReviewedRun(project,id,{store:runs,approve:async()=> 'allow',...extra});

it('reviews actual executor artifacts with distinct controller/reviewer models, updates the HUD and replays without calls',async()=>{
  const p=plan(),reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';
  const view=await reviewed(p),hud:string[]=[];decide=async context=>{expect(context.outcomes[0].artifacts.find((a:any)=>a.id==='tests').excerpt).toContain('"cleanupConfirmed":true');expect(context.outcomes[0].artifacts.find((a:any)=>a.id==='patch').excerpt).toContain('+public toy candidate');if(context.role==='reviewer')expect(context.draft.action).toBe('continue');return keepGoing(context);};
  const result=await execute(view.run.id,{onProgress:(value:any)=>hud.push(...workflowLines([workflowSnapshot(value)],'agents'))});
  expect(result.status,JSON.stringify(result.execution.state.supervision)).toBe('completed');expect(requests.map(r=>r.body.model)).toEqual(['worker-toy','worker-toy','controller-toy','reviewer-toy']);
  expect(result.execution.state).toMatchObject({version:3,supervision:{rounds:1,phase:'ready'}});expect(hud.some(row=>row.includes('reviewing round 1'))).toBe(true);
  const events=result.execution.events;expect(events.findIndex(e=>e.change.type==='supervision_started')).toBeGreaterThan(events.findIndex(e=>e.change.type==='agent_finished'));
  expect(replayExecution(result.execution.header,view.manifest,events)).toEqual(result.execution.state);expect(new ExecutionStore(join(runs.root,view.run.id),view.manifest).read()).toEqual(result.execution);
  const lines:string[]=[];await runOrchestrationCommand('run',['replay',view.run.id,'--json'],{cwd:project,store:runs,write:line=>lines.push(line)});expect(JSON.parse(lines[0]!).data.execution.events).toEqual(events);expect(requests).toHaveLength(4);expect(git('status','--porcelain')).toBe('?? plan.json\n');
});

it('replans a failed isolated candidate, preserves both attempts and only completes after verification and final review',async()=>{
  verificationExits=[1,0];decide=async context=>context.outcomes[0].status==='failed'?retry(context):keepGoing(context);
  const view=await reviewed(),result=await execute(view.run.id);
  expect(result.status,JSON.stringify(result.execution.state.supervision)).toBe('completed');expect(result.execution.state.tasks['inspect-a']).toMatchObject({attempts:2,status:'completed'});expect(result.execution.state.supervision).toMatchObject({rounds:2,stalledRounds:0,strategies:{'inspect-a':{strategy:expect.stringContaining('boundary')}}});
  const feedback=requests.find(r=>r.context.supervision)?.context.supervision;expect(feedback.feedback[0].status).toBe('failed');expect(feedback.feedback[0].artifacts.find((a:any)=>a.id==='tests').excerpt).toContain('"exitCode":1');
  const outcomes=result.execution.events.filter(e=>e.change.type==='task_finished');expect(outcomes.map(e=>(e.change as any).status)).toEqual(['failed','completed']);
  expect(result.execution.events.find(e=>e.change.type==='supervision_applied')?.change).toMatchObject({receipts:[{artifactId:'tests',exitCode:1,cleanupConfirmed:true}]});
  for(const attempt of [1,2])expect(fs.existsSync(join(runs.root,view.run.id,'execution',`worker-inspect-a-${attempt}`,'files','a/report.txt'))).toBe(true);
  const budget=new ReservationLedger(join(runs.root,view.run.id,'budget')).read(project);expect(Object.keys(budget.projection.requests)).toHaveLength(6);expect(budget.projection.spent.tokens).toBe(60);
});

it('keeps malformed controller output recoverable only through an explicit command without resetting budget or clock',async()=>{
  decide=async()=>'{bad JSON';const view=await reviewed(),first=await execute(view.run.id);expect(first.status).toBe('failed');expect(first.execution.state.supervision?.halt?.reason).toContain('malformed');
  const count=requests.length,again=await execute(view.run.id,{resume:true});expect(again.status).toBe('failed');expect(requests).toHaveLength(count);
  const ledger=new ReservationLedger(join(runs.root,view.run.id,'budget')),before=ledger.read(project),lines:string[]=[];
  expect(await runOrchestrationCommand('run',['retry-controller',view.run.id,'--json'],{cwd:project,store:runs,write:line=>lines.push(line)})).toBe(0);expect(ledger.read(project)).toEqual(before);
  decide=async context=>keepGoing(context);const next=await execute(view.run.id,{resume:true});expect(next.status).toBe('completed');expect(next.execution.header).toEqual(first.execution.header);expect(next.execution.state.supervision?.rounds).toBe(2);expect(requests).toHaveLength(count+1);
});

it('cancels an active controller and retains its unknown request reservation',async()=>{
  let ready!:()=>void;const began=new Promise<void>(r=>{ready=r;});decide=async(_context,signal)=>{ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const view=await reviewed(),controller=new AbortController(),running=execute(view.run.id,{signal:controller.signal});await began;controller.abort();const result=await running;
  expect(result.status).toBe('cancelled');expect(result.execution.state.ownerId).toBeNull();expect(result.execution.state.supervision?.halt?.outcome).toBe('cancelled');
  const budget=new ReservationLedger(join(runs.root,view.run.id,'budget')).read(project);expect(Object.values(budget.projection.requests).some(r=>r.reservation.agentId==='coordinator'&&r.state==='unknown')).toBe(true);
});

it('does not let a controller retry denied tools, unclean verification or exhausted task attempts',async()=>{
  for(const scenario of ['denied','unclean','attempts']){
    verificationExits=[1,1];requests=[];decide=async context=>retry(context,'retry');
    const p=plan();if(scenario==='attempts')p.agents[1]!.escalationPolicy.maxRetries=0;
    if(scenario==='unclean')vi.mocked(commands.runIsolatedCommand).mockResolvedValueOnce({version:1,kind:'isolated-command',argv:['node','check.js'],image,exitCode:1,outcome:'unavailable',stdout:'',stderr:'',truncated:false,durationMs:1,container:'calliope-check-'+randomUUID(),cleanupConfirmed:false});
    const view=await reviewed(p),result=await execute(view.run.id,scenario==='denied'?{approve:async(d:any)=>d.request?.tool==='shell'?'reject':'allow'}:{});
    expect(result.status).not.toBe('completed');expect(result.execution.state.tasks['inspect-a']!.attempts).toBe(1);expect(result.execution.state.supervision?.phase).toBe('halted');expect(result.execution.events.some(e=>e.change.type==='supervision_applied')).toBe(false);
  }
});

it('honors stop decisions and round limits even when a model claims the task is complete',async()=>{
  decide=async context=>({...keepGoing(context),action:'stop',reason:'The reviewer requests human inspection.'});const view=await reviewed(),result=await execute(view.run.id);expect(result.status).toBe('partial');expect(result.execution.state.supervision?.halt?.outcome).toBe('stop');
  const p=plan();p.supervision!.maxRounds=p.supervision!.maxStalledRounds=1;verificationExits=[1,0];decide=async context=>retry(context);const next=await reviewed(p),limited=await execute(next.run.id);expect(limited.status).toBe('denied');expect(limited.execution.state.supervision).toMatchObject({rounds:1,halt:{outcome:'limit'}});
  await expect(controlExecution(project,next.run.id,'controller-retry','coordinator',{store:runs})).rejects.toThrow('rounds remaining');
});

it('admits controller children against one recorded decision and original persistent budget',async()=>{
  const p=plan(),child=structuredClone(p.agents[1]!),task=structuredClone(p.tasks[0]!);child.id='child';task.id='child-task';task.agentId=child.id;task.outputs.forEach(o=>o.id='child-'+o.id);task.outputs[0]!.path='a/child.txt';task.isolation!.patchArtifactId='child-patch';task.isolation!.commands[0]!.artifactId='child-tests';task.acceptanceChecks!.forEach(c=>c.artifactId='child-'+c.artifactId);
  decide=async context=>context.round===1?{...keepGoing(context),action:'decompose',hypothesis:'A second candidate supplies independent evidence.',expectedMetric:{name:'verified tasks',direction:'increase'},children:{version:1,parentId:'coordinator',agents:[child],tasks:[task]}}:keepGoing(context);
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.status,JSON.stringify(result.execution.state.supervision)).toBe('completed');
  const graph=result.execution.state.graph!;expect(graph.admissions).toHaveLength(1);expect(graph.plan.tasks).toHaveLength(2);expect(graph.admissions[0]!.proposal.source).toMatchObject({kind:'supervision',eventId:result.execution.events.find(e=>e.change.type==='supervision_decided')!.id});
  const budget=new ReservationLedger(join(runs.root,view.run.id,'budget')).read(project);expect(budget.projection.childGrants).toHaveLength(1);expect(budget.manifest.accounts).toHaveLength(2);expect(result.execution.header.deadline).toBe(budget.manifest.deadline);
});

it('denies model-requested tools in controller turns even when the root account owns write tools',async()=>{
  controllerTool=true;const view=await reviewed(),result=await execute(view.run.id);
  expect(result.status,JSON.stringify(result.execution.state.supervision)).toBe('denied');expect(fs.existsSync(join(project,'forbidden.txt'))).toBe(false);expect(result.execution.state.supervision?.halt?.outcome).toBe('denied');
});

it('rechecks retry artifact hashes and recovers the committed decision without paying for a new review',async()=>{
  verificationExits=[1,0];decide=async context=>context.outcomes[0].status==='failed'?retry(context):keepGoing(context);
  const view=await reviewed();let file='',bytes:Buffer|undefined;
  const first=await execute(view.run.id,{onEvent:(event:any)=>{if(event.change.type==='supervision_decided'&&!bytes){const store=new ExecutionStore(join(runs.root,view.run.id),view.manifest),a=store.read().state.artifacts.tests!;file=join(store.root,'artifacts',a.path);bytes=fs.readFileSync(file);fs.writeFileSync(file,'altered');}}});
  expect(first.status).toBe('failed');expect(first.execution.state.tasks['inspect-a']!.attempts).toBe(1);expect(first.execution.state.supervision?.decision?.action).toBe('replan');
  fs.writeFileSync(file,bytes!);await controlExecution(project,view.run.id,'controller-retry','coordinator',{store:runs});
  const next=await execute(view.run.id,{resume:true});expect(next.status).toBe('completed');expect(next.execution.state.supervision?.rounds).toBe(2);expect(requests).toHaveLength(6);expect(next.execution.header).toEqual(first.execution.header);
});

it('recovers a child grant interrupted after reservation without minting duplicate capacity',async()=>{
  const p=plan(),child=structuredClone(p.agents[1]!),task=structuredClone(p.tasks[0]!);child.id='child';task.id='child-task';task.agentId=child.id;task.outputs.forEach(o=>o.id='child-'+o.id);task.outputs[0]!.path='a/child.txt';task.isolation!.patchArtifactId='child-patch';task.isolation!.commands[0]!.artifactId='child-tests';task.acceptanceChecks!.forEach(c=>c.artifactId='child-'+c.artifactId);
  decide=async context=>context.round===1?{...keepGoing(context),action:'decompose',hypothesis:'Collect independent evidence.',expectedMetric:{name:'verified tasks',direction:'increase'},children:{version:1,parentId:'coordinator',agents:[child],tasks:[task]}}:keepGoing(context);
  const view=await reviewed(p),controller=new AbortController(),original=ReservationLedger.prototype.grantChildren;
  const spy=vi.spyOn(ReservationLedger.prototype,'grantChildren').mockImplementation(async function(...args){const result=await original.apply(this,args);controller.abort();return result;});
  const first=await execute(view.run.id,{signal:controller.signal});spy.mockRestore();expect(first.status).toBe('cancelled');expect(first.execution.state.graph).toBeUndefined();
  const ledger=new ReservationLedger(join(runs.root,view.run.id,'budget')),before=ledger.read(project);expect(before.projection.childGrants).toHaveLength(1);
  await controlExecution(project,view.run.id,'controller-retry','coordinator',{store:runs});const next=await execute(view.run.id,{resume:true});expect(next.status,JSON.stringify(next.execution.state.supervision)).toBe('completed');expect(ledger.read(project).projection.childGrants).toEqual(before.projection.childGrants);expect(next.execution.state.graph?.admissions).toHaveLength(1);
});

it('preserves stop escalation for exhausted agents before a controller can authorize more work',async()=>{
  const p=plan();p.agents[1]!.escalationPolicy={onFailure:'stop',maxRetries:0};verificationExits=[1];const view=await reviewed(p),result=await execute(view.run.id);
  expect(result.status).toBe('failed');expect(result.execution.state.tasks['inspect-a']!.escalation).toBe('stop');expect(requests).toHaveLength(2);expect(result.execution.state.supervision?.rounds).toBe(0);
});

it('does not disclose controller evidence to a worker whose read scope excludes its source path',async()=>{
  const p=plan(),restricted=structuredClone(p.agents[1]!);restricted.id='restricted';restricted.allowedPaths=[{path:'b',access:'read'}];p.agents.push(restricted);fs.mkdirSync(join(project,'b'));
  const view=await reviewed(p),result=await execute(view.run.id),store=new ExecutionStore(join(runs.root,view.run.id),view.manifest),event=result.execution.events.find(e=>e.change.type==='task_finished')!;
  await expect(reviewEvidence(store,[event.id],{},'restricted')).rejects.toThrow('policy');await expect(reviewEvidence(store,[event.id],{},'absent')).rejects.toThrow('policy');
});

it('proposes without applying work, then runs the exact reviewed cycle under the original clock and budget',async()=>{
  verificationExits=[1,0];decide=async context=>({...keepGoing(context),action:'stop'});const view=await reviewed(),first=await execute(view.run.id);
  expect(first.status).toBe('failed');const before=requests.length,deadline=first.execution.header.deadline;
  decide=async context=>context.outcomes.some((o:any)=>o.status==='failed')?retry(context):keepGoing(context);
  const proposal=await proposeImprovement(project,view.run.id,{store:runs,approve:async()=> 'allow'});
  expect(requests.length-before).toBe(1);expect(proposal.cycle.status).toBe('proposed');expect(proposal.cycle.results).toEqual([]);
  const waiting=await inspectImprovements(project,view.run.id,{store:runs});expect(waiting.execution!.state.tasks['inspect-a']!.attempts).toBe(1);expect(waiting.execution!.state.supervision?.phase,JSON.stringify(waiting.execution!.state.supervision)).toBe('decision');
  expect(waiting.execution!.state.supervision!.review).toMatchObject({decisionId:proposal.cycle.id,approved:false});
  await expect(execute(view.run.id,{resume:true})).rejects.toThrow('exact reviewed approval');
  expect((await proposeImprovement(project,view.run.id,{store:runs})).existing).toBe(true);expect(requests.length-before).toBe(1);
  await expect(runImprovement(project,view.run.id,proposal.cycle.id,'wrong',{store:runs})).rejects.toThrow('exact reviewed');
  await expect(runImprovement(project,view.run.id,proposal.cycle.id,proposal.proposalHash,{store:runs,confirmation:'mutating',approve:async()=> 'reject'})).rejects.toThrow();expect(requests.length-before).toBe(1);
  const deniedLines:string[]=[];expect(await runImprovementCommand(['run',proposal.cycle.id,'--run',view.run.id,'--approve',proposal.proposalHash,'--json'],{cwd:project,store:runs,write:l=>deniedLines.push(l)})).toBe(3);expect(JSON.parse(deniedLines.at(-1)!).error.code).toBe('policy-denied');expect(requests.length-before).toBe(1);
  const hud:string[]=[],runLines:string[]=[];expect(await runImprovementCommand(['run',proposal.cycle.id,'--run',view.run.id,'--approve',proposal.proposalHash,'--allow-mutations','--json'],{cwd:project,store:runs,onProgress:p=>hud.push(...workflowLines([workflowSnapshot(p)],'agents')),write:l=>runLines.push(l)})).toBe(0);const result=JSON.parse(runLines.at(-1)!).data;
  expect(result.status).toBe('completed');expect(result.execution.header.deadline).toBe(deadline);expect(result.execution.state.tasks['inspect-a']!.attempts).toBe(2);expect(requests.length-before).toBe(4);
  const current=await inspectImprovements(project,view.run.id,{store:runs}),cycle=current.history.cycles[0]!;
  expect(cycle.status).toBe('verified');expect(cycle.application).not.toBeNull();expect(cycle.approval.proposal).not.toBeNull();expect(cycle.approval.approval).not.toBeNull();expect(cycle.hypothesis.state).toBe('proposed');expect(cycle.approval.production).toBe('not-approved');
  expect(cycle.rollback.baseCommit).toMatch(/^[a-f0-9]{40}$/);expect(cycle.rollback.patches).toHaveLength(1);expect(cycle.results[0]!.artifacts.find(a=>a.kind==='patch')?.sha256).toMatch(/^[a-f0-9]{64}$/);
  const metric=cycle.metrics.find(m=>m.name==='acceptance-check-pass-rate')!;expect(metric.comparable).toBe(true);expect(metric.after!).toBeGreaterThan(metric.before!);
  expect(cycle.budget.deadline).toBe(deadline);expect(cycle.source.decision.id).toBe(proposal.cycle.id);expect(improvementProposalHash(cycle)).toBe(proposal.proposalHash);
  expect(improvementFeedback(current.history).cycles[0]!.status).toBe('verified');expect(hud.some(s=>s.includes('improvement 1 verified'))).toBe(true);
  expect(replayExecution(result.execution.header,view.manifest,result.execution.events)).toEqual(result.execution.state);
  const lines:string[]=[];expect(await runImprovementCommand(['history','--run',view.run.id,'--json'],{cwd:project,store:runs,write:l=>lines.push(l)})).toBe(0);expect(JSON.parse(lines[0]!).data).toEqual(current.history);
});

it('withdraws an unexecuted proposal, retains reservations and refuses a stale approval after a permission race',async()=>{
  verificationExits=[1];decide=async context=>({...keepGoing(context),action:'stop'});const view=await reviewed();await execute(view.run.id);decide=async context=>retry(context);
  const proposal=await proposeImprovement(project,view.run.id,{store:runs,approve:async()=> 'allow'}),calls=requests.length;
  const ledger=new ReservationLedger(join(runs.root,view.run.id,'budget')),before=ledger.read(project);
  await expect(withdrawImprovement(project,view.run.id,proposal.cycle.id,{store:runs,confirmation:'mutating',approve:async()=> 'reject'})).rejects.toThrow();
  let withdrawn=false;
  await expect(runImprovement(project,view.run.id,proposal.cycle.id,proposal.proposalHash,{store:runs,confirmation:'mutating',approve:async()=>{if(!withdrawn){withdrawn=true;await withdrawImprovement(project,view.run.id,proposal.cycle.id,{store:runs,approve:async()=> 'allow'});}return 'allow';}})).rejects.toThrow();
  const history=await inspectImprovements(project,view.run.id,{store:runs});expect(history.history.cycles[0]!.status).toBe('withdrawn');expect(history.execution!.state.supervision?.phase).toBe('halted');expect(requests).toHaveLength(calls);
  expect(ledger.read(project).projection.spent).toEqual(before.projection.spent);expect(history.execution!.state.tasks['inspect-a']!.attempts).toBe(1);
  expect((await withdrawImprovement(project,view.run.id,proposal.cycle.id,{store:runs})).alreadyWithdrawn).toBe(true);
  expect(replayExecution(history.execution!.header,view.manifest,history.execution!.events)).toEqual(history.execution!.state);
});

it('retires an applied strategy without rewriting results, restores its predecessor and never refunds spend',async()=>{
  const p=plan();p.agents[0]!.escalationPolicy.maxRetries=2;p.agents[1]!.escalationPolicy.maxRetries=2;p.agents[1]!.tokenBudget=40000;p.agents[1]!.costBudgetUsd=0.4;p.supervision!.maxStalledRounds=3;verificationExits=[1,1,0];
  decide=async context=>context.outcomes.some((o:any)=>o.status==='failed')?{...retry(context),strategy:`Preserve tests and use strategy ${context.round}.`}:keepGoing(context);
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.status).toBe('completed');
  const initial=await inspectImprovements(project,view.run.id,{store:runs}),[first,second]=initial.history.cycles;expect(first!.status).toBe('failed');expect(second!.previousCycleId).toBe(first!.id);expect(second!.status).toBe('verified');
  const ledger=new ReservationLedger(join(runs.root,view.run.id,'budget')),spent=ledger.read(project).projection.spent,calls=requests.length;
  await withdrawImprovement(project,view.run.id,second!.id,{store:runs,approve:async()=> 'allow'});
  const after=await inspectImprovements(project,view.run.id,{store:runs});expect(after.execution!.state.supervision?.strategies['inspect-a']?.decisionId).toBe(first!.id);expect(after.execution!.state.tasks).toEqual(result.execution.state.tasks);
  expect(after.history.cycles[1]!.results).toEqual(second!.results);expect(after.history.cycles[1]!.status).toBe('withdrawn');expect(ledger.read(project).projection.spent).toEqual(spent);expect(requests).toHaveLength(calls);
  await withdrawImprovement(project,view.run.id,first!.id,{store:runs,approve:async()=> 'allow'});expect((await inspectImprovements(project,view.run.id,{store:runs})).execution!.state.supervision?.strategies).toEqual({});
});

it('links recursive improvements to the admitting cycle without claiming comparable metrics for new tasks',async()=>{
  const p=plan(),child=structuredClone(p.agents[1]!),task=structuredClone(p.tasks[0]!);child.id='child';task.id='child-task';task.agentId=child.id;task.outputs.forEach(o=>o.id='child-'+o.id);task.outputs[0]!.path='a/child.txt';task.isolation!.patchArtifactId='child-patch';task.isolation!.commands[0]!.artifactId='child-tests';task.acceptanceChecks!.forEach(c=>c.artifactId='child-'+c.artifactId);
  verificationExits=[0,1,0];
  decide=async context=>context.round===1?{...keepGoing(context),action:'decompose',hypothesis:'An independent child supplies more evidence.',expectedMetric:{name:'verified tasks',direction:'increase'},children:{version:1,parentId:'coordinator',agents:[child],tasks:[task]}}:context.round===2?{...retry(context),taskId:'child-task'}:keepGoing(context);
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.status).toBe('completed');
  const current=await inspectImprovements(project,view.run.id,{store:runs}),[parent,nested]=current.history.cycles;
  expect(parent!.status).toBe('failed');expect(parent!.metrics.every(m=>!m.comparable)).toBe(true);expect(nested!.parentCycleId).toBe(parent!.id);expect(nested!.status).toBe('verified');
  expect(nested!.budget.accounts.map(a=>a.id)).toContain('coordinator');expect(nested!.budget.deadline).toBe(parent!.budget.deadline);
  expect(projectImprovementHistory(view.manifest,result.execution,current.store.context()).cycles.map(c=>c.id)).toEqual(current.history.cycles.map(c=>c.id));
  const before=result.execution.state.graph?.admissions;await withdrawImprovement(project,view.run.id,parent!.id,{store:runs,approve:async()=> 'allow'});
  const withdrawn=await inspectImprovements(project,view.run.id,{store:runs});expect(withdrawn.execution!.state.graph?.admissions).toEqual(before);expect(withdrawn.execution!.state.stoppedAgents).toContain('child');
});

it('rejects changed artifact and worktree provenance during improvement inspection',async()=>{
  verificationExits=[1,0];decide=async context=>context.outcomes.some((o:any)=>o.status==='failed')?retry(context):keepGoing(context);
  const view=await reviewed();await execute(view.run.id);const initial=await inspectImprovements(project,view.run.id,{store:runs}),artifact=initial.history.cycles[0]!.baseline[0]!.artifacts[0]!,file=join(initial.store.root,'artifacts',artifact.path),bytes=fs.readFileSync(file);
  fs.writeFileSync(file,'changed');await expect(inspectImprovements(project,view.run.id,{store:runs})).rejects.toThrow();fs.writeFileSync(file,bytes);
  const base=join(initial.store.root,'workspace-base.json'),original=fs.readFileSync(base);fs.writeFileSync(base,'{"private":"malformed"}');await expect(inspectImprovements(project,view.run.id,{store:runs})).rejects.toThrow();fs.writeFileSync(base,original);
  const controller=new AbortController();controller.abort();await expect(inspectImprovements(project,view.run.id,{store:runs,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
  const lines:string[]=[];expect(await runImprovementCommand(['run','--json'],{cwd:project,store:runs,write:l=>lines.push(l)})).toBe(2);expect(JSON.parse(lines[0]!).error.code).toBe('invalid');
});

it('cancels an improvement review, blocks a concurrent proposer and retains the uncertain reservation',async()=>{
  verificationExits=[1];decide=async context=>({...keepGoing(context),action:'stop'});const view=await reviewed(),first=await execute(view.run.id),calls=requests.length;
  let ready!:()=>void;const began=new Promise<void>(resolve=>{ready=resolve;});decide=async(_context,signal)=>{ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const controller=new AbortController(),pending=proposeImprovement(project,view.run.id,{store:runs,signal:controller.signal,approve:async()=> 'allow'});const rejection=expect(pending).rejects.toMatchObject({name:'AbortError'});await began;
  await expect(proposeImprovement(project,view.run.id,{store:runs})).rejects.toThrow('active coordinator');controller.abort();await rejection;
  const current=await inspectImprovements(project,view.run.id,{store:runs});expect(current.execution!.header).toEqual(first.execution.header);expect(current.execution!.state.supervision?.halt?.outcome).toBe('cancelled');expect(current.execution!.state.tasks['inspect-a']!.attempts).toBe(1);expect(requests).toHaveLength(calls+1);
  await expect(execute(view.run.id,{resume:true})).rejects.toThrow('interrupted proposal review');expect(requests).toHaveLength(calls+1);
  const ledger=new ReservationLedger(join(runs.root,view.run.id,'budget')).read(project);expect(Object.values(ledger.projection.requests).filter(r=>r.state==='unknown')).toHaveLength(1);
});

it('streams proposal events as JSON and allows an expired proposal to be withdrawn but never executed',async()=>{
  verificationExits=[1];decide=async context=>({...keepGoing(context),action:'stop'});const view=await reviewed();await execute(view.run.id);decide=async context=>retry(context);
  const lines:string[]=[];expect(await runImprovementCommand(['propose','--run',view.run.id,'--allow-mutations','--json'],{cwd:project,store:runs,write:l=>lines.push(l)})).toBe(0);
  const records=lines.map(l=>JSON.parse(l)),last=records.at(-1),{cycle,proposalHash}=last.data;expect(last).toMatchObject({version:1,type:'improvement',action:'propose',localOnly:true});
  const events=records.filter(r=>r.type==='improvement.event');expect(events.length).toBeGreaterThan(0);expect(events.every(r=>r.version===1&&r.runId===view.run.id&&r.event.version===(r.event.change.type.startsWith('supervision_')?3:1)&&r.event.hash.length===64)).toBe(true);
  const calls=requests.length,ledger=new ReservationLedger(join(runs.root,view.run.id,'budget')),before=ledger.read(project);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(cycle.budget.deadline+1);
  await expect(runImprovement(project,view.run.id,cycle.id,proposalHash,{store:runs})).rejects.toThrow(/deadline|expired/i);
  const human:string[]=[];expect(await runImprovementCommand(['history','--run',view.run.id],{cwd:project,store:runs,write:l=>human.push(l)})).toBe(0);expect(human[0]).toContain(cycle.id);
  const rolled:string[]=[];expect(await runImprovementCommand(['rollback',cycle.id,'--run',view.run.id,'--allow-mutations','--json'],{cwd:project,store:runs,write:l=>rolled.push(l)})).toBe(0);expect(JSON.parse(rolled.at(-1)!).data.cycle.status).toBe('withdrawn');
  expect(ledger.read(project)).toEqual(before);expect(requests).toHaveLength(calls);
});

it('rejects malformed improvement commands and redacts unexpected errors without inference',async()=>{
  for(const args of [['unknown'],['run'],['history','extra'],['history','--approve','hash'],['run','cycle'],['rollback'],['--bogus'],['x'.repeat(4097)],['history\n']]){
    const lines:string[]=[];expect(await runImprovementCommand([...args,'--json'],{cwd:project,store:runs,write:l=>lines.push(l)})).toBe(2);expect(JSON.parse(lines.at(-1)!).error.code).toBe('invalid');
  }
  const lines:string[]=[];const signal=AbortSignal.abort();expect(await runImprovementCommand(['--json'],{cwd:project,store:runs,signal,write:l=>lines.push(l)})).toBe(130);expect(JSON.parse(lines.at(-1)!).error.code).toBe('cancelled');expect(requests).toEqual([]);
});
