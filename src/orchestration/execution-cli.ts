import {parseArgs} from 'node:util';
import {approvalDisplayText} from '../approvals/index.js';
import {isCancellation} from '../cancellation.js';
import {SessionPolicyError} from '../session-management/index.js';
import {ExecutionLimitError} from '../execution/index.js';
import {executeReviewedRun,type CoordinatorOptions} from './coordinator.js';
import {inspectExecution,controlExecution} from './coordinator-actions.js';
import {prepareRun,changePreparedRun} from './actions.js';
import {OrchestrationError} from './types.js';
import {RunStore} from './store.js';
import type {ExecutionInspection} from './coordinator-types.js';
import type {OrchestrationNamespace} from './cli.js';
import {analyzePlan} from './validation.js';

export const EXECUTION_USAGE='calliope run execute|resume <run-id> [--allow-mutations] [--max-output-tokens N] [--json] | run retry|accept <run-id> <task-id> | agents stop|retry <agent-id> --run <run-id>';
export type ExecutionCommandOptions=CoordinatorOptions&{cwd?:string;write?:(text:string)=>void};
export function formatExecutionData(action:string,value:unknown):string {
  const data=value as {runId?:string;status?:string;interrupted?:boolean;execution?:ExecutionInspection;agents?:{id:string;parentId:string|null;role:string}[];runs?:{runId:string;status:string;completed:number;total:number}[]};
  const lines=[`Orchestration ${action}${data.runId?' · '+data.runId:''}${data.status?' · '+data.status:''}`];
  if(data.interrupted)lines.push('Coordinator is no longer active; interrupted tasks need inspection before retry.');
  if(data.runs)for(const run of data.runs)lines.push(`${run.runId} · ${run.status} · ${run.completed}/${run.total} verified tasks`);
  const state=data.execution?.state;
  if(state){
    if(data.agents){const tree=(parent:string|null,depth:number)=>{for(const agent of data.agents!.filter(a=>a.parentId===parent)){const tasks=Object.values(state.tasks).filter(t=>t.agentId===agent.id);lines.push(`${'   '.repeat(depth)}${parent?'└─ ':''}${agent.id} · ${agent.role}${state.stoppedAgents.includes(agent.id)?' · stopped':''}${tasks.length?' · '+tasks.map(t=>t.status+(t.escalation?' (escalated to '+t.escalation+')':'')).join(', '):''}`);tree(agent.id,depth+1);}};tree(null,0);}
    for(const task of Object.values(state.tasks)){lines.push(`${task.id} · ${task.status} · ${task.attempts} attempt(s)`);if(task.output){lines.push(`  ${task.output.summary}`,`  ${task.output.testEvidence.length} passing acceptance checks`);for(const risk of task.output.unresolvedRisks)lines.push(`  Review: ${risk}`);for(const artifact of task.output.artifacts)lines.push(`  Artifact ${artifact.id}: ${artifact.location}:${artifact.path} · SHA-256 ${artifact.sha256}`);}}
    if(action==='replay')for(const event of data.execution!.events)lines.push(`${event.sequence}. ${event.at} ${event.change.type} · ${event.id}`);
  }
  const display=approvalDisplayText(lines.join('\n'));return display.length>32000?display.slice(0,32000)+'\n[Display limited; use --json for complete evidence.]':display;
}
/** Keep version-1 inactive reports separate; execution emits version-2 JSON envelopes. */
export async function executionCommand(namespace:OrchestrationNamespace,args:string[],options:ExecutionCommandOptions):Promise<number|null> {
  const delimiter=args.indexOf('--'),flags=args.slice(0,delimiter<0?args.length:delimiter),json=flags.includes('--json');
  let parsed:ReturnType<typeof parseArgs>;
  try{parsed=parseArgs({args,allowPositionals:true,options:{json:{type:'boolean'},'allow-mutations':{type:'boolean'},'max-output-tokens':{type:'string'},run:{type:'string'},tree:{type:'boolean'},graph:{type:'boolean'},'dry-run':{type:'boolean'}}});}catch{return null;}
  const {positionals:p,values:v}=parsed,action=p[0]??'list',cwd=options.cwd??process.cwd();
  const controls=namespace==='agents'&&['stop','retry'].includes(action),execution=namespace==='run'&&['execute','resume','retry','accept'].includes(action),taskApproval=namespace==='run'&&action==='approve'&&p.length===3;
  const candidate=namespace==='run'&&!['list','status','replay','prepare','approve','cancel',...['execute','resume','retry','accept']].includes(action)&&p.length===1&&!v['dry-run'];
  if(v['dry-run'])return null;
  const write=options.write??(text=>{process.stdout.write(text);});
  const emit=(value:unknown,text:string)=>write(json?JSON.stringify(value)+'\n':approvalDisplayText(text)+'\n');
  const report=(data:unknown,code=0)=>{emit({version:2,type:'orchestration.execution',action,data},formatExecutionData(action,data));return code;};
  try {
    if(args.some(arg=>arg.length>4096||/[\x00-\x1f\x7f]/.test(arg)))throw new OrchestrationError('invalid',EXECUTION_USAGE);
    if(execution||controls||taskApproval||candidate){
      if(v.tree||v.graph||namespace==='run'&&v.run||candidate&&p.length!==1)throw new OrchestrationError('invalid',EXECUTION_USAGE);
      if(v['allow-mutations']&&!candidate&&!['execute','resume'].includes(action)||v['max-output-tokens']&&!candidate&&!['execute','resume'].includes(action))throw new OrchestrationError('invalid',EXECUTION_USAGE);
      const raw=v['max-output-tokens'];if(raw!==undefined&&(!/^\d+$/.test(String(raw))||!Number.isSafeInteger(Number(raw))||Number(raw)<1||Number(raw)>100000000))throw new OrchestrationError('invalid',EXECUTION_USAGE);
      const opts={...options,...(v['allow-mutations']?{approve:async()=> 'allow' as const}:{}),...(raw?{maxOutputTokens:Number(raw)}:{})};
      if(controls){if(p.length!==2||!v.run)throw new OrchestrationError('invalid',EXECUTION_USAGE);const state=await controlExecution(cwd,String(v.run),action==='stop'?'agent-stop':'agent-retry',p[1]!,opts);return report({runId:String(v.run),status:state.state.status,execution:state});}
      if(action==='retry'||action==='accept'||taskApproval){if(p.length!==3)throw new OrchestrationError('invalid',EXECUTION_USAGE);const state=await controlExecution(cwd,p[1]!,action==='retry'?'retry':'accept',p[2]!,opts);return report({runId:p[1],status:state.state.status,execution:state});}
      let runId:string;
      if(candidate){const prepared=await prepareRun(cwd,action,opts);emit({version:2,type:'orchestration.execution',action:'prepared',data:{runId:prepared.run.id,planHash:prepared.run.planHash}},`Prepared run ${prepared.run.id}.`);runId=prepared.run.id;await changePreparedRun(cwd,runId,'approved',opts);}
      else {if(p.length!==2)throw new OrchestrationError('invalid',EXECUTION_USAGE);runId=p[1]!;}
      const result=await executeReviewedRun(cwd,runId,{...opts,resume:action==='resume',onEvent:event=>{options.onEvent?.(event);emit({version:2,type:'orchestration.event',runId,event},`${event.sequence}. ${event.change.type}${'taskId'in event.change?' · '+event.change.taskId:''}`);}});
      return report(result,result.exitCode);
    }
    // Existing inspection commands upgrade only when that run has execution records.
    if(v['allow-mutations']||v['max-output-tokens'])throw new OrchestrationError('invalid',EXECUTION_USAGE);
    if(namespace==='run'&&action==='list'&&p.length<=1&&!v.run&&!v.tree&&!v.graph){
      const runs=await(options.store??new RunStore()).list(cwd,options.signal),rows=[];let any=false;
      for(const run of runs.runs){const info=await inspectExecution(cwd,run.id,options);any ||= !!info.execution;const tasks=Object.values(info.execution?.state.tasks??{});rows.push({runId:run.id,status:info.execution?.state.status??run.status,completed:tasks.filter(t=>t.status==='completed').length,total:info.execution?tasks.length:info.view.manifest.plan.tasks.length});}
      if(any)return report({runs:rows,unavailable:runs.unavailable});return null;
    }
    let runId:string|undefined;
    if(namespace==='run'&&['status','replay','cancel'].includes(action)&&p.length<=2&&!v.run&&!v.tree&&!v.graph)runId=p[1];
    else if(namespace!=='run'&&p.length<=2){const expected=namespace==='agents'?'tree':'graph';if(p[0]&&p[0]!==expected||p[1]&&v.run||v[expected==='tree'?'graph':'tree'])throw new OrchestrationError('invalid',EXECUTION_USAGE);runId=String(v.run??p[1]??'')||undefined;}
    if(!runId&&(namespace!=='run'||action==='status'))runId=(await(options.store??new RunStore()).list(cwd,options.signal)).runs.at(-1)?.id;
    if(!runId)return null;
    const view=await inspectExecution(cwd,runId,options);if(!view.execution)return null;
    if(namespace==='run'&&action==='cancel'){await changePreparedRun(cwd,runId,'cancelled',options);return report({runId,status:'cancellation-requested',execution:view.store.read(),owner:view.store.owner()});}
    const context=view.store.context(view.execution),analysis=analyzePlan(context.plan);
    options.onProgress?.({context,execution:view.execution});
    return report({runId,status:view.execution.state.status,interrupted:view.execution.state.status==='running'&&!view.owner?.alive,approval:view.view.run.approval,owner:view.owner,execution:view.execution,...(namespace==='agents'?{agents:context.plan.agents,depths:analysis.depths}:namespace==='tasks'?{tasks:context.plan.tasks,stages:analysis.stages,conflicts:analysis.conflicts}:{})});
  }catch(error){
    const cancelled=options.signal?.aborted||isCancellation(error),denied=error instanceof SessionPolicyError||error instanceof ExecutionLimitError||error instanceof OrchestrationError&&error.code==='policy-denied';
    const code=cancelled?130:denied?3:error instanceof OrchestrationError&&error.code==='invalid'?2:1,message=cancelled?'Coordinator operation cancelled; inspect the recorded run before resuming.':error instanceof Error?approvalDisplayText(error.message):'Execution operation failed.';
    emit({version:2,type:'orchestration.execution',action,error:{code:cancelled?'cancelled':denied?'policy-denied':error instanceof OrchestrationError?error.code:'failed',message}},message);return code;
  }
}
