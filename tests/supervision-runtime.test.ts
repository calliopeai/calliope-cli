import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {clearModelCache} from '../src/model-detection.js';
import {providerTarget} from '../src/health/index.js';
import {RunStore,ExecutionStore,prepareRun,changePreparedRun,executeReviewedRun,controlExecution,recoverTaskEvidence,runOrchestrationCommand,replayExecution,type ProjectPlan} from '../src/orchestration/index.js';
import {ReservationLedger,type RequestReservation} from '../src/execution/index.js';
import {coordinatorProgress} from '../src/orchestration/progress.js';
import {projectBudgetPath} from '../src/budget.js';
import {verifiedPlan} from './helpers/coordinator-run.js';
import * as commands from '../src/isolation/process.js';
import * as isolation from '../src/isolation/coordinator.js';
import {workflowSnapshot,workflowLines} from '../src/ui/workflow-progress.js';
import {inspectImprovements,proposeImprovement,runImprovement,withdrawImprovement,runImprovementCommand,improvementProposalHash,projectImprovementHistory,improvementFeedback} from '../src/improvement/index.js';
import {reviewEvidence} from '../src/supervision/index.js';
import {initBrain,ingestBrainRun,BrainStore} from '../src/brain/index.js';
vi.setConfig({testTimeout:20000}); // Multiple real Git worktrees and durable journals per recovery scenario.
let root:string,project:string,runs:RunStore,requests:any[],verificationExits:number[],controllerTool:boolean,truncateWorkers:number,decide:(context:any,signal:AbortSignal)=>Promise<unknown>;
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
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');git('add','.');git('commit','-qm','fixture');runs=new RunStore(join(root,'runs'));requests=[];verificationExits=[0];controllerTool=false;truncateWorkers=0;decide=async context=>keepGoing(context);
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
    const truncated=context.kind!=='controller-review'&&!tool_calls&&truncateWorkers>0;if(truncated)truncateWorkers--;
    return json({id:'toy',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:truncated?'{"version":1,"outputs":[{"id":"forged-test",':content,...(tool_calls?{tool_calls}:{})},finish_reason:tool_calls?'tool_calls':truncated?'length':'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}});
  }));
  vi.spyOn(commands,'runIsolatedCommand').mockImplementation(async(image,command)=>{const exit=verificationExits.shift()??0;return{version:1,kind:'isolated-command',argv:command.argv,image,exitCode:exit,outcome:exit?'failed':'passed',stdout:'retained boundary test evidence',stderr:'',truncated:false,durationMs:1,container:'calliope-check-'+randomUUID(),cleanupConfirmed:true};});
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
async function reviewed(p=plan()){fs.writeFileSync(join(project,'plan.json'),JSON.stringify(p));const view=await prepareRun(project,'plan.json',{store:runs});return changePreparedRun(project,view.run.id,'approved',{store:runs});}
const execute=(id:string,extra={})=>executeReviewedRun(project,id,{store:runs,approve:async()=> 'allow',...extra});

it.each(['stop','decompose'])('exposes denied-parent availability to both review roles and enforces policy after %s',async action=>{
  const p=plan();p.agents[1]!.maxChildDepth=1;p.agents[1]!.maxChildCount=1;const reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';reviewer.maxChildDepth=0;reviewer.maxChildCount=0;p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';
  const child=structuredClone(p.agents[1]!);child.id='child';child.parentId='a';child.maxChildDepth=0;child.maxChildCount=0;child.tokenBudget=8000;child.costBudgetUsd=0.1;
  const task=structuredClone(p.tasks[0]!);task.id='child-task';task.agentId='child';task.outputs[0]!.id='child-report';task.outputs[0]!.path='a/child.txt';task.outputs[1]!.id='child-patch';task.outputs[2]!.id='child-tests';task.acceptanceChecks![0]!.artifactId='child-report';task.acceptanceChecks![1]!.artifactId='child-tests';task.isolation!.patchArtifactId='child-patch';task.isolation!.commands[0]!.artifactId='child-tests';
  const transport=fetch;vi.stubGlobal('fetch',async(input,init)=>{const response=await transport(input,init),body=await response.clone().json();if(body.model==='worker-toy'&&body.choices[0].message.tool_calls){body.choices[0].message.tool_calls[0].function={name:'read_file',arguments:JSON.stringify({path:'package.json'})};return json(body);}return response;});
  const roles:string[]=[];decide=async context=>{
    roles.push(context.role);expect(context.availability.version).toBe(1);expect(context.availability.executionRevision).toMatch(/^[a-f0-9]{64}$/);expect(context.availability.childParents.find((a:any)=>a.id==='a')).toMatchObject({status:'blocked',reason:'This agent or an ancestor is stopped or escalated.'});expect(context.availability.retryTasks[0].status).toBe('blocked');
    if(context.role==='reviewer')return{version:1,verdict:'approve',draftHash:context.draftHash,reason:'Review of the supplied draft.'};
    return action==='stop'?{...keepGoing(context),action:'stop',reason:'Operator inspection is required for the denied task.'}:{...keepGoing(context),action:'decompose',hypothesis:'This intentionally ignores the blocked-parent snapshot.',expectedMetric:{name:'verified tasks',direction:'increase'},children:{version:1,parentId:'a',agents:[child],tasks:[task]}};
  };
  const view=await reviewed(p),result=await execute(view.run.id);expect(roles).toEqual(['controller','reviewer']);expect(result.status).toBe(action==='stop'?'denied':'failed');expect(result.execution.state.tasks['inspect-a']!.status).toBe('denied');expect(result.execution.state.graph?.admissions??[]).toHaveLength(0);expect(result.execution.events.filter(e=>e.change.type==='task_started')).toHaveLength(1);expect(commands.runIsolatedCommand).not.toHaveBeenCalled();expect(fs.existsSync(join(project,'a/child.txt'))).toBe(false);
  if(action==='decompose')expect(result.execution.state.supervision?.halt?.reason).toContain('no child admission');
  const before=requests.length,rows:any[]=[];expect(await runOrchestrationCommand('run',['replay',view.run.id,'--json'],{cwd:project,store:new RunStore(runs.root),write:text=>rows.push(JSON.parse(text))})).toBe(0);expect(rows.at(-1).version).toBe(2);expect(requests.length).toBe(before);
});

