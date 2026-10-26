/** Real transport and native file guard: an owner grant binds a copied workspace, not a new budget. */
import {beforeEach,afterEach,it,expect} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {projectIdentity} from '../src/approvals/index.js';
import {projectBudgetPath} from '../src/budget.js';
import type {RouteCandidate} from '../src/routing/index.js';
import {ReservationLedger,manifestHash,ExecutionGuard,ExecutionLimitError,agentFiles,createLedgerServer,LedgerServerState,mintLedgerToken,RemoteReservationLedger,executionProjectForAccount,replayReservations,validateChildGrant,type ChildGrant,type ExecutionManifest} from '../src/execution/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
import {source as brainSource} from './helpers/brain.js';

let root:string,project:string,copy:string,url:string,parent:string,server:Server,ledger:ReservationLedger,manifest:ExecutionManifest,hash:string,ownerActive:boolean;
const identity=(cwd:string)=>{const p=projectIdentity(cwd);return {root:p.project,key:p.projectKey};};
beforeEach(async()=>{
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-workspace-binding-')));fs.chmodSync(root,0o700);
  project=join(root,'parent');copy=join(root,'copy');for(const p of [project,copy]){fs.mkdirSync(p);fs.mkdirSync(join(p,'a'));fs.mkdirSync(join(p,'b'));}
  manifest=executionManifest(project);manifest.tokenBudget=manifest.accounts[0]!.tokenBudget=10000;manifest.costBudgetNanos=manifest.accounts[0]!.costBudgetNanos=50000000;
  ledger=new ReservationLedger(join(root,'budget'));ledger.create(manifest);hash=manifestHash(manifest);
  const state=new LedgerServerState(join(root,'server'));parent=mintLedgerToken(state.secret(),{v:1,run:manifest.runId,role:'parent',exp:manifest.deadline});
  ownerActive=true;server=createLedgerServer({ledger,cwd:project,state,assertAuthority:()=>{if(!ownerActive)throw new ExecutionLimitError('authority','Owner stopped.');}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async()=>{
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  for(const p of [project,copy])if(fs.existsSync(p))fs.rmSync(dirname(projectBudgetPath(p)),{recursive:true,force:true});
  fs.rmSync(root,{recursive:true,force:true});
});
const grant=(id='child',parentId='root',tokens=3000):ChildGrant=>({version:2,project:identity(copy),id:randomUUID(),proposalHash:randomUUID().replaceAll('-','').padEnd(64,'a'),previousGraphHash:ledger.read(project).projection.childGrants?.at(-1)?.grant.planHash??manifest.planHash,planHash:randomUUID().replaceAll('-','').padEnd(64,'b'),runManifestHash:'d'.repeat(64),approvalRevision:randomUUID(),parentId,accounts:[{...manifest.accounts[1]!,id,parentId,tokenBudget:tokens,costBudgetNanos:5000000}]});
const call=async(op:string,body:unknown,token=parent)=>{
  const response=await fetch(`${url}/v1/${op}`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});return response.json() as Promise<any>;
};
const allocate=(g=grant(),token=parent)=>call('grant',{manifestHash:hash,grant:g},token);
const connect=(token:string,cwd=copy,agentId='child',extra:Partial<Parameters<typeof RemoteReservationLedger.connect>[0]>={})=>RemoteReservationLedger.connect({url,token,root:join(root,'cache-'+agentId),execution:{cwd,agentId},...extra});

it('uses only the granted copy paths while charging the original parent allowance and deadline',async()=>{
  fs.writeFileSync(join(copy,'a/input.txt'),'copy evidence');fs.writeFileSync(join(project,'a/input.txt'),'parent evidence');
  const child=await connect((await allocate()).token),guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},copy);
  expect(guard.manifest.project).toEqual(manifest.project);expect(guard.filesRoot).toBe(copy);expect(guard.deadline).toBe(manifest.deadline);
  expect(await agentFiles(guard,'child',{id:'read',name:'read_file',arguments:{}}).readTextFile(join(copy,'a/input.txt'))).toBe('copy evidence');
  await agentFiles(guard,'child',{id:'write',name:'write_file',arguments:{}}).writeTextFile(join(copy,'a/nested/output.txt'),'child result');
  expect(fs.readFileSync(join(copy,'a/nested/output.txt'),'utf8')).toBe('child result');expect(fs.existsSync(join(project,'a/nested/output.txt'))).toBe(false);
  for(const file of [join(copy,'b/denied.txt'),join(project,'a/input.txt')])expect(guard.check({id:'deny',name:'read_file',arguments:{path:file}})).toBeTruthy();
  fs.symlinkSync(join(project,'a/input.txt'),join(copy,'a/alias'));expect(guard.check({id:'alias',name:'read_file',arguments:{path:join(copy,'a/alias')}})).toBeTruthy();
  const route={provider:'deepseek',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:1000,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'} as RouteCandidate;
  const budget=guard.budget(route,[{role:'user',content:'public toy'}],[],false),id=await budget.reserve({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10});
  await budget.settle(id,'cancelled');const saved=ledger.read(project);
  expect(saved.manifest).toEqual(manifest);expect(saved.projection.requests[id]!.state).toBe('unknown');expect(saved.projection.accounts.root!.tokens).toBe(saved.projection.accounts.child!.tokens);expect(saved.projection.spent.tokens).toBeGreaterThan(0);
  const again=await connect((await allocate(saved.projection.childGrants![0]!.grant)).token);expect(again.read(copy).projection).toEqual(saved.projection);
});

it('requires the exact owner-approved identity and account, including after filesystem replacement',async()=>{
  const g=grant(),token=(await allocate(g)).token;
  await expect(connect(token,project)).rejects.toMatchObject({code:'authority'});
  await expect(connect(token,copy,'a')).rejects.toMatchObject({code:'authority'});
  const child=await connect(token),guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},copy);
  expect(()=>new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'a',maxOutputTokens:10},copy)).toThrow(/binding/);
  fs.renameSync(copy,copy+'-original');fs.mkdirSync(copy);
  expect(()=>guard.assertActive()).toThrow(/different or replaced/);
  await expect(connect(token)).rejects.toMatchObject({code:'authority'});
  expect(ledger.read(project).projection.spent.tokens).toBe(0);
});

