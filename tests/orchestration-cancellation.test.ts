/** Real permission processes: cancelling preparation must stop the process, not just its promise. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import { saveHooks, executeHooks } from '../src/hooks.js';
import { evaluatePolicy } from '../src/policy.js';
import { RunStore, orchestrationCommand } from '../src/orchestration/index.js';
import { toyPlan } from './helpers/orchestration-plan.js';
let root:string, project:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=realpathSync(mkdtempSync(join(tmpdir(),'calliope-permission-cancel-')));project=join(root,'project');mkdirSync(project);writeFileSync(join(project,'plan.json'),JSON.stringify(toyPlan()));});
afterEach(()=>{config.resetConfig();saveHooks([]);rmSync(root,{recursive:true,force:true});});
it.skipIf(process.platform === 'win32').each(['policy','hook'] as const)('stops a SIGTERM-ignoring %s process before cancelled preparation returns',async kind=>{
  const ready=join(project,'ready'), forbidden=join(project,'late-mutation'), script=join(project,'permission.cjs');
  writeFileSync(script,`const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000); setTimeout(()=>fs.writeFileSync(${JSON.stringify(forbidden)},'must not run'),5000);`);
  const command=`'${process.execPath}' '${script}'`;
  if(kind==='policy')config.set('policy',{command,timeoutMs:10000});else saveHooks([{id:'bounded',name:'bounded',event:'pre-tool',command,enabled:true,async:true,timeout:10000}]);
  const controller=new AbortController(), store=new RunStore(join(root,'store'));
  const pending=orchestrationCommand('run',['prepare','plan.json','--json'],{cwd:project,store,signal:controller.signal});
  try {
    await vi.waitFor(()=>expect(existsSync(ready)).toBe(true),{timeout:3000}); const pid=Number(readFileSync(ready,'utf8')); controller.abort();
    expect(await pending).toMatchObject({exitCode:130,report:{error:{code:'cancelled'}}});
    await vi.waitFor(()=>{let status='';try{status=execFileSync('ps',['-o','stat=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* Reaped. */} expect(status === '' || status.startsWith('Z')).toBe(true);},{timeout:2000});
    expect(existsSync(forbidden)).toBe(false); expect(existsSync(store.root)).toBe(false);
  } finally {controller.abort();await pending;}
},10000);
it('honors an already-cancelled signal without running a policy or hook',async()=>{
  const marker=join(project,'marker'), command=`touch '${marker}'`;
  expect(await evaluatePolicy({id:'read',name:'read_file',arguments:{path:'plan.json'}},{command,signal:AbortSignal.abort()})).toMatchObject({decision:'deny',reason:expect.stringContaining('cancelled')});
  saveHooks([{id:'skip',name:'skip',event:'pre-tool',command,enabled:true,async:false}]);
  await expect(executeHooks('pre-tool',{}, {signal:AbortSignal.abort()})).rejects.toMatchObject({name:'AbortError'}); expect(existsSync(marker)).toBe(false);
});
