import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {GoalStore,readGoalAccounting,inspectGoalMetrics,runGoalCommand,signed} from '../src/goals/index.js';
import {ReservationLedger,requestCostNanos,manifestHash,type RequestReservation} from '../src/execution/index.js';
import {goalFixture,toyGoal,toyProposal} from './helpers/goal.js';
import {coordinatorRun} from './helpers/coordinator-run.js';
import {ExecutionStore} from '../src/orchestration/execution-store.js';
import {coordinatorProgress} from '../src/orchestration/progress.js';
import {workflowSnapshot,retainWorkflows} from '../src/ui/workflow-progress.js';
import {linkedGoalAccounting} from '../src/goals/accounting.js';

let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-goal-accounting-')));vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No provider calls during accounting');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
type Fixture=Awaited<ReturnType<typeof goalFixture>>;
const inspect=(f:Fixture)=>readGoalAccounting(f.goals.read(f.manifest.id,f.project),f.goals);
const request=():RequestReservation=>({id:randomUUID(),agentId:'planner',provider:'deepseek',model:'public-toy',target:'a'.repeat(64),inputTokens:90,outputTokens:10,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(90,10,1,2)});
async function freeze(f:Fixture){const p=f.authority.ledger.read(f.project).projection,spend={...p.spent,revision:p.revision},proposal=f.goals.writeProposal(toyProposal(f.manifest,f.allocation),spend);await f.goals.append(f.manifest.id,{type:'planning_finished',status:'review_required',spend,proposalHash:proposal.hash,reason:'Public recorded fixture.'});}

it('distinguishes unallocated zero spend from a missing allocated budget without creating stores',async()=>{
  const project=join(root,'project');fs.mkdirSync(project);const goals=new GoalStore(join(root,'goals')),m=toyGoal(project,join(root,'runs'));goals.create(m);
  const empty=readGoalAccounting(goals.read(m.id,project),goals);expect(empty).toMatchObject({status:'available',accounted:{tokens:0,costNanos:0},phases:{planning:{status:'not-allocated'},execution:{status:'not-allocated'}}});expect(fs.existsSync(m.runsRoot)).toBe(false);
  const metrics=await inspectGoalMetrics(project,m.id,{goals});expect(metrics.costPerVerifiedTask).toMatchObject({value:null,numerator:0,denominator:0});expect(metrics.evidence.status).toBe('not-executed');
  const other=join(root,'other');fs.mkdirSync(other);const f=await goalFixture(other),file=join(f.authority.ledger.root,'history.json');fs.unlinkSync(file);
  const missing=inspect(f);expect(missing).toMatchObject({status:'partial',accounted:null,remaining:null,phases:{planning:{status:'unavailable'}}});expect(fs.existsSync(file)).toBe(false);expect(fetch).not.toHaveBeenCalled();
});

it.each(['success','error','cancelled','invalid-usage','oversized'] as const)('retains %s charges and original goal limits across restart',async outcome=>{
  const f=await goalFixture(root),r=request();await f.authority.ledger.reserve(f.project,f.authority.manifestHash,r);
  const before=inspect(f);expect(before).toMatchObject({status:'available',accounted:{tokens:100,costNanos:110000},phases:{planning:{requests:{pending:1},closed:false}},usageComplete:false});
  await f.authority.ledger.settle(f.project,f.authority.manifestHash,{requestId:r.id,outcome:outcome==='oversized'?'success':outcome,usage:{inputTokens:outcome==='oversized'?25000:7,outputTokens:3}});
  const after=inspect(f),expected=outcome==='success'?{tokens:10,costNanos:13000}:outcome==='oversized'?{tokens:25003,costNanos:25006000}:{tokens:100,costNanos:110000};
  expect(after).toMatchObject({status:'available',accounted:expected,deadline:f.manifest.deadline,limit:{tokens:20000,costNanos:100000000}});
  if(outcome==='oversized')expect(after).toMatchObject({remaining:{tokens:0},phases:{planning:{exceeded:true,requests:{exceeded:1}}}});
  const restarted=new GoalStore(f.goals.root),events=f.goals.read(f.manifest.id),budget=f.authority.ledger.read(f.project);expect(readGoalAccounting(restarted.read(f.manifest.id,f.project),restarted)).toEqual(after);expect(f.goals.read(f.manifest.id)).toEqual(events);expect(f.authority.ledger.read(f.project)).toEqual(budget);expect(fetch).not.toHaveBeenCalled();
});

it('freezes known planning spend and rejects later valid-ledger changes rather than hiding them as free',async()=>{
  const f=await goalFixture(root),r=request();await f.authority.ledger.reserve(f.project,f.authority.manifestHash,r);await f.authority.ledger.settle(f.project,f.authority.manifestHash,{requestId:r.id,outcome:'success',usage:{inputTokens:7,outputTokens:3}});await freeze(f);
  expect(inspect(f)).toMatchObject({status:'available',usageComplete:true,accounted:{costNanos:13000},phases:{planning:{closed:true}}});
  const goal=f.goals.read(f.manifest.id);await f.authority.ledger.reserve(f.project,f.authority.manifestHash,request());expect(inspect(f)).toMatchObject({status:'partial',accounted:null,usageComplete:false});expect(f.goals.read(f.manifest.id)).toEqual(goal);
});

