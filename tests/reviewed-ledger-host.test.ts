import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {prepareReviewedLedger,controlExecution,changePreparedRun} from '../src/orchestration/index.js';
import {inspectSpawn,admitSpawn,proposalGrant} from '../src/spawning/index.js';
import {createLedgerServer,LedgerServerState,mintLedgerToken,verifyLedgerToken,RemoteReservationLedger,ReservationLedger} from '../src/execution/index.js';
import {runLedgerCommand} from '../src/execution/ledger-cli.js';

let root:string,fixture:Awaited<ReturnType<typeof coordinatorRun>>,servers:Server[];
beforeEach(async()=>{
  config.resetConfig();saveHooks([]);servers=[];root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-reviewed-host-')));
  const plan=verifiedPlan();plan.limits.timeBudgetMs=120000;for(const agent of plan.agents)agent.timeBudgetMs=120000;
  fixture=await coordinatorRun(root,plan);
});
afterEach(async()=>{
  vi.restoreAllMocks();for(const server of servers)if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  config.resetConfig();saveHooks([]);
  if(process.platform==='darwin'){const open=spawnSync('/usr/sbin/lsof',['-nP','+D',root],{encoding:'utf8'});expect({status:open.status,stdout:open.stdout,stderr:open.stderr}).toEqual({status:1,stdout:'',stderr:''});}
  fs.rmSync(root,{recursive:true,force:true});
});
const state=()=>new LedgerServerState(join(dirname(fixture.authority.ledger.root),`${fixture.view.run.id}.ledger-server`));
const prepare=(agentId='coordinator')=>prepareReviewedLedger(fixture.project,fixture.view.run.id,agentId,10,{store:fixture.runs});
async function listen(server:Server){servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
async function start(agentId='coordinator'){const host=await prepare(agentId),url=await listen(host.server);return {...host,url};}
const connect=(url:string,token:string,agentId?:string)=>RemoteReservationLedger.connect({url,token,root:join(root,'cache-'+randomUUID()),...(agentId?{execution:{cwd:fixture.project,agentId}}:{})});
const request=(agentId='a')=>({id:randomUUID(),agentId,provider:'deepseek',model:'fixture',target:'a'.repeat(64),inputTokens:99,outputTokens:1,inputPrice:0,outputPrice:0,costNanos:0});
const post=async(url:string,token:string,op:string,body:object)=>{
  const response=await fetch(`${url}/v1/${op}`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as Record<string,unknown>};
};
it.each([{provider:'openai',model:'fixture'},{provider:'deepseek',model:'other-model'}])('refuses a reservation outside the reviewed inference choice: $provider/$model',async choice=>{
  const directory=join(root,'inference-scope');fs.mkdirSync(directory);
  const plan=verifiedPlan();plan.limits.timeBudgetMs=120000;
  for(const agent of plan.agents)agent.timeBudgetMs=120000;
  plan.agents.find(agent=>agent.id==='a')!.preference={provider:'deepseek',model:'fixture'};
  fixture=await coordinatorRun(directory,plan);
  const host=await start('a'),client=await connect(host.url,host.ownerToken,'a');
  const before=fixture.authority.ledger.read(fixture.project);
  await expect(client.reserve(fixture.project,host.execution.manifestHash,{...request(),...choice})).rejects.toMatchObject({code:'authority'});
  expect(fixture.authority.ledger.read(fixture.project)).toEqual(before);
  await client.reserve(fixture.project,host.execution.manifestHash,request());
  expect(fixture.authority.ledger.read(fixture.project).projection.spent.tokens).toBe(100);
});
async function childProposal(preference?:{provider:string;model?:string}){
  const agent=structuredClone(fixture.view.manifest.plan.agents[1]!),task=structuredClone(fixture.view.manifest.plan.tasks[0]!);
  if(preference)agent.preference=preference;
  agent.id='c';agent.allowedPaths=[{path:'c',access:'write'}];task.id='inspect-c';task.agentId='c';task.outputs[0]!.id='report-c';task.outputs[0]!.path='c/report.txt';task.acceptanceChecks![0]!.artifactId='report-c';
  fs.mkdirSync(join(fixture.project,'c'));fs.writeFileSync(join(fixture.project,'children.json'),JSON.stringify({version:1,parentId:'coordinator',agents:[agent],tasks:[task]}));
  return (await inspectSpawn(fixture.project,fixture.view.run.id,'children.json',{store:fixture.runs})).proposal;
}

it('enforces the explicit preference of a newly admitted descendant',async()=>{
  const host=await start(),parent=await connect(host.url,host.ownerToken);
  const proposal=await childProposal({provider:'deepseek',model:'fixture'});
  const admission=await admitSpawn(fixture.project,fixture.view.run.id,proposal,proposal.hash,{store:fixture.runs});
  const issued=await parent.grantChildren(fixture.project,host.execution.manifestHash,admission.admission.grant.grant);
  const child=await connect(host.url,issued.token,'c'),before=fixture.authority.ledger.read(fixture.project);
  await expect(child.reserve(fixture.project,host.execution.manifestHash,{...request('c'),model:'other'})).rejects.toMatchObject({code:'authority'});
  expect(fixture.authority.ledger.read(fixture.project)).toEqual(before);
  await child.reserve(fixture.project,host.execution.manifestHash,request('c'));
  expect(fixture.authority.ledger.read(fixture.project).projection.spent.tokens).toBe(100);
});

it('serves the actual reviewed account without replacing its allowance or clock across restart',async()=>{
  const before=fixture.authority.ledger.read(fixture.project),host=await start('a');
  expect(host.capability).toMatchObject({version:1,ownerScope:1,tokenVersion:2,reviewedAuthority:1,grants:'native-admissions-only'});
  expect(host.execution.manifestHash).toBe(fixture.authority.manifestHash);expect(host.deadline).toBe(before.manifest.accounts[1]!.deadline);
  const claims=verifyLedgerToken(state().secret(),host.ownerToken,fixture.view.run.id);expect(claims).toMatchObject({v:2,owner:'a',role:'parent',exp:host.deadline});expect(claims.authority).toMatch(/^[a-f0-9]{64}$/);
  const client=await connect(host.url,host.ownerToken,'a'),saved=request();await client.reserve(fixture.project,host.execution.manifestHash,saved);
  expect(fixture.authority.ledger.read(fixture.project).projection.spent.tokens).toBe(100);
  const restarted=await start('a'),again=await connect(restarted.url,host.ownerToken,'a');await again.reserve(fixture.project,host.execution.manifestHash,saved);
  expect(restarted.execution.ledger.read(fixture.project).manifest).toEqual(before.manifest);expect(again.read(fixture.project).projection.spent.tokens).toBe(100);
  await expect(again.reserve(fixture.project,host.execution.manifestHash,{...request(),inputTokens:1000})).rejects.toMatchObject({code:'budget'});
});

it('rejects root, sibling, alternate-owner and raw-host credential reuse',async()=>{
  const a=await start('a'),b=await start('b'),client=await connect(a.url,a.ownerToken),before=fixture.authority.ledger.read(fixture.project);
  for(const id of ['coordinator','b'])await expect(client.reserve(fixture.project,a.execution.manifestHash,request(id))).rejects.toMatchObject({code:'authority'});
  await expect(connect(b.url,a.ownerToken)).rejects.toMatchObject({code:'authority'});
  const rawToken=mintLedgerToken(state().secret(),{v:1,run:fixture.view.run.id,role:'parent',exp:a.deadline});
  await expect(connect(a.url,rawToken)).rejects.toMatchObject({code:'authority'});
  const raw=await listen(createLedgerServer({ledger:fixture.authority.ledger as ReservationLedger,cwd:fixture.project,state:state()}));
  await expect(connect(raw,a.ownerToken)).rejects.toMatchObject({code:'authority'});
  await expect(client.reserve(fixture.project,a.execution.manifestHash,{...request(),outputTokens:11})).rejects.toMatchObject({code:'budget'});
  expect(fixture.authority.ledger.read(fixture.project)).toEqual(before);
});

it('only issues child credentials for an exact native admission, including interrupted admission recovery',async()=>{
  const host=await start(),client=await connect(host.url,host.ownerToken),proposal=await childProposal(),grant=proposalGrant(proposal,fixture.store.read().header);
  const before=fixture.authority.ledger.read(fixture.project);
  await expect(client.grantChildren(fixture.project,host.execution.manifestHash,grant)).rejects.toMatchObject({code:'authority'});
  expect(fixture.authority.ledger.read(fixture.project)).toEqual(before);
  await fixture.authority.ledger.grantChildren(fixture.project,host.execution.manifestHash,grant);
  await expect(client.grantChildren(fixture.project,host.execution.manifestHash,grant)).rejects.toMatchObject({code:'authority'});
  await expect(connect(host.url,host.ownerToken,'c')).rejects.toMatchObject({code:'authority'});
  const admission=await admitSpawn(fixture.project,fixture.view.run.id,proposal,proposal.hash,{store:fixture.runs});
  const admitted=fixture.authority.ledger.read(fixture.project),issued=await client.grantChildren(fixture.project,host.execution.manifestHash,admission.admission.grant.grant);
  expect(fixture.authority.ledger.read(fixture.project)).toEqual(admitted);
  const child=await connect(host.url,issued.token,'c');await child.reserve(fixture.project,host.execution.manifestHash,request('c'));
  await expect(child.reserve(fixture.project,host.execution.manifestHash,request('a'))).rejects.toMatchObject({code:'authority'});
  await expect(client.grantChildren(fixture.project,host.execution.manifestHash,{...grant,proposalHash:'1'.repeat(64)})).rejects.toMatchObject({code:'authority'});
  const raw=await listen(createLedgerServer({ledger:fixture.authority.ledger as ReservationLedger,cwd:fixture.project,state:state()}));
  await expect(connect(raw,issued.token)).rejects.toMatchObject({code:'authority'});
  const revoked=await post(host.url,host.ownerToken,'revoke',{grant:grant.id});expect(revoked.status).toBe(200);
  await expect(child.reserve(fixture.project,host.execution.manifestHash,request('c'))).rejects.toMatchObject({code:'authority'});
  await expect(client.grantChildren(fixture.project,host.execution.manifestHash,grant)).rejects.toMatchObject({code:'authority'});
});

it('a coordinator host fences a stopped target under the writer lock while siblings and settlement stay available',async()=>{
  const host=await start(),client=await connect(host.url,host.ownerToken),saved=request();await client.reserve(fixture.project,host.execution.manifestHash,saved);
  const ledger=host.execution.ledger,lock=join(ledger.root,'writer.lock');fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),original=ledger.reserve.bind(ledger);
  vi.spyOn(ledger,'reserve').mockImplementation((...args)=>{entered();return original(...args);});
  const pending=client.reserve(fixture.project,host.execution.manifestHash,request()).then(value=>({value}),error=>({error}));
  try{await waiting;await controlExecution(fixture.project,fixture.view.run.id,'agent-stop','a',{store:fixture.runs});}finally{fs.unlinkSync(lock);}
  expect(await pending).toMatchObject({error:{code:'authority'}});
  await expect(connect(host.url,host.ownerToken,'a')).rejects.toMatchObject({code:'authority'});
  await client.reserve(fixture.project,host.execution.manifestHash,request('b'));
  await client.settle(fixture.project,host.execution.manifestHash,{requestId:saved.id,outcome:'success',usage:{inputTokens:5,outputTokens:1}});
  expect(ledger.read(fixture.project).projection.spent.tokens).toBe(106);
});

