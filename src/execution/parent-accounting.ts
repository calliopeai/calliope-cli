import {accountLineage,validateExecutionManifest} from './authority.js';
import {effectiveExecutionManifest} from './child-grants.js';
import {parentBudgetAuthority} from './parent-budget.js';
import type {ExecutionManifest} from './types.js';

export interface ParentAccountBalance {
  runId:string;agentId:string;manifestHash:string;revision:string;deadline:number;
  authority:'active'|'inactive'|'expired'|'exceeded';
  tokens:{limit:number;accounted:number;remaining:number};
  costNanos:{limit:number;accounted:number;remaining:number};
  requests:{pending:number;settled:number;unknown:number;exceeded:number};
}
export type ParentBudgetAccounting = {version:1;status:'unlinked'}
  |{version:1;status:'available';basis:'reservations-and-settlements';parents:ParentAccountBalance[]}
  |{version:1;status:'unavailable'};

/** Read-only account balances, never an admission promise or a sum of expenses.
 * A request must still fit every run/account, grant allocation and provider quote. */
export async function readParentBudgetAccounting(input:ExecutionManifest,cwd:string,signal?:AbortSignal):Promise<ParentBudgetAccounting>{
  try{
    let child=validateExecutionManifest(input);
    if(!child.parent)return {version:1,status:'unlinked'};
    const parents:ParentAccountBalance[]=[],checks:(()=>boolean)[]=[];
    // The native authority reader validates the whole bounded, acyclic lineage.
    while(child.parent){
      const authority=await parentBudgetAuthority(child,cwd,false,signal);
      const saved=authority!.ledger.read(cwd),manifest=effectiveExecutionManifest(saved.manifest,saved.projection);
      const selected=child.parent.agentId,account=accountLineage(manifest,selected)[0]!,spent=saved.projection.accounts[selected]!;
      let state:ParentAccountBalance['authority']='active';
      try{await parentBudgetAuthority(child,cwd,true,signal);}catch(error){
        const code=(error as {code?:string}).code;
        if(code==='authority'||code==='policy-denied')state='inactive';
        else if(code==='deadline')state='expired';
        else if(code==='budget')state='exceeded';
        else throw error;
      }
      const balance=(limit:number,accounted:number)=>({limit,accounted,remaining:Math.max(0,limit-accounted)});
      const requests={pending:0,settled:0,unknown:0,exceeded:0};
      for(const entry of Object.values(saved.projection.requests)){
        if(accountLineage(manifest,entry.reservation.agentId).some(a=>a.id===selected))requests[entry.state]++;
      }
      parents.push({runId:manifest.runId,agentId:selected,manifestHash:saved.projection.manifestHash,revision:saved.projection.revision,
        deadline:account.deadline,authority:state,tokens:balance(account.tokenBudget,spent.tokens),
        costNanos:balance(account.costBudgetNanos,spent.costNanos),requests});
      checks.push(()=>authority!.ledger.read(cwd).projection.revision===saved.projection.revision);
      child=saved.manifest;
    }
    if(!checks.every(check=>check()))return {version:1,status:'unavailable'};
    return {version:1,status:'available',basis:'reservations-and-settlements',parents};
  }catch{return {version:1,status:'unavailable'};}
}
