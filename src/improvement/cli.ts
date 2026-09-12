import {parseArgs} from 'node:util';
import {approvalDisplayText} from '../approvals/index.js';
import {isCancellation} from '../cancellation.js';
import {SessionPolicyError} from '../session-management/index.js';
import {ExecutionLimitError} from '../execution/index.js';
import {OrchestrationError} from '../orchestration/types.js';
import type {CoordinatorOptions} from '../orchestration/coordinator.js';
import {inspectImprovements,proposeImprovement,runImprovement,withdrawImprovement} from './actions.js';
import type {ImprovementCycle} from './types.js';

export const IMPROVEMENT_USAGE='calliope improve [history|propose|run <cycle-id> --approve <hash>|rollback <cycle-id>] [--run <run-id>] [--allow-mutations] [--json]';
export function improvementLines(cycles:ImprovementCycle[]):string[] {
  return cycles.slice(-20).flatMap(c=>[`${c.id} · ${c.principle} · ${c.proposedChange.action} · ${c.status}${c.parentCycleId?' · parent '+c.parentCycleId:''}`,
    ...c.metrics.filter(m=>m.comparable).map(m=>`  ${m.name}: ${m.before} → ${m.after} ${m.unit}; observed, not a causal guarantee`)]);
}
export async function runImprovementCommand(args:string[],options:CoordinatorOptions&{cwd?:string;write?:(line:string)=>void}={}):Promise<number> {
  const write=options.write??(line=>process.stdout.write(line)),cwd=options.cwd??process.cwd();let json=args.includes('--json'),action='history';
  const emit=(data:unknown)=>write(JSON.stringify(data)+'\n');
  try{
    if(args.some(v=>v.length>4096||/[\x00-\x1f\x7f]/.test(v)))throw new OrchestrationError('invalid',IMPROVEMENT_USAGE);
    const {values,positionals}=parseArgs({args,allowPositionals:true,options:{run:{type:'string'},approve:{type:'string'},json:{type:'boolean'},'allow-mutations':{type:'boolean'}}});json=!!values.json;action=positionals[0]??'history';
    if(!['history','propose','run','rollback'].includes(action)||positionals.length>(['run','rollback'].includes(action)?2:1)||['run','rollback'].includes(action)&&!positionals[1]||action==='run'&&!values.approve||action!=='run'&&values.approve)throw new OrchestrationError('invalid',IMPROVEMENT_USAGE);
    const opts:CoordinatorOptions={...options,...(values['allow-mutations']?{approve:async()=> 'allow' as const}:{}),confirmation:values['allow-mutations']?'none':options.confirmation??'mutating',onEvent:event=>{options.onEvent?.(event);if(json)emit({version:1,type:'improvement.event',runId:event.runId,event});}};
    let data:unknown,exitCode=0;
    if(action==='history')data=(await inspectImprovements(cwd,values.run,opts)).history;
    else if(action==='propose')data=await proposeImprovement(cwd,values.run,opts);
    else if(action==='rollback')data=await withdrawImprovement(cwd,values.run,positionals[1]!,opts);
    else{const result=await runImprovement(cwd,values.run,positionals[1]!,values.approve!,opts);data=result;exitCode=result.exitCode;}
    if(json)emit({version:1,type:'improvement',action,localOnly:true,data});
    else {
      const value=data as {cycles?:ImprovementCycle[];cycle?:ImprovementCycle;proposalHash?:string;status?:string};
      write(approvalDisplayText([`Improvement ${action}`,value.status?`Execution ${value.status}`:'',...improvementLines(value.cycles??(value.cycle?[value.cycle]:[])),value.proposalHash?`Review hash: ${value.proposalHash}`:'',action==='rollback'?'Strategy withdrawn; retained isolated results and original source remain available.':''].filter(Boolean).join('\n'))+'\n');
    }
    return exitCode;
  }catch(error){
    const cancelled=options.signal?.aborted||isCancellation(error),denied=error instanceof SessionPolicyError||error instanceof ExecutionLimitError||error instanceof OrchestrationError&&error.code==='policy-denied';
    const code=cancelled?'cancelled':denied?'policy-denied':error instanceof OrchestrationError?error.code:error instanceof TypeError?'invalid':'unavailable',exitCode=cancelled?130:denied?3:code==='invalid'?2:1;
    const message=cancelled?'Improvement operation cancelled; inspect retained evidence before retrying.':error instanceof OrchestrationError||error instanceof SessionPolicyError||error instanceof ExecutionLimitError?approvalDisplayText(error.message):'Improvement operation failed; inspect the run and preserve its evidence. '+IMPROVEMENT_USAGE;
    if(json)emit({version:1,type:'improvement',action,localOnly:true,error:{code,message}});else write(message+'\n');return exitCode;
  }
}