it('applies explicit reviewer approval to the exact replan, retains verification evidence and replays after restart',async()=>{
  const p=plan(),reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';verificationExits=[1,0];
  decide=async context=>context.role==='reviewer'?'Review notes.\n```json\n'+JSON.stringify({version:1,verdict:'approve',draftHash:context.draftHash,reason:'The original receipt supports the current bounded draft.'})+'\n```\nNo additional authority is requested.':context.round===1?retry(context):keepGoing(context);
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.status,JSON.stringify(result.execution.state.supervision)).toBe('completed');
  expect(result.execution.events.filter(e=>e.change.type==='task_finished').map(e=>e.change.type==='task_finished'&&e.change.status)).toEqual(['failed','completed']);
  const decisions=result.execution.events.filter(e=>e.change.type==='supervision_decided'&&e.change.role==='reviewer');expect(decisions.map(e=>e.change.type==='supervision_decided'&&e.change.decision.action)).toEqual(['replan','continue']);
  expect(result.execution.state.tasks['inspect-a']!.attempts).toBe(2);expect(result.execution.events.some(e=>e.change.type==='supervision_applied'&&e.change.decisionId===decisions[0]!.id)).toBe(true);expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);
  const count=requests.length,restarted=new ExecutionStore(join(runs.root,view.run.id),view.manifest).read();expect(replayExecution(restarted.header,view.manifest,restarted.events)).toEqual(restarted.state);
  const rows:any[]=[];expect(await runOrchestrationCommand('run',['replay',view.run.id,'--json'],{cwd:project,store:new RunStore(runs.root),write:s=>rows.push(JSON.parse(s))})).toBe(0);expect(rows.at(-1).version).toBe(2);expect(requests).toHaveLength(count);
});
it.each(['reject','stale','ambiguous'])('does not retry a failed worker after a %s reviewer reply',async kind=>{
  const p=plan(),reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';verificationExits=[1];
  decide=async context=>{
    if(context.role==='controller')return retry(context);
    const verdict={version:1,verdict:kind==='reject'?'reject':'approve',draftHash:kind==='stale'?'0'.repeat(64):context.draftHash,reason:'Stop for operator inspection.'};
    const block='```json\n'+JSON.stringify(verdict)+'\n```';return kind==='ambiguous'?block+'\n'+block:verdict;
  };
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.status).not.toBe('completed');expect(result.execution.state.supervision?.halt?.outcome).toBe(kind==='reject'?'stop':'failed');
  expect(result.execution.events.filter(e=>e.change.type==='task_reset')).toHaveLength(0);expect(result.execution.events.filter(e=>e.change.type==='task_started')).toHaveLength(1);expect(fs.existsSync(join(project,'a/report.txt'))).toBe(false);
  if(kind!=='reject')expect(result.execution.state.supervision?.halt?.reason).toContain('Reviewer');
});
it('cancels an in-flight reviewer before a verdict can authorize another worker attempt',async()=>{
  const p=plan(),reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';verificationExits=[1];const aborter=new AbortController();
  decide=async(context,signal)=>{expect(context.availability.retryTasks[0].status).toBe('possible');if(context.role==='controller')return retry(context);expect(context.draftEffect).toMatchObject({retryTaskIds:['inspect-a'],newAgentIds:[],newTaskIds:[]});aborter.abort();throw signal.reason;};
  const view=await reviewed(p),result=await execute(view.run.id,{signal:aborter.signal});expect(result.status).toBe('cancelled');expect(result.execution.events.filter(e=>e.change.type==='task_reset')).toHaveLength(0);expect(result.execution.state.supervision?.halt?.outcome).toBe('cancelled');
});
it('rejects a truncated reviewer verdict while retaining usage and the original failed task',async()=>{
  const p=plan(),reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';verificationExits=[1];
  decide=async context=>context.role==='reviewer'?{version:1,verdict:'approve',draftHash:context.draftHash,reason:'The draft is bounded.'}:retry(context);
  const transport=fetch;vi.stubGlobal('fetch',async(input,init)=>{const response=await transport(input,init),body=await response.clone().json();if(body.model==='reviewer-toy'){body.choices[0].finish_reason='length';return json(body);}return response;});
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.execution.state.supervision?.halt).toMatchObject({outcome:'failed',reason:'Reviewer stopped: length.'});expect(result.execution.state.tasks['inspect-a']!.attempts).toBe(1);
  const ledger=new ReservationLedger(join(runs.root,view.run.id,'budget')).read(project);expect(Object.values(ledger.projection.requests).filter(r=>r.reservation.agentId==='reviewer').map(r=>r.state)).toEqual(['settled']);
});
it('denies model-requested tools from a reviewer even when its JSON verdict approves the draft',async()=>{
  const p=plan(),reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';verificationExits=[1];
  decide=async context=>{if(context.role==='controller')return retry(context);controllerTool=true;return{version:1,verdict:'approve',draftHash:context.draftHash,reason:'The draft is bounded.'};};
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.status).toBe('denied');expect(result.execution.state.supervision?.halt?.outcome).toBe('denied');expect(fs.existsSync(join(project,'forbidden.txt'))).toBe(false);expect(result.execution.state.tasks['inspect-a']!.attempts).toBe(1);
});

