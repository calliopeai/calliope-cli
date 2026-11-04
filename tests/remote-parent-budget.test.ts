import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {projectIdentity} from '../src/approvals/index.js';
import {providerTarget} from '../src/health/index.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {RunStore,prepareRun,changePreparedRun,prepareAgentExecution,prepareReviewedLedger,executeReviewedRun,remoteTaskAdmission,activeRemoteTasks,ExecutionStore} from '../src/orchestration/index.js';
import {inspectDelegatedSpawn,admitSpawn} from '../src/spawning/index.js';
import {RemoteReservationLedger,ExecutionGuard,parentRequestId,remoteParentBudgetCapabilities,type RemoteParentBudgetLink} from '../src/execution/index.js';

let root:string,project:string,r:Awaited<ReturnType<typeof coordinatorRun>>,runs:RunStore,servers:Server[],link:RemoteParentBudgetLink;
async function serve(){const host=await prepareReviewedLedger(r.project,r.view.run.id,'coordinator',10,{store:r.runs});servers.push(host.server);await new Promise<void>(resolve=>host.server.listen(0,'127.0.0.1',resolve));return {...host,url:`http://127.0.0.1:${(host.server.address() as AddressInfo).port}`};}
beforeEach(async()=>{
 config.resetConfig();saveHooks([]);vi.stubEnv('DEEPSEEK_BASE_URL','http://127.0.0.1:9/v1');vi.stubEnv('DEEPSEEK_API_KEY','public-test-only');servers=[];root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-remote-funding-')));
 const owner=join(root,'owner');fs.mkdirSync(owner);const plan=verifiedPlan();plan.limits.timeBudgetMs=300000;plan.limits.maxConcurrent=1;plan.limits.tokenBudget=2000000;plan.limits.costBudgetUsd=4;for(const agent of plan.agents){agent.timeBudgetMs=300000;agent.tokenBudget=agent.parentId?500000:2000000;agent.costBudgetUsd=agent.parentId?1:4;}r=await coordinatorRun(owner,plan);
 project=join(root,'placed');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.mkdirSync(join(project,'b'));runs=new RunStore(join(root,'placed-runs'));
 const identity=projectIdentity(project),agent={...structuredClone(plan.agents[1]!),id:'placed',allowedPaths:[{path:'.',access:'write' as const}],maxChildDepth:1,maxChildCount:1};
 const proposal=(await inspectDelegatedSpawn(r.project,r.view.run.id,{version:2,parentId:'coordinator',agents:[agent],tasks:[],delegation:{project:{root:identity.project,key:identity.projectKey},reference:'astrolift:placed',observationHash:'a'.repeat(64)}},{store:r.runs})).proposal;
 const admission=await admitSpawn(r.project,r.view.run.id,proposal,proposal.hash,{store:r.runs}),host=await serve();
 const client=await RemoteReservationLedger.connect({url:host.url,token:host.ownerToken,root:join(root,'owner-cache')});
 const issued=await client.grantChildren(r.project,host.execution.manifestHash,admission.admission.grant.grant),tokenFile=join(root,'placed.token');fs.writeFileSync(tokenFile,issued.token,{mode:0o600});
 link={version:2,url:host.url,tokenFile,checkpointRoot:join(root,'placed-cache'),runId:r.view.run.id,budgetManifestHash:host.execution.manifestHash,agentId:'placed',accountMap:{coordinator:'placed'},reviewed:host.reviewedContext};
});
afterEach(async()=>{vi.restoreAllMocks();for(const server of servers)if(server.listening){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}vi.unstubAllGlobals();vi.unstubAllEnvs();config.resetConfig();saveHooks([]);fs.rmSync(root,{recursive:true,force:true});});
async function child(parent=link,wide=false,tokens=800,supervised=false){const plan=verifiedPlan();if(supervised){plan.version=4;plan.supervision={version:1,controllerId:'coordinator',maxRounds:2,maxStalledRounds:1,maxOutputTokens:10,principle:'robustness',allowedActions:[]};}if(!wide){plan.agents=plan.agents.slice(0,1);plan.agents[0]!.maxChildDepth=0;plan.agents[0]!.maxChildCount=0;plan.tasks=plan.tasks.slice(0,1);plan.tasks[0]!.agentId="coordinator";delete plan.tasks[0]!.outputs[0]!.path;Object.assign(plan.limits,{maxAgents:1,maxTasks:1,maxDepth:0,maxConcurrent:1});}if(supervised){
 plan.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
 const agent=plan.agents[0]!;agent.allowedTools=['read_file'];agent.allowedPaths=[{path:'.',access:'read'}];
 const task=plan.tasks[0]!;delete task.outputs[0]!.path;task.outputs.push({id:'patch',kind:'patch',description:'Executor-owned patch.'});task.isolation={mode:'read-only-v1',patchArtifactId:'patch',commands:[]};
 if(!fs.existsSync(join(project,'.git'))){const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe'});git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');fs.writeFileSync(join(project,'a/seed.txt'),'public fixture');git('add','a/seed.txt');git('-c','commit.gpgsign=false','commit','-qm','fixture');}
 }plan.limits.tokenBudget=tokens;plan.limits.costBudgetUsd=.008;plan.limits.timeBudgetMs=10000;for(const agent of plan.agents){agent.tokenBudget=agent.parentId?Math.floor(tokens/4):tokens;agent.costBudgetUsd=agent.parentId ? .002 : .008;agent.timeBudgetMs=10000;}const file=randomUUID()+'.json';fs.writeFileSync(join(project,file),JSON.stringify(plan));const prepared=await prepareRun(project,file,{store:runs});const view=await changePreparedRun(project,prepared.run.id,'approved',{store:runs});return {view,execution:await prepareAgentExecution(project,view.run.id,'coordinator',10,{store:runs,parentBudget:parent})};}
