import {remoteTaskAdmission,type RemoteTaskAdmission} from '../orchestration/remote-task-capacity.js';
import type {RequestAttribution} from './attribution.js';
/** A native run may draw from another reviewed run's account. No synthetic usage or
 * second accounting store: the same provider request is reserved in both ledgers. */
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../approvals/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {RemoteReservationLedger} from './remote-ledger.js';
import {markParentAdmissionUncertain} from './parent-uncertainty.js';
import {ReservationLedger} from './ledger.js';
import {accountLineage,assertExecutionStoreOutsideProject,manifestHash,permits,validateExecutionManifest} from './authority.js';
import {effectiveExecutionManifest} from './child-grants.js';
import {ExecutionLimitError,type ExecutionManifest,type ExecutionAccount,type ChildGrant,type RequestReservation,type RequestSettlement} from './types.js';

const denied=(message:string)=>new ExecutionLimitError('authority',message);
export const parentBudgetCapabilities=()=>({version:1 as const,manifestVersion:2 as const,owner:'calliope-cli' as const,semantics:'charge-native-parent-before-child' as const,maxLinks:8,placement:'same-project-local' as const});
export const remoteParentBudgetCapabilities=()=>({version:1 as const,linkVersion:2 as const,manifestVersion:2 as const,executionEventVersion:13 as const,reservationEventVersion:6 as const,accountMapping:'native-admissions-only' as const,taskConcurrency:'parent-execution-journal' as const,maxLinks:8,transport:'delegation-ledger/v1' as const});
/** Deterministic per-child identity lets an interrupted admission reconcile its
 * existing parent charge; identical caller UUIDs in sibling runs cannot collide. */
