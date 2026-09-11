import {parseArgs} from 'node:util';
import {getProviderNames} from '../config.js';
import {approvalDisplayText} from '../approvals/index.js';
import {isCancellation,throwIfCancelled} from '../cancellation.js';
import {SessionPolicyError} from '../session-management/index.js';
import {ExecutionLimitError} from '../execution/index.js';
import {OrchestrationError} from '../orchestration/index.js';
import {GoalStore} from './store.js';
import {startGoal,approveGoal,resumeGoal,inspectGoal,cancelGoal,reviseGoal,type GoalOptions,type GoalResult} from './actions.js';
import type {GoalLimits,GoalTeam} from './types.js';
import {validateGoalTeam} from './team.js';

export const GOAL_USAGE='calliope orchestrate <goal> [--tokens N] [--cost USD] [--time-ms N] [--provider NAME] [--model ID] [--worker-provider NAME --worker-model ID] [--reviewer-provider NAME --reviewer-model ID] [--attempts 1..4] [--json] | orchestrate status|proposal|replay|resume|cancel <goal-id> | orchestrate approve <goal-id> <proposal-hash> [--allow-mutations] | orchestrate revise <goal-id> <plan.json> | orchestrate list';
export type GoalCommandOptions=GoalOptions&{cwd?:string;write?:(text:string)=>void};
const numeric={tokens:'tokenBudget',cost:'costBudgetNanos','time-ms':'timeBudgetMs','planning-tokens':'planningTokens','planning-cost':'planningCostNanos','planning-time-ms':'planningTimeMs','max-output-tokens':'maxOutputTokens','max-agents':'maxAgents','max-tasks':'maxTasks','max-depth':'maxDepth','max-concurrent':'maxConcurrent'} as const;
const stringFlags=Object.fromEntries([...Object.keys(numeric),'provider','model','planner-provider','planner-model','worker-provider','worker-model','reviewer-provider','reviewer-model','attempts'].map(key=>[key,{type:'string' as const}]));
const actions=['plan','list','status','proposal','replay','resume','cancel','approve','revise'];
export function formatGoal(value:GoalResult,action='status'):string {
  const {goal,status,execution}=value,m=goal.manifest,lines=[`Goal ${m.id} · ${status}`,m.goal,`Total limit: ${m.limits.tokenBudget} tokens · $${m.limits.costBudgetNanos/1e9} · deadline ${new Date(m.deadline).toISOString()}`,`Planning: ${goal.state.planningSpend?.tokens??'unknown'} tokens charged · execution ${goal.state.execution?.runId??'not allocated'}`];
  if(m.team)lines.push(`Planner/controller: ${m.preference.provider}:${m.preference.model??'auto'} · workers: ${m.team.workers?m.team.workers.provider+':'+(m.team.workers.model??'auto'):'inherit'} · reviewer: ${m.team.reviewer?m.team.reviewer.provider+':'+(m.team.reviewer.model??'auto'):'none'} · maximum task attempts: ${m.team.maxAttempts??'per plan'}`);
  if(goal.proposal){lines.push(`Proposal SHA-256 ${goal.proposal.hash}`,`${goal.proposal.plan.agents.length} agents · ${goal.proposal.plan.tasks.length} tasks · inferred ${goal.proposal.inferred} · knowledge proposed`);
    if(status==='review_required'||action==='proposal')lines.push('Review the full proposed plan, including its acceptance checks:',JSON.stringify(goal.proposal.plan,null,2),`Approve: calliope orchestrate approve ${m.id} ${goal.proposal.hash}`);
  }
  if(goal.state.revoked)lines.push('Cancellation requested; inspect linked run owners and task status to confirm cleanup.');
  if(value.interrupted)lines.push('The previous owner stopped; inspect recorded attempts before resuming.');
  if(execution)for(const task of Object.values(execution.state.tasks))lines.push(`${task.id} · ${task.status} · ${task.output?.testEvidence.length??0} passing acceptance checks`);
  if(action==='replay')for(const event of goal.events)lines.push(`${event.sequence}. ${event.at} ${event.change.type} · ${event.id}`);
  const last=goal.events.at(-1)?.change;if(last&&'reason'in last)lines.push(last.reason);
  return approvalDisplayText(lines.join('\n'));
}

