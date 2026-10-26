import {hex,shape,text,uuid,fail} from '../orchestration/validation.js';
import {OrchestrationError,type RunManifest} from '../orchestration/types.js';
import type {ExecutionEvent,ExecutionHeader,ExecutionProjection,ExecutionInspection} from '../orchestration/coordinator-types.js';
import {projectImprovementHistory} from './projection.js';
import {improvementProposalHash} from './proposal-hash.js';

/** Untrusted request data. It never contains a human approval or execution grant. */
export interface ImprovementReviewRequest {
  version:1;action:'propose'|'run'|'rollback';executionRevision:string;
  cycleId:string|null;proposalHash:string|null;reason:string;
}
export function validateImprovementReviewRequest(value:unknown):asserts value is ImprovementReviewRequest {
  shape(value,['version','action','executionRevision','cycleId','proposalHash','reason']);
  if(value.version!==1||!['propose','run','rollback'].includes(String(value.action))||!hex(value.executionRevision))fail('Invalid improvement review request.');
  text(value.reason,1024);
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.reason))fail('Invalid review request text.');
  if(value.action==='propose'?value.cycleId!==null||value.proposalHash!==null:!uuid(value.cycleId)||!hex(value.proposalHash))fail('Review request requires an exact proposal identity.');
}
export function validateImprovementReviewEvent(event:ExecutionEvent,manifest:RunManifest,header:ExecutionHeader,state:ExecutionProjection,prior:ExecutionEvent[]):void {
  const c=event.change;
  function conflict(message:string):never {throw new OrchestrationError('conflict',message);}
  if(state.ownerId||!state.supervision)conflict('Improvement review requests require an inactive supervised run.');
  if(c.type==='improvement_review_dismissed'){
    const last=prior.at(-1);
    if(c.executionRevision!==state.revision||last?.id!==c.requestId||last.change.type!=='improvement_review_requested')conflict('Review request is no longer pending.');
    return;
  }
  if(c.type!=='improvement_review_requested')fail('Invalid improvement review event.');
  const request=c.request;
  if(request.executionRevision!==state.revision||event.previous!==state.revision)conflict('Review request revision changed.');
  if(prior.at(-1)?.change.type==='improvement_review_requested')conflict('Resolve the pending review request before requesting another.');
  if(prior.filter(e=>e.change.type==='improvement_review_requested').length>=64)conflict('Review request retention reached; preserve the run.');
  const context={...manifest,plan:state.graph?.plan??manifest.plan};
  const history=projectImprovementHistory(manifest,{header,events:prior,state},context);
  if(request.action==='propose'){
    if(Date.parse(event.at)>=state.deadline||state.status==='completed'||state.supervision!.review||state.supervision!.rounds>=context.plan.supervision!.maxRounds||!prior.some(e=>e.change.type==='task_finished'))conflict('A new improvement proposal is unavailable.');
  }else{
    const cycle=history.cycles.find(c=>c.id===request.cycleId);
    if(!cycle||cycle.withdrawal||improvementProposalHash(cycle)!==request.proposalHash)conflict('Improvement proposal identity changed or was withdrawn.');
    if(request.action==='run'&&(Date.parse(event.at)>=state.deadline||cycle.status!=='proposed'||state.supervision!.decisionId!==cycle.id))conflict('Select the current unapplied improvement.');
    if(request.action==='rollback'&&state.supervision!.decisionId&&state.supervision!.decisionId!==cycle.id)conflict('Resolve the current decision before requesting withdrawal.');
  }
}
export function projectImprovementReviews(execution:ExecutionInspection,now=Date.now()) {
  return {version:1 as const,kind:'improvement.review-requests' as const,runId:execution.state.runId,executionRevision:execution.state.revision,
    requests:execution.events.flatMap(event=>{
      if(event.change.type!=='improvement_review_requested')return[];
      const dismissed=execution.events.find(e=>e.change.type==='improvement_review_dismissed'&&e.change.requestId===event.id);
      const status=dismissed?'dismissed':event.hash!==execution.state.revision?'stale':event.change.request.action!=='rollback'&&now>=execution.state.deadline?'expired':'pending';
      return[{id:event.id,hash:event.hash,at:event.at,request:structuredClone(event.change.request),status,
        dismissal:dismissed?{id:dismissed.id,hash:dismissed.hash,at:dismissed.at}:null}];
    })};
}