export function parentRequestId(child:ExecutionManifest,requestId:string):string {
  const bytes=createHash('sha256').update(canonicalJson({child:manifestHash(child),requestId})).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&0x0f)|0x40;bytes[8]=(bytes[8]!&0x3f)|0x80;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export interface ParentBudgetAuthority {
  ledger:import('./ledger.js').ReservationLedgerAccess;hash:string;assertActive:()=>void;
  validateGrant?:(grant:ChildGrant)=>void;
  refreshAgent?:(agentId:string,signal?:AbortSignal)=>Promise<void>;
  reservation:(request:RequestReservation)=>RequestReservation;
  settlement:(settlement:RequestSettlement)=>RequestSettlement;
}
/** The authenticated owner declares the full retained run ancestry. */
export function budgetRunLineage(input:ExecutionManifest,cwd:string):string[] {
  const ids:string[]=[];let current=validateExecutionManifest(input);
  while(true){
    if(ids.includes(current.runId)||ids.length>=9)throw denied('Parent run ancestry is cyclic or too deep.');
    ids.push(current.runId);if(!current.parent)return ids;
    if(current.parent.version===2){
      const next=[...ids,...current.parent.reviewed.lineage];
      if(next.length>9||new Set(next).size!==next.length)throw denied('Parent run ancestry is cyclic or too deep.');
      return next;
    }
    current=new ReservationLedger(join(current.parent.runsRoot,current.parent.runId,'budget')).read(cwd).manifest;
  }
}
async function remoteParentAuthority(child:ExecutionManifest,cwd:string,admission:boolean,signal?:AbortSignal,seen:string[]=[]):Promise<ParentBudgetAuthority>{
  const link=child.parent;if(!link||link.version!==2)throw denied('Remote parent link required.');
  if([child.runId,...seen].some(id=>link.reviewed.lineage.includes(id))||link.reviewed.lineage.length+seen.length>=9)throw denied('Remote parent ancestry is cyclic or too deep.');
  assertExecutionStoreOutsideProject(child.project.root,dirname(link.tokenFile));assertExecutionStoreOutsideProject(child.project.root,link.checkpointRoot);
  const {readArtifactBytes}=await import('../orchestration/execution-store.js');
  const token=readArtifactBytes(link.tokenFile,8192,true).toString().trim();
  const ledger=await RemoteReservationLedger.connect({url:link.url,token,root:link.checkpointRoot,reviewed:link.reviewed,signal,
    ...(admission?{execution:{cwd,agentId:link.agentId}}:{reconciliation:{cwd,agentId:link.agentId}})});
  if(admission&&!ledger.supportsTaskCapacity)throw new ExecutionLimitError('unavailable','Remote parent lacks native task capacity; upgrade the parent CLI.');
  const saved=ledger.read(cwd),parent=effectiveExecutionManifest(saved.manifest,saved.projection),account=accountLineage(parent,link.agentId)[0]!;
  if(saved.projection.manifestHash!==link.budgetManifestHash||parent.runId!==link.runId||canonicalJson(ledger.executionProject(cwd,link.agentId))!==canonicalJson(child.project)||child.tokenBudget>account.tokenBudget||child.costBudgetNanos>account.costBudgetNanos||child.deadline>account.deadline||child.accounts.some(a=>a.allowedTools.some(tool=>!account.allowedTools.includes(tool))||a.allowedPaths.some(path=>!permits(account.allowedPaths,path.path,path.access))))throw denied('Remote child exceeds its reviewed parent identity or allowance.');
  for(const id of Object.values(link.accountMap))if(!accountLineage(parent,id).some(entry=>entry.id===link.agentId))throw denied('Remote account map exceeds its parent subtree.');
  const mapped=(id:string)=>{const value=link.accountMap[id];if(!value)throw denied('Child account has no native parent admission.');return value;};
  const validateAccounts=(accounts:ExecutionAccount[])=>{for(const own of accounts){
    const original=accountLineage(parent,mapped(own.id))[0]!;
    if((own.parentId===null?original.id!==link.agentId:original.parentId!==mapped(own.parentId))||own.tokenBudget>original.tokenBudget||own.costBudgetNanos>original.costBudgetNanos||own.deadline>original.deadline||own.allowedTools.some(tool=>!original.allowedTools.includes(tool))||own.allowedPaths.some(path=>!permits(original.allowedPaths,path.path,path.access)))throw denied('Child graph exceeds its explicitly admitted native accounts.');
  }};
  validateAccounts(child.accounts);
  const assertActive=()=>{throwIfCancelled(signal);const current=ledger.read(cwd);if(current.projection.manifestHash!==link.budgetManifestHash)throw denied('Remote parent changed.');if(current.projection.exceeded)throw new ExecutionLimitError('budget','Parent usage exceeded its reservation.');if(Date.now()>=account.deadline)throw new ExecutionLimitError('deadline','Parent allowance expired.');};
  if(admission)assertActive();
  return {ledger,hash:link.budgetManifestHash,assertActive,validateGrant:grant=>validateAccounts(grant.accounts),
    refreshAgent:async(agentId,currentSignal)=>{await RemoteReservationLedger.connect({url:link.url,token,root:link.checkpointRoot,reviewed:link.reviewed,signal:currentSignal,execution:{cwd,agentId:mapped(agentId)}});throwIfCancelled(currentSignal);},
    reservation:request=>({...request,id:parentRequestId(child,request.id),agentId:mapped(request.agentId),...(request.remoteAdmission?{remoteAdmission:mappedParentAdmission(child,request.remoteAdmission)}:request.attribution?{remoteAdmission:fundedTaskAdmission(child,request.agentId,request.attribution)}:{})}),settlement:settlement=>({...settlement,requestId:parentRequestId(child,settlement.requestId)})};
}
export async function parentBudgetAuthority(input:ExecutionManifest,cwd:string,admission=true,signal?:AbortSignal,seen:string[]=[]):Promise<ParentBudgetAuthority|undefined>{
  const child=validateExecutionManifest(input),link=child.parent;if(!link)return undefined;
  throwIfCancelled(signal);
  if(link.version===2)return remoteParentAuthority(child,cwd,admission,signal,seen);
  if(seen.includes(child.runId)||seen.length>=8||link.runId===child.runId)throw denied('Parent budget lineage is cyclic or exceeds eight links.');
  assertExecutionStoreOutsideProject(child.project.root,link.runsRoot);
  const {RunStore}=await import('../orchestration/store.js');
  const {ExecutionStore}=await import('../orchestration/execution-store.js');
  const {inspectSpawnAuthority}=await import('../spawning/authority.js');
  const {agentStopped}=await import('../orchestration/execution-journal.js');
  const runs=new RunStore(link.runsRoot),view=await runs.read(link.runId,cwd,signal);
  if(view.manifest.hash!==link.runManifestHash||!view.events.some(event=>event.id===link.approvalRevision&&event.change.type==='approved'))throw denied('Parent budget does not match its reviewed native run.');
  const ledger=new ReservationLedger(join(runs.root,link.runId,'budget')),saved=ledger.read(cwd);
  if(saved.projection.manifestHash!==link.budgetManifestHash||saved.manifest.runId!==link.runId||saved.manifest.planHash!==view.manifest.planHash)throw denied('Parent budget identity changed.');
  const parent=effectiveExecutionManifest(saved.manifest,saved.projection),account=accountLineage(parent,link.agentId)[0]!;
  if(child.project.key!==parent.project.key||child.project.root!==parent.project.root||child.tokenBudget>account.tokenBudget||child.costBudgetNanos>account.costBudgetNanos||child.deadline>account.deadline||child.accounts.some(a=>a.allowedTools.some(tool=>!account.allowedTools.includes(tool))||a.allowedPaths.some(path=>!permits(account.allowedPaths,path.path,path.access))))throw denied('Child budget, clock or scope exceeds its parent account.');
  const store=new ExecutionStore(join(runs.root,link.runId),view.manifest);
  // Reconcile settled work even after cancellation; never require fresh execution authority to record usage.
  const goal=admission?(await import('../goals/index.js')).goalRunAuthority(view.manifest,runs.root):undefined;
  const ancestor=await parentBudgetAuthority(saved.manifest,cwd,admission,signal,[...seen,child.runId]);
  const assertActive=()=>{
    throwIfCancelled(signal);store.assertApproval({approvalRevision:link.approvalRevision});goal?.assertActive();ancestor?.assertActive();
    const current=ledger.read(cwd);if(current.projection.manifestHash!==link.budgetManifestHash)throw denied('Parent budget identity changed.');
    if(current.projection.exceeded)throw new ExecutionLimitError('budget','Parent usage exceeded its reservation; further admission is stopped.');
    if(Date.now()>=account.deadline)throw new ExecutionLimitError('deadline','Parent allowance expired.');
    if(store.exists()){
      const authority=inspectSpawnAuthority(store,ledger);store.assertApproval(authority.view.header);
      if(authority.view.state.status==='completed'||!authority.context.plan.agents.some(agent=>agent.id===link.agentId)||agentStopped(authority.view.state,authority.context,link.agentId))throw denied('Parent account is completed, stopped or not admitted.');
    }else if(!view.manifest.plan.agents.some(agent=>agent.id===link.agentId))throw denied('Parent account is not admitted to the native plan.');
  };
  if(admission)assertActive();
  return {ledger,hash:link.budgetManifestHash,assertActive,
    reservation:(request:RequestReservation):RequestReservation=>{
      return {...request,id:parentRequestId(child,request.id),agentId:link.agentId,...(request.remoteAdmission?{remoteAdmission:mappedParentAdmission(child,request.remoteAdmission)}:request.attribution?{remoteAdmission:fundedTaskAdmission(child,request.agentId,request.attribution)}:{})};
    },
    settlement:(settlement:RequestSettlement):RequestSettlement=>({...settlement,requestId:parentRequestId(child,settlement.requestId)})};
}