/** A headless goal stops at review; only a named proposal hash authorizes execution. */
export async function runGoalCommand(args:string[],options:GoalCommandOptions={}):Promise<number> {
  const delimiter=args.indexOf('--'),json=args.slice(0,delimiter<0?args.length:delimiter).includes('--json'),write=options.write??(text=>{process.stdout.write(text);});
  let action='plan',goalId:string|undefined;
  const emit=(type:string,data:unknown,text:string)=>write(json?JSON.stringify({version:1,type,action,...(goalId?{goalId}:{}),data})+'\n':approvalDisplayText(text)+'\n');
  const report=(value:GoalResult)=>{emit('orchestration.goal',value,formatGoal(value,action));return value.exitCode;};
  try {
    let parsed:ReturnType<typeof parseArgs>;try{parsed=parseArgs({args,allowPositionals:true,tokens:true,options:{...stringFlags,json:{type:'boolean'},'allow-mutations':{type:'boolean'},'read-path':{type:'string',multiple:true},'write-path':{type:'string',multiple:true}}});}catch{throw new OrchestrationError('invalid',GOAL_USAGE);}
    if(args.length>128||args.some(arg=>arg.length>8192||/[\x00-\x1f\x7f]/.test(arg)))throw new OrchestrationError('invalid',GOAL_USAGE);
    const {positionals:p,values:v}=parsed,first=parsed.tokens?.find(token=>token.kind==='positional'),explicit=actions.includes(p[0]??'')&&(delimiter<0||first!==undefined&&first.index<delimiter);action=explicit?p.shift()!:'plan';
    if(action==='plan'?!p.length:action==='list'?p.length!==0:p.length!==(action==='approve'||action==='revise'?2:1))throw new OrchestrationError('invalid',GOAL_USAGE);
    const execution=action==='approve'||action==='resume',configuration=Object.keys(v).some(key=>![...(execution?['allow-mutations','max-output-tokens']:[]),'json'].includes(key));
    if(action!=='plan'&&configuration||v['allow-mutations']&&!execution)throw new OrchestrationError('invalid',GOAL_USAGE);
    for(const part of ['provider','model'])if(v['planner-'+part]!==undefined){if(v[part]!==undefined)throw new OrchestrationError('invalid','Use either --planner-'+part+' or --'+part+'.');v[part]=v['planner-'+part];}
    const team:GoalTeam={version:1,...options.team};
    for(const [flag,key]of [['worker','workers'],['reviewer','reviewer']] as const){
      if(v[flag+'-model']!==undefined&&v[flag+'-provider']===undefined)throw new OrchestrationError('invalid','--'+flag+'-model requires --'+flag+'-provider.');
      if(v[flag+'-provider']!==undefined)team[key]={provider:String(v[flag+'-provider']),...(v[flag+'-model']!==undefined?{model:String(v[flag+'-model'])}:{})};
    }
    if(v.attempts!==undefined){if(!/^[1-4]$/.test(String(v.attempts)))throw new OrchestrationError('invalid','--attempts must be between 1 and 4.');team.maxAttempts=Number(v.attempts);}
    const configuredTeam=Object.keys(team).length>1?validateGoalTeam(team):undefined;
    if(v.provider!==undefined&&v.provider!=='auto'&&!getProviderNames().includes(String(v.provider) as never))throw new OrchestrationError('invalid','Unknown goal provider.');
    const limits:Partial<GoalLimits>={...options.limits};
    for(const [flag,key]of Object.entries(numeric))if(v[flag]!==undefined){const raw=String(v[flag]),money=key.endsWith('Nanos');if(!(money?/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/:/^\d+$/).test(raw))throw new OrchestrationError('invalid',`Invalid --${flag}.`);const value=money?Number(BigInt(raw.split('.')[0]!)*1000000000n+BigInt((raw.split('.')[1]??'').padEnd(9,'0'))):Number(raw);if(!Number.isSafeInteger(value)||value<0||(!money&&key!=='maxDepth'&&value===0))throw new OrchestrationError('invalid',`Invalid --${flag}.`);limits[key as keyof GoalLimits]=value;}
    if(limits.maxOutputTokens!==undefined&&limits.maxOutputTokens>100000000)throw new OrchestrationError('invalid','Invalid --max-output-tokens.');
    const cwd=options.cwd??process.cwd(),goals=options.goals??new GoalStore();throwIfCancelled(options.signal);
    const opts:GoalOptions={...options,goals,limits,...(configuredTeam?{team:configuredTeam}:{}),...(v.provider||v.model?{preference:{provider:String(v.provider??options.preference?.provider??'auto'),...(v.model?{model:String(v.model)}:{})}}:{}),...(v['read-path']||v['write-path']?{workspace:{allowedTools:['think','read_file','list_files',...(v['write-path']?['write_file','edit_file']:[])],allowedPaths:[...(v['read-path'] as string[]??[]).map(path=>({path,access:'read' as const})),...(v['write-path'] as string[]??[]).map(path=>({path,access:'write' as const}))]}}:{}),...(execution&&limits.maxOutputTokens!==undefined?{maxOutputTokens:limits.maxOutputTokens}:{}),...(v['allow-mutations']?{approve:async()=> 'allow' as const}:{}),
      onCreated:view=>{goalId=view.manifest.id;options.onCreated?.(view);emit('orchestration.goal.created',{manifest:view.manifest},`Created goal ${goalId}.`);},
      onGoalEvent:event=>{options.onGoalEvent?.(event);emit('orchestration.goal.event',event,`${event.sequence}. ${event.change.type}`);},
      onRunEvent:event=>{options.onRunEvent?.(event);emit('orchestration.goal.run_event',event,`Run ${event.runId}: ${event.change.type}${'taskId'in event.change?' · '+event.change.taskId:''}`);}};
    if(action==='list'){const listed=goals.list(cwd);emit('orchestration.goal.list',listed,listed.goals.map(g=>`${g.manifest.id} · ${g.state.status}`).join('\n')||`No project goals. ${listed.unavailable} unavailable records.`);return 0;}
    if(action==='plan'){
      const planned=await startGoal(cwd,p.join(' '),opts);report(planned);
      if(options.source==='repl'&&planned.status==='review_required'&&options.approve&&!json){action='approve';return report(await approveGoal(cwd,planned.goal.manifest.id,planned.goal.proposal!.hash,opts));}
      return planned.exitCode;
    }
    goalId=p[0]!;
    if(action==='approve'){const pending=await inspectGoal(cwd,goalId,opts);emit('orchestration.goal.review',pending,formatGoal(pending,'proposal'));return report(await approveGoal(cwd,goalId,p[1]!,opts));}
    if(action==='resume')return report(await resumeGoal(cwd,goalId,opts));
    if(action==='revise')return report(await reviseGoal(cwd,goalId,p[1]!,opts));
    if(action==='cancel'){const cancelled=await cancelGoal(cwd,goalId,opts);emit('orchestration.goal.cancelled',{status:'cancellation-requested',goal:cancelled.goal,execution:cancelled.execution,owner:goals.owner(goalId)},formatGoal(cancelled));return 0;}
    const inspected=await inspectGoal(cwd,goalId,opts);report(inspected);return 0;
  }catch(error){
    const cancelled=options.signal?.aborted||isCancellation(error),denied=error instanceof SessionPolicyError||error instanceof ExecutionLimitError||error instanceof OrchestrationError&&error.code==='policy-denied',invalid=error instanceof OrchestrationError&&error.code==='invalid';
    const code=cancelled?130:denied?3:invalid?2:1,message=cancelled?'Goal operation cancelled; inspect its recorded state before resuming.':error instanceof Error?approvalDisplayText(error.message):'Goal operation failed; preserve its records.';
    write(json?JSON.stringify({version:1,type:'orchestration.goal',action,...(goalId?{goalId}:{}),error:{code:cancelled?'cancelled':denied?'policy-denied':error instanceof OrchestrationError?error.code:'failed',message}})+'\n':message+'\n');return code;
  }
}
