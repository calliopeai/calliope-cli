import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {RunStore,prepareRun,changePreparedRun,prepareAgentExecution,ExecutionStore,activeRemoteTasks,type RunInspection} from '../src/orchestration/index.js';
import {ReservationLedger,ExecutionGuard,ProjectSpendLedger,parentRequestId,acquireParentTask,readParentBudgetAccounting,validateExecutionManifest,createLedgerServer,LedgerServerState,mintLedgerToken,RemoteReservationLedger,type AgentExecution,type ParentBudgetLink} from '../src/execution/index.js';
import {projectBudgetPath} from '../src/budget.js';
import type {RouteCandidate} from '../src/routing/index.js';
import {toyPlan} from './helpers/orchestration-plan.js';

let root:string,project:string,store:RunStore,server:Server|undefined;
beforeEach(()=>{
  config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-parent-budget-')));
  project=join(root,'project');fs.mkdirSync(project);store=new RunStore(join(root,'runs'));
});
afterEach(async()=>{
  vi.restoreAllMocks();if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;
  config.resetConfig();saveHooks([]);
  if(process.platform==='darwin'){
    const open=spawnSync('/usr/sbin/lsof',['-nP','+D',root],{encoding:'utf8'});
    expect({status:open.status,stdout:open.stdout,stderr:open.stderr}).toEqual({status:1,stdout:'',stderr:''});
  }
  fs.rmSync(root,{recursive:true,force:true});
});
async function reviewed(tokens=4000,cost=0.04,wall=20000){
  const plan=toyPlan();Object.assign(plan.limits,{tokenBudget:tokens,costBudgetUsd:cost,timeBudgetMs:wall});
  for(const agent of plan.agents)Object.assign(agent,{tokenBudget:agent.parentId?Math.floor(tokens/4):tokens,costBudgetUsd:agent.parentId?cost/4:cost,timeBudgetMs:wall});
  const file=randomUUID()+'.json';fs.writeFileSync(join(project,file),JSON.stringify(plan));
  const view=await prepareRun(project,file,{store});return changePreparedRun(project,view.run.id,'approved',{store});
}
const execution=(view:RunInspection,parentBudget?:ParentBudgetLink)=>prepareAgentExecution(project,view.run.id,'coordinator',10,{store,parentBudget});
const link=(view:RunInspection,exec:AgentExecution):ParentBudgetLink=>({version:1,runsRoot:store.root,runId:view.run.id,runManifestHash:view.manifest.hash,approvalRevision:view.run.revision,budgetManifestHash:exec.manifestHash,agentId:'coordinator'});
async function parent(tokens=5000,cost=0.05){const view=await reviewed(tokens,cost,300000),exec=await execution(view);return {view,exec,link:link(view,exec)};}
const request=(tokens=100,id=randomUUID())=>({id,agentId:'coordinator',provider:'deepseek',model:'fixture',target:'a'.repeat(64),inputTokens:tokens-1,outputTokens:1,inputPrice:0,outputPrice:0,costNanos:0});
const snapshot=(exec:AgentExecution)=>exec.ledger.read(project);
const reserve=(exec:AgentExecution,value=request())=>exec.ledger.reserve(project,exec.manifestHash,value);

it('concurrent independent runs share one allowance and reopening cannot omit it',async()=>{
  const p=await parent(),aView=await reviewed(),a=await execution(aView,p.link),b=await execution(await reviewed(),p.link);
  const results=await Promise.allSettled([reserve(a,request(3000)),reserve(b,request(3000))]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.find(result=>result.status==='rejected')).toMatchObject({reason:{code:'budget'}});
  expect(snapshot(p.exec).projection.spent.tokens).toBe(3000);
  const again=await execution(aView);expect(snapshot(again).manifest).toEqual(snapshot(a).manifest);
  await expect(reserve(again,request(3000))).rejects.toMatchObject({code:'budget'});
  expect(snapshot(p.exec).projection.spent.tokens).toBe(3000);
});

it('charges every funding ancestor and gives sibling request UUIDs independent identities',async()=>{
  const p=await parent(10000),aView=await reviewed(),a=await execution(aView,p.link);
  const b=await execution(await reviewed(1000,0.01,5000),link(aView,a)),c=await execution(await reviewed(),p.link),id=randomUUID();
  await reserve(b,request(100,id));await reserve(c,request(100,id));
  expect(snapshot(b).projection.spent.tokens).toBe(100);expect(snapshot(a).projection.spent.tokens).toBe(100);
  expect(snapshot(p.exec).projection.spent.tokens).toBe(200);
  expect(Object.keys(snapshot(p.exec).projection.requests)).toHaveLength(2);
  expect(parentRequestId(snapshot(b).manifest,id)).not.toBe(parentRequestId(snapshot(c).manifest,id));
});