it('cancellation survives a restart while existing usage still settles',async()=>{
  const host=await start(),client=await connect(host.url,host.ownerToken),saved=request();await client.reserve(fixture.project,host.execution.manifestHash,saved);
  await changePreparedRun(fixture.project,fixture.view.run.id,'cancelled',{store:fixture.runs});
  await expect(client.reserve(fixture.project,host.execution.manifestHash,request())).rejects.toMatchObject({code:'authority'});
  await expect(prepare()).rejects.toMatchObject({code:'policy-denied'});
  await client.settle(fixture.project,host.execution.manifestHash,{requestId:saved.id,outcome:'cancelled'});
  expect(fixture.authority.ledger.read(fixture.project).projection.requests[saved.id]!.state).toBe('unknown');
});

it.each(['policy','expired','stopped','unknown'] as const)('refuses %s authority before creating server credentials',async kind=>{
  if(kind==='policy')config.set('policy',{command:'exit 17'});
  if(kind==='expired')vi.spyOn(Date,'now').mockReturnValue(fixture.authority.ledger.read(fixture.project).manifest.deadline+1);
  if(kind==='stopped')await controlExecution(fixture.project,fixture.view.run.id,'agent-stop','a',{store:fixture.runs});
  await expect(prepare(kind==='unknown'?'missing':'a')).rejects.toThrow();expect(fs.existsSync(state().dir)).toBe(false);
});

