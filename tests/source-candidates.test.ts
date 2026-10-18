import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {canonicalJson,digest} from '../src/approvals/index.js';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {MUTATING_TOOLS} from '../src/runtime/permissions.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {collectTaskOutput,changePreparedRun,previewSourceCandidate,createSourceCandidate,inspectSourceCandidate,
  listSourceCandidates,sourceCandidateCapabilities,type SourceCandidateSelection} from '../src/orchestration/index.js';
import {inspectSourceChange,listSourceChanges} from '../src/improvement/index.js';
import {taskWorktree} from '../src/isolation/index.js';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-source-candidates-')));vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No inference in candidate publication.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
const git=(project:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:project,encoding:'utf8'}).trim();
const content='// public toy candidate, not behaviorally verified\nexport const sum = (a: number,b: number) => a + b;\n';

async function fixture({existing=false,completed=true}:{existing?:boolean;completed?:boolean}={}) {
  const p=verifiedPlan();p.version=3;p.tasks=p.tasks.slice(0,1);p.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
  p.limits.timeBudgetMs=60000;for(const agent of p.agents)agent.timeBudgetMs=60000;
  const task=p.tasks[0]!,path='a/candidate.mts';task.outputs[0]!.path=path;
  task.outputs.push({id:'patch',kind:'patch',description:'Executor Git patch.'});task.isolation={patchArtifactId:'patch',commands:[]};
  const f=await coordinatorRun(root,p),options={store:f.runs,approve:async()=> 'allow' as const};
  fs.writeFileSync(join(f.project,'a/source.mjs'),'export const sum = (a,b) => a + b;\n');
  if(existing)fs.writeFileSync(join(f.project,path),'Original target.\n');
  git(f.project,'init','-q');git(f.project,'config','user.name','Local Reviewer');git(f.project,'config','user.email','reviewer@example.test');
  git(f.project,'add','a');git(f.project,'commit','-qm','Original source');const base=git(f.project,'rev-parse','HEAD');
  const ownerId=randomUUID();await f.store.append({type:'started',ownerId});
  await f.store.append({type:'task_started',taskId:task.id,attempt:1,sessionId:'candidate-worker'});
  const workspace=(await taskWorktree(f.store,task,options))!;fs.writeFileSync(join(workspace.filesRoot,path),completed?content:'No declared output check.');
  const collected=await collectTaskOutput(f.store,task,JSON.stringify({version:1,summary:'Generated source.',outputs:[]}),
    {...options,workspace,executorOutputs:new Map([['patch',await workspace.patch()]])});
  await f.store.append({type:'task_finished',taskId:task.id,status:collected.status,output:collected.output});
  await f.store.append({type:'finished',ownerId,status:completed?'completed':'failed'});
  const artifact=collected.output.artifacts.find(a=>a.id==='patch')!;
  const source:SourceCandidateSelection={runId:f.view.run.id,executionRevision:f.store.read().state.revision,
    taskId:task.id,attempt:1,artifactId:artifact.id,artifactHash:artifact.sha256};
  return {...f,options,path,base,source,artifact,preview:()=>previewSourceCandidate(f.project,source,options)};
}

