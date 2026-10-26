import {canonicalJson} from '../approvals/index.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {OrchestrationError} from '../orchestration/types.js';
import {uuid,hex} from '../orchestration/validation.js';
import type {CoordinatorOptions} from '../orchestration/coordinator.js';
import {inspectImprovements} from './actions.js';
import {projectImprovementReviews,validateImprovementReviewRequest,type ImprovementReviewRequest} from './review-contract.js';

/** Separately negotiated metadata API; not an extension of the execution capability contract. */
export function improvementReviewCapabilities() {
  return {version:1,kind:'improvement.review-capabilities',owner:'calliope-cli',operations:['request','inspect','dismiss'],
    actions:['propose','run','rollback'],authority:'request-only-no-execution',storage:'native-execution-journal',maxRequests:64} as const;
}
export async function inspectImprovementReviews(cwd:string,runId:string|undefined,options:CoordinatorOptions={}) {
  const current=await inspectImprovements(cwd,runId,options);
  return projectImprovementReviews(current.execution!);
}
export async function requestImprovementReview(cwd:string,runId:string|undefined,request:ImprovementReviewRequest,options:CoordinatorOptions={}) {
  validateImprovementReviewRequest(request);request=structuredClone(request);
  const current=await inspectImprovements(cwd,runId,options),store=current.store;
  if(current.owner?.alive||current.execution!.state.ownerId)throw new OrchestrationError('conflict','Stop or recover the active coordinator before requesting review.');
  const duplicate=()=>{const last=store.read().events.at(-1);return last?.change.type==='improvement_review_requested'&&canonicalJson(last.change.request)===canonicalJson(request)?last:null;};
  if(!duplicate())store.assertRevision(request.executionRevision);
  await authorizeSessionAction(cwd,'orchestration_improvement_review_request',{path:cwd,runId:current.view.run.id,request,scope:'record untrusted review request only; no model calls or execution authority'},{...options,confirmation:options.confirmation??'mutating'});
  const lease=store.acquire();
  try{
    lease.check();const prior=store.read();store.assertApproval(prior.header);
    if(prior.state.ownerId)throw new OrchestrationError('conflict','Execution became active during review request.');
    const existing=duplicate();
    if(existing)return{requestId:existing.id,existing:true,reviews:projectImprovementReviews(prior)};
    store.assertRevision(request.executionRevision);
    const event=await store.append({type:'improvement_review_requested',request},options.signal,undefined,()=>{lease.check();store.assertApproval(prior.header);store.assertRevision(request.executionRevision);});
    return{requestId:event.id,existing:false,reviews:projectImprovementReviews(store.read())};
  }finally{lease.release();}
}
export async function dismissImprovementReview(cwd:string,runId:string|undefined,requestId:string,executionRevision:string,options:CoordinatorOptions={}) {
  if(!uuid(requestId)||!hex(executionRevision))throw new OrchestrationError('invalid','Review dismissal requires its exact request and revision.');
  const current=await inspectImprovements(cwd,runId,options),store=current.store;
  store.assertRevision(executionRevision);
  const last=current.execution!.events.at(-1);
  if(current.owner?.alive||current.execution!.state.ownerId||last?.id!==requestId||last.change.type!=='improvement_review_requested')throw new OrchestrationError('conflict','Review request is no longer pending.');
  await authorizeSessionAction(cwd,'orchestration_improvement_review_dismiss',{path:cwd,runId:current.view.run.id,requestId,executionRevision,scope:'dismiss request only; retain the strategy and execution evidence'},{...options,confirmation:options.confirmation??'mutating'});
  const lease=store.acquire();
  try{
    const before=current.execution!;
    await store.append({type:'improvement_review_dismissed',requestId,executionRevision},options.signal,undefined,()=>{lease.check();store.assertApproval(before.header);store.assertRevision(executionRevision);});
    return projectImprovementReviews(store.read());
  }finally{lease.release();}
}