it('cannot change, remove, or add a parent to an already created budget',async()=>{
  const p=await parent(),other=await parent(),view=await reviewed(),child=await execution(view,p.link),plainView=await reviewed();await execution(plainView);
  await expect(execution(view,other.link)).rejects.toMatchObject({code:'conflict'});
  await expect(execution(plainView,p.link)).rejects.toMatchObject({code:'conflict'});
  const reopened=await execution(view);expect(snapshot(reopened).manifest.parent).toEqual(p.link);expect(snapshot(reopened).manifest).toEqual(snapshot(child).manifest);
});

it.each(['tokens','cost','deadline','scope','revision','hash'] as const)('refuses a child with a foreign or expanded %s before creating its ledger',async field=>{
  const p=await parent(),parentLink={...p.link};
  if(field==='scope')parentLink.agentId='a';
  if(field==='revision')parentLink.approvalRevision=randomUUID();
  if(field==='hash')parentLink.budgetManifestHash='b'.repeat(64);
  const view=await reviewed(field==='tokens'?6000:4000,field==='cost'?0.06:0.04,field==='deadline'?400000:20000);
  await expect(execution(view,parentLink)).rejects.toThrow();
  expect(fs.existsSync(join(store.root,view.run.id,'budget'))).toBe(false);
  expect(snapshot(p.exec).events).toEqual([]);
});

it('rejects malformed persisted parent manifests instead of reading them as unfunded',async()=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),m=snapshot(child).manifest;
  for(const bad of [{...m,version:1},{...m,parent:undefined},{...m,version:'2'},{...m,parent:{...p.link,runsRoot:'../runs'}},{...m,parent:{...p.link,extra:true}}])expect(()=>validateExecutionManifest(bad)).toThrow();
});

it('cancelling the parent fences children during a parent writer wait without refreshing their clocks',async()=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),before=snapshot(child),lock=join(p.exec.ledger.root,'writer.lock');fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),original=ReservationLedger.prototype.reserve;
  vi.spyOn(ReservationLedger.prototype,'reserve').mockImplementation(function(...args){if(this.root===p.exec.ledger.root)entered();return original.apply(this,args);});
  const result=reserve(child).then(value=>({value}),error=>({error}));
  try{await waiting;await changePreparedRun(project,p.view.run.id,'cancelled',{store});}finally{fs.unlinkSync(lock);}
  expect(await result).toMatchObject({error:{code:'authority'}});
  expect(snapshot(p.exec).events).toEqual([]);expect(snapshot(child)).toEqual(before);
  expect(()=>new ExecutionGuard(child,project)).toThrow(/approval.*revoked/i);
});

it('retains an interrupted parent charge and reconciles the same child request without charging twice',async()=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),value=request(),parentId=parentRequestId(snapshot(child).manifest,value.id);
  await expect(child.ledger.reserve(project,child.manifestHash,value,undefined,()=>{if(snapshot(p.exec).projection.requests[parentId])throw new Error('interrupted after parent commit');})).rejects.toThrow('interrupted');
  expect(snapshot(child).events).toEqual([]);expect(snapshot(p.exec).projection.spent.tokens).toBe(100);
  await reserve(child,value);expect(snapshot(child).projection.spent.tokens).toBe(100);expect(snapshot(p.exec).projection.spent.tokens).toBe(100);
  expect(Object.keys(snapshot(p.exec).projection.requests)).toHaveLength(1);
});

it('settles known usage once after cancellation and recovers an interrupted ancestor settlement',async()=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),value=request();await reserve(child,value);
  await changePreparedRun(project,p.view.run.id,'cancelled',{store});
  const head=join(store.root,p.view.run.id,'head.json'),held=head+'.held';fs.renameSync(head,held);
  const settlement={requestId:value.id,outcome:'success' as const,usage:{inputTokens:5,outputTokens:1}};
  try{await expect(child.ledger.settle(project,child.manifestHash,settlement)).rejects.toThrow();}finally{fs.renameSync(held,head);}
  expect(snapshot(child).projection.spent.tokens).toBe(6);expect(snapshot(p.exec).projection.spent.tokens).toBe(100);
  await child.ledger.settle(project,child.manifestHash,settlement);await child.ledger.settle(project,child.manifestHash,settlement);
  expect(snapshot(p.exec).projection.spent.tokens).toBe(6);
  await expect(child.ledger.settle(project,child.manifestHash,{...settlement,usage:{inputTokens:1,outputTokens:1}})).rejects.toMatchObject({code:'conflict'});
  await expect(reserve(child)).rejects.toMatchObject({code:'authority'});
});

