import { randomUUID } from 'node:crypto';
import { projectIdentity } from '../../src/approvals/index.js';
import type { ExecutionManifest } from '../../src/execution/index.js';
export function executionManifest(project:string,now=Date.now()):ExecutionManifest {
  const identity=projectIdentity(project), deadline=now+60000;
  const allowedTools=['think','read_file','write_file','edit_file','list_files'],allowedPaths=[{path:'.',access:'write' as const}];
  return {version:1,runId:randomUUID(),planHash:'a'.repeat(64),project:{root:identity.project,key:identity.projectKey},createdAt:now,deadline,
    tokenBudget:4000,costBudgetNanos:10000000,accounts:[
      {id:'root',parentId:null,tokenBudget:4000,costBudgetNanos:10000000,deadline,allowedTools:[...allowedTools],allowedPaths},
      {id:'a',parentId:'root',tokenBudget:2000,costBudgetNanos:5000000,deadline,allowedTools:[...allowedTools],allowedPaths:[{path:'a',access:'write'}]},
      {id:'b',parentId:'root',tokenBudget:2000,costBudgetNanos:5000000,deadline,allowedTools:[...allowedTools],allowedPaths:[{path:'b',access:'read'}]},
    ]};
}
