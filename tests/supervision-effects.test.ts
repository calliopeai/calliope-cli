import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {verifiedPlan} from './helpers/coordinator-run.js';
import {supervisionDraftEffect,supervisionDraftHash,buildControllerContext,type ControllerContextInput} from '../src/supervision/index.js';

function fixture(){
  const plan=verifiedPlan();plan.version=4;plan.tasks=plan.tasks.slice(0,2);plan.limits.maxConcurrent=1;
  plan.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
  for(const t of plan.tasks){t.outputs.push({id:t.id+'-patch',kind:'patch',description:'Candidate patch.'});t.isolation={patchArtifactId:t.id+'-patch',commands:[]};}
  plan.supervision={version:1,controllerId:'coordinator',maxRounds:4,maxStalledRounds:2,maxOutputTokens:100,principle:'robustness',allowedActions:['retry','replan','decompose']};
  const eventId=randomUUID(),evidence=new Set([eventId]);
  const base={version:1 as const,reason:'Review the actual receipt.',evidence:[eventId]},improvement={hypothesis:'The correction should pass.',expectedMetric:{name:'checks passed',direction:'increase' as const}};
  return{plan,evidence,base,improvement};
}

it.each(['retry','replan'] as const)('describes %s as one existing task even when admission capacity is exhausted',action=>{
  const {plan,evidence,base,improvement}=fixture();plan.limits.maxAgents=plan.agents.length;plan.limits.maxTasks=plan.tasks.length;
  const draft={...base,...improvement,action,taskId:'inspect-a',...(action==='replan'?{strategy:'Repair A; after it passes, propose a separate retry of B.'}:{})},before=JSON.stringify({plan,draft});
  const effect=supervisionDraftEffect(draft,plan,evidence);
  expect(effect).toMatchObject({version:1,draftHash:supervisionDraftHash(draft),action,retryTaskIds:['inspect-a'],newAgentIds:[],newTaskIds:[],maxConcurrent:1});
  expect(effect.summary).toContain('Other tasks are not retried');expect(JSON.stringify({plan,draft})).toBe(before);
  expect(supervisionDraftEffect({...draft,reason:'A different exact draft.'},plan,evidence).draftHash).not.toBe(effect.draftHash);
});

it.each(['continue','stop'] as const)('describes %s without inventing work or completion',action=>{
  const {plan,evidence,base}=fixture(),effect=supervisionDraftEffect({...base,action},plan,evidence);
  expect(effect).toMatchObject({action,retryTaskIds:[],newAgentIds:[],newTaskIds:[],maxConcurrent:1});expect(effect.summary).toContain('creates no agents');
});

it('names only the agents/tasks proposed for admission and rejects an already applied draft',()=>{
  const {plan,evidence,base,improvement}=fixture(),agent=structuredClone(plan.agents[1]!),task=structuredClone(plan.tasks[0]!);
  agent.id='child';task.id='child-task';task.agentId=agent.id;task.outputs.forEach(o=>{o.id='child-'+o.id;if(o.path)o.path='a/child.txt';});task.isolation!.patchArtifactId='child-inspect-a-patch';task.acceptanceChecks![0]!.artifactId='child-report-a';
  const draft={...base,...improvement,action:'decompose' as const,children:{version:1 as const,parentId:'coordinator',agents:[agent],tasks:[task]}};
  expect(supervisionDraftEffect(draft,plan,evidence)).toMatchObject({retryTaskIds:[],newAgentIds:['child'],newTaskIds:['child-task'],maxConcurrent:1});
  expect(()=>supervisionDraftEffect(draft,{...plan,agents:[...plan.agents,agent],tasks:[...plan.tasks,task]},evidence)).toThrow();
});

it('rejects unknown targets, invented evidence, extra fields and unsupported authority',()=>{
  const {plan,evidence,base,improvement}=fixture(),draft={...base,...improvement,action:'retry',taskId:'inspect-a'};
  for(const change of [{version:2},{taskId:'absent'},{evidence:[randomUUID()]},{taskIds:['inspect-a','inspect-b']},{action:'publish'}])expect(()=>supervisionDraftEffect({...draft,...change},plan,evidence)).toThrow();
  expect(()=>supervisionDraftEffect(draft,{...plan,supervision:{...plan.supervision!,allowedActions:[]}},evidence)).toThrow('does not permit');
  const legacy={...plan,version:3 as const};delete legacy.supervision;expect(()=>supervisionDraftEffect(draft,legacy,evidence)).toThrow('supervised plan');
});

it('adds draft effects only to contexts with an exact draft and preserves its hash',()=>{
  const {plan,evidence,base,improvement}=fixture();
  const context:ControllerContextInput={role:'controller',round:1,plan,tasks:{},outcomes:[],budget:{deadline:30000,spent:{},accounts:{}},strategies:{}};
  const original=JSON.parse(buildControllerContext(context).content);expect(original.version).toBe(1);expect(original).not.toHaveProperty('draftEffect');
  const draft={...base,...improvement,action:'retry' as const,taskId:'inspect-a'};
  context.outcomes=[{eventId:[...evidence][0],summary:'Failed test.'}] as ControllerContextInput['outcomes'];
  const reviewed=JSON.parse(buildControllerContext({...context,role:'reviewer',draft}).content);
  expect(reviewed.draft).toEqual(draft);expect(reviewed.draftHash).toBe(reviewed.draftEffect.draftHash);expect(reviewed.draftEffect.retryTaskIds).toEqual(['inspect-a']);
});