const request=()=>({id:randomUUID(),agentId:'coordinator',provider:'deepseek',model:'fixture',target:providerTarget('deepseek').key,inputTokens:99,outputTokens:1,inputPrice:0,outputPrice:0,costNanos:0});
it('funds a native run in a different owner-bound workspace and settles the same parent charge',async()=>{
 expect(remoteParentBudgetCapabilities()).toMatchObject({version:1,linkVersion:2,executionEventVersion:13,reservationEventVersion:6,accountMapping:'native-admissions-only',taskConcurrency:'parent-execution-journal'});
 const c=await child(),value=request();await c.execution.ledger.reserve(project,c.execution.manifestHash,value);
 const own=c.execution.ledger.read(project),parent=r.authority.ledger.read(r.project),id=parentRequestId(own.manifest,value.id);
 expect(own.projection.spent.tokens).toBe(100);expect(parent.projection.requests[id]!.reservation.agentId).toBe('placed');expect(parent.projection.spent.tokens).toBe(100);
 await c.execution.ledger.settle(project,c.execution.manifestHash,{requestId:value.id,outcome:'success',usage:{inputTokens:4,outputTokens:1}});
 expect(r.authority.ledger.read(r.project).projection.spent.tokens).toBe(5);
 const reopened=await prepareAgentExecution(project,c.view.run.id,'coordinator',10,{store:runs});expect(reopened.ledger.read(project).manifest).toEqual(own.manifest);
});
it.each(['context','account','cycle','budget','alias'] as const)('refuses a forged %s before creating a child allowance',async kind=>{
 const forged=structuredClone(link);
 if(kind==='context')forged.reviewed.approvalRevision=randomUUID();
 if(kind==='account')forged.agentId='b';
 if(kind==='cycle')forged.reviewed.lineage=[forged.runId,forged.runId];
 if(kind==='budget')forged.budgetManifestHash='f'.repeat(64);
 if(kind==='alias')forged.accountMap={coordinator:'placed',hidden:'placed'};
 await expect(child(forged)).rejects.toThrow();expect(r.authority.ledger.read(r.project).projection.spent.tokens).toBe(0);
});
it('revokes tool authority after parent cancellation but permits late settlement',async()=>{
 const c=await child(),value=request();await c.execution.ledger.reserve(project,c.execution.manifestHash,value);
 await changePreparedRun(r.project,r.view.run.id,'cancelled',{store:r.runs});
 await expect(new ExecutionGuard(c.execution,project).refreshAuthority()).rejects.toThrow();
 await expect(c.execution.ledger.reserve(project,c.execution.manifestHash,request())).rejects.toThrow();
 await c.execution.ledger.settle(project,c.execution.manifestHash,{requestId:value.id,outcome:'success',usage:{inputTokens:4,outputTokens:1}});
 expect(r.authority.ledger.read(r.project).projection.spent.tokens).toBe(5);
});
it('retains the parent charge when the child commit is interrupted and recovers without duplicate admission',async()=>{
 const c=await child(),value=request();let failure:unknown;
 try{await c.execution.ledger.reserve(project,c.execution.manifestHash,value,undefined,()=>{if(r.authority.ledger.read(r.project).projection.spent.tokens)throw new Error('interrupted');});}catch(error){failure=error;}
 expect(failure).toBeInstanceOf(Error);expect(c.execution.ledger.canReleaseFailedReservation?.(failure)).toBe(false);
 expect(c.execution.ledger.read(project).projection.spent.tokens).toBe(0);expect(r.authority.ledger.read(r.project).projection.spent.tokens).toBe(100);
 await c.execution.ledger.reserve(project,c.execution.manifestHash,value);expect(r.authority.ledger.read(r.project).projection.spent.tokens).toBe(100);
});