it.each([false,true])('stages an unverified first-attempt candidate without touching existing checkout/index/history (existing=%s)',async existing=>{
  const f=await fixture({existing}),history=f.store.read(),index=fs.readFileSync(join(f.project,'.git/index'));
  fs.writeFileSync(join(f.project,'unrelated.txt'),'Keep unrelated work.');const before=git(f.project,'status','--porcelain');
  const preview=await f.preview();expect(preview.review).toMatchObject({kind:'source-candidate-review',verification:'required',source:{attempt:1}});
  expect(preview.review.paths).toEqual([f.path]);expect(preview.patch).toContain('public toy');
  expect(git(f.project,'for-each-ref','--format=%(refname)','refs/calliope-candidates')).toBe('');
  const calls:any[]=[];const saved=await createSourceCandidate(f.project,f.source,preview.hash,{...f.options,approve:async request=>{calls.push(request);return 'allow';}});
  expect(saved.status).toBe('candidate');expect(saved.review.verification).toBe('required');
  expect(git(f.project,'show',`${saved.commit}:${f.path}`)+'\n').toBe(content);
  expect(git(f.project,'rev-parse',`${saved.commit}^`)).toBe(f.base);
  expect(git(f.project,'rev-parse','HEAD')).toBe(f.base);expect(git(f.project,'status','--porcelain')).toBe(before);
  expect(fs.readFileSync(join(f.project,'.git/index'))).toEqual(index);expect(f.store.read()).toEqual(history);
  expect(existing?fs.readFileSync(join(f.project,f.path),'utf8'):fs.existsSync(join(f.project,f.path))).toBe(existing?'Original target.\n':false);
  expect(calls.some(r=>r.request?.tool==='orchestration_source_candidate')).toBe(true);
  expect(await inspectSourceCandidate(f.project,f.source.runId,preview.hash,f.options)).toEqual(saved);
  expect(await createSourceCandidate(f.project,f.source,preview.hash,{...f.options,approve:async()=> 'deny'})).toEqual(saved);
  expect(await listSourceCandidates(f.project,f.source.runId,f.options)).toEqual([saved]);
  expect(await listSourceChanges(f.project,f.source.runId,f.options)).toEqual([]);
  await expect(inspectSourceChange(f.project,f.source.runId,preview.hash,f.options)).rejects.toThrow('No saved');
  expect(fs.readdirSync(join(f.store.root,'source-candidates')).some(p=>p.startsWith('index-'))).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['denied','stale','artifact','source-commit','rules-commit','revoked','author','attempt','revision','artifact-id','owned','untracked','ignored','unstaged','staged'])('refuses %s before publishing a candidate',async mode=>{
  const f=await fixture({existing:['unstaged','staged'].includes(mode)}),preview=await f.preview();
  let lease:ReturnType<typeof f.store.acquire>|undefined;
  if(mode==='artifact')fs.writeFileSync(join(f.store.root,'artifacts',f.artifact.path),'Changed patch.');
  if(mode==='source-commit')git(f.project,'commit','--allow-empty','-qm','Advanced source');
  if(mode==='rules-commit'){fs.writeFileSync(join(f.project,'RULES.md'),'Changed rulebook');git(f.project,'add','RULES.md');git(f.project,'commit','-qm','Advanced rules');}
  if(mode==='revoked')await changePreparedRun(f.project,f.source.runId,'cancelled',f.options);
  if(mode==='author')git(f.project,'config','user.email','changed@example.test');
  if(mode==='attempt')f.source.attempt=2;
  if(mode==='revision')f.source.executionRevision='a'.repeat(64);
  if(mode==='artifact-id')f.source.artifactId='unknown';
  if(mode==='owned')lease=f.store.acquire();
  if(['untracked','ignored','unstaged','staged'].includes(mode)){
    fs.writeFileSync(join(f.project,f.path),'Keep this conflicting user edit.');
    if(mode==='staged')git(f.project,'add',f.path);
    if(mode==='ignored')fs.writeFileSync(join(f.project,'.gitignore'),f.path+'\n');
  }
  try {
    await expect(createSourceCandidate(f.project,f.source,mode==='stale'?'f'.repeat(64):preview.hash,
      {...f.options,...(mode==='denied'?{approve:async(request:any)=>request.request?.tool==='orchestration_source_candidate'?'deny' as const:'allow' as const}:{})})).rejects.toThrow();
    expect(git(f.project,'for-each-ref','--format=%(refname)','refs/calliope-candidates')).toBe('');
    if(['untracked','ignored','unstaged','staged'].includes(mode))expect(fs.readFileSync(join(f.project,f.path),'utf8')).toBe('Keep this conflicting user edit.');
  } finally {lease?.release();}
});

it('does not turn failed checks into a candidate',async()=>{
  const f=await fixture({completed:false});await expect(f.preview()).rejects.toThrow('completed isolated task');
});

it.each(['source','edit'])('rechecks %s after permission without altering local work',async change=>{
  const f=await fixture(),preview=await f.preview();
  await expect(createSourceCandidate(f.project,f.source,preview.hash,{...f.options,approve:async request=>{
    if(request.request?.tool==='orchestration_source_candidate'){
      if(change==='source')git(f.project,'commit','--allow-empty','-qm','Source changed during permission');
      else fs.writeFileSync(join(f.project,f.path),'Concurrent user target.');
    }
    return 'allow';
  }})).rejects.toThrow();
  expect(git(f.project,'for-each-ref','--format=%(refname)','refs/calliope-candidates')).toBe('');
});

it.each(['intent','commit'])('recovers the same request after interruption at %s',async point=>{
  const f=await fixture(),preview=await f.preview(),controller=new AbortController(),rename=fs.renameSync;
  const intercepted=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
    rename(from,to);
    if(String(to).endsWith(preview.hash+(point==='commit'?'.candidate':'')+'.json'))controller.abort();
  });
  await expect(createSourceCandidate(f.project,f.source,preview.hash,{...f.options,signal:controller.signal})).rejects.toThrow();
  intercepted.mockRestore();
  const pending=await inspectSourceCandidate(f.project,f.source.runId,preview.hash,f.options);
  expect(pending.status).toBe('prepared');expect(pending.commit).toBeNull();
  const saved=await createSourceCandidate(f.project,f.source,preview.hash,f.options);
  if(point==='commit'){
    const original=JSON.parse(fs.readFileSync(join(f.store.root,'source-candidates',preview.hash+'.candidate.json'),'utf8')).body;
    expect(saved.commit).toBe(original.commit);expect(saved.tree).toBe(pending.tree);
  }
  expect(await createSourceCandidate(f.project,f.source,preview.hash,{...f.options,approve:async()=> 'deny'})).toEqual(saved);
  expect(git(f.project,'for-each-ref','--format=%(refname)','refs/calliope-candidates').split('\n')).toEqual([saved.branch]);
});

