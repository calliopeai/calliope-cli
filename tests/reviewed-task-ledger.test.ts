import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as config from '../src/config.js';
import {providerTarget} from '../src/health/target.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {prepareReviewedTaskLedger,prepareReviewedLedger,controlExecution,collectTaskOutput} from '../src/orchestration/index.js';
import {RemoteReservationLedger} from '../src/execution/remote-ledger.js';
import {connectDelegatedExecution,executionBinding,assertExecutionBinding} from '../src/execution/delegated.js';
import {ExecutionGuard} from '../src/execution/guard.js';
import {runLedgerCommand} from '../src/execution/ledger-cli.js';
import type {RouteCandidate} from '../src/routing/index.js';

let root:string,fixture:Awaited<ReturnType<typeof coordinatorRun>>,servers:Server[];
beforeEach(async()=>{
  config.resetConfig();saveHooks([]);servers=[];root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-task-host-')));
  const plan=verifiedPlan();plan.limits.timeBudgetMs=120000;for(const agent of plan.agents)agent.timeBudgetMs=120000;
  fixture=await coordinatorRun(root,plan);
});
afterEach(async()=>{
  vi.restoreAllMocks();for(const server of servers)if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  config.resetConfig();saveHooks([]);fs.rmSync(root,{recursive:true,force:true});
});
async function nativeStart(taskId='inspect-a',attempt=1){
  if(fixture.store.read().state.status!=='running')await fixture.store.append({type:'started',ownerId:randomUUID()});
  return fixture.store.append({type:'task_started',taskId,attempt,sessionId:randomUUID(),requestAttribution:1});
}
const prepare=(taskId='inspect-a',attempt=1,cap=10)=>prepareReviewedTaskLedger(fixture.project,fixture.view.run.id,taskId,attempt,cap,{store:fixture.runs});
async function listen(server:Server){servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
async function start(taskId='inspect-a',attempt=1,cap=10){const host=await prepare(taskId,attempt,cap);return {...host,url:await listen(host.server)};}
const connect=(url:string,token:string,agentId='a')=>RemoteReservationLedger.connect({url,token,root:join(root,'cache-'+randomUUID()),execution:{cwd:fixture.project,agentId}});
const request=()=>({id:randomUUID(),agentId:'a',provider:'deepseek',model:'fixture',target:providerTarget('deepseek').key,inputTokens:99,outputTokens:1,inputPrice:0,outputPrice:0,costNanos:0});
const post=async(url:string,token:string,op:string,body:object={})=>{
  const response=await fetch(`${url}/v1/${op}`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as Record<string,unknown>};
};

it('derives the exact native start, negotiates task execution and preserves the original allowance across restart',async()=>{
  const event=await nativeStart(),before=fixture.authority.ledger.read(fixture.project),host=await start();
  const attribution={version:1,kind:'task',eventId:event.id,eventHash:event.hash,sessionId:event.change.type==='task_started'?event.change.sessionId:'',taskId:'inspect-a',attempt:1};
  expect(host.execution.attribution).toEqual(attribution);expect(host.capability).toMatchObject({version:2,taskBinding:1,grants:'unavailable'});
  const client=await connect(host.url,host.ownerToken);
  expect(client.taskExecutionBinding).toEqual({attribution,maxOutputTokens:10});
  client.taskExecutionBinding!.attribution.taskId='tampered';expect(client.taskExecutionBinding!.attribution).toEqual(attribution);
  const saved={...request(),attribution:host.execution.attribution};await client.reserve(fixture.project,host.execution.manifestHash,saved);
  const restarted=await start();expect(restarted.ownerToken).toBe(host.ownerToken);
  const again=await connect(restarted.url,host.ownerToken);await again.reserve(fixture.project,host.execution.manifestHash,saved);
  expect(again.read(fixture.project).manifest).toEqual(before.manifest);expect(again.read(fixture.project).projection.spent.tokens).toBe(100);
});

it('refuses every forged attribution, absent attribution, excess output and other account without changing the ledger',async()=>{
  await nativeStart();const host=await start(),client=await connect(host.url,host.ownerToken),before=fixture.authority.ledger.read(fixture.project);
  const attribution=host.execution.attribution!;
  const mutations=[{eventId:randomUUID()},{eventHash:'f'.repeat(64)},{sessionId:randomUUID()},{taskId:'inspect-b'},{attempt:2},{kind:'supervision',role:'controller',round:1},{extra:true}];
  for(const mutation of mutations)await expect(client.reserve(fixture.project,host.execution.manifestHash,{...request(),attribution:{...attribution,...mutation} as never})).rejects.toMatchObject({code:'authority'});
  await expect(client.reserve(fixture.project,host.execution.manifestHash,request())).rejects.toMatchObject({code:'authority'});
  await expect(client.reserve(fixture.project,host.execution.manifestHash,{...request(),attribution,outputTokens:11})).rejects.toMatchObject({code:'budget'});
  for(const agentId of ['coordinator','b'])await expect(client.reserve(fixture.project,host.execution.manifestHash,{...request(),attribution,agentId})).rejects.toMatchObject({code:'authority'});
  expect(fixture.authority.ledger.read(fixture.project)).toEqual(before);
});

it('separates task, cap and legacy token audiences and refuses legacy execution or grant operations',async()=>{
  await nativeStart();await nativeStart('inspect-b');const host=await start(),other=await start('inspect-b'),narrow=await start('inspect-a',1,5);
  const legacy=await prepareReviewedLedger(fixture.project,fixture.view.run.id,'a',10,{store:fixture.runs}),legacyUrl=await listen(legacy.server);
  for(const url of [other.url,narrow.url,legacyUrl])await expect(connect(url,host.ownerToken)).rejects.toMatchObject({code:'authority'});
  await expect(connect(host.url,legacy.ownerToken)).rejects.toMatchObject({code:'authority'});
  await expect(connect(host.url,host.ownerToken,'b')).rejects.toMatchObject({code:'authority'});
  expect((await post(host.url,host.ownerToken,'hello')).body.operations).toEqual(['hello','journal','task-execution','reserve','settle']);
  for(const op of ['execution','grant','revoke'])expect((await post(host.url,host.ownerToken,op)).status).toBe(404);
});

it('a retry requires its new native start and cannot reuse the old credential or session binding',async()=>{
  await nativeStart();const original=await start(),binding=executionBinding(original.execution);
  const oldClient=await connect(original.url,original.ownerToken),saved={...request(),attribution:original.execution.attribution};
  await oldClient.reserve(fixture.project,original.execution.manifestHash,saved);
  await fixture.store.append({type:'task_finished',taskId:'inspect-a',status:'failed',output:{version:1,taskId:'inspect-a',agentId:'a',status:'failed',summary:'No accepted work.',changedFiles:[],artifacts:[],testEvidence:[],unresolvedRisks:[],recommendedNextAction:'Inspect.',checks:[]}});
  await fixture.store.append({type:'task_reset',taskId:'inspect-a',source:'manual'});await nativeStart('inspect-a',2);
  const retry=await start('inspect-a',2);expect(retry.ownerToken).not.toBe(original.ownerToken);
  await expect(connect(retry.url,original.ownerToken)).rejects.toMatchObject({code:'authority'});
  await expect(connect(original.url,original.ownerToken)).rejects.toMatchObject({code:'authority'});
  expect(()=>assertExecutionBinding(binding,retry.execution)).toThrow();
  const client=await connect(retry.url,retry.ownerToken);
  await expect(client.reserve(fixture.project,retry.execution.manifestHash,saved)).rejects.toMatchObject({code:'authority'});
  await expect(client.settle(fixture.project,retry.execution.manifestHash,{requestId:saved.id,outcome:'success',usage:{inputTokens:1,outputTokens:1}})).rejects.toMatchObject({code:'authority'});
  await oldClient.settle(fixture.project,original.execution.manifestHash,{requestId:saved.id,outcome:'success',usage:{inputTokens:1,outputTokens:1}});
  await client.reserve(fixture.project,retry.execution.manifestHash,{...request(),attribution:retry.execution.attribution});
  expect(client.taskExecutionBinding!.attribution.attempt).toBe(2);
});

it.each(['attribution','cap'] as const)('a live connection refuses a substituted %s response',async field=>{
  await nativeStart();const host=await start();let change=false;
  const transport:typeof fetch=async(input,init)=>{
    const response=await fetch(input,init);
    if(!change||!String(input).endsWith('/task-execution'))return response;
    const body=await response.json();
    if(field==='cap')body.binding.maxOutputTokens=9;else body.binding.attribution.eventHash='f'.repeat(64);
    return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  };
  const client=await RemoteReservationLedger.connect({url:host.url,token:host.ownerToken,root:join(root,'changed-response'),execution:{cwd:fixture.project,agentId:'a'},fetch:transport});
  const before=client.taskExecutionBinding;change=true;
  await expect(client.refreshAuthority(fixture.project,'a')).rejects.toMatchObject({code:'authority'});
  expect(client.taskExecutionBinding).toEqual(before);
});

it.each(['pending','unattributed','wrong-attempt','missing','invalid-cap'] as const)('refuses %s before creating a task host',async kind=>{
  if(kind==='unattributed'){
    await fixture.store.append({type:'started',ownerId:randomUUID()});
    await fixture.store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:randomUUID()});
  }else if(kind!=='pending')await nativeStart();
  await expect(prepare(kind==='missing'?'missing':'inspect-a',kind==='wrong-attempt'?2:1,kind==='invalid-cap'?0:10)).rejects.toThrow();
});