it('keeps a whole-workspace grant inside its bound root using native path separators',async()=>{
  const g=grant();g.accounts[0]!.allowedPaths=[{path:'.',access:'write'}];
  const child=await connect((await allocate(g)).token),guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},copy);
  expect(guard.check({id:'inside',name:'write_file',arguments:{path:join(copy,'b/nested/file')}})).toBeUndefined();
  expect(guard.check({id:'outside',name:'write_file',arguments:{path:join(copy,'..','parent','a','file')}})).toMatch(/outside/);
});

it('checks retained knowledge locators against the bound copy without importing parent brain authority',async()=>{
  const child=await connect((await allocate()).token),guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},copy);
  const source={...brainSource(),version:1 as const,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),revision:'f'.repeat(64)};
  const check=guard.brainContext().sourceDenial;
  expect(check({...source,locator:{projectKey:identity(copy).key,path:'a/evidence.txt'}})).toBeUndefined();
  expect(check({...source,locator:{projectKey:identity(copy).key,path:'b/evidence.txt'}})).toMatch(/scope/);
  expect(check({...source,locator:{projectKey:manifest.project.key,path:'a/evidence.txt'}})).toMatch(/another project/);
  expect(check({...source,locator:{path:'a/evidence.txt'}})).toMatch(/lacks a project binding/);
});

it('inherits the binding through nested grants but refuses a child-issued workspace change',async()=>{
  const token=(await allocate()).token,child=await connect(token),candidate=grant('grandchild','child',1000);
  expect(await allocate(candidate,token)).toMatchObject({ok:false,code:'authority'});
  const {project:_,...fields}=candidate as Extract<ChildGrant,{version:2}>,nested:ChildGrant={...fields,version:1};
  const result=await child.grantChildren(copy,hash,nested),grand=await connect(result.token,copy,'grandchild');
  expect(grand.executionProject(copy,'grandchild')).toEqual(identity(copy));
  const saved=ledger.read(project);expect(executionProjectForAccount(saved.manifest,saved.projection,'grandchild')).toEqual(identity(copy));
  await call('revoke',{grant:saved.projection.childGrants![0]!.grant.id});
  await expect(connect(result.token,copy,'grandchild')).rejects.toMatchObject({code:'authority'});
});

