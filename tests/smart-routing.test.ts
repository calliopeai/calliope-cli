import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {validateSmartPolicy,validateSmartSelection,smartPolicyWithin,smartScore} from '../src/routing/smart.js';
import {taskSmartSelection,validateRecordedRoute} from '../src/orchestration/routing.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {collectTaskOutput,replayExecution,ExecutionStore} from '../src/orchestration/index.js';
import {workflowSnapshot} from '../src/ui/workflow-progress.js';
import {extendPlan} from '../src/spawning/validation.js';

const policy=()=>({version:1 as const,profile:'cost' as const,pool:[{provider:'deepseek' as const,model:'economical'}],escalationPool:[{provider:'deepseek' as const,model:'reviewed-escalation'}]});
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-smart-')));fs.chmodSync(root,0o700);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No network in policy/replay tests.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
it('rejects malformed, secret-bearing, unbounded or duplicate policy data',()=>{
  const p=policy();expect(validateSmartPolicy(p)).toEqual(p);
  for(const value of [null,[],{}, {...p,version:2},{...p,profile:'quality'},{...p,extra:true},{...p,pool:[]},{...p,pool:Array(33).fill(p.pool[0])},{...p,pool:[p.pool[0],p.pool[0]]},{...p,pool:[{provider:'auto'}]},{...p,pool:[{provider:'unknown'}]},{...p,pool:[{provider:'deepseek',model:''}]},{...p,pool:[{provider:'deepseek',model:'x'.repeat(257)}]},{...p,pool:[{provider:'deepseek',model:'a\nb'}]},{...p,pool:[{provider:'deepseek',model:'sk-'+ 'a'.repeat(40)}]},{...p,pool:[{provider:'deepseek',key:'secret'}]},{...p,escalationPool:[]}])expect(()=>validateSmartPolicy(value)).toThrow(/Smart/);
  for(const value of [null,{policy:p,stage:'other'},{policy:p,stage:'initial',extra:true},{policy:p,stage:'escalation',evidenceId:'invalid'},{policy:{...p,escalationPool:undefined},stage:'escalation',evidenceId:randomUUID()}])expect(()=>validateSmartSelection(value)).toThrow(/Smart/);
  expect(smartPolicyWithin(p,{...p,pool:[{provider:'deepseek'}],escalationPool:[{provider:'deepseek'}]})).toBe(true);
  expect(smartPolicyWithin({...p,pool:[{provider:'google'}]},p)).toBe(false);
  expect(smartPolicyWithin(p,{version:1,profile:'cost',pool:p.pool})).toBe(false);
  for(const profile of ['cost','balanced','speed'] as const)expect(smartScore(profile,{support:1,health:1,latency:1,cost:1})).toBeCloseTo(1);
});
it('records verification-based escalation, displays the actual model and replays without discovery',async()=>{
  const plan=verifiedPlan();plan.agents[1]!.routing=policy();delete plan.tasks[0]!.outputs[0]!.path;
  const {store,view}=await coordinatorRun(root,plan),task=view.manifest.plan.tasks[0]!,ownerId=randomUUID();
  await store.append({type:'started',ownerId});await store.append({type:'task_started',taskId:task.id,attempt:1,sessionId:'first'});
  const route={version:1 as const,decisionId:randomUUID(),provider:'deepseek',model:'economical',reason:'Smart cost; initial approved pool.',profile:'cost' as const,stage:'initial' as const};
  await store.append({type:'agent_routed',agentId:'a',taskId:task.id,sessionId:'first',route});
  const failed=await collectTaskOutput(store,task,JSON.stringify({version:1,summary:'Candidate report.',outputs:[{id:task.outputs[0]!.id,content:'does not meet check'}]}));
  expect(failed.status).toBe('failed');const failure=await store.append({type:'task_finished',taskId:task.id,status:'failed',output:failed.output});
  expect(taskSmartSelection(policy(),store.read().events,task.id)).toMatchObject({stage:'escalation',evidenceId:failure.id});
  await store.append({type:'task_reset',taskId:task.id,source:'automatic'});await store.append({type:'task_started',taskId:task.id,attempt:2,sessionId:'second'});
  const change={type:'agent_routed' as const,agentId:'a',taskId:task.id,sessionId:'second',route:{...route,decisionId:randomUUID(),model:'reviewed-escalation',stage:'escalation' as const,evidenceId:failure.id}};
  await expect(store.append({...change,route:{...change.route,evidenceId:randomUUID()}})).rejects.toThrow(/previous failed verification/);
  await store.append(change);const saved=store.read();expect(saved.state.version).toBe(5);expect(saved.events.at(-1)!.version).toBe(5);
  expect(new ExecutionStore(dirname(store.root),view.manifest).read()).toEqual(saved);expect(replayExecution(saved.header,view.manifest,saved.events)).toEqual(saved.state);
  const hud=workflowSnapshot({context:store.context(saved),execution:saved});expect(hud.agents.find(a=>a.id==='a')!.label).toContain('actual deepseek:reviewed-escalation');expect(hud.agents.find(a=>a.id==='a')!.label).toContain('Smart cost/escalation');expect(fetch).not.toHaveBeenCalled();
});
it('denies routing before admission, after cancellation, across sessions and outside reviewed pins/pools',async()=>{
  const plan=verifiedPlan();plan.agents[1]!.routing=policy();const {store,view}=await coordinatorRun(root,plan);
  const route={version:1 as const,decisionId:randomUUID(),provider:'deepseek',model:'economical',reason:'Approved pool.',profile:'cost' as const,stage:'initial' as const};
  const change={type:'agent_routed' as const,agentId:'a',taskId:'inspect-a',sessionId:'first',route};
  await expect(store.append(change)).rejects.toThrow(/not active/);await store.append({type:'started',ownerId:randomUUID()});await store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:'first'});
  await expect(store.append({...change,sessionId:'foreign'})).rejects.toThrow(/active task/);
  await expect(store.append({...change,route:{...route,model:'unreviewed'}})).rejects.toThrow(/pool/);
  await expect(store.append({...change,route:{...route,model:'reviewed-escalation',stage:'escalation',evidenceId:randomUUID()}})).rejects.toThrow(/previous failed verification/);
  await expect(store.append(change,AbortSignal.abort())).rejects.toThrow();await store.append(change);await store.append({type:'agent_stop',agentId:'a'});await expect(store.append(change)).rejects.toThrow(/authority/);
  const context=store.context();context.plan.agents[1]!.preference={provider:'google',model:'pinned'};expect(()=>validateRecordedRoute(route,context,'a')).toThrow(/pin/);
  for(const changed of [{...route,profile:'speed'},{...route,evidenceId:randomUUID()},{...route,stage:'escalation'},{...route,version:2},{...route,decisionId:'invalid'}])expect(()=>validateRecordedRoute(changed,view.manifest,'a')).toThrow();
});
it('does not equate provider failures, prose, denial or missing evidence with failed verification',()=>{
  for(const status of ['denied','cancelled','unknown','completed','failed']){
    const events=[{id:randomUUID(),change:{type:'task_finished',taskId:'work',status,output:{checks:[{passed:false,observedHash:null,artifactId:'a'}],artifacts:[]}}}] as never;
    expect(taskSmartSelection(policy(),events,'work').stage).toBe('initial');
  }
  expect(taskSmartSelection(policy(),[]).stage).toBe('initial');
});
it('requires dynamic children to inherit or narrow their parent routing authority',()=>{
  const base=verifiedPlan();base.agents[0]!.routing=policy();
  const agent={...structuredClone(base.agents[1]!),id:'child',allowedPaths:[{path:'c',access:'write' as const}]},task={...structuredClone(base.tasks[0]!),id:'child-task',agentId:'child',outputs:[{id:'child-output',kind:'report' as const,description:'Child report.'}],acceptanceChecks:[]};
  const input={version:1 as const,parentId:'coordinator',agents:[agent],tasks:[task]};
  expect(()=>extendPlan(base,input)).toThrow(/routing/);agent.routing=policy();expect(extendPlan(base,input).agents.at(-1)!.routing).toEqual(policy());
  base.agents[0]!.childRouting=policy();base.agents[0]!.routing={version:1,profile:'balanced',pool:[{provider:'anthropic',model:'controller'}]};expect(extendPlan(base,input).agents.at(-1)!.routing).toEqual(policy());
  agent.maxChildCount=1;agent.maxChildDepth=1;agent.childRouting={version:1,profile:'cost',pool:[{provider:'google'}]};expect(()=>extendPlan(base,input)).toThrow(/delegation pool/);delete agent.childRouting;
  agent.preference={provider:'google',model:'foreign'};expect(()=>extendPlan(base,input)).toThrow(/routing/);agent.preference={provider:'auto',model:'foreign'};expect(()=>extendPlan(base,input)).toThrow(/routing/);
});

