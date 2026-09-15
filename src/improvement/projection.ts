import type {ExecutionEvent,ExecutionInspection,RunPlanContext} from '../orchestration/coordinator-types.js';
import type {RunManifest} from '../orchestration/types.js';
import {cycleMetrics} from './metrics.js';
import type {CycleEventRef,CycleOutcome,ImprovementCycle,ImprovementHistory} from './types.js';
import type {RequestAccounting} from '../orchestration/request-accounting.js';

const ref=(e:ExecutionEvent):CycleEventRef=>({id:e.id,hash:e.hash,at:e.at,sequence:e.sequence});
/** Pure projection of an already validated ExecutionStore inspection; never performs work. */
export function projectImprovementHistory(manifest:RunManifest,execution:ExecutionInspection,context:RunPlanContext,accounting?:RequestAccounting):ImprovementHistory {
  const history:ImprovementHistory={version:1,kind:'improvement.history',runId:manifest.id,revision:execution.state.revision,cycles:[]};
  const policy=context.plan.supervision;if(!policy)return history;
  if(accounting?.status==='available'&&accounting.executionRevision!==execution.state.revision)accounting=undefined;
  const attributed=execution.events.some(e=>'requestAttribution'in e.change&&e.change.requestAttribution===1);
  if(attributed){history.version=2;history.accounting={version:1,status:accounting?.status??'unavailable',revision:accounting?.status==='available'?accounting.revision:null,scope:'worker-attempts',basis:'reservations-and-settlements'};}
  const events=new Map<string,ExecutionEvent>(),outcomes=new Map<string,CycleOutcome>(),starts=new Map<string,ExecutionEvent>();
  const taskCycles=new Map<string,string>(),agentCycles=new Map<string,string>(),previous=new Map<string,string>();
  const pending=new Map<string,{cycle:ImprovementCycle;attempts:Map<string,number>}>();
  const health=new Map<string,import('../supervision/types.js').SupervisionHealthEvidence>();
  const tools=new Map<string,{calls:number;failures:number}>();let reviewRequest:CycleEventRef|null=null;
  for(const event of execution.events){
    const c=event.change;events.set(event.id,event);
    if(c.type==='started'&&c.proposalOnly)reviewRequest=ref(event);
    if(c.type==='supervision_started'&&c.health)health.set(`${c.round}:${c.role}`,structuredClone(c.health));
    if(c.type==='task_started'){starts.set(c.taskId,event);tools.set(c.taskId,{calls:0,failures:0});}
    else if(c.type==='tool'&&c.stage==='finished'){const counts=tools.get(c.taskId);if(counts){counts.calls++;if(!c.success)counts.failures++;}}
    else if(c.type==='task_finished'){
      const start=starts.get(c.taskId),count=tools.get(c.taskId),attempt=start?.change.type==='task_started'?start.change.attempt:0;
      const outcome:CycleOutcome={taskId:c.taskId,attempt,status:c.status,event:ref(event),checks:structuredClone(c.output.checks),artifacts:structuredClone(c.output.artifacts),risks:[...c.output.unresolvedRisks],
        durationMs:start?Date.parse(event.at)-Date.parse(start.at):null,toolCalls:count?.calls??0,toolFailures:count?.failures??0,
        ...(attributed?{accounting:accounting?.status==='available'&&start?structuredClone(accounting.groups[start.id]??null):null}:{})};
      outcomes.set(event.id,outcome);
      for(const {cycle,attempts} of pending.values())if(cycle.application&&!cycle.withdrawal&&attempts.get(c.taskId)===attempt&&!cycle.results.some(r=>r.taskId===c.taskId))cycle.results.push(outcome);
    }else if(c.type==='task_accepted'){
      const outcome=[...outcomes.values()].reverse().find(o=>o.taskId===c.taskId);
      if(outcome){
        const accepted:CycleOutcome={...outcome,status:'completed',event:ref(event)};outcomes.set(event.id,accepted);
        for(const {cycle} of pending.values()){const index=cycle.results.findIndex(r=>r.event.id===outcome.event.id);if(index>=0&&!cycle.withdrawal)cycle.results[index]=accepted;}
      }
    }else if(c.type==='supervision_decided'&&!(c.role==='controller'&&policy.reviewerId)){
      const decision=c.decision;if(!('hypothesis'in decision)){reviewRequest=null;continue;}
      const targets=decision.action==='decompose'?decision.children.tasks.map(t=>t.id):[decision.taskId];
      const baseline=decision.evidence.map(id=>outcomes.get(id)).filter((v):v is CycleOutcome=>!!v&&(decision.action==='decompose'||v.taskId===decision.taskId));
      const parent=decision.action==='decompose'?agentCycles.get(decision.children.parentId):taskCycles.get(decision.taskId);
      const controllerHealth=health.get(`${c.round}:controller`),reviewerHealth=health.get(`${c.round}:reviewer`),providerHealth=controllerHealth?{controller:controllerHealth,...(reviewerHealth?{reviewer:reviewerHealth}:{})}:undefined;
      const cycle:ImprovementCycle={version:providerHealth?3:attributed?2:1,id:event.id,runId:manifest.id,round:c.round,principle:policy.principle,parentCycleId:parent??null,previousCycleId:decision.action==='decompose'?null:previous.get(decision.taskId)??null,status:'proposed',
        trigger:{reason:decision.reason,events:decision.evidence.map(id=>ref(events.get(id)!))},hypothesis:{text:decision.hypothesis,state:'proposed'},proposedChange:structuredClone(decision),expectedMetric:{...decision.expectedMetric,state:'proposed'},
        budget:{deadline:execution.header.deadline,limits:structuredClone(context.plan.limits),accounts:cycleAccounts(decision.action==='decompose'?{...context,plan:{...context.plan,agents:[...context.plan.agents,...decision.children.agents.filter(a=>!context.plan.agents.some(existing=>existing.id===a.id))],tasks:[...context.plan.tasks,...decision.children.tasks.filter(t=>!context.plan.tasks.some(existing=>existing.id===t.id))]}}:context,targets,policy.controllerId,policy.reviewerId)},
        approval:{proposal:reviewRequest,approval:null,execution:'pending',planHash:manifest.planHash,approvalRevision:execution.header.approvalRevision,production:'not-approved'},withdrawal:null,application:null,targetTaskIds:targets,baseline,results:[],metrics:[],risks:[],
        isolation:{mode:context.plan.workspace.isolation?'git-worktree':'unavailable',image:context.plan.workspace.isolation?.image??null},
        rollback:{kind:'retained-source-and-artifacts',manifestHash:manifest.hash,baselineEvents:baseline.map(o=>o.event),patches:baseline.flatMap(o=>o.artifacts.filter(a=>a.kind==='patch')),productionChanged:false,baseCommit:null},
        source:{manifestHash:manifest.hash,executionRevision:execution.state.revision,decision:ref(event)},...(providerHealth?{providerHealth}:{})};
      history.cycles.push(cycle);pending.set(cycle.id,{cycle,attempts:new Map(targets.map(id=>[id,(baseline.find(o=>o.taskId===id)?.attempt??0)+1]))});
    }else if(c.type==='supervision_proposed'||c.type==='supervision_approved'){
      const item=pending.get(c.decisionId);if(item)item.cycle.approval[c.type==='supervision_proposed'?'proposal':'approval']=ref(event);
    }else if(c.type==='supervision_withdrawn'){
      reviewRequest=null;
      const item=pending.get(c.decisionId);if(item)item.cycle.withdrawal=ref(event);
    }else if(c.type==='supervision_applied'){
      reviewRequest=null;
      const item=pending.get(c.decisionId);if(!item)continue;
      const cycle=item.cycle;cycle.application=ref(event);cycle.approval.execution='reviewed-policy';
      if(cycle.proposedChange.action==='decompose'){
        for(const task of cycle.proposedChange.children.tasks)taskCycles.set(task.id,cycle.id);
        for(const agent of cycle.proposedChange.children.agents)agentCycles.set(agent.id,cycle.id);
      }else previous.set(cycle.proposedChange.taskId,cycle.id);
    }
  }
  for(const cycle of history.cycles){
    if(cycle.application){
      const complete=cycle.results.length===cycle.targetTaskIds.length;
      cycle.status=complete?(cycle.results.every(r=>r.status==='completed')?'verified':cycle.results.some(r=>r.status==='cancelled')?'cancelled':cycle.results.some(r=>['failed','denied','unknown'].includes(r.status))?'failed':'partial')
        :execution.state.status==='cancelled'?'cancelled':execution.state.status==='running'?'running':'partial';
    }
    if(cycle.withdrawal)cycle.status='withdrawn';
    cycle.metrics=cycleMetrics(cycle.baseline,cycle.results,cycle.targetTaskIds);
    cycle.risks=[...new Set([...cycle.baseline,...cycle.results].flatMap(o=>o.risks))];
  }
  if(history.cycles.some(cycle=>cycle.version===3))history.version=3;
  return history;
}

function cycleAccounts(context:RunPlanContext,targets:string[],controller:string,reviewer?:string):ImprovementCycle['budget']['accounts'] {
  const ids=new Set([controller,...(reviewer?[reviewer]:[]),...context.plan.tasks.filter(t=>targets.includes(t.id)).map(t=>t.agentId)]);
  for(let i=0;i<context.plan.agents.length;i++)for(const agent of context.plan.agents)if(ids.has(agent.id)&&agent.parentId)ids.add(agent.parentId);
  return context.plan.agents.filter(a=>ids.has(a.id)).map(({id,parentId,tokenBudget,costBudgetUsd,timeBudgetMs,maxChildDepth,maxChildCount,allowedTools,allowedPaths})=>({id,parentId,tokenBudget,costBudgetUsd,timeBudgetMs,maxChildDepth,maxChildCount,allowedTools:[...allowedTools],allowedPaths:structuredClone(allowedPaths)}));
}