it('serves the reviewed CLI mode with a private file, scoped metadata and clean signal handlers',async()=>{
  const tokenFile=join(root,'owner.token'),signals=['SIGINT','SIGTERM'] as const,before=signals.map(signal=>process.listeners(signal));let line='';
  const args=['serve-reviewed','--run',fixture.view.run.id,'--agent','a','--max-output-tokens','10','--project',fixture.project,'--token-file',tokenFile];
  const running=runLedgerCommand(args,text=>{line+=text;},{store:fixture.runs});
  try{
    await vi.waitFor(()=>expect(line).toContain('url'));const output=JSON.parse(line),token=fs.readFileSync(tokenFile,'utf8');
    expect(output).toMatchObject({ownerAgentId:'a',reviewed:{tokenVersion:2,reviewedAuthority:1}});expect(line).not.toContain(token);
    if(process.platform!=='win32')expect(fs.statSync(tokenFile).mode&0o077).toBe(0);
    const client=await connect(output.url,token,'a');await client.reserve(fixture.project,fixture.authority.manifestHash,request());
  }finally{process.emit('SIGTERM');await expect(running).resolves.toBe(0);}
  for(const [i,signal] of signals.entries())expect(process.listeners(signal).filter(listener=>!before[i]!.includes(listener))).toEqual([]);
});

