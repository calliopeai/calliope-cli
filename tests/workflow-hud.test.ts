import {it,expect} from 'vitest';
import React from 'react';
import {render} from 'ink-testing-library';
import {workflowSnapshot,workflowLines,retainWorkflows} from '../src/ui/workflow-progress.js';
import {WorkflowRegion} from '../src/ui/regions/workflow-region.js';
import {handleCommand,type CommandContext} from '../src/ui/commands.js';
import type {CoordinatorProgress} from '../src/orchestration/index.js';
import {verifiedPlan} from './helpers/coordinator-run.js';

function progress():CoordinatorProgress {
  const plan=verifiedPlan();plan.agents[0]!.preference={provider:'anthropic',model:'controller-toy'};plan.agents[1]!.preference={provider:'openai',model:'worker-toy'};
  return{context:{id:'12345678-run',project:{root:'/toy',key:'toy'},plan},execution:{header:{} as never,events:[],state:{version:1,runId:'12345678-run',revision:'first',status:'running',ownerId:'owner',deadline:1,tasks:Object.fromEntries(plan.tasks.map(task=>[task.id,{id:task.id,agentId:task.agentId,status:'pending' as const,attempts:0,sessionId:null,output:null,artifactIds:[],changedFiles:[],mutations:false,escalation:null}])),artifacts:{},stoppedAgents:[]}}};
}
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
it('renders one clipped line per row and changes HUD mode without executing an agent',async()=>{
  const view=workflowSnapshot(progress()),screen=render(React.createElement(WorkflowRegion,{workflows:[view],mode:'agents',width:60}));
  expect(screen.lastFrame()).toContain('12345678');expect(screen.lastFrame()!.split('\n').every(line=>line.length<=60)).toBe(true);
  screen.rerender(React.createElement(WorkflowRegion,{workflows:[view],mode:'off',width:60}));await new Promise(resolve=>setTimeout(resolve,50));expect(screen.lastFrame()).toBe('');screen.unmount();screen.cleanup();
  const modes:string[]=[],messages:string[]=[],ctx={setWorkflowHudMode:(mode:string)=>modes.push(mode),addMessage:(_type:string,text:string)=>messages.push(text)} as unknown as CommandContext;
  await handleCommand('/agents hud workflows',ctx);await handleCommand('/agents hud off',ctx);await handleCommand('/agents hud',ctx);await handleCommand('/agents hud invalid',ctx);await handleCommand('/agents hud off extra',ctx);
  expect(modes).toEqual(['workflows','off','agents']);expect(messages.at(-1)).toContain('Usage:');
});
