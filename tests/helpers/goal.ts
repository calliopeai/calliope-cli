import * as fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {projectIdentity} from '../../src/approvals/index.js';
import {GoalStore,signed,type GoalManifest,type GoalAllocation,type GoalProposal} from '../../src/goals/index.js';
import {RunStore,analyzePlan,changePreparedRun,prepareAgentExecution,type ProjectPlan} from '../../src/orchestration/index.js';
import {verifiedPlan} from './coordinator-run.js';
export function toyGoal(project:string,runsRoot:string):GoalManifest {
  const identity=projectIdentity(project),now=Date.now();return signed({version:1 as const,id:randomUUID(),createdAt:new Date(now).toISOString(),deadline:now+30000,project:{root:identity.project,key:identity.projectKey},runsRoot,goal:'Inspect the public toy project and propose bounded work.',preference:{provider:'auto'},workspace:{allowedTools:['read_file','write_file','list_files','think','edit_file'],allowedPaths:[{path:'.',access:'write' as const}]},limits:{tokenBudget:20000,costBudgetNanos:100000000,timeBudgetMs:30000,planningTokens:5000,planningCostNanos:10000000,planningTimeMs:10000,maxOutputTokens:100,maxAgents:4,maxTasks:4,maxDepth:2,maxConcurrent:2}});
}
export function toyPlanner(manifest:GoalManifest):ProjectPlan {
  return{version:2,id:'planner',goal:manifest.goal,workspace:{id:'workspace',root:'.',allowedTools:['read_file','list_files','think'],allowedPaths:[{path:'.',access:'read'}]},limits:{maxAgents:1,maxTasks:1,maxDepth:0,maxConcurrent:1,tokenBudget:5000,costBudgetUsd:0.01,timeBudgetMs:10000},agents:[{id:'planner',parentId:null,role:'Planner',objective:'Propose a bounded plan.',inputs:[],allowedTools:['read_file','list_files','think'],allowedPaths:[{path:'.',access:'read'}],preference:{provider:'auto'},tokenBudget:5000,costBudgetUsd:0.01,timeBudgetMs:10000,maxChildDepth:0,maxChildCount:0,acceptanceCriteria:['Return a proposed plan.'],escalationPolicy:{onFailure:'human',maxRetries:0}}],tasks:[{id:'propose',agentId:'planner',objective:'Return a proposed plan.',inputs:[],outputs:[{id:'proposal',kind:'report',description:'Proposed plan JSON.'}],dependencies:[],acceptanceCriteria:['The plan is a proposal, not completed work.'],acceptanceChecks:[]}]};
}
export async function goalFixture(root:string){
  const project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.mkdirSync(join(project,'b'));const runs=new RunStore(join(root,'runs')),goals=new GoalStore(join(root,'goals')),manifest=toyGoal(project,runs.root);goals.create(manifest);
  const plan=toyPlanner(manifest),analysis=analyzePlan(plan),allocation:GoalAllocation={id:randomUUID(),phase:'planning',runId:randomUUID(),planHash:analysis.hash,tokens:5000,costNanos:10000000,deadline:Date.parse(manifest.createdAt)+10000};
  await goals.append(manifest.id,{type:'planning_allocated',allocation});
  const binding={id:allocation.runId,createdAt:manifest.createdAt,goal:{version:1 as const,root:goals.root,id:manifest.id,manifestHash:manifest.hash,allocationId:allocation.id,phase:'planning' as const}};
  const prepared=await runs.prepare(analysis,project,{kind:'goal',path:'goal-plan.json',sha256:analysis.hash},undefined,binding),view=await changePreparedRun(project,prepared.run.id,'approved',{store:runs});
  const authority=await prepareAgentExecution(project,view.run.id,'planner',100,{store:runs});return{project,runs,goals,manifest,allocation,view,authority};
}
export function toyProposal(manifest:GoalManifest,allocation:GoalAllocation,plan=verifiedPlan()):GoalProposal {
  return signed({version:1 as const,goalId:manifest.id,goalManifestHash:manifest.hash,plan,planHash:analyzePlan(plan).hash,knowledgeStatus:'proposed' as const,confidence:null,inferred:true,source:{kind:'agent' as const,runId:allocation.runId,artifactId:'proposal',artifactHash:'a'.repeat(64),eventId:randomUUID()}});
}