it('does not turn evidence recovery of an earlier owner attempt into new inference authority',async()=>{
  const plan=verifiedPlan();plan.version=3;plan.agents=plan.agents.slice(0,2);plan.tasks=plan.tasks.slice(0,1);
  plan.limits.timeBudgetMs=120000;plan.workspace.allowedTools.push('shell');plan.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
  for(const agent of plan.agents){agent.timeBudgetMs=120000;agent.allowedTools.push('shell');}
  const task=plan.tasks[0]!;task.outputs.push({id:'patch',kind:'patch',description:'Candidate diff.'},{id:'tests',kind:'test_result',description:'Verification result.'});
  task.isolation={patchArtifactId:'patch',commands:[{artifactId:'tests',argv:['node','check.js'],timeoutMs:3000}]};
  task.acceptanceChecks!.push({id:'real-tests',artifactId:'tests',kind:'command',criteria:['task:0','agent:0']});
  const directory=join(root,'recovery');fs.mkdirSync(directory);fixture=await coordinatorRun(directory,plan);
  await nativeStart();await prepare();
  await fixture.store.append({type:'tool',taskId:'inspect-a',callId:'write',name:'write_file',stage:'started',path:'a/report.txt',mutating:true,success:false});
  const outcome=await fixture.store.append({type:'task_finished',taskId:'inspect-a',status:'failed',output:{version:1,taskId:'inspect-a',agentId:'a',status:'failed',summary:'Worker stopped: length.',changedFiles:[],artifacts:[],testEvidence:[],unresolvedRisks:[],recommendedNextAction:'Inspect.',checks:[]}});
  await fixture.store.append({type:'started',ownerId:randomUUID()});
  await fixture.store.append({type:'task_recovery_started',taskId:'inspect-a',outcomeId:outcome.id});
  expect(fixture.store.read().state.tasks['inspect-a']!.status).toBe('running');
  await expect(prepare()).rejects.toMatchObject({code:'authority'});
});