it('uses reviewed limits for ID-only worker, controller and reviewer discovery with replayable reservations',async()=>{
  const p=plan(),reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';
  const original=fetch;vi.stubGlobal('fetch',vi.fn(async(input,init)=>new Request(input,init).url.endsWith('/models')?json({data:['worker-toy','controller-toy','reviewer-toy'].map(id=>({id}))}):original(input,init)));
  const file=join(root,'billing.json'),now=Date.now();vi.stubEnv('CALLIOPE_BILLING_FILE',file);fs.writeFileSync(file,JSON.stringify({version:2,profiles:p.agents.map(a=>({version:2,provider:'deepseek',model:a.preference.model,target:providerTarget('deepseek').key,checkedAt:now,expiresAt:now+60000,sources:['https://example.invalid/fixture'],prices:{input:1,output:2},capabilities:{chat:true,tools:true},limits:{contextLength:4096,maxOutputTokens:100},admission:'reviewed-full-context-v1'}))}),{mode:0o600});
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.status).toBe('completed');expect(requests.map(r=>r.body.model)).toEqual(['worker-toy','worker-toy','controller-toy','reviewer-toy']);expect(requests.every(r=>r.body.max_tokens===100)).toBe(true);
  const saved=new ReservationLedger(join(runs.root,view.run.id,'budget')).read(project);expect(saved.events.filter(e=>e.change.type==='reserve')).toHaveLength(4);for(const e of saved.events)if(e.change.type==='reserve')expect(e).toMatchObject({version:4,change:{reservation:{quoteEvidence:{version:2,live:{maxOutputTokens:null}},attribution:{version:1}}}});
  expect(replayExecution(result.execution.header,view.manifest,result.execution.events)).toEqual(result.execution.state);expect(result.accounting).toMatchObject({status:'available',run:{accounted:{tokens:40,costNanos:52000}}});
});

it('reviews actual executor artifacts with distinct controller/reviewer models, updates the HUD and replays without calls',async()=>{
  const p=plan(),reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';
  const view=await reviewed(p),hud:string[]=[];decide=async context=>{expect(context.outcomes[0].artifacts.find((a:any)=>a.id==='tests').excerpt).toContain('"cleanupConfirmed":true');expect(context.outcomes[0].artifacts.find((a:any)=>a.id==='patch').excerpt).toContain('+public toy candidate');if(context.role==='reviewer')expect(context.draft.action).toBe('continue');return keepGoing(context);};
  const result=await execute(view.run.id,{onProgress:(value:any)=>hud.push(...workflowLines([workflowSnapshot(value)],'agents'))});
  expect(result.status,JSON.stringify(result.execution.state.supervision)).toBe('completed');expect(requests.map(r=>r.body.model)).toEqual(['worker-toy','worker-toy','controller-toy','reviewer-toy']);
  expect(result.execution.state).toMatchObject({version:6,supervision:{rounds:1,phase:'ready'}});expect(hud.some(row=>row.includes('reviewing round 1'))).toBe(true);
  const accounting=result.accounting;if(accounting.status!=='available'||accounting.attribution?.status!=='available')throw Error('Missing request attribution');
  const groups=Object.values(accounting.attribution.groups);expect(groups).toHaveLength(3);expect(groups.every(g=>g.status==='available'&&g.usageComplete)).toBe(true);
  expect(groups.filter(g=>g.source.kind==='task')).toMatchObject([{accounted:{tokens:20,costNanos:26000}}]);
  expect(groups.filter(g=>g.source.kind==='supervision').map(g=>[g.source.kind==='supervision'?g.source.role:'',g.status==='available'?g.accounted.costNanos:null])).toEqual([['controller',13000],['reviewer',13000]]);
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
  const inspected=await inspectImprovements(project,view.run.id,{store:runs});expect(inspected.history.version).toBe(2);expect(inspected.history.cycles[0]!.version).toBe(2);
  expect(inspected.history.cycles[0]!.metrics.find(m=>m.name==='provider-accounted-cost')).toMatchObject({before:26000,after:26000,delta:0,comparable:true});
  const controller=requests.filter(r=>r.context.kind==='controller-review').at(-1)!.context;
  expect(controller.improvements.accounting.scope).toBe('worker-attempts');expect(controller.improvements.cycles[0].measurements.find((m:any)=>m.name==='provider-accounted-cost')).toMatchObject({before:26000,after:26000,comparable:true});
});

