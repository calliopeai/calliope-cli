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
import {projectIdentity,canonicalJson,digest} from '../src/approvals/index.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {inspectSpawn,inspectDelegatedSpawn,admitSpawn,executeSpawn,spawnCommand,proposalGrant,validateSpawnInput,validateSpawnProposal,makeSpawnProposal,type SpawnInput} from '../src/spawning/index.js';
import {prepareReviewedLedger,controlExecution,changePreparedRun,ExecutionStore,replayExecution} from '../src/orchestration/index.js';
import {ReservationLedger,RemoteReservationLedger,ExecutionGuard} from '../src/execution/index.js';

let root:string,remoteProject:string,r:Awaited<ReturnType<typeof coordinatorRun>>,servers:Server[];
beforeEach(async()=>{
  config.resetConfig();saveHooks([]);servers=[];
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-delegated-admission-')));
  remoteProject=join(root,'remote');fs.mkdirSync(remoteProject);fs.mkdirSync(join(remoteProject,'c'));
  const plan=verifiedPlan();plan.limits.maxAgents=6;plan.agents[0]!.maxChildCount=5;plan.limits.timeBudgetMs=120000;for(const a of plan.agents)a.timeBudgetMs=120000;
  r=await coordinatorRun(root,plan);
});
afterEach(async()=>{
  vi.restoreAllMocks();for(const server of servers)if(server.listening){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  config.resetConfig();saveHooks([]);
  if(process.platform==='darwin'){const open=spawnSync('/usr/sbin/lsof',['-nP','+D',root],{encoding:'utf8'});expect({status:open.status,stdout:open.stdout,stderr:open.stderr}).toEqual({status:1,stdout:'',stderr:''});}
  fs.rmSync(root,{recursive:true,force:true});
});
const options=()=>({store:r.runs});
function input():SpawnInput {
  const agent=structuredClone(r.view.manifest.plan.agents[1]!);agent.id='c';agent.allowedPaths=[{path:'c',access:'write'}];agent.maxChildDepth=1;agent.maxChildCount=1;
  const {project,projectKey}=projectIdentity(remoteProject);
  return{version:2,parentId:'coordinator',agents:[agent],tasks:[],delegation:{project:{root:project,key:projectKey},reference:'astrolift:fixture-task',observationHash:'1'.repeat(64)}};
}
async function preview(value:unknown=input()){
  fs.writeFileSync(join(r.project,'delegation.json'),JSON.stringify(value));
  return (await inspectSpawn(r.project,r.view.run.id,'delegation.json',options())).proposal;
}
async function admit(){const p=await preview();return admitSpawn(r.project,r.view.run.id,p,p.hash,options());}
async function host(){
  const h=await prepareReviewedLedger(r.project,r.view.run.id,'coordinator',10,options());servers.push(h.server);
  await new Promise<void>(resolve=>h.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(h.server.address() as AddressInfo).port}`;
  const parent=await RemoteReservationLedger.connect({url,token:h.ownerToken,root:join(root,'parent-'+randomUUID())});
  return{...h,url,parent};
}
const request=(agentId='c')=>({id:randomUUID(),agentId,provider:'deepseek',model:'fixture',target:'a'.repeat(64),inputTokens:99,outputTokens:1,inputPrice:0,outputPrice:0,costNanos:0});

it.each(['file','host'])('admits exact observed %s placement without local tasks, binds remote spending, and preserves replay and stop authority',async origin=>{
  // A parent-side alias is irrelevant to a separately observed remote workspace.
  fs.symlinkSync(remoteProject,join(r.project,'c'));
  const h=await host(),p=origin==='host'?(await inspectDelegatedSpawn(r.project,r.view.run.id,input(),options())).proposal:await preview(),original=r.authority.ledger.read(r.project),grant=proposalGrant(p,r.store.read().header);
  await expect(h.parent.grantChildren(r.project,h.execution.manifestHash,grant)).rejects.toMatchObject({code:'authority'});
  expect(r.authority.ledger.read(r.project)).toEqual(original);
  const accepted=await admitSpawn(r.project,r.view.run.id,p,p.hash,options());
  expect(accepted.admission.grant.grant).toMatchObject({version:2,project:input().delegation!.project});
  expect(Object.keys(accepted.execution.state.tasks)).toEqual(Object.keys(r.store.read().state.tasks));
  expect(Object.keys(accepted.execution.state.tasks)).toHaveLength(3);
  expect(accepted.admission.grant.grant.accounts[0]!.deadline).toBe(original.manifest.accounts[1]!.deadline);
  const restarted=new ExecutionStore(join(r.runs.root,r.view.run.id),r.view.manifest),saved=restarted.read();expect(replayExecution(saved.header,r.view.manifest,saved.events)).toEqual(saved.state);
  expect(await executeSpawn(r.project,accepted.admission,options())).toMatchObject({status:'delegated',exitCode:0});
  expect(r.store.owner()).toBeNull();expect(r.store.read()).toEqual(saved);
  const issued=await h.parent.grantChildren(r.project,h.execution.manifestHash,grant);
  expect((await h.parent.grantChildren(r.project,h.execution.manifestHash,grant)).token).toBe(issued.token);
  const child=await RemoteReservationLedger.connect({url:h.url,token:issued.token,root:join(root,'child'),execution:{cwd:remoteProject,agentId:'c'}});
  const execution={ledger:child,agentId:'c',manifestHash:h.execution.manifestHash,maxOutputTokens:10};
  const guard=new ExecutionGuard(execution,remoteProject);
  expect(guard.check({id:'read',name:'read_file',arguments:{path:join(remoteProject,'c/report.txt')}})).toBeUndefined();
  expect(guard.check({id:'escape',name:'read_file',arguments:{path:join(r.project,'a/report.txt')}})).toMatch(/scope|outside/i);
  await expect(RemoteReservationLedger.connect({url:h.url,token:issued.token,root:join(root,'wrong-workspace'),execution:{cwd:r.project,agentId:'c'}})).rejects.toThrow();
  const charge=request();await child.reserve(remoteProject,h.execution.manifestHash,charge);
  await child.settle(remoteProject,h.execution.manifestHash,{requestId:charge.id,outcome:'success',usage:{inputTokens:5,outputTokens:1}});
  const charged=r.authority.ledger.read(r.project);expect(charged.projection.spent.tokens).toBe(6);expect(charged.projection.accounts.coordinator!.tokens).toBe(6);
  await expect(child.reserve(remoteProject,h.execution.manifestHash,request('a'))).rejects.toMatchObject({code:'authority'});
  expect((await admitSpawn(r.project,r.view.run.id,p.hash,p.hash,options())).alreadyAdmitted).toBe(true);expect(r.authority.ledger.read(r.project)).toEqual(charged);
  await controlExecution(r.project,r.view.run.id,'agent-stop','c',options());
  await expect(child.reserve(remoteProject,h.execution.manifestHash,request())).rejects.toMatchObject({code:'authority'});
  await expect(h.parent.grantChildren(r.project,h.execution.manifestHash,grant)).rejects.toMatchObject({code:'authority'});
});

it.each(['file','host'])('recovers an interrupted %s allocation once without changing its workspace, allowance or clock',async origin=>{
  const p=origin==='host'?(await inspectDelegatedSpawn(r.project,r.view.run.id,input(),options())).proposal:await preview(),controller=new AbortController(),original=ReservationLedger.prototype.grantChildren;
  const spy=vi.spyOn(ReservationLedger.prototype,'grantChildren').mockImplementation(async function(...args){const result=await original.apply(this,args);controller.abort();return result;});
  await expect(admitSpawn(r.project,r.view.run.id,p,p.hash,{...options(),signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});spy.mockRestore();
  const saved=r.authority.ledger.read(r.project);expect(saved.projection.childGrants).toHaveLength(1);expect(r.store.read().state.graph).toBeUndefined();
  const h=await host();await expect(h.parent.grantChildren(r.project,h.execution.manifestHash,proposalGrant(p,r.store.read().header))).rejects.toMatchObject({code:'authority'});
  if(origin==='file')fs.unlinkSync(join(r.project,'delegation.json'));
  else expect((await inspectDelegatedSpawn(r.project,r.view.run.id,input(),options())).pending).toEqual([p.hash]);
  const accepted=await admitSpawn(r.project,r.view.run.id,p.hash,p.hash,options());expect(accepted.admission.grant).toEqual(saved.projection.childGrants![0]);expect(r.authority.ledger.read(r.project)).toEqual(saved);
});

it('previews a content-bound host proposal without writing the project or admitting capacity',async()=>{
  const files=fs.readdirSync(r.project),before=r.authority.ledger.read(r.project),journal=r.store.read(),value=input();
  const result=await inspectDelegatedSpawn(r.project,r.view.run.id,value,options()),hash=digest(canonicalJson(value));
  expect(result.proposal.source).toEqual({kind:'delegation',path:`delegation/${hash}.json`,sha256:hash});
  expect(result.deadline).toBe(journal.header.deadline);expect(result.pending).toEqual([]);
  value.agents[0]!.objective='Changed after preview';expect(result.proposal.agents[0]!.objective).not.toBe(value.agents[0]!.objective);
  expect(fs.readdirSync(r.project)).toEqual(files);expect(r.authority.ledger.read(r.project)).toEqual(before);expect(r.store.read()).toEqual(journal);
  await expect(admitSpawn(r.project,r.view.run.id,result.proposal,result.proposal.hash,{...options(),confirmation:'mutating',approve:async()=> 'reject'})).rejects.toThrow(/policy/i);
  expect(r.authority.ledger.read(r.project)).toEqual(before);expect(r.store.read()).toEqual(journal);
});

it('refuses local tasks and expanded scope in a host proposal before reserving capacity',async()=>{
  await expect(inspectDelegatedSpawn(r.project,r.view.run.id,{version:1,parentId:'coordinator',agents:input().agents,tasks:[r.view.manifest.plan.tasks[0]!]},options())).rejects.toThrow(/externally scheduled/);
  const expanded=input();expanded.agents[0]!.allowedTools=['shell'];
  await expect(inspectDelegatedSpawn(r.project,r.view.run.id,expanded,options())).rejects.toThrow();
  expect(r.authority.ledger.read(r.project).events).toEqual([]);expect(r.store.read().events).toEqual([]);
});

it.each(['execution','budget'])('rechecks host revocation after waiting for the %s writer lock',async kind=>{
  const p=(await inspectDelegatedSpawn(r.project,r.view.run.id,input(),options())).proposal;
  const lock=join(kind==='execution'?r.store.root:r.authority.ledger.root,'writer.lock');
  fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});
  let allowed=true,reviewed!:()=>void;
  const review=new Promise<void>(resolve=>{reviewed=resolve;});
  const pending=admitSpawn(r.project,r.view.run.id,p,p.hash,{...options(),assertAuthority:()=>{
    if(!allowed)throw new Error('Host connection revoked');
  },confirmation:'mutating',approve:async()=>{reviewed();return 'allow';}});
  const refused=expect(pending).rejects.toThrow('Host connection revoked');
  try{
    await review;await new Promise(resolve=>setTimeout(resolve,30));
    allowed=false;fs.unlinkSync(lock);await refused;
    expect(r.authority.ledger.read(r.project).events).toEqual([]);expect(r.store.read().events).toEqual([]);
  }finally{if(fs.existsSync(lock))fs.unlinkSync(lock);}
});

it.each(['placement','source-hash','source-path','source-event','legacy'] as const)('refuses changed host %s evidence even with a recomputed proposal hash',async field=>{
  const p=(await inspectDelegatedSpawn(r.project,r.view.run.id,input(),options())).proposal;
  const modified:any=structuredClone(p);
  if(field==='placement')modified.delegation.observationHash='2'.repeat(64);
  if(field==='source-hash')modified.source.sha256='2'.repeat(64);
  if(field==='source-path')modified.source.path='other.json';
  if(field==='source-event')modified.source.eventId=randomUUID();
  if(field==='legacy'){modified.version=1;delete modified.delegation;}
  const {hash,...body}=modified,changed={...body,hash:digest(canonicalJson(body))};
  await expect(admitSpawn(r.project,r.view.run.id,changed,changed.hash,options())).rejects.toThrow(/delegated proposal source/);
  expect(r.authority.ledger.read(r.project).events).toEqual([]);expect(r.store.read().events).toEqual([]);
});

it.each(['tasks','file-input','bad-key','missing-observation','missing-placement','legacy-placement','expanded-scope','expanded-budget'] as const)('refuses %s before granting any capacity',async kind=>{
  const value:any=input();
  if(kind==='tasks')value.tasks=[{...r.view.manifest.plan.tasks[0],id:'external-task',agentId:'c'}];
  if(kind==='file-input')value.agents[0].inputs=[{id:'file',kind:'file',value:'c/source.txt'}];
  if(kind==='bad-key')value.delegation.project.key='invalid';
  if(kind==='missing-observation')delete value.delegation.observationHash;
  if(kind==='missing-placement')delete value.delegation;
  if(kind==='legacy-placement')value.version=1;
  if(kind==='expanded-scope')value.agents[0].allowedTools=['shell'];
  if(kind==='expanded-budget')value.agents[0].tokenBudget=4001;
  await expect(preview(value)).rejects.toThrow();expect(r.authority.ledger.read(r.project).events).toEqual([]);expect(r.store.read().events).toEqual([]);
});

it('binds approval to placement evidence and refuses changed or revoked proposals',async()=>{
  const p=await preview();
  await expect(admitSpawn(r.project,r.view.run.id,p,'0'.repeat(64),options())).rejects.toMatchObject({code:'policy-denied'});
  let details:string[]=[];
  await expect(admitSpawn(r.project,r.view.run.id,p,p.hash,{...options(),confirmation:'mutating',approve:async decision=>{details=decision.request!.details;return 'reject';}})).rejects.toThrow(/policy/i);
  expect(details.join(' ')).toContain(p.delegation!.project.key);expect(details.join(' ')).toContain(p.delegation!.observationHash);expect(details.join(' ')).toContain(p.delegation!.reference);
  for(const field of ['reference','observationHash'] as const){const modified=structuredClone(p);modified.delegation![field]='2'.repeat(64);await expect(admitSpawn(r.project,r.view.run.id,modified,p.hash,options())).rejects.toThrow(/hash/);}
  fs.appendFileSync(join(r.project,'delegation.json'),' ');await expect(admitSpawn(r.project,r.view.run.id,p,p.hash,options())).rejects.toThrow(/source changed/);
  await changePreparedRun(r.project,r.view.run.id,'cancelled',options());await expect(admitSpawn(r.project,r.view.run.id,p,p.hash,options())).rejects.toThrow(/revoked/);
  expect(r.authority.ledger.read(r.project).events).toEqual([]);
});

it('cannot turn delegated accounts into locally scheduled descendants',async()=>{
  await admit();const agent={...input().agents[0]!,id:'d',parentId:'c',maxChildDepth:0,maxChildCount:0,tokenBudget:100};
  const task=structuredClone(r.view.manifest.plan.tasks[0]!);task.id='inspect-d';task.agentId='d';task.outputs[0]!.id='report-d';task.outputs[0]!.path='c/d.txt';task.acceptanceChecks![0]!.artifactId='report-d';
  const before=r.authority.ledger.read(r.project);
  for(const parentId of ['c','coordinator'])await expect(preview({version:1,parentId,agents:[agent],tasks:[task]})).rejects.toThrow(/externally scheduled/);expect(r.authority.ledger.read(r.project)).toEqual(before);
  const delegated={...input(),parentId:'c',agents:[agent]};const p=await preview(delegated);expect((await admitSpawn(r.project,r.view.run.id,p,p.hash,options())).admission.proposal.parentId).toBe('c');
});

it('reports delegated rather than completed through the native CLI without starting a coordinator',async()=>{
  const p=await preview(),lines:string[]=[];
  expect(await spawnCommand(['spawn','delegation.json','--run',r.view.run.id,'--approve',p.hash,'--json'],{...options(),cwd:r.project,write:text=>lines.push(text)})).toBe(0);
  expect(JSON.parse(lines.at(-1)!).data).toMatchObject({status:'delegated'});expect(r.store.owner()).toBeNull();expect(r.store.read().events.every(e=>e.change.type==='graph_admitted')).toBe(true);
});

it('creates admission history when a reviewed ledger is hosted before any coordinator starts',async()=>{
  fs.rmSync(r.store.root,{recursive:true});
  const saved=r.authority.ledger.read(r.project);await host();expect(r.store.read().header).toMatchObject({createdAt:new Date(saved.manifest.createdAt).toISOString(),deadline:saved.manifest.deadline});
  expect((await admit()).admission.proposal.version).toBe(2);expect(r.store.owner()).toBeNull();
});

it('keeps legacy empty-task proposals invalid',()=>{
  expect(()=>validateSpawnInput({version:1,parentId:'coordinator',agents:input().agents,tasks:[]})).toThrow();
});

it('rejects unknown versions and placement smuggling even when their proposal hash is recomputed',async()=>{
  const p=await preview();
  for(const modified of [{...p,version:3},{...p,version:1}]){
    const {hash,...body}=modified;
    expect(()=>validateSpawnProposal({...body,hash:digest(canonicalJson(body))},r.view.manifest,r.store.read().header,r.view.manifest.plan)).toThrow(/placement version/);
  }
  const eventId=randomUUID();
  expect(()=>makeSpawnProposal(r.view.manifest,r.store.read().header,r.view.manifest.plan,input(),{kind:'supervision',eventId,path:`supervision/${eventId}.json`,sha256:'1'.repeat(64)})).toThrow(/operator proposal/);
});

it('fences remote requests at cancellation while preserving already admitted charges for settlement',async()=>{
  const h=await host(),accepted=await admit(),grant=accepted.admission.grant.grant;
  const issued=await h.parent.grantChildren(r.project,h.execution.manifestHash,grant);
  const child=await RemoteReservationLedger.connect({url:h.url,token:issued.token,root:join(root,'cancel-child'),execution:{cwd:remoteProject,agentId:'c'}});
  const saved=request();await child.reserve(remoteProject,h.execution.manifestHash,saved);
  await changePreparedRun(r.project,r.view.run.id,'cancelled',options());
  await expect(child.reserve(remoteProject,h.execution.manifestHash,request())).rejects.toMatchObject({code:'authority'});
  await child.settle(remoteProject,h.execution.manifestHash,{requestId:saved.id,outcome:'cancelled'});
  expect(r.authority.ledger.read(r.project).projection.requests[saved.id]!.state).toBe('unknown');
  expect(r.authority.ledger.read(r.project).projection.spent.tokens).toBe(100);
});

it('does not bind later local children to an earlier delegated workspace',async()=>{
  fs.symlinkSync(remoteProject,join(r.project,'c'));await admit();
  const agent={...r.view.manifest.plan.agents[1]!,id:'d',allowedPaths:[{path:'d',access:'write' as const}]};
  const task=structuredClone(r.view.manifest.plan.tasks[0]!);task.id='inspect-d';task.agentId='d';task.outputs[0]!.id='report-d';task.outputs[0]!.path='d/report.txt';task.acceptanceChecks![0]!.artifactId='report-d';
  const p=await preview({version:1,parentId:'coordinator',agents:[agent],tasks:[task]});
  const result=await admitSpawn(r.project,r.view.run.id,p,p.hash,options());
  expect(result.admission.grant.grant.version).toBe(1);expect(result.execution.state.tasks['inspect-d']).toMatchObject({status:'pending',attempts:0});
});
