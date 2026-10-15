import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {collectTaskOutput,changePreparedRun} from '../src/orchestration/index.js';
import {taskWorktree} from '../src/isolation/index.js';
import {supervisionEvidence} from '../src/supervision/index.js';
import {inspectImprovements,improvementProposalHash,previewSourceChange,proposeSourceChange,inspectSourceChange,
  sourceChangeCapabilities,withdrawImprovement,type SourceChangeSelection} from '../src/improvement/index.js';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-source-proposals-')));vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No inference in source proposals.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
const git=(project:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:project,encoding:'utf8'}).trim();

async function fixture(kind='skill'){
  const p=verifiedPlan();p.version=4;p.tasks=p.tasks.slice(0,1);p.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
  p.limits.timeBudgetMs=60000;for(const agent of p.agents)agent.timeBudgetMs=60000;
  p.supervision={version:1,controllerId:'coordinator',maxRounds:3,maxStalledRounds:2,maxOutputTokens:10,principle:'robustness',allowedActions:['retry','replan','decompose']};
  const task=p.tasks[0]!,path='a/'+(kind==='skill'?'SKILL.md':'panel.html');task.outputs[0]!.path=path;
  task.outputs.push({id:'patch',kind:'patch',description:'Executor Git patch.'});task.isolation={patchArtifactId:'patch',commands:[]};
  const f=await coordinatorRun(root,p),options={store:f.runs,approve:async()=> 'allow' as const};
  fs.writeFileSync(join(f.project,path),'Original source.');git(f.project,'init','-q');git(f.project,'config','user.name','Local Reviewer');git(f.project,'config','user.email','reviewer@example.test');
  git(f.project,'add',path);git(f.project,'commit','-qm','Source fixture');const base=git(f.project,'rev-parse','HEAD');
  const ownerId=randomUUID();await f.store.append({type:'started',ownerId});
  async function finish(attempt:number,content:string){
    await f.store.append({type:'task_started',taskId:task.id,attempt,sessionId:'worker-'+attempt});
    const workspace=(await taskWorktree(f.store,task,options))!;fs.writeFileSync(join(workspace.filesRoot,path),content);
    const collected=await collectTaskOutput(f.store,task,JSON.stringify({version:1,summary:'Native checked source.',outputs:[]}),
      {...options,workspace,executorOutputs:new Map([['patch',await workspace.patch()]])});
    await f.store.append({type:'task_finished',taskId:task.id,status:collected.status,output:collected.output});
  }
  async function decide(round:number,retry:boolean){
    const evidence=supervisionEvidence(f.store.read().events);
    await f.store.append({type:'supervision_started',round,role:'controller',agentId:'coordinator',sessionId:'controller-'+round,evidenceIds:evidence.ids,evidenceHash:evidence.hash});
    const event=await f.store.append({type:'supervision_decided',round,role:'controller',agentId:'coordinator',sessionId:'controller-'+round,
      decision:retry?{version:1,action:'retry',reason:'Repair failed source.',evidence:evidence.ids,taskId:task.id,hypothesis:'Fix source acceptance.',expectedMetric:{name:'failed checks',direction:'decrease'}}:
        {version:1,action:'continue',reason:'Verified source.',evidence:evidence.ids}});
    await f.store.append({type:'supervision_applied',round,decisionId:event.id,receipts:[]});return event;
  }
  await finish(1,'Missing expected evidence.');await decide(1,true);await finish(2,kind==='skill'?'---\nname: local-fixture\ndescription: public toy guidance\n---\nCheck the source.\n':'<main>public toy interface</main>\n');
  await decide(2,false);await f.store.append({type:'finished',ownerId,status:'completed'});
  const current=await inspectImprovements(f.project,f.view.run.id,options),cycle=current.history.cycles[0]!;
  expect(cycle.status).toBe('verified');const artifact=cycle.results[0]!.artifacts.find(a=>a.id==='patch')!;
  const source:SourceChangeSelection={runId:f.view.run.id,cycleId:cycle.id,executionRevision:current.history.revision,proposalHash:improvementProposalHash(cycle),
    taskId:task.id,artifactId:artifact.id,artifactHash:artifact.sha256};
  return {...f,options,path,base,source,artifact,preview:()=>previewSourceChange(f.project,source,options)};
}