it('ingests attributed improvement measurements with their ledger revision without accepting hypotheses',async()=>{
  verificationExits=[1,0];const view=await reviewed(),ledger=new ReservationLedger(join(runs.root,view.run.id,'budget'));let pending:RequestReservation|undefined;
  decide=async context=>{if(!pending){const saved=ledger.read(project);pending={...structuredClone(Object.values(saved.projection.requests).find(r=>r.state==='pending')!.reservation),id:randomUUID()};await ledger.reserve(project,saved.projection.manifestHash,pending);}return context.outcomes[0].status==='failed'?retry(context):keepGoing(context);};
  await execute(view.run.id);const current=await inspectImprovements(project,view.run.id,{store:runs}),options={runs,base:join(root,'brain'),confirmation:'none' as const};
  await initBrain(project,options);const imported=await ingestBrainRun(project,view.run.id,options);
  const decision=Object.values(imported.state.entities).find(e=>e.kind==='decision')!;expect(decision.state).toBe('proposed');expect(decision.provenance[0]!.basis).toBe('inferred');
  const source=imported.state.sources[decision.provenance[0]!.sourceId]!,record=JSON.parse(source.content);
  expect(record.accounting.revision).toBe(current.history.accounting!.revision);expect(record.accounting.scope).toBe('worker-attempts');expect(record.metrics.find((m:any)=>m.name==='provider-accounted-cost')).toMatchObject({before:26000,after:26000,comparable:true});
  const before=new BrainStore(project,'project',options.base).read();await ingestBrainRun(project,view.run.id,options);expect(new BrainStore(project,'project',options.base).read().state.revision).toBe(before.state.revision);
  const checks=Object.values(imported.state.entities).filter(e=>e.kind==='test_evidence');expect(checks.some(e=>e.attributes.passed===false)).toBe(true);expect(checks.every(e=>e.state==='accepted')).toBe(true);
  const execution=new ExecutionStore(join(runs.root,view.run.id),view.manifest),events=execution.read();
  await ledger.settle(project,ledger.read(project).projection.manifestHash,{requestId:pending!.id,outcome:'success',usage:{inputTokens:7,outputTokens:3}});
  const updated=await ingestBrainRun(project,view.run.id,options);expect(updated.state.revision).not.toBe(before.state.revision);expect(execution.read()).toEqual(events);
  const decisions=Object.values(updated.state.entities).filter(e=>e.kind==='decision');expect(decisions).toHaveLength(2);expect(decisions.every(e=>e.state==='proposed')).toBe(true);expect(updated.state.entities[decision.id]).toEqual(decision);
  await ingestBrainRun(project,view.run.id,options);expect(new BrainStore(project,'project',options.base).read().state.revision).toBe(updated.state.revision);
});

it('refreshes improvement cost after settlement alone and rejects stale execution attribution',async()=>{
  verificationExits=[1,0];const view=await reviewed(),ledger=new ReservationLedger(join(runs.root,view.run.id,'budget'));let pending:RequestReservation|undefined;
  // Reserve one additional worker request while its recorded attempt is active.
  const transport=globalThis.fetch;vi.stubGlobal('fetch',async(input:any,init:any)=>{
    const req=new Request(input,init);if(req.url.endsWith('/chat/completions')&&!pending){const saved=ledger.read(project),active=Object.values(saved.projection.requests).find(r=>r.state==='pending');if(active?.reservation.attribution?.kind==='task'){pending={...structuredClone(active.reservation),id:randomUUID()};await ledger.reserve(project,saved.projection.manifestHash,pending);}}
    return transport(input,init);
  });
  decide=async context=>context.outcomes[0].status==='failed'?retry(context):keepGoing(context);await execute(view.run.id);
  const execution=new ExecutionStore(join(runs.root,view.run.id),view.manifest),progress=coordinatorProgress(execution),before=workflowSnapshot(progress);expect(before.summary).not.toContain('attempt cost');
  await ledger.settle(project,ledger.read(project).projection.manifestHash,{requestId:pending!.id,outcome:'success',usage:{inputTokens:7,outputTokens:3}});
  const next=coordinatorProgress(execution),after=workflowSnapshot(next);expect(after.revision).toBe(before.revision);expect(after.accountingRevision).not.toBe(before.accountingRevision);expect(after.summary).toContain('attempt cost <$0.0001→<$0.0001');
  if(next.accounting?.status!=='available'||next.accounting.attribution?.status!=='available')throw Error('Missing attribution');
  const stale={...next.accounting.attribution,executionRevision:'a'.repeat(64)},history=projectImprovementHistory(view.manifest,next.execution,next.context,stale);
  expect(history.accounting).toMatchObject({status:'unavailable',revision:null});expect(history.cycles[0]!.metrics.find(m=>m.name==='provider-accounted-cost')).toMatchObject({before:null,after:null,comparable:false});
});

it('retains real verification after a truncated worker report and retries without accepting the cutoff as success',async()=>{
  truncateWorkers=1;decide=async context=>context.outcomes[0].status==='failed'?retry(context,'retry'):keepGoing(context);
  const view=await reviewed(),result=await execute(view.run.id);
  expect(result.status,JSON.stringify(result.execution.state.supervision)).toBe('completed');
  const outcomes=result.execution.events.filter(e=>e.change.type==='task_finished').map(e=>(e.change as any).output);
  expect(outcomes.map(o=>o.status)).toEqual(['failed','success']);expect(outcomes[0].summary).toContain('truncated');
  expect(outcomes[0].checks.every((c:any)=>c.passed)).toBe(true);expect(outcomes[0].artifacts.map((a:any)=>a.id)).toEqual(expect.arrayContaining(['patch','tests']));
  expect(JSON.stringify(outcomes)).not.toContain('forged-test');
  expect(result.execution.events.find(e=>e.change.type==='supervision_applied')?.change).toMatchObject({receipts:[{artifactId:'tests',exitCode:0,cleanupConfirmed:true}]});
  expect(commands.runIsolatedCommand).toHaveBeenCalledTimes(2);expect(result.execution.state.tasks['inspect-a']?.attempts).toBe(2);
  expect(replayExecution(result.execution.header,view.manifest,result.execution.events)).toEqual(result.execution.state);
});

