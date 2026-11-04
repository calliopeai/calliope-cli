/** Host an existing reviewed allowance; native graph admission remains the only writer of children. */
import {dirname,join} from 'node:path';
import {getProviderNames} from '../config.js';
import {providerTarget} from '../health/target.js';
import {canonicalJson,digest} from '../approvals/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {accountLineage,identifier,integer} from '../execution/authority.js';
import type {TaskRequestAttribution} from '../execution/attribution.js';
import {effectiveExecutionManifest} from '../execution/child-grants.js';
import {createLedgerServer} from '../execution/ledger-server.js';
import {LedgerServerState,mintLedgerToken} from '../execution/ledger-protocol.js';
import {ExecutionLimitError,type ChildGrant} from '../execution/types.js';
import type {ReservationLedger} from '../execution/ledger.js';
import {inspectSpawnAuthority} from '../spawning/authority.js';
import {RunStore} from './store.js';
import {ExecutionStore} from './execution-store.js';
import {agentStopped} from './execution-journal.js';
import {prepareAgentExecution} from './execution.js';
import type {RunActionOptions} from './actions.js';
import {matchesAgentRouting,taskSmartSelection} from './routing.js';

export const REVIEWED_LEDGER_CAPABILITY={version:1,ownerScope:1,tokenVersion:2,reviewedAuthority:1,endpointBinding:1,grants:'native-admissions-only'} as const;
export const REVIEWED_TASK_LEDGER_CAPABILITY={version:2,ownerScope:1,tokenVersion:2,reviewedAuthority:1,taskBinding:1,endpointBinding:1,grants:'unavailable'} as const;

interface ReviewedTaskBinding {agentId:string;ownerId:string;attribution:TaskRequestAttribution}
function currentTask(history:ExecutionStore,taskId:string,attempt:number):ReviewedTaskBinding {
  identifier(taskId);integer(attempt,1,4);
  const current=history.read(),task=current.state.tasks[taskId];
  const event=[...current.events].reverse().find(event=>event.change.type==='task_started'&&event.change.taskId===taskId);
  const owner=[...current.events].reverse().find(event=>event.change.type==='started');
  if(current.state.status!=='running'||!current.state.ownerId||!task||task.status!=='running'||task.attempts!==attempt||
    !owner||owner.change.type!=='started'||owner.change.ownerId!==current.state.ownerId||!event||event.sequence<=owner.sequence||
    event.change.type!=='task_started'||event.change.attempt!==attempt||event.change.requestAttribution!==1||event.change.sessionId!==task.sessionId)
    throw new ExecutionLimitError('authority','Task requires its current attributed native attempt.');
  return {agentId:task.agentId,ownerId:current.state.ownerId,attribution:{version:1,kind:'task',eventId:event.id,eventHash:event.hash,
    sessionId:event.change.sessionId,taskId,attempt}};
}

/** Bind a child to a native start event; this neither dispatches nor takes task ownership. */
export async function prepareReviewedTaskLedger(cwd:string,runId:string,taskId:string,attempt:number,maxOutputTokens:number,options:RunActionOptions={}) {
  const runs=options.store??new RunStore(),view=await runs.read(runId,cwd,options.signal);
  const binding=currentTask(new ExecutionStore(join(runs.root,runId),view.manifest),taskId,attempt);
  return prepareReviewedHost(cwd,runId,binding.agentId,maxOutputTokens,{...options,store:runs},binding);
}

