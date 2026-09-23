import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExecutionGuard,ReservationLedger,manifestHash,validateExecutionManifest,agentFiles,assertExecutionStoreOutsideProject,type ExecutionManifest} from '../src/execution/index.js';
import {resolvePermission} from '../src/runtime/permissions.js';
import {executeTool} from '../src/tools.js';
import {withScope} from '../src/scope.js';
import {saveHooks} from '../src/hooks.js';
import * as config from '../src/config.js';
import * as fleet from '../src/fleet.js';
import {executionManifest} from './helpers/execution-manifest.js';
import {simulateWindowsPathSeparators} from './helpers/windows-path.js';
vi.mock('node:path', async original => ({ ...await original<typeof import('node:path')>() }));
let root:string,project:string,manifest:ExecutionManifest,ledger:ReservationLedger;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-authority-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);for(const name of ['a','b'])fs.mkdirSync(join(project,name));manifest=executionManifest(project);ledger=new ReservationLedger(join(root,'budget'));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
const guard=(agentId='a')=>{ledger.create(manifest);return new ExecutionGuard({ledger,manifestHash:manifestHash(manifest),agentId,maxOutputTokens:100},project);};
it('accepts a store outside the project on Windows, where relative() returns backslashes (#382)',()=>{
  const restore=simulateWindowsPathSeparators();
  try {
    const outside=join(root,'store','brain');fs.mkdirSync(outside,{recursive:true});
    expect(()=>assertExecutionStoreOutsideProject(project,outside)).not.toThrow();
  } finally { restore(); }
});
it('still rejects a store the Windows separator check would otherwise miss, aliased inside the project',()=>{
  const restore=simulateWindowsPathSeparators();
  try {
    const inside=join(project,'a','store');fs.mkdirSync(inside,{recursive:true});
    expect(()=>assertExecutionStoreOutsideProject(project,inside)).toThrow(/outside worker project scope/);
  } finally { restore(); }
});
it('rejects changed OpenRouter transport prices before writing an agent reservation',async()=>{
  const budget=guard().budget({provider:'openrouter',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),
    capabilities:{chat:true},contextLength:900,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'},[],[],false);
  const attempt={provider:'openrouter' as const,model:'toy',target:'a'.repeat(64),maxOutputTokens:100};
  for(const priceCeiling of [undefined,{input:0,output:2},{input:1,output:0}])await expect(budget.reserve({...attempt,priceCeiling})).rejects.toMatchObject({code:'authority'});
  expect(ledger.read(project).events).toHaveLength(0);
});
it('validates bounded inherited authority and rejects malformed or expanded contracts',()=>{
  expect(validateExecutionManifest(manifest)).toEqual(manifest);
  for(const mutate of [(m:any)=>m.version=2,(m:any)=>m.extra=true,(m:any)=>m.deadline+=86400000,(m:any)=>m.accounts[1].parentId='a',(m:any)=>m.accounts[1].allowedTools.push('shell'),(m:any)=>m.accounts[1].allowedPaths[0].path='../escape',(m:any)=>m.accounts[1].costBudgetNanos=10000001,(m:any)=>m.accounts[2].id='a']){
    const value=structuredClone(manifest);mutate(value);expect(()=>validateExecutionManifest(value)).toThrow();
  }
});
it('denies undeclared paths and tools before running policy, hooks or approval',async()=>{
  const g=guard(),marker=join(project,'marker');config.set('policy',{command:`touch '${marker}'`});const approve=vi.fn(async()=> 'allow' as const);
  for(const call of [{id:'read',name:'read_file',arguments:{path:'b/private.txt'}},{id:'shell',name:'shell',arguments:{command:'echo no'}},{id:'net',name:'web_fetch',arguments:{url:'https://example.invalid'}}]){
    const decision=await withScope(project,()=>resolvePermission(call,{cwd:project,confirmation:'mutating',authority:g.check,approve}));expect(decision).toMatchObject({decision:'deny',layer:'scope'});
  }
  expect(fs.existsSync(marker)).toBe(false);expect(approve).not.toHaveBeenCalled();
});
it('rejects unsupported containment even when the plan explicitly names shell or custom tools',async()=>{
  for(const a of manifest.accounts)a.allowedTools.push('shell','custom_tool');const g=guard();
  for(const name of ['shell','custom_tool'])expect(g.check({id:name,name,arguments:{command:'echo no'}})).toMatch(/containment/);
  expect(g.tools([{name:'shell'} as any,{name:'read_file'} as any]).map(t=>t.name)).toEqual(['read_file']);
});
it('rechecks agent scope after approval and at the tool boundary',async()=>{
  const g=guard(),target=join(project,'a/file.txt'),outside=join(root,'outside');fs.writeFileSync(target,'old');fs.writeFileSync(outside,'outside');
  const call={id:'write',name:'write_file',arguments:{path:target,content:'unsafe'}};
  const decision=await withScope(project,()=>resolvePermission(call,{cwd:project,confirmation:'mutating',authority:g.check,approve:async()=>{fs.unlinkSync(target);fs.symlinkSync(outside,target);return 'allow';}}));
  expect(decision.decision).toBe('deny');
  const result=await withScope(project,()=>executeTool(call,project,1000,undefined,{authority:g.check}));expect(result.isError).toBe(true);expect(fs.readFileSync(outside,'utf8')).toBe('outside');
});
it('writes atomically through the declared edit tool and detects stale reads and cancellation',async()=>{
  manifest.accounts[1]!.allowedTools=['edit_file'];const g=guard(),file=join(project,'a/file.txt');fs.writeFileSync(file,'hello');
  const call={id:'edit',name:'edit_file',arguments:{path:file,old_string:'hello',new_string:'world'}};
  const result=await withScope(project,()=>executeTool(call,project,1000,undefined,{authority:g.check,fs:agentFiles(g,'a',call)}));expect(result.isError).toBeFalsy();expect(fs.readFileSync(file,'utf8')).toBe('world');
  const delegate=agentFiles(g,'a',call);await delegate.readTextFile!(file);fs.writeFileSync(file,'changed');await expect(delegate.writeTextFile!(file,'stale')).rejects.toMatchObject({code:'conflict'});expect(fs.readFileSync(file,'utf8')).toBe('changed');
  const controller=new AbortController(),cancelled=agentFiles(g,'a',call,controller.signal);await cancelled.readTextFile!(file);controller.abort();await expect(cancelled.writeTextFile!(file,'cancelled')).rejects.toThrow();expect(fs.readFileSync(file,'utf8')).toBe('changed');
});
it('allows a declared creation write without read_file while preserving read-before-write for existing files',async()=>{
  manifest.accounts[1]!.allowedTools=['write_file'];const g=guard(),file=join(project,'a/new-file.txt');
  const call={id:'create',name:'write_file',arguments:{path:file,content:'created'}};
  const result=await withScope(project,()=>executeTool(call,project,1000,undefined,{authority:g.check,fs:agentFiles(g,'a',call)}));
  expect(result.isError).toBeFalsy();expect(fs.readFileSync(file,'utf8')).toBe('created');
  const existing=join(project,'a/existing.txt');fs.writeFileSync(existing,'old');
  const blocked=agentFiles(g,'a',{...call,id:'overwrite',arguments:{path:existing,content:'new'}});
  await expect(blocked.writeTextFile!(existing,'new')).rejects.toMatchObject({code:'conflict'});
  expect(fs.readFileSync(existing,'utf8')).toBe('old');
});
it('denies writes through read-only grants and creation of undeclared parent directories',async()=>{
  manifest.accounts[1]!.allowedPaths=[{path:'a/new/file.txt',access:'write'}];const g=guard(),call={id:'write',name:'write_file',arguments:{path:'a/new/file.txt',content:'text'}};
  const result=await withScope(project,()=>executeTool(call,project,1000,undefined,{authority:g.check,fs:agentFiles(g,'a',call)}));expect(result.isError).toBe(true);expect(fs.existsSync(join(project,'a/new'))).toBe(false);
  const b=new ExecutionGuard({ledger,manifestHash:manifestHash(manifest),agentId:'b',maxOutputTokens:100},project);expect(b.check({id:'bad',name:'write_file',arguments:{path:'b/file'}})).toMatch(/write scope/);
});
it('lists within scope with a total entry limit and never follows directory symlinks',async()=>{
  const g=guard(),outside=join(root,'outside-dir');fs.mkdirSync(outside);fs.writeFileSync(join(outside,'private.txt'),'secret');fs.symlinkSync(outside,join(project,'a/link'));
  for(let n=0;n<1001;n++)fs.writeFileSync(join(project,'a',String(n)),'');const call={id:'list',name:'list_files',arguments:{path:'a',recursive:true}};
  const result=await withScope(project,()=>executeTool(call,project,1000,undefined,{authority:g.check,fs:agentFiles(g,'a',call)}));expect(result.result).toContain('limited to 1,000');expect(result.result).not.toContain('private.txt');
});
it('does not mirror bounded tool arguments to an enabled fleet transport',async()=>{
  vi.spyOn(fleet,'fleetActive').mockReturnValue(true);const mirror=vi.spyOn(fleet,'fleetMirrorToolCall').mockResolvedValue(undefined);
  const g=guard(),file=join(project,'a/source.txt');fs.writeFileSync(file,'public toy');const call={id:'read',name:'read_file',arguments:{path:file}};
  const result=await withScope(project,()=>executeTool(call,project,1000,undefined,{authority:g.check,fs:agentFiles(g,'a',call)}));expect(result.isError).toBeFalsy();expect(result.result).toContain('public toy');expect(mirror).not.toHaveBeenCalled();
});
