import * as fs from 'node:fs';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as config from '../src/config.js';
import * as hooks from '../src/hooks.js';
import {withScope} from '../src/scope.js';
import {BrainStore,initBrain,ingestBrainFile,noteBrain} from '../src/brain/index.js';
import {BRAIN_TOOLS,BRAIN_TOOL_NAMES} from '../src/brain/tools.js';
import {queryBrainTool,BRAIN_TOOL_RESULT_BYTES} from '../src/brain/tool-query.js';
import {ExecutionGuard,ReservationLedger,manifestHash} from '../src/execution/index.js';
import {getTools,executeTool} from '../src/tools.js';
import {resolvePermission} from '../src/runtime/permissions.js';
import {RunLog,readRunLog,verifyChain} from '../src/runlog.js';
import {fixture,source,entity} from './helpers/brain.js';
import {executionManifest} from './helpers/execution-manifest.js';
let f:ReturnType<typeof fixture>,store:BrainStore,guard:ExecutionGuard,ledger:ReservationLedger;
const call=(name='brain_search',args:Record<string,unknown>={query:'portable'})=>({id:'brain-call',name,arguments:args});
const retrieve=(name='brain_search',args:Record<string,unknown>={query:'portable'},signal?:AbortSignal)=>withScope(f.cwd,()=>executeTool(call(name,args),f.cwd,60000,undefined,{authority:guard.check,brain:guard.brainContext(),signal}));
async function ingest(path:string,content='Portable SQLite storage.') { fs.writeFileSync(join(f.cwd,path),content);return ingestBrainFile(f.cwd,path,{confirmation:'none'}); }
beforeEach(async()=>{
  f=fixture();config.resetConfig();hooks.saveHooks([]);fs.mkdirSync(join(f.cwd,'a'));fs.mkdirSync(join(f.cwd,'b'));
  store=new BrainStore(f.cwd);await initBrain(f.cwd,{confirmation:'none'});
  const manifest=executionManifest(f.cwd);for(const account of manifest.accounts)account.allowedTools.push(...BRAIN_TOOL_NAMES);
  ledger=new ReservationLedger(join(f.root,'budget'));ledger.create(manifest);guard=new ExecutionGuard({ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100},f.cwd);
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Knowledge retrieval must be local.');}));
});
afterEach(()=>{fs.rmSync(store.root,{recursive:true,force:true});f.clean();config.resetConfig();hooks.saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('keeps ordinary tools unchanged and exposes canonical definitions only within explicit inherited grants',async()=>{
  expect(getTools().map(t=>t.name)).not.toEqual(expect.arrayContaining(BRAIN_TOOL_NAMES));
  expect(guard.tools([{...BRAIN_TOOLS[0]!,description:'untrusted plugin schema'}]).filter(t=>t.name==='brain_search')).toEqual([BRAIN_TOOLS[0]]);
  const manifest=executionManifest(f.cwd),other=new ReservationLedger(join(f.root,'ordinary'));other.create(manifest);
  const plain=new ExecutionGuard({ledger:other,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:100},f.cwd);
  expect(plain.tools(getTools()).map(t=>t.name)).not.toEqual(expect.arrayContaining(BRAIN_TOOL_NAMES));
  expect(plain.check(call())).toMatch(/declared agent authority/);
  expect((await executeTool(call(),f.cwd)).isError).toBe(true);
  expect((await executeTool(call(),f.cwd,60000,undefined,{brain:guard.brainContext()})).isError).toBe(true);
  for(const name of BRAIN_TOOL_NAMES)expect((await resolvePermission(call(name),{cwd:f.cwd,mode:'plan',confirmation:'mutating',authority:guard.check})).decision).toBe('allow');
});
it('returns indexed evidence with provenance and source hashes, survives restart, and does not mutate history or reservations',async()=>{
  const first=await ingest('a/source.md'),before=store.read(),budget=ledger.read(f.cwd);
  const found=await retrieve();expect(found.isError).not.toBe(true);const parsed=JSON.parse(found.result);
  expect(parsed).toMatchObject({version:1,type:'project-knowledge',revision:before.state.revision,entities:[{id:first.entityId,freshness:'current',effectiveState:'accepted',confidence:1}]});
  expect(parsed.guidance).toContain('untrusted retained evidence');
  const detail=JSON.parse((await retrieve('brain_entity',{query:first.entityId})).result);
  expect(detail.entity.provenance[0]).toMatchObject({sourceId:first.sourceId,basis:'observed'});
  expect(detail.sources[0]).toMatchObject({contentOmitted:true,originalHash:before.state.sources[first.sourceId]!.originalHash,locator:{path:'a/source.md'}});
  expect(detail.sources[0]).not.toHaveProperty('content');expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(BRAIN_TOOL_RESULT_BYTES);
  guard=new ExecutionGuard({ledger:new ReservationLedger(ledger.root),manifestHash:budget.projection.manifestHash,agentId:'a',maxOutputTokens:100},f.cwd);
  const again=JSON.parse((await retrieve('brain_entity',{query:first.entityId})).result);expect(again.entity).toEqual(detail.entity);expect(new BrainStore(f.cwd).read()).toEqual(before);expect(ledger.read(f.cwd)).toEqual(budget);expect(fetch).not.toHaveBeenCalled();
});
it('checks every source against current agent grants, including mixed, foreign and pathless provenance',async()=>{
  const allowed=await ingest('a/public.md'),outside=await ingest('b/private.md');
  await noteBrain(f.cwd,'Portable decision','Use SQLite.','decision',{confirmation:'none'});
  await store.append([{kind:'source',value:{...source('foreign'),locator:{projectKey:'f'.repeat(64),path:'a/public.md'}}},{kind:'entity',id:'foreign',expected:null,value:entity('foreign',{name:'Foreign portable decision',provenance:[{sourceId:'foreign',basis:'observed'}]})},{kind:'source',value:{...source('unbound'),locator:{path:'a/public.md'}}},{kind:'entity',id:'unbound',expected:null,value:entity('unbound',{name:'Unbound portable decision',provenance:[{sourceId:'unbound',basis:'observed'}]})},{kind:'entity',id:'mixed',expected:null,value:entity('mixed',{name:'Mixed portable decision',provenance:[{sourceId:allowed.sourceId,basis:'observed'},{sourceId:outside.sourceId,basis:'inferred'}]})}], 'human','Public scope fixtures');
  expect(JSON.parse((await retrieve()).result).entities.map((e:any)=>e.id)).toEqual([allowed.entityId]);
  for(const query of [outside.entityId,'mixed','foreign','unbound','Portable decision'])expect((await retrieve('brain_entity',{query})).isError).toBe(true);
  const saved=ledger.read(f.cwd);guard=new ExecutionGuard({ledger,manifestHash:saved.projection.manifestHash,agentId:'root',maxOutputTokens:100},f.cwd);
  expect(JSON.parse((await retrieve('brain_entity',{query:'Portable decision'})).result).entity).toMatchObject({state:'proposed',confidence:1});
  for(const query of ['foreign','unbound'])expect((await retrieve('brain_entity',{query})).isError).toBe(true);
});
it('preserves stale/inferred labels and rechecks current source policy, secret configuration and aliases',async()=>{
  const first=await ingest('a/source.md','Portable SQLite with a public canary-value-for-revocation.');
  fs.writeFileSync(join(f.cwd,'a/source.md'),'Changed design.');
  expect(JSON.parse((await retrieve('brain_entity',{query:first.entityId})).result).entity).toMatchObject({state:'accepted',effectiveState:'stale',freshness:'changed'});
  const blocked=vi.spyOn(hooks,'checkHooksAllow').mockImplementation(async(_event,context)=>({allowed:context.toolArgs?.operation!=='brain-read-retained-source',reason:'Current source policy'}));
  expect(JSON.parse((await retrieve()).result).entities).toEqual([]);expect((await retrieve('brain_entity',{query:first.entityId})).isError).toBe(true);blocked.mockRestore();
  vi.stubEnv('EXAMPLE_API_KEY','canary-value-for-revocation');expect(JSON.parse((await retrieve()).result).entities).toEqual([]);vi.unstubAllEnvs();
  fs.rmSync(join(f.cwd,'a/source.md'));expect(JSON.parse((await retrieve('brain_entity',{query:first.entityId})).result).entity.freshness).toBe('missing');
  fs.symlinkSync(join(f.cwd,'b'),join(f.cwd,'a/source.md'));expect((await retrieve('brain_entity',{query:first.entityId})).isError).toBe(true);
});
it.each([{}, {query:''},{query:'x'.repeat(1025)},{query:'🚀'.repeat(300)},{query:'a\nb'}, {query:'portable',limit:0},{query:'portable',limit:11},{query:'portable',limit:1.5},{query:'portable',limit:'2'},{query:'portable',scope:'global'},{query:'portable',base:'/tmp/other'},{query:'portable',path:'../outside'}])('rejects malformed arguments without releasing evidence: %j',async args=>{
  expect((await retrieve('brain_search',args)).isError).toBe(true);
});
it('rejects unknown actions, entity limit overrides, secret arguments and oversized responses as complete errors',async()=>{
  await expect(queryBrainTool(call('brain_write'),f.cwd,guard.brainContext())).rejects.toThrow();
  expect((await retrieve('brain_entity',{query:'portable',limit:1})).isError).toBe(true);
  vi.stubEnv('EXAMPLE_API_KEY','secret-query-fixture');expect((await retrieve('brain_search',{query:'secret-query-fixture'})).isError).toBe(true);
  await store.append([{kind:'source',value:{...source(),locator:{projectKey:store.project.key,path:'a/public.md'}}},{kind:'entity',id:'large',expected:null,value:entity('large',{summary:'p'.repeat(16000),attributes:{one:'p'.repeat(4096),two:'p'.repeat(4096),three:'p'.repeat(4096),four:'p'.repeat(4096)}})}], 'human','Bounded public result fixture');
  const result=await retrieve('brain_entity',{query:'large'});expect(result.isError).toBe(true);expect(JSON.parse(result.result).error.code).toBe('limit');expect(result.result).not.toContain('p'.repeat(100));
});
it('records source-scope denials on the same audit chain without source content',async()=>{
  const first=await ingest('b/secret.md','Portable private-source-canary.'),log=RunLog.open('brain-audit',{dir:join(f.root,'audit')});
  const result=await withScope(f.cwd,()=>executeTool(call('brain_entity',{query:first.entityId}),f.cwd,60000,undefined,{authority:guard.check,brain:{...guard.brainContext(),runlog:log}}));await log.flush();
  expect(result.isError).toBe(true);const events=readRunLog(log.filePath);expect(verifyChain(events).ok).toBe(true);expect(events.some(e=>e.type==='policy_event'&&JSON.stringify(e).includes('agent read scope'))).toBe(true);expect(JSON.stringify(events)).not.toContain('private-source-canary');
});
it('fails closed on cancellation, revoked authority, missing storage and changed secret metadata',async()=>{
  const first=await ingest('a/source.md');const controller=new AbortController();controller.abort();await expect(retrieve('brain_entity',{query:first.entityId},controller.signal)).rejects.toThrow();
  const saved=ledger.read(f.cwd);let revoked=false;guard=new ExecutionGuard({ledger,manifestHash:saved.projection.manifestHash,agentId:'a',maxOutputTokens:100,assertAuthority:()=>{if(revoked)throw new Error('revoked');}},f.cwd);
  const block=vi.spyOn(hooks,'checkHooksAllow').mockImplementation(async()=>{revoked=true;return {allowed:true};});
  expect((await retrieve()).isError).toBe(true);block.mockRestore();revoked=false;
  const metadata=store.read().state.sources[first.sourceId]!.originalHash;vi.stubEnv('EXAMPLE_API_KEY',metadata);expect((await retrieve('brain_entity',{query:first.entityId})).isError).toBe(true);vi.unstubAllEnvs();
  fs.rmSync(store.root,{recursive:true,force:true});expect(JSON.parse((await retrieve()).result).error.code).toBe('not-found');
});

it('cancels during retained-source permission checks before releasing a result',async()=>{
  const first=await ingest('a/source.md'),controller=new AbortController();
  vi.spyOn(hooks,'checkHooksAllow').mockImplementation(async(_event,context)=>{if(context.toolArgs?.operation==='brain-read-retained-source')controller.abort();return {allowed:true};});
  await expect(retrieve('brain_entity',{query:first.entityId},controller.signal)).rejects.toThrow();
});

it('returns labelled UTF-8 source excerpts from the source project even with an isolated files root',async()=>{
  const first=await ingest('a/source.md','A portable design '+('🚀'.repeat(1500))),saved=ledger.read(f.cwd),filesRoot=join(f.root,'isolated');fs.mkdirSync(filesRoot);fs.mkdirSync(join(filesRoot,'a'));fs.writeFileSync(join(filesRoot,'a/source.md'),'Different isolated candidate.');
  guard=new ExecutionGuard({ledger,manifestHash:saved.projection.manifestHash,agentId:'a',maxOutputTokens:100,workspace:{filesRoot,assertIdentity:()=>{}}},f.cwd);
  const result=JSON.parse((await retrieve('brain_entity',{query:first.entityId})).result),excerpt=result.sources[0].excerpt;
  expect(excerpt).toContain('A portable design');expect(excerpt).not.toContain('Different isolated candidate');expect(excerpt).not.toContain('�');expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(4096);expect(result.sources[0].excerptTruncated).toBe(true);expect(result.entity.freshness).toBe('current');
});