/** Returns an unbound server and a private owner token. Only the trusted host listens or delivers credentials. */
export async function prepareReviewedLedger(cwd:string,runId:string,agentId:string,maxOutputTokens:number,options:RunActionOptions={}) {
  return prepareReviewedHost(cwd,runId,agentId,maxOutputTokens,options);
}
async function prepareReviewedHost(cwd:string,runId:string,agentId:string,maxOutputTokens:number,options:RunActionOptions,task?:ReviewedTaskBinding) {
  const captureTargets=()=>Object.fromEntries(getProviderNames().map(provider=>[provider,providerTarget(provider).key]));
  const targets=Object.freeze(captureTargets());
  const runs=options.store??new RunStore(),execution=await prepareAgentExecution(cwd,runId,agentId,maxOutputTokens,{...options,store:runs,reviewedProviderTargets:targets});
  const ledger=execution.ledger as ReservationLedger,view=await runs.read(runId,cwd,options.signal),history=new ExecutionStore(join(runs.root,runId),view.manifest);
  const assertOwner=()=>{
    throwIfCancelled(options.signal);execution.assertAuthority!();
    if(canonicalJson(captureTargets())!==canonicalJson(targets))throw new ExecutionLimitError('authority','Reviewed provider endpoint configuration changed.');
    if(task&&canonicalJson(currentTask(history,task.attribution.taskId,task.attribution.attempt))!==canonicalJson(task))throw new ExecutionLimitError('authority','Native task execution binding changed.');
  };
  const assertAccount=(id:string)=>{
    assertOwner();
    if(task&&id!==task.agentId)throw new ExecutionLimitError('authority','Task endpoint cannot act for another account.');
    const current=history.exists()?inspectSpawnAuthority(history,ledger):undefined,context=current?.context??view.manifest;
    const agent=context.plan.agents.find(agent=>agent.id===id);
    if(!agent||current&&agentStopped(current.view.state,context,id))throw new ExecutionLimitError('authority','Account is not active in the reviewed native graph.');
    return agent;
  };
  const assertGrant=(grant:ChildGrant)=>{
    assertOwner();
    const admitted=history.exists()?inspectSpawnAuthority(history,ledger).view.state.graph?.admissions.find(entry=>entry.grant.grant.id===grant.id):undefined;
    if(!admitted||canonicalJson(admitted.grant.grant)!==canonicalJson(grant))throw new ExecutionLimitError('authority','Child grant requires its existing native reviewed admission.');
    for(const account of grant.accounts)assertAccount(account.id);
  };
  assertAccount(agentId);
  const saved=ledger.read(cwd),effective=effectiveExecutionManifest(saved.manifest,saved.projection),deadline=Math.min(...accountLineage(effective,agentId).map(account=>account.deadline));
  if(Date.now()>=deadline)throw new ExecutionLimitError('deadline','Original owner allowance expired.');
  history.create({version:1,runId,manifestHash:view.manifest.hash,approvalRevision:view.run.revision,createdAt:new Date(saved.manifest.createdAt).toISOString(),deadline:saved.manifest.deadline});
  assertAccount(agentId);
  const authority=digest(canonicalJson({version:1,runId,manifestHash:view.manifest.hash,approvalRevision:view.run.revision,providerTargets:targets,
    ...(task?{task:{...task,maxOutputTokens}}:{})}));
  const state=new LedgerServerState(join(dirname(ledger.root),`${runId}.ledger-server`));
  const server=createLedgerServer({ledger,cwd,state,ownerAgentId:agentId,authority,assertAuthority:assertOwner,assertAccountAuthority:assertAccount,assertGrantAuthority:assertGrant,
    ...(task?{taskExecution:{attribution:task.attribution,maxOutputTokens}}:{}),
    assertReservationAuthority:reservation=>{
      const agent=assertAccount(reservation.agentId);
      if(targets[reservation.provider]!==reservation.target)throw new ExecutionLimitError('authority','Request changes a reviewed provider endpoint.');
      const selection=agent.routing?taskSmartSelection(agent.routing,history.read().events,task?.attribution.taskId):undefined;
      if(!matchesAgentRouting(agent,reservation.provider,reservation.model,selection))throw new ExecutionLimitError('authority','Request exceeds the reviewed provider, model or Smart routing stage.');
      if(reservation.outputTokens>maxOutputTokens)throw new ExecutionLimitError('budget','Request exceeds the reviewed host output limit.');
    }});
  const ownerToken=mintLedgerToken(state.secret(),{v:2,authority,run:runId,role:'parent',owner:agentId,exp:deadline});
  return {server,ownerToken,execution:task?{...execution,assertAuthority:assertOwner,attribution:structuredClone(task.attribution)}:execution,deadline,
    capability:task?REVIEWED_TASK_LEDGER_CAPABILITY:REVIEWED_LEDGER_CAPABILITY};
}
