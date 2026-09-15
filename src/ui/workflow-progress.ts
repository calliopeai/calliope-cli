import {projectImprovementHistory} from '../improvement/projection.js';
import {agentPreference,type CoordinatorProgress} from '../orchestration/progress.js';
import {approvalDisplayText} from '../approvals/request.js';
import type {SupervisionHealthEvidence} from '../supervision/types.js';

export type WorkflowHudMode='agents'|'workflows'|'off';
export interface WorkflowRow {id:string;label:string;active:boolean}
export interface WorkflowSnapshot {
  id:string;revision:string;accountingRevision?:string;goalAccountingRevision?:string;status:string;summary:string;agents:WorkflowRow[];
}
const dollars=(nanos:number)=>nanos>0&&nanos<100000?'<$0.0001':'$'+(nanos/1e9).toFixed(4);
const cycleHudCache=new Map<string,{revision:string;label:string}>();
function cycleHud(progress:CoordinatorProgress):string {
  if(!progress.manifest||!progress.context.plan.supervision)return '';
  const accounting=progress.accounting?.status==='available'?progress.accounting.attribution:undefined;
  const revision=progress.execution.state.revision+':'+(accounting?.status==='available'?accounting.revision:'unavailable');
  const prior=cycleHudCache.get(progress.context.id);if(prior?.revision===revision)return prior.label;
  const cycles=projectImprovementHistory(progress.manifest,progress.execution,progress.context,accounting).cycles,last=cycles.at(-1),check=last?.metrics.find(m=>m.name==='acceptance-check-pass-rate'&&m.comparable),cost=last?.metrics.find(m=>m.name==='provider-accounted-cost'&&m.comparable);
  const label=last?` · improvement ${cycles.length} ${last.status}${check?' · checks '+Math.round(check.before!*100)+'→'+Math.round(check.after!*100)+'%':''}${cost?' · attempt cost '+dollars(cost.before!)+'→'+dollars(cost.after!):''}`:'';
  cycleHudCache.delete(progress.context.id);cycleHudCache.set(progress.context.id,{revision,label});if(cycleHudCache.size>3)cycleHudCache.delete(cycleHudCache.keys().next().value!);return label;
}
const clean=(text:string)=>approvalDisplayText(text).replace(/[\r\n\t]/g,' ');
const latestReviewHealth=(progress:CoordinatorProgress):SupervisionHealthEvidence|undefined=>{
  const start=[...progress.execution.events].reverse().find(event=>event.change.type==='supervision_started'&&event.change.health!==undefined);
  return start?.change.type==='supervision_started'?start.change.health:undefined;
};
const sampled=(health:SupervisionHealthEvidence)=>health.status==='available'?health.providers.filter(provider=>provider.sampleCount>0).length:0;
function providerHealthLabel(health:SupervisionHealthEvidence|undefined,provider?:string):string {
  if(!health)return '';
  if(health.status==='unavailable')return ' · review health unavailable';
  const item=health.providers.find(value=>value.provider===provider);
  if(!item)return provider?'':` · review health ${sampled(health)}/${health.providers.length} sampled`;
  if(item.quarantine.active)return ` · review health quarantined${item.quarantine.reason?` (${item.quarantine.reason})`:''}`;
  if(!item.sampleCount)return ' · review health unmeasured';
  const errors=item.errorRate===null?'unknown err':`${Math.round(item.errorRate*100)}% err`;
  return ` · review health ${errors}${item.latencyMs===null?'':`, ${item.latencyMs}ms`}`;
}
function workflowHealthLabel(health:SupervisionHealthEvidence|undefined):string {
  if(!health)return '';
  if(health.status==='unavailable')return ' · review health unavailable';
  const quarantined=health.providers.filter(provider=>provider.quarantine.active).length;
  return ` · review health ${sampled(health)}/${health.providers.length} sampled${quarantined?` · ${quarantined} quarantined`:''}`;
}
/** Presentation only: completion and attempts come from the verified execution projection. */
export function workflowSnapshot(progress:CoordinatorProgress):WorkflowSnapshot {
  const {context,execution,accounting,goalAccounting}=progress;
  const plan=context.plan,state=execution.state,tasks=Object.values(state.tasks),health=latestReviewHealth(progress);
  const complete=tasks.filter(task=>task.status==='completed').length,review=tasks.filter(task=>task.status==='review_required').length;
  const agents=plan.agents.map(agent=>{
    const assigned=tasks.filter(task=>task.agentId===agent.id),current=assigned.find(task=>task.status==='running')??assigned.find(task=>['failed','denied','unknown','cancelled'].includes(task.status))??assigned.find(task=>task.status==='review_required')??assigned.find(task=>task.status==='pending')??assigned.at(-1);
    let ancestor=agent,stopped=false;for(let n=0;n<plan.agents.length;n++){if(state.stoppedAgents.includes(ancestor.id)){stopped=true;break;}const parent=plan.agents.find(a=>a.id===ancestor.parentId);if(!parent)break;ancestor=parent;}
    const supervising=state.supervision?.active?.agentId===agent.id;
    const preference=agentPreference(plan,agent.id),status=stopped?'stopped':supervising?`reviewing round ${state.supervision!.rounds}`:current?.escalation?'escalated':current?.status??'coordinating';
    const recorded=state.routes?.[agent.id],route=supervising?(recorded?.sessionId===state.supervision!.active!.sessionId?recorded.route:undefined):current?.route??(!current?recorded?.route:undefined);
    const choice=route?`actual ${route.provider}:${route.model}`:`choice ${preference.provider??'auto'}:${preference.model??'auto'}`;
    const healthLabel=providerHealthLabel(health,route?.provider??(preference.provider&&preference.provider!=='auto'?preference.provider:undefined));
    const attempt=current?` · ${current.id} ${current.attempts}/${agent.escalationPolicy.maxRetries+1}`:'';
    const account=accounting?.status==='available'?accounting.accounts[agent.id]:undefined;
    const balance=account?` · left ${dollars(account.remaining.costNanos)}, ${account.remaining.tokens} tok${plan.agents.some(a=>a.parentId===agent.id)?' (subtree)':''}`:'';
    return{id:agent.id,active:supervising||current?.status==='running',label:clean(`${agent.id} · ${agent.role} · ${status} · ${choice}${healthLabel}${attempt}${balance} · ${assigned.filter(task=>task.status==='completed').length}/${assigned.length} done${route?' · Smart '+route.profile+'/'+route.stage+' · '+(route.stage==='escalation'?'failed verification':'live capability/health/latency/cost'):''}`)};
  });
  const s=state.supervision,supervision=s?` · ${plan.supervision!.principle} · controller ${s.phase} ${s.rounds}/${plan.supervision!.maxRounds}${s.halt?' · '+s.halt.reason:''}`:'';
  const balance=accounting?.status==='available'?` · accounted ${dollars(accounting.run.accounted.costNanos)}/${dollars(accounting.run.limit.costNanos)} · left ${accounting.run.remaining.tokens} tok · pending ${accounting.run.requests.pending}, unknown ${accounting.run.requests.unknown}${accounting.exceeded?' · reservation exceeded':''}`:accounting?' · budget unavailable':` · limit $${plan.limits.costBudgetUsd}`;
  const whole=goalAccounting?.status==='available'?` · goal accounted ${dollars(goalAccounting.accounted!.costNanos)}/${dollars(goalAccounting.limit.costNanos)} incl. planning/reviews`:goalAccounting?' · goal budget unavailable':'';
  return{id:context.id,revision:state.revision,...(goalAccounting?{goalAccountingRevision:goalAccounting.status==='unavailable'?'unavailable':goalAccounting.revision}:{}),...(accounting?{accountingRevision:accounting.status==='available'?accounting.revision:'unavailable'}:{}),status:state.status,summary:clean(`Run ${context.id.slice(0,8)} · ${state.status} · ${complete}/${tasks.length} done${review?' · '+review+' review':''}${whole}${balance}${supervision}${workflowHealthLabel(health)}${cycleHud(progress)} · ${plan.goal}`),agents};
}
export function retainWorkflows(previous:WorkflowSnapshot[],next:WorkflowSnapshot):WorkflowSnapshot[] {
  const prior=previous.find(value=>value.id===next.id);
  if(prior?.revision===next.revision&&prior.accountingRevision===next.accountingRevision&&prior.goalAccountingRevision===next.goalAccountingRevision)return previous;
  return[...previous.filter(value=>value.id!==next.id),next].slice(-3);
}
export function workflowLines(workflows:WorkflowSnapshot[],mode:WorkflowHudMode,maxAgents=6):string[] {
  if(mode==='off')return[];
  const lines:string[]=[];
  for(const workflow of workflows){
    lines.push(workflow.summary);
    if(mode==='agents'&&workflow===workflows.at(-1)){
      const rows=[...workflow.agents].sort((a,b)=>Number(b.active)-Number(a.active)),limit=Math.max(0,Math.min(16,Math.floor(maxAgents)||0));
      lines.push(...rows.slice(0,limit).map(row=>'  '+row.label));
      if(rows.length>limit)lines.push(`  +${rows.length-limit} agents · /agents tree --run ${workflow.id}`);
    }
  }
  if(lines.length)lines.push('Control: /agents stop|retry <agent> --run <id> · /agents hud workflows|off');
  return lines;
}
