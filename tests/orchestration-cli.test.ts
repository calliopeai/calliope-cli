import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import { saveHooks } from '../src/hooks.js';
import { RunStore, orchestrationCommand, runOrchestrationCommand, parseOrchestrationArgs, formatOrchestration, prepareRun, changePreparedRun } from '../src/orchestration/index.js';
import { toyPlan } from './helpers/orchestration-plan.js';
import { handleCommand, type CommandContext } from '../src/ui/commands.js';
let root:string, project:string, store:RunStore;
beforeEach(() => { root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-orch-cli-'))); project=join(root,'project'); fs.mkdirSync(project); store=new RunStore(join(root,'store')); config.resetConfig(); saveHooks([]); fs.writeFileSync(join(project,'plan.json'),JSON.stringify(toyPlan())); vi.stubGlobal('fetch',vi.fn(() => {throw new Error('No inference or discovery allowed');})); });
afterEach(() => {config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
const run = (...args:string[]) => orchestrationCommand('run',args,{cwd:project,store});
it('validates dry-run JSON without creating run state, contacting a provider or mutating the source', async () => {
  const before=fs.readFileSync(join(project,'plan.json'),'utf8'); const result=await run('plan.json','--dry-run','--json');
  expect(result).toMatchObject({exitCode:0,report:{version:1,type:'orchestration',action:'dry-run',localOnly:true,execution:'not-started',data:{approval:'not-requested',modelDiscovery:'not-checked',executedTasks:0,stages:[['inspect-a','inspect-b'],['verify']]}}});
  expect(fs.existsSync(store.root)).toBe(false); expect(fs.readFileSync(join(project,'plan.json'),'utf8')).toBe(before); expect(fetch).not.toHaveBeenCalled();
  expect(formatOrchestration(result.report)).toContain('4000 tokens');
  expect((await run('plan.json')).exitCode).toBe(2);
});
it('prepares, inspects, approves and cancels a durable run through the versioned command contract', async () => {
  const prepared=await run('prepare','plan.json'), id=(prepared.report.data as any).run.id;
  expect(prepared.exitCode).toBe(0); expect((await run('status',id)).report.data).toMatchObject({run:{id,status:'prepared',executedTasks:0}});
  expect((await run()).report.data).toMatchObject({runs:[{id}]}); expect((await run('status')).report.data).toMatchObject({run:{id}});
  const agents=await orchestrationCommand('agents',['--tree','--run',id],{cwd:project,store}); expect(formatOrchestration(agents.report)).toContain('└─ a');
  const tasks=await orchestrationCommand('tasks',['graph',id],{cwd:project,store}); expect(formatOrchestration(tasks.report)).toContain('depends on inspect-a, inspect-b');
  expect((await run('approve',id)).report.data).toMatchObject({run:{status:'approved',approval:'approved',executedTasks:0}});
  expect((await run('cancel',id)).report.data).toMatchObject({run:{status:'cancelled',approval:'revoked'}});
  const replay=await run('replay',id); expect((replay.report.data as any).events.map((event:any)=>event.change.type)).toEqual(['prepared','approved','cancelled']);
  expect(formatOrchestration(replay.report)).toContain('3.'); expect(fetch).not.toHaveBeenCalled();
});
it('enforces shared project policy and non-interactive permission defaults', async () => {
  config.set('policy',{command:'exit 17'}); expect((await run('prepare','plan.json')).exitCode).toBe(3); expect(fs.existsSync(store.root)).toBe(false);
  config.set('policy',{});
  expect((await orchestrationCommand('run',['prepare','plan.json'],{cwd:project,store,mode:'plan'})).exitCode).toBe(3);
  expect((await orchestrationCommand('run',['prepare','plan.json'],{cwd:project,store,confirmation:'mutating'})).exitCode).toBe(3);
  const prepared=await prepareRun(project,'plan.json',{store,confirmation:'mutating',approve:async()=> 'allow'});
  config.set('policy',{command:'exit 17'}); await expect(changePreparedRun(project,prepared.run.id,'approved',{store})).rejects.toThrow(/denied/);
  expect((await store.read(prepared.run.id,project)).run.status).toBe('prepared');
});
it('refuses dry-run executable policy/hooks before running their commands', async () => {
  const marker=join(project,'marker'), script=join(project,'policy.cjs'); fs.writeFileSync(script,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
  config.set('policy',{command:`'${process.execPath}' '${script}'`}); expect((await run('plan.json','--dry-run')).exitCode).toBe(3); expect(fs.existsSync(marker)).toBe(false);
  config.set('policy',{}); saveHooks([{id:'test',name:'test',event:'pre-tool',command:`'${process.execPath}' '${script}'`,enabled:true}]);
  expect((await run('plan.json','--dry-run')).exitCode).toBe(3); expect(fs.existsSync(marker)).toBe(false); expect(fs.existsSync(store.root)).toBe(false);
});
it('fails safely on malformed arguments, plans, source aliases and project escapes', async () => {
  for (const args of [['--unknown'],['prepare'],['prepare','plan.json','--dry-run'],['approve'],['list','extra'],['status','--run','id'],['--tree'],['bad\x00arg'],['x'.repeat(4097)]]) expect((await run(...args)).exitCode).toBe(2);
  for (const [namespace,args] of [['agents',['graph']],['agents',['--graph']],['tasks',['--dry-run']],['tasks',['graph','a','--run','b']],['agents',['tree','a','extra']]] as const) expect((await orchestrationCommand(namespace,[...args],{cwd:project,store})).exitCode).toBe(2);
  expect((await run('status')).exitCode).toBe(1); fs.writeFileSync(join(project,'plan.json'),'{'); expect((await run('prepare','plan.json')).exitCode).toBe(1); expect(fs.existsSync(store.root)).toBe(false);
  fs.writeFileSync(join(root,'outside.json'),JSON.stringify(toyPlan())); fs.symlinkSync(join(root,'outside.json'),join(project,'alias.json'));
  expect((await run('alias.json','--dry-run')).exitCode).toBe(1); expect((await run('../outside.json','--dry-run')).exitCode).toBe(1);
  expect((await run('missing.json','--dry-run')).exitCode).toBe(1);
});
it('keeps cancellation and JSON output stable in headless environments', async () => {
  const output:string[]=[]; expect(await runOrchestrationCommand('run',['plan.json','--dry-run','--json'],{cwd:project,store,write:text=>output.push(text)})).toBe(0);
  expect(output).toHaveLength(1); expect(JSON.parse(output[0]!)).toMatchObject({type:'orchestration',action:'dry-run'});
  const cancelled=await orchestrationCommand('run',['prepare','plan.json'],{cwd:project,store,signal:AbortSignal.abort()}); expect(cancelled).toMatchObject({exitCode:130,report:{error:{code:'cancelled'}}}); expect(fs.existsSync(store.root)).toBe(false);
  const text:string[]=[]; expect(await runOrchestrationCommand('run',['list'],{cwd:project,store,write:value=>text.push(value)})).toBe(0); expect(text[0]).toContain('No prepared runs');
});
it('supports REPL preparation and tree/status inspection, including quoted paths and uppercase roots', async () => {
  const path=join(project,'plan with spaces.json'); fs.writeFileSync(path,JSON.stringify(toyPlan())); const messages:string[]=[];
  const ctx={sessionRef:{current:{projectPath:project}},mode:'work',addMessage:(_:string,value:string)=>messages.push(value)} as unknown as CommandContext;
  await handleCommand('/RUN "plan with spaces.json" --dry-run',ctx); expect(messages.at(-1)).toContain('Plan toy-plan');
  await handleCommand('/run prepare "plan with spaces.json"',ctx); expect(messages.at(-1)).toContain('prepared');
  const id=/Run ([a-f0-9-]{36})/.exec(messages.at(-1)!)![1]!;
  await handleCommand(`/agents tree ${id}`,ctx); expect(messages.at(-1)).toContain('└─ a');
  await handleCommand(`/tasks graph ${id}`,ctx); expect(messages.at(-1)).toContain('Dependency stage 2');
  await handleCommand(`/run approve ${id}`,ctx); expect(messages.at(-1)).toContain('approval approved'); expect(fetch).not.toHaveBeenCalled();
});
it('parses quoted arguments literally and rejects incomplete or unbounded input', () => {
  expect(parseOrchestrationArgs('prepare "toy plan.json" --json')).toEqual(['prepare','toy plan.json','--json']);
  expect(parseOrchestrationArgs("'$(echo literal)' escaped\\ path")).toEqual(['$(echo literal)','escaped path']);
  expect(parseOrchestrationArgs("''")).toEqual(['']);
  for (const text of ['"unclosed','trailing\\','x'.repeat(32769),Array(130).fill('x').join(' ')]) expect(()=>parseOrchestrationArgs(text)).toThrow();
});
it('honors the option delimiter and accepts plan filenames that resemble options or commands', async () => {
  for (const name of ['--json','prepare']) fs.copyFileSync(join(project,'plan.json'),join(project,name));
  const output:string[]=[];
  expect(await runOrchestrationCommand('run',['--dry-run','--','--json'],{cwd:project,store,write:value=>output.push(value)})).toBe(0);
  expect(output[0]).toMatch(/^Orchestration dry-run/);
  output.length=0;
  expect(await runOrchestrationCommand('run',['--dry-run','--json','--','prepare'],{cwd:project,store,write:value=>output.push(value)})).toBe(0);
  expect(JSON.parse(output[0]!)).toMatchObject({action:'dry-run',data:{source:{path:'prepare'},executedTasks:0}});
  expect(fs.existsSync(store.root)).toBe(false); expect(fetch).not.toHaveBeenCalled();
});
