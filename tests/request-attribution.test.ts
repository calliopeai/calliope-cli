import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {ReservationLedger,manifestHash,replayReservations,requestCostNanos,validateRequestAttribution,type RequestAttribution,type RequestReservation} from '../src/execution/index.js';
import {readRunAccounting,runOrchestrationCommand,type TaskOutput,type ExecutionEvent} from '../src/orchestration/index.js';
import {canonicalJson,digest} from '../src/approvals/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';

let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-attribution-')));});
afterEach(()=>{config.resetConfig();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();fs.rmSync(root,{recursive:true,force:true});});
const source=():RequestAttribution=>({version:1,kind:'task',eventId:randomUUID(),eventHash:'c'.repeat(64),sessionId:randomUUID(),taskId:'inspect-a',attempt:1});
const request=(attribution?:RequestAttribution,agentId='a'):RequestReservation=>({id:randomUUID(),agentId,provider:'deepseek',model:'public-toy',target:'b'.repeat(64),inputTokens:90,outputTokens:10,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(90,10,1,2),...(attribution?{attribution}:{})});
function setup(){const project=join(root,'project');fs.mkdirSync(project);const manifest=executionManifest(project),ledger=new ReservationLedger(join(root,'budget'));ledger.create(manifest);return{project,manifest,ledger,hash:manifestHash(manifest)};}
const taskSource=(event:ExecutionEvent):RequestAttribution=>{if(event.change.type!=='task_started')throw Error('Expected start');return{version:1,kind:'task',eventId:event.id,eventHash:event.hash,sessionId:event.change.sessionId,taskId:event.change.taskId,attempt:event.change.attempt};};
const failed=(taskId='inspect-a',agentId='a'):TaskOutput=>({version:1,taskId,agentId,status:'failed',summary:'No accepted work.',changedFiles:[],artifacts:[],testEvidence:[],unresolvedRisks:[],recommendedNextAction:'Inspect.',checks:[]});
async function start(run:Awaited<ReturnType<typeof coordinatorRun>>,taskId='inspect-a',attempt=1,attributed=true){return run.store.append({type:'task_started',taskId,attempt,sessionId:randomUUID(),...(attributed?{requestAttribution:1 as const}:{})});}
async function finish(run:Awaited<ReturnType<typeof coordinatorRun>>,taskId='inspect-a',agentId='a'){await run.store.append({type:'task_finished',taskId,status:'failed',output:failed(taskId,agentId)});}
function groups(run:Awaited<ReturnType<typeof coordinatorRun>>){const accounting=readRunAccounting(run.store);expect(accounting.status).toBe('available');if(accounting.status!=='available'||accounting.attribution?.status!=='available')throw Error(JSON.stringify(accounting));return accounting.attribution;}

it.each(['success','error','cancelled','invalid-usage','missing','oversized'] as const)('retains attributed %s charges and immutable legacy records through restart',async outcome=>{
  const {project,ledger,manifest,hash}=setup(),legacy=request();await ledger.reserve(project,hash,legacy);await ledger.settle(project,hash,{requestId:legacy.id,outcome:'success',usage:{inputTokens:1,outputTokens:1}});
  const before=ledger.read(project);expect(before.projection.version).toBe(1);expect(before.projection.requests[legacy.id]!.accounted).toBeUndefined();
  const r=request(source());await ledger.reserve(project,hash,r);
  const settled=await ledger.settle(project,hash,{requestId:r.id,outcome:outcome==='missing'||outcome==='oversized'?'success':outcome,...(outcome==='missing'?{}:{usage:{inputTokens:outcome==='oversized'?120:10,outputTokens:2}})});
  const saved=new ReservationLedger(ledger.root).read(project),entry=settled.requests[r.id]!;
  expect(saved.events.slice(0,2)).toEqual(before.events);expect(saved.events[2]!.version).toBe(3);expect(saved.events[3]!.version).toBe(1);expect(settled.version).toBe(3);
  expect(entry.reservation.attribution).toEqual(r.attribution);expect(entry.accounted).toEqual(outcome==='success'?{tokens:12,costNanos:14000}:outcome==='oversized'?{tokens:122,costNanos:124000}:{tokens:100,costNanos:110000});
  expect(entry.state).toBe(outcome==='success'?'settled':['invalid-usage','oversized'].includes(outcome)?'exceeded':'unknown');
  expect(replayReservations(manifest,saved.events)).toEqual(saved.projection);
  expect(saved.projection.spent.costNanos).toBe(entry.accounted!.costNanos+3000);
});

