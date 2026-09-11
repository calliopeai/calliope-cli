import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {GoalStore,newGoalManifest,plannerPlan,proposePlan,signed,validateGoalManifest,validateGoalLimits,validateGoalLink,validateGoalProposal,validateGoalEvent,replayGoal,goalHistoryHash,type GoalManifest,type GoalEvent} from '../src/goals/index.js';
import {toyGoal,toyProposal,goalFixture} from './helpers/goal.js';
import {verifiedPlan} from './helpers/coordinator-run.js';
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
