import {it,expect} from 'vitest';
import React from 'react';
import {render} from 'ink-testing-library';
import {workflowSnapshot,workflowLines,retainWorkflows} from '../src/ui/workflow-progress.js';
import {WorkflowRegion} from '../src/ui/regions/workflow-region.js';
import {handleCommand,type CommandContext} from '../src/ui/commands.js';
import type {CoordinatorProgress} from '../src/orchestration/index.js';
import type {SupervisionHealthEvidence,SupervisionProviderHealth} from '../src/supervision/index.js';
import {verifiedPlan} from './helpers/coordinator-run.js';

function progress():CoordinatorProgress {
  const plan=verifiedPlan();plan.agents[0]!.preference={provider:'anthropic',model:'controller-toy'};plan.agents[1]!.preference={provider:'openai',model:'worker-toy'};
  return{context:{id:'12345678-run',project:{root:'/toy',key:'toy'},plan},execution:{header:{} as never,events:[],state:{version:1,runId:'12345678-run',revision:'first',status:'running',ownerId:'owner',deadline:1,tasks:Object.fromEntries(plan.tasks.map(task=>[task.id,{id:task.id,agentId:task.agentId,status:'pending' as const,attempts:0,sessionId:null,output:null,artifactIds:[],changedFiles:[],mutations:false,escalation:null}])),artifacts:{},stoppedAgents:[]}}};
}
const providerHealth=(provider:'anthropic'|'openai',sampleCount=0):SupervisionProviderHealth=>({provider,target:(provider==='anthropic'?'a':'b').repeat(64),sampleCount,latencyMs:sampleCount?120:null,timeoutRate:sampleCount?0:null,retryRate:sampleCount?0.25:null,errorRate:sampleCount?0.25:null,lastSuccessAt:null,lastFailure:null,discovery:{status:'unknown',at:null,modelCount:null},lastSuccessfulConformanceAt:null,capabilities:{tools:'unknown',streaming:'unknown',cancellation:'unknown',usage:'unknown'},quarantine:{active:false,reason:null,expiresAt:null,failures:0},importedEvents:0});
function addHealth(value:CoordinatorProgress,health:SupervisionHealthEvidence){value.execution.events.push({change:{type:'supervision_started',health}} as never);}
it('shows chosen models, actual attempts, review state, and completed evidence without model claims',()=>{
  const value=progress(),state=value.execution.state;state.tasks['inspect-a']!.status='running';state.tasks['inspect-a']!.attempts=2;state.tasks['inspect-b']!.status='review_required';
  const snapshot=workflowSnapshot(value),lines=workflowLines([snapshot],'agents');expect(lines[0]).toContain('0/3 done · 1 review');expect(lines[1]).toContain('openai:worker-toy');expect(lines[1]).toContain('inspect-a 2/2');expect(lines.join('\n')).toContain('anthropic:controller-toy');
  state.tasks['inspect-a']!.status='completed';state.tasks['inspect-b']!.status='failed';state.tasks['inspect-b']!.escalation='parent';expect(workflowLines([workflowSnapshot(value)],'agents').join('\n')).toContain('escalated');
  state.stoppedAgents=['coordinator'];expect(workflowSnapshot(value).agents.every(agent=>agent.label.includes('stopped'))).toBe(true);
});
it('bounds retained workflows and rows, collapses output and sanitizes terminal content',()=>{
  const value=progress();value.context.plan.goal='untrusted\ntext\x1b[31m';const next=workflowSnapshot(value);
  const first=retainWorkflows([],next);expect(retainWorkflows(first,next)).toBe(first);
  let values=first;for(let n=0;n<5;n++)values=retainWorkflows(values,{...next,id:'run-'+n,revision:String(n)});expect(values).toHaveLength(3);
  expect(workflowLines([next],'workflows')).toHaveLength(2);expect(workflowLines([next],'off')).toEqual([]);
  const limited=workflowLines([next],'agents',1);expect(limited.some(line=>line.includes('+2 agents'))).toBe(true);expect(limited.every(line=>!/[\n\x1b]/.test(line))).toBe(true);
  value.context.plan.agents[0]!.preference={provider:'auto'};value.context.plan.agents[1]!.preference={provider:'auto',model:'selected-toy'};value.execution.state.tasks={};expect(workflowSnapshot(value).agents[0]!.label).toContain('coordinating · choice auto:auto');expect(workflowSnapshot(value).agents[1]!.label).toContain('auto:selected-toy');
});
it('shows the latest replayed review health without reading providers or certifying unmeasured evidence',()=>{
  const value=progress(),available:SupervisionHealthEvidence={version:1,observedAt:'2026-09-15T00:00:00.000Z',status:'available',historyHash:'c'.repeat(64),eventCount:4,providers:[providerHealth('anthropic'),providerHealth('openai',4)]};addHealth(value,available);
  const first=workflowSnapshot(value);expect(first.summary).toContain('review health 1/2 sampled');expect(first.agents.find(agent=>agent.id==='coordinator')!.label).toContain('review health unmeasured');expect(first.agents.find(agent=>agent.id==='a')!.label).toContain('review health 25% err, 120ms');expect(workflowSnapshot(structuredClone(value))).toEqual(first);
  available.providers[1]!.quarantine={active:true,reason:'rate_limit',expiresAt:'2026-09-15T00:01:00.000Z',failures:3};const quarantined=workflowSnapshot(value);expect(quarantined.summary).toContain('1 quarantined');expect(quarantined.agents.find(agent=>agent.id==='a')!.label).toContain('quarantined (rate_limit)');
  const sparse:SupervisionHealthEvidence={...available,providers:[{...providerHealth('openai',1),errorRate:null,latencyMs:null,quarantine:{active:true,reason:null,expiresAt:'2026-09-15T00:01:00.000Z',failures:3}}]};addHealth(value,sparse);expect(workflowSnapshot(value).agents.find(agent=>agent.id==='coordinator')!.label).not.toContain('review health');expect(workflowSnapshot(value).agents.find(agent=>agent.id==='a')!.label).toContain('review health quarantined');
  sparse.providers[0]!.quarantine={active:false,reason:null,expiresAt:null,failures:0};expect(workflowSnapshot(value).agents.find(agent=>agent.id==='a')!.label).toContain('review health unknown err');value.context.plan.agents[0]!.preference={provider:'auto'};value.context.plan.agents[1]!.preference={provider:'auto',model:'worker-toy'};expect(workflowSnapshot(value).agents.find(agent=>agent.id==='a')!.label).toContain('review health 1/1 sampled');
  addHealth(value,{version:1,observedAt:'2026-09-15T00:00:01.000Z',status:'unavailable',historyHash:null,eventCount:0,providers:[],reason:'local-health-history-unavailable'});const unavailable=workflowSnapshot(value);expect(unavailable.summary).toContain('review health unavailable');expect(unavailable.agents.every(agent=>agent.label.includes('review health unavailable'))).toBe(true);
  expect(workflowSnapshot(progress()).summary).not.toContain('review health');
});
it('renders one clipped line per row and changes HUD mode without executing an agent',async()=>{
  const value=progress(),health:SupervisionHealthEvidence={version:1,observedAt:'2026-09-15T00:00:00.000Z',status:'available',historyHash:'d'.repeat(64),eventCount:1,providers:[providerHealth('anthropic'),providerHealth('openai',1)]};health.providers[1]!.quarantine={active:true,reason:'rate\n\x1b[31mlimit',expiresAt:null,failures:2};addHealth(value,health);
  const view=workflowSnapshot(value),screen=render(React.createElement(WorkflowRegion,{workflows:[view],mode:'agents',width:60}));
  expect(screen.lastFrame()).toContain('12345678');expect(screen.lastFrame()).not.toContain('\x1b[31m');expect(view.agents.every(agent=>!/[\n\x1b]/.test(agent.label))).toBe(true);expect(screen.lastFrame()!.split('\n').every(line=>line.length<=60)).toBe(true);
  screen.rerender(React.createElement(WorkflowRegion,{workflows:[view],mode:'off',width:60}));await new Promise(resolve=>setTimeout(resolve,50));expect(screen.lastFrame()).toBe('');screen.unmount();screen.cleanup();
  const modes:string[]=[],messages:string[]=[],ctx={setWorkflowHudMode:(mode:string)=>modes.push(mode),addMessage:(_type:string,text:string)=>messages.push(text)} as unknown as CommandContext;
  await handleCommand('/agents hud workflows',ctx);await handleCommand('/agents hud off',ctx);await handleCommand('/agents hud',ctx);await handleCommand('/agents hud invalid',ctx);await handleCommand('/agents hud off extra',ctx);
  expect(modes).toEqual(['workflows','off','agents']);expect(messages.at(-1)).toContain('Usage:');
});
