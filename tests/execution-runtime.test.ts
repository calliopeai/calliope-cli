/** Real runtime, live-discovery parser, permission boundary and SDK over a toy transport. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {clearModelCache} from '../src/model-detection.js';
import {runTurn,type TurnOptions} from '../src/runtime/index.js';
import {getTools} from '../src/tools.js';
import {RunLog,readRunLog,verifyChain} from '../src/runlog.js';
import {ReservationLedger,manifestHash,type ExecutionManifest} from '../src/execution/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
import {saveHooks} from '../src/hooks.js';
import {loadProjectSpend,projectBudgetPath} from '../src/budget.js';
let root:string,project:string,manifest:ExecutionManifest,ledger:ReservationLedger,requests:any[],respond:(request:any,signal:AbortSignal)=>Promise<Response>,metadata:any;
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const completion=(tool?:{name:string;args:unknown},usage:unknown={prompt_tokens:7,completion_tokens:3,total_tokens:10})=>json({id:'toy',object:'chat.completion',model:'toy',choices:[{index:0,message:{role:'assistant',content:tool?'Working.':'Done.',...(tool?{tool_calls:[{id:'call',type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{})},finish_reason:tool?'tool_calls':'stop'}],...(usage?{usage}:{})});
beforeEach(()=>{
  config.resetConfig();saveHooks([]);clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-agent-runtime-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.writeFileSync(join(project,'a/toy.txt'),'public toy');manifest=executionManifest(project);ledger=new ReservationLedger(join(root,'budget'));requests=[];
  for(const provider of config.getProviderNames()){const env=config.getProviderEnvVars(provider);for(const name of [env.apiKey,env.baseUrl])if(name)vi.stubEnv(name,'');}
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://execution.invalid/v1'});
  metadata={id:'toy',context_length:900,max_output_tokens:100,pricing:{input:1,output:2},capabilities:{chat:true,tools:true,streaming:true}};
  respond=async()=>completion();vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
    const req=new Request(input,init);if(new URL(req.url).pathname==='/v1/models')return json({data:[metadata]});
    // Observe the SDK's actual transport signal, not a cloned Request's derived signal.
    expect(req.url).toBe('https://execution.invalid/v1/chat/completions');const body=await req.json();requests.push(body);return respond(body,init?.signal??req.signal);
  }));
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
const options=(extra:Partial<TurnOptions>={}):TurnOptions=>({cwd:project,provider:'deepseek',model:'toy',sessionId:randomUUID(),prompt:'Use the public toy file.',messages:{current:[{role:'user',content:'Use the public toy file.'}]},confirmation:'none',maxIterations:3,tools:()=>[],runlog:RunLog.open(randomUUID(),{enabled:false}),execution:{ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100},...extra});
it('executes a bounded request using live metadata and records reservation/usage evidence',async()=>{
  ledger.create(manifest);const sessionId=randomUUID(),log=RunLog.open(sessionId,{dir:join(root,'audit')}),result=await runTurn(options({sessionId,runlog:log}));
  expect(result.reason).toBe('completed');expect(result.totals.inputTokens).toBe(7);expect(requests).toHaveLength(1);expect(requests[0].max_tokens).toBe(100);
  const saved=ledger.read(project);expect(saved.projection.spent).toEqual({tokens:10,costNanos:13000});expect(saved.events.map(e=>e.change.type)).toEqual(['reserve','settle']);
  expect(JSON.stringify(saved.events)).not.toContain('Use the public toy');
  const trace=readRunLog(log.filePath);expect(verifyChain(trace).ok).toBe(true);expect(trace.some(e=>e.type==='policy_event'&&JSON.stringify(e).includes('execution-budget'))).toBe(true);
});
it('prevents simultaneous turns from spending the same remaining capacity',async()=>{
  manifest.accounts[1]!.tokenBudget=1000;ledger.create(manifest);let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});respond=async()=>{await held;return completion();};
  const work=[runTurn(options()),runTurn(options())];const denied=await Promise.race(work);expect(denied.reason).toBe('budget');expect(requests).toHaveLength(1);release();
  const outcomes=await Promise.all(work);expect(outcomes.filter(o=>o.reason==='completed')).toHaveLength(1);expect(ledger.read(project).projection.spent.tokens).toBe(10);
});
it.each(['price','capacity','incompatible'] as const)('does not dispatch with missing or incompatible %s evidence',async kind=>{
  if(kind==='price')delete metadata.pricing;if(kind==='capacity')delete metadata.context_length;if(kind==='incompatible')metadata.capabilities.chat=false;
  ledger.create(manifest);if(kind==='incompatible')await expect(runTurn(options())).rejects.toThrow();else expect((await runTurn(options())).reason).toBe('budget');expect(requests).toHaveLength(0);expect(ledger.read(project).events).toHaveLength(0);
});
it('retains missing usage and rejects malformed usage without returning budget to later turns',async()=>{
  ledger.create(manifest);respond=async()=>completion(undefined,null);await runTurn(options());expect(ledger.read(project).projection.spent.tokens).toBe(1000);
  respond=async()=>completion(undefined,{prompt_tokens:-1,completion_tokens:3});expect((await runTurn(options())).reason).toBe('budget');expect(ledger.read(project).projection.exceeded).toBe(true);
  expect((await runTurn(options())).reason).toBe('budget');expect(requests).toHaveLength(2);
});
it('enforces generated tool authority and safe non-interactive mutation defaults',async()=>{
  ledger.create(manifest);respond=async()=>requests.length===1?completion({name:'write_file',args:{path:'a/denied.txt',content:'no'}}):completion();
  const denied:any[]=[];await runTurn(options({tools:getTools,onToolResult:(_call,result)=>{denied.push(result);}}));expect(denied[0].isError).toBe(true);expect(fs.existsSync(join(project,'a/denied.txt'))).toBe(false);
  requests=[];respond=async()=>requests.length===1?completion({name:'write_file',args:{path:'b/outside.txt',content:'no'}}):completion();const approve=vi.fn(async()=> 'allow' as const);
  await runTurn(options({tools:getTools,approve}));expect(approve).not.toHaveBeenCalled();expect(fs.existsSync(join(project,'b/outside.txt'))).toBe(false);
});
it('allows an explicitly approved scoped mutation and rejects undeclared tool schemas',async()=>{
  ledger.create(manifest);respond=async request=>{expect(request.tools.every((t:any)=>!['shell','web_fetch','configure'].includes(t.function.name))).toBe(true);return requests.length===1?completion({name:'write_file',args:{path:'a/new.txt',content:'approved'}}):completion();};
  const approve=vi.fn(async()=> 'allow' as const);const result=await runTurn(options({tools:getTools,approve}));expect(result.reason).toBe('completed');expect(approve).toHaveBeenCalledTimes(1);expect(fs.readFileSync(join(project,'a/new.txt'),'utf8')).toBe('approved');
});
it('propagates cancellation and deadline expiry to HTTP while retaining pending spend',async()=>{
  // Advance the original clock only after HTTP dispatch; host load must not turn
  // this transport-cancellation test into an admission-before-deadline race.
  vi.useFakeTimers({now:Date.now()-10000,toFake:['Date','setTimeout','clearTimeout']});
  try {
  // The ledger captures Date.now at construction; bind it to the runtime clock.
  // Offset fake time above so accidentally retaining the real clock fails reliably.
  ledger=new ReservationLedger(join(root,'budget'));
  manifest.createdAt=Date.now();manifest.deadline=manifest.createdAt+500;for(const a of manifest.accounts)a.deadline=manifest.deadline;ledger.create(manifest);
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});let transportSignal:AbortSignal;
  respond=async(_request,signal)=>{transportSignal=signal;started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const running=runTurn(options());expect(await Promise.race([ready.then(()=> 'dispatched'),running.then(result=>result.reason)])).toBe('dispatched');await vi.advanceTimersByTimeAsync(501);const result=await running;expect(result.reason).toBe('cancelled');expect(transportSignal!.aborted).toBe(true);expect(requests).toHaveLength(1);expect(ledger.read(project).projection.spent.tokens).toBe(1000);
  }finally{vi.useRealTimers();}
});
it.each(['ordinary','child'] as const)('shares project reservations between an active agent and a competing %s run',async kind=>{
  config.set('budget',{maxCostPerProject:0.0011});ledger.create(manifest);let started!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});respond=async()=>{started();await held;return completion();};
  const running=runTurn(options());await ready;expect(loadProjectSpend(project).spentUsd).toBe(0.0011);
  const secondManifest={...manifest,runId:randomUUID()},second=new ReservationLedger(join(root,'other-budget'));second.create(secondManifest);
  const competitor=await runTurn(options({execution:kind==='ordinary'?undefined:{ledger:second,manifestHash:manifestHash(secondManifest),agentId:'a',maxOutputTokens:100}}));
  expect(competitor.reason).toBe('budget');expect(competitor.budget?.message).toMatch(/cap|budget/i);expect(requests).toHaveLength(1);
  release();expect((await running).reason).toBe('completed');expect(loadProjectSpend(project).spentUsd).toBe(0.000013);
});
it('enforces configured run caps before dispatch and rechecks tightened policy before a file mutation',async()=>{
  ledger.create(manifest);config.set('budget',{maxTokensPerRun:999});expect((await runTurn(options())).reason).toBe('budget');expect(requests).toHaveLength(0);expect(loadProjectSpend(project).spentUsd).toBe(0);
  config.set('budget',{});respond=async()=>completion({name:'write_file',args:{path:'a/policy.txt',content:'no'}});
  const result=await runTurn(options({tools:getTools,approve:async()=>{config.set('budget',{maxTokensPerRun:1});return 'allow';}}));
  expect(result.reason).toBe('budget');expect(fs.existsSync(join(project,'a/policy.txt'))).toBe(false);expect(requests).toHaveLength(1);
});
it('reserves ordinary project-capped turns, preserves unknown usage and freezes on an overrun',async()=>{
  config.set('budget',{maxCostPerProject:0.01});const ordinary=()=>options({execution:undefined});
  expect((await runTurn(ordinary())).reason).toBe('completed');expect(loadProjectSpend(project).spentUsd).toBe(0.000013);
  respond=async()=>completion(undefined,null);expect((await runTurn(ordinary())).reason).toBe('completed');expect(loadProjectSpend(project).spentUsd).toBe(0.001113);
  respond=async()=>completion(undefined,{prompt_tokens:901,completion_tokens:0});expect((await runTurn(ordinary())).reason).toBe('budget');
  expect(loadProjectSpend(project).spentUsd).toBe(0.002213);expect((await runTurn(ordinary())).reason).toBe('budget');expect(requests).toHaveLength(3);
});
it('waits for asynchronous post-tool hooks and cancels their process when an agent deadline expires',async()=>{
  manifest.deadline=manifest.createdAt+500;for(const a of manifest.accounts)a.deadline=manifest.deadline;ledger.create(manifest);
  const script=join(project,'hook.cjs'),marker=join(project,'hook-started');fs.writeFileSync(script,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},60000);`);
  saveHooks([{id:'bounded-post',name:'bounded-post',event:'post-tool',enabled:true,async:true,command:`'${process.execPath}' '${script}'`}]);
  respond=async()=>completion({name:'read_file',args:{path:'a/toy.txt'}});const result=await runTurn(options({tools:getTools}));expect(result.reason).toBe('cancelled');expect(fs.existsSync(marker)).toBe(true);expect(requests).toHaveLength(1);
});
