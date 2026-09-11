import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ReservationLedger,manifestHash,effectiveExecutionManifest,replayReservations,ExecutionGuard,requestCostNanos,type ExecutionManifest,type ChildGrant} from '../src/execution/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
let root:string,project:string,manifest:ExecutionManifest,ledger:ReservationLedger,hash:string;
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-child-budget-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);manifest=executionManifest(project);manifest.tokenBudget=manifest.accounts[0]!.tokenBudget=10000;manifest.costBudgetNanos=manifest.accounts[0]!.costBudgetNanos=50000000;ledger=new ReservationLedger(join(root,'budget'));ledger.create(manifest);hash=manifestHash(manifest);});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
const grant=(id='child',tokens=2000):ChildGrant=>({version:1,id:randomUUID(),proposalHash:'b'.repeat(64),previousGraphHash:manifest.planHash,planHash:'c'.repeat(64),runManifestHash:'d'.repeat(64),approvalRevision:randomUUID(),parentId:'root',accounts:[{...structuredClone(manifest.accounts[1]!),id,parentId:'root',tokenBudget:tokens,costBudgetNanos:5000000}]});
const request=(agentId:string,tokens:number)=>({id:randomUUID(),agentId,provider:'deepseek',model:'toy',target:'a'.repeat(64),inputTokens:tokens-1,outputTokens:1,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(tokens-1,1,1,2)});
it('records child authority without creating provider usage and preserves the original manifest across restart',async()=>{
  const g=grant(),state=await ledger.grantChildren(project,hash,g);expect(state).toMatchObject({version:2,manifestHash:hash,spent:{tokens:0,costNanos:0},requests:{},childGrants:[{grant:g}]});
  const saved=new ReservationLedger(ledger.root).read(project);expect(saved.manifest).toEqual(manifest);expect(saved.events[0]!.version).toBe(2);expect(replayReservations(saved.manifest,saved.events)).toEqual(state);expect(effectiveExecutionManifest(saved.manifest,state).accounts.map(a=>a.id)).toEqual(['root','a','b','child']);
  const guard=new ExecutionGuard({ledger,manifestHash:hash,agentId:'child',maxOutputTokens:100},project);expect(guard.manifest.deadline).toBe(manifest.deadline);expect(guard.check({id:'test',name:'write_file',arguments:{path:'b/file'}})).toMatch(/scope/);
  await ledger.grantChildren(project,hash,g);expect(ledger.read(project).events).toHaveLength(1);
});
it('retains unknown charges and refuses to allocate capacity already charged to parent work',async()=>{
  const r=request('root',5000);await ledger.reserve(project,hash,r);await ledger.settle(project,hash,{requestId:r.id,outcome:'cancelled'});await expect(ledger.grantChildren(project,hash,grant())).rejects.toMatchObject({code:'budget'});expect(ledger.read(project).projection.spent.tokens).toBe(5000);
});
it('protects granted children from parent borrowing and charges actual descendant requests through every ancestor',async()=>{
  const g=grant();await ledger.grantChildren(project,hash,g);await expect(ledger.reserve(project,hash,request('root',4001))).rejects.toMatchObject({code:'budget'});
  const r=request('child',1000),state=await ledger.reserve(project,hash,r);expect(state.accounts.child!.tokens).toBe(1000);expect(state.accounts.root!.tokens).toBe(1000);expect(state.requests[r.id]!.state).toBe('pending');
  const settled=await ledger.settle(project,hash,{requestId:r.id,outcome:'success',usage:{inputTokens:9,outputTokens:1}});expect(settled.spent.tokens).toBe(10);expect(settled.childGrants).toEqual(state.childGrants);
});
it('serializes simultaneous grants and rejects stale graph parents without losing the winning allocation',async()=>{
  const a=grant('child-a'),b={...grant('child-b'),proposalHash:'e'.repeat(64),planHash:'f'.repeat(64)},results=await Promise.allSettled([a,b].map(g=>ledger.grantChildren(project,hash,g)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(ledger.read(project).projection.childGrants).toHaveLength(1);expect(ledger.read(project).projection.spent.tokens).toBe(0);
  const saved=ledger.read(project).projection.childGrants![0]!.grant;await expect(ledger.grantChildren(project,hash,{...saved,planHash:'0'.repeat(64)})).rejects.toMatchObject({code:'conflict'});
});
it('resolves a grant racing a provider request under one writer lock without oversubscribing either',async()=>{
  const choices=await Promise.allSettled([ledger.grantChildren(project,hash,grant('large-child',5000)),ledger.reserve(project,hash,request('root',3500))]);expect(choices.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const state=ledger.read(project).projection;expect((state.childGrants?.length??0)+(Object.keys(state.requests).length)).toBe(1);
});
it('allows nested child grants only within inherited scope, original deadlines and unspent child capacity',async()=>{
  const first=grant();await ledger.grantChildren(project,hash,first);const second={...grant('grandchild',500),parentId:'child',proposalHash:'e'.repeat(64),previousGraphHash:first.planHash,planHash:'f'.repeat(64)};second.accounts[0]!.parentId='child';second.accounts[0]!.costBudgetNanos=1000000;
  await ledger.grantChildren(project,hash,second);const saved=ledger.read(project);expect(effectiveExecutionManifest(saved.manifest,saved.projection).accounts.at(-1)!.deadline).toBe(manifest.deadline);
  const r=request('grandchild',300);await ledger.reserve(project,hash,r);expect(ledger.read(project).projection.accounts.child!.tokens).toBe(300);expect(ledger.read(project).projection.accounts.root!.tokens).toBe(300);
});
it('rejects malformed, aliased or expanded account authority and expired grants without altering history',async()=>{
  for(const mutate of [(g:ChildGrant)=>g.accounts.push({...g.accounts[0]!}),(g:ChildGrant)=>{g.accounts[0]!.allowedPaths=[{path:'../outside',access:'write'}];},(g:ChildGrant)=>{g.accounts[0]!.allowedTools.push('shell');},(g:ChildGrant)=>{g.accounts[0]!.deadline++;},(g:ChildGrant)=>{g.accounts[0]!.parentId=null;},(g:ChildGrant)=>{g.accounts[0]!.id='root';}]){const g=grant();mutate(g);await expect(ledger.grantChildren(project,hash,g)).rejects.toThrow();}
  await expect(new ReservationLedger(ledger.root,()=>manifest.deadline+1).grantChildren(project,hash,grant())).rejects.toMatchObject({code:'deadline'});expect(ledger.read(project).events).toHaveLength(0);
});
it('cancels before a grant commits and retains a completed grant when activation fails later',async()=>{
  const controller=new AbortController();await expect(ledger.grantChildren(project,hash,grant(),controller.signal,()=>controller.abort())).rejects.toMatchObject({name:'AbortError'});expect(ledger.read(project).events).toHaveLength(0);
  const g=grant(),allocated=await ledger.grantChildren(project,hash,g);expect(new ReservationLedger(ledger.root).read(project).projection).toEqual(allocated);await ledger.grantChildren(project,hash,g);expect(ledger.read(project).events).toHaveLength(1);
});
