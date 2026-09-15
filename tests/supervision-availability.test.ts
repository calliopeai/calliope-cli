import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {collectTaskOutput,ExecutionStore,replayExecution,type TaskStatus} from '../src/orchestration/index.js';
import {supervisionAvailability,buildControllerContext,controllerInstructions,assertSupervisedRetry} from '../src/supervision/index.js';
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-availability-')));vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Availability must not dispatch requests');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
async function fixture(unfinishedMutation=false){
  const p=verifiedPlan();p.version=4;p.tasks=p.tasks.slice(0,2);p.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};p.agents[1]!.maxChildDepth=1;p.agents[1]!.maxChildCount=1;
  for(const task of p.tasks){delete task.outputs[0]!.path;task.outputs.push({id:task.id+'-patch',kind:'patch',description:'Retained patch.'});task.isolation={patchArtifactId:task.id+'-patch',commands:[]};}
  p.supervision={version:1,controllerId:'coordinator',maxRounds:3,maxStalledRounds:2,maxOutputTokens:100,principle:'robustness',allowedActions:['retry','replan','decompose']};
  const f=await coordinatorRun(root,p),task=p.tasks[0]!;await f.store.append({type:'started',ownerId:randomUUID()});await f.store.append({type:'task_started',taskId:task.id,attempt:1,sessionId:'availability-worker'});
  if(unfinishedMutation)await f.store.append({type:'tool',taskId:task.id,callId:'unfinished',name:'write_file',path:'a/file.txt',stage:'started',mutating:true,success:false});
  const output=await collectTaskOutput(f.store,task,JSON.stringify({version:1,summary:'Actual failed contains check.',outputs:[{id:'report-a',content:'failed baseline'}]}),{executorOutputs:new Map([[task.id+'-patch','retained patch']])});
  await f.store.append({type:'task_finished',taskId:task.id,status:'failed',output:output.output});
  const view=f.store.read(),now=Date.now(),plan=f.view.manifest.plan;
  return{...f,manifest:f.view.manifest,plan,view,now,inspect:()=>supervisionAvailability(plan,view,now)};
}
it('reports preliminary retry and child capacity from recorded state without changing it or granting authority',async()=>{
  const f=await fixture(),before=structuredClone(f.view),plan=structuredClone(f.plan),a=f.inspect();
  expect(a).toMatchObject({version:1,executionRevision:f.view.state.revision,observedAt:f.now,remainingCapacity:{agents:1,tasks:2},retryCapacity:{available:1,policy:'allowed',reason:null}});
  expect(a.retryTasks[0]).toEqual({id:'inspect-a',actions:['retry','replan'],status:'possible',reason:null});expect(a.retryTasks[1]!.status).toBe('blocked');
  expect(a.childParents.find(a=>a.id==='a')).toMatchObject({status:'possible',remainingChildren:1,remainingDepth:1});expect(a.limitations).toContain('grants no authority');
  expect(f.inspect()).toEqual(a);expect(f.view).toEqual(before);expect(f.plan).toEqual(plan);expect(fetch).not.toHaveBeenCalled();
  a.retryTasks[0]!.actions.length=0;expect(f.inspect().retryTasks[0]!.actions).toEqual(['retry','replan']);
});
it('separates existing-task retry capacity from exhausted child admission capacity',async()=>{
  const f=await fixture(),plan=structuredClone(f.plan);plan.limits.maxAgents=plan.agents.length;plan.limits.maxTasks=plan.tasks.length;
  const a=supervisionAvailability(plan,f.view,f.now);expect(a.remainingCapacity).toEqual({agents:0,tasks:0});expect(a.retryCapacity).toEqual({available:1,policy:'allowed',reason:null});expect(a.retryTasks[0]!.status).toBe('possible');
  expect(a.limitations).toContain('grants no authority');
});
it('reports stopped and escalated ancestors for both retry and delegation',async()=>{
  const f=await fixture();
  for(const ancestor of ['a','coordinator']){const view=structuredClone(f.view);view.state.stoppedAgents=[ancestor];const a=supervisionAvailability(f.plan,view,f.now);expect(a.retryTasks[0]!.reason).toContain('stopped');expect(a.childParents.find(a=>a.id==='a')!.reason).toContain('stopped or escalated');}
  f.view.state.tasks['inspect-a']!.escalation='parent';const a=f.inspect();expect(a.retryTasks[0]!.status).toBe('blocked');expect(a.childParents.find(a=>a.id==='a')!.reason).toContain('stopped or escalated');expect(a.childParents.find(a=>a.id==='coordinator')!.status).toBe('possible');
});
it('distinguishes denied, unknown, cancelled, consumed and exhausted attempts from a possible retry',async()=>{
  const f=await fixture();for(const status of ['denied','unknown','cancelled','completed','running'] as TaskStatus[]){const view=structuredClone(f.view);view.state.tasks['inspect-a']!.status=status;expect(supervisionAvailability(f.plan,view,f.now).retryTasks[0]!.status).toBe('blocked');expect(()=>assertSupervisedRetry(f.plan,view.state,view.events,'inspect-a')).toThrow();}
  const exhausted=structuredClone(f.view);exhausted.state.tasks['inspect-a']!.attempts=2;expect(supervisionAvailability(f.plan,exhausted,f.now).retryTasks[0]!.reason).toContain('attempts remaining');
  f.plan.tasks[1]!.dependencies=['inspect-a'];f.view.state.tasks['inspect-b']!.attempts=1;expect(f.inspect().retryTasks[0]!.reason).toContain('unconsumed');
});
it('retains the executor requirement for uncertain mutation evidence',async()=>{
  const f=await fixture(true);expect(f.inspect().retryTasks[0]!.reason).toContain('Uncertain mutation');expect(f.view.state.tasks['inspect-a']!.mutations).toBe(true);
});
it('uses original run and account clocks, with no renewed allowance on inspection',async()=>{
  const f=await fixture(),created=Date.parse(f.view.header.createdAt),deadline=created+f.plan.agents[1]!.timeBudgetMs;
  expect(supervisionAvailability(f.plan,f.view,deadline).retryTasks[0]!.reason).toContain('task agent deadline');expect(supervisionAvailability(f.plan,f.view,deadline).childParents.find(a=>a.id==='a')!.reason).toContain('parent deadline');
  const expired=supervisionAvailability(f.plan,f.view,f.view.state.deadline);expect(expired.retryTasks.every(t=>t.reason==='The original run deadline expired.')).toBe(true);expect(expired.childParents.every(a=>a.status==='blocked')).toBe(true);
  f.view.state.status='completed';expect(f.inspect().childParents.every(a=>a.reason==='The run is completed.')).toBe(true);
});
it('reports policy and direct child, graph count and depth limits without inferring new grants',async()=>{
  const f=await fixture(),check=(change:(p:typeof f.plan)=>void,id='a')=>{const plan=structuredClone(f.plan);change(plan);return supervisionAvailability(plan,f.view,f.now).childParents.find(a=>a.id===id)!;};
  expect(check(p=>{p.supervision!.allowedActions=[];}).reason).toContain('policy');expect(check(p=>{p.limits.maxAgents=p.agents.length;}).reason).toContain('agent count');expect(check(p=>{p.limits.maxTasks=p.tasks.length;}).reason).toContain('task count');
  expect(check(p=>{p.agents[0]!.maxChildCount=2;},'coordinator').reason).toContain('child count');expect(check(p=>{p.agents[1]!.maxChildDepth=0;}).reason).toContain('child depth');
  f.plan.supervision!.allowedActions=[];expect(f.inspect().retryTasks[0]!.reason).toContain('policy');
});
it('preserves the snapshot in both review roles and reproduces it after store restart/replay',async()=>{
  const f=await fixture(),availability=f.inspect(),restarted=new ExecutionStore(join(f.runs.root,f.manifest.id),f.manifest);
  // Read the original journal again from the run directory.
  const saved=restarted.read();expect(replayExecution(saved.header,f.manifest,saved.events)).toEqual(saved.state);expect(supervisionAvailability(f.plan,saved,f.now)).toEqual(availability);
  for(const role of ['controller','reviewer'] as const){const result=buildControllerContext({role,round:1,plan:f.plan,availability,tasks:saved.state.tasks,outcomes:[],budget:{deadline:saved.state.deadline,spent:{},accounts:{}},strategies:{}});expect(JSON.parse(result.content).availability).toEqual(availability);expect(controllerInstructions(f.plan.supervision!,role)).toContain('Never propose or approve an action marked blocked');}
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects malformed observation clocks and unsupervised or invalid plans',async()=>{
  const f=await fixture(),created=Date.parse(f.view.header.createdAt);
  for(const at of [NaN,Infinity,-1,1.5,created-1])expect(()=>supervisionAvailability(f.plan,f.view,at)).toThrow('clock');
  for(const changed of [{header:{...f.view.header,createdAt:'invalid'}},{state:{...f.view.state,deadline:created-1}}])expect(()=>supervisionAvailability(f.plan,{...f.view,...changed},f.now)).toThrow('clock');
  const plan=structuredClone(f.plan);plan.version=3;delete plan.supervision;expect(()=>supervisionAvailability(plan,f.view,f.now)).toThrow('supervised plan');
  f.view.state.graph={version:1,hash:'0'.repeat(64),plan:f.plan,admissions:[]};expect(()=>f.inspect()).toThrow('current reviewed graph');delete f.view.state.graph;
  f.plan.limits.maxAgents=1;expect(()=>f.inspect()).toThrow();
});