it.each([
  {version:2},{kind:'other'},{eventId:'invalid'},{eventHash:'bad'},{sessionId:'secret\nvalue'},{sessionId:''},{taskId:'../outside'},{attempt:0},{attempt:5},{attempt:1.5},{role:'controller'},{extra:true},
])('denies malformed task attribution before mutating the ledger: %j',async patch=>{
  const {project,ledger,hash}=setup(),before=ledger.read(project),r=request({...source(),...patch} as RequestAttribution);
  await expect(ledger.reserve(project,hash,r)).rejects.toThrow();expect(ledger.read(project)).toEqual(before);
});

it('validates review roles, rejects version downgrades and keeps attribution private from caller mutation',async()=>{
  const task=source(),{taskId,attempt,...base}=task as Extract<RequestAttribution,{kind:'task'}>,review={...base,kind:'supervision' as const,role:'reviewer' as const,round:2};
  expect(validateRequestAttribution(review)).toEqual(review);
  for(const patch of [{role:'worker'},{round:0},{round:65},{taskId:'task'}])expect(()=>validateRequestAttribution({...review,...patch})).toThrow();
  const {project,manifest,ledger,hash}=setup(),r=request(structuredClone(review));await ledger.reserve(project,hash,r);r.attribution!.eventHash='e'.repeat(64);
  const saved=ledger.read(project);expect(saved.projection.requests[r.id]!.reservation.attribution).toEqual(review);
  const old=structuredClone(saved.events[0]!);old.version=1;const {hash:ignored,...body}=old;old.hash=digest(canonicalJson(body));expect(()=>replayReservations(manifest,[old])).toThrow();
});

it('reserves concurrent attributed requests independently and leaves cancelled admission empty',async()=>{
  const {project,ledger,hash}=setup(),a=request(source()),b=request({...source(),taskId:'inspect-b'},'b');
  await expect(ledger.reserve(project,hash,a,AbortSignal.abort())).rejects.toMatchObject({name:'AbortError'});expect(ledger.read(project).events).toHaveLength(0);
  await Promise.all([a,b].map(r=>ledger.reserve(project,hash,r)));
  const state=ledger.read(project).projection;expect(state.spent).toEqual({tokens:200,costNanos:220000});expect(Object.values(state.requests).map(r=>r.reservation.attribution!.eventId).sort()).toEqual([a.attribution!.eventId,b.attribution!.eventId].sort());
});

