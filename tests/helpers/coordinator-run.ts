import * as fs from 'node:fs';
import {join} from 'node:path';
import {toyPlan} from './orchestration-plan.js';
import {RunStore,prepareRun,changePreparedRun,prepareAgentExecution,ExecutionStore,type ProjectPlan} from '../../src/orchestration/index.js';
export function verifiedPlan():ProjectPlan {
  const plan=toyPlan();plan.version=2;
  for(const task of plan.tasks)task.acceptanceChecks=[{id:'output-check',artifactId:task.outputs[0]!.id,kind:'contains',expected:'public toy',criteria:['task:0','agent:0']}];
  return plan;
}
export async function coordinatorRun(root:string,plan=verifiedPlan()) {
  const project=join(root,'project');fs.mkdirSync(project);fs.mkdirSync(join(project,'a'));fs.mkdirSync(join(project,'b'));fs.writeFileSync(join(project,'plan.json'),JSON.stringify(plan));
  const runs=new RunStore(join(root,'runs')),prepared=await prepareRun(project,'plan.json',{store:runs}),view=await changePreparedRun(project,prepared.run.id,'approved',{store:runs});
  const authority=await prepareAgentExecution(project,view.run.id,'coordinator',10,{store:runs});const budget=authority.ledger.read(project).manifest;
  const store=new ExecutionStore(join(runs.root,view.run.id),view.manifest);store.create({version:1,runId:view.run.id,manifestHash:view.manifest.hash,approvalRevision:view.run.revision,createdAt:new Date(budget.createdAt).toISOString(),deadline:budget.deadline});
  return{project,runs,view,authority,store};
}
