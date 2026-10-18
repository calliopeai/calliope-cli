import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest,Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {PassThrough} from 'node:stream';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {canonicalJson,projectIdentity} from '../src/approvals/index.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {inspectSpawn,admitSpawn} from '../src/spawning/index.js';
import {prepareReviewedLedger,controlExecution} from '../src/orchestration/index.js';
import {attachLedgerTunnel,listenLedgerTunnel,RemoteReservationLedger,MAX_LEDGER_REQUEST_BYTES,type LedgerTunnelBinding,type LedgerTunnelHandle} from '../src/execution/index.js';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
let root:string,servers:Server[],handles:LedgerTunnelHandle[],streams:PassThrough[];
beforeEach(()=>{servers=[];handles=[];streams=[];root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-ledger-tunnel-')));config.resetConfig();saveHooks([]);});
afterEach(async()=>{
  vi.restoreAllMocks();await Promise.all(handles.map(handle=>handle.close()));
  for(const stream of streams)stream.destroy();
  for(const server of servers)if(server.listening){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  config.resetConfig();saveHooks([]);
  if(process.platform==='darwin'){const open=spawnSync('/usr/sbin/lsof',['-nP','+D',root],{encoding:'utf8'});expect({status:open.status,stdout:open.stdout,stderr:open.stderr}).toEqual({status:1,stdout:'',stderr:''});}
  fs.rmSync(root,{recursive:true,force:true});
});
async function listen(server:Server){servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
async function port(){const server=createServer(),url=await listen(server);await new Promise<void>(resolve=>server.close(()=>resolve()));return Number(new URL(url).port);}
function pair(){const a=new PassThrough({highWaterMark:1024}),b=new PassThrough({highWaterMark:1024});streams.push(a,b);return {host:{input:a,output:b},task:{input:b,output:a}};}
async function tunnel(ledgerUrl:string,binding:LedgerTunnelBinding,options:{port?:number;timeoutMs?:number;assertConnection?:()=>void;signal?:AbortSignal;io?:ReturnType<typeof pair>}={}){
  const io=options.io??pair(),timeoutMs=options.timeoutMs??5000;
  const host=attachLedgerTunnel({...io.host,binding,ledgerUrl,timeoutMs,assertConnection:options.assertConnection??(()=>{}),signal:options.signal});handles.push(host);
  const task=await listenLedgerTunnel({...io.task,binding,timeoutMs,port:options.port??await port()});handles.push(task);
  return {host,task,io};
}
function fakeCredential(){
  const claims={v:2,role:'child',run:randomUUID(),grant:randomUUID(),authority:'a'.repeat(64),exp:Date.now()+120000,epoch:1,accounts:['c']};
  const token=Buffer.from(JSON.stringify(claims)).toString('base64url')+'.test-only-unsigned';
  const binding:LedgerTunnelBinding={version:1,runId:claims.run,grantId:claims.grant,authority:claims.authority,deadline:claims.exp,credentialSha256:hash(token)};
  return {token,binding};
}
const post=(url:string,token:string,path='/v1/hello',body='{}')=>fetch(url+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body});
const charge=()=>({id:randomUUID(),agentId:'c',provider:'deepseek',model:'fixture',target:'a'.repeat(64),inputTokens:99,outputTokens:1,inputPrice:0,outputPrice:0,costNanos:0});
async function native(){
  const plan=verifiedPlan();plan.limits.timeBudgetMs=120000;for(const a of plan.agents)a.timeBudgetMs=120000;
  const r=await coordinatorRun(root,plan),remote=join(root,'remote');fs.mkdirSync(remote);fs.mkdirSync(join(remote,'c'));
  const agent=structuredClone(r.view.manifest.plan.agents[1]!);agent.id='c';agent.allowedPaths=[{path:'c',access:'write'}];
  const identity=projectIdentity(remote),input={version:2,parentId:'coordinator',agents:[agent],tasks:[],delegation:{project:{root:identity.project,key:identity.projectKey},reference:'astrolift:fixture-task',observationHash:'1'.repeat(64)}};
  fs.writeFileSync(join(r.project,'delegation.json'),JSON.stringify(input));
  const options={store:r.runs},proposal=(await inspectSpawn(r.project,r.view.run.id,'delegation.json',options)).proposal;
  const accepted=await admitSpawn(r.project,r.view.run.id,proposal,proposal.hash,options);
  const start=async()=>{const prepared=await prepareReviewedLedger(r.project,r.view.run.id,'coordinator',10,options);return {...prepared,url:await listen(prepared.server)};};
  const h=await start(),parent=await RemoteReservationLedger.connect({url:h.url,token:h.ownerToken,root:join(root,'parent')});
  const {token}=await parent.grantChildren(r.project,h.execution.manifestHash,accepted.admission.grant.grant);
  const claims=JSON.parse(Buffer.from(token.split('.')[0]!,'base64url').toString());
  const binding:LedgerTunnelBinding={version:1,runId:claims.run,grantId:claims.grant,authority:claims.authority,deadline:claims.exp,credentialSha256:hash(token)};
  return {r,remote,h,start,token,binding,hash:h.execution.manifestHash};
}

it('reconnects the same task URL, credential and native allowance after losing a committed reservation reply',async()=>{
  const n=await native(),original=n.r.authority.ledger.read(n.r.project).manifest,p=await port();
  let t=await tunnel(n.h.url,n.binding,{port:p});
  const connect=()=>RemoteReservationLedger.connect({url:t.task.url,token:n.token,root:join(root,'child'),execution:{cwd:n.remote,agentId:'c'},attempts:1,timeoutMs:1000});
  const client=await connect(),request=charge(),ledger=n.h.execution.ledger,originalReserve=ledger.reserve.bind(ledger);
  const spy=vi.spyOn(ledger,'reserve').mockImplementation(async(...args)=>{const result=await originalReserve(...args);await t.host.close();return result;});
  const failure=await client.reserve(n.remote,n.hash,request).catch(error=>error);
  expect(failure).toMatchObject({code:'unavailable'});expect(client.canReleaseFailedReservation(failure)).toBe(false);
  expect(n.r.authority.ledger.read(n.r.project).projection.requests[request.id]!.state).toBe('pending');
  spy.mockRestore();await t.task.closed;
  n.h.server.closeAllConnections();await new Promise<void>(resolve=>n.h.server.close(()=>resolve()));
  const restarted=await n.start();t=await tunnel(restarted.url,n.binding,{port:p});
  const again=await connect();await again.reserve(n.remote,n.hash,request);
  expect(again.read(n.remote).projection.spent.tokens).toBe(100);
  expect(Object.keys(again.read(n.remote).projection.requests)).toEqual([request.id]);
  await again.settle(n.remote,n.hash,{requestId:request.id,outcome:'success',usage:{inputTokens:5,outputTokens:1}});
  expect(n.r.authority.ledger.read(n.r.project).projection.spent.tokens).toBe(6);
  expect(n.r.authority.ledger.read(n.r.project).manifest).toEqual(original);
  await controlExecution(n.r.project,n.r.view.run.id,'agent-stop','c',{store:n.r.runs});
  await expect(again.reserve(n.remote,n.hash,charge())).rejects.toMatchObject({code:'authority'});
});

it('never carries a parent or replacement token over the task exec stream',async()=>{
  const n=await native(),t=await tunnel(n.h.url,n.binding);let bytes=0;t.io.task.output.on('data',chunk=>{bytes+=chunk.length;});
  for(const token of [n.h.ownerToken,n.token+'x',''])expect((await post(t.task.url,token)).status).toBe(403);
  for(const path of ['/v1/revoke','/v1/journal?url=http://example.test','/bridge/v1/ping'])expect((await post(t.task.url,n.token,path)).status).toBe(403);
  const absolute=await new Promise<number|undefined>((resolve,reject)=>{
    const req=httpRequest(t.task.url,{method:'POST',path:'http://example.test/v1/hello',headers:{authorization:`Bearer ${n.token}`}},response=>{response.resume();resolve(response.statusCode);});
    req.once('error',reject);req.end('{}');
  });expect(absolute).toBe(403);
  expect(bytes).toBe(0);
  const changed={...n.binding,credentialSha256:hash(n.h.ownerToken)},other=await tunnel(n.h.url,changed);
  expect((await post(other.task.url,n.h.ownerToken)).status).toBe(403);
});

it('lets the native server authenticate the signature and workspace instead of trusting decoded claims',async()=>{
  const n=await native(),forged=n.token.slice(0,-3)+'bad',t=await tunnel(n.h.url,{...n.binding,credentialSha256:hash(forged)});
  await expect(RemoteReservationLedger.connect({url:t.task.url,token:forged,root:join(root,'forged')})).rejects.toMatchObject({code:'authority'});
  const valid=await tunnel(n.h.url,n.binding);
  await expect(RemoteReservationLedger.connect({url:valid.task.url,token:n.token,root:join(root,'wrong'),execution:{cwd:n.r.project,agentId:'c'}})).rejects.toMatchObject({code:'authority'});
});

it('streams a multi-megabyte response through bounded pipes without changing it',async()=>{
  const {token,binding}=fakeCredential(),payload=JSON.stringify({ok:true,data:'x'.repeat(3*1024*1024)});
  const upstream=createServer((_req,res)=>res.end(payload)),url=await listen(upstream),t=await tunnel(url,binding);
  expect(await (await post(t.task.url,token)).text()).toBe(payload);
  expect(await (await post(t.task.url,token)).text()).toBe(payload);
});

it('expires an idle lost owner and releases only its pinned port',async()=>{
  const {binding}=fakeCredential(),upstream=createServer(),url=await listen(upstream),p=await port(),t=await tunnel(url,binding,{port:p,timeoutMs:200});
  // A hung transport stays open but stops receiving. Both sides have a wall clock deadline.
  t.io.host.input.pause();t.io.task.input.pause();
  await Promise.all([t.host.closed,t.task.closed]);
  const replacement=createServer();servers.push(replacement);await new Promise<void>((resolve,reject)=>{replacement.once('error',reject);replacement.listen(p,'127.0.0.1',resolve);});
});

it('keeps a live idle bridge open with heartbeats and checks the owner lease again',async()=>{
  const {binding}=fakeCredential(),url=await listen(createServer()),check=vi.fn(),t=await tunnel(url,binding,{timeoutMs:300,assertConnection:check});
  await vi.waitFor(()=>expect(check.mock.calls.length).toBeGreaterThan(5),{timeout:2000});
  check.mockImplementation(()=>{throw new Error('private lease detail');});await Promise.all([t.host.closed,t.task.closed]);
});

it('waits for an in-flight heartbeat instead of refusing native connection negotiation',async()=>{
  const {token,binding}=fakeCredential(),url=await listen(createServer((_req,res)=>res.end('{"ok":true}'))),io=pair();
  let entered!:()=>void,release!:()=>void,pings=0;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),original=io.host.output._transform.bind(io.host.output);
  io.host.output._transform=(chunk,encoding,done)=>{
    if(chunk.toString().includes('HTTP/1.1 204')&&++pings===2){release=()=>original(chunk,encoding,done);entered();}
    else original(chunk,encoding,done);
  };
  const t=await tunnel(url,binding,{io,timeoutMs:1000});await waiting;
  const pending=post(t.task.url,token);
  try{await new Promise(resolve=>setTimeout(resolve,50));}finally{release();}
  expect((await pending).status).toBe(200);
});

it.each(['mismatch','aborted','port-conflict'] as const)('refuses %s attachment without choosing a new endpoint',async kind=>{
  const {binding}=fakeCredential(),url=await listen(createServer()),io=pair(),controller=new AbortController();
  const host=attachLedgerTunnel({...io.host,binding,ledgerUrl:url,assertConnection:()=>{},timeoutMs:200});handles.push(host);
  let p=await port();if(kind==='port-conflict')p=Number(new URL(await listen(createServer())).port);
  if(kind==='aborted')controller.abort();
  await expect(listenLedgerTunnel({...io.task,binding:kind==='mismatch'?{...binding,grantId:randomUUID()}:binding,port:p,timeoutMs:200,signal:controller.signal})).rejects.toMatchObject({code:'unavailable'});
  await host.closed;
});

it.each(['https://127.0.0.1:1234','http://localhost:1234','http://127.0.0.1:1234/other','http://127.0.0.1:1234/?x=1','http://user@127.0.0.1:1234','not-url'])('refuses owner endpoint %s before attaching streams',ledgerUrl=>{
  const {binding}=fakeCredential(),io=pair();expect(()=>attachLedgerTunnel({...io.host,binding,ledgerUrl,assertConnection:()=>{}})).toThrow();
});

it.each(['oversized','redirect','stalled'] as const)('closes on an %s upstream response without declaring non-admission',async kind=>{
  const {token,binding}=fakeCredential();
  const url=await listen(createServer((_req,res)=>{
    if(kind==='redirect'){res.writeHead(302,{location:'http://example.test'});res.end();}
    if(kind==='oversized')res.end(Buffer.alloc(33*1024*1024));
  }));
  const t=await tunnel(url,binding,{timeoutMs:500});
  const result=await post(t.task.url,token).then(async response=>({status:response.status,text:await response.text()})).catch(()=>null);
  if(result)expect(result.text).not.toContain('"admission":"refused"');await t.task.closed;
});

it('rejects oversized task bodies before the native server sees them',async()=>{
  const {token,binding}=fakeCredential(),seen=vi.fn((_req,res)=>res.end('{"ok":true}')),url=await listen(createServer(seen)),t=await tunnel(url,binding);
  await post(t.task.url,token,'/v1/reserve','x'.repeat(MAX_LEDGER_REQUEST_BYTES+1)).catch(()=>{});
  await t.task.closed;expect(seen).not.toHaveBeenCalled();
});

it('bounds stalled task request bodies and does not leak the listening port',async()=>{
  const {token,binding}=fakeCredential(),url=await listen(createServer()),t=await tunnel(url,binding,{timeoutMs:200});
  const req=httpRequest(t.task.url+'/v1/reserve',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-length':'1000'}});req.on('error',()=>{});req.write('{');
  await t.task.closed;req.destroy();
});

it('closes both sides on explicit owner cancellation and on the original deadline',async()=>{
  const {binding}=fakeCredential(),url=await listen(createServer()),controller=new AbortController();
  const t=await tunnel(url,binding,{signal:controller.signal});controller.abort();await Promise.all([t.host.closed,t.task.closed]);
  const expired=await tunnel(url,{...binding,deadline:Date.now()+200});await Promise.all([expired.host.closed,expired.task.closed]);
});

it.each(['port','timeout','binding','expired'] as const)('rejects invalid %s configuration before listening',async kind=>{
  const {binding}=fakeCredential(),io=pair();
  if(kind==='binding')binding.credentialSha256='invalid';
  if(kind==='expired')binding.deadline=0;
  await expect(listenLedgerTunnel({...io.task,binding,port:kind==='port'?0:await port(),timeoutMs:kind==='timeout'?0:1000})).rejects.toMatchObject({code:'unavailable'});
});

it.each(['connect','upgrade'] as const)('closes forbidden HTTP %s on private owner streams',async kind=>{
  const {binding}=fakeCredential(),seen=vi.fn((_req,res)=>res.end('{}')),url=await listen(createServer(seen)),io=pair();
  const host=attachLedgerTunnel({...io.host,binding,ledgerUrl:url,assertConnection:()=>{}});handles.push(host);
  const wire=kind==='connect'?'CONNECT example.test:443 HTTP/1.1\r\nHost: example.test\r\n\r\n':
    'GET / HTTP/1.1\r\nHost: example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n';
  io.task.output.write(wire);await host.closed;expect(seen).not.toHaveBeenCalled();
});

it('bounds an incomplete HTTP body on the private owner stream',async()=>{
  const {binding}=fakeCredential(),seen=vi.fn((_req,res)=>res.end('{}')),url=await listen(createServer(seen)),io=pair();
  const host=attachLedgerTunnel({...io.host,binding,ledgerUrl:url,timeoutMs:200,assertConnection:()=>{}});handles.push(host);
  const fingerprint=hash(canonicalJson(binding));
  io.task.output.write(`POST /bridge/v1/ping HTTP/1.1\r\nHost: localhost\r\nx-calliope-ledger-binding: ${fingerprint}\r\nContent-Length: 1000\r\n\r\n{`);
  await host.closed;expect(seen).not.toHaveBeenCalled();
});

it('releases the pinned port when cancelled as the task listener becomes ready',async()=>{
  const {binding}=fakeCredential(),url=await listen(createServer()),io=pair(),p=await port(),controller=new AbortController();
  const host=attachLedgerTunnel({...io.host,binding,ledgerUrl:url,assertConnection:()=>{}});handles.push(host);
  const original=Server.prototype.listen,spy=vi.spyOn(Server.prototype,'listen').mockImplementation(function(this:Server,...args:unknown[]){
    this.prependOnceListener('listening',()=>controller.abort());return Reflect.apply(original,this,args);
  });
  try{await expect(listenLedgerTunnel({...io.task,binding,port:p,signal:controller.signal})).rejects.toMatchObject({code:'unavailable'});}
  finally{spy.mockRestore();}
  await host.closed;
  const replacement=createServer();servers.push(replacement);
  await new Promise<void>((resolve,reject)=>{replacement.once('error',reject);replacement.listen(p,'127.0.0.1',resolve);});
});