it('refuses an internal child graph wider or deeper than the original delegated agent',async()=>{
 await expect(child(link,true)).rejects.toMatchObject({code:'authority'});
});

it.each([false,true])('runs actual native coordinators through one shared parent execution slot (supervised=%s)',async supervised=>{
 config.setProviderCred('deepseek',{apiKey:'public-test-only'});config.set('defaultProvider','deepseek');config.set('defaultModel','fixture');
 const original=globalThis.fetch;let requests=0,inFlight=0,maximum=0,releaseFirst!:()=>void;
 const firstGate=new Promise<void>(resolve=>{releaseFirst=resolve;});
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const req=new Request(input,init);if(new URL(req.url).origin!=='http://127.0.0.1:9')return original(input,init);
  if(req.method==='GET')return new Response(JSON.stringify({data:[{id:'fixture',context_length:32768,max_output_tokens:100,pricing:{input:0,output:0},capabilities:{chat:true,tools:true,streaming:true}}]}),{headers:{'content-type':'application/json'}});
  requests++;inFlight++;maximum=Math.max(maximum,inFlight);if(requests===1)await firstGate;inFlight--;
  const body=await req.json(),context=JSON.parse(body.messages.find((message:any)=>message.role==='user'&&message.content.startsWith('{')).content);
  const content=JSON.stringify(context.kind==='controller-review'?{version:1,action:'continue',reason:'The recorded checks passed.',evidence:context.outcomes.map((outcome:any)=>outcome.eventId)}:{version:1,summary:'Public result.',outputs:[{id:'report-a',content:'public toy'}]});
  const completion={id:'fixture',model:'fixture',created:1,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:1}};
  if(!body.stream)return new Response(JSON.stringify(completion),{headers:{'content-type':'application/json'}});
  return new Response('data: '+JSON.stringify({...completion,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }));
 const a=await child(link,false,100000,supervised),b=await child(link,false,100000,supervised);
 if(supervised){execFileSync('git',['add','.'],{cwd:project,stdio:'pipe'});execFileSync('git',['-c','commit.gpgsign=false','commit','-qm','reviewed fixtures'],{cwd:project,stdio:'pipe'});}
 const controller=new AbortController();
 const run=(c:typeof a)=>executeReviewedRun(project,c.view.run.id,{store:runs,resume:true,maxOutputTokens:10,signal:controller.signal,approve:async()=> 'allow'});
 const completed:unknown[]=[];const one=run(a).then(result=>{completed.push({status:result.status,tasks:result.execution.state.tasks,supervision:result.execution.state.supervision});return result;}),two=run(b).then(result=>{completed.push({status:result.status,tasks:result.execution.state.tasks,supervision:result.execution.state.supervision});return result;});
 try{
  await vi.waitFor(()=>expect(requests,JSON.stringify(completed)).toBe(1),{timeout:5000});
  expect(Object.values(r.store.read().state.remoteTasks??{}).filter(x=>x.status==='active')).toHaveLength(1);
  releaseFirst();const results=await Promise.all([one,two]);expect(results.map(result=>result.status)).toEqual(['completed','completed']);
  expect(requests,JSON.stringify(completed)).toBe(supervised?4:2);expect(maximum).toBe(1);
  expect(Object.values(r.store.read().state.remoteTasks??{})).toHaveLength(supervised?4:2);
  if(supervised)expect(Object.values(r.store.read().state.remoteTasks??{}).filter(x=>x.admission.kind==='supervision')).toHaveLength(2);
  expect(Object.values(r.store.read().state.remoteTasks??{}).every(x=>x.status==='released')).toBe(true);
  expect(r.authority.ledger.read(r.project).projection.spent.tokens).toBeGreaterThan(0);
 }finally{releaseFirst();controller.abort();await Promise.allSettled([one,two]);}
},20000);

