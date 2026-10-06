/** delegation-ledger/v1 conformance (#415): one parent allowance shared with children over a real transport. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ReservationLedger,manifestHash,requestCostNanos,ExecutionGuard,createLedgerServer,LedgerServerState,mintLedgerToken,RemoteReservationLedger,type ExecutionManifest,type ChildGrant} from '../src/execution/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
import {runLedgerCommand} from '../src/execution/ledger-cli.js';
import type {RouteCandidate} from '../src/routing/index.js';

let root:string,project:string,manifest:ExecutionManifest,ledger:ReservationLedger,hash:string,state:LedgerServerState,server:Server,url:string,parent:string;
const start=async()=>{server=createLedgerServer({ledger,cwd:project,state});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;};
beforeEach(async()=>{
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-delegation-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);
  manifest=executionManifest(project);manifest.tokenBudget=manifest.accounts[0]!.tokenBudget=10000;manifest.costBudgetNanos=manifest.accounts[0]!.costBudgetNanos=50000000;
  ledger=new ReservationLedger(join(root,'budget'));ledger.create(manifest);hash=manifestHash(manifest);state=new LedgerServerState(join(root,'ledger-server'));
  parent=mintLedgerToken(state.secret(),{v:1,run:manifest.runId,role:'parent',exp:manifest.deadline});await start();
});
afterEach(async()=>{vi.restoreAllMocks();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});

let graph:string|undefined;
const grant=(id:string,tokens:number,parentId='root'):ChildGrant=>{
  const previous=graph??manifest.planHash,planHash=randomUUID().replace(/-/g,'').padEnd(64,'0');graph=planHash;
  return {version:1,id:randomUUID(),proposalHash:randomUUID().replace(/-/g,'').padEnd(64,'1'),previousGraphHash:previous,planHash,runManifestHash:'d'.repeat(64),approvalRevision:randomUUID(),parentId,
    accounts:[{...structuredClone(manifest.accounts[1]!),id,parentId,tokenBudget:tokens,costBudgetNanos:5000000}]};
};
beforeEach(()=>{graph=undefined;});
const request=(agentId:string,tokens:number)=>({id:randomUUID(),agentId,provider:'deepseek',model:'toy',target:'a'.repeat(64),inputTokens:tokens-1,outputTokens:1,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(tokens-1,1,1,2)});
const connect=(token:string,extra:Partial<Parameters<typeof RemoteReservationLedger.connect>[0]>={})=>RemoteReservationLedger.connect({url,token,root:join(root,'child-cache'),attempts:2,...extra});
const allocate=async(g:ChildGrant,token=parent)=>{const r=await fetch(`${url}/v1/grant`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({manifestHash:hash,grant:g})});const v=await r.json() as {ok:boolean;token:string;code?:string};return v;};

it('concurrent and nested children exhaust one parent allowance and nothing is admitted after', async()=>{
  const a=await allocate(grant('child-a',3000)),b=await allocate(grant('child-b',3000));
  const ca=await connect(a.token),cb=await connect(b.token);
  const results=await Promise.allSettled([...[1,2,3].map(()=>ca.reserve(project,hash,request('child-a',1000))),...[1,2,3,4].map(()=>cb.reserve(project,hash,request('child-b',1000)))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(6);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'budget'}});
  const nested=await (await connect(a.token)).grantChildren(project,hash,grant('grandchild',1,'child-a')).catch(e=>e);expect(nested).toMatchObject({code:'budget'});
  const total=ledger.read(project).projection;expect(total.accounts.root!.tokens).toBe(6000);expect(total.spent.tokens).toBe(6000);
});

it('a duplicate dispatch and a lost acknowledgement admit once', async()=>{
  const child=await connect((await allocate(grant('child',5000))).token),r=request('child',1000);
  await child.reserve(project,hash,r);await child.reserve(project,hash,r);
  // The server commits, the response is lost on the way back: the retry replays the original admission.
  let drop=1;const lossy=await connect((await allocate(grant('lossy',1000))).token,{fetch:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/reserve')&&drop-->0)throw new TypeError('connection reset');return response;}});
  await lossy.reserve(project,hash,request('lossy',500));
  const saved=ledger.read(project).projection;expect(saved.spent.tokens).toBe(1500);expect(Object.keys(saved.requests)).toHaveLength(2);
  await expect(child.reserve(project,hash,{...r,inputTokens:r.inputTokens-1,costNanos:requestCostNanos(r.inputTokens-1,1,1,2)})).rejects.toMatchObject({code:'conflict'});
});

it('an unreachable parent authorizes nothing, and a dead child keeps its reservation charged', async()=>{
  const child=await connect((await allocate(grant('child',5000))).token),r=request('child',1000);await child.reserve(project,hash,r);
  await new Promise(res=>server.close(res));
  await expect(child.reserve(project,hash,request('child',100))).rejects.toMatchObject({code:'unavailable'});
  await start();
  // The child never settles: the reservation stays pending and charged through every ancestor.
  expect(ledger.read(project).projection.requests[r.id]!.state).toBe('pending');expect(ledger.read(project).projection.accounts.root!.tokens).toBe(1000);
  const reborn=await connect(parent);const settled=await reborn.settle(project,hash,{requestId:r.id,outcome:'cancelled'});
  expect(settled.requests[r.id]!.state).toBe('unknown');expect(settled.spent.tokens).toBe(1000);
});

it('a restart cannot reset limits and a rolled-back history is refused', async()=>{
  const g=grant('child',2000),token=(await allocate(g)).token,child=await connect(token);await child.reserve(project,hash,request('child',1500));
  await new Promise(res=>server.close(res));await start();
  const again=await connect(token,{url});await expect(again.reserve(project,hash,request('child',600))).rejects.toMatchObject({code:'budget'});
  // A server that forgets history (reset or replaced log) is detected by the child.
  let rollback=false;const watched=await connect(token,{fetch:async(input,init)=>{const response=await fetch(input,init);if(!rollback)return response;const body=await response.json() as {events:unknown[]};body.events=body.events.slice(0,1);return new Response(JSON.stringify(body));}});
  rollback=true;await expect(watched.refresh()).rejects.toMatchObject({code:'conflict'});
});

it('revocation fences the child and its descendants immediately and permanently', async()=>{
  const g=grant('child',5000),token=(await allocate(g)).token,child=await connect(token);
  const {token:grandToken}=await child.grantChildren(project,hash,grant('grandchild',1000,'child'));const grandchild=await connect(grandToken);
  await grandchild.reserve(project,hash,request('grandchild',100));
  const revoked=await fetch(`${url}/v1/revoke`,{method:'POST',headers:{authorization:`Bearer ${parent}`},body:JSON.stringify({grant:g.id})});expect(revoked.status).toBe(200);
  await expect(child.reserve(project,hash,request('child',100))).rejects.toMatchObject({code:'authority'});
  await expect(grandchild.reserve(project,hash,request('grandchild',100))).rejects.toMatchObject({code:'authority'});
  expect((await allocate(g)).code).toBe('authority');
  expect(ledger.read(project).projection.spent.tokens).toBe(100);
});

it('another run, a sibling, the root account or a forged token cannot act', async()=>{
  const a=await allocate(grant('child-a',3000)),b=await connect((await allocate(grant('child-b',3000))).token);
  await expect(b.reserve(project,hash,request('child-a',100))).rejects.toMatchObject({code:'authority'});
  await expect(b.reserve(project,hash,request('root',100))).rejects.toMatchObject({code:'authority'});
  expect((await allocate(grant('mine',100,'root'),a.token)).code).toBe('authority');
  const foreign=mintLedgerToken(state.secret(),{v:1,run:randomUUID(),role:'parent',exp:manifest.deadline});
  await expect(connect(foreign)).rejects.toMatchObject({code:'authority'});
  const [body,mac]=a.token.split('.') as [string,string],alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const swap=(at:number,c:(i:number)=>number)=>`${body}.${mac.slice(0,at)}${alphabet[c(alphabet.indexOf(mac[at]!))]}${mac.slice(at+1)}`;
  await expect(connect(swap(0,i=>(i+1)%64))).rejects.toMatchObject({code:'authority'});
  // Same decoded bytes, different spelling: only the canonical token is accepted.
  await expect(connect(swap(mac.length-1,i=>i^1))).rejects.toMatchObject({code:'authority'});
  expect(ledger.read(project).projection.spent.tokens).toBe(0);
});

it('ExecutionGuard admits and settles provider requests through the parent ledger unchanged', async()=>{
  const child=await connect((await allocate(grant('child',5000))).token);
  const guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},project);
  const route={provider:'deepseek',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:1000,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'} as RouteCandidate;
  const budget=guard.budget(route,[{role:'user',content:'public toy'}],[],false);
  const id=await budget.reserve({provider:'deepseek',model:'toy',target:route.target,maxOutputTokens:10});
  expect(ledger.read(project).projection.requests[id]).toMatchObject({state:'pending',reservation:{agentId:'child'}});
  await budget.settle(id,'success',{inputTokens:5,outputTokens:2});
  const saved=ledger.read(project).projection;expect(saved.requests[id]!.state).toBe('settled');expect(saved.accounts.child!.tokens).toBe(7);expect(saved.accounts.root!.tokens).toBe(7);
});

it('calliope ledger serve hands the parent token to a private file and serves children', async()=>{
  const tokenFile=join(root,'parent.token');let line='';
  const running=runLedgerCommand(['serve','--budget',ledger.root,'--project',project,'--token-file',tokenFile],t=>{line+=t;});
  await vi.waitFor(()=>expect(line).toContain('url'));
  const {url:served,protocol}=JSON.parse(line);expect(protocol).toBe('delegation-ledger/v1');
  expect(fs.statSync(tokenFile).mode&0o077).toBe(0);expect(line).not.toContain(fs.readFileSync(tokenFile,'utf8'));
  const owner=await RemoteReservationLedger.connect({url:served,token:fs.readFileSync(tokenFile,'utf8'),root:join(root,'cache')});
  await owner.reserve(project,hash,request('root',100));expect(ledger.read(project).projection.spent.tokens).toBe(100);
  process.emit('SIGTERM');await expect(running).resolves.toBe(0);
});
