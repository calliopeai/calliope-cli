import {canonicalJson} from '../approvals/index.js';
import type {AccountSpend,RequestAttribution,ReservationLedger} from '../execution/index.js';
import type {ExecutionInspection,RunPlanContext} from './coordinator-types.js';

export type AttributedCharge = {
  source:RequestAttribution;agentId:string;
} & ({status:'available';accounted:AccountSpend;requestIds:string[];requests:{pending:number;settled:number;unknown:number;exceeded:number};closed:boolean;usageComplete:boolean}
  |{status:'unavailable';reason:string});
export type RequestAccounting = {version:1;status:'available';revision:string;executionRevision:string;groups:Record<string,AttributedCharge>}
  |{version:1;status:'unavailable';reason:string};

/** Requires validated, matching execution and budget histories. Never infers ownership from time. */
export function attributeRequests(budget:ReturnType<ReservationLedger['read']>,execution:ExecutionInspection,context:RunPlanContext):RequestAccounting {
  try {
    if(budget.manifest.runId!==context.id||execution.header.runId!==context.id)throw new Error('Foreign history.');
    const starts=new Map<string,{source:RequestAttribution;agentId:string;at:number;end?:number}>(),activeTasks=new Map<string,string>();let activeReview:string|undefined;
    for(const event of execution.events){
      const c=event.change;
      if(c.type==='task_started'){
        activeTasks.set(c.taskId,event.id);
        if(c.requestAttribution===1){
          const agentId=context.plan.tasks.find(t=>t.id===c.taskId)!.agentId;
          starts.set(event.id,{source:{version:1,kind:'task',eventId:event.id,eventHash:event.hash,sessionId:c.sessionId,taskId:c.taskId,attempt:c.attempt},agentId,at:Date.parse(event.at)});
        }
      }else if(c.type==='supervision_started'){
        activeReview=event.id;
        if(c.requestAttribution===1)starts.set(event.id,{source:{version:1,kind:'supervision',eventId:event.id,eventHash:event.hash,sessionId:c.sessionId,role:c.role,round:c.round},agentId:c.agentId,at:Date.parse(event.at)});
      }else if(c.type==='task_finished'){
        const start=starts.get(activeTasks.get(c.taskId)??'');if(start)start.end=Date.parse(event.at);activeTasks.delete(c.taskId);
      }else if(c.type==='supervision_decided'||c.type==='supervision_halted'){
        const start=starts.get(activeReview??'');if(start)start.end=Date.parse(event.at);activeReview=undefined;
      }
    }
    const unbound=new Set<string>();
    const groups:Record<string,AttributedCharge>=Object.create(null);
    for(const [id,start]of starts)groups[id]={source:start.source,agentId:start.agentId,status:'available',accounted:{tokens:0,costNanos:0},requestIds:[],requests:{pending:0,settled:0,unknown:0,exceeded:0},closed:start.end!==undefined,usageComplete:false};
    for(const event of budget.events){
      if(event.change.type!=='reserve')continue;
      const r=event.change.reservation,source=r.attribution;
      if(!source){unbound.add(r.agentId);continue;}
      const start=starts.get(source.eventId),request=budget.projection.requests[r.id],group=groups[source.eventId];
      if(!start||!request?.accounted||group?.status!=='available'||r.agentId!==start.agentId||canonicalJson(source)!==canonicalJson(start.source)||event.at<start.at||start.end!==undefined&&event.at>start.end)throw new Error('Invalid request binding.');
      group.requestIds.push(r.id);group.requests[request.state]++;group.accounted.tokens+=request.accounted.tokens;group.accounted.costNanos+=request.accounted.costNanos;
      if(!Number.isSafeInteger(group.accounted.tokens)||!Number.isSafeInteger(group.accounted.costNanos))throw new Error('Invalid charges.');
    }
    for(const [id,group]of Object.entries(groups))if(group.status==='available'){
      if(unbound.has(group.agentId))groups[id]={source:group.source,agentId:group.agentId,status:'unavailable',reason:'This agent has requests without attempt/review provenance; its costs cannot be partitioned safely.'};
      else group.usageComplete=group.closed&&!group.requests.pending&&!group.requests.unknown&&!group.requests.exceeded;
    }
    return{version:1,status:'available',revision:budget.projection.revision,executionRevision:execution.state.revision,groups};
  }catch{return{version:1,status:'unavailable',reason:'Request provenance does not match this execution history; no attempt or review cost can be established.'};}
}
