import {beforeAll,afterAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createServer,type Server} from 'node:http';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {GoalStore,newGoalManifest} from '../src/goals/index.js';
import {ReservationLedger} from '../src/execution/index.js';
let build:string,root:string,project:string,goals:GoalStore,id:string,server:Server|undefined,children:ChildProcess[];
beforeAll(()=>{build=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-goal-build-')));execFileSync(resolve('node_modules/.bin/tsc'),['--outDir',join(build,'dist'),'--incremental','false'],{timeout:30000,stdio:'pipe'});fs.writeFileSync(join(build,'package.json'),'{"type":"module"}');fs.symlinkSync(resolve('node_modules'),join(build,'node_modules'),'junction');},30000);
afterAll(()=>fs.rmSync(build,{recursive:true,force:true}));
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-goal-process-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);goals=new GoalStore(join(root,'goals'));children=[];for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of[names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}const manifest=newGoalManifest(project,'Inspect public toy evidence.',join(root,'runs'),{preference:{provider:'deepseek',model:'process-toy'},limits:{tokenBudget:30000,planningTokens:10000,planningCostNanos:10000000,timeBudgetMs:60000,planningTimeMs:30000,maxOutputTokens:100}});goals.create(manifest);id=manifest.id;});
afterEach(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await stopped;}server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;config.resetConfig();saveHooks([]);vi.unstubAllEnvs();fs.rmSync(root,{recursive:true,force:true});});
function child(code:string){const proc=spawn(process.execPath,['--input-type=module','-e',`const p=JSON.parse(process.argv[1]),api=await import(process.argv[2]);${code}`,JSON.stringify({project,root:goals.root,id}),pathToFileURL(join(build,'dist/goals/index.js')).href],{env:{...process.env},stdio:['ignore','pipe','pipe']});children.push(proc);let output='',error='';proc.stdout!.on('data',chunk=>{output+=chunk;});proc.stderr!.on('data',chunk=>{error+=chunk;});const closed=new Promise<number|null>(resolve=>proc.once('exit',resolve));return{proc,closed,output:()=>output,error:()=>error};}
it('excludes a second goal owner and recovers the original identity after its OS process exits',async()=>{
  const owner=child(`new api.GoalStore(p.root).acquire(p.id);process.stdout.write('owned');setInterval(()=>{},1000);`);await vi.waitFor(()=>expect(owner.output()).toBe('owned'),{timeout:5000});expect(()=>goals.acquire(id)).toThrow(/owns/);
  owner.proc.kill('SIGKILL');await owner.closed;expect(goals.owner(id)?.alive).toBe(false);const lease=goals.acquire(id);expect(goals.owner(id)?.pid).toBe(process.pid);lease.release();expect(goals.read(id).manifest.id).toBe(id);
},10000);
it('cancels an actual HTTP planner from another process and replays its retained reservation without another request',async()=>{
  let calls=0,closed=0;server=createServer((req,res)=>{if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'process-toy',context_length:4096,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}}]}));return;}if(req.url==='/v1/chat/completions'){calls++;res.on('close',()=>closed++);req.resume();return;}res.writeHead(404);res.end();});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`});config.set('routing',{enabled:true,providerPool:['deepseek']});
  const running=child(`process.exitCode=await api.runGoalCommand(['resume',p.id,'--json'],{cwd:p.project,goals:new api.GoalStore(p.root)});`);await vi.waitFor(()=>expect(calls).toBe(1),{timeout:8000});expect(goals.owner(id)?.alive).toBe(true);
  const second=child(`process.exitCode=await api.runGoalCommand(['resume',p.id,'--json'],{cwd:p.project,goals:new api.GoalStore(p.root)});`);expect(await second.closed,second.error()).toBe(1);expect(JSON.parse(second.output()).error.code).toBe('locked');
  const cancellation=child(`process.exitCode=await api.runGoalCommand(['cancel',p.id,'--json'],{cwd:p.project,goals:new api.GoalStore(p.root)});`);expect(await cancellation.closed,cancellation.error()).toBe(0);expect(JSON.parse(cancellation.output().trim().split('\n').at(-1)!).data.status).toBe('cancellation-requested');expect(await running.closed,running.error()).toBe(130);
  await vi.waitFor(()=>expect(closed).toBe(1));const saved=goals.read(id);expect(saved.state).toMatchObject({revoked:true,planningFrozen:true,planningSpend:{tokens:4196}});expect(goals.owner(id)).toBeNull();
  const ledger=new ReservationLedger(join(saved.manifest.runsRoot,saved.state.planning!.runId,'budget')).read(project);expect(ledger.manifest.createdAt).toBe(Date.parse(saved.manifest.createdAt));expect(ledger.projection.spent.tokens).toBe(4196);
  const replay=child(`process.exitCode=await api.runGoalCommand(['replay',p.id,'--json'],{cwd:p.project,goals:new api.GoalStore(p.root)});`);expect(await replay.closed).toBe(0);expect(JSON.parse(replay.output()).data.goal.events).toEqual(saved.events);expect(calls).toBe(1);
},20000);