/** Only an identical recorded reservation can recover an interrupted parent admission. */
export async function reserveParent(authority:NonNullable<Awaited<ReturnType<typeof parentBudgetAuthority>>>,cwd:string,request:RequestReservation,signal?:AbortSignal,beforeCommit?:()=>void):Promise<void>{
  const check=()=>{authority.assertActive();beforeCommit?.();};check();
  const existing=authority.ledger.read(cwd).projection.requests[request.id];
  if(existing){
    if(existing.state!=='pending'||canonicalJson(existing.reservation)!==canonicalJson(request))throw denied('Parent reservation was settled or belongs to another request.');
    return;
  }
  let admitted=false;
  try {
    await authority.ledger.reserve(cwd,authority.hash,request,signal,check);admitted=true;
    await authority.ledger.refreshAuthority?.(cwd,request.agentId,signal);check();
  }catch(error){if(admitted||authority.ledger.canReleaseFailedReservation?.(error)===false)markParentAdmissionUncertain(error);throw error;}
}

export async function settleParent(authority:NonNullable<Awaited<ReturnType<typeof parentBudgetAuthority>>>,cwd:string,settlement:RequestSettlement):Promise<void>{
  const saved=authority.ledger.read(cwd),entry=saved.projection.requests[settlement.requestId];
  if(entry&&entry.state!=='pending'){
    const event=saved.events.find(event=>event.change.type==='settle'&&event.change.settlement.requestId===settlement.requestId);
    if(!event||event.change.type!=='settle'||canonicalJson(event.change.settlement)!==canonicalJson(settlement))throw denied('Parent request was settled with different usage.');
    // A linked parent may itself have an interrupted settlement to reconcile.
    if(saved.manifest.parent)await authority.ledger.settle(cwd,authority.hash,settlement);
    return;
  }
  await authority.ledger.settle(cwd,authority.hash,settlement);
}

