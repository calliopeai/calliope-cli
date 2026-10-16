import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {RunStore,prepareRun,changePreparedRun,prepareAgentExecution} from '../src/orchestration/index.js';
import {ExecutionGuard,ReservationLedger,ProjectSpendLedger,createLedgerServer,LedgerServerState,mintLedgerToken,RemoteReservationLedger,requestCostNanos,type AgentExecution,type ChildGrant} from '../src/execution/index.js';
import {projectBudgetPath} from '../src/budget.js';
import type {RouteCandidate} from '../src/routing/index.js';
import {toyPlan} from './helpers/orchestration-plan.js';

let root:string,project:string,store:RunStore,execution:AgentExecution,ledger:ReservationLedger,server:Server|undefined;
beforeEach(async()=>{
  config.resetConfig();saveHooks([]);
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-reviewed-ledger-')));
  project=join(root,'project');fs.mkdirSync(project);store=new RunStore(join(root,'runs'));
  const plan=toyPlan();plan.limits.timeBudgetMs=60000;for(const agent of plan.agents)agent.timeBudgetMs=60000;
  fs.writeFileSync(join(project,'plan.json'),JSON.stringify(plan));
  const prepared=await prepareRun(project,'plan.json',{store});await changePreparedRun(project,prepared.run.id,'approved',{store});
  execution=await prepareAgentExecution(project,prepared.run.id,'coordinator',10,{store});
  ledger=execution.ledger as ReservationLedger;
  expect(fs.existsSync(join(store.root,prepared.run.id,'execution'))).toBe(false);
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
const cancel=()=>changePreparedRun(project,ledger.read(project).manifest.runId,'cancelled',{store});
const request=()=>({id:randomUUID(),agentId:'coordinator',provider:'deepseek',model:'fixture',target:'a'.repeat(64),inputTokens:99,outputTokens:1,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(99,1,1,2)});
const budget=()=>{
  const route={provider:'deepseek',model:'fixture',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:100,maxOutputTokens:10,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'fixture'} as RouteCandidate;
  const quote=new ExecutionGuard(execution,project).budget(route,[{role:'user',content:'public fixture'}],[],false);
  return ()=>quote.reserve({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10});
};
const start=async()=>{
  const state=new LedgerServerState(join(root,'server')),manifest=ledger.read(project).manifest;
  server=createLedgerServer({ledger,cwd:project,state,assertAuthority:execution.assertAuthority});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  return RemoteReservationLedger.connect({url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,token:mintLedgerToken(state.secret(),{v:1,run:manifest.runId,role:'parent',exp:manifest.deadline}),root:join(root,'cache')});
};
const grant=():ChildGrant=>{
  const manifest=ledger.read(project).manifest;
  return {version:1,id:randomUUID(),proposalHash:'1'.repeat(64),previousGraphHash:manifest.planHash,planHash:'2'.repeat(64),runManifestHash:'3'.repeat(64),approvalRevision:randomUUID(),parentId:'coordinator',accounts:[{...manifest.accounts[1]!,id:'child',parentId:'coordinator',tokenBudget:100,costBudgetNanos:1000000}]};
};

it('revokes a saved prepared handle before any coordinator journal exists',async()=>{
  const reserve=budget();await reserve();const before=ledger.read(project);
  await cancel();
  expect(()=>new ExecutionGuard(execution,project)).toThrow(/approval.*revoked/i);
  await expect(reserve()).rejects.toMatchObject({code:'authority'});
  expect(ledger.read(project)).toEqual(before);
  await expect(prepareAgentExecution(project,before.manifest.runId,'coordinator',10,{store})).rejects.toMatchObject({code:'policy-denied'});
});

it('rechecks prepared approval inside the reservation lock and releases only proven non-admission',async()=>{
  const reserve=budget();await reserve();const before=ledger.read(project),spent=new ProjectSpendLedger(projectBudgetPath(project)).read().spentUsd;
  const lock=join(ledger.root,'writer.lock');fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),original=ledger.reserve.bind(ledger);
  vi.spyOn(ledger,'reserve').mockImplementation((...args)=>{entered();return original(...args);});
  const result=reserve().then(value=>({value}),error=>({error}));
  try{await waiting;await cancel();}finally{fs.unlinkSync(lock);}
  expect(await result).toMatchObject({error:{code:'authority'}});
  expect(ledger.read(project)).toEqual(before);
  expect(new ProjectSpendLedger(projectBudgetPath(project)).read().spentUsd).toBe(spent);
});

it('refuses new remote admission after cancellation while preserving replay, unknown spend and settlement',async()=>{
  const remote=await start(),saved=request();await remote.reserve(project,execution.manifestHash,saved);await cancel();
  await expect(remote.reserve(project,execution.manifestHash,request())).rejects.toMatchObject({code:'authority'});
  await expect(remote.grantChildren(project,execution.manifestHash,grant())).rejects.toMatchObject({code:'authority'});
  await remote.reserve(project,execution.manifestHash,saved);
  await remote.settle(project,execution.manifestHash,{requestId:saved.id,outcome:'cancelled'});
  expect(ledger.read(project).projection.requests[saved.id]!.state).toBe('unknown');
  expect(ledger.read(project).projection.spent.tokens).toBe(100);
  await new Promise<void>(resolve=>server!.close(()=>resolve()));
  const restarted=await start();await expect(restarted.reserve(project,execution.manifestHash,request())).rejects.toMatchObject({code:'authority'});
  expect(restarted.read(project).projection.spent.tokens).toBe(100);
});

it.each(['reserve','grant'] as const)('rechecks native run cancellation after remote %s waits for the writer',async operation=>{
  const remote=await start(),lock=join(ledger.root,'writer.lock');fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
  if(operation==='reserve'){const original=ledger.reserve.bind(ledger);vi.spyOn(ledger,'reserve').mockImplementation((...args)=>{entered();return original(...args);});}
  else{const original=ledger.grantChildren.bind(ledger);vi.spyOn(ledger,'grantChildren').mockImplementation((...args)=>{entered();return original(...args);});}
  const pending=operation==='reserve'?remote.reserve(project,execution.manifestHash,request()):remote.grantChildren(project,execution.manifestHash,grant());
  const result=pending.then(value=>({value}),error=>({error}));
  try{await waiting;await cancel();}finally{fs.unlinkSync(lock);}
  expect(await result).toMatchObject({error:{code:'authority'}});
  expect(ledger.read(project).events).toEqual([]);
});

it('accepts known late usage after cancellation without opening a new allowance',async()=>{
  const remote=await start(),saved=request();await remote.reserve(project,execution.manifestHash,saved);await cancel();
  await remote.settle(project,execution.manifestHash,{requestId:saved.id,outcome:'success',usage:{inputTokens:5,outputTokens:1}});
  expect(ledger.read(project).projection.spent.tokens).toBe(6);
  await expect(remote.reserve(project,execution.manifestHash,request())).rejects.toMatchObject({code:'authority'});
});

it('does not reissue a previously admitted child grant after run cancellation',async()=>{
  const remote=await start(),child=grant();await remote.grantChildren(project,execution.manifestHash,child);
  const before=ledger.read(project);await cancel();
  await expect(remote.grantChildren(project,execution.manifestHash,child)).rejects.toMatchObject({code:'authority'});
  expect(ledger.read(project)).toEqual(before);
});

it.each(['missing','damaged'] as const)('fails closed when the prepared run approval is %s',async mode=>{
  const remote=await start(),reserve=budget(),head=join(store.root,ledger.read(project).manifest.runId,'head.json');
  if(mode==='missing')fs.unlinkSync(head);else fs.writeFileSync(head,'{}');
  await expect(reserve()).rejects.toThrow();
  await expect(remote.reserve(project,execution.manifestHash,request())).rejects.toMatchObject({code:'unavailable'});
  expect(ledger.read(project).events).toEqual([]);
});
