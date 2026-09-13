/** Real stores, discovery and SDK parsing; only the provider HTTP responses are synthetic. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {providerTarget} from '../src/health/index.js';
import {canonicalJson,digest} from '../src/approvals/index.js';
import {providerQuote,readBillingEvidence,reviewedOutputLimit,validateBillingProfile,validateQuoteEvidence,ExecutionGuard,ReservationLedger,ProjectSpendLedger,manifestHash,projectAttemptBudget,replayReservations,type FullContextBillingProfile} from '../src/execution/index.js';
import {executionManifest} from './helpers/execution-manifest.js';
import {syntheticWire,wireResponse} from './helpers/provider-wire.js';
import {projectBudgetPath,loadProjectSpend} from '../src/budget.js';
import {chat} from '../src/providers/index.js';
import {runTurn} from '../src/runtime/index.js';
import {RunLog} from '../src/runlog.js';
import {clearModelCache} from '../src/model-detection.js';
import {selectRoute,type RouteCandidate} from '../src/routing/index.js';
import type {Message,Tool} from '../src/types.js';

let root:string,project:string,file:string,profile:FullContextBillingProfile,route:RouteCandidate,requests:{path:string;body:any}[];
let respond:(path:string,body:any,signal:AbortSignal)=>Promise<Response>;
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
const messages:Message[]=[{role:'system',content:'Public root instructions'},{role:'user',content:'Public toy request'}];
const tools:Tool[]=[{name:'echo',description:'Echo text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}];
const writeProfile=()=>fs.writeFileSync(file,JSON.stringify({version:2,profiles:[profile]}),{mode:0o600});
const evidence=()=>readBillingEvidence(route,project)!;
const attempt=()=>({provider:route.provider,model:route.model,target:route.target,maxOutputTokens:100});
function guard(){const manifest=executionManifest(project);manifest.accounts[1]!.tokenBudget=3000;manifest.accounts[2]!.tokenBudget=1000;const ledger=new ReservationLedger(join(root,'ledger'));ledger.create(manifest);return{ledger,manifest,execution:new ExecutionGuard({ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100},project)};}
beforeEach(()=>{
  config.resetConfig();clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-reviewed-')));project=join(root,'project');fs.mkdirSync(project);file=join(root,'billing.json');vi.stubEnv('CALLIOPE_BILLING_FILE',file);
  vi.stubEnv('DEEPSEEK_API_KEY','');vi.stubEnv('DEEPSEEK_BASE_URL','');config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://reviewed.invalid/v1'});
  route={provider:'deepseek',model:'reviewed-toy',target:providerTarget('deepseek').key,evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{},contextLength:null,maxOutputTokens:null,price:null,estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'Live ID-only fixture'};
  profile={version:2,provider:'deepseek',model:route.model,target:route.target,checkedAt:Date.now(),expiresAt:Date.now()+60000,sources:['https://example.invalid/model-contract'],prices:{input:2,output:5},capabilities:{chat:true,tools:true,streaming:true},limits:{contextLength:1000,maxOutputTokens:100},admission:'reviewed-full-context-v1'};writeProfile();requests=[];
  respond=async(path,body)=>{if(path.endsWith('/models'))return json({data:[{id:route.model}]});const wire=syntheticWire('chat','text',!!body.stream);return wireResponse(wire.body,wire.type);};
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{const request=new Request(input,init),url=new URL(request.url);expect(url.origin).toBe('https://reviewed.invalid');const body=request.method==='POST'?await request.json():undefined;requests.push({path:url.pathname,body});return respond(url.pathname,body,init?.signal??request.signal);}));
});
afterEach(()=>{config.resetConfig();clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});

it('supplements missing fields without changing discovery, model identity or conservative live bounds',()=>{
  const original=structuredClone(route),e=evidence(),quote=providerQuote(route,messages,tools,true,100,e);expect(quote).toMatchObject({inputTokens:1000,outputTokens:100,inputPrice:2,outputPrice:5,costNanos:2500000,quoteEvidence:{version:2,profileHash:e.hash,live:{contextLength:null,maxOutputTokens:null,capabilities:{}}}});expect(route).toEqual(original);
  const richer={...route,contextLength:2000,maxOutputTokens:80,capabilities:{chat:true,tools:true,streaming:true},price:{input:3,output:7}};expect(providerQuote(richer,[],[],false,80,e)).toMatchObject({inputTokens:2000,inputPrice:3,outputPrice:7});expect(()=>providerQuote(richer,[],[],false,81,e)).toThrow(/output/);
  expect(providerQuote({...richer,contextLength:500,price:{input:0,output:0}},[],[],false,80,e)).toMatchObject({inputTokens:1000,inputPrice:2,outputPrice:5});
  expect(reviewedOutputLimit(route,project)).toBe(100);expect(reviewedOutputLimit(richer,project)).toBe(80);expect(reviewedOutputLimit({...route,maxOutputTokens:200},project)).toBe(100);expect(reviewedOutputLimit({...route,model:'other'},project)).toBeNull();
  expect(()=>providerQuote(route,[],[],false,100)).toThrow();expect(()=>providerQuote(route,[],[],false,101,e)).toThrow(/output/);
  for(const patch of [{provider:'google'},{model:'other'},{target:'a'.repeat(64)},{evidence:'explicit-unverified'},{discoveredAt:new Date(Date.now()-300001).toISOString()}])expect(()=>providerQuote({...route,...patch} as RouteCandidate,[],[],false,100,e)).toThrow();
  expect(()=>providerQuote(route,[{role:'user',content:[{type:'image',source:{type:'url',url:'https://example.invalid/image'}}]}] as never,[],false,100,e)).toThrow(/Multimodal/);
  expect(()=>providerQuote(route,[],[],false,100,e,{version:1,method:'anthropic-count-tokens',requestHash:'a'.repeat(64),inputTokens:7,at:Date.now()})).toThrow(/input count/);expect(fetch).not.toHaveBeenCalled();
});
it.each(['chat','tools','streaming'] as const)('never overrides a live %s rejection',capability=>{
  expect(()=>providerQuote({...route,capabilities:{[capability]:false}},messages,tools,true,100,evidence())).toThrow(/capabilities/);
  profile.capabilities[capability]=false;writeProfile();expect(()=>providerQuote(route,messages,tools,true,100,evidence())).toThrow(/capabilities/);
  expect(providerQuote({...route,capabilities:{chat:true,tools:true,streaming:true}},messages,tools,true,100,evidence())).toMatchObject({inputTokens:1000});
});
it('validates versioned metadata and preserves matching legacy profiles without migrating files',()=>{
  const old={provider:'anthropic',model:'legacy-toy',target:'a'.repeat(64),checkedAt:profile.checkedAt,expiresAt:profile.expiresAt,sources:profile.sources,prices:profile.prices,capabilities:{tools:true},admission:'provider-count-v1'};
  fs.writeFileSync(file,JSON.stringify({version:2,profiles:[old,profile]}));const before=fs.readFileSync(file);expect(evidence().profile).toEqual(profile);expect(readBillingEvidence({...route,provider:'anthropic',model:old.model,target:old.target},project)?.profile).toEqual(old);expect(fs.readFileSync(file)).toEqual(before);
  fs.writeFileSync(file,JSON.stringify({version:1,profiles:[profile]}));expect(()=>evidence()).toThrow(/malformed/);
  for(const patch of [{version:1},{version:3},{provider:'auto'},{provider:'invented'},{admission:'guessed-count'},{limits:{contextLength:0,maxOutputTokens:100}},{limits:{contextLength:1e9,maxOutputTokens:100}},{limits:{contextLength:1000,maxOutputTokens:1.2}},{capabilities:{vision:true}},{sources:['https://example.invalid/?key=private']},{prices:{input:-1,output:5}},{extra:true}])expect(()=>validateBillingProfile({...profile,...patch})).toThrow();
  for(const profiles of [[profile,profile],Array.from({length:65},()=>profile)]){fs.writeFileSync(file,JSON.stringify({version:2,profiles}));expect(()=>evidence()).toThrow();}
  writeProfile();expect(readBillingEvidence({...route,model:'not-present'},project)).toBeUndefined();profile.expiresAt=Date.now()-1;writeProfile();expect(()=>evidence()).toThrow(/expired/);
});
it('refuses symlinked, writable, oversized, project-local or malformed metadata without leaking its bytes',()=>{
  const saved=fs.readFileSync(file);fs.renameSync(file,file+'.saved');fs.symlinkSync(file+'.saved',file);expect(()=>evidence()).toThrow(/safely/);fs.unlinkSync(file);fs.renameSync(file+'.saved',file);
  fs.chmodSync(file,0o666);expect(()=>evidence()).toThrow();fs.chmodSync(file,0o600);
  for(const bytes of ['private marker invalid json',' '.repeat(131073)]){fs.writeFileSync(file,bytes);try{evidence();throw Error('Expected failure');}catch(e){expect(String(e)).not.toContain('private marker');}}fs.writeFileSync(file,saved);
  const inside=join(project,'billing.json');fs.writeFileSync(inside,saved);expect(()=>readBillingEvidence(route,project,inside)).toThrow(/outside/);expect(fetch).not.toHaveBeenCalled();
});
it.each([false,true])('dispatches native-compatible SDK text/tools without requesting an Anthropic count (stream=%s)',async streaming=>{
  const {execution,ledger}=guard();respond=async(_path,body)=>{const w=syntheticWire('chat','tool',!!body.stream);return wireResponse(w.body,w.type);};
  const budget=execution.budget(route,messages,tools,streaming);expect(budget.inputCounting).toBeUndefined();const response=await chat('deepseek',messages,tools,route.model,streaming?()=>{}:undefined,undefined,{maxOutputTokens:100,attemptBudget:budget});expect(response.toolCalls?.[0]).toMatchObject({name:'echo'});
  expect(requests.map(r=>r.path)).toEqual(['/v1/chat/completions']);expect(requests[0]!.body.max_tokens).toBe(100);
  const saved=new ReservationLedger(ledger.root).read(project);expect(saved.events[0]!.version).toBe(4);expect(saved.projection.spent).toEqual({tokens:10,costNanos:29000});const entry=Object.values(saved.projection.requests)[0]!;expect(entry.reservation).toMatchObject({inputTokens:1000,quoteEvidence:{version:2,profile}});expect(replayReservations(saved.manifest,saved.events)).toEqual(saved.projection);expect(JSON.stringify(saved.events)).not.toMatch(/Public root instructions|synthetic/);
});
it('runs the shared runtime with ID-only discovery and exposes original unknown fields in routing',async()=>{
  const {execution,ledger,manifest}=guard(),routes:any[]=[];const selected=await selectRoute({provider:'deepseek',model:route.model,requirements:{tools:true}});expect(selected.selected).toMatchObject({evidence:'live',contextLength:null,maxOutputTokens:null,capabilities:{}});
  const result=await runTurn({cwd:project,provider:'deepseek',model:route.model,sessionId:randomUUID(),prompt:'Public toy',messages:{current:[{role:'user',content:'Public toy'}]},confirmation:'none',maxIterations:1,tools:()=>[],onRoute:r=>routes.push(r),runlog:RunLog.open(randomUUID(),{enabled:false}),execution:{ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100}});
  expect(result.reason).toBe('completed');expect(routes.at(-1).selected.price?.input).toBeUndefined();expect(routes.at(-1).selected.price?.output).toBeUndefined();expect(requests.map(r=>r.path)).toEqual(['/v1/models','/v1/chat/completions']);expect(ledger.read(project).projection.spent.costNanos).toBe(29000);execution.assertActive();
});
it.each(['agent','project'] as const)('rechecks revoked %s metadata before admission and after durable reservation',async kind=>{
  const {execution,ledger}=guard(),make=()=>kind==='agent'?execution.budget(route,messages,tools,false):projectAttemptBudget(project,randomUUID(),route,messages,tools,false,100),budget=make();
  fs.unlinkSync(file);await expect(budget.reserve(attempt())).rejects.toThrow(/revoked/);expect(loadProjectSpend(project).spentUsd).toBe(0);expect(ledger.read(project).events).toHaveLength(0);writeProfile();
  const reserve=ProjectSpendLedger.prototype.reserve;vi.spyOn(ProjectSpendLedger.prototype,'reserve').mockImplementation(async function(this:ProjectSpendLedger,...args){await reserve.apply(this,args);fs.unlinkSync(file);});
  await expect(chat('deepseek',messages,tools,route.model,undefined,undefined,{maxOutputTokens:100,attemptBudget:make()})).rejects.toThrow(/revoked while committing/);expect(fetch).not.toHaveBeenCalled();expect(loadProjectSpend(project).spentUsd).toBe(0.0025);if(kind==='agent')expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('pending');
});
it('retains failed/cancelled charges, bounds retries and freezes overrun across restart',async()=>{
  const {execution,ledger,manifest}=guard(),budget=execution.budget(route,[],[],false),first=await budget.reserve(attempt());await budget.settle(first,'error');
  const restarted=new ExecutionGuard({ledger:new ReservationLedger(ledger.root),manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100},project),next=restarted.budget(route,[],[],false),second=await next.reserve(attempt());await next.settle(second,'cancelled');
  expect(ledger.read(project).projection.spent).toEqual({tokens:2200,costNanos:5000000});await expect(next.reserve(attempt())).rejects.toMatchObject({code:'budget'});
  const other=new ExecutionGuard({ledger,manifestHash:manifestHash(manifest),agentId:'root',maxOutputTokens:100},project).budget(route,[],[],false),third=await other.reserve(attempt());await expect(other.settle(third,'success',{inputTokens:1001,outputTokens:100})).rejects.toMatchObject({code:'budget'});expect(ledger.read(project).projection.exceeded).toBe(true);expect(()=>restarted.assertActive()).toThrow();
});
it('cancels pending transport immediately and retains its full reservation',async()=>{
  const {execution,ledger}=guard(),controller=new AbortController();respond=async(_p,_b,signal)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});queueMicrotask(()=>controller.abort());});
  await expect(chat('deepseek',messages,[],route.model,undefined,undefined,{signal:controller.signal,maxOutputTokens:100,attemptBudget:execution.budget(route,messages,[],false,controller.signal)})).rejects.toThrow();expect(requests).toHaveLength(1);expect(ledger.read(project).projection.spent.tokens).toBe(1100);await vi.waitFor(()=>expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown'));expect(ledger.read(project).projection.spent.tokens).toBe(1100);
});
it.each(['agent','project'] as const)('enforces current policy, expiry and cancellation for %s admission before dispatch',async kind=>{
  const {execution,ledger}=guard(),controller=new AbortController(),make=()=>kind==='agent'?execution.budget(route,[],[],false,controller.signal):projectAttemptBudget(project,randomUUID(),route,[],[],false,100,controller.signal),budget=make();
  config.set('budget',{maxCostPerProject:0.002});await expect(budget.reserve(attempt())).rejects.toMatchObject({code:'budget'});expect(ledger.read(project).events).toHaveLength(0);expect(loadProjectSpend(project).spentUsd).toBe(0);config.set('budget',{});
  vi.spyOn(Date,'now').mockReturnValue(profile.expiresAt);await expect(budget.reserve(attempt())).rejects.toThrow(/expired/);vi.restoreAllMocks();
  controller.abort();await expect(budget.reserve(attempt())).rejects.toThrow();expect(ledger.read(project).events).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
});
it('records full-context project audit evidence and retains a failed charge across an actual SDK retry',async()=>{
  const events:any[]=[];let paid=0;respond=async()=>++paid===1?json({error:{message:'Public temporary failure',type:'server_error'}},503):wireResponse(syntheticWire('chat','text',false).body,'application/json');
  const budget=projectAttemptBudget(project,randomUUID(),route,messages,[],false,100,undefined,(id,stage,evidence)=>events.push({id,stage,evidence}));
  await chat('deepseek',messages,[],route.model,undefined,undefined,{maxOutputTokens:100,attemptBudget:budget});
  expect(requests.map(r=>r.path)).toEqual(['/v1/chat/completions','/v1/chat/completions']);expect(events.filter(e=>e.stage==='reserved')).toHaveLength(2);expect(new Set(events.map(e=>e.id)).size).toBe(2);
  for(const e of events.filter(e=>e.stage==='reserved'))expect(validateQuoteEvidence(e.evidence)).toMatchObject({version:2,profile,live:{contextLength:null}});
  expect(events.map(e=>e.stage)).toEqual(['reserved','unknown','reserved','settled']);expect(loadProjectSpend(project).spentUsd).toBeCloseTo(0.002529,9);
},15000); // Exercise the real shared 10-second server-error backoff.
it('rejects tampered full-context evidence and lower reservations during deterministic ledger replay',async()=>{
  const {execution,ledger}=guard(),budget=execution.budget(route,[],[],false);await budget.reserve(attempt());const saved=ledger.read(project),original=Object.values(saved.projection.requests)[0]!.reservation,proof=original.quoteEvidence!;expect(proof.version).toBe(2);if(proof.version!==2)throw Error('Expected reviewed proof');
  for(const patch of [{version:3},{quotedAt:profile.expiresAt},{quotedAt:profile.checkedAt-2000},{profileHash:'a'.repeat(64)},{profileHash:'invalid'},{live:{...proof.live,capabilities:{chat:'yes'}}},{live:{...proof.live,discoveredAt:proof.quotedAt-300001}},{live:{...proof.live,contextLength:0}},{live:{...proof.live,prices:{input:-1,output:null}}},{requirements:{tools:'yes',streaming:false}},{count:{}}])expect(()=>validateQuoteEvidence({...proof,...patch})).toThrow();
  const legacy={provider:'anthropic',model:profile.model,target:profile.target,checkedAt:profile.checkedAt,expiresAt:profile.expiresAt,sources:profile.sources,prices:profile.prices,capabilities:{tools:true},admission:'provider-count-v1'};expect(()=>validateQuoteEvidence({...proof,profile:legacy,profileHash:digest(canonicalJson(legacy))})).toThrow();
  for(const patch of [{model:'another-model'},{inputPrice:1,costNanos:1500000},{inputTokens:999,costNanos:2498000},{outputTokens:101,costNanos:2505000},{inputPrice:3,costNanos:3500000}]){
    const event=structuredClone(saved.events[0]!);if(event.change.type!=='reserve')throw Error('Expected reservation');Object.assign(event.change.reservation,patch);const {hash,...body}=event;event.hash=digest(canonicalJson(body));expect(()=>replayReservations(saved.manifest,[event])).toThrow();
  }
  const event=structuredClone(saved.events[0]!);event.version=3;const {hash,...body}=event;event.hash=digest(canonicalJson(body));expect(()=>replayReservations(saved.manifest,[event])).toThrow();expect(ledger.read(project)).toEqual(saved);
});