it('recovers published candidates after source changes and refuses a moved candidate ref',async()=>{
  const f=await fixture();expect(await listSourceCandidates(f.project,f.source.runId,f.options)).toEqual([]);
  const preview=await f.preview(),saved=await createSourceCandidate(f.project,f.source,preview.hash,f.options);
  git(f.project,'commit','--allow-empty','-qm','Source moved after publication');
  expect(await listSourceCandidates(f.project,f.source.runId,{...f.options,approve:async()=> 'deny'})).toEqual([saved]);
  expect(await createSourceCandidate(f.project,f.source,preview.hash,{...f.options,approve:async()=> 'deny'})).toEqual(saved);
  git(f.project,'update-ref',saved.branch,f.base);
  await expect(inspectSourceCandidate(f.project,f.source.runId,preview.hash,f.options)).rejects.toThrow('branch changed');
  await expect(createSourceCandidate(f.project,f.source,preview.hash,f.options)).rejects.toThrow('branch changed');
});

it.each([{runId:'../escape'},{executionRevision:'bad'},{attempt:0},{attempt:1.1},{artifactHash:'bad'},{taskId:'../escape'},{extra:true}])('rejects malformed selection %j',async bad=>{
  await expect(previewSourceCandidate(root,{runId:randomUUID(),executionRevision:'a'.repeat(64),taskId:'worker',attempt:1,artifactId:'patch',artifactHash:'b'.repeat(64),...bad} as SourceCandidateSelection)).rejects.toThrow();
});

it('requires a distinct mutating permission and advertises independent verification',()=>{
  expect(MUTATING_TOOLS.has('orchestration_source_candidate')).toBe(true);
  expect(sourceCandidateCapabilities()).toMatchObject({version:1,verification:'required',merge:false,push:false,mayCallModel:false});
});

it.each(['damaged','family','candidate-id','commit-content'])('refuses %s retained evidence instead of silently replacing the request',async mode=>{
  const f=await fixture(),preview=await f.preview(),saved=await createSourceCandidate(f.project,f.source,preview.hash,f.options);
  const directory=join(f.store.root,'source-candidates'),file=join(directory,preview.hash+(mode==='candidate-id'||mode==='commit-content'?'.candidate':'')+'.json');
  if(mode==='damaged')fs.writeFileSync(file,'incomplete');
  else {
    const record=JSON.parse(fs.readFileSync(file,'utf8'));
    if(mode==='family')record.body.review.kind='source-change-review';
    if(mode==='candidate-id')record.body.commit='bad';
    if(mode==='commit-content'){
      record.body.commit=f.base;record.body.tree=git(f.project,'rev-parse',f.base+'^{tree}');git(f.project,'update-ref',saved.branch,f.base);
    }
    record.sha256=digest(canonicalJson(record.body));fs.writeFileSync(file,canonicalJson(record));
  }
  await expect(inspectSourceCandidate(f.project,f.source.runId,preview.hash,f.options)).rejects.toThrow();
  await expect(createSourceCandidate(f.project,f.source,preview.hash,f.options)).rejects.toThrow();
  expect(git(f.project,'for-each-ref','--format=%(refname)','refs/calliope-candidates').split('\n')).toEqual([saved.branch]);
});

it('bounds the number of retained candidate requests before creating another intent',async()=>{
  const f=await fixture(),preview=await f.preview(),directory=join(f.store.root,'source-candidates');fs.mkdirSync(directory,{mode:0o700});
  for(let n=0;n<100;n++)fs.writeFileSync(join(directory,n.toString(16).padStart(64,'0')+'.json'),'unopened prior receipt');
  await expect(createSourceCandidate(f.project,f.source,preview.hash,f.options)).rejects.toThrow('100 source proposal');
  expect(fs.existsSync(join(directory,preview.hash+'.json'))).toBe(false);
  expect(git(f.project,'for-each-ref','--format=%(refname)','refs/calliope-candidates')).toBe('');
});