it('partitions retries and other tasks owned by the same agent without timestamp inference',async()=>{
  const plan=verifiedPlan();plan.tasks=plan.tasks.slice(0,1);const second=structuredClone(plan.tasks[0]!);second.id='second';second.outputs[0]!.id='second-report';second.acceptanceChecks![0]!.artifactId='second-report';plan.tasks.push(second);
  const run=await coordinatorRun(root,plan),owner=randomUUID();await run.store.append({type:'started',ownerId:owner});
  const first=await start(run),r1=request(taskSource(first));await run.authority.ledger.reserve(run.project,run.authority.manifestHash,r1);await run.authority.ledger.settle(run.project,run.authority.manifestHash,{requestId:r1.id,outcome:'success',usage:{inputTokens:3,outputTokens:1}});await finish(run);
  await run.store.append({type:'task_reset',taskId:'inspect-a',source:'manual'});const retry=await start(run,'inspect-a',2),r2=request(taskSource(retry));await run.authority.ledger.reserve(run.project,run.authority.manifestHash,r2);await run.authority.ledger.settle(run.project,run.authority.manifestHash,{requestId:r2.id,outcome:'cancelled'});await finish(run);
  const other=await start(run,'second');await finish(run,'second');await run.store.append({type:'finished',ownerId:owner,status:'failed'});
  const accounted=groups(run);expect(accounted.groups[first.id]).toMatchObject({status:'available',accounted:{tokens:4,costNanos:5000},requestIds:[r1.id],usageComplete:true});
  expect(accounted.groups[retry.id]).toMatchObject({status:'available',accounted:{tokens:100,costNanos:110000},requestIds:[r2.id],usageComplete:false,requests:{unknown:1}});
  expect(accounted.groups[other.id]).toMatchObject({status:'available',accounted:{tokens:0,costNanos:0},requestIds:[],usageComplete:true});
  const before=run.authority.ledger.read(run.project),events=run.store.read();vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No provider calls during inspection');}));
  for(const action of ['status','replay']){const rows:string[]=[];expect(await runOrchestrationCommand('run',[action,run.view.run.id,'--json'],{cwd:run.project,store:run.runs,write:l=>rows.push(l)})).toBe(0);expect(JSON.parse(rows.at(-1)!).version).toBe(2);expect(JSON.parse(rows.at(-1)!).data.accounting.attribution).toEqual(accounted);}
  expect(run.store.read()).toEqual(events);expect(run.authority.ledger.read(run.project)).toEqual(before);expect(fetch).not.toHaveBeenCalled();
});

it.each(['hash','event','task','session','attempt','agent','kind','late'] as const)('rejects a valid ledger with a foreign %s binding without losing total charges',async mismatch=>{
  const run=await coordinatorRun(root);await run.store.append({type:'started',ownerId:randomUUID()});const begun=await start(run),attribution=taskSource(begun),r=request(attribution);
  if(mismatch==='hash')attribution.eventHash='f'.repeat(64);if(mismatch==='event')attribution.eventId=randomUUID();if(mismatch==='session')attribution.sessionId=randomUUID();
  if(attribution.kind==='task'){if(mismatch==='task')attribution.taskId='inspect-b';if(mismatch==='attempt')attribution.attempt=2;}
  if(mismatch==='agent')r.agentId='b';if(mismatch==='kind'){const {taskId,attempt,...base}=attribution as Extract<RequestAttribution,{kind:'task'}>;r.attribution={...base,kind:'supervision',role:'controller',round:1};}
  if(mismatch==='late'){await finish(run);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+100);}
  const ledger=mismatch==='late'?new ReservationLedger(run.authority.ledger.root):run.authority.ledger;await ledger.reserve(run.project,run.authority.manifestHash,r);
  const before=ledger.read(run.project),accounting=readRunAccounting(run.store);expect(accounting).toMatchObject({status:'available',run:{accounted:{tokens:100,costNanos:110000}},attribution:{status:'unavailable'}});expect(ledger.read(run.project)).toEqual(before);
});

it('distinguishes missing provenance from a known zero-request attempt and preserves legacy projections',async()=>{
  const run=await coordinatorRun(root);await run.store.append({type:'started',ownerId:randomUUID()});const legacy=await start(run,'inspect-a',1,false);expect(legacy.version).toBe(1);expect(readRunAccounting(run.store)).not.toHaveProperty('attribution');
  await run.authority.ledger.reserve(run.project,run.authority.manifestHash,request());await finish(run);await run.store.append({type:'task_reset',taskId:'inspect-a',source:'manual'});
  const newer=await start(run,'inspect-a',2);await finish(run);expect(newer.version).toBe(6);expect(groups(run).groups[newer.id]).toMatchObject({status:'unavailable'});expect(groups(run).groups[legacy.id]).toBeUndefined();
  const before=run.store.read();for(const value of [0,2,true])await expect(run.store.append({type:'task_started',taskId:'inspect-b',attempt:1,sessionId:randomUUID(),requestAttribution:value as 1})).rejects.toThrow();expect(run.store.read()).toEqual(before);
});