it.each(['cancelled','invalid-usage'] as const)('retains %s usage through every ancestor',async outcome=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),value=request();await reserve(child,value);
  await child.ledger.settle(project,child.manifestHash,{requestId:value.id,outcome});
  expect(snapshot(p.exec).projection.spent.tokens).toBe(100);expect(snapshot(child).projection.spent.tokens).toBe(100);
  expect(snapshot(p.exec).projection.exceeded).toBe(outcome==='invalid-usage');
  if(outcome==='invalid-usage')await expect(reserve(child)).rejects.toMatchObject({code:'budget'});
});

it('uses parent funding through the provider guard without double-charging the project ledger',async()=>{
  const p=await parent(800),a=await execution(await reviewed(600),p.link),b=await execution(await reviewed(600),p.link);
  const route={provider:'deepseek',model:'fixture',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:500,maxOutputTokens:10,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'fixture'} as RouteCandidate;
  const quote=(exec:AgentExecution)=>new ExecutionGuard(exec,project).budget(route,[{role:'user',content:'public fixture'}],[],false);
  const first=quote(a),second=quote(b),attempt={provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10};
  const id=await first.reserve(attempt);await expect(second.reserve(attempt)).rejects.toMatchObject({code:'budget'});
  expect(new ProjectSpendLedger(projectBudgetPath(project)).read().spentUsd).toBe(0.00052);
  await first.settle(id,'success',{inputTokens:5,outputTokens:2});
  expect(snapshot(p.exec).projection.spent.tokens).toBe(7);expect(new ProjectSpendLedger(projectBudgetPath(project)).read().spentUsd).toBe(0.000009);
  await second.reserve(attempt);expect(snapshot(p.exec).projection.spent.tokens).toBe(517);
});

it('a served child ledger enforces persisted parent funding without a client-supplied lifecycle hook',async()=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),state=new LedgerServerState(join(root,'server'));
  server=createLedgerServer({ledger:child.ledger as ReservationLedger,cwd:project,state});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const m=snapshot(child).manifest,token=mintLedgerToken(state.secret(),{v:1,role:'parent',run:m.runId,exp:m.deadline});
  const remote=await RemoteReservationLedger.connect({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,token,root:join(root,'cache')}),value=request();
  await remote.reserve(project,child.manifestHash,value);await changePreparedRun(project,p.view.run.id,'cancelled',{store});
  await expect(remote.reserve(project,child.manifestHash,request())).rejects.toMatchObject({code:'authority'});
  await remote.settle(project,child.manifestHash,{requestId:value.id,outcome:'cancelled'});
  expect(snapshot(p.exec).projection.spent.tokens).toBe(100);
});

it('reads shared account balances without creating execution, changing clocks or exposing provider details',async()=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),value={...request(),inputPrice:1,outputPrice:2,costNanos:101000};
  await reserve(child,value);
  const before=snapshot(p.exec),first=await readParentBudgetAccounting(snapshot(child).manifest,project);
  expect(first).toMatchObject({version:1,status:'available',basis:'reservations-and-settlements',parents:[{
    runId:p.view.run.id,agentId:'coordinator',authority:'active',deadline:before.manifest.deadline,
    tokens:{limit:5000,accounted:100,remaining:4900},costNanos:{limit:50000000,accounted:101000,remaining:49899000},requests:{pending:1,settled:0,unknown:0,exceeded:0}}]});
  expect(JSON.stringify(first)).not.toMatch(/deepseek|fixture|runsRoot|allowedPaths|target|inputPrice/);
  expect(snapshot(p.exec)).toEqual(before);expect(fs.existsSync(join(store.root,p.view.run.id,'execution'))).toBe(false);
  await child.ledger.settle(project,child.manifestHash,{requestId:value.id,outcome:'success',usage:{inputTokens:5,outputTokens:1}});
  const next=await readParentBudgetAccounting(snapshot(child).manifest,project);
  expect(next).toMatchObject({status:'available',parents:[{tokens:{accounted:6},costNanos:{accounted:7000},requests:{settled:1}}]});
  if(next.status!=='available'||first.status!=='available')throw Error('Missing balances');
  expect(next.parents[0]!.revision).not.toBe(first.parents[0]!.revision);
});