function mappedParentAdmission(child:ExecutionManifest,admission:RemoteTaskAdmission):RemoteTaskAdmission {
  const link=child.parent;if(!link)throw denied('A parent link is required for remote work.');
  const agentId=link.version===2?link.accountMap[admission.agentId]:link.agentId;
  if(!agentId)throw denied('Remote work requires its mapped native parent account.');
  const {id:_,...body}=admission;return remoteTaskAdmission({...body,agentId});
}
function fundedTaskAdmission(child:ExecutionManifest,agentId:string,attribution:RequestAttribution):RemoteTaskAdmission {
  const account=accountLineage(child,agentId)[0]!;
  return mappedParentAdmission(child,remoteTaskAdmission({version:1,runId:child.runId,manifestHash:manifestHash(child),...(attribution.kind==='task'?{taskId:attribution.taskId,attempt:attribution.attempt}:{kind:'supervision',role:attribution.role,round:attribution.round}),startEventId:attribution.eventId,startEventHash:attribution.eventHash,sessionId:attribution.sessionId,agentId,deadline:account.deadline}));
}
/** Propagate the same work identity through every funding ancestor. A failed
 * acknowledgement retains any ancestor admission for exact retry/reconciliation. */
export async function parentTaskCapacity(child:ExecutionManifest,cwd:string,admission:RemoteTaskAdmission,release=false,signal?:AbortSignal):Promise<void>{
  const link=child.parent;if(!link)return;
  const authority=await parentBudgetAuthority(child,cwd,!release,signal),mapped=mappedParentAdmission(child,admission);
  if(link.version===2){
    const ledger=authority!.ledger as RemoteReservationLedger;
    if(release)await ledger.releaseTask(mapped,signal);else await ledger.admitTask(mapped,cwd,signal);
    return;
  }
  const {RunStore}=await import('../orchestration/store.js'),{ExecutionStore}=await import('../orchestration/execution-store.js');
  const {admitRemoteTask,releaseRemoteTask}=await import('../orchestration/remote-task-capacity.js');
  const view=await new RunStore(link.runsRoot).read(link.runId,cwd,signal),history=new ExecutionStore(join(link.runsRoot,link.runId),view.manifest);
  const budget=authority!.ledger.read(cwd).manifest;
  if(!history.exists())history.create({version:1,runId:link.runId,manifestHash:link.runManifestHash,approvalRevision:link.approvalRevision,createdAt:new Date(budget.createdAt).toISOString(),deadline:budget.deadline});
  if(release)await releaseRemoteTask(history,mapped,signal);else await admitRemoteTask(history,mapped,authority!.assertActive,signal);
}
export async function acquireParentTask(child:ExecutionManifest,cwd:string,agentId:string,attribution:RequestAttribution,signal?:AbortSignal):Promise<{release:()=>Promise<void>}|undefined>{
  if(!child.parent)return undefined;
  const account=accountLineage(child,agentId)[0]!,admission=remoteTaskAdmission({version:1,runId:child.runId,manifestHash:manifestHash(child),...(attribution.kind==='task'?{taskId:attribution.taskId,attempt:attribution.attempt}:{kind:'supervision',role:attribution.role,round:attribution.round}),startEventId:attribution.eventId,startEventHash:attribution.eventHash,sessionId:attribution.sessionId,agentId,deadline:account.deadline});
  await parentTaskCapacity(child,cwd,admission,false,signal);
  return {release:()=>parentTaskCapacity(child,cwd,admission,true)};
}
