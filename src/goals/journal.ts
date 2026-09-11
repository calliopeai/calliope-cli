import {canonicalJson,digest} from '../approvals/index.js';
import {shape,integer,iso,uuid,hex,array,text,fail} from '../orchestration/validation.js';
import {OrchestrationError} from '../orchestration/types.js';
import {validateGoalManifest,validateAllocation,validatePlanningSpend,verifyHash,MAX_GOAL_EVENTS,MAX_GOAL_EVENT_BYTES} from './validation.js';
import type {GoalManifest,GoalEvent,GoalProjection} from './types.js';

export const goalHistoryHash=(manifest:GoalManifest,events:GoalEvent[])=>digest(canonicalJson({manifestHash:manifest.hash,events:events.map(e=>e.hash)}));
export function validateGoalEvent(value:unknown,manifest:GoalManifest):GoalEvent {
  shape(value,['version','id','goalId','sequence','at','previous','change','hash']);if(value.version!==1||!uuid(value.id)||value.goalId!==manifest.id||!iso(value.at)||!hex(value.previous))fail('Invalid goal event.');integer(value.sequence,1,MAX_GOAL_EVENTS);
  shape(value.change,['type'],['allocation','status','spend','proposalHash','reason','source','runId','revision','completed','total']);const c=value.change;
  if(c.type==='planning_allocated'){shape(c,['type','allocation']);validateAllocation(c.allocation,manifest,'planning');}
  else if(c.type==='planning_finished'){shape(c,['type','status','spend','proposalHash','reason']);if(!['review_required','failed','denied','cancelled'].includes(String(c.status))||c.proposalHash!==null&&!hex(c.proposalHash))fail('Invalid planning outcome.');if(c.spend!==null)validatePlanningSpend(c.spend);text(c.reason);}
  else if(c.type==='proposal_revised'){shape(c,['type','proposalHash']);if(!hex(c.proposalHash))fail('Invalid revised proposal.');}
  else if(c.type==='execution_allocated'){shape(c,['type','allocation','proposalHash','source']);validateAllocation(c.allocation,manifest,'execution');if(!hex(c.proposalHash)||!['cli','repl'].includes(String(c.source)))fail('Invalid plan approval.');}
  else if(c.type==='execution_started'){shape(c,['type','runId']);if(!uuid(c.runId))fail('Invalid execution run.');}
  else if(c.type==='execution_interrupted'){shape(c,['type','runId','status','reason']);if(!uuid(c.runId)||!['failed','denied','cancelled'].includes(String(c.status)))fail('Invalid execution interruption.');text(c.reason);}
  else if(c.type==='execution_finished'){shape(c,['type','runId','revision','status','completed','total']);if(!uuid(c.runId)||!hex(c.revision)||!['completed','partial','failed','denied','cancelled'].includes(String(c.status)))fail('Invalid execution evidence.');integer(c.total,1,manifest.limits.maxTasks);integer(c.completed,0,c.total);if(c.status==='completed'&&c.completed!==c.total)fail('Goal completion requires all task evidence.');}
  else if(c.type==='cancelled'){shape(c,['type','source']);if(!['cli','repl'].includes(String(c.source)))fail('Invalid cancellation source.');}
  else fail('Unknown goal event.');verifyHash(value);if(Buffer.byteLength(JSON.stringify(value))>MAX_GOAL_EVENT_BYTES)fail('Goal event exceeds its byte limit.');return value as unknown as GoalEvent;
}
export function replayGoal(manifest:GoalManifest,events:GoalEvent[]):GoalProjection {
  validateGoalManifest(manifest);array(events,MAX_GOAL_EVENTS);const state:GoalProjection={version:1,id:manifest.id,revision:goalHistoryHash(manifest,[]),status:'created',revoked:false,planning:null,execution:null,planningSpend:null,planningFrozen:false,proposalHash:null,approvedProposalHash:null,result:null};
  const seen=new Set<string>();let at=manifest.createdAt;const conflict=(message:string):never=>{throw new OrchestrationError('conflict',message);};
  for(const event of events){validateGoalEvent(event,manifest);if(seen.has(event.id)||event.sequence!==seen.size+1||event.previous!==state.revision||event.at<at)fail('Broken goal event ancestry.');seen.add(event.id);at=event.at;const c=event.change;
    if(c.type==='planning_allocated'){if(state.status!=='created'||state.planning||Date.parse(at)>=c.allocation.deadline)conflict('Goal cannot allocate a new planner.');state.planning=c.allocation;state.status='planning';}
    else if(c.type==='planning_finished'){
      if(!state.planning||state.planningFrozen||!['planning','cancelled'].includes(state.status))conflict('Planning is already frozen or was never allocated.');
      if(c.status==='review_required'&&(!c.proposalHash||!c.spend||c.spend.tokens>state.planning!.tokens||c.spend.costNanos>state.planning!.costNanos)||c.status!=='review_required'&&c.proposalHash!==null)fail('A proposal requires bounded planning evidence.');
      state.planningSpend=c.spend;state.planningFrozen=true;state.proposalHash=c.proposalHash;if(state.status!=='cancelled')state.status=c.status;
    }else if(c.type==='proposal_revised'){if(!['review_required','failed','denied','cancelled'].includes(state.status)||state.revoked||state.execution||!state.planningFrozen||!state.planningSpend)conflict('Only frozen, unallocated planning can be revised.');state.proposalHash=c.proposalHash;state.status='review_required';}
    else if(c.type==='execution_allocated'){
      if(state.status!=='review_required'||state.execution||!state.planningSpend||state.proposalHash!==c.proposalHash||Date.parse(at)>=c.allocation.deadline||c.allocation.runId===state.planning!.runId||c.allocation.id===state.planning!.id)conflict('Execution needs the current unallocated proposal and deadline.');
      if(c.allocation.tokens>manifest.limits.tokenBudget-state.planningSpend!.tokens||c.allocation.costNanos>manifest.limits.costBudgetNanos-state.planningSpend!.costNanos)conflict('Execution allocation exceeds remaining goal budget.');
      state.execution=c.allocation;state.approvedProposalHash=c.proposalHash;state.status='approved';
    }else if(c.type==='execution_started'){if(!state.execution||c.runId!==state.execution.runId||state.revoked||state.status==='completed'||Date.parse(at)>=state.execution.deadline)conflict('Execution cannot start or refresh its deadline.');state.status='running';}
    else if(c.type==='execution_interrupted'){if(!state.execution||c.runId!==state.execution.runId||state.status==='completed')conflict('Goal interruption belongs to another or completed execution.');if(!state.revoked)state.status=c.status;}
    else if(c.type==='execution_finished'){if(!state.execution||c.runId!==state.execution.runId)conflict('Goal result belongs to another execution.');state.result={runId:c.runId,revision:c.revision,status:c.status,completed:c.completed,total:c.total};if(!state.revoked)state.status=c.status;}
    else if(c.type==='cancelled'){if(state.status==='completed')conflict('Completed goals cannot be cancelled.');state.status='cancelled';state.revoked=true;}
    state.revision=event.hash;
  }
  return state;
}
