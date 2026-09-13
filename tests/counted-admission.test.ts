/** Real SDK serialization, durable ledgers and runtime boundaries; only HTTP is synthetic. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {providerTarget} from '../src/health/index.js';
import {chat} from '../src/providers/index.js';
import {countAnthropicInput,chatAnthropic} from '../src/providers/anthropic.js';
import {providerQuote,readBillingEvidence,validateBillingProfile,validateInputCount,validateQuoteEvidence,billingFile,ExecutionGuard,ReservationLedger,manifestHash,projectAttemptBudget,type BillingProfile,type InputCount} from '../src/execution/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
import {projectBudgetPath,loadProjectSpend} from '../src/budget.js';
import {runTurn} from '../src/runtime/index.js';
import {RunLog} from '../src/runlog.js';
import {clearModelCache,getAvailableModels} from '../src/model-detection.js';
import {syntheticWire,wireResponse} from './helpers/provider-wire.js';
import type {RouteCandidate} from '../src/routing/index.js';
import type {Message,Tool} from '../src/types.js';
import {GoalStore,runGoalCommand} from '../src/goals/index.js';
import {RunStore} from '../src/orchestration/index.js';
import {PROVIDER_REFUSAL_MESSAGE} from '../src/errors.js';
let root:string,project:string,file:string,profile:BillingProfile,route:RouteCandidate,requests:{path:string;body:any}[],respond:(path:string,body:any,signal:AbortSignal)=>Promise<Response>;
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
const messages:Message[]=[{role:'system',content:'Public root instructions'},{role:'user',content:'Echo hello'},{role:'assistant',content:'',toolCalls:[{id:'call_1',name:'echo',arguments:{text:'hello'}}]},{role:'tool',toolCallId:'call_1',content:'hello'},{role:'system',content:'Public trailing instruction'}];
const tools:Tool[]=[{name:'echo',description:'Echo text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}];
const writeProfile=()=>fs.writeFileSync(file,JSON.stringify({version:1,profiles:[profile]}),{mode:0o600});
const count=():InputCount=>({version:1,method:'anthropic-count-tokens',requestHash:'b'.repeat(64),inputTokens:7,at:Date.now()});
beforeEach(()=>{
  config.resetConfig();clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-counted-')));project=join(root,'project');fs.mkdirSync(project);file=join(root,'billing.json');vi.stubEnv('CALLIOPE_BILLING_FILE',file);
  for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL'])vi.stubEnv(name,'');
  config.setProviderCred('anthropic',{apiKey:'synthetic',baseUrl:'https://count.invalid/v1'});
  route={provider:'anthropic',model:'claude-test-model',target:providerTarget('anthropic').key,evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true},contextLength:1000000,maxOutputTokens:8192,price:null,estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'live fixture'};
  profile={provider:'anthropic',model:'claude-test-model',target:route.target,checkedAt:Date.now(),expiresAt:Date.now()+60000,sources:['https://example.invalid/prices'],prices:{input:2,output:5},capabilities:{tools:true,streaming:true},admission:'provider-count-v1'};writeProfile();requests=[];
  respond=async(path,body)=>{if(path.endsWith('/count_tokens'))return json({input_tokens:7});if(path.endsWith('/models'))return json({data:[{id:route.model,max_input_tokens:1000000,max_tokens:8192}],has_more:false});const wire=syntheticWire('anthropic','text',!!body.stream);return wireResponse(wire.body,wire.type);};
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{const request=new Request(input,init),path=new URL(request.url).pathname,body=request.method==='POST'?await request.json():undefined;requests.push({path,body});return respond(path,body,init?.signal??request.signal);}));
});
afterEach(()=>{config.resetConfig();clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
function guard(){const manifest=executionManifest(project),ledger=new ReservationLedger(join(root,'ledger'));ledger.create(manifest);return {ledger,manifest,execution:new ExecutionGuard({ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100},project)};}
it('uses explicit evidence without replacing discovery, with bounded estimate headroom and conservative unit prices',()=>{
  const evidence=readBillingEvidence(route,project)!;
  expect(providerQuote(route,messages,tools,true,100,evidence,count())).toMatchObject({inputTokens:1038,outputTokens:100,inputPrice:2,outputPrice:5,quoteEvidence:{profileHash:evidence.hash,multiplier:2,slackTokens:1024}});
  expect(providerQuote({...route,price:{input:3,output:7}},[],[],false,100,evidence,count())).toMatchObject({inputPrice:3,outputPrice:7});
  expect(providerQuote({...route,contextLength:100},[],[],false,100,evidence,{...count(),inputTokens:80}).inputTokens).toBe(100);
  for(const patch of [{capabilities:{chat:true,tools:false}},{capabilities:{chat:true,streaming:false}},{evidence:'emergency'},{discoveredAt:new Date(Date.now()-300001).toISOString()}])expect(()=>providerQuote({...route,...patch} as RouteCandidate,messages,tools,true,100,evidence,count())).toThrow();
  for(const c of [{...count(),inputTokens:1000001},{...count(),at:Date.now()-60001},{...count(),at:Date.now()+2000}])expect(()=>providerQuote(route,[],[],false,100,evidence,c)).toThrow();
  expect(()=>providerQuote({...route,price:{input:2,output:5}},[],[],false,100,undefined,count())).toThrow();
  expect(()=>providerQuote(route,[],[],false,100,{...evidence,hash:'a'.repeat(64)},count())).toThrow();
  expect(()=>providerQuote(route,[],[],false,100,{...evidence,profile:{...profile,model:'other'}},count())).toThrow();
  expect(providerQuote(route,[],[],false,100,evidence).inputTokens).toBe(1000000);
  fs.unlinkSync(file);expect(readBillingEvidence(route,project)).toBeUndefined();expect(readBillingEvidence(undefined,project)).toBeUndefined();
});
it('rejects malformed, future, expired, ambiguous and unsafe local policy without exposing its bytes',()=>{
  expect(billingFile()).toBe(file);vi.stubEnv('CALLIOPE_BILLING_FILE','');expect(billingFile()).toMatch(/\.calliope-cli\/billing.json$/);vi.stubEnv('CALLIOPE_BILLING_FILE',file);
  for(const patch of [{provider:'openai'},{admission:'other'},{model:'bad\nmodel'},{target:'bad'},{checkedAt:-1},{expiresAt:Date.now()+8*86400000},{sources:[]},{sources:['invalid']},{sources:['https://user:secret@example.invalid']},{sources:['https://example.invalid/?key=secret']},{sources:['http://example.invalid']},{prices:{input:NaN,output:5}},{prices:{input:-1,output:5}},{capabilities:{tools:'yes'}},{unknown:1}])expect(()=>validateBillingProfile({...profile,...patch})).toThrow();
  for(const value of [{version:2,profiles:[]},{version:1,profiles:[profile,profile]},{version:1,profiles:'bad'}]){fs.writeFileSync(file,JSON.stringify(value));expect(()=>readBillingEvidence(route,project)).toThrow();}
  for(const value of ['private unparsed secret',' '.repeat(131073)]){fs.writeFileSync(file,value);expect(()=>readBillingEvidence(route,project)).toThrow(/malformed/);}
  writeProfile();fs.chmodSync(file,0o666);expect(()=>readBillingEvidence(route,project)).toThrow();fs.chmodSync(file,0o600);
  profile.expiresAt=Date.now()-1;profile.checkedAt-=10000;writeProfile();expect(()=>readBillingEvidence(route,project)).toThrow(/expired/);
  profile.checkedAt=Date.now()+5000;profile.expiresAt=Date.now()+60000;writeProfile();expect(()=>readBillingEvidence(route,project)).toThrow(/expired/);
  profile.checkedAt=Date.now();writeProfile();const other={...route,model:'other'};expect(readBillingEvidence(other,project)).toBeUndefined();
  fs.renameSync(file,join(root,'actual'));fs.symlinkSync(join(root,'actual'),file);expect(()=>readBillingEvidence(route,project)).toThrow(/safely/);fs.unlinkSync(file);fs.linkSync(join(root,'actual'),file);expect(()=>readBillingEvidence(route,project)).toThrow();fs.unlinkSync(file);
  fs.mkdirSync(file);expect(()=>readBillingEvidence(route,project)).toThrow();fs.rmdirSync(file);
  writeProfile();expect(()=>readBillingEvidence(route,root)).toThrow(/outside/);
});
it.each([false,true])('counts and sends the same native system/tool replay payload (stream=%s)',async streaming=>{
  const {execution,ledger}=guard(),budget=execution.budget(route,messages,tools,streaming);
  const result=await chat('anthropic',messages,tools,route.model,streaming?()=>{}:undefined,undefined,{maxOutputTokens:100,attemptBudget:budget});
  expect(result.finishReason).toBe('stop');expect(requests.map(r=>r.path)).toEqual(['/v1/messages/count_tokens','/v1/messages']);
  const {max_tokens,stream,...paid}=requests[1]!.body;expect(max_tokens).toBe(100);expect(paid).toEqual(requests[0]!.body);
  expect(paid.system).toContain('Public trailing instruction');expect(paid.messages.at(-1).content[0]).toMatchObject({type:'tool_result',tool_use_id:'call_1'});
  const saved=new ReservationLedger(ledger.root).read(project),proof=Object.values(saved.projection.requests)[0]!.reservation.quoteEvidence!;
  expect(proof.profile).toEqual(profile);expect(proof.count.inputTokens).toBe(7);expect(saved.projection.spent).toEqual({tokens:10,costNanos:29000});
  expect(JSON.stringify(saved.events)).not.toContain('Public root instructions');expect(JSON.stringify(saved.events)).not.toContain('synthetic');
  expect(()=>validateQuoteEvidence({...proof,profileHash:'f'.repeat(64)})).toThrow();expect(()=>validateQuoteEvidence({...proof,multiplier:1})).toThrow();
});
it('runs through live discovery and the shared runtime with native missing price/tool metadata',async()=>{
  const {ledger,manifest}=guard();
  const result=await runTurn({cwd:project,provider:'anthropic',model:route.model,sessionId:randomUUID(),prompt:'Public toy',messages:{current:[{role:'user',content:'Public toy'}]},confirmation:'none',maxIterations:1,tools:()=>[],runlog:RunLog.open(randomUUID(),{enabled:false}),execution:{ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100}});
  expect(result.reason).toBe('completed');expect(requests.map(r=>r.path)).toContain('/v1/models');expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});
it.each([0,1])('persists a refused native planner without repair (%i) and exposes its usage through headless restart and replay',async(planningRepairs)=>{
  const prior=respond;respond=async(path,body,signal)=>path==='/v1/messages'?json({id:'refused',type:'message',role:'assistant',model:route.model,content:[],stop_reason:'refusal',usage:{input_tokens:7,output_tokens:0}}):prior(path,body,signal);
  const goals=new GoalStore(join(root,'goals')),store=new RunStore(join(root,'runs')),lines:string[]=[];
  const options={cwd:project,goals,store,planningRepairs,write:(line:string)=>lines.push(line),preference:{provider:'anthropic',model:route.model},limits:{tokenBudget:10000,costBudgetNanos:100000000,timeBudgetMs:60000,planningTokens:5000,planningCostNanos:50000000,planningTimeMs:30000,maxOutputTokens:100}};
  expect(await runGoalCommand(['Plan a tiny public fixture.','--json'],options)).toBe(planningRepairs?3:1);
  const records=lines.map(line=>JSON.parse(line)),id=records.find(r=>r.type==='orchestration.goal.created').data.manifest.id;
  expect(records.at(-1)).toMatchObject({version:1,error:{code:planningRepairs?'policy-denied':'unavailable',message:'Planner stopped: '+PROVIDER_REFUSAL_MESSAGE}});
  const saved=goals.read(id,project);expect(saved.state).toMatchObject({status:planningRepairs?'denied':'failed',planningFrozen:true,execution:null});expect(saved.proposal).toBeNull();if(!planningRepairs)expect(saved.state.planningSpend).toMatchObject({tokens:1138,costNanos:2576000});else expect(saved.state.planningSpend!.tokens).toBeGreaterThan(7);
  expect(saved.events.at(-1)?.change).toMatchObject({type:'planning_finished',reason:'Planner stopped: '+PROVIDER_REFUSAL_MESSAGE});
  const nativeRequests=requests.filter(r=>r.path==='/v1/messages').length;expect(nativeRequests).toBe(1);expect(fs.readdirSync(project)).toEqual([]);
  for(const action of ['resume','replay']){lines.length=0;expect(await runGoalCommand([action,id,'--json'],{...options,goals:new GoalStore(goals.root),store:new RunStore(store.root)})).toBe(action==='resume'?(planningRepairs?3:1):0);expect(JSON.parse(lines.at(-1)!).data.goal.events.at(-1).change.reason).toContain('Provider refused');}
  expect(requests.filter(r=>r.path==='/v1/messages')).toHaveLength(nativeRequests);
});
it('rejects changed messages or tools after counting before paid dispatch',async()=>{
  const input=structuredClone(messages),receipt=await countAnthropicInput(input,tools,route.model,false,undefined,{maxOutputTokens:100});input[0]!.content='Changed';
  await expect(chatAnthropic(input,tools,route.model,undefined,undefined,{bounded:true,maxOutputTokens:100,inputCount:receipt})).rejects.toThrow(/changed/);
  await expect(chatAnthropic(messages,[],route.model,undefined,undefined,{bounded:true,maxOutputTokens:100,inputCount:receipt})).rejects.toThrow(/changed/);
  await expect(chatAnthropic(messages,tools,route.model,()=>{},undefined,{bounded:true,maxOutputTokens:100,inputCount:receipt})).rejects.toThrow(/changed/);
  expect(requests).toHaveLength(1);
});
it('does not reserve or create a paid request after failed or malformed counting',async()=>{
  const {execution,ledger}=guard();
  for(const value of [0,-1,1.5,'7',null]){respond=async()=>json({input_tokens:value});await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{maxOutputTokens:100,attemptBudget:execution.budget(route,messages,tools,false)})).rejects.toThrow();}
  respond=async()=>json({error:{message:'Private upstream diagnostic'}},429);
  await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{maxOutputTokens:100,attemptBudget:execution.budget(route,messages,tools,false)})).rejects.toThrow('Request admission');
  expect(requests).toHaveLength(6);expect(requests.every(r=>r.path.endsWith('count_tokens'))).toBe(true);expect(ledger.read(project).projection.spent.costNanos).toBe(0);
  for(const patch of [{version:2},{method:'guess'},{requestHash:'bad'},{at:-1}])expect(()=>validateInputCount({...count(),...patch})).toThrow();
});
it('cancels free counting immediately, with no inference reservation',async()=>{
  const {execution,ledger}=guard(),controller=new AbortController();
  respond=async(_path,_body,signal)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});queueMicrotask(()=>controller.abort());});
  await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{signal:controller.signal,maxOutputTokens:100,attemptBudget:execution.budget(route,messages,tools,false,controller.signal)})).rejects.toMatchObject({name:'AbortError'});
  expect(requests).toHaveLength(1);expect(ledger.read(project).projection.spent.costNanos).toBe(0);
});
it('rechecks endpoint and revoked billing authority after free counting',async()=>{
  const {execution,ledger}=guard();respond=async()=>{config.setProviderCred('anthropic',{apiKey:'synthetic',baseUrl:'https://changed.invalid/v1'});return json({input_tokens:7});};
  await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{maxOutputTokens:100,attemptBudget:execution.budget(route,messages,tools,false)})).rejects.toThrow(/endpoint changed/);
  config.setProviderCred('anthropic',{apiKey:'synthetic',baseUrl:'https://count.invalid/v1'});respond=async()=>{fs.unlinkSync(file);return json({input_tokens:7});};
  await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{maxOutputTokens:100,attemptBudget:execution.budget(route,messages,tools,false)})).rejects.toThrow(/revoked/);
  expect(ledger.read(project).projection.spent.costNanos).toBe(0);expect(requests).toHaveLength(2);
});
it('keeps failed reservations across restart, reserves each retry and freezes on usage overrun',async()=>{
  const {execution,ledger}=guard(),attempt={provider:route.provider,model:route.model,target:route.target,maxOutputTokens:100,inputCount:count()},budget=execution.budget(route,[],[],false);
  const first=await budget.reserve(attempt);await budget.settle(first,'error');expect(new ReservationLedger(ledger.root).read(project).projection.spent.costNanos).toBe(2576000);
  // The same account has insufficient token headroom until the failed request is explicitly retained; a retry cannot refund it.
  await expect(budget.reserve({...attempt,inputCount:{...count(),inputTokens:8}})).rejects.toMatchObject({code:'budget'});
  const other=new ExecutionGuard({ledger,manifestHash:manifestHash(ledger.read(project).manifest),agentId:'b',maxOutputTokens:100},project),secondBudget=other.budget(route,[],[],false),second=await secondBudget.reserve(attempt);
  await expect(secondBudget.settle(second,'success',{inputTokens:1100,outputTokens:3})).rejects.toMatchObject({code:'budget'});expect(ledger.read(project).projection.exceeded).toBe(true);expect(()=>execution.assertActive()).toThrow(/exceeded/);
});
it('preserves project caps and audits counted quotes for ordinary requests',async()=>{
  config.set('budget',{maxCostPerProject:0.006});const audit:any[]=[];
  const budget=projectAttemptBudget(project,randomUUID(),route,[],[],false,100,undefined,(_id,_stage,proof)=>{if(proof)audit.push(proof);}),attempt={provider:route.provider,model:route.model,target:route.target,maxOutputTokens:100,inputCount:count()};
  await expect(budget.reserve({...attempt,inputCount:undefined})).rejects.toThrow(/omitted/);
  const first=await budget.reserve(attempt);await budget.settle(first,'error');const second=await budget.reserve(attempt);await budget.settle(second,'success',{inputTokens:7,outputTokens:3});expect(audit).toHaveLength(2);expect(loadProjectSpend(project).spentUsd).toBe(0.002605);
  const third=await budget.reserve(attempt);await expect(budget.settle(third,'success',{inputTokens:2000,outputTokens:3})).rejects.toThrow(/exceeded/);await expect(budget.reserve(attempt)).rejects.toThrow();
  await expect(budget.settle('missing','success')).rejects.toThrow(/Unknown/);
});
it('recounts and reserves every shared network retry without hidden SDK retries',async()=>{
  const manifest=executionManifest(project);manifest.tokenBudget=6000;manifest.accounts[0]!.tokenBudget=6000;manifest.accounts[1]!.tokenBudget=4000;manifest.costBudgetNanos=20000000;manifest.accounts[0]!.costBudgetNanos=20000000;manifest.accounts[1]!.costBudgetNanos=10000000;
  const ledger=new ReservationLedger(join(root,'retry'));ledger.create(manifest);const execution=new ExecutionGuard({ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100},project);let paid=0;
  respond=async(path)=>{if(path.endsWith('count_tokens'))return json({input_tokens:7+paid});if(++paid===1)return json({type:'error',error:{type:'overloaded_error',message:'Synthetic overload'}},529);const wire=syntheticWire('anthropic','text',false);return wireResponse(wire.body,wire.type);};
  const retries=vi.fn();await chat('anthropic',messages,tools,route.model,undefined,retries,{maxOutputTokens:100,attemptBudget:execution.budget(route,messages,tools,false)});
  expect(retries).toHaveBeenCalledTimes(1);expect(requests.map(r=>r.path)).toEqual(['/v1/messages/count_tokens','/v1/messages','/v1/messages/count_tokens','/v1/messages']);
  const saved=ledger.read(project);expect(Object.values(saved.projection.requests).map(r=>r.state)).toEqual(['unknown','settled']);expect(saved.projection.spent.costNanos).toBe(2605000);
  vi.spyOn(config,'getApiKey').mockReturnValue(undefined);await expect(countAnthropicInput([],[],route.model,false)).rejects.toThrow(/key not configured/);
});
it.each(['agent','project'] as const)('denies revocation during durable %s admission and retains its reservation',async kind=>{
  const {execution,ledger}=guard(),{ProjectSpendLedger}=await import('../src/execution/index.js'),reserve=ProjectSpendLedger.prototype.reserve;
  vi.spyOn(ProjectSpendLedger.prototype,'reserve').mockImplementation(async function(this:InstanceType<typeof ProjectSpendLedger>,...args){await reserve.apply(this,args);fs.unlinkSync(file);});
  const budget=kind==='agent'?execution.budget(route,messages,tools,false):projectAttemptBudget(project,randomUUID(),route,messages,tools,false,100);
  await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{maxOutputTokens:100,attemptBudget:budget})).rejects.toThrow(/revoked while committing/);
  expect(requests.map(r=>r.path)).toEqual(['/v1/messages/count_tokens']);expect(loadProjectSpend(project).spentUsd).toBe(0.002576);
  if(kind==='agent')expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('pending');
});

async function discoverEffort() {
  const next=respond;
  respond=async(path,body,signal)=>path.endsWith('/models')?json({data:[{id:route.model,max_input_tokens:1000000,max_tokens:8192,capabilities:{effort:{supported:true,low:{supported:true},high:{supported:true}}}}],has_more:false}):next(path,body,signal);
  await getAvailableModels('anthropic',{quiet:true,throwOnError:true});requests=[];
}
it.each([false,true])('binds explicit effort to counted and paid native payloads, including replay (stream=%s)',async streaming=>{
  await discoverEffort();const {execution}=guard();
  await chat('anthropic',messages,tools,route.model,streaming?()=>{}:undefined,undefined,{reasoningEffort:'low',maxOutputTokens:100,attemptBudget:execution.budget(route,messages,tools,streaming)});
  const {max_tokens,stream,...paid}=requests[1]!.body;expect(paid).toEqual(requests[0]!.body);expect(paid.output_config).toEqual({effort:'low'});expect(max_tokens).toBe(100);
  const proof=await countAnthropicInput(messages,tools,route.model,false,undefined,{maxOutputTokens:100,reasoningEffort:'low'});
  await expect(chatAnthropic(messages,tools,route.model,undefined,undefined,{bounded:true,maxOutputTokens:100,reasoningEffort:'high',inputCount:proof})).rejects.toThrow('changed');
  expect(requests).toHaveLength(3);
});
it('carries effort through shared runtime routing, native counting and dispatch',async()=>{
  await discoverEffort();const {ledger,manifest}=guard(),routes:any[]=[];
  const result=await runTurn({cwd:project,provider:'anthropic',model:route.model,reasoningEffort:'low',sessionId:randomUUID(),prompt:'Public toy',messages:{current:[{role:'user',content:'Public toy'}]},confirmation:'none',maxIterations:1,tools:()=>[],onRoute:r=>routes.push(r),runlog:RunLog.open(randomUUID(),{enabled:false}),execution:{ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100}});
  expect(result.reason).toBe('completed');expect(routes.every(r=>r.selected.reasoningEffort==='low')).toBe(true);expect(requests.at(-1)!.body.output_config.effort).toBe('low');
});
it('denies unsupported, stale and malformed effort before admission and fails closed if evidence is revoked during it',async()=>{
  const {execution,ledger}=guard(),budget=execution.budget(route,messages,tools,false),opts={maxOutputTokens:100,attemptBudget:budget};
  await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{...opts,reasoningEffort:'low'})).rejects.toThrow('Live discovery');
  expect(requests).toHaveLength(0);expect(ledger.read(project).projection.spent.costNanos).toBe(0);
  await discoverEffort();await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{...opts,reasoningEffort:'invented' as any})).rejects.toThrow('Live discovery');
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://count.invalid/v1'});
  await expect(chat('deepseek',messages,tools,route.model,undefined,undefined,{reasoningEffort:'low'})).rejects.toThrow('native Anthropic');
  const reserve=budget.reserve;budget.reserve=async attempt=>{const id=await reserve(attempt);clearModelCache();return id;};
  await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{...opts,reasoningEffort:'low'})).rejects.toThrow('Live discovery');
  expect(requests.map(r=>r.path)).toEqual(['/v1/messages/count_tokens']);expect(ledger.read(project).projection.spent.costNanos).toBeGreaterThan(0);
});
it('cancels effort counting without paid dispatch or resetting the persistent budget',async()=>{
  await discoverEffort();const {execution,ledger}=guard(),controller=new AbortController();
  respond=async()=>{controller.abort();return json({input_tokens:7});};
  await expect(chat('anthropic',messages,tools,route.model,undefined,undefined,{reasoningEffort:'low',maxOutputTokens:100,attemptBudget:execution.budget(route,messages,tools,false),signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
  expect(requests).toHaveLength(1);expect(ledger.read(project).projection.spent.costNanos).toBe(0);
});