// Reproduce the legacy cutoff boundary without rewriting any journal or fabricating receipts.
async function legacyCutoff(){
  truncateWorkers=1;decide=async context=>context.outcomes[0].status==='failed'?retry(context,'retry'):keepGoing(context);
  const spy=vi.spyOn(isolation,'verifyInWorktree').mockRejectedValueOnce(new Error('Worker stopped: length.'));
  try{
    const view=await reviewed(),result=await execute(view.run.id),store=new ExecutionStore(join(runs.root,view.run.id),view.manifest);
    expect(result.execution.state.tasks['inspect-a']).toMatchObject({status:'failed',attempts:1,artifactIds:[],output:{summary:'Worker stopped: length.'}});
    expect(result.execution.state.supervision?.halt?.reason).toContain('original verification');
    return{view,result,store,workspace:join(store.root,'worker-inspect-a-1','files'),ledger:new ReservationLedger(join(runs.root,view.run.id,'budget'))};
  }finally{spy.mockRestore();}
}

it('recovers legacy evidence through the JSON command after restart, retains history and forces a fresh bounded review',async()=>{
  const {view,result,store,workspace,ledger}=await legacyCutoff(),before=ledger.read(project),count=requests.length,lines:string[]=[];
  const file=fs.readFileSync(join(workspace,'a/report.txt')),identity=fs.statSync(workspace).ino;
  expect(await runOrchestrationCommand('run',['recover-evidence',view.run.id,'inspect-a','--allow-mutations','--json'],{cwd:project,store:new RunStore(runs.root),write:line=>lines.push(line)})).toBe(0);
  const recovered=store.read();expect(JSON.parse(lines[0]!)).toMatchObject({version:2,type:'orchestration.execution',action:'recover-evidence',data:{status:'failed'}});
  expect(recovered.events.slice(0,result.execution.events.length)).toEqual(result.execution.events);expect(recovered.header).toEqual(result.execution.header);
  expect(recovered.state.tasks['inspect-a']).toMatchObject({attempts:1,status:'failed',output:{testEvidence:['output-check','real-tests']}});
  expect(recovered.state.supervision).toMatchObject({rounds:1,stalledRounds:1,phase:'halted',decision:null,decisionId:null,reviewedHash:null,forceReview:true});
  expect(ledger.read(project)).toEqual(before);expect(requests).toHaveLength(count);expect(commands.runIsolatedCommand).toHaveBeenCalledTimes(1);
  expect(fs.statSync(workspace).ino).toBe(identity);expect(fs.readFileSync(join(workspace,'a/report.txt'))).toEqual(file);
  expect(replayExecution(recovered.header,view.manifest,recovered.events)).toEqual(recovered.state);
  await expect(recoverTaskEvidence(project,view.run.id,'inspect-a',{store:runs,approve:async()=> 'allow'})).rejects.toThrow('inactive isolated cutoff');
  await controlExecution(project,view.run.id,'controller-retry','coordinator',{store:runs});
  const next=await execute(view.run.id,{resume:true});expect(next.status).toBe('completed');expect(next.execution.state.tasks['inspect-a']?.attempts).toBe(2);expect(next.execution.state.supervision?.rounds).toBe(3);
  expect(requests.slice(count).map(r=>r.body.model)).toEqual(['controller-toy','worker-toy','worker-toy','controller-toy']);
});

it('requires explicit recovery approval and preserves all state when denied or already cancelled',async()=>{
  const {view,store,ledger}=await legacyCutoff(),before=store.read(),budget=ledger.read(project),count=requests.length,lines:string[]=[];
  expect(await runOrchestrationCommand('run',['recover-evidence',view.run.id,'inspect-a','--json'],{cwd:project,store:runs,write:line=>lines.push(line)})).toBe(3);
  expect(JSON.parse(lines[0]!).error.code).toBe('policy-denied');
  const controller=new AbortController();controller.abort();
  await expect(recoverTaskEvidence(project,view.run.id,'inspect-a',{store:runs,signal:controller.signal,approve:async()=> 'allow'})).rejects.toThrow();
  expect(store.read()).toEqual(before);expect(ledger.read(project)).toEqual(budget);expect(requests).toHaveLength(count);expect(commands.runIsolatedCommand).not.toHaveBeenCalled();
});

it('does not start cutoff verification after a shell denial or cancellation',async()=>{
  for(const cancel of [false,true]){
    truncateWorkers=1;const view=await reviewed(),controller=new AbortController();
    const result=await execute(view.run.id,{signal:controller.signal,approve:async(d:any)=>{if(d.request?.tool==='shell'){if(cancel)controller.abort();return 'reject';}return 'allow';}});
    expect(result.execution.state.tasks['inspect-a']?.status).toBe(cancel?'cancelled':'denied');expect(commands.runIsolatedCommand).not.toHaveBeenCalled();
  }
});

