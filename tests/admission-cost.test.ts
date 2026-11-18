/** Real runtime, SDK and durable ledgers; only provider HTTP is synthetic. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {clearModelCache} from '../src/model-detection.js';
import {providerTarget} from '../src/health/index.js';
import {runTurn} from '../src/runtime/index.js';
import {RunLog,readRunLog} from '../src/runlog.js';
import {ReservationLedger,manifestHash} from '../src/execution/index.js';
import {loadProjectSpend,projectBudgetPath} from '../src/budget.js';
import {executionManifest} from './helpers/execution-manifest.js';
let root:string,project:string,requests:number,metadata:Record<string,unknown>,reported:boolean;
beforeEach(()=>{
 config.resetConfig();saveHooks([]);clearModelCache();root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-admission-cost-')));project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));requests=0;reported=true;
 for(const provider of config.getProviderNames()){const names=config.getProviderEnvVars(provider);for(const name of [names.apiKey,names.baseUrl])if(name)vi.stubEnv(name,'');}
 config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://cost.invalid/v1'});
 config.set('budget',{maxCostPerProject:4});
 metadata={id:'toy',context_length:65536,max_output_tokens:100,capabilities:{chat:true,tools:true,streaming:true}};
 const file=join(root,'billing.json');vi.stubEnv('CALLIOPE_BILLING_FILE',file);
 fs.writeFileSync(file,JSON.stringify({version:2,profiles:[{version:2,provider:'deepseek',model:'toy',target:providerTarget('deepseek').key,checkedAt:Date.now(),expiresAt:Date.now()+60000,sources:['https://example.invalid/prices'],prices:{input:2,output:10},capabilities:{chat:true,tools:true,streaming:true},admission:'reviewed-full-context-v1',limits:{contextLength:65536,maxOutputTokens:100}}]}),{mode:0o600});
 vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
  const request=new Request(input,init);expect(new URL(request.url).origin).toBe('https://cost.invalid');
  const body=request.method==='GET'?{data:[metadata]}:(requests++,{id:'toy',object:'chat.completion',model:'toy',choices:[{index:0,message:{role:'assistant',content:'Done.'},finish_reason:'stop'}],...(reported?{usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}:{})});
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 }));
});
afterEach(()=>{config.resetConfig();saveHooks([]);clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
async function execute(mode:'agent'|'project'){
 const manifest=executionManifest(project);manifest.tokenBudget=500000;manifest.costBudgetNanos=4000000000;for(const account of manifest.accounts){account.tokenBudget=account.id==='root'?500000:200000;account.costBudgetNanos=account.id==='root'?4000000000:1000000000;}
 const ledger=new ReservationLedger(join(root,'ledger'));ledger.create(manifest);const log=RunLog.open(randomUUID(),{enabled:true,dir:join(root,'logs')});
 const result=await runTurn({cwd:project,provider:'deepseek',model:'toy',sessionId:randomUUID(),prompt:'Return done.',messages:{current:[{role:'user',content:'Return done.'}]},tools:()=>[],disableCompression:true,maxIterations:1,runlog:log,...(mode==='agent'?{execution:{ledger,manifestHash:manifestHash(manifest),agentId:'a',maxOutputTokens:10}}:{})});
 await log.flush();return {result,ledger,events:readRunLog(log.filePath)};
}
it.each(['agent','project'] as const)('uses admitted rates for %s totals when discovery prices are absent',async mode=>{
 const {result,ledger,events}=await execute(mode);expect(result.reason).toBe('completed');expect(requests).toBe(1);expect(result.totals.cost).toBeCloseTo(.000044,12);
 expect(events.find(e=>e.type==='assistant_message')).toMatchObject({usageReported:true,costSource:'admission',cost:result.totals.cost});expect(loadProjectSpend(project).spentUsd).toBeCloseTo(result.totals.cost,12);
 if(mode==='agent')expect(ledger.read(project).projection.spent.costNanos).toBe(44000);
});
it.each(['agent','project'] as const)('preserves the higher admitted rate basis for %s totals',async mode=>{
 metadata.pricing={input:1,output:2};const {result,ledger,events}=await execute(mode);expect(result.reason).toBe('completed');expect(requests).toBe(1);expect(result.totals.cost).toBeCloseTo(.000044,12);
 expect(events.find(e=>e.type==='assistant_message')).toMatchObject({costSource:'admission'});expect(loadProjectSpend(project).spentUsd).toBeCloseTo(result.totals.cost,12);
 if(mode==='agent'){const saved=ledger.read(project).projection;expect(Object.values(saved.requests)[0]!.reservation).toMatchObject({inputPrice:2,outputPrice:10});expect(saved.spent.costNanos).toBe(44000);}
});
it.each(['agent','project'] as const)('keeps missing %s response usage unknown and its reservation held',async mode=>{
 reported=false;const {result,ledger,events}=await execute(mode);expect(result.reason).toBe('completed');expect(result.totals.cost).toBe(0);
 expect(events.find(e=>e.type==='assistant_message')).toMatchObject({usageReported:false,costSource:'admission',cost:0});expect(loadProjectSpend(project).spentUsd).toBeGreaterThan(0);
 if(mode==='agent')expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');
});

it.each(['agent','project'] as const)('uses the ledger nano-dollar rounding for %s response estimates',async mode=>{
 const file=process.env.CALLIOPE_BILLING_FILE!,profile=JSON.parse(fs.readFileSync(file,'utf8'));profile.profiles[0].prices={input:2.000001,output:10.000001};fs.writeFileSync(file,JSON.stringify(profile));
 const {result,ledger}=await execute(mode);expect(result.reason).toBe('completed');expect(result.totals.cost).toBe(.00004401);expect(loadProjectSpend(project).spentUsd).toBe(result.totals.cost);
 if(mode==='agent')expect(ledger.read(project).projection.spent.costNanos).toBe(44010);
});
