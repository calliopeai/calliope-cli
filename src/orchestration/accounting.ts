import {join} from 'node:path';
import {ReservationLedger,effectiveExecutionManifest,accountLineage,type AccountSpend} from '../execution/index.js';
import {inspectSpawnAuthority} from '../spawning/authority.js';
import type {ExecutionStore} from './execution-store.js';
import type {ExecutionInspection} from './coordinator-types.js';
import {attributeRequests,type RequestAccounting} from './request-accounting.js';

/** Ledger charges include unresolved reservations; they are not provider invoices. */
export interface AccountBalance {
  limit:AccountSpend;accounted:AccountSpend;remaining:AccountSpend;deadline:number;
  requests:{pending:number;settled:number;unknown:number;exceeded:number};
}
export type RunAccounting = {
  version:1;status:'available';basis:'reservations-and-settlements';revision:string;executionRevision:string;
  exceeded:boolean;run:AccountBalance;accounts:Record<string,AccountBalance>;
  attribution?:RequestAccounting;
} | {version:1;status:'unavailable';reason:string};

/** Inspection never initializes, settles or repairs a ledger, including after cancellation. */
export function readRunAccounting(store:ExecutionStore,execution:ExecutionInspection=store.read()):RunAccounting {
  try {
    const {budget,context}=inspectSpawnAuthority(store,new ReservationLedger(join(store.root,'..','budget')),execution);
    const state=budget.projection,manifest=effectiveExecutionManifest(budget.manifest,state);
    if(manifest.createdAt!==Date.parse(execution.header.createdAt)||manifest.deadline!==execution.header.deadline)throw new Error('Mismatched clock.');
    const balance=(limit:AccountSpend,accounted:AccountSpend,deadline:number):AccountBalance=>({limit,accounted:{...accounted},remaining:{tokens:Math.max(0,limit.tokens-accounted.tokens),costNanos:Math.max(0,limit.costNanos-accounted.costNanos)},deadline,requests:{pending:0,settled:0,unknown:0,exceeded:0}});
    const run=balance({tokens:manifest.tokenBudget,costNanos:manifest.costBudgetNanos},state.spent,manifest.deadline);
    const accounts=Object.fromEntries(manifest.accounts.map(a=>[a.id,balance({tokens:a.tokenBudget,costNanos:a.costBudgetNanos},state.accounts[a.id]!,a.deadline)]));
    for(const request of Object.values(state.requests)){
      run.requests[request.state]++;
      for(const account of accountLineage(manifest,request.reservation.agentId))accounts[account.id]!.requests[request.state]++;
    }
    const attributed=execution.events.some(e=>'requestAttribution'in e.change&&e.change.requestAttribution===1);
    return{version:1,status:'available',basis:'reservations-and-settlements',revision:state.revision,executionRevision:execution.state.revision,exceeded:state.exceeded,run,accounts,...(attributed?{attribution:attributeRequests(budget,execution,context)}:{})};
  }catch{return{version:1,status:'unavailable',reason:'Budget history is unavailable or inconsistent; preserve the run and inspect its ledger. No balance can be established.'};}
}