it('does not recreate missing baselines, budgets or workspaces or verify unrecorded changes',async()=>{
  const {view,store,workspace,ledger}=await legacyCutoff(),before=store.read();
  const recover=()=>recoverTaskEvidence(project,view.run.id,'inspect-a',{store:runs,approve:async()=> 'allow'});
  for(const path of [join(store.root,'workspace-base.json'),ledger.root,join(workspace,'..','identity.json'),workspace]){
    fs.renameSync(path,path+'.retained');try{await expect(recover()).rejects.toThrow();expect(fs.existsSync(path)).toBe(false);}finally{fs.renameSync(path+'.retained',path);}
  }
  fs.writeFileSync(join(workspace,'a/seed.txt'),'unrecorded replacement');await expect(recover()).rejects.toThrow('unrecorded or unauthorized');
  expect(store.read()).toEqual(before);expect(commands.runIsolatedCommand).not.toHaveBeenCalled();
});

it('rechecks approval, run ownership, stopped agents and the original deadline before recovery commands',async()=>{
  const {view,store}=await legacyCutoff(),before=store.read(),opts={store:runs,approve:async()=> 'allow' as const};
  const lease=store.acquire();try{await expect(recoverTaskEvidence(project,view.run.id,'inspect-a',opts)).rejects.toThrow('already owns');}finally{lease.release();}
  vi.spyOn(Date,'now').mockReturnValue(before.header.deadline+1);await expect(recoverTaskEvidence(project,view.run.id,'inspect-a',opts)).rejects.toThrow('deadline');vi.mocked(Date.now).mockRestore();
  expect(store.read()).toEqual(before);
  let stopped=false;
  await expect(recoverTaskEvidence(project,view.run.id,'inspect-a',{store:runs,approve:async()=>{if(!stopped){stopped=true;await controlExecution(project,view.run.id,'agent-stop','a',{store:runs});}return 'allow';}})).rejects.toThrow();
  expect(commands.runIsolatedCommand).not.toHaveBeenCalled();
});

it('retains real failed verification and never promotes recovered files to accepted work',async()=>{
  const {view,store,ledger}=await legacyCutoff(),before=ledger.read(project);verificationExits=[1];
  const result=await recoverTaskEvidence(project,view.run.id,'inspect-a',{store:runs,approve:async()=> 'allow'}),task=result.state.tasks['inspect-a']!;
  expect(task.status).toBe('failed');expect(task.output?.checks.find(c=>c.id==='real-tests')?.passed).toBe(false);
  const receipt=task.output!.artifacts.find(a=>a.id==='tests')!;expect(JSON.parse(fs.readFileSync(join(store.root,'artifacts',receipt.path),'utf8'))).toMatchObject({exitCode:1,outcome:'failed',cleanupConfirmed:true});
  await expect(controlExecution(project,view.run.id,'accept','inspect-a',{store:runs})).rejects.toThrow('not awaiting acceptance');expect(ledger.read(project)).toEqual(before);
});

it('cancels recovery verification promptly and keeps its process receipt without claiming success',async()=>{
  const {view,store,ledger}=await legacyCutoff(),before=ledger.read(project),controller=new AbortController();let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
  vi.mocked(commands.runIsolatedCommand).mockImplementationOnce(async(image,command,_mounts,signal)=>{
    ready();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));
    return{version:1,kind:'isolated-command',argv:command.argv,image,exitCode:-1,outcome:'cancelled',stdout:'',stderr:'',truncated:false,durationMs:1,container:'calliope-check-'+randomUUID(),cleanupConfirmed:true};
  });
  const pending=recoverTaskEvidence(project,view.run.id,'inspect-a',{store:runs,approve:async()=> 'allow',signal:controller.signal});await started;controller.abort();await expect(pending).rejects.toThrow();
  const result=store.read();expect(result.state).toMatchObject({status:'cancelled',ownerId:null,tasks:{'inspect-a':{status:'cancelled',attempts:1,artifactIds:['tests']}}});
  expect(ledger.read(project)).toEqual(before);expect(replayExecution(result.header,view.manifest,result.events)).toEqual(result.state);
});

it('records verification denial without running commands or replenishing attempts',async()=>{
  const {view,store}=await legacyCutoff();
  await expect(recoverTaskEvidence(project,view.run.id,'inspect-a',{store:runs,approve:async d=>d.request?.tool==='shell'?'reject':'allow'})).rejects.toThrow('denied');
  expect(store.read().state).toMatchObject({status:'denied',ownerId:null,tasks:{'inspect-a':{attempts:1,status:'denied',artifactIds:[]}}});expect(commands.runIsolatedCommand).not.toHaveBeenCalled();
});