it('retains unknown charges and balances while reporting cancelled parent authority',async()=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),value=request();await reserve(child,value);
  await child.ledger.settle(project,child.manifestHash,{requestId:value.id,outcome:'cancelled'});
  await changePreparedRun(project,p.view.run.id,'cancelled',{store});const before=snapshot(p.exec);
  expect(await readParentBudgetAccounting(snapshot(child).manifest,project)).toMatchObject({status:'available',parents:[{authority:'inactive',tokens:{accounted:100,remaining:4900},requests:{unknown:1}}]});
  expect(snapshot(p.exec)).toEqual(before);
});

it('shows each funding ancestor independently and retains expired or exceeded accounting',async()=>{
  const p=await parent(10000),aView=await reviewed(),a=await execution(aView,p.link),b=await execution(await reviewed(1000,0.01,5000),link(aView,a));
  const value=request();await reserve(b,value);
  expect(await readParentBudgetAccounting(snapshot(b).manifest,project)).toMatchObject({status:'available',parents:[{runId:aView.run.id,tokens:{accounted:100}},{runId:p.view.run.id,tokens:{accounted:100}}]});
  const clock=vi.spyOn(Date,'now').mockReturnValue(snapshot(p.exec).manifest.deadline+1);
  expect(await readParentBudgetAccounting(snapshot(b).manifest,project)).toMatchObject({status:'available',parents:[{authority:'expired'},{authority:'expired'}]});clock.mockRestore();
  await b.ledger.settle(project,b.manifestHash,{requestId:value.id,outcome:'invalid-usage'});
  expect(await readParentBudgetAccounting(snapshot(b).manifest,project)).toMatchObject({status:'available',parents:[{authority:'exceeded',requests:{exceeded:1}},{authority:'exceeded',requests:{exceeded:1}}]});
});

it('reports unavailable funding without replacing damaged histories with zero balances',async()=>{
  const p=await parent(),child=await execution(await reviewed(),p.link),manifest=snapshot(child).manifest;
  const file=join(p.exec.ledger.root,'history.json'),raw=fs.readFileSync(file);
  for(const content of ['PRIVATE malformed state',null]){
    if(content===null)fs.unlinkSync(file);else fs.writeFileSync(file,content);
    expect(await readParentBudgetAccounting(manifest,project)).toEqual({version:1,status:'unavailable'});
    expect(fs.existsSync(file)).toBe(content!==null);if(content!==null)expect(fs.readFileSync(file,'utf8')).toBe(content);
    fs.writeFileSync(file,raw,{mode:0o600});
  }
  const elsewhere=join(root,'elsewhere');fs.mkdirSync(elsewhere);
  expect(await readParentBudgetAccounting(manifest,elsewhere)).toEqual({version:1,status:'unavailable'});
  expect(await readParentBudgetAccounting(manifest,project,AbortSignal.abort())).toEqual({version:1,status:'unavailable'});
  expect(await readParentBudgetAccounting(snapshot(p.exec).manifest,project)).toEqual({version:1,status:'unlinked'});
});


it('shares native task capacity through every local funding ancestor and releases it idempotently',async()=>{
 const p=await parent(),middleView=await reviewed(),middle=await execution(middleView,p.link),leafView=await reviewed(1000,.01,5000),leaf=await execution(leafView,link(middleView,middle));
 const attribution={version:1 as const,kind:'task' as const,taskId:'nested-work',attempt:1,eventId:randomUUID(),eventHash:'a'.repeat(64),sessionId:randomUUID()};
 const ticket=await acquireParentTask(snapshot(leaf).manifest,project,'coordinator',attribution);
 const parentStore=new ExecutionStore(join(store.root,p.view.run.id),p.view.manifest),middleStore=new ExecutionStore(join(store.root,middleView.run.id),middleView.manifest);
 expect(activeRemoteTasks(parentStore.read().state)).toMatchObject([{runId:leafView.run.id,startEventId:attribution.eventId}]);
 expect(activeRemoteTasks(middleStore.read().state)).toMatchObject([{runId:leafView.run.id,startEventId:attribution.eventId}]);
 await ticket!.release();await ticket!.release();
 expect(activeRemoteTasks(parentStore.read().state)).toEqual([]);expect(activeRemoteTasks(middleStore.read().state)).toEqual([]);
});
