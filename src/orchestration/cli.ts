import { parseArgs } from 'node:util';
import { SessionPolicyError } from '../session-management/index.js';
import { isCancellation, throwIfCancelled } from '../cancellation.js';
import { approvalDisplayText } from '../approvals/index.js';
import { OrchestrationError, type AgentContract, type PreparedRun, type ProjectTask, type ProjectPlan, type OrchestrationEvent } from './types.js';
import { RunStore } from './store.js';
import { loadRunPlan, prepareRun, changePreparedRun, inspectRun, type RunActionOptions } from './actions.js';
import {executionCommand,type ExecutionCommandOptions} from './execution-cli.js';
export const ORCHESTRATION_USAGE = 'calliope run <plan> --dry-run | run prepare <plan> | run [list|status|replay] [run-id] | run approve|cancel <run-id> | agents [--tree] [--run <id>] | tasks [--graph] [--run <id>] [--json]';
/** Quotes group arguments only; substitutions and commands are never evaluated. */
export function parseOrchestrationArgs(input: string): string[] {
  if (input.length > 32768) throw new OrchestrationError('invalid','Orchestration command exceeds 32,768 characters.');
  const args: string[] = []; let value = '', quote = '', present = false;
  const push = () => { if (present) { args.push(value); value = ''; present = false; if (args.length > 128) throw new OrchestrationError('invalid','Too many orchestration arguments.'); } };
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === '\\' && quote !== "'") { if (++i >= input.length) throw new OrchestrationError('invalid','Incomplete argument escape.'); value += input[i]; present = true; }
    else if (quote) { if (char === quote) quote = ''; else value += char; }
    else if (char === '"' || char === "'") { quote = char; present = true; }
    else if (/\s/.test(char)) push();
    else { value += char; present = true; }
  }
  if (quote) throw new OrchestrationError('invalid','Unclosed argument quote.'); push(); return args;
}
export interface OrchestrationReport {
  version: 1; type: 'orchestration'; action: string; localOnly: true; execution: 'not-started';
  data?: unknown; error?: { code: string; message: string };
}
export type OrchestrationNamespace = 'run' | 'agents' | 'tasks';
export function isSpawnArgs(args:string[]):boolean {
  try{return parseArgs({args,strict:false,allowPositionals:true,options:{run:{type:'string'},approve:{type:'string'},resume:{type:'string'},'max-output-tokens':{type:'string'}}}).positionals[0]==='spawn';}catch{return false;}
}
export async function orchestrationCommand(namespace: OrchestrationNamespace, args: string[], options: RunActionOptions & {cwd?: string} = {}): Promise<{report:OrchestrationReport;exitCode:number}> {
  let action = namespace as string;
  const response = (data: unknown) => ({exitCode:0,report:{version:1 as const,type:'orchestration' as const,action,localOnly:true as const,execution:'not-started' as const,data}});
  const failure = (code: string, message: string, exitCode: number) => ({exitCode,report:{version:1 as const,type:'orchestration' as const,action,localOnly:true as const,execution:'not-started' as const,error:{code,message}}});
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({args,allowPositionals:true,options:{json:{type:'boolean'},'dry-run':{type:'boolean'},tree:{type:'boolean'},graph:{type:'boolean'},run:{type:'string'}}}); }
  catch { return failure('invalid-arguments',ORCHESTRATION_USAGE,2); }
  const {positionals,values} = parsed;
  if (args.some(arg => arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg))) return failure('invalid-arguments',ORCHESTRATION_USAGE,2);
  const cwd = options.cwd ?? process.cwd(), store = options.store ?? new RunStore(), opts = {...options,store};
  try {
    throwIfCancelled(options.signal);
    if (namespace !== 'run') {
      const expected = namespace === 'agents' ? 'tree' : 'graph';
      if (values['dry-run'] || values[expected === 'tree' ? 'graph' : 'tree'] || positionals.length > 2 || positionals[0] && positionals[0] !== expected || positionals[1] && values.run) return failure('invalid-arguments',ORCHESTRATION_USAGE,2);
      const view = await inspectRun(cwd,positionals[1] ?? values.run as string | undefined,opts);
      return response(namespace === 'agents' ? {run:view.run,coordinatorId:view.analysis.coordinatorId,depths:view.analysis.depths,agents:view.manifest.plan.agents}
        : {run:view.run,tasks:view.manifest.plan.tasks,stages:view.analysis.stages,conflicts:view.analysis.conflicts});
    }
    if (values.tree || values.graph || values.run) return failure('invalid-arguments',ORCHESTRATION_USAGE,2);
    action = positionals[0] ?? 'list';
    if (values['dry-run']) {
      if (positionals.length !== 1) return failure('invalid-arguments',ORCHESTRATION_USAGE,2);
      action = 'dry-run'; const {analysis,project,source} = await loadRunPlan(cwd,positionals[0]!,true,opts);
      return response({project,source,planHash:analysis.hash,plan:analysis.plan,coordinatorId:analysis.coordinatorId,stages:analysis.stages,conflicts:analysis.conflicts,approval:'not-requested',modelDiscovery:'not-checked',executedTasks:0});
    }
    const arities: Record<string, number[]> = {list:[0],status:[0,1],replay:[1],prepare:[1],approve:[1],cancel:[1]};
    const count = positionals.length ? positionals.length - 1 : 0;
    if (!Object.hasOwn(arities,action) || !arities[action]!.includes(count)) return failure('invalid-arguments',ORCHESTRATION_USAGE + '. Child execution is not available in this preparation command.',2);
    if (action === 'list') return response(await store.list(cwd,options.signal));
    if (action === 'prepare') { const view = await prepareRun(cwd,positionals[1]!,opts); return response({run:view.run,coordinatorId:view.analysis.coordinatorId,agents:view.manifest.plan.agents.length,tasks:view.manifest.plan.tasks.length,stages:view.analysis.stages,conflicts:view.analysis.conflicts}); }
    if (action === 'approve' || action === 'cancel') return response({run:(await changePreparedRun(cwd,positionals[1]!,action === 'approve' ? 'approved' : 'cancelled',opts)).run});
    const view = await inspectRun(cwd,positionals[1],opts);
    return response(action === 'replay' ? {run:view.run,events:view.events} : {run:view.run,coordinatorId:view.analysis.coordinatorId,agents:view.manifest.plan.agents.length,tasks:view.manifest.plan.tasks.length,stages:view.analysis.stages,conflicts:view.analysis.conflicts});
  } catch (error) {
    if (options.signal?.aborted || isCancellation(error)) return failure('cancelled','Operation cancelled. Inspect recorded state before retrying; no child agents were started.',130);
    if (error instanceof SessionPolicyError) return failure('policy-denied',error.message,3);
    if (error instanceof OrchestrationError) return failure(error.code,approvalDisplayText(error.message),error.code === 'policy-denied' ? 3 : 1);
    return failure('unavailable','Run operation failed. Check the project, plan, local store permissions and available space; preserve existing records.',1);
  }
}
export function formatOrchestration(report: OrchestrationReport): string {
  if (report.error) return report.error.message;
  const data = report.data as {run?:PreparedRun;runs?:PreparedRun[];unavailable?:number;agents?:AgentContract[]|number;tasks?:ProjectTask[]|number;plan?:ProjectPlan;planHash?:string;depths?:Record<string,number>;stages?:string[][];conflicts?:{tasks:[string,string];paths:string[]}[];events?:OrchestrationEvent[]};
  const lines = [`Orchestration ${report.action} · no child execution`];
  if (data.run) lines.push(`Run ${data.run.id} · ${data.run.status} · approval ${data.run.approval}`, `Plan SHA-256 ${data.run.planHash} · revision ${data.run.revision}`);
  if (data.plan) lines.push(`Plan ${data.plan.id}: ${data.plan.goal}`, `SHA-256 ${data.planHash}`, `${data.plan.agents.length} declared agents · ${data.plan.tasks.length} tasks · concurrency limit ${data.plan.limits.maxConcurrent}`, `Budgets: ${data.plan.limits.tokenBudget} tokens · $${data.plan.limits.costBudgetUsd} · ${data.plan.limits.timeBudgetMs} ms`, 'Model compatibility has not been checked.');
  if (data.runs) { for (const run of data.runs) lines.push(`${run.id} · ${run.status} · ${run.eventCount} events · ${run.updatedAt}`); if (!data.runs.length) lines.push('No prepared runs in this project.'); if (data.unavailable) lines.push(`${data.unavailable} run directories are unavailable; preserve them for inspection.`); }
  if (Array.isArray(data.agents)) {
    const agents = data.agents;
    const tree = (parentId: string | null, indent: string) => { for (const agent of agents.filter(agent => agent.parentId === parentId).sort((a,b) => a.id.localeCompare(b.id))) {
      lines.push(`${indent}${parentId ? '└─ ' : ''}${agent.id} · ${agent.role} · planned`); tree(agent.id,indent+'   ');
    } }; tree(null,'');
  }
  if (Array.isArray(data.tasks)) for (const task of data.tasks) lines.push(`${task.id} → ${task.agentId} · depends on ${task.dependencies.join(', ') || 'none'} · pending`);
  if (data.stages) data.stages.forEach((stage,index) => lines.push(`Dependency stage ${index+1}: ${stage.join(', ')}`));
  if (data.conflicts?.length) { lines.push(`${data.conflicts.length} write/read scope overlaps require scheduling or isolation:`); for (const conflict of data.conflicts.slice(0,40)) lines.push(`${conflict.tasks.join(' ↔ ')}: ${conflict.paths.join(', ')}`); if (data.conflicts.length > 40) lines.push('Further overlaps are available with --json.'); }
  if (data.events) for (const event of data.events) lines.push(`${event.sequence}. ${event.at} ${event.change.type} · ${event.id}`);
  lines.push('Plan approval records intent; runtime permission and budget gates still apply.');
  const display = approvalDisplayText(lines.join('\n'));
  return display.length > 32000 ? display.slice(0,32000)+'\n[Display limited to 32,000 characters; use --json for the complete report.]' : display;
}
export async function runOrchestrationCommand(namespace: OrchestrationNamespace,args:string[],options:ExecutionCommandOptions = {}): Promise<number> {
  if(namespace==='agents'&&isSpawnArgs(args))return(await import('../spawning/index.js')).spawnCommand(args,options);
  const executed=await executionCommand(namespace,args,options);if(executed!==null)return executed;
  const result = await orchestrationCommand(namespace,args,options);
  const delimiter = args.indexOf('--'), json = args.slice(0, delimiter < 0 ? args.length : delimiter).includes('--json');
  (options.write ?? (text => {process.stdout.write(text); }))(json ? JSON.stringify(result.report)+'\n' : formatOrchestration(result.report)+'\n');
  return result.exitCode;
}
