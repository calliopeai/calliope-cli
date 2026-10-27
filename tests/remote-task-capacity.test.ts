import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {remoteTaskAdmission,admitRemoteTask,releaseRemoteTask,activeRemoteTasks,occupiedExecutionSlots} from '../src/orchestration/remote-task-capacity.js';
import {ExecutionStore} from '../src/orchestration/execution-store.js';
let root:string,r:Awaited<ReturnType<typeof coordinatorRun>>;
beforeEach(async()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-remote-capacity-')));const plan=verifiedPlan();plan.limits.maxConcurrent=1;plan.limits.timeBudgetMs=120000;for(const a of plan.agents)a.timeBudgetMs=120000;r=await coordinatorRun(root,plan);});
afterEach(()=>{vi.restoreAllMocks();config.resetConfig();saveHooks([]);fs.rmSync(root,{recursive:true,force:true});});
const admission=(agentId='a')=>remoteTaskAdmission({version:1,runId:randomUUID(),manifestHash:'a'.repeat(64),taskId:'remote-task',attempt:1,startEventId:randomUUID(),startEventHash:'b'.repeat(64),sessionId:randomUUID(),agentId,deadline:r.store.read().header.deadline-1000});
const admit=(value=admission())=>admitRemoteTask(r.store,value,()=>r.authority.assertAuthority!());
it('serializes local and remote work against one native parent concurrency limit',async()=>{
 const remote=admission();await admit(remote);await r.store.append({type:'started',ownerId:randomUUID()});
 await expect(r.store.append({type:'task_started',taskId:'inspect-b',attempt:1,sessionId:randomUUID()})).rejects.toThrow(/concurrency/);
 expect(occupiedExecutionSlots(r.store.read().state)).toBe(1);
 await releaseRemoteTask(r.store,remote);
 await r.store.append({type:'task_started',taskId:'inspect-b',attempt:1,sessionId:randomUUID()});
 await expect(admit(admission('a'))).rejects.toMatchObject({code:'limit'});
 expect(occupiedExecutionSlots(r.store.read().state)).toBe(1);
});
it('admits only one concurrent remote worker and replays its exact admission',async()=>{
 const a=admission('a'),b=admission('b');const result=await Promise.allSettled([admit(a),admit(b)]);
 expect(result.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 const saved=r.store.read(),active=activeRemoteTasks(saved.state)[0]!;
 await admit(active);expect(r.store.read()).toEqual(saved);
 expect(saved.events[0]!.version).toBe(13);expect(saved.state.version).toBe(8);
});
it('retains unknown remote occupancy across owner restart and time expiry until exact release',async()=>{
 const value=admission();await admit(value);await r.store.append({type:'started',ownerId:randomUUID()});
 await r.store.append({type:'started',ownerId:randomUUID()});
 const restarted=new ExecutionStore(join(r.runs.root,r.view.run.id),r.view.manifest);
 expect(activeRemoteTasks(restarted.read().state)).toEqual([value]);
 vi.spyOn(Date,'now').mockReturnValue(value.deadline+1);
 expect(activeRemoteTasks(restarted.read().state)).toEqual([value]);
 await releaseRemoteTask(restarted,value);const after=restarted.read();await releaseRemoteTask(restarted,value);
 expect(restarted.read()).toEqual(after);expect(activeRemoteTasks(after.state)).toEqual([]);
 await expect(admit(value)).rejects.toThrow(/no longer active/);
});
it('refuses substituted admission metadata and same-workspace conflicting scopes',async()=>{
 const value=admission();await expect(admit({...value,taskId:'other'})).rejects.toThrow(/hash changed/);
 await expect(releaseRemoteTask(r.store,value)).rejects.toMatchObject({code:'authority'});
 const plan=verifiedPlan();plan.limits.maxConcurrent=2;for(const a of plan.agents)a.timeBudgetMs=120000;plan.limits.timeBudgetMs=120000;
 const directory=join(root,'overlap');fs.mkdirSync(directory);r=await coordinatorRun(directory,plan);
 await admit(admission('coordinator'));
 await expect(admit(admission('a'))).rejects.toThrow(/scopes are busy/);
});

it.each(['controller','reviewer'] as const)('counts remote %s turns against the same capacity and rejects changed round identity',async role=>{
 const value=remoteTaskAdmission({version:1,runId:randomUUID(),manifestHash:'a'.repeat(64),kind:'supervision',role,round:2,startEventId:randomUUID(),startEventHash:'b'.repeat(64),sessionId:randomUUID(),agentId:'a',deadline:r.store.read().header.deadline-1000});
 await admit(value);expect(occupiedExecutionSlots(r.store.read().state)).toBe(1);
 await expect(admit(admission('b'))).rejects.toMatchObject({code:'limit'});
 await expect(releaseRemoteTask(r.store,{...value,round:3})).rejects.toThrow(/hash changed/);
 await releaseRemoteTask(r.store,value);expect(occupiedExecutionSlots(r.store.read().state)).toBe(0);
});