it.each(['owner','stop','finished'] as const)('fences %s changes, including queued admission, while permitting prior replay and settlement',async change=>{
  await nativeStart();const host=await start(),client=await connect(host.url,host.ownerToken),saved={...request(),attribution:host.execution.attribution};
  await client.reserve(fixture.project,host.execution.manifestHash,saved);
  const ledger=host.execution.ledger,lock=join(ledger.root,'writer.lock');fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),original=ledger.reserve.bind(ledger);
  vi.spyOn(ledger,'reserve').mockImplementation((...args)=>{entered();return original(...args);});
  const pending=client.reserve(fixture.project,host.execution.manifestHash,{...request(),attribution:host.execution.attribution}).then(value=>({value}),error=>({error}));
  try{
    await waiting;
    if(change==='owner')await fixture.store.append({type:'started',ownerId:randomUUID()});
    else if(change==='stop')await controlExecution(fixture.project,fixture.view.run.id,'agent-stop','a',{store:fixture.runs});
    else await fixture.store.append({type:'task_finished',taskId:'inspect-a',status:'failed',output:{version:1,taskId:'inspect-a',agentId:'a',status:'failed',summary:'No accepted work.',changedFiles:[],artifacts:[],testEvidence:[],unresolvedRisks:[],recommendedNextAction:'Inspect.',checks:[]}});
  }finally{fs.unlinkSync(lock);}
  expect(await pending).toMatchObject({error:{code:'authority'}});
  expect(()=>new ExecutionGuard(host.execution,fixture.project)).toThrow();
  await expect(client.refreshAuthority(fixture.project,'a')).rejects.toMatchObject({code:'authority'});
  await client.reserve(fixture.project,host.execution.manifestHash,saved);
  await client.settle(fixture.project,host.execution.manifestHash,{requestId:saved.id,outcome:'success',usage:{inputTokens:5,outputTokens:1}});
  expect(ledger.read(fixture.project).projection.spent.tokens).toBe(6);
});

