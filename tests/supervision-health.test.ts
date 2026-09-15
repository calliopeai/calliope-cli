import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as config from '../src/config.js';
import {HealthStore,providerTarget} from '../src/health/index.js';
import type {ExecutionProjection} from '../src/orchestration/index.js';
import {supervisionHealthEvidence,validateSupervisionHealthEvidence} from '../src/supervision/index.js';
import {supervisedGoalPlan} from './helpers/supervised-goal.js';

let directory:string,now:number,store:HealthStore;
beforeEach(()=>{
  config.resetConfig();directory=fs.mkdtempSync(join(tmpdir(),'calliope-supervision-health-'));now=Date.parse('2026-09-14T12:00:00.000Z');
  config.setProviderCred('deepseek',{apiKey:'synthetic',baseUrl:'https://user:secret@health.invalid/private?api_key=secret'});
  store=new HealthStore(directory,{},()=>now);
});
afterEach(()=>{fs.rmSync(directory,{recursive:true,force:true});config.resetConfig();vi.restoreAllMocks();vi.unstubAllEnvs();});
const state=()=>({routes:{}} as unknown as ExecutionProjection);
const append=(observation:Parameters<HealthStore['append']>[0])=>{now+=10;return store.append(observation);};

it('captures only plan-relevant sanitized health and binds it to immutable event identities',()=>{
  const deepseek=providerTarget('deepseek'),openai=providerTarget('openai');
  append({provider:'deepseek',target:deepseek.key,type:'attempt',outcome:'success',durationMs:100,retryIndex:0});
  append({provider:'deepseek',target:deepseek.key,type:'attempt',outcome:'timeout',failure:'timeout',durationMs:300,retryIndex:1});
  append({provider:'deepseek',target:deepseek.key,type:'discovery',outcome:'success',durationMs:20,modelCount:2});
  append({provider:'deepseek',target:deepseek.key,type:'conformance',outcome:'success',evidenceHash:'a'.repeat(64),capabilities:{tools:true,streaming:true,usage:true}});
  append({provider:'openai',target:openai.key,type:'attempt',outcome:'error',failure:'authentication',httpStatus:401});
  const plan=supervisedGoalPlan();for(const agent of plan.agents)agent.preference={provider:'deepseek',model:'fixture'};
  const evidence=supervisionHealthEvidence(plan,state(),{source:store,now});
  expect(validateSupervisionHealthEvidence(evidence)).toEqual(evidence);
  expect(evidence).toMatchObject({version:1,status:'available',eventCount:4,providers:[{provider:'deepseek',sampleCount:2,latencyMs:200,errorRate:0.5,timeoutRate:0.5,retryRate:0.5,discovery:{status:'success',modelCount:2},capabilities:{tools:true,streaming:true,cancellation:'unknown',usage:true}}]});
  expect(JSON.stringify(evidence)).not.toMatch(/secret|private|api_key|health\.invalid/);
  const frozen=structuredClone(evidence);append({provider:'deepseek',target:deepseek.key,type:'attempt',outcome:'success',durationMs:10});
  expect(evidence).toEqual(frozen);expect(supervisionHealthEvidence(plan,state(),{source:store,now})).not.toMatchObject({historyHash:evidence.historyHash,eventCount:evidence.eventCount});
});

it('represents unreadable history explicitly and rejects malformed or secret-bearing snapshots',()=>{
  const evidence=supervisionHealthEvidence(supervisedGoalPlan(),state(),{source:{settings:store.settings,read:()=>{throw Error('corrupt private history');}},now});
  expect(evidence).toEqual({version:1,observedAt:new Date(now).toISOString(),status:'unavailable',historyHash:null,eventCount:0,providers:[],reason:'local-health-history-unavailable'});
  expect(validateSupervisionHealthEvidence(evidence)).toEqual(evidence);
  const available=supervisionHealthEvidence(supervisedGoalPlan(),state(),{source:store,now});
  for(const bad of [{...available,apiKey:'secret'},{...available,eventCount:-1},{...available,historyHash:'bad'},{...available,providers:[...(available.status==='available'?available.providers:[]),...(available.status==='available'?available.providers:[])]},{...evidence,reason:'healthy'}])expect(()=>validateSupervisionHealthEvidence(bad)).toThrow();
});