it.each(['skill','interface'])('creates a reviewed local %s branch and retains checkout, index and native history',async kind=>{
  const f=await fixture(kind),before=f.store.read(),index=fs.readFileSync(join(f.project,'.git/index'));
  fs.writeFileSync(join(f.project,'unrelated.txt'),'Preserve unrelated dirty source.');const status=git(f.project,'status','--porcelain');
  const preview=await f.preview();expect(preview.review.paths).toEqual([f.path]);expect(preview.patch).toContain('public toy');
  expect(git(f.project,'for-each-ref','--format=%(refname)','refs/heads/calliope-proposals')).toBe('');
  const seen:any[]=[];const saved=await proposeSourceChange(f.project,f.source,preview.hash,{...f.options,approve:async request=>{seen.push(request);return 'allow';}});
  expect(saved.status).toBe('proposed');expect(git(f.project,'show',`${saved.commit}:${f.path}`)).toContain('public toy');
  expect(git(f.project,'rev-parse',`${saved.commit}^`)).toBe(f.base);expect(git(f.project,'rev-parse','HEAD')).toBe(f.base);
  expect(git(f.project,'status','--porcelain')).toBe(status);expect(fs.readFileSync(join(f.project,'.git/index'))).toEqual(index);
  expect(fs.readFileSync(join(f.project,f.path),'utf8')).toBe('Original source.');expect(f.store.read()).toEqual(before);
  expect(seen.some(r=>r.request?.tool==='orchestration_source_proposal')).toBe(true);
  expect(await inspectSourceChange(f.project,f.source.runId,preview.hash,f.options)).toEqual(saved);
  expect(await proposeSourceChange(f.project,f.source,preview.hash,{...f.options,approve:async()=> 'deny'})).toEqual(saved);
  expect(git(f.project,'for-each-ref','--format=%(refname)','refs/heads/calliope-proposals').split('\n')).toEqual([saved.branch]);
  expect(fs.readdirSync(join(f.store.root,'source-proposals')).some(p=>p.startsWith('index-'))).toBe(false);expect(fetch).not.toHaveBeenCalled();
});

it.each(['denied','stale','artifact','advanced','revoked','withdrawn','author'])('refuses %s source authority or evidence before creating a branch',async mode=>{
  const f=await fixture(),preview=await f.preview();
  if(mode==='artifact')fs.writeFileSync(join(f.store.root,'artifacts',f.artifact.path),'changed');
  if(mode==='advanced')git(f.project,'commit','--allow-empty','-qm','Source advanced');
  if(mode==='revoked')await changePreparedRun(f.project,f.source.runId,'cancelled',f.options);
  if(mode==='withdrawn')await withdrawImprovement(f.project,f.source.runId,f.source.cycleId,f.options);
  if(mode==='author')git(f.project,'config','user.email','changed@example.test');
  await expect(proposeSourceChange(f.project,f.source,mode==='stale'?'f'.repeat(64):preview.hash,
    {...f.options,...(mode==='denied'?{approve:async(request:any)=>request.request?.tool==='orchestration_source_proposal'?'deny' as const:'allow' as const}:{})})).rejects.toThrow();
  expect(git(f.project,'for-each-ref','--format=%(refname)','refs/heads/calliope-proposals')).toBe('');
});

it('rechecks source after permission and detects a moved proposal branch',async()=>{
  const f=await fixture(),preview=await f.preview();
  await expect(proposeSourceChange(f.project,f.source,preview.hash,{...f.options,approve:async request=>{
    if(request.request?.tool==='orchestration_source_proposal')git(f.project,'commit','--allow-empty','-qm','Changed during permission');return 'allow';
  }})).rejects.toThrow();
  git(f.project,'reset','--soft',f.base);const saved=await proposeSourceChange(f.project,f.source,preview.hash,f.options);
  git(f.project,'update-ref',saved.branch,f.base);
  await expect(inspectSourceChange(f.project,f.source.runId,preview.hash,f.options)).rejects.toThrow('branch changed');
  await expect(proposeSourceChange(f.project,f.source,preview.hash,f.options)).rejects.toThrow('branch changed');
});

it('advertises source authoring without skill installation, merging, inference or remote publication',()=>{
  expect(sourceChangeCapabilities()).toMatchObject({version:1,writer:'git',installation:false,merge:false,push:false,mayCallModel:false});
});

it('recovers the same candidate after cancellation between commit creation and branch publication',async()=>{
  const f=await fixture(),preview=await f.preview(),controller=new AbortController(),rename=fs.renameSync;
  const failure=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
    rename(from,to);if(String(to).endsWith('.candidate.json'))controller.abort();
  });
  await expect(proposeSourceChange(f.project,f.source,preview.hash,{...f.options,signal:controller.signal})).rejects.toThrow();
  failure.mockRestore();
  const pending=await inspectSourceChange(f.project,f.source.runId,preview.hash,f.options);
  expect(pending.status).toBe('prepared');expect(pending.commit).toBeNull();expect(pending.tree).toMatch(/^[a-f0-9]{40,64}$/);
  const candidate=JSON.parse(fs.readFileSync(join(f.store.root,'source-proposals',preview.hash+'.candidate.json'),'utf8')).body;
  const recovered=await proposeSourceChange(f.project,f.source,preview.hash,f.options);
  expect(recovered.commit).toBe(candidate.commit);expect(recovered.tree).toBe(candidate.tree);
  expect(git(f.project,'rev-parse','HEAD')).toBe(f.base);expect(fetch).not.toHaveBeenCalled();
});