it('carries attribution and the host output cap through the delegated guard and session binding',async()=>{
  await nativeStart();const host=await start(),tokenFile=join(root,'task.token');fs.writeFileSync(tokenFile,host.ownerToken,{mode:0o600});
  const execution=await connectDelegatedExecution(fixture.project,{url:host.url,tokenFile,agentId:'a',maxOutputTokens:100});
  expect(execution.maxOutputTokens).toBe(10);expect(execution.attribution).toEqual(host.execution.attribution);
  const binding=executionBinding(execution);expect(binding).toMatchObject({version:2,attribution:host.execution.attribution});
  expect(()=>assertExecutionBinding(binding,execution)).not.toThrow();
  expect(()=>assertExecutionBinding(binding,{...execution,attribution:{...host.execution.attribution!,attempt:2}})).toThrow();
  const route={provider:'deepseek',model:'fixture',target:providerTarget('deepseek').key,evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:100,maxOutputTokens:100,price:{input:0,output:0},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'fixture'} as RouteCandidate;
  const quote=new ExecutionGuard(execution,fixture.project).budget(route,[{role:'user',content:'public fixture'}],[],false);
  await quote.reserve({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10});
  const admitted=Object.values(fixture.authority.ledger.read(fixture.project).projection.requests);
  expect(admitted).toHaveLength(1);expect(admitted[0]!.reservation.attribution).toEqual(host.execution.attribution);
});

it('serves task CLI metadata with a private token and refuses conflicting arguments',async()=>{
  await nativeStart();const file=join(root,'cli.token');
  const args=['serve-task','--run',fixture.view.run.id,'--task','inspect-a','--attempt','1','--max-output-tokens','10','--project',fixture.project,'--token-file',file];
  for(const suffix of [['--agent','a'],['--attempt','2'],['--budget',root],['--unknown','x']])expect(await runLedgerCommand([...args,...suffix],()=>{},{store:fixture.runs})).toBe(2);
  let line='';const running=runLedgerCommand(args,text=>{line+=text;},{store:fixture.runs});
  try{
    await vi.waitFor(()=>expect(line).toContain('url'));const output=JSON.parse(line),token=fs.readFileSync(file,'utf8');
    expect(output).toMatchObject({ownerAgentId:'a',reviewed:{version:2,taskBinding:1},attribution:{taskId:'inspect-a',attempt:1}});expect(line).not.toContain(token);
    if(process.platform!=='win32')expect(fs.statSync(file).mode&0o077).toBe(0);
    expect((await connect(output.url,token)).taskExecutionBinding!.attribution).toEqual(output.attribution);
  }finally{process.emit('SIGTERM');await expect(running).resolves.toBe(0);}
});

