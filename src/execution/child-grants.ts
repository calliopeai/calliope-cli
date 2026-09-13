import {canonicalJson} from '../approvals/index.js';
import {shape,uuid,hex,identifier,invalid,validateExecutionManifest,accountLineage} from './authority.js';
import {ExecutionLimitError,type ChildGrant,type ExecutionManifest,type ReservationProjection,type RecordedChildGrant} from './types.js';

export const MAX_CHILD_GRANT_BYTES=32768;
export function validateChildGrant(value:unknown):ChildGrant {
  shape(value,['version','id','proposalHash','previousGraphHash','planHash','runManifestHash','approvalRevision','parentId','accounts']);
  if(value.version!==1||!uuid(value.id)||!uuid(value.approvalRevision)||![value.proposalHash,value.previousGraphHash,value.planHash,value.runManifestHash].every(hex)||!Array.isArray(value.accounts)||!value.accounts.length||value.accounts.length>16)invalid();identifier(value.parentId);
  for(const account of value.accounts)shape(account,['id','parentId','tokenBudget','costBudgetNanos','deadline','allowedTools','allowedPaths']);
  if(Buffer.byteLength(canonicalJson(value))>MAX_CHILD_GRANT_BYTES)throw new ExecutionLimitError('limit','Child grant exceeds its 32 KiB limit.');return value as unknown as ChildGrant;
}
/** Derived accounts never replace the original immutable budget manifest/hash. */
export function effectiveExecutionManifest(base:ExecutionManifest,state:ReservationProjection):ExecutionManifest {
  return state.childGrants?.length?validateExecutionManifest({...base,accounts:[...base.accounts,...state.childGrants.flatMap(record=>record.grant.accounts)]}):base;
}
function ownSpend(manifest:ExecutionManifest,state:ReservationProjection,agentId:string):{tokens:number;costNanos:number} {
  const spent=state.accounts[agentId]??{tokens:0,costNanos:0},children=manifest.accounts.filter(a=>a.parentId===agentId);
  return{tokens:spent.tokens-children.reduce((n,a)=>n+(state.accounts[a.id]?.tokens??0),0),costNanos:spent.costNanos-children.reduce((n,a)=>n+(state.accounts[a.id]?.costNanos??0),0)};
}
/** Once children are granted, their remaining capacity cannot be borrowed by their parent. */
export function assertChildCapacity(manifest:ExecutionManifest,state:ReservationProjection,agentId:string,tokens=0,costNanos=0):void {
  const account=accountLineage(manifest,agentId)[0]!,spent=ownSpend(manifest,state,agentId),children=manifest.accounts.filter(a=>a.parentId===agentId);
  if(spent.tokens<0||spent.costNanos<0)invalid();
  if(spent.tokens+tokens+children.reduce((n,a)=>n+a.tokenBudget,0)>account.tokenBudget||spent.costNanos+costNanos+children.reduce((n,a)=>n+a.costBudgetNanos,0)>account.costBudgetNanos)
    throw new ExecutionLimitError('budget','Child grants and charged parent work exceed remaining capacity.');
}
export function applyChildGrant(base:ExecutionManifest,current:ExecutionManifest,state:ReservationProjection,record:RecordedChildGrant):ExecutionManifest {
  const grant=validateChildGrant(record.grant),previous=state.childGrants?.at(-1)?.grant.planHash??base.planHash;
  if(state.exceeded||state.childGrants?.some(r=>r.grant.id===grant.id||r.grant.proposalHash===grant.proposalHash)||grant.previousGraphHash!==previous||grant.planHash===previous)throw new ExecutionLimitError('conflict','Child grant is stale, duplicated or follows a budget violation.');
  if(!current.accounts.some(a=>a.id===grant.parentId)||grant.accounts.some(a=>a.parentId===null||current.accounts.some(old=>old.id===a.id)))invalid();
  const next=validateExecutionManifest({...current,accounts:[...current.accounts,...grant.accounts]});
  for(const account of grant.accounts){const lineage=accountLineage(next,account.id);if(!lineage.slice(1).some(a=>a.id===grant.parentId))invalid();if(record.at>=Math.min(...lineage.map(a=>a.deadline)))throw new ExecutionLimitError('deadline','Original parent or child deadline expired before allocation.');}
  for(const account of next.accounts)assertChildCapacity(next,state,account.id);
  for(const account of grant.accounts)Object.defineProperty(state.accounts,account.id,{value:{tokens:0,costNanos:0},enumerable:true});
  (state.childGrants??=[]).push(structuredClone(record));if(state.version<2)state.version=2;return next;
}
