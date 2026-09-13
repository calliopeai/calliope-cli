import {dirname,join} from 'node:path';
import {canonicalJson,digest} from '../approvals/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {ReservationLedger,type AccountSpend} from '../execution/index.js';
import {ExecutionStore,privateDirectory,readArtifactBytes} from '../orchestration/execution-store.js';
import {executionManifestForRun} from '../orchestration/execution.js';
import {validateRunManifest} from '../orchestration/store.js';
import {MAX_PLAN_BYTES} from '../orchestration/validation.js';
import {inspectSpawnAuthority} from '../spawning/authority.js';
import type {ExecutionInspection} from '../orchestration/coordinator-types.js';
import type {RunManifest} from '../orchestration/types.js';
import {GoalStore} from './store.js';
import type {GoalAllocation,GoalInspection} from './types.js';

type RequestCounts={pending:number;settled:number;unknown:number;exceeded:number};
export type GoalPhaseAccounting=
  |{status:'not-allocated';runId:null;accounted:AccountSpend}
  |{status:'unavailable';runId:string;reason:string}
  |{status:'available';runId:string;allocationId:string;runManifestHash:string;planHash:string;budgetRevision:string;executionRevision:string|null;accounted:AccountSpend;requests:RequestCounts;exceeded:boolean;closed:boolean;usageComplete:boolean;pendingChildGrants:number};
export type GoalAccounting={version:1;status:'unavailable';reason:string}
  |{version:1;status:'available'|'partial';basis:'reservations-and-settlements';goalId:string;goalManifestHash:string;goalRevision:string;revision:string;deadline:number;limit:AccountSpend;accounted:AccountSpend|null;knownCharges:AccountSpend;remaining:AccountSpend|null;usageComplete:boolean;phases:{planning:GoalPhaseAccounting;execution:GoalPhaseAccounting}};
const zero=():AccountSpend=>({tokens:0,costNanos:0});
const unavailable=():GoalAccounting=>({version:1,status:'unavailable',reason:'Goal accounting is unavailable or inconsistent; preserve the goal and its linked run budgets.'});

/** Shared identity check for inspection; unlike execution authority it also permits completed/revoked goals. */
export function assertGoalRunBinding(goal:GoalInspection,allocation:GoalAllocation,manifest:RunManifest,goals:GoalStore):void {
  const expected={version:1,root:goals.root,id:goal.manifest.id,manifestHash:goal.manifest.hash,allocationId:allocation.id,phase:allocation.phase};
  if(manifest.version!==2||manifest.id!==allocation.runId||manifest.planHash!==allocation.planHash||canonicalJson(manifest.goal)!==canonicalJson(expected)||canonicalJson(manifest.project)!==canonicalJson(goal.manifest.project)||manifest.createdAt!==goal.manifest.createdAt||manifest.plan.limits.tokenBudget!==allocation.tokens||Math.floor(manifest.plan.limits.costBudgetUsd*1e9)!==allocation.costNanos||Date.parse(manifest.createdAt)+manifest.plan.limits.timeBudgetMs!==allocation.deadline)throw new Error('Mismatched goal allocation.');
}

