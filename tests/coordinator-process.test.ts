import {beforeAll,afterAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createServer,type Server} from 'node:http';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {ExecutionStore,changePreparedRun} from '../src/orchestration/index.js';
import {inspectSpawn,inspectSpawnAuthority} from '../src/spawning/index.js';

let build:string,root:string,server:Server|undefined,children:ChildProcess[];
// Compile today's source into an isolated package, so process tests never trust a stale dist/.
beforeAll(()=>{
  build=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-process-build-')));
  execFileSync(resolve('node_modules/.bin/tsc'),['--outDir',join(build,'dist'),'--incremental','false'],{cwd:process.cwd(),timeout:30000,stdio:'pipe'});
  fs.writeFileSync(join(build,'package.json'),'{"type":"module"}');fs.symlinkSync(resolve('node_modules'),join(build,'node_modules'),'junction');
},30000);
afterAll(()=>fs.rmSync(build,{recursive:true,force:true}));
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-coordinator-process-')));fs.chmodSync(root,0o700);children=[];for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of[names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}});
afterEach(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await stopped;}server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;config.resetConfig();saveHooks([]);vi.unstubAllEnvs();fs.rmSync(root,{recursive:true,force:true});});
function child(code:string,payload:unknown){
  const process=spawn(globalThis.process.execPath,['--input-type=module','-e',`const p=JSON.parse(process.argv[1]); const api=await import(process.argv[2]); ${code}`,JSON.stringify(payload),pathToFileURL(join(build,'dist/orchestration/index.js')).href],{env:{...globalThis.process.env},stdio:['ignore','pipe','pipe']});children.push(process);let output='',error='';process.stdout!.on('data',chunk=>{output+=chunk;});process.stderr!.on('data',chunk=>{error+=chunk;});const closed=new Promise<number|null>(resolve=>process.once('exit',resolve));return{process,closed,output:()=>output,error:()=>error};
}
it('excludes a second OS process and reclaims only an owner whose process has exited',async()=>{
  const {store,view,runs}=await coordinatorRun(root),payload={runDirectory:join(runs.root,view.run.id),manifest:view.manifest};
  const first=child(`const store=new api.ExecutionStore(p.runDirectory,p.manifest);store.acquire();process.stdout.write('owned');setInterval(()=>{},1000);`,payload);
  await vi.waitFor(()=>expect(first.output()).toBe('owned'),{timeout:5000});expect(()=>store.acquire()).toThrow(/owns/);
  const second=child(`try{new api.ExecutionStore(p.runDirectory,p.manifest).acquire();process.exitCode=9;}catch(e){process.stdout.write(e.code);}`,payload);expect(await second.closed).toBe(0);expect(second.output()).toBe('locked');
  first.process.kill('SIGKILL');await first.closed;expect(store.owner()?.alive).toBe(false);const lease=store.acquire();expect(store.owner()?.pid).toBe(process.pid);lease.release();
},15000);
it('cancels a running coordinator across processes, closes live HTTP requests and replays its final journal',async()=>{
  const p=verifiedPlan();p.limits.tokenBudget=30000;p.limits.costBudgetUsd=1;p.limits.timeBudgetMs=20000;for(const a of p.agents){a.tokenBudget=a.parentId?10000:30000;a.costBudgetUsd=a.parentId?0.2:1;a.timeBudgetMs=20000;a.preference={provider:'deepseek',model:'process-toy'};}
  const {project,runs,view}=await coordinatorRun(root,p);let calls=0,closed=0;
  server=createServer((req,res)=>{if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'process-toy',context_length:4096,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}]}));return;}if(req.url==='/v1/chat/completions'){calls++;res.on('close',()=>closed++);req.resume();return;}res.writeHead(404);res.end();});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:`http://127.0.0.1:${address.port}/v1`});config.set('routing',{enabled:true,providerPool:['deepseek']});
  const running=child(`process.exitCode=await api.runOrchestrationCommand('run',['resume',p.runId,'--allow-mutations','--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,{runId:view.run.id,project,runs:runs.root});
  await vi.waitFor(()=>expect(calls).toBe(2),{timeout:8000});expect(()=>new ExecutionStore(join(runs.root,view.run.id),view.manifest).acquire()).toThrow(/owns/);
  const cancellation=child(`process.exitCode=await api.runOrchestrationCommand('run',['cancel',p.runId,'--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,{runId:view.run.id,project,runs:runs.root});
  expect(await cancellation.closed).toBe(0);expect(JSON.parse(cancellation.output()).data.status).toBe('cancellation-requested');expect(await running.closed).toBe(130);
  await vi.waitFor(()=>expect(closed).toBe(2));expect(calls).toBe(2);const record=JSON.parse(running.output().trim().split('\n').at(-1)!);expect(record.data.status).toBe('cancelled');
  const store=new ExecutionStore(join(runs.root,view.run.id),view.manifest);expect(store.owner()).toBeNull();expect(store.read()).toEqual(record.data.execution);
},20000);
it('recovers a killed child admitter while another process coordinates the run, without duplicating budget or losing events',async()=>{
  const p=verifiedPlan();p.limits.maxConcurrent=3;p.limits.tokenBudget=40000;p.limits.costBudgetUsd=1;p.limits.timeBudgetMs=120000;
  for(const a of p.agents){a.tokenBudget=a.parentId?10000:40000;a.costBudgetUsd=a.parentId?0.2:1;a.timeBudgetMs=a.parentId?60000:120000;a.preference={provider:'deepseek',model:'process-toy'};}
  const r=await coordinatorRun(root,p),a=structuredClone(p.agents[1]!),task=structuredClone(p.tasks[0]!);a.id='c';a.allowedPaths=[{path:'c',access:'write'}];task.id='inspect-c';task.agentId='c';task.outputs[0]!.id='report-c';task.outputs[0]!.path='c/report.txt';task.acceptanceChecks![0]!.artifactId='report-c';fs.mkdirSync(join(r.project,'c'));fs.writeFileSync(join(r.project,'children.json'),JSON.stringify({version:1,parentId:'coordinator',agents:[a],tasks:[task]}));
  const held:(()=>void)[]=[];let calls=0;
  server=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'process-toy',context_length:4096,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}]}));return;}
    if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{calls++;const body=JSON.parse(raw),task=JSON.parse(body.messages.find((m:any)=>m.role==='user'&&m.content.startsWith('{')).content).task,first=!body.messages.some((m:any)=>m.role==='tool');
      const reply=()=>res.end(JSON.stringify({id:'toy',object:'chat.completion',model:'process-toy',choices:[{index:0,message:{role:'assistant',content:'public toy evidence',...(first?{tool_calls:[{id:'call-'+task.id,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:task.outputs[0].path,content:'public toy evidence'})}}]}:{})},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}));
      if(first&&['inspect-a','inspect-b'].includes(task.id))held.push(reply);else{reply();if(task.id==='inspect-c'&&!first)for(const release of held.splice(0))release();}
    });
  });await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`});config.set('routing',{enabled:true,providerPool:['deepseek']});
  const payload={runId:r.view.run.id,project:r.project,runs:r.runs.root},running=child(`process.exitCode=await api.runOrchestrationCommand('run',['resume',p.runId,'--allow-mutations','--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,payload);
  await vi.waitFor(()=>expect(held.length).toBe(2),{timeout:10000});const preview=await inspectSpawn(r.project,r.view.run.id,'children.json',{store:r.runs});
  const interrupted=child(`const fs=(await import('node:fs')).default;const {syncBuiltinESMExports}=await import('node:module');const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(String(to).endsWith('/budget/history.json'))process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();process.exitCode=await api.runOrchestrationCommand('agents',['spawn','children.json','--run',p.runId,'--approve',p.hash,'--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,{...payload,hash:preview.proposal.hash});
  await interrupted.closed;expect(interrupted.process.signalCode).toBe('SIGKILL');const budget=r.authority.ledger.read(r.project);expect(budget.projection.childGrants).toHaveLength(1);expect(inspectSpawnAuthority(r.store,r.authority.ledger).pending).toHaveLength(1);expect(r.store.read().state.tasks['inspect-c']).toBeUndefined();
  const recovered=child(`process.exitCode=await api.runOrchestrationCommand('agents',['spawn','--resume',p.hash,'--run',p.runId,'--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,{...payload,hash:preview.proposal.hash});
  expect(await recovered.closed).toBe(0);expect(await running.closed).toBe(0);expect(calls).toBe(8);const result=JSON.parse(recovered.output().trim().split('\n').at(-1)!);expect(result.data.status).toBe('completed');expect(result.data.execution.state.tasks['inspect-c'].output.testEvidence).toEqual(['output-check']);
  const records=running.output().trim().split('\n').map(line=>JSON.parse(line)),events=records.filter(r=>r.type==='orchestration.event').map(r=>r.event);expect(events).toEqual(r.store.read().events);expect(events.filter(e=>e.change.type==='graph_admitted')).toHaveLength(1);expect(r.authority.ledger.read(r.project).projection.childGrants).toEqual(budget.projection.childGrants);expect(r.store.read().header.deadline).toBe(preview.deadline);
},30000);
