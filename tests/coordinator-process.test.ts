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
import {ExecutionStore,changePreparedRun,recoverInterruptedExecution} from '../src/orchestration/index.js';
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
it.each(['answer','crash'])('recovers a question across processes and handles %s without replaying its earlier write',async mode=>{
  const p=verifiedPlan();p.tasks=p.tasks.slice(0,1);p.agents=p.agents.slice(0,2);p.workspace.allowedTools.push('ask_question');
  p.limits.tokenBudget=30000;p.limits.costBudgetUsd=1;p.limits.timeBudgetMs=60000;
  for(const a of p.agents){a.allowedTools.push('ask_question');a.tokenBudget=a.parentId?15000:30000;a.costBudgetUsd=a.parentId?0.5:1;a.timeBudgetMs=60000;a.preference={provider:'deepseek',model:'question-process-toy'};}
  const r=await coordinatorRun(root,p);let calls=0;
  server=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'question-process-toy',context_length:8192,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}]}));return;}
    if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
      calls++;const body=JSON.parse(raw),wrote=body.messages.some((m:any)=>m.role==='tool'&&m.tool_call_id==='write'),answered=body.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id==='audience');
      if(answered)expect(answered.content).toBe('Operators');
      const call=!wrote?{id:'write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'a/report.txt',content:'public toy evidence'})}}:!answered?{id:'audience',type:'function',function:{name:'ask_question',arguments:JSON.stringify({question:'Which audience?',options:['Engineers','Operators']})}}:null;
      res.end(JSON.stringify({id:'toy',object:'chat.completion',model:'question-process-toy',choices:[{index:0,message:{role:'assistant',content:'public toy evidence',...(call?{tool_calls:[call]}:{})},finish_reason:call?'tool_calls':'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}));
    });
  });
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`});config.set('routing',{enabled:true,providerPool:['deepseek']});
  const payload={project:r.project,runId:r.view.run.id,runs:r.runs.root};
  const running=child(`process.exitCode=await api.runOrchestrationCommand('run',['resume',p.runId,'--allow-mutations','--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,payload);
  await vi.waitFor(()=>expect(Object.values(r.store.read().state.questions??{}).some(q=>q.status==='pending')).toBe(true),{timeout:12000});
  const before=r.store.read(),q=Object.values(before.state.questions!)[0]!,written=fs.statSync(join(r.project,'a/report.txt')).mtimeMs;
  expect(calls).toBe(2);expect(r.store.owner()?.pid).toBe(running.process.pid);
  if(mode==='crash'){running.process.kill('SIGKILL');await running.closed;expect(r.store.owner()?.alive).toBe(false);}
  const reloaded=child(`process.exitCode=await api.runOrchestrationCommand('run',['status',p.runId,'--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,payload);
  expect(await reloaded.closed).toBe(0);const inspected=JSON.parse(reloaded.output()).data;
  expect(inspected.execution.state.questions[q.id]).toEqual(q);expect(inspected.interrupted).toBe(mode==='crash');
  const answer=child(`process.exitCode=await api.runOrchestrationCommand('run',['answer',p.runId,p.id,'--revision',p.revision,'--answer','Operators','--allow-mutations','--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,{...payload,id:q.id,revision:before.state.revision});
  expect(await answer.closed,answer.output()+answer.error()).toBe(mode==='crash'?1:0);
  if(mode==='answer'){
    expect(await running.closed,running.error()+running.output()).toBe(0);
    const result=r.store.read();expect(result.state.status).toBe('completed');expect(result.header).toEqual(before.header);
    expect(result.state.tasks['inspect-a']).toMatchObject({attempts:1,sessionId:q.sessionId});
    expect(result.state.questions![q.id]).toMatchObject({status:'answered',answer:'Operators'});expect(calls).toBe(3);
    expect(result.events.filter(e=>e.change.type==='tool'&&e.change.stage==='started'&&e.change.name==='write_file')).toHaveLength(1);
  }else{expect(r.store.read()).toEqual(before);expect(calls).toBe(2);}
  expect(fs.statSync(join(r.project,'a/report.txt')).mtimeMs).toBe(written);
},30000);
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

it.each(['recover','cli','denied','stale','revoked','changed'])('records a dead coordinator without inference or budget changes: %s',async mode=>{
  const r=await coordinatorRun(root),payload={runDirectory:join(r.runs.root,r.view.run.id),manifest:r.view.manifest};
  const running=child(`const store=new api.ExecutionStore(p.runDirectory,p.manifest),lease=store.acquire();await store.append({type:'started',ownerId:lease.id});await store.append({type:'task_started',taskId:'inspect-a',attempt:1,sessionId:'interrupted-worker'});await store.append({type:'tool',taskId:'inspect-a',callId:'write',name:'write_file',path:'a/report.txt',stage:'started',mutating:true,success:false});process.stdout.write('interrupted');setInterval(()=>{},1000);`,payload);
  await vi.waitFor(()=>expect(running.output()).toBe('interrupted'),{timeout:5000});
  const initial=r.store.read(),budget=fs.readFileSync(join(r.authority.ledger.root,'history.json'));
  await expect(recoverInterruptedExecution(r.project,r.view.run.id,initial.state.revision,{store:r.runs})).rejects.toThrow(/dead/);
  running.process.kill('SIGKILL');await running.closed;expect(r.store.owner()?.alive).toBe(false);
  if(mode==='revoked')await changePreparedRun(r.project,r.view.run.id,'cancelled',{store:r.runs});
  const options={store:r.runs,confirmation:'mutating' as const,approve:async()=>{
    if(mode==='changed')await r.store.append({type:'agent_stop',agentId:'a'});
    return mode==='denied'?'deny' as const:'allow' as const;
  }};
  if(!['recover','cli'].includes(mode)){
    await expect(recoverInterruptedExecution(r.project,r.view.run.id,mode==='stale'?'a'.repeat(64):initial.state.revision,options)).rejects.toThrow();
    const after=r.store.read();if(mode==='changed')expect(after.state.stoppedAgents).toContain('a');expect(after.events.filter(e=>e.change.type==='interruption_recovered')).toHaveLength(0);expect(after.state.tasks['inspect-a']).toMatchObject({status:'running',attempts:1,mutations:true});
  }else{
    if(mode==='cli'){
      const recovered=child(`process.exitCode=await api.runOrchestrationCommand('run',['recover-interruption',p.runId,'--revision',p.revision,'--allow-mutations','--json'],{cwd:p.project,store:new api.RunStore(p.runs)});`,{runId:r.view.run.id,project:r.project,runs:r.runs.root,revision:initial.state.revision});
      expect(await recovered.closed,recovered.output()+recovered.error()).toBe(0);
    }else await recoverInterruptedExecution(r.project,r.view.run.id,initial.state.revision,options);
    const after=r.store.read();
    expect(after.header).toEqual(initial.header);expect(after.events.slice(0,-1)).toEqual(initial.events);
    expect(after.events.at(-1)).toMatchObject({version:10,change:{type:'interruption_recovered',ownerId:initial.state.ownerId,source:'cli'}});
    expect(after.state).toMatchObject({status:'failed',ownerId:null,tasks:{'inspect-a':{status:'unknown',attempts:1,sessionId:'interrupted-worker',mutations:true,output:null},'inspect-b':{status:'pending',attempts:0}}});
    expect(r.store.owner()).toBeNull();await expect(recoverInterruptedExecution(r.project,r.view.run.id,initial.state.revision,options)).rejects.toThrow(/dead/);
    expect(r.store.read()).toEqual(after);
  }
  expect(fs.readFileSync(join(r.authority.ledger.root,'history.json'))).toEqual(budget);
},15000);
