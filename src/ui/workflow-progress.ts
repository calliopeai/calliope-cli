import {agentPreference,type CoordinatorProgress} from '../orchestration/progress.js';
import {approvalDisplayText} from '../approvals/request.js';

export type WorkflowHudMode='agents'|'workflows'|'off';
export interface WorkflowRow {id:string;label:string;active:boolean}
export interface WorkflowSnapshot {
  id:string;revision:string;status:string;summary:string;agents:WorkflowRow[];
}
const clean=(text:string)=>approvalDisplayText(text).replace(/[\r\n\t]/g,' ');
/** Presentation only: completion and attempts come from the verified execution projection. */
export function workflowSnapshot({context,execution}:CoordinatorProgress):WorkflowSnapshot {
  const plan=context.plan,state=execution.state,tasks=Object.values(state.tasks);
  const complete=tasks.filter(task=>task.status==='completed').length,review=tasks.filter(task=>task.status==='review_required').length;
  const agents=plan.agents.map(agent=>{
    const assigned=tasks.filter(task=>task.agentId===agent.id),current=assigned.find(task=>task.status==='running')??assigned.find(task=>['failed','denied','unknown','cancelled'].includes(task.status))??assigned.find(task=>task.status==='review_required')??assigned.find(task=>task.status==='pending')??assigned.at(-1);
    let ancestor=agent,stopped=false;for(let n=0;n<plan.agents.length;n++){if(state.stoppedAgents.includes(ancestor.id)){stopped=true;break;}const parent=plan.agents.find(a=>a.id===ancestor.parentId);if(!parent)break;ancestor=parent;}
    const preference=agentPreference(plan,agent.id),status=stopped?'stopped':current?.escalation?'escalated':current?.status??'coordinating';
    const attempt=current?` · ${current.id} ${current.attempts}/${agent.escalationPolicy.maxRetries+1}`:'';
    return{id:agent.id,active:current?.status==='running',label:clean(`${agent.id} · ${agent.role} · ${status} · choice ${preference.provider??'auto'}:${preference.model??'auto'}${attempt} · ${assigned.filter(task=>task.status==='completed').length}/${assigned.length} done`)};
  });
  return{id:context.id,revision:state.revision,status:state.status,summary:clean(`Run ${context.id.slice(0,8)} · ${state.status} · ${complete}/${tasks.length} done${review?' · '+review+' review':''} · limit $${plan.limits.costBudgetUsd} · ${plan.goal}`),agents};
}
export function retainWorkflows(previous:WorkflowSnapshot[],next:WorkflowSnapshot):WorkflowSnapshot[] {
  if(previous.find(value=>value.id===next.id)?.revision===next.revision)return previous;
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