it.each(['missing','malformed'])('does not reinterpret legacy grants or connect without a native handshake (%s capabilities)',async mode=>{
  const {project:_,...fields}=grant() as Extract<ChildGrant,{version:2}>,legacy:ChildGrant={...fields,version:1};
  const token=(await allocate(legacy)).token;
  await expect(connect(token)).rejects.toMatchObject({code:'authority'});
  const local=await connect(token,project);expect(local.read(project).manifest).toEqual(manifest);
  await expect(connect(token,project,'child',{fetch:async(input,init)=>{
    const response=await fetch(input,init);if(!String(input).endsWith('/hello'))return response;
    const body=await response.json() as any;body.operations=mode==='missing'?body.operations.filter((op:string)=>op!=='execution'):{};return new Response(JSON.stringify(body));
  }})).rejects.toMatchObject({code:'unavailable'});
});

it('requires live owner authority to bind another invocation, while journal inspection stays available',async()=>{
  const token=(await allocate()).token,child=await connect(token);ownerActive=false;
  await expect(connect(token)).rejects.toMatchObject({code:'authority'});
  await expect(child.refresh()).resolves.toBeUndefined();
  expect(child.read(copy).projection.spent.tokens).toBe(0);
});

it('records workspace grants with a distinct event version and preserves portable identity data',async()=>{
  const g={...grant(),version:2 as const,project:{root:'C:\\workspace\\copy',key:'e'.repeat(64)}};
  expect((await allocate(g)).ok).toBe(true);const saved=ledger.read(project);
  expect(saved.events[0]!.version).toBe(5);expect(saved.projection.version).toBe(4);
  expect(replayReservations(saved.manifest,saved.events)).toEqual(saved.projection);
  expect(()=>replayReservations(saved.manifest,[{...saved.events[0]!,version:2}])).toThrow();
  expect(()=>validateChildGrant({...g,version:1})).toThrow();
  expect(()=>validateChildGrant({...g,project:{...g.project,key:'wrong'}})).toThrow();
  expect(()=>validateChildGrant({...g,project:{...g.project,root:'relative'}})).toThrow();
});

it('refuses a transport reply that substitutes the approved project binding',async()=>{
  const token=(await allocate()).token;
  await expect(connect(token,copy,'child',{fetch:async(input,init)=>{
    const response=await fetch(input,init);if(!String(input).endsWith('/execution'))return response;
    const body=await response.json() as any;body.binding.project=identity(project);return new Response(JSON.stringify(body));
  }})).rejects.toMatchObject({code:'authority'});
});

it.each(['owner-stopped','grant-revoked'] as const)('does not treat cached history as live authority after %s',async mode=>{
  const child=await connect((await allocate()).token),guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},copy);
  if(mode==='owner-stopped'){ownerActive=false;await child.refresh();}
  else await call('revoke',{grant:ledger.read(project).projection.childGrants![0]!.grant.id});
  const files=agentFiles(guard,'child',{id:'write',name:'write_file',arguments:{}});
  await expect(files.writeTextFile(join(copy,'a/denied.txt'),'must not write')).rejects.toMatchObject({code:'authority'});
  expect(fs.existsSync(join(copy,'a/denied.txt'))).toBe(false);
  expect(ledger.read(project).projection.spent.tokens).toBe(0);
});

it('rechecks remote authority before committing staged file bytes',async()=>{
  let checks=0;
  const child=await connect((await allocate()).token,copy,'child',{fetch:async(input,init)=>{
    if(String(input).endsWith('/execution')&&++checks===3)ownerActive=false;
    return fetch(input,init);
  }}),guard=new ExecutionGuard({ledger:child,manifestHash:hash,agentId:'child',maxOutputTokens:10},copy);
  const files=agentFiles(guard,'child',{id:'write',name:'write_file',arguments:{}});
  await expect(files.writeTextFile(join(copy,'a/denied.txt'),'must not commit')).rejects.toMatchObject({code:'authority'});
  expect(checks).toBe(3);
  expect(fs.readdirSync(join(copy,'a'))).toEqual([]);
});
