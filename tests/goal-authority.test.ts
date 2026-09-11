import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {GoalStore,signed,replayGoal,type GoalAllocation} from '../src/goals/index.js';
import {analyzePlan,changePreparedRun,prepareAgentExecution,validateRunManifest,RunStore} from '../src/orchestration/index.js';
import {requestCostNanos} from '../src/execution/index.js';
import {goalFixture,toyGoal,toyProposal} from './helpers/goal.js';
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-goal-authority-')));fs.chmodSync(root,0o700);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No provider request is permitted.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
async function freeze(f:Awaited<ReturnType<typeof goalFixture>>){
  const saved=f.authority.ledger.read(f.project),spend={...saved.projection.spent,revision:saved.projection.revision},proposal=f.goals.writeProposal(toyProposal(f.manifest,f.allocation),spend);
  await f.goals.append(f.manifest.id,{type:'planning_finished',status:'review_required',spend,proposalHash:proposal.hash,reason:'Synthetic fixture planning evidence.'});return{spend,proposal};
}
it('pins planner authority to one allocated run, its private store and the original goal clock',async()=>{
  const f=await goalFixture(root),budget=f.authority.ledger.read(f.project).manifest;expect(f.view.manifest.version).toBe(2);expect(budget.createdAt).toBe(Date.parse(f.manifest.createdAt));expect(budget.deadline).toBe(f.allocation.deadline);f.authority.assertAuthority!();
  await expect(f.goals.append(f.manifest.id,{type:'planning_allocated',allocation:{...f.allocation,id:randomUUID(),runId:randomUUID()}})).rejects.toThrow(/new planner/);
  const copied=new RunStore(join(root,'copied'));fs.cpSync(f.runs.root,copied.root,{recursive:true});const privateCopy=(path:string)=>{const s=fs.statSync(path);fs.chmodSync(path,s.isDirectory()?0o700:0o600);if(s.isDirectory())for(const name of fs.readdirSync(path))privateCopy(join(path,name));};privateCopy(copied.root);await expect(prepareAgentExecution(f.project,f.view.run.id,'planner',100,{store:copied})).rejects.toThrow(/allocation/);
  for(const version of ['2',true,3])expect(()=>validateRunManifest({...f.view.manifest,version})).toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('freezes unknown planning reservations and allocates only the remaining goal envelope',async()=>{
  const f=await goalFixture(root),request={id:randomUUID(),agentId:'planner',provider:'deepseek',model:'goal-toy',target:'a'.repeat(64),inputTokens:100,outputTokens:10,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(100,10,1,2)};
  await f.authority.ledger.reserve(f.project,f.authority.manifestHash,request);await f.authority.ledger.settle(f.project,f.authority.manifestHash,{requestId:request.id,outcome:'error'});
  const {spend,proposal}=await freeze(f);expect(spend.tokens).toBe(110);expect(()=>f.authority.assertAuthority!()).toThrow(/frozen/);
  const allocation:GoalAllocation={id:randomUUID(),phase:'execution',runId:randomUUID(),planHash:proposal.planHash,tokens:proposal.plan.limits.tokenBudget,costNanos:Math.floor(proposal.plan.limits.costBudgetUsd*1e9),deadline:f.manifest.deadline};
  const before=f.goals.read(f.manifest.id);await expect(f.goals.append(f.manifest.id,{type:'execution_allocated',allocation:{...allocation,tokens:f.manifest.limits.tokenBudget},proposalHash:proposal.hash,source:'cli'})).rejects.toThrow(/remaining/);expect(f.goals.read(f.manifest.id)).toEqual(before);
  await f.goals.append(f.manifest.id,{type:'execution_allocated',allocation,proposalHash:proposal.hash,source:'cli'});await expect(f.goals.append(f.manifest.id,{type:'execution_allocated',allocation:{...allocation,runId:randomUUID()},proposalHash:proposal.hash,source:'cli'})).rejects.toThrow(/unallocated/);
  const binding={id:allocation.runId,createdAt:f.manifest.createdAt,goal:{version:1 as const,root:f.goals.root,id:f.manifest.id,manifestHash:f.manifest.hash,allocationId:allocation.id,phase:'execution' as const}},run=await f.runs.prepare(analyzePlan(proposal.plan),f.project,{kind:'goal',path:'approved-proposal.json',sha256:proposal.planHash},undefined,binding);await changePreparedRun(f.project,run.run.id,'approved',{store:f.runs});
  const authority=await prepareAgentExecution(f.project,run.run.id,'coordinator',100,{store:f.runs});expect(authority.ledger.read(f.project).manifest.createdAt).toBe(Date.parse(f.manifest.createdAt));expect(authority.ledger.read(f.project).manifest.deadline).toBe(f.manifest.deadline);authority.assertAuthority!();
  await f.goals.append(f.manifest.id,{type:'cancelled',source:'cli'});expect(()=>authority.assertAuthority!()).toThrow(/revoked/);await expect(prepareAgentExecution(f.project,run.run.id,'coordinator',100,{store:f.runs})).rejects.toThrow(/revoked/);
});
it('rejects proposed scope expansion and mismatched allocation amounts before commit',async()=>{
  const f=await goalFixture(root),{spend,proposal}=await freeze(f),changed=structuredClone(proposal);changed.plan.workspace.allowedTools.push('shell');changed.planHash=analyzePlan(changed.plan).hash;
  const {hash,...body}=changed;expect(()=>f.goals.writeProposal(signed(body),spend)).toThrow(/workspace/);
  const state=f.goals.read(f.manifest.id),allocation:GoalAllocation={id:randomUUID(),phase:'execution',runId:randomUUID(),planHash:proposal.planHash,tokens:1,costNanos:1,deadline:f.manifest.deadline};await expect(f.goals.append(f.manifest.id,{type:'execution_allocated',allocation,proposalHash:proposal.hash,source:'cli'})).rejects.toThrow();expect(f.goals.read(f.manifest.id)).toEqual(state);
});
it('serializes concurrent approval decisions and preserves immutable proposal/replay records across restart',async()=>{
  const f=await goalFixture(root),{proposal}=await freeze(f),before=f.goals.read(f.manifest.id),allocation=()=>({id:randomUUID(),phase:'execution' as const,runId:randomUUID(),planHash:proposal.planHash,tokens:proposal.plan.limits.tokenBudget,costNanos:Math.floor(proposal.plan.limits.costBudgetUsd*1e9),deadline:f.manifest.deadline});
  const choices=await Promise.allSettled([0,1].map(()=>f.goals.append(f.manifest.id,{type:'execution_allocated',allocation:allocation(),proposalHash:proposal.hash,source:'cli'},{expectedRevision:before.state.revision})));expect(choices.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const restarted=new GoalStore(f.goals.root).read(f.manifest.id,f.project);expect(replayGoal(restarted.manifest,restarted.events)).toEqual(restarted.state);expect(restarted.proposal).toEqual(proposal);expect(f.goals.list(f.project).goals).toHaveLength(1);
});
it('fails closed for corrupted state, changed owners, revoked review and in-project authority stores',async()=>{
  const f=await goalFixture(root),owner=f.goals.acquire(f.manifest.id);expect(()=>f.goals.acquire(f.manifest.id)).toThrow(/owns/);owner.check();owner.release();expect(()=>owner.check()).toThrow();
  const bad=join(f.project,'goals');expect(()=>new GoalStore(bad).create(toyGoal(f.project,f.runs.root))).toThrow(/outside/);
  const file=join(f.goals.directory(f.manifest.id),'history.json'),before=fs.readFileSync(file);fs.writeFileSync(file,'{');expect(()=>f.goals.read(f.manifest.id)).toThrow(/damaged/);expect(f.goals.list(f.project).unavailable).toBe(1);fs.writeFileSync(file,before);
  await f.goals.append(f.manifest.id,{type:'cancelled',source:'cli'});await expect(prepareAgentExecution(f.project,f.view.run.id,'planner',100,{store:f.runs})).rejects.toThrow(/revoked/);expect(fetch).not.toHaveBeenCalled();
});
