import {beforeAll,afterAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {projectIdentity} from '../src/approvals/index.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {RunStore,ExecutionStore,prepareRun,changePreparedRun,prepareAgentExecution,prepareReviewedLedger,activeRemoteTasks,releaseRemoteTask} from '../src/orchestration/index.js';
import {inspectDelegatedSpawn,admitSpawn} from '../src/spawning/index.js';
import {RemoteReservationLedger,type RemoteParentBudgetLink,type ParentBudgetLink} from '../src/execution/index.js';

let build:string,root:string,servers:Server[],children:ChildProcess[],childRunDirectories:string[];
beforeAll(()=>{
 build=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-remote-process-build-')));
 execFileSync(resolve('node_modules/.bin/tsc'),['--outDir',join(build,'dist'),'--incremental','false'],{cwd:process.cwd(),timeout:30000,stdio:'pipe'});
 fs.writeFileSync(join(build,'package.json'),JSON.stringify({type:'module',version:JSON.parse(fs.readFileSync(resolve('package.json'),'utf8')).version}));fs.symlinkSync(resolve('node_modules'),join(build,'node_modules'),'junction');
},30000);
afterAll(()=>fs.rmSync(build,{recursive:true,force:true}));
beforeEach(()=>{
 config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-remote-process-')));servers=[];children=[];childRunDirectories=[];
 for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of[names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}
});
afterEach(async()=>{
 for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;}
 for(const server of servers)if(server.listening){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 for(const directory of childRunDirectories)fs.rmSync(directory,{recursive:true,force:true});
 config.resetConfig();saveHooks([]);vi.unstubAllEnvs();fs.rmSync(root,{recursive:true,force:true});
});
async function listen(server:Server,port=0){servers.push(server);await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
function runChild(project:string,runId:string){
 const native=process.env.CALLIOPE_REMOTE_PARENT_BINARY;
 const command=native??process.execPath,args=[...(native?[]:[join(build,'dist/bin.js')]),'run','resume',runId,'--allow-mutations','--max-output-tokens','10','--json'];
 const child=spawn(command,args,{cwd:project,env:{...process.env},stdio:['ignore','pipe','pipe']});children.push(child);
 let output='',error='';child.stdout!.on('data',chunk=>output+=chunk);child.stderr!.on('data',chunk=>error+=chunk);
 const closed=new Promise<number|null>(resolve=>child.once('close',resolve));return {child,closed,output:()=>output,error:()=>error};
}

it.each(['complete','owner-restart','offline','cancel','worker-death','budget-exhaustion'] as const)('preserves one remote parent allowance across native processes: %s',async mode=>{
 let requests=0,inFlight=0,maximum=0,hold=true;const replies:(()=>void)[]=[];
 const provider=createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'process-fixture',context_length:32768,max_output_tokens:100,pricing:{input:0,output:0},capabilities:{chat:true,tools:true,streaming:true}}]}));return;}
  let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
   requests++;inFlight++;maximum=Math.max(maximum,inFlight);let finished=false;const done=()=>{if(!finished){finished=true;inFlight--;}};res.once('close',done);
   const body=JSON.parse(raw),content=JSON.stringify({version:1,summary:'Public result.',outputs:[{id:'report-a',content:'public toy'}]});
   const send=()=>{const completion={id:'fixture',model:'process-fixture',created:1,usage:{prompt_tokens:5,completion_tokens:1}};
    if(body.stream){res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({...completion,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
    else res.end(JSON.stringify({...completion,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));done();};
   if(hold)replies.push(send);else send();
  });
 });
 const providerUrl=await listen(provider);config.setProviderCred('deepseek',{apiKey:'public-process-fixture',baseUrl:providerUrl+'/v1'});config.set('autoUpgrade',false);config.set('setupComplete',true);config.set('defaultProvider','deepseek');config.set('defaultModel','process-fixture');config.set('routing',{enabled:true,providerPool:['deepseek']});
 const owner=join(root,'owner');fs.mkdirSync(owner);const plan=verifiedPlan();Object.assign(plan.limits,{maxConcurrent:1,tokenBudget:2000000,costBudgetUsd:4,timeBudgetMs:120000});
 for(const agent of plan.agents){Object.assign(agent,{tokenBudget:agent.parentId?500000:2000000,costBudgetUsd:agent.parentId?1:4,timeBudgetMs:120000,preference:{provider:'deepseek',model:'process-fixture'}});}
 const parent=await coordinatorRun(owner,plan),project=join(root,'placed');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));const identity=projectIdentity(project);
 const tokens=mode==='budget-exhaustion'?50000:100000;
 const agent={...structuredClone(plan.agents[1]!),tokenBudget:mode==='budget-exhaustion'?tokens:500000,id:'placed',allowedPaths:[{path:'.',access:'write' as const}],maxChildDepth:1,maxChildCount:1};
 const proposal=(await inspectDelegatedSpawn(parent.project,parent.view.run.id,{version:2,parentId:'coordinator',agents:[agent],tasks:[],delegation:{project:{root:identity.project,key:identity.projectKey},reference:'astrolift:process-fixture',observationHash:'a'.repeat(64)}},{store:parent.runs})).proposal;
 const admission=await admitSpawn(parent.project,parent.view.run.id,proposal,proposal.hash,{store:parent.runs});
 let host=await prepareReviewedLedger(parent.project,parent.view.run.id,'coordinator',10,{store:parent.runs});const hostUrl=await listen(host.server);
 const client=await RemoteReservationLedger.connect({url:hostUrl,token:host.ownerToken,root:join(root,'owner-checkpoint')});
 const granted=await client.grantChildren(parent.project,host.execution.manifestHash,admission.admission.grant.grant),tokenFile=join(root,'child.token');fs.writeFileSync(tokenFile,granted.token,{mode:0o600});
 const link:RemoteParentBudgetLink={version:2,url:hostUrl,tokenFile,checkpointRoot:join(root,'child-checkpoint'),runId:parent.view.run.id,budgetManifestHash:host.execution.manifestHash,agentId:'placed',accountMap:{coordinator:'placed'},reviewed:host.reviewedContext};
 const runs=new RunStore();
 const prepare=async(name:string,parentBudget:ParentBudgetLink=link,wall=30000)=>{
  const plan=verifiedPlan();plan.agents=plan.agents.slice(0,1);plan.agents[0]!.maxChildDepth=0;plan.agents[0]!.maxChildCount=0;plan.agents[0]!.preference={provider:'deepseek',model:'process-fixture'};
  plan.tasks=plan.tasks.slice(0,1);plan.tasks[0]!.agentId='coordinator';delete plan.tasks[0]!.outputs[0]!.path;Object.assign(plan.limits,{maxAgents:1,maxTasks:1,maxDepth:0,maxConcurrent:1,tokenBudget:tokens,costBudgetUsd:.01,timeBudgetMs:wall});Object.assign(plan.agents[0]!,{tokenBudget:tokens,costBudgetUsd:.01,timeBudgetMs:wall});
  fs.writeFileSync(join(project,name+'.json'),JSON.stringify(plan));const prepared=await prepareRun(project,name+'.json',{store:runs}),view=await changePreparedRun(project,prepared.run.id,'approved',{store:runs});
  await prepareAgentExecution(project,view.run.id,'coordinator',10,{store:runs,parentBudget});childRunDirectories.push(join(runs.root,view.run.id));return view;
 };
 const middle=await prepare('middle',link,60000),middleExecution=await prepareAgentExecution(project,middle.run.id,'coordinator',10,{store:runs});
 const local:ParentBudgetLink={version:1,runsRoot:runs.root,runId:middle.run.id,runManifestHash:middle.manifest.hash,approvalRevision:middle.run.revision,budgetManifestHash:middleExecution.manifestHash,agentId:'coordinator'};
 const a=await prepare('a',local),b=await prepare('b'),one=runChild(project,a.run.id);
 await vi.waitFor(()=>expect(requests,one.error()+one.output()).toBe(1),{timeout:12000});
 if(mode==='offline'){
  const port=(host.server.address() as AddressInfo).port;host.server.closeAllConnections();await new Promise<void>(resolve=>host.server.close(()=>resolve()));
  const denied=runChild(project,b.run.id);expect(await denied.closed,denied.error()+denied.output()).toBe(3);
  expect(requests).toBe(1);expect(activeRemoteTasks(parent.store.read().state)).toHaveLength(1);
  host=await prepareReviewedLedger(parent.project,parent.view.run.id,'coordinator',10,{store:parent.runs});await listen(host.server,port);
  hold=false;for(const reply of replies)reply();expect(await one.closed,one.error()+one.output()).toBe(0);
  expect(requests).toBe(1);expect(activeRemoteTasks(parent.store.read().state)).toEqual([]);return;
 }
 // Reconnect only after the owner is listening: an unavailable authority must refuse new work.
 if(mode==='owner-restart'){
  const port=(host.server.address() as AddressInfo).port;host.server.closeAllConnections();await new Promise<void>(resolve=>host.server.close(()=>resolve()));
  host=await prepareReviewedLedger(parent.project,parent.view.run.id,'coordinator',10,{store:parent.runs});await listen(host.server,port);
  expect(activeRemoteTasks(new ExecutionStore(join(parent.runs.root,parent.view.run.id),parent.view.manifest).read().state)).toHaveLength(1);
 }
 const two=runChild(project,b.run.id);
 const secondStore=new ExecutionStore(join(runs.root,b.run.id),b.manifest);
 await vi.waitFor(()=>expect(secondStore.exists()&&secondStore.read().state.tasks['inspect-a']?.status).toBe('running'),{timeout:8000});
 expect(requests).toBe(1);expect(activeRemoteTasks(parent.store.read().state)).toHaveLength(1);
 if(mode==='worker-death'||mode==='budget-exhaustion'){
  one.child.kill('SIGKILL');await one.closed;
  expect(activeRemoteTasks(parent.store.read().state)).toHaveLength(1);
  expect(Object.values(parent.authority.ledger.read(parent.project).projection.requests)).toMatchObject([{state:'pending'}]);
  if(mode==='budget-exhaustion'){const intermediate=new ExecutionStore(join(runs.root,middle.run.id),middle.manifest);await releaseRemoteTask(intermediate,activeRemoteTasks(intermediate.read().state)[0]!);}
 }
 if(mode==='cancel'||mode==='worker-death')await changePreparedRun(parent.project,parent.view.run.id,'cancelled',{store:parent.runs});
 hold=false;for(const reply of replies)reply();
 if(mode==='complete'||mode==='owner-restart'){
  expect(await one.closed,one.error()+one.output()).toBe(0);expect(await two.closed,two.error()+two.output()).toBe(0);
  expect(requests).toBe(2);expect(maximum).toBe(1);expect(activeRemoteTasks(parent.store.read().state)).toEqual([]);
  expect(parent.authority.ledger.read(parent.project).projection.spent.tokens).toBe(12);
 }else{
  if(mode==='cancel')await one.closed;await two.closed;
  expect(requests).toBe(1);expect(maximum).toBe(1);
  expect(activeRemoteTasks(parent.store.read().state)).toHaveLength(mode==='worker-death'?1:0);
  if(mode==='budget-exhaustion'){expect(parent.authority.ledger.read(parent.project).projection.spent.tokens).toBeGreaterThan(tokens/2);expect(secondStore.read().state.status).toBe('denied');}
  expect(secondStore.read().state.status).not.toBe('completed');
 }
},30000);