it('retains a remote slot after its admission acknowledgement is lost and recovers the same admission',async()=>{
 const original=globalThis.fetch,controller=new AbortController();
 const transport:typeof fetch=async(input,init)=>{const response=await original(input,init);if(String(input).endsWith('/task-admit')){await response.json();controller.abort();throw new Error('lost acknowledgement');}return response;};
 const options={url:link.url,token:fs.readFileSync(link.tokenFile,'utf8'),root:join(root,'ack-cache'),reviewed:link.reviewed,execution:{cwd:project,agentId:'placed'}};
 const first=await RemoteReservationLedger.connect({...options,fetch:transport});
 const admission=remoteTaskAdmission({version:1,runId:randomUUID(),manifestHash:'c'.repeat(64),taskId:'work',attempt:1,startEventId:randomUUID(),startEventHash:'d'.repeat(64),sessionId:randomUUID(),agentId:'placed',deadline:Date.now()+5000});
 await expect(first.admitTask(admission,project,controller.signal)).rejects.toThrow();
 expect(activeRemoteTasks(r.store.read().state)).toEqual([admission]);
 const saved=r.store.read(),reconnected=await RemoteReservationLedger.connect(options);
 await reconnected.admitTask(admission,project);expect(r.store.read()).toEqual(saved);
 await reconnected.releaseTask(admission);expect(activeRemoteTasks(r.store.read().state)).toEqual([]);
});

it('replays a lost release acknowledgement without releasing a different admission',async()=>{
 const options={url:link.url,token:fs.readFileSync(link.tokenFile,'utf8'),root:join(root,'release-cache'),reviewed:link.reviewed,execution:{cwd:project,agentId:'placed'}};
 const client=await RemoteReservationLedger.connect(options),admission=remoteTaskAdmission({version:1,runId:randomUUID(),manifestHash:'c'.repeat(64),kind:'supervision',role:'reviewer',round:1,startEventId:randomUUID(),startEventHash:'d'.repeat(64),sessionId:randomUUID(),agentId:'placed',deadline:Date.now()+5000});
 await client.admitTask(admission,project);
 const original=globalThis.fetch,transport:typeof fetch=async(input,init)=>{const response=await original(input,init);if(String(input).endsWith('/task-release')){await response.json();throw new Error('lost release acknowledgement');}return response;};
 const uncertain=await RemoteReservationLedger.connect({...options,fetch:transport,attempts:1});
 await expect(uncertain.releaseTask(admission)).rejects.toThrow();expect(activeRemoteTasks(r.store.read().state)).toEqual([]);
 const saved=r.store.read();await client.releaseTask(admission);expect(r.store.read()).toEqual(saved);
 const {id:ignored,...body}=admission;const other=remoteTaskAdmission({...body,startEventId:randomUUID()});
 await expect(client.releaseTask(other)).rejects.toThrow();expect(r.store.read()).toEqual(saved);
});