const smartPolicy=()=>({version:1 as const,profile:'cost' as const,pool:[{provider:'deepseek' as const,model:'initial'}],escalationPool:[{provider:'deepseek' as const,model:'escalated'}]});
async function smartFixture(preference={provider:'auto' as string},pool=smartPolicy()){
  const directory=join(root,'smart');fs.mkdirSync(directory);
  const plan=verifiedPlan();plan.limits.timeBudgetMs=120000;
  for(const agent of plan.agents)agent.timeBudgetMs=120000;
  plan.agents[1]!.routing=pool;plan.agents[1]!.preference=preference as (typeof plan.agents)[number]['preference'];
  delete plan.tasks[0]!.outputs[0]!.path;
  fixture=await coordinatorRun(directory,plan);
}
it('enforces the initial Smart pool on task and account hosts before spending',async()=>{
  await smartFixture();await nativeStart();
  const task=await start(),legacy=await prepareReviewedLedger(fixture.project,fixture.view.run.id,'a',10,{store:fixture.runs});
  for(const host of [task,{...legacy,url:await listen(legacy.server)}]){
    const client=await connect(host.url,host.ownerToken),before=fixture.authority.ledger.read(fixture.project);
    for(const choice of [{provider:'deepseek',model:'escalated'},{provider:'deepseek',model:'unreviewed'},{provider:'google',model:'initial'}])
      await expect(client.reserve(fixture.project,host.execution.manifestHash,{...request(),...choice,...(host===task?{attribution:task.execution.attribution}:{})})).rejects.toMatchObject({code:'authority'});
    expect(fixture.authority.ledger.read(fixture.project)).toEqual(before);
    await client.reserve(fixture.project,host.execution.manifestHash,{...request(),model:'initial',...(host===task?{attribution:task.execution.attribution}:{})});
  }
});
it.each([true,false])('opens escalation only for a task with retained failed-check evidence (%s)',async verified=>{
  await smartFixture();await nativeStart();
  const task=fixture.view.manifest.plan.tasks[0]!;
  const output=verified?(await collectTaskOutput(fixture.store,task,JSON.stringify({version:1,summary:'Failed check.',outputs:[{id:task.outputs[0]!.id,content:'does not meet check'}]}))).output:
    {version:1 as const,taskId:task.id,agentId:'a',status:'failed' as const,summary:'Provider failed.',changedFiles:[],artifacts:[],testEvidence:[],unresolvedRisks:[],recommendedNextAction:'Inspect.',checks:[]};
  await fixture.store.append({type:'task_finished',taskId:task.id,status:'failed',output});
  await fixture.store.append({type:'task_reset',taskId:task.id,source:'manual'});await nativeStart(task.id,2);
  const host=await start(task.id,2),client=await connect(host.url,host.ownerToken),before=fixture.authority.ledger.read(fixture.project);
  const denied=verified?'initial':'escalated',allowed=verified?'escalated':'initial';
  await expect(client.reserve(fixture.project,host.execution.manifestHash,{...request(),model:denied,attribution:host.execution.attribution})).rejects.toMatchObject({code:'authority'});
  expect(fixture.authority.ledger.read(fixture.project)).toEqual(before);
  await client.reserve(fixture.project,host.execution.manifestHash,{...request(),model:allowed,attribution:host.execution.attribution});
  const legacy=await prepareReviewedLedger(fixture.project,fixture.view.run.id,'a',10,{store:fixture.runs}),legacyClient=await connect(await listen(legacy.server),legacy.ownerToken);
  await expect(legacyClient.reserve(fixture.project,legacy.execution.manifestHash,{...request(),model:'escalated'})).rejects.toMatchObject({code:'authority'});
});
it.each([
  [{provider:'deepseek',model:'pinned'},'deepseek','pinned'],
  [{provider:'google'},'google','operator-model'],
  [{provider:'deepseek'},'deepseek','initial'],
])('preserves explicit reviewed preference %j with Smart routing',async(preference,provider,model)=>{
  await smartFixture(preference);await nativeStart();const host=await start(),client=await connect(host.url,host.ownerToken);
  await client.reserve(fixture.project,host.execution.manifestHash,{...request(),provider,model,target:providerTarget(provider as never).key,attribution:host.execution.attribution});
  const before=fixture.authority.ledger.read(fixture.project);
  await expect(client.reserve(fixture.project,host.execution.manifestHash,{...request(),provider:'anthropic',model:'outside',attribution:host.execution.attribution})).rejects.toMatchObject({code:'authority'});
  expect(fixture.authority.ledger.read(fixture.project)).toEqual(before);
});
