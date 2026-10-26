import {authorizeSessionAction} from '../session-management/index.js';
import {inspectExecution} from './coordinator-actions.js';
import {RunStore} from './store.js';
import {OrchestrationError} from './types.js';
import type {RunActionOptions} from './actions.js';

export function interruptionRecoveryCapabilities() {
  return {version:1,owner:'calliope-cli',eventVersion:10,semantics:'record-interruption-without-execution'} as const;
}

/** Record a confirmed dead coordinator without retrying work or settling charges. */
export async function recoverInterruptedExecution(cwd:string,runId:string,revision:string,options:RunActionOptions={}) {
  const initial=await inspectExecution(cwd,runId,options),{store,execution,owner}=initial;
  if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))throw new OrchestrationError('invalid','Recovery requires the observed execution revision.');
  if(!execution||execution.state.status!=='running'||!execution.state.ownerId||!owner||owner.alive||owner.id!==execution.state.ownerId)
    throw new OrchestrationError('conflict','Recovery requires a confirmed dead matching coordinator.');
  store.assertRevision(revision);store.assertApproval(execution.header);
  const authority=initial.view.manifest.version===2?(await import('../goals/index.js')).goalRunAuthority(initial.view.manifest,(options.store??new RunStore()).root):undefined;
  authority?.assertActive();
  await authorizeSessionAction(cwd,'orchestration_recover',{path:cwd,runId,revision,ownerId:owner.id,
    planHash:execution.state.graph?.hash??initial.view.manifest.planHash,operation:'Record interrupted work without execution, retry or budget settlement.'},options);
  const currentOwner=store.owner();
  if(!currentOwner||currentOwner.alive||currentOwner.id!==owner.id||currentOwner.pid!==owner.pid)
    throw new OrchestrationError('conflict','Coordinator ownership changed during recovery review.');
  const lease=store.acquire();
  try {
    await store.append({type:'interruption_recovered',ownerId:owner.id,source:options.source==='repl'?'repl':'cli'},options.signal,undefined,()=>{
      lease.check();store.assertRevision(revision);store.assertApproval(execution.header);authority?.assertActive();
    });
    return store.read();
  }finally{lease.release();}
}