it('rejects candidate changes during either approval and retains receipts if inputs change during execution',async()=>{
  for(const stage of ['recovery','shell','execution']){
    const {view,store,workspace}=await legacyCutoff(),file=join(workspace,'a/report.txt');let changed=false,recoveryApprovals=0;
    if(stage==='execution')vi.mocked(commands.runIsolatedCommand).mockImplementationOnce(async(image,command)=>{fs.writeFileSync(file,'changed during command');return{version:1,kind:'isolated-command',argv:command.argv,image,exitCode:0,outcome:'passed',stdout:'',stderr:'',truncated:false,durationMs:1,container:'calliope-check-'+randomUUID(),cleanupConfirmed:true};});
    const before=vi.mocked(commands.runIsolatedCommand).mock.calls.length;
    await expect(recoverTaskEvidence(project,view.run.id,'inspect-a',{store:runs,approve:async d=>{
      const tool=d.request?.tool;if(tool==='orchestration_evidence_recovery')recoveryApprovals++;
      if(!changed&&(stage==='shell'&&tool==='shell'||stage==='recovery'&&recoveryApprovals===2)){changed=true;fs.writeFileSync(file,'changed during approval');}
      return 'allow';
    }})).rejects.toThrow('changed');
    expect(commands.runIsolatedCommand).toHaveBeenCalledTimes(before+(stage==='execution'?1:0));
    expect(store.read().state.tasks['inspect-a']?.status).toBe('failed');
  }
});

it('requires execution history and binds recovery events to the exact legacy outcome',async()=>{
  const prepared=await reviewed();await expect(recoverTaskEvidence(project,prepared.run.id,'inspect-a',{store:runs})).rejects.toThrow('no execution history');
  const {view,store,result}=await legacyCutoff(),ownerId=randomUUID();
  await expect(store.appendBatch([{change:{type:'started',ownerId}},{change:{type:'task_recovery_started',taskId:'inspect-a',outcomeId:randomUUID()}}])).rejects.toThrow('cutoff attempt');
  expect(store.read()).toEqual(result.execution);
  const rows:string[]=[];await runOrchestrationCommand('run',['status',view.run.id],{cwd:project,store:runs,write:line=>rows.push(line)});expect(rows.join('')).toContain('run recover-evidence '+view.run.id+' inspect-a');
  const outcome=[...result.execution.events].reverse().find(e=>e.change.type==='task_finished')!;
  await store.appendBatch([{change:{type:'started',ownerId}},{change:{type:'task_recovery_started',taskId:'inspect-a',outcomeId:outcome.id}}]);
  const output=result.execution.state.tasks['inspect-a']!.output!;
  await expect(store.append({type:'task_finished',taskId:'inspect-a',status:'review_required',output:{...output,status:'partial'}})).rejects.toThrow('cannot accept');
  const recovered=await store.append({type:'task_finished',taskId:'inspect-a',status:'failed',output});await store.append({type:'finished',ownerId,status:'failed'});
  await expect(store.appendBatch([{change:{type:'started',ownerId}},{change:{type:'task_recovery_started',taskId:'inspect-a',outcomeId:recovered.id}}])).rejects.toThrow('one recovery');
});