it('propagates nested remote admissions to the original parent and retains them across owner restart',async()=>{
 const a=await child(),b=await child();
 const host=async(c:typeof a)=>{
  const service=await prepareReviewedLedger(project,c.view.run.id,'coordinator',10,{store:runs});servers.push(service.server);
  await new Promise<void>(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const client=await RemoteReservationLedger.connect({url:`http://127.0.0.1:${(service.server.address() as AddressInfo).port}`,token:service.ownerToken,root:join(root,randomUUID()),reviewed:service.reviewedContext,execution:{cwd:project,agentId:'coordinator'}});
  return {client,history:new ExecutionStore(join(runs.root,c.view.run.id),c.view.manifest)};
 };
 const first=await host(a),second=await host(b);
 const ticket=(deadline:number)=>remoteTaskAdmission({version:1,runId:randomUUID(),manifestHash:'c'.repeat(64),taskId:'nested',attempt:1,startEventId:randomUUID(),startEventHash:'d'.repeat(64),sessionId:randomUUID(),agentId:'coordinator',deadline});
 const accepted=ticket(Date.now()+3000);await first.client.admitTask(accepted,project);
 expect(activeRemoteTasks(first.history.read().state)).toEqual([accepted]);
 expect(activeRemoteTasks(r.store.read().state)).toMatchObject([{runId:accepted.runId,agentId:'placed',startEventId:accepted.startEventId}]);
 await expect(second.client.admitTask(ticket(Date.now()+250),project)).rejects.toThrow(/deadline/i);
 expect(activeRemoteTasks(second.history.read().state)).toEqual([]);
 const restarted=new ExecutionStore(join(r.runs.root,r.view.run.id),r.view.manifest);
 expect(activeRemoteTasks(restarted.read().state)).toHaveLength(1);
 await first.client.releaseTask(accepted);
 expect(activeRemoteTasks(first.history.read().state)).toEqual([]);expect(activeRemoteTasks(restarted.read().state)).toEqual([]);
 await first.client.releaseTask(accepted);expect(activeRemoteTasks(restarted.read().state)).toEqual([]);
},15000);


it('rejects a parent without native capacity negotiation before creating a child budget',async()=>{
 const original=globalThis.fetch;
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const response=await original(input,init);if(!String(input).endsWith('/hello'))return response;
  const body=await response.json();body.operations=body.operations.filter((op:string)=>!['task-admit','task-release'].includes(op));return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 });
 await expect(child()).rejects.toMatchObject({code:'unavailable'});
 expect(r.authority.ledger.read(r.project).projection.spent.tokens).toBe(0);
});


it('refuses new inference after a held remote task deadline and retains its unresolved slot',async()=>{
 const client=await RemoteReservationLedger.connect({url:link.url,token:fs.readFileSync(link.tokenFile,'utf8'),root:join(root,'deadline-cache'),reviewed:link.reviewed,execution:{cwd:project,agentId:'placed'}});
 const value=remoteTaskAdmission({version:1,runId:randomUUID(),manifestHash:'c'.repeat(64),taskId:'work',attempt:1,startEventId:randomUUID(),startEventHash:'d'.repeat(64),sessionId:randomUUID(),agentId:'placed',deadline:Date.now()+5000});
 await client.admitTask(value,project);const before=r.authority.ledger.read(r.project);
 vi.spyOn(Date,'now').mockReturnValue(value.deadline);
 await expect(client.reserve(project,link.budgetManifestHash,{...request(),agentId:'placed',remoteAdmission:value,attribution:{version:1,kind:'task',taskId:'work',attempt:1,eventId:value.startEventId,eventHash:value.startEventHash,sessionId:value.sessionId}})).rejects.toMatchObject({code:'deadline'});
 expect(r.authority.ledger.read(r.project)).toEqual(before);expect(activeRemoteTasks(r.store.read().state)).toEqual([value]);
 await client.releaseTask(value);expect(activeRemoteTasks(r.store.read().state)).toEqual([]);
});
