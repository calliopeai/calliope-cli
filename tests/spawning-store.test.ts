import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun} from './helpers/coordinator-run.js';
import {inspectSpawn,admitSpawn,SpawnProposalStore,inspectSpawnAuthority,spawnCommand,executeSpawn,type SpawnInput} from '../src/spawning/index.js';
import {ReservationLedger,ExecutionGuard} from '../src/execution/index.js';
import {ExecutionStore,replayExecution,controlExecution,changePreparedRun} from '../src/orchestration/index.js';
import {simulateWindowsDirectoryFsyncDenial} from './helpers/windows-fsync.js';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-spawn-')));fs.chmodSync(root,0o700);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No provider request authorized');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
async function setup(){
  const run=await coordinatorRun(root),agent=structuredClone(run.view.manifest.plan.agents[1]!),task=structuredClone(run.view.manifest.plan.tasks[0]!);
  agent.id='c';agent.allowedPaths=[{path:'c',access:'write'}];task.id='inspect-c';task.agentId='c';task.outputs[0]!.id='report-c';task.outputs[0]!.path='c/report.txt';task.acceptanceChecks![0]!.artifactId='report-c';
  const input:SpawnInput={version:1,parentId:'coordinator',agents:[agent],tasks:[task]};fs.mkdirSync(join(run.project,'c'));fs.writeFileSync(join(run.project,'children.json'),JSON.stringify(input));
  return{...run,input,options:{store:run.runs},id:run.view.run.id};
}
it('previews without allocating, admits the exact graph, and replays unchanged authority across restart',async()=>{
  const r=await setup(),preview=await inspectSpawn(r.project,r.id,'children.json',r.options);expect(r.authority.ledger.read(r.project).events).toEqual([]);expect(fs.existsSync(join(r.store.root,'spawn-proposals'))).toBe(false);
  const accepted=await admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,r.options);expect(accepted.alreadyAdmitted).toBe(false);expect(accepted.execution.state.tasks['inspect-c']).toMatchObject({status:'pending',attempts:0});expect(accepted.execution.events[0]!.version).toBe(2);
  const restarted=new ExecutionStore(join(r.runs.root,r.id),r.view.manifest),view=restarted.read();expect(replayExecution(view.header,r.view.manifest,view.events)).toEqual(view.state);expect(view.header).toEqual(r.store.read().header);expect(restarted.manifest.plan.agents).toHaveLength(3);expect(restarted.context().plan.agents).toHaveLength(4);
  expect(inspectSpawnAuthority(restarted,r.authority.ledger).pending).toEqual([]);expect(new SpawnProposalStore(restarted).read(preview.proposal.hash)).toEqual(preview.proposal);
  const repeated=await admitSpawn(r.project,r.id,preview.proposal.hash,preview.proposal.hash,r.options);expect(repeated.alreadyAdmitted).toBe(true);expect(r.authority.ledger.read(r.project).events).toHaveLength(1);expect(r.store.read().events).toHaveLength(1);
  const forged=structuredClone(accepted.admission);forged.proposal.agents[0]!.id='coordinator';await expect(executeSpawn(r.project,forged,r.options)).rejects.toThrow(/recorded authority/);
  const guard=new ExecutionGuard({...r.authority,agentId:'c'},r.project);expect(guard.check({id:'call',name:'read_file',arguments:{path:'a/report.txt'}})).toMatch(/scope/);
  await controlExecution(r.project,r.id,'agent-stop','c',r.options);expect(r.store.read().state.stoppedAgents).toContain('c');
});
it('preserves a grant after interrupted activation and recovers it without re-reading a changed source or resetting the clock',async()=>{
  const r=await setup(),preview=await inspectSpawn(r.project,r.id,'children.json',r.options),controller=new AbortController(),original=ReservationLedger.prototype.grantChildren;
  const spy=vi.spyOn(ReservationLedger.prototype,'grantChildren').mockImplementation(async function(...args){const result=await original.apply(this,args);controller.abort();return result;});
  await expect(admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,{...r.options,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});spy.mockRestore();
  const budget=r.authority.ledger.read(r.project);expect(budget.projection.childGrants).toHaveLength(1);expect(r.store.read().state.graph).toBeUndefined();expect(inspectSpawnAuthority(r.store,r.authority.ledger).pending).toHaveLength(1);
  fs.unlinkSync(join(r.project,'children.json'));const admitted=await admitSpawn(r.project,r.id,preview.proposal.hash,preview.proposal.hash,r.options);expect(admitted.admission.grant).toEqual(budget.projection.childGrants![0]);expect(r.authority.ledger.read(r.project)).toEqual(budget);expect(inspectSpawnAuthority(r.store,r.authority.ledger).pending).toEqual([]);
});
it('rejects stale source, wrong approval, cancelled approval, and changed graph without allocating',async()=>{
  const r=await setup(),preview=await inspectSpawn(r.project,r.id,'children.json',r.options);
  await expect(admitSpawn(r.project,r.id,preview.proposal,'0'.repeat(64),r.options)).rejects.toMatchObject({code:'policy-denied'});
  await expect(admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,{...r.options,confirmation:'mutating',approve:async()=> 'reject'})).rejects.toThrow(/policy/);
  await expect(admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,{...r.options,signal:AbortSignal.abort()})).rejects.toMatchObject({name:'AbortError'});
  fs.appendFileSync(join(r.project,'children.json'),' ');await expect(admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,r.options)).rejects.toThrow(/source changed/);expect(r.authority.ledger.read(r.project).events).toEqual([]);
  await changePreparedRun(r.project,r.id,'cancelled',r.options);await expect(inspectSpawn(r.project,r.id,'children.json',r.options)).rejects.toThrow(/revoked/);
});
it('serializes competing approvals and keeps the losing proposal from expanding the winning graph',async()=>{
  const r=await setup(),a=(await inspectSpawn(r.project,r.id,'children.json',r.options)).proposal;
  r.input.agents[0]!.id='d';r.input.tasks[0]!.id='inspect-d';r.input.tasks[0]!.agentId='d';fs.writeFileSync(join(r.project,'second.json'),JSON.stringify(r.input));const b=(await inspectSpawn(r.project,r.id,'second.json',r.options)).proposal;
  const results=await Promise.allSettled([a,b].map(p=>admitSpawn(r.project,r.id,p,p.hash,r.options)));expect(results.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(r.store.read().state.graph!.admissions).toHaveLength(1);expect(r.authority.ledger.read(r.project).projection.childGrants).toHaveLength(1);
});
it('denies stopped parents, unknown parents, depth violations, scope expansion and malformed sources',async()=>{
  const r=await setup();for(const input of [{...r.input,parentId:'missing'},{...r.input,agents:[{...r.input.agents[0],parentId:'a'}]},{...r.input,agents:[{...r.input.agents[0],allowedTools:['shell']}]},{...r.input,version:2},{...r.input,tasks:[]},{...r.input,extra:true}]){fs.writeFileSync(join(r.project,'bad.json'),JSON.stringify(input));await expect(inspectSpawn(r.project,r.id,'bad.json',r.options)).rejects.toThrow();}
  fs.writeFileSync(join(r.project,'bad.json'),'{');await expect(inspectSpawn(r.project,r.id,'bad.json',r.options)).rejects.toThrow(/JSON/);await expect(inspectSpawn(r.project,r.id,'../bad.json',r.options)).rejects.toThrow();
  const preview=await inspectSpawn(r.project,r.id,'children.json',r.options);await r.store.append({type:'agent_stop',agentId:'coordinator'});await expect(admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,r.options)).rejects.toThrow(/stopped/);expect(r.authority.ledger.read(r.project).events).toEqual([]);
});
it('checks executable policy during preview and approval and does not mutate stores on dry-run',async()=>{
  const r=await setup(),preview=await inspectSpawn(r.project,r.id,'children.json',{...r.options,dryRun:true});config.set('policy',{command:'exit 17'});
  await expect(inspectSpawn(r.project,r.id,'children.json',{...r.options,dryRun:true})).rejects.toThrow(/Dry-run/);await expect(inspectSpawn(r.project,r.id,'children.json',r.options)).rejects.toThrow(/policy/);await expect(admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,r.options)).rejects.toThrow(/policy/);expect(r.store.read().events).toEqual([]);expect(r.authority.ledger.read(r.project).events).toEqual([]);
});
it('keeps headless error envelopes stable, refuses malformed flags and requires REPL review even with confirmation off',async()=>{
  const r=await setup(),lines:string[]=[],options={...r.options,cwd:r.project,write:(text:string)=>lines.push(text)};
  for(const args of [['spawn'],['spawn','children.json'],['spawn','children.json','--run',r.id,'--wat'],['spawn','children.json','--run',r.id,'--max-output-tokens','NaN'],['spawn','children.json','--run',r.id,'--dry-run','--approve','0'.repeat(64)],['spawn','children.json','--run',r.id,'--resume','0'.repeat(64)]]){lines.length=0;expect(await spawnCommand([...args,'--json'],options)).toBe(2);expect(JSON.parse(lines.at(-1)!).type).toBe('orchestration.spawn.error');}
  expect(await spawnCommand(['spawn','children.json','--run',r.id,'--json'],{...options,signal:AbortSignal.abort()})).toBe(130);
  expect(await spawnCommand(['spawn','missing.json','--run',r.id,'--json'],options)).toBe(1);
  expect(await spawnCommand(['spawn','children.json','--run',r.id,'--dry-run','--json'],options)).toBe(0);expect(r.authority.ledger.read(r.project).events).toEqual([]);
  const decisions:string[]=[];expect(await spawnCommand(['spawn','children.json','--run',r.id],{...options,source:'repl',confirmation:'none',approve:async decision=>{decisions.push(decision.request!.tool);return 'reject';}})).toBe(3);expect(decisions).toEqual(['orchestration_spawn']);expect(r.authority.ledger.read(r.project).events).toEqual([]);
});
it('cancels the actual REPL approval signal without admitting children',async()=>{
  const r=await setup(),preview=await inspectSpawn(r.project,r.id,'children.json',r.options),controller=new AbortController();let approvalSignal:AbortSignal|undefined;
  await expect(admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,{...r.options,source:'repl',signal:controller.signal,approve:async(_decision,signal)=>{approvalSignal=signal;controller.abort();return 'allow';}})).rejects.toMatchObject({name:'AbortError'});expect(approvalSignal?.aborted).toBe(true);expect(r.authority.ledger.read(r.project).events).toEqual([]);
});
it('rejects renamed proposal records and aliased private storage without granting authority',async()=>{
  const r=await setup(),preview=await inspectSpawn(r.project,r.id,'children.json',r.options),proposals=new SpawnProposalStore(r.store);fs.mkdirSync(proposals.root,{mode:0o700});
  fs.writeFileSync(join(proposals.root,'0'.repeat(64)+'.json'),JSON.stringify(preview.proposal),{mode:0o600});expect(()=>proposals.read('0'.repeat(64))).toThrow(/requested hash/);expect(()=>proposals.read('../outside')).toThrow(/hash/);
  fs.rmSync(proposals.root,{recursive:true});const target=join(root,'foreign');fs.mkdirSync(target,{mode:0o700});fs.symlinkSync(target,proposals.root);await expect(admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,r.options)).rejects.toThrow(/symlink/);expect(r.authority.ledger.read(r.project).events).toEqual([]);
});
it('admits a child spawn proposal on Windows, where its directories cannot be fsynced (#388)',async()=>{
  const restore=simulateWindowsDirectoryFsyncDenial();
  try{
    const r=await setup(),preview=await inspectSpawn(r.project,r.id,'children.json',r.options);
    const accepted=await admitSpawn(r.project,r.id,preview.proposal,preview.proposal.hash,r.options);
    expect(accepted.alreadyAdmitted).toBe(false);expect(new SpawnProposalStore(r.store).read(preview.proposal.hash)).toEqual(preview.proposal);
  }finally{restore();}
});