it('rejects malformed recovery commands and unknown or non-cutoff tasks without side effects',async()=>{
  const {view,store}=await legacyCutoff(),before=store.read();
  for(const args of [['recover-evidence'],['recover-evidence',view.run.id],['recover-evidence',view.run.id,'inspect-a','extra'],['recover-evidence',view.run.id,'inspect-a','--max-output-tokens','2'],['recover-evidence',view.run.id,'missing']]){
    const lines:string[]=[];expect(await runOrchestrationCommand('run',[...args,'--json'],{cwd:project,store:runs,write:line=>lines.push(line)})).toBe(2);expect(JSON.parse(lines[0]!).error.code).toBe('invalid');
  }
  expect(store.read()).toEqual(before);expect(commands.runIsolatedCommand).not.toHaveBeenCalled();
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

it.each([false,true])('admits controller children against one recorded decision and original persistent budget (Smart %s)',async smart=>{
  const p=plan();if(smart){p.agents[0]!.routing={version:1,profile:'balanced',pool:[{provider:'deepseek',model:'controller-toy'}]};p.agents[0]!.childRouting={version:1,profile:'cost',pool:[{provider:'deepseek',model:'worker-toy'}]};p.agents[1]!.routing=structuredClone(p.agents[0]!.childRouting);p.agents[1]!.preference={provider:'auto'};}
  const child=structuredClone(p.agents[1]!),task=structuredClone(p.tasks[0]!);child.id='child';task.id='child-task';task.agentId=child.id;task.outputs.forEach(o=>o.id='child-'+o.id);task.outputs[0]!.path='a/child.txt';task.isolation!.patchArtifactId='child-patch';task.isolation!.commands[0]!.artifactId='child-tests';task.acceptanceChecks!.forEach(c=>c.artifactId='child-'+c.artifactId);
  decide=async context=>context.round===1?{...keepGoing(context),action:'decompose',hypothesis:'A second candidate supplies independent evidence.',expectedMetric:{name:'verified tasks',direction:'increase'},children:{version:1,parentId:'coordinator',agents:[child],tasks:[task]}}:keepGoing(context);
  const view=await reviewed(p),result=await execute(view.run.id);expect(result.status,JSON.stringify(result.execution.state.supervision)).toBe('completed');
  const graph=result.execution.state.graph!;expect(graph.admissions).toHaveLength(1);expect(graph.plan.tasks).toHaveLength(2);expect(graph.admissions[0]!.proposal.source).toMatchObject({kind:'supervision',eventId:result.execution.events.find(e=>e.change.type==='supervision_decided')!.id});
  const budget=new ReservationLedger(join(runs.root,view.run.id,'budget')).read(project);expect(budget.projection.childGrants).toHaveLength(1);expect(budget.manifest.accounts).toHaveLength(2);expect(result.execution.header.deadline).toBe(budget.manifest.deadline);
  if(smart){expect(result.execution.state.routes!.child!.route.model).toBe('worker-toy');expect(result.execution.state.routes!.coordinator!.route.model).toBe('controller-toy');expect(replayExecution(result.execution.header,view.manifest,result.execution.events)).toEqual(result.execution.state);}
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

it.each(['approve','reject'] as const)('keeps a child replan sequential at full graph capacity when its reviewer chooses %s',async verdict=>{
  const p=plan();p.limits.maxAgents=4;p.limits.maxTasks=2;p.limits.maxConcurrent=1;p.supervision!.maxStalledRounds=3;
  p.agents[1]!.maxChildDepth=1;p.agents[1]!.maxChildCount=1;
  const reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.preference.model='reviewer-toy';reviewer.maxChildDepth=0;reviewer.maxChildCount=0;p.agents.push(reviewer);p.supervision!.reviewerId='reviewer';
  const child=structuredClone(p.agents[1]!),task=structuredClone(p.tasks[0]!);child.id='child';child.parentId='a';child.maxChildDepth=0;child.maxChildCount=0;child.tokenBudget=8000;child.costBudgetUsd=0.1;
  task.id='child-task';task.agentId=child.id;task.outputs.forEach(o=>o.id='child-'+o.id);task.outputs[0]!.path='a/child.txt';task.isolation!.patchArtifactId='child-patch';task.isolation!.commands[0]!.artifactId='child-tests';task.acceptanceChecks!.forEach(c=>c.artifactId='child-'+c.artifactId);
  verificationExits=[1,1,0,0];
  decide=async context=>{
    if(context.role==='reviewer'){
      expect(context.draftEffect.draftHash).toBe(context.draftHash);
      if(context.round===2){expect(context.availability.remainingCapacity).toEqual({agents:0,tasks:0});expect(context.availability.retryTasks.find((t:any)=>t.id==='child-task').status).toBe('possible');expect(context.draftEffect).toMatchObject({action:'replan',retryTaskIds:['child-task'],newAgentIds:[],newTaskIds:[],maxConcurrent:1});}
      return{version:1,verdict:context.round===2?verdict:'approve',draftHash:context.draftHash,reason:'Independent review of the exact current action.'};
    }
    expect(context).not.toHaveProperty('draftEffect');
    return context.round===1?{...keepGoing(context),action:'decompose',hypothesis:'Collect diagnostic evidence.',expectedMetric:{name:'verified tasks',direction:'increase'},children:{version:1,parentId:'a',agents:[child],tasks:[task]}}:context.round===2?{...retry(context),taskId:'child-task',strategy:'Retry the child alone; after it passes, propose a separate original-task retry.'}:context.round===3?retry(context):keepGoing(context);
  };
  const view=await reviewed(p),result=await execute(view.run.id),finished=result.execution.events.filter(e=>e.change.type==='task_finished');
  expect(result.status).toBe(verdict==='approve'?'completed':'failed');expect(finished.map(e=>e.change.type==='task_finished'&&e.change.status)).toEqual(verdict==='approve'?['failed','failed','completed','completed']:['failed','failed']);
  expect(result.execution.state.graph!.admissions).toHaveLength(1);expect(result.execution.state.graph!.plan.limits).toEqual(p.limits);
  const history=await inspectImprovements(project,view.run.id,{store:runs});if(verdict==='approve'){expect(history.history.cycles[1]!.parentCycleId).toBe(history.history.cycles[0]!.id);expect(history.history.cycles[1]!.status).toBe('verified');}
  const calls=requests.length,store=new ExecutionStore(join(runs.root,view.run.id),view.manifest),fresh=store.read();expect(replayExecution(fresh.header,view.manifest,fresh.events)).toEqual(result.execution.state);expect(requests).toHaveLength(calls);
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
  const events=records.filter(r=>r.type==='improvement.event');expect(events.length).toBeGreaterThan(0);expect(events.every(r=>r.version===1&&r.runId===view.run.id&&r.event.version===(r.event.change.requestAttribution===1?6:r.event.change.type.startsWith('supervision_')?3:1)&&r.event.hash.length===64)).toBe(true);
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

it('records actual controller routing in Smart mode without granting mutation or changing the supervised loop',async()=>{
  const p=plan();p.agents[0]!.routing={version:1,profile:'balanced',pool:[{provider:'deepseek',model:'controller-toy'}]};p.agents[1]!.routing={version:1,profile:'cost',pool:[{provider:'deepseek',model:'worker-toy'}]};p.agents[1]!.preference={provider:'auto'};
  const view=await reviewed(p),result=await executeReviewedRun(project,view.run.id,{store:runs,approve:async()=> 'allow'});expect(result.status).toBe('completed');
  expect(result.execution.state.routes!.coordinator!.route).toMatchObject({model:'controller-toy',profile:'balanced',stage:'initial'});expect(result.execution.state.routes!.a!.route.model).toBe('worker-toy');
  const event=result.execution.events.find(e=>e.change.type==='agent_routed'&&e.change.agentId==='coordinator')!;expect(event.change).not.toHaveProperty('taskId');
  expect(replayExecution(result.execution.header,view.manifest,result.execution.events)).toEqual(result.execution.state);expect(requests.filter(r=>r.context.kind==='controller-review').every(r=>!r.body.tools?.length)).toBe(true);
},20000);
