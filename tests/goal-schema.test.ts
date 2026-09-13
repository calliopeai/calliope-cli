import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from '../src/approvals/index.js';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {GoalStore,newGoalManifest,plannerPlan,proposePlan,signed,validateGoalManifest,validateGoalLimits,validateGoalLink,validateGoalProposal,validateGoalEvent,replayGoal,goalHistoryHash,type GoalManifest,type GoalEvent} from '../src/goals/index.js';
import {toyGoal,toyProposal,goalFixture} from './helpers/goal.js';
import {verifiedPlan} from './helpers/coordinator-run.js';
import {goalSupervision} from './helpers/supervised-goal.js';
import {analyzePlan,OrchestrationError,RunStore} from '../src/orchestration/index.js';
import {runGoalCommand,formatGoal} from '../src/goals/index.js';
let root:string,project:string,manifest:GoalManifest;
const resign=(value:any)=>{const {hash,...body}=value;return signed(body);};
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-goal-schema-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);manifest=toyGoal(project,join(root,'runs'));vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No provider requests in schema tests.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
it('validates exact versioned envelopes and every bounded goal limit',()=>{
  expect(validateGoalManifest(manifest)).toEqual(manifest);
  for(const key of Object.keys(manifest.limits))for(const value of [NaN,Infinity,-1,'1'])expect(()=>validateGoalLimits({...manifest.limits,[key]:value})).toThrow();
  for(const bad of [{version:2},{id:'id'},{createdAt:'bad'},{deadline:manifest.deadline+1},{goal:''},{goal:'x'.repeat(8193)},{runsRoot:'relative'},{preference:{provider:'unknown'}},{preference:{provider:'auto',model:''}},{workspace:{allowedTools:['shell'],allowedPaths:[]}},{workspace:{allowedTools:['read_file'],allowedPaths:[{path:'../escape',access:'read'}]}},{workspace:{allowedTools:[],allowedPaths:[{path:'.',access:'read'},{path:'.',access:'write'}]}},{project:{root:project,key:'bad'}}])expect(()=>validateGoalManifest(resign({...manifest,...bad}))).toThrow();
  expect(()=>validateGoalManifest({...manifest,extra:true})).toThrow();expect(()=>validateGoalManifest({...manifest,hash:'0'.repeat(64)})).toThrow();
  const link={version:1,root:join(root,'goals'),id:manifest.id,manifestHash:manifest.hash,allocationId:randomUUID(),phase:'planning'};expect(validateGoalLink(link)).toEqual(link);
  for(const bad of [{version:'1'},{root:'.'},{phase:'invalid'},{allocationId:'x'}])expect(()=>validateGoalLink({...link,...bad})).toThrow();
});
it('caps defaults by configured policy, preserves preference and builds a read-only planner',()=>{
  const goal=newGoalManifest(project,'A public goal.',manifest.runsRoot,{preference:{provider:'deepseek',model:'toy'}}),p=plannerPlan(goal);expect(goal.preference).toEqual({provider:'deepseek',model:'toy'});expect(p.workspace.allowedPaths).toEqual([{path:'.',access:'read'}]);expect(p.workspace.allowedTools).not.toContain('write_file');expect(p.agents[0]!.maxChildCount).toBe(0);
  const tiny=newGoalManifest(project,'Tiny goal.',manifest.runsRoot,{limits:{tokenBudget:2,costBudgetNanos:0}});expect(tiny.limits.planningTokens).toBe(1);
  for(const limits of [{tokenBudget:Infinity},{extra:1},{planningTokens:0},{timeBudgetMs:86400001}])expect(()=>newGoalManifest(project,'Toy.',manifest.runsRoot,{limits:limits as any})).toThrow();
  const paths=Array.from({length:20},(_,n)=>({path:'path-'+n,access:'read' as const})),large=plannerPlan(newGoalManifest(project,'Scoped public goal.',manifest.runsRoot,{workspace:{allowedTools:['read_file'],allowedPaths:paths}}));expect(large.agents[0]!.inputs.filter(i=>i.id.startsWith('scope-'))).toHaveLength(4);
});
it('versions repair intent independently of teams and supervision while retaining legacy planner bytes',()=>{
  for(const configuration of [{},{team:{version:1 as const,maxAttempts:2}},{supervision:goalSupervision()}]){
    const m=JSON.parse(canonicalJson(newGoalManifest(project,'Public goal.',manifest.runsRoot,configuration))),old=plannerPlan(m),repaired=resign({...m,version:4,planningRepair:{version:1,maxRetries:2}}),plan=plannerPlan(repaired);
    expect(plan.agents.every(a=>a.escalationPolicy.maxRetries===2)).toBe(true);expect(plan.agents[0]!.inputs.some(i=>i.id==='planning-repair')).toBe(true);
    for(const a of plan.agents){a.escalationPolicy.maxRetries=0;a.inputs=a.inputs.filter(i=>i.id!=='planning-repair');}expect(JSON.stringify(plan)).toBe(JSON.stringify(old));
    expect(newGoalManifest(project,'Public goal.',manifest.runsRoot,{...configuration,planningRepairs:0}).version).toBe(m.version);
  }
  const m=newGoalManifest(project,'Repair intent.',manifest.runsRoot,{planningRepairs:1});expect(validateGoalManifest(m)).toEqual(m);expect(m.workspace.allowedTools).not.toContain('shell');
  for(const planningRepairs of [-1,3,1.5,NaN,Infinity,'1'])expect(()=>newGoalManifest(project,'Invalid repair.',manifest.runsRoot,{planningRepairs:planningRepairs as number})).toThrow();
  for(const planningRepair of [undefined,null,{version:2,maxRetries:1},{version:1,maxRetries:0},{version:1,maxRetries:3},{version:1,maxRetries:1,extra:true}])expect(()=>validateGoalManifest(resign({...m,planningRepair}))).toThrow();
  expect(()=>validateGoalManifest(resign({...m,version:1}))).toThrow(/version 4/);
  const store=new GoalStore(join(root,'goals'));store.create(m);expect(new GoalStore(store.root).read(m.id).manifest.planningRepair).toEqual({version:1,maxRetries:1});
  expect(formatGoal({goal:store.read(m.id),status:'created'} as any)).toContain('1 retries per stage');
});
it('reports numeric field paths and inherited limits without echoing untrusted plan content',()=>{
  const cases:Array<[(p:ReturnType<typeof verifiedPlan>)=>void,string]>=[
    [p=>{p.agents[0]!.allowedTools=[];},'allowedTools'],
    [p=>{p.agents[0]!.allowedPaths=[];},'allowedPaths'],
    [p=>{p.agents[1]!.tokenBudget=p.agents[0]!.tokenBudget+1;},'tokenBudget'],
    [p=>{p.agents[1]!.costBudgetUsd=p.agents[0]!.costBudgetUsd+1;},'costBudgetUsd'],
    [p=>{p.agents[1]!.timeBudgetMs=p.agents[0]!.timeBudgetMs+1;},'timeBudgetMs'],
    [p=>{p.agents[1]!.maxChildDepth=2;},'maxChildDepth'],
    [p=>{p.agents[1]!.maxChildCount=4;},'maxChildCount'],
    [p=>{p.agents[1]!.escalationPolicy.maxRetries=2;},'escalationPolicy.maxRetries'],
  ];
  for(const [edit,field]of cases){const p=verifiedPlan();edit(p);try{analyzePlan(p);throw new Error('Expected diagnostic');}catch(error){expect(error).toBeInstanceOf(OrchestrationError);expect((error as OrchestrationError).diagnostics?.[0]).toMatchObject({path:'agents[1].'+field,parentPath:'agents[0].'+field});}}
});
it('rejects misplaced and malformed repair flags before storing a goal or discovering models',async()=>{
  const goals=new GoalStore(join(root,'goals')),lines:string[]=[],options={cwd:project,goals,store:new RunStore(manifest.runsRoot),write:(line:string)=>lines.push(line)};
  for(const value of ['-1','3','1.0','01','Infinity'])expect(await runGoalCommand(['Public goal.','--planning-repairs',value,'--json'],options)).toBe(2);
  expect(await runGoalCommand(['resume',randomUUID(),'--planning-repairs','1','--json'],options)).toBe(2);expect(goals.list(project).goals).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
});
it('keeps proposal provenance separate from human execution approval and validates remaining budgets and scope',()=>{
  const allocation={id:randomUUID(),phase:'planning' as const,runId:randomUUID(),planHash:'a'.repeat(64),tokens:5000,costNanos:10000000,deadline:manifest.deadline},proposal=toyProposal(manifest,allocation),spend={tokens:100,costNanos:1000,revision:'b'.repeat(64)};
  expect(validateGoalProposal(proposal,manifest,spend)).toEqual(proposal);
  for(const bad of [{knowledgeStatus:'accepted'},{confidence:1},{inferred:false},{goalId:randomUUID()},{goalManifestHash:'c'.repeat(64)},{source:{...proposal.source,eventId:'bad'}},{source:{kind:'human',path:'../bad',sha256:'a'.repeat(64)}},{source:{kind:'unknown'}},{planHash:'d'.repeat(64)}])expect(()=>validateGoalProposal(resign({...proposal,...bad}),manifest,spend)).toThrow();
  expect(()=>validateGoalProposal(proposal,manifest,{...spend,tokens:manifest.limits.tokenBudget})).toThrow(/allowance/);
  expect(()=>validateGoalProposal(proposal,manifest,{...spend,costNanos:manifest.limits.costBudgetNanos})).toThrow(/allowance/);
  const restricted=resign({...manifest,workspace:{allowedTools:['read_file','write_file'],allowedPaths:[{path:'a',access:'write'}]}});expect(()=>validateGoalProposal(resign({...proposal,goalManifestHash:restricted.hash}),restricted,spend)).toThrow(/workspace/);
  const selected=resign({...manifest,preference:{provider:'deepseek',model:'root-toy'}}),p=verifiedPlan();p.agents[0]!.preference={provider:'auto',model:'child-toy'};
  expect(proposePlan(selected,p,{kind:'human',path:'proposal.json',sha256:'e'.repeat(64)},spend).plan.agents[0]!.preference).toEqual({provider:'deepseek',model:'child-toy'});
});
function event(change:unknown,overrides:Record<string,unknown>={}):GoalEvent{return signed({version:1,id:randomUUID(),goalId:manifest.id,sequence:1,at:manifest.createdAt,previous:goalHistoryHash(manifest,[]),change,...overrides}) as GoalEvent;}
it('rejects malformed event variants, forged ancestry and unsupported state transitions',()=>{
  const valid=event({type:'cancelled',source:'cli'});expect(replayGoal(manifest,[valid]).revoked).toBe(true);
  for(const change of [{type:'unknown'},{type:'planning_allocated',allocation:{}},{type:'planning_finished',status:'passed',spend:null,proposalHash:null,reason:'toy'},{type:'planning_finished',status:'failed',spend:{tokens:-1,costNanos:0,revision:'a'.repeat(64)},proposalHash:null,reason:'toy'},{type:'proposal_revised',proposalHash:'bad'},{type:'execution_allocated',allocation:{}},{type:'execution_started',runId:'bad'},{type:'execution_interrupted',runId:randomUUID(),status:'completed',reason:'no proof'},{type:'execution_finished',runId:randomUUID(),revision:'a'.repeat(64),status:'completed',completed:0,total:1},{type:'cancelled',source:'agent'}])expect(()=>validateGoalEvent(event(change),manifest)).toThrow();
  for(const change of [{type:'planning_finished',status:'failed',spend:null,proposalHash:null,reason:'toy'},{type:'proposal_revised',proposalHash:'a'.repeat(64)},{type:'execution_started',runId:randomUUID()},{type:'execution_interrupted',runId:randomUUID(),status:'failed',reason:'toy'},{type:'execution_finished',runId:randomUUID(),revision:'a'.repeat(64),status:'completed',completed:1,total:1}])expect(()=>replayGoal(manifest,[event(change)])).toThrow();
  for(const overrides of [{version:2},{sequence:0},{previous:'b'.repeat(64)},{at:new Date(Date.parse(manifest.createdAt)-1).toISOString()}])expect(()=>replayGoal(manifest,[event({type:'cancelled',source:'cli'},overrides)])).toThrow();
  expect(()=>replayGoal(manifest,[valid,resign({...valid,sequence:2,previous:valid.hash})])).toThrow();
});
it('preserves history when a writer loses its revision, is cancelled or fails before commit',async()=>{
  const store=new GoalStore(join(root,'goals'));store.create(manifest);const original=store.read(manifest.id),file=join(store.directory(manifest.id),'history.json'),bytes=fs.readFileSync(file);
  await expect(store.append(manifest.id,{type:'cancelled',source:'cli'},{expectedRevision:'a'.repeat(64)})).rejects.toThrow(/changed/);
  await expect(store.append(manifest.id,{type:'cancelled',source:'cli'},{signal:AbortSignal.abort()})).rejects.toThrow();
  await expect(store.append(manifest.id,{type:'cancelled',source:'cli'},{beforeCommit:()=>{throw new Error('injected disk boundary failure');}})).rejects.toThrow(/injected/);
  expect(fs.readFileSync(file)).toEqual(bytes);expect(store.read(manifest.id)).toEqual(original);expect(fs.readdirSync(store.directory(manifest.id))).not.toContain('writer.lock');
  await store.append(manifest.id,{type:'cancelled',source:'cli'});const modified=JSON.parse(fs.readFileSync(file,'utf8'));modified.hash='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(modified));expect(()=>store.read(manifest.id)).toThrow();
});
it('rejects aliases, foreign project stores, malformed owner records and proposal retention overflow',async()=>{
  const store=new GoalStore(join(root,'goals'));expect(store.list(project)).toEqual({goals:[],unavailable:0});store.create(manifest);expect(()=>store.create(manifest)).toThrow(/exists/);
  const other=join(root,'other');fs.mkdirSync(other);expect(store.list(other).goals).toHaveLength(0);expect(()=>store.read(manifest.id,other)).toThrow(/another/);
  fs.symlinkSync(store.root,join(root,'alias'));expect(()=>new GoalStore(join(root,'alias')).read(manifest.id)).toThrow();
  const owner=join(store.directory(manifest.id),'owner.json');fs.writeFileSync(owner,'{}',{mode:0o600});expect(()=>store.owner(manifest.id)).toThrow();fs.unlinkSync(owner);
  const directory=join(store.directory(manifest.id),'proposals'),allocation={id:randomUUID(),phase:'planning' as const,runId:randomUUID(),planHash:'a'.repeat(64),tokens:5000,costNanos:10000000,deadline:manifest.deadline},proposal=toyProposal(manifest,allocation),spend={tokens:0,costNanos:0,revision:'a'.repeat(64)};
  fs.writeFileSync(join(directory,'unexpected.txt'),'toy');expect(()=>store.writeProposal(proposal,spend)).toThrow(/damaged/);fs.unlinkSync(join(directory,'unexpected.txt'));
  for(let n=0;n<64;n++)fs.writeFileSync(join(directory,n.toString(16).padStart(64,'0')+'.json'),'{}',{mode:0o600});expect(()=>store.writeProposal(proposal,spend)).toThrow(/retention/);
});