it('refuses ambiguous reviewed arguments and credentials inside the agent workspace',async()=>{
  const args=['serve-reviewed','--run',fixture.view.run.id,'--agent','a','--max-output-tokens','10','--project',fixture.project,'--token-file',join(fixture.project,'owner.token')];
  await expect(runLedgerCommand(args,()=>{}, {store:fixture.runs})).rejects.toThrow();expect(fs.existsSync(state().dir)).toBe(false);
  for(const suffix of [['--agent','b'],['--budget',fixture.authority.ledger.root],['--unknown','x'],['--port']])expect(await runLedgerCommand([...args,...suffix],()=>{},{store:fixture.runs})).toBe(2);
});

it('closes a listener when private token delivery fails and never replaces an existing file',async()=>{
  const holder=createServer(),reserved=await listen(holder),port=new URL(reserved).port;await new Promise<void>(resolve=>holder.close(()=>resolve()));
  const tokenFile=join(root,'existing.token');fs.writeFileSync(tokenFile,'preserved',{mode:0o600});
  await expect(runLedgerCommand(['serve-reviewed','--run',fixture.view.run.id,'--agent','a','--max-output-tokens','10','--project',fixture.project,'--token-file',tokenFile,'--port',port],()=>{},{store:fixture.runs})).rejects.toMatchObject({code:'EEXIST'});
  expect(fs.readFileSync(tokenFile,'utf8')).toBe('preserved');
  const probe=createServer();servers.push(probe);await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(Number(port),'127.0.0.1',resolve);});
});
it('does not write credentials when another listener owns the selected port',async()=>{
  const holder=createServer(),reserved=await listen(holder),tokenFile=join(root,'undelivered.token');
  await expect(runLedgerCommand(['serve-reviewed','--run',fixture.view.run.id,'--agent','a','--max-output-tokens','10','--project',fixture.project,'--token-file',tokenFile,'--port',new URL(reserved).port],()=>{},{store:fixture.runs})).rejects.toMatchObject({code:'EADDRINUSE'});
  expect(fs.existsSync(tokenFile)).toBe(false);expect(holder.listening).toBe(true);
});
