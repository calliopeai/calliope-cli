import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ReservationLedger,manifestHash,replayReservations,requestCostNanos,MAX_RESERVATION_BYTES,type ExecutionManifest,type RequestReservation,type ReservationEvent} from '../src/execution/index.js';
import {canonicalJson,digest} from '../src/approvals/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
let root:string,project:string,manifest:ExecutionManifest,ledger:ReservationLedger;
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-budget-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);manifest=executionManifest(project);ledger=new ReservationLedger(join(root,'budget'));});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
const request=(agentId='a',inputTokens=900,outputTokens=100):RequestReservation=>({id:randomUUID(),agentId,provider:'openai',model:'toy',target:'b'.repeat(64),inputTokens,outputTokens,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(inputTokens,outputTokens,1,2)});
it('reserves against every ancestor before dispatch, then settles exactly once after restart',async()=>{
  ledger.create(manifest);const hash=manifestHash(manifest),r=request();
  const reserved=await ledger.reserve(project,hash,r);expect(reserved.spent).toEqual({tokens:1000,costNanos:1100000});expect(reserved.accounts.root).toEqual(reserved.accounts.a);expect(reserved.accounts.b!.tokens).toBe(0);
  const restarted=new ReservationLedger(ledger.root);expect(restarted.read(project).projection).toEqual(reserved);
  const settled=await restarted.settle(project,hash,{requestId:r.id,outcome:'success',usage:{inputTokens:10,outputTokens:2}});
  expect(settled.spent).toEqual({tokens:12,costNanos:14000});const saved=restarted.read(project);expect(replayReservations(saved.manifest,saved.events)).toEqual(settled);
  await expect(restarted.settle(project,hash,{requestId:r.id,outcome:'success',usage:{inputTokens:0,outputTokens:0}})).rejects.toMatchObject({code:'conflict'});
  for(const p of [ledger.root,join(ledger.root,'history.json')])expect(fs.statSync(p).mode&0o777).toBe(p===ledger.root?0o700:0o600);
});
it('serializes concurrent callers and denies a request that cannot fit the remaining leaf/run capacity',async()=>{
  manifest.accounts[1]!.tokenBudget=1000;ledger.create(manifest);const hash=manifestHash(manifest);
  const results=await Promise.allSettled([0,1].map(()=>ledger.reserve(project,hash,request())));expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('budget');expect(ledger.read(project).projection.spent.tokens).toBe(1000);
  await expect(ledger.reserve(project,hash,request('root',3000,1000))).rejects.toMatchObject({code:'budget'});
});
it.each(['error','cancelled'] as const)('retains unknown %s spend and unfinished requests across restart',async outcome=>{
  ledger.create(manifest);const r=request(),hash=manifestHash(manifest);await ledger.reserve(project,hash,r);
  const saved=await ledger.settle(project,hash,{requestId:r.id,outcome,usage:{inputTokens:0,outputTokens:0}});expect(saved.spent.tokens).toBe(1000);expect(saved.requests[r.id]!.state).toBe('unknown');
  const pending=request();await ledger.reserve(project,hash,pending);expect(new ReservationLedger(ledger.root).read(project).projection.spent.tokens).toBe(2000);
  await expect(ledger.reserve(project,hash,request())).rejects.toMatchObject({code:'budget'});
});
it('records usage exceeding its reservation, freezes further admission and never credits it',async()=>{
  ledger.create(manifest);const r=request(),hash=manifestHash(manifest);await ledger.reserve(project,hash,r);
  const state=await ledger.settle(project,hash,{requestId:r.id,outcome:'success',usage:{inputTokens:901,outputTokens:99}});expect(state.exceeded).toBe(true);expect(state.spent.tokens).toBeGreaterThanOrEqual(1000);
  await expect(ledger.reserve(project,hash,request('b'))).rejects.toThrow();
});
it('rejects malformed, removed, forged and aliased storage instead of resetting capacity',async()=>{
  ledger.create(manifest);const file=join(ledger.root,'history.json'),raw=fs.readFileSync(file,'utf8');
  for(const bad of ['{','{}',raw.replace('"tokenBudget":4000','"tokenBudget":5000')]){fs.writeFileSync(file,bad);expect(()=>ledger.read(project)).toThrow();expect(()=>ledger.create(manifest)).toThrow();expect(fs.readFileSync(file,'utf8')).toBe(bad);}
  fs.unlinkSync(file);expect(()=>ledger.create(manifest)).toThrow();fs.symlinkSync(join(root,'missing'),file);expect(()=>ledger.read(project)).toThrow();
});
it('keeps old spend on failed atomic commits and refuses a replaced project or contract',async()=>{
  ledger.create(manifest);const hash=manifestHash(manifest),r=request();await ledger.reserve(project,hash,r);
  vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw new Error('disk failure');});await expect(ledger.settle(project,hash,{requestId:r.id,outcome:'success',usage:{inputTokens:1,outputTokens:1}})).rejects.toThrow();
  expect(ledger.read(project).projection.requests[r.id]!.state).toBe('pending');
  await expect(ledger.reserve(project,'c'.repeat(64),request())).rejects.toMatchObject({code:'conflict'});
  fs.renameSync(project,join(root,'old-project'));fs.mkdirSync(project);expect(()=>ledger.read(project)).toThrow();
});
it('honors cancellation and deadlines before commit while allowing final settlement afterwards',async()=>{
  ledger.create(manifest);const hash=manifestHash(manifest),r=request();await expect(ledger.reserve(project,hash,r,AbortSignal.abort())).rejects.toMatchObject({name:'AbortError'});
  const controller=new AbortController(),pending=ledger.reserve(project,hash,r,controller.signal);controller.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(ledger.read(project).events).toHaveLength(0);
  await ledger.reserve(project,hash,r);const expired=new ReservationLedger(ledger.root,()=>manifest.deadline+1);
  await expect(expired.reserve(project,hash,request())).rejects.toMatchObject({code:'deadline'});
  expect((await expired.settle(project,hash,{requestId:r.id,outcome:'cancelled'})).requests[r.id]!.state).toBe('unknown');
});
it('does not write through symlink parents or reuse a foreign lock',async()=>{
  const outside=join(root,'outside'),alias=join(root,'alias');fs.mkdirSync(outside,{mode:0o700});fs.symlinkSync(outside,alias);
  expect(()=>new ReservationLedger(join(alias,'budget')).create(manifest)).toThrow();expect(fs.readdirSync(outside)).toEqual([]);
  ledger.create(manifest);const lock=join(ledger.root,'writer.lock');fs.writeFileSync(lock,'foreign');await expect(ledger.reserve(project,manifestHash(manifest),request())).rejects.toMatchObject({code:'locked'});expect(fs.readFileSync(lock,'utf8')).toBe('foreign');
});
it('reserves journal capacity for final settlement and rejects oversized history without discarding it',async()=>{
  ledger.create(manifest);const hash=manifestHash(manifest),events:ReservationEvent[]=[];
  const append=(change:ReservationEvent['change'])=>{const body={version:1 as const,id:randomUUID(),at:manifest.createdAt,previous:events.at(-1)?.hash??hash,change};events.push({...body,hash:digest(canonicalJson(body))});};
  for(let n=0;n<4999;n++){const r={...request(),inputTokens:1,outputTokens:1,inputPrice:0,outputPrice:0,costNanos:0};append({type:'reserve',reservation:r});append({type:'settle',settlement:{requestId:r.id,outcome:'success',usage:{inputTokens:0,outputTokens:0}}});}
  const file=join(ledger.root,'history.json');fs.writeFileSync(file,JSON.stringify({version:1,manifest,events,hash:digest(canonicalJson({manifest:hash,events:events.map(e=>e.hash)}))}));
  const last=request();await ledger.reserve(project,hash,last);await expect(ledger.reserve(project,hash,request())).rejects.toMatchObject({code:'limit'});await ledger.settle(project,hash,{requestId:last.id,outcome:'cancelled'});expect(ledger.read(project).events).toHaveLength(10000);
  fs.truncateSync(file,MAX_RESERVATION_BYTES+1);expect(()=>ledger.read(project)).toThrow();expect(()=>ledger.create(manifest)).toThrow();expect(fs.statSync(file).size).toBe(MAX_RESERVATION_BYTES+1);
});
