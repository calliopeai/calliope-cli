import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {RunStore,prepareRun,changePreparedRun,prepareAgentExecution,executionManifestForRun} from '../src/orchestration/index.js';
import {toyPlan} from './helpers/orchestration-plan.js';
let root:string,project:string,store:RunStore;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-orch-execution-')));project=join(root,'project');fs.mkdirSync(project);store=new RunStore(join(root,'store'));fs.writeFileSync(join(project,'plan.json'),JSON.stringify(toyPlan()));vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No provider request allowed');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
const approved=async()=>{const view=await prepareRun(project,'plan.json',{store});return changePreparedRun(project,view.run.id,'approved',{store});};
it('derives authority only from an approved immutable plan and preserves the original deadline across restart',async()=>{
  const view=await approved(),execution=await prepareAgentExecution(project,view.run.id,'a',20,{store,confirmation:'mutating',approve:async()=> 'allow'});
  const saved=execution.ledger.read(project);expect(saved.manifest.planHash).toBe(view.manifest.planHash);expect(saved.manifest.accounts[1]).toMatchObject({id:'a',allowedPaths:[{path:'a',access:'write'}],tokenBudget:1000});
  const later=await prepareAgentExecution(project,view.run.id,'b',10,{store});expect(later.ledger.read(project).manifest).toEqual(saved.manifest);expect(later.manifestHash).toBe(execution.manifestHash);expect(saved.events).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
  expect(executionManifestForRun(view.manifest,saved.manifest.createdAt)).toEqual(saved.manifest);
});
it('denies unapproved runs, malformed agent/output requests, project policy and non-interactive mutations',async()=>{
  const prepared=await prepareRun(project,'plan.json',{store});await expect(prepareAgentExecution(project,prepared.run.id,'a',20,{store})).rejects.toMatchObject({code:'policy-denied'});
  const view=await changePreparedRun(project,prepared.run.id,'approved',{store});
  for(const [agent,max] of [['missing',20],['a',0],['a',NaN],['a',1.5]] as const)await expect(prepareAgentExecution(project,view.run.id,agent,max,{store})).rejects.toMatchObject({code:'invalid'});
  await expect(prepareAgentExecution(project,view.run.id,'a',20,{store,confirmation:'mutating'})).rejects.toThrow();
  config.set('policy',{command:'exit 17'});await expect(prepareAgentExecution(project,view.run.id,'a',20,{store})).rejects.toThrow();
  expect(fs.existsSync(join(store.root,view.run.id,'budget'))).toBe(false);expect(fetch).not.toHaveBeenCalled();
});
it('rechecks approval revisions after waiting and propagates cancellation without creating authority',async()=>{
  const view=await approved();
  await expect(prepareAgentExecution(project,view.run.id,'a',20,{store,confirmation:'mutating',approve:async()=>{await changePreparedRun(project,view.run.id,'cancelled',{store});return 'allow';}})).rejects.toMatchObject({code:'conflict'});
  expect(fs.existsSync(join(store.root,view.run.id,'budget'))).toBe(false);
  await expect(prepareAgentExecution(project,view.run.id,'a',20,{store,signal:AbortSignal.abort()})).rejects.toMatchObject({name:'AbortError'});
});
it('never replaces damaged or foreign execution state with a fresh budget',async()=>{
  const view=await approved(),execution=await prepareAgentExecution(project,view.run.id,'a',20,{store});
  fs.unlinkSync(join(execution.ledger.root,'history.json'));await expect(prepareAgentExecution(project,view.run.id,'a',20,{store})).rejects.toThrow();expect(fs.existsSync(join(execution.ledger.root,'history.json'))).toBe(false);
});
