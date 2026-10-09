/** delegation-ledger/v1 conformance (#415): one parent allowance shared with children over a real transport. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ReservationLedger,manifestHash,requestCostNanos,ExecutionGuard,ExecutionLimitError,createLedgerServer,LedgerServerState,mintLedgerToken,RemoteReservationLedger,type ExecutionManifest,type ChildGrant} from '../src/execution/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
import {runLedgerCommand} from '../src/execution/ledger-cli.js';
import type {RouteCandidate} from '../src/routing/index.js';
import {projectBudgetPath} from '../src/budget.js';
import {ProjectSpendLedger} from '../src/execution/project-spend.js';

let root:string,project:string,manifest:ExecutionManifest,ledger:ReservationLedger,hash:string,state:LedgerServerState,server:Server,url:string,parent:string;
const start=async(now?:()=>number)=>{server=createLedgerServer({ledger,cwd:project,state,now});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;};
beforeEach(async()=>{
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-delegation-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);
  manifest=executionManifest(project);manifest.tokenBudget=manifest.accounts[0]!.tokenBudget=10000;manifest.costBudgetNanos=manifest.accounts[0]!.costBudgetNanos=50000000;
  ledger=new ReservationLedger(join(root,'budget'));ledger.create(manifest);hash=manifestHash(manifest);state=new LedgerServerState(join(root,'ledger-server'));
  parent=mintLedgerToken(state.secret(),{v:1,run:manifest.runId,role:'parent',exp:manifest.deadline});await start();
});
afterEach(async()=>{vi.restoreAllMocks();await new Promise(r=>server.close(r));fs.rmSync(dirname(projectBudgetPath(project)),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});

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

it.each([false,true])('retains project capacity when admission is unknown (parent committed: %s)',async committed=>{
  let disconnected=false;
  const child=await connect((await allocate(grant('child',5000))).token,{attempts:1,fetch:async(input,init)=>{
    if(disconnected)throw new TypeError('connection reset');
    if(String(input).endsWith('/reserve')){
      if(committed)await fetch(input,init);
      disconnected=true;throw new TypeError('connection reset');
    }
    return fetch(input,init);
  }});
  const guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},project);
  const route={provider:'deepseek',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:1000,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'} as RouteCandidate;
  const budget=guard.budget(route,[{role:'user',content:'public toy'}],[],false);
  await expect(budget.reserve({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10})).rejects.toMatchObject({code:'unavailable'});
  const restarted=new ProjectSpendLedger(projectBudgetPath(project)),saved=restarted.read();
  expect(saved.spentUsd).toBe(0.00102);
  expect(saved.events.map(e=>e.change.type)).toEqual(['reserve']);
  expect(Object.keys(ledger.read(project).projection.requests)).toHaveLength(committed?1:0);
  await expect(restarted.reserve(randomUUID(),manifest.runId,1,1020000)).rejects.toMatchObject({code:'budget'});
});

it.each([true,false])('requires explicit non-admission evidence to release capacity (server supports evidence: %s)',async evidence=>{
  const child=await connect((await allocate(grant('child',1))).token,{fetch:async(input,init)=>{
    const response=await fetch(input,init);
    if(!evidence&&String(input).endsWith('/reserve')){
      const body=await response.json() as {admission?:string};delete body.admission;
      return new Response(JSON.stringify(body),{status:response.status});
    }
    return response;
  }});
  const guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},project);
  const route={provider:'deepseek',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:1000,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'} as RouteCandidate;
  const budget=guard.budget(route,[{role:'user',content:'public toy'}],[],false);
  await expect(budget.reserve({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10})).rejects.toMatchObject({code:'budget'});
  const saved=new ProjectSpendLedger(projectBudgetPath(project)).read();
  expect(saved.spentUsd).toBe(evidence?0:0.00102);
  expect(saved.events.map(e=>e.change.type)).toEqual(evidence?['reserve','settle']:['reserve']);
  expect(Object.keys(ledger.read(project).projection.requests)).toHaveLength(0);
});

it('does not refund an in-flight admission absent from a fresh journal',async()=>{
  let release!:()=>void,started!:()=>void,pending:Promise<Response>|undefined;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const reserve=ledger.reserve.bind(ledger);
  vi.spyOn(ledger,'reserve').mockImplementation(async(...args)=>{started();await gate;return reserve(...args);});
  const child=await connect((await allocate(grant('child',5000))).token,{attempts:1,fetch:async(input,init)=>{
    if(String(input).endsWith('/reserve')){
      pending=fetch(input,init);await entered;throw new TypeError('connection reset');
    }
    return fetch(input,init);
  }});
  const guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},project);
  const route={provider:'deepseek',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:1000,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'} as RouteCandidate;
  try{
    const budget=guard.budget(route,[{role:'user',content:'public toy'}],[],false);
    await expect(budget.reserve({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10})).rejects.toMatchObject({code:'unavailable'});
    expect(Object.keys(ledger.read(project).projection.requests)).toHaveLength(0);
    expect(new ProjectSpendLedger(projectBudgetPath(project)).read().spentUsd).toBe(0.00102);
  }finally{release();await pending;}
  expect(Object.keys(ledger.read(project).projection.requests)).toHaveLength(1);
  expect(new ProjectSpendLedger(projectBudgetPath(project)).read().spentUsd).toBe(0.00102);
});

it.each(['revoked-retry','rewritten-journal'])('retains project capacity after an admitted request returns %s',async failure=>{
  const g=grant('child',5000);
  let dropped=false;
  const child=await connect((await allocate(g)).token,{fetch:async(input,init)=>{
    const response=await fetch(input,init);
    if(String(input).endsWith('/reserve')&&!dropped){
      dropped=true;
      if(failure==='revoked-retry'){
        await fetch(`${url}/v1/revoke`,{method:'POST',headers:{authorization:`Bearer ${parent}`},body:JSON.stringify({grant:g.id})});
        throw new TypeError('connection reset');
      }
      const body=await response.json() as {events:unknown[]};body.events=[];
      return new Response(JSON.stringify(body));
    }
    return response;
  }});
  const guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},project);
  const route={provider:'deepseek',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:1000,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'} as RouteCandidate;
  const budget=guard.budget(route,[{role:'user',content:'public toy'}],[],false);
  await expect(budget.reserve({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10})).rejects.toMatchObject({code:failure==='revoked-retry'?'authority':'conflict'});
  expect(Object.keys(ledger.read(project).projection.requests)).toHaveLength(1);
  expect(new ProjectSpendLedger(projectBudgetPath(project)).read().spentUsd).toBe(0.00102);
});

it('does not mistake a server journal error after commit for non-admission',async()=>{
  const child=await connect((await allocate(grant('child',5000))).token);
  let committed=false;
  const reserve=ledger.reserve.bind(ledger),read=ledger.read.bind(ledger);
  vi.spyOn(ledger,'reserve').mockImplementation(async(...args)=>{const result=await reserve(...args);committed=true;return result;});
  vi.spyOn(ledger,'read').mockImplementation((...args)=>{
    if(committed){committed=false;throw new ExecutionLimitError('authority','Project changed while preparing the reply.');}
    return read(...args);
  });
  const guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},project);
  const route={provider:'deepseek',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:1000,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'} as RouteCandidate;
  const budget=guard.budget(route,[{role:'user',content:'public toy'}],[],false);
  await expect(budget.reserve({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10})).rejects.toMatchObject({code:'authority'});
  expect(Object.keys(ledger.read(project).projection.requests)).toHaveLength(1);
  expect(new ProjectSpendLedger(projectBudgetPath(project)).read().spentUsd).toBe(0.00102);
});

it.each([['reserve','revoked'],['reserve','expired'],['grant','revoked'],['grant','expired'],['reissue','revoked'],['reissue','expired']] as const)('rechecks %s authority after the ledger writer wait (%s)',async(operation,ending)=>{
  let clock=Date.now();
  if(ending==='expired'){await new Promise(resolve=>server.close(resolve));await start(()=>clock);}
  const g=grant('child',5000),token=(await allocate(g)).token,child=await connect(operation==='reissue'?parent:token);
  const lock=join(ledger.root,'writer.lock');fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  let entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  if(operation==='reserve'){
    const reserve=ledger.reserve.bind(ledger);
    vi.spyOn(ledger,'reserve').mockImplementation((...args)=>{entered();return reserve(...args);});
  }else{
    const allocate=ledger.grantChildren.bind(ledger);
    vi.spyOn(ledger,'grantChildren').mockImplementation((...args)=>{entered();return allocate(...args);});
  }
  const pending=operation==='reserve'?child.reserve(project,hash,request('child',100)):child.grantChildren(project,hash,operation==='reissue'?g:grant('grandchild',1000,'child'));
  const result=pending.then(value=>({value}),error=>({error}));
  try{
    await waiting;
    if(ending==='revoked'){
      const revoked=await fetch(`${url}/v1/revoke`,{method:'POST',headers:{authorization:`Bearer ${parent}`},body:JSON.stringify({grant:g.id})});
      expect(revoked.status).toBe(200);
    }else clock=manifest.deadline;
  }finally{fs.rmSync(lock,{force:true});}
  expect(await result).toMatchObject({error:{code:'authority'}});
  expect(ledger.read(project).projection.spent.tokens).toBe(0);
  expect(ledger.read(project).projection.childGrants).toHaveLength(1);
});