it('pins concurrent task sessions independently when one agent owns both tasks',async()=>{
  const p=verifiedPlan();p.agents=p.agents.slice(0,2);p.tasks=p.tasks.slice(0,2);p.agents[1]!.routing={...policy(),pool:[{provider:'deepseek'}]};p.agents[1]!.allowedPaths=[{path:'.',access:'read'}];p.agents[1]!.allowedTools=['read_file'];p.tasks[1]!.agentId='a';for(const task of p.tasks)delete task.outputs[0]!.path;
  const {store}=await coordinatorRun(root,p);await store.append({type:'started',ownerId:randomUUID()});
  for(const taskId of ['inspect-a','inspect-b'])await store.append({type:'task_started',taskId,attempt:1,sessionId:taskId});
  const route={version:1 as const,decisionId:randomUUID(),provider:'deepseek',model:'first',reason:'Approved candidate.',profile:'cost' as const,stage:'initial' as const};
  await store.append({type:'agent_routed',agentId:'a',taskId:'inspect-a',sessionId:'inspect-a',route});await store.append({type:'agent_routed',agentId:'a',taskId:'inspect-b',sessionId:'inspect-b',route:{...route,decisionId:randomUUID(),model:'second'}});
  await expect(store.append({type:'agent_routed',agentId:'a',taskId:'inspect-a',sessionId:'inspect-a',route:{...route,decisionId:randomUUID(),model:'third'}})).rejects.toThrow(/protocol/);
  expect(workflowSnapshot({context:store.context(),execution:store.read()}).agents.find(a=>a.id==='a')!.label).toContain('actual deepseek:first');
});
