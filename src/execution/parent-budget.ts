/** A native run may draw from another reviewed run's account. No synthetic usage or
 * second accounting store: the same provider request is reserved in both ledgers. */
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../approvals/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {ReservationLedger} from './ledger.js';
import {accountLineage,assertExecutionStoreOutsideProject,manifestHash,permits,validateExecutionManifest} from './authority.js';
import {effectiveExecutionManifest} from './child-grants.js';
import {ExecutionLimitError,type ExecutionManifest,type RequestReservation,type RequestSettlement} from './types.js';

const denied=(message:string)=>new ExecutionLimitError('authority',message);
export const parentBudgetCapabilities=()=>({version:1 as const,manifestVersion:2 as const,owner:'calliope-cli' as const,semantics:'charge-native-parent-before-child' as const,maxLinks:8,placement:'same-project-local' as const});
/** Deterministic per-child identity lets an interrupted admission reconcile its
 * existing parent charge; identical caller UUIDs in sibling runs cannot collide. */
export function parentRequestId(child:ExecutionManifest,requestId:string):string {
  const bytes=createHash('sha256').update(canonicalJson({child:manifestHash(child),requestId})).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&0x0f)|0x40;bytes[8]=(bytes[8]!&0x3f)|0x80;
  const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export interface ParentBudgetAuthority {
  ledger:ReservationLedger;hash:string;assertActive:()=>void;
  reservation:(request:RequestReservation)=>RequestReservation;
  settlement:(settlement:RequestSettlement)=>RequestSettlement;
}
export async function parentBudgetAuthority(input:ExecutionManifest,cwd:string,admission=true,signal?:AbortSignal,seen:string[]=[]):Promise<ParentBudgetAuthority|undefined>{
  const child=validateExecutionManifest(input),link=child.parent;if(!link)return undefined;
  throwIfCancelled(signal);
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
      return {...request,id:parentRequestId(child,request.id),agentId:link.agentId};
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
  await authority.ledger.reserve(cwd,authority.hash,request,signal,check);check();
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
