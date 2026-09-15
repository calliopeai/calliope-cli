import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {providerQuote,costCapNanos,projectAttemptBudget} from '../src/execution/index.js';
import {projectBudgetPath,loadProjectSpend} from '../src/budget.js';
import type {RouteCandidate} from '../src/routing/index.js';
let project:string,route:RouteCandidate;
beforeEach(()=>{config.resetConfig();project=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-quotes-')));route={provider:'deepseek',model:'toy',target:'a'.repeat(64),evidence:'live',discoveredAt:new Date().toISOString(),capabilities:{chat:true,tools:true,streaming:true},contextLength:1000,maxOutputTokens:100,price:{input:1,output:2},estimatedCost:null,latencyMs:null,errorRate:null,score:0,reason:'test'};});
afterEach(()=>{config.resetConfig();vi.restoreAllMocks();fs.rmSync(dirname(projectBudgetPath(project)),{recursive:true,force:true});fs.rmSync(project,{recursive:true,force:true});});
it('reserves discovered capacity, rounds cost bounds conservatively and refuses stale or incompatible evidence',()=>{
  expect(providerQuote(route,[{role:'user',content:'public toy'}],[],true,10)).toMatchObject({inputTokens:1000,outputTokens:10,costNanos:1020000});expect(costCapNanos(0.0000000019)).toBe(1);
  for(const cap of [-1,NaN,Infinity,1e100])expect(()=>costCapNanos(cap)).toThrow();
  for(const patch of [{evidence:'explicit-unverified'}, {discoveredAt:null},{discoveredAt:'bad'},{discoveredAt:new Date(Date.now()-300001).toISOString()},{discoveredAt:new Date(Date.now()+10000).toISOString()},{contextLength:0},{contextLength:1.5},{maxOutputTokens:9},{price:null},{price:{input:1,output:-1}},{capabilities:{chat:false}}])expect(()=>providerQuote({...route,...patch} as RouteCandidate,[],[],false,10)).toThrow();
  expect(()=>providerQuote(undefined,[],[],false,10)).toThrow();expect(()=>providerQuote(route,[],[],false,0)).toThrow();
  for(const capabilities of [{},{chat:true},{chat:true,tools:true}])expect(()=>providerQuote({...route,capabilities},[],[{name:'read_file'} as any],true,10)).toThrow(/confirm/);
  expect(()=>providerQuote({...route,capabilities:{tools:false}},[],[{name:'read_file'} as any],false,10)).toThrow();expect(()=>providerQuote({...route,capabilities:{streaming:false}},[],[],true,10)).toThrow();
  expect(()=>providerQuote(route,[{role:'user',content:[{type:'image',data:'toy'} as any]}],[],false,10)).toThrow(/Multimodal/);
});
it('admits live local backends with explicit zero cost when discovery has no price field',()=>{
  const local={...route,provider:'ollama' as const,price:undefined};
  expect(providerQuote(local,[{role:'user',content:'public toy'}],[],false,10)).toMatchObject({inputPrice:0,outputPrice:0,costNanos:0});
});
it('rejects changed attempts and cancelled admission, and accounts for retries without crediting errors',async()=>{
  config.set('budget',{maxCostPerProject:0.003});const signal=new AbortController(),events:string[]=[];
  const budget=projectAttemptBudget(project,randomUUID(),route,[],[],false,10,signal.signal,(_id,stage)=>events.push(stage));
  const attempt={provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10};
  await expect(budget.reserve({...attempt,model:'changed'})).rejects.toMatchObject({code:'authority'});expect(loadProjectSpend(project).spentUsd).toBe(0);
  const first=await budget.reserve(attempt);await budget.settle(first,'error',{inputTokens:0,outputTokens:0});expect(loadProjectSpend(project).spentUsd).toBe(0.00102);
  const second=await budget.reserve(attempt);await budget.settle(second,'success',{inputTokens:1,outputTokens:1});expect(loadProjectSpend(project).spentUsd).toBe(0.001023);
  signal.abort();await expect(budget.reserve(attempt)).rejects.toMatchObject({name:'AbortError'});expect(events).toEqual(['reserved','unknown','reserved','settled']);
});
it('freezes ordinary capped requests on invalid usage without letting them recover spend',async()=>{
  const budget=projectAttemptBudget(project,randomUUID(),route,[],[],false,10),attempt={provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10};
  const id=await budget.reserve(attempt);await expect(budget.settle(id,'success',{inputTokens:-1,outputTokens:0})).rejects.toMatchObject({code:'budget'});expect(loadProjectSpend(project).spentUsd).toBe(0.00102);await expect(budget.reserve(attempt)).rejects.toMatchObject({code:'budget'});
});

it('binds OpenRouter prices to admission and retains a failed reservation across restart',async()=>{
  route.provider='openrouter';route.price={input:25,output:75};config.set('budget',{maxCostPerProject:0.026});
  const runId=randomUUID(),budget=projectAttemptBudget(project,runId,route,[],[],false,10);
  expect(budget.priceCeiling).toEqual({input:25,output:75});expect(Object.isFrozen(budget.priceCeiling)).toBe(true);
  route.price.input=0;
  const attempt={provider:route.provider,model:route.model,target:route.target,maxOutputTokens:10,priceCeiling:budget.priceCeiling};
  for(const priceCeiling of [undefined,{input:0,output:75},{input:25,output:1}])
    await expect(budget.reserve({...attempt,priceCeiling})).rejects.toMatchObject({code:'authority'});
  const id=await budget.reserve(attempt);await budget.settle(id,'error');expect(loadProjectSpend(project).spentUsd).toBe(0.02575);
  route.price.input=25;const restarted=projectAttemptBudget(project,runId,route,[],[],false,10);
  await expect(restarted.reserve(attempt)).rejects.toMatchObject({code:'budget'});
});
