import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {verifiedPlan} from './helpers/coordinator-run.js';
import {validateSupervisionPolicy,validateSupervisionDecision,type SupervisionPolicy} from '../src/supervision/index.js';

function fixture() {
  const plan=verifiedPlan();plan.version=3;plan.workspace.isolation={version:1,image:'sha256:'+'a'.repeat(64)};
  for(const task of plan.tasks){task.outputs.push({id:task.id+'-patch',kind:'patch',description:'Candidate patch.'});task.isolation={patchArtifactId:task.id+'-patch',commands:[]};}
  const policy:SupervisionPolicy={version:1,controllerId:plan.agents[0]!.id,maxRounds:4,maxStalledRounds:2,maxOutputTokens:100,principle:'robustness',allowedActions:['retry','replan','decompose']};
  const eventId=randomUUID(),evidence=new Set([eventId]);
  const decision={version:1,action:'replan',reason:'The recorded check failed.',evidence:[eventId],taskId:plan.tasks[0]!.id,strategy:'Use the failed boundary-case evidence while preserving the reviewed checks.',hypothesis:'Correcting the boundary condition will remove the failed check.',expectedMetric:{name:'failed acceptance checks',direction:'decrease'}};
  return{plan,policy,evidence,decision};
}

it('captures bounded controller/reviewer authority and a proposed improvement hypothesis',()=>{
  const {plan,policy,evidence,decision}=fixture();policy.reviewerId=plan.agents[1]!.id;
  plan.agents[1]!.allowedPaths=[{path:'.',access:'read'}];
  const saved=validateSupervisionPolicy(policy,plan);
  expect(saved).toEqual(policy);expect(saved).not.toBe(policy);
  const output=validateSupervisionDecision(decision,saved,plan,evidence);
  expect(output).toEqual(decision);
  expect(output).not.toHaveProperty('accepted');
});

it('does not allow changing ownership, round bounds, principle or isolation authority',()=>{
  const {plan,policy}=fixture();
  for(const changed of [{version:2},{controllerId:plan.agents[1]!.id},{reviewerId:policy.controllerId},{reviewerId:'missing'},{maxRounds:0},{maxRounds:65},{maxStalledRounds:5},{maxOutputTokens:100000000},{principle:'ignore-policy'},{allowedActions:['publish']},{allowedActions:['retry','retry']}]){
    expect(()=>validateSupervisionPolicy({...policy,...changed},plan)).toThrow();
  }
  delete plan.workspace.isolation;
  expect(()=>validateSupervisionPolicy(policy,plan)).toThrow('isolated');
  expect(validateSupervisionPolicy({...policy,allowedActions:[]},plan).allowedActions).toEqual([]);
});

it('rejects invented evidence, unapproved actions and changes to task acceptance',()=>{
  const {plan,policy,evidence,decision}=fixture();
  for(const changed of [{version:2},{evidence:[]},{evidence:[randomUUID()]},{evidence:[...evidence,...evidence]},{taskId:'absent'},{strategy:''},{hypothesis:''},{expectedMetric:{name:'test passes',direction:'invent'}},{acceptanceChecks:[]},{action:'publish'},{action:'continue',strategy:'hidden changes'}]){
    expect(()=>validateSupervisionDecision({...decision,...changed},policy,plan,evidence)).toThrow();
  }
  expect(()=>validateSupervisionDecision(decision,{...policy,allowedActions:['retry']},plan,evidence)).toThrow('does not permit');
  expect(()=>validateSupervisionDecision({...decision,reason:'x'.repeat(65537)},policy,plan,evidence)).toThrow('byte limit');
});

it('allows evidence-backed stop/continue without granting completion or mutation authority',()=>{
  const {plan,policy,evidence}=fixture();
  for(const action of ['continue','stop'])expect(validateSupervisionDecision({version:1,action,reason:'Inspect recorded outcomes.',evidence:[...evidence]},{...policy,allowedActions:[]},plan,evidence).action).toBe(action);
});

it('keeps child proposals as bounded data for the existing admission boundary',()=>{
  const {plan,policy,evidence,decision}=fixture();
  const {taskId,strategy,...common}=decision;
  const agent=structuredClone(plan.agents[1]!);agent.id='child';agent.allowedPaths=[{path:'child',access:'write'}];
  const task=structuredClone(plan.tasks[0]!);task.id='child-task';task.agentId=agent.id;
  task.outputs=[{id:'child-output',kind:'file',path:'child/output.txt',description:'Child result.'},{id:'child-patch',kind:'patch',description:'Child patch.'}];
  task.acceptanceChecks![0]!.artifactId='child-output';task.isolation!.patchArtifactId='child-patch';
  const children={version:1,parentId:policy.controllerId,agents:[agent],tasks:[task]};
  expect(validateSupervisionDecision({...common,action:'decompose',children},policy,plan,evidence)).toMatchObject({action:'decompose',children});
  for(const changed of [{version:2},{parentId:'absent'},{agents:[]},{tasks:[]},{permissions:'all'}])expect(()=>validateSupervisionDecision({...common,action:'decompose',children:{...children,...changed}},policy,plan,evidence)).toThrow();
  expect(()=>validateSupervisionDecision({...common,action:'decompose',children:{...children,agents:[{...agent,tokenBudget:100000000}]}},policy,plan,evidence)).toThrow();
});