/** Two linked runs with bounded journal reads; a missing allocated ledger is never zero spend. */
export function readGoalAccounting(goal:GoalInspection,goals:GoalStore,active?:{store:ExecutionStore;execution:ExecutionInspection},signal?:AbortSignal):GoalAccounting {
  throwIfCancelled(signal);
  try {
    const current=goals.read(goal.manifest.id,goal.manifest.project.root);
    if(current.manifest.hash!==goal.manifest.hash||current.state.revision!==goal.state.revision)return unavailable();
    goal=current;
    if(active){const link=active.store.manifest.goal,a=link?.phase==='planning'?goal.state.planning:goal.state.execution;if(!link||!a||dirname(dirname(active.store.root))!==goal.manifest.runsRoot)throw new Error('Foreign active run.');assertGoalRunBinding(goal,a,active.store.manifest,goals);}
    const phase=(allocation:GoalAllocation|null):GoalPhaseAccounting=>{
      if(!allocation)return{status:'not-allocated',runId:null,accounted:zero()};
      try {
        throwIfCancelled(signal);privateDirectory(goal.manifest.runsRoot);const dir=join(goal.manifest.runsRoot,allocation.runId);privateDirectory(dir);
        const manifest=validateRunManifest(JSON.parse(readArtifactBytes(join(dir,'manifest.json'),MAX_PLAN_BYTES+8192,true).toString()));assertGoalRunBinding(goal,allocation,manifest,goals);
        const store=new ExecutionStore(dir,manifest),ledger=new ReservationLedger(join(dir,'budget'));
        const execution=active?.store.manifest.id===allocation.runId?active.execution:store.exists()?store.read():null;
        const inspected=execution?inspectSpawnAuthority(store,ledger,execution):null,budget=inspected?.budget??ledger.read(goal.manifest.project.root);
        if(canonicalJson(budget.manifest)!==canonicalJson(executionManifestForRun(manifest,Date.parse(goal.manifest.createdAt))))throw new Error('Goal budget contract changed.');
        if(execution&&(execution.header.runId!==manifest.id||execution.header.manifestHash!==manifest.hash||execution.state.runId!==manifest.id||execution.header.createdAt!==goal.manifest.createdAt||execution.header.deadline!==allocation.deadline)||!execution&&budget.projection.childGrants?.length)throw new Error('Missing child execution evidence.');
        const s=budget.projection,frozen=goal.state.planningSpend;
        if(allocation.phase==='planning'&&goal.state.planningFrozen&&(!frozen||frozen.revision!==s.revision||frozen.tokens!==s.spent.tokens||frozen.costNanos!==s.spent.costNanos))throw new Error('Frozen planning spend changed.');
        const requests:RequestCounts={pending:0,settled:0,unknown:0,exceeded:0};for(const r of Object.values(s.requests))requests[r.state]++;
        const closed=allocation.phase==='planning'?goal.state.planningFrozen:!!execution&&!['ready','running'].includes(execution.state.status)&&execution.state.ownerId===null;
        const pendingChildGrants=inspected?.pending.length??0;
        return{status:'available',runId:allocation.runId,allocationId:allocation.id,runManifestHash:manifest.hash,planHash:manifest.planHash,budgetRevision:s.revision,executionRevision:execution?.state.revision??null,accounted:{...s.spent},requests,exceeded:s.exceeded,closed,usageComplete:closed&&!requests.pending&&!requests.unknown&&!requests.exceeded&&!pendingChildGrants,pendingChildGrants};
      }catch{throwIfCancelled(signal);return{status:'unavailable',runId:allocation.runId,reason:'Allocated run, budget, clock, child history or frozen planning spend is unavailable or inconsistent.'};}
    };
    const phases={planning:phase(goal.state.planning),execution:phase(goal.state.execution)},values=Object.values(phases),complete=values.every(p=>p.status!=='unavailable'),knownCharges=zero();
    for(const p of values)if(p.status!=='unavailable'){knownCharges.tokens+=p.accounted.tokens;knownCharges.costNanos+=p.accounted.costNanos;}
    if(!Number.isSafeInteger(knownCharges.tokens)||!Number.isSafeInteger(knownCharges.costNanos))return unavailable();
    const limit={tokens:goal.manifest.limits.tokenBudget,costNanos:goal.manifest.limits.costBudgetNanos};
    if(goals.read(goal.manifest.id,goal.manifest.project.root).state.revision!==goal.state.revision)return unavailable();throwIfCancelled(signal);
    return{version:1,status:complete?'available':'partial',basis:'reservations-and-settlements',goalId:goal.manifest.id,goalManifestHash:goal.manifest.hash,goalRevision:goal.state.revision,revision:digest(canonicalJson({goalRevision:goal.state.revision,phases})),deadline:goal.manifest.deadline,limit,accounted:complete?{...knownCharges}:null,knownCharges,remaining:complete?{tokens:Math.max(0,limit.tokens-knownCharges.tokens),costNanos:Math.max(0,limit.costNanos-knownCharges.costNanos)}:null,usageComplete:complete&&values.every(p=>p.status==='not-allocated'||p.status==='available'&&p.usageComplete),phases};
  }catch{throwIfCancelled(signal);return unavailable();}
}

/** Live numeric context for linked runs; no artifact reads, prompts, provider calls or grants. */
export function linkedGoalAccounting(store:ExecutionStore,execution:ExecutionInspection,signal?:AbortSignal):GoalAccounting|undefined {
  const link=store.manifest.goal;if(!link)return undefined;
  try{const goals=new GoalStore(link.root),goal=goals.read(link.id,store.manifest.project.root);if(goal.manifest.hash!==link.manifestHash)return unavailable();return readGoalAccounting(goal,goals,{store,execution},signal);}
  catch{throwIfCancelled(signal);return unavailable();}
}