it.each(['clock','tokens','cost','plan'] as const)('rejects a structurally valid foreign %s budget contract',async mismatch=>{
  const f=await goalFixture(root),original=f.authority.ledger.read(f.project).manifest,manifest=structuredClone(original);
  if(mismatch==='clock')manifest.createdAt--;if(mismatch==='plan')manifest.planHash='c'.repeat(64);
  if(mismatch==='tokens'){manifest.tokenBudget--;manifest.accounts[0]!.tokenBudget--;}
  if(mismatch==='cost'){manifest.costBudgetNanos--;manifest.accounts[0]!.costBudgetNanos--;}
  const foreign=new ReservationLedger(join(root,'foreign'));foreign.create(manifest);fs.copyFileSync(join(foreign.root,'history.json'),join(f.authority.ledger.root,'history.json'));
  expect(inspect(f)).toMatchObject({status:'partial',accounted:null});expect(f.authority.ledger.read(f.project).projection.manifestHash).toBe(manifestHash(manifest));
});

it.each(['allocation','phase','root','hash'] as const)('refuses a foreign linked run %s without changing evidence',async mismatch=>{
  const f=await goalFixture(root),file=join(f.runs.root,f.view.run.id,'manifest.json'),m=structuredClone(f.view.manifest);
  if(mismatch==='allocation')m.goal!.allocationId=randomUUID();if(mismatch==='phase')m.goal!.phase='execution';if(mismatch==='root')m.goal!.root=join(root,'other-goals');if(mismatch==='hash')m.goal!.manifestHash='c'.repeat(64);
  const {hash,...body}=m;fs.writeFileSync(file,JSON.stringify(signed(body)));const bytes=fs.readFileSync(file);expect(inspect(f)).toMatchObject({status:'partial',accounted:null});expect(fs.readFileSync(file)).toEqual(bytes);
});

it('counts concurrent reservations once and refuses malformed, symlinked or cancelled observations',async()=>{
  const f=await goalFixture(root);await Promise.all([request(),request()].map(r=>f.authority.ledger.reserve(f.project,f.authority.manifestHash,r)));expect(inspect(f)).toMatchObject({accounted:{tokens:200,costNanos:220000},phases:{planning:{requests:{pending:2}}}});
  const file=join(f.runs.root,f.view.run.id,'manifest.json'),raw=fs.readFileSync(file);fs.writeFileSync(file,'private malformed fixture');expect(inspect(f)).toMatchObject({status:'partial'});expect(JSON.stringify(inspect(f))).not.toContain('private malformed fixture');
  fs.writeFileSync(file,raw);fs.renameSync(file,file+'.saved');fs.symlinkSync(file+'.saved',file);expect(inspect(f)).toMatchObject({status:'partial'});fs.unlinkSync(file);fs.renameSync(file+'.saved',file);
  const before=f.authority.ledger.read(f.project);expect(()=>readGoalAccounting(f.goals.read(f.manifest.id),f.goals,undefined,AbortSignal.abort())).toThrow();
  const rows:string[]=[];expect(await runGoalCommand(['metrics',f.manifest.id,'--json'],{cwd:f.project,goals:f.goals,store:f.runs,signal:AbortSignal.abort(),write:l=>rows.push(l)})).toBe(130);expect(f.authority.ledger.read(f.project)).toEqual(before);
  const elsewhere=join(root,'elsewhere');fs.mkdirSync(elsewhere);await expect(inspectGoalMetrics(elsewhere,f.manifest.id,{goals:f.goals,store:f.runs})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});

it('rejects stale goal observations and foreign active runs while ignoring caller changes to projected fields',async()=>{
  const f=await goalFixture(root),before=f.goals.read(f.manifest.id),tampered=structuredClone(before);tampered.state.planning!.runId=randomUUID();expect(readGoalAccounting(tampered,f.goals)).toEqual(inspect(f));
  await freeze(f);expect(readGoalAccounting(before,f.goals)).toMatchObject({status:'unavailable'});
  const other=join(root,'other');fs.mkdirSync(other);const standalone=await coordinatorRun(other);await expect(inspectGoalMetrics(f.project,f.manifest.id,{goals:f.goals,store:standalone.runs})).rejects.toThrow(/original run store/);expect(linkedGoalAccounting(standalone.store,standalone.store.read())).toBeUndefined();expect(readGoalAccounting(f.goals.read(f.manifest.id),f.goals,{store:standalone.store,execution:standalone.store.read()})).toMatchObject({status:'unavailable'});
});

it('refreshes the HUD on goal-only changes while execution and run accounting remain unchanged',async()=>{
  const f=await goalFixture(root),store=new ExecutionStore(join(f.runs.root,f.view.run.id),f.view.manifest),budget=f.authority.ledger.read(f.project).manifest;
  store.create({version:1,runId:f.view.run.id,manifestHash:f.view.manifest.hash,approvalRevision:f.view.run.revision,createdAt:f.manifest.createdAt,deadline:budget.deadline});
  const first=workflowSnapshot(coordinatorProgress(store));expect(first.summary).toContain('goal accounted');const retained=retainWorkflows([],first);await freeze(f);
  const next=workflowSnapshot(coordinatorProgress(store));expect(next.revision).toBe(first.revision);expect(next.accountingRevision).toBe(first.accountingRevision);expect(next.goalAccountingRevision).not.toBe(first.goalAccountingRevision);expect(retainWorkflows(retained,next)).not.toBe(retained);
  fs.unlinkSync(join(f.authority.ledger.root,'history.json'));const missing=workflowSnapshot(coordinatorProgress(store));expect(missing.summary).toContain('goal budget unavailable');expect(retainWorkflows([next],missing)).not.toEqual([next]);expect(fetch).not.toHaveBeenCalled();
});
