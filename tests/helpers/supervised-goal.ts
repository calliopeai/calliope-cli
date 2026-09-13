import {verifiedPlan} from './coordinator-run.js';
import type {GoalSupervision} from '../../src/goals/index.js';
export const goalImage='sha256:'+'a'.repeat(64);
export const goalSupervision=():GoalSupervision=>({version:1,image:goalImage,maxRounds:4,maxStalledRounds:2,maxOutputTokens:100,principle:'robustness',allowedActions:['retry','replan','decompose'],controller:{provider:'deepseek',model:'controller-toy'},reviewer:{provider:'deepseek',model:'reviewer-toy'}});
export function supervisedGoalPlan(){
  const p=verifiedPlan();p.version=4;p.tasks=p.tasks.slice(0,1);p.agents=p.agents.slice(0,2);
  p.limits.tokenBudget=60000;p.limits.costBudgetUsd=0.1;p.limits.timeBudgetMs=60000;
  p.workspace.allowedTools.push('shell');p.workspace.isolation={version:1,image:goalImage};
  for(const agent of p.agents){agent.allowedTools.push('shell');agent.timeBudgetMs=60000;agent.tokenBudget=agent.parentId?20000:60000;agent.costBudgetUsd=agent.parentId?0.03:0.1;}
  const reviewer=structuredClone(p.agents[1]!);reviewer.id='reviewer';reviewer.allowedTools=['read_file'];reviewer.allowedPaths=[{path:'.',access:'read'}];p.agents.push(reviewer);
  const task=p.tasks[0]!;task.outputs.push({id:'patch',kind:'patch',description:'Candidate diff.'},{id:'tests',kind:'test_result',description:'Verification result.'});
  task.isolation={patchArtifactId:'patch',commands:[{artifactId:'tests',argv:['node','check.js'],timeoutMs:3000}]};
  task.acceptanceChecks!.push({id:'tests-pass',artifactId:'tests',kind:'command',criteria:['task:0','agent:0']});
  const {image,controller,reviewer:preference,...policy}=goalSupervision();p.supervision={...policy,controllerId:'coordinator',reviewerId:'reviewer'};return p;
}
