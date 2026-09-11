import {parseArgs} from 'node:util';
import {approvalDisplayText} from '../approvals/index.js';
import {isCancellation,throwIfCancelled} from '../cancellation.js';
import {SessionPolicyError} from '../session-management/index.js';
import {ExecutionLimitError} from '../execution/index.js';
import {OrchestrationError} from '../orchestration/types.js';
import {inspectExecution} from '../orchestration/coordinator-actions.js';
import type {ExecutionCommandOptions} from '../orchestration/execution-cli.js';
import {inspectSpawn,admitSpawn} from './actions.js';
import {SpawnProposalStore} from './store.js';
import {executeSpawn} from './execution.js';

export const SPAWN_USAGE='calliope agents spawn <children.json> --run <id> [--dry-run] [--approve <proposal-hash>] [--allow-mutations] [--json] | agents spawn --resume <proposal-hash> --run <id> [--json]';
export async function spawnCommand(args:string[],options:ExecutionCommandOptions={}):Promise<number> {
  const delimiter=args.indexOf('--'),json=args.slice(0,delimiter<0?args.length:delimiter).includes('--json'),write=options.write??(text=>{process.stdout.write(text);}),cwd=options.cwd??process.cwd();
  const emit=(type:string,data:unknown,text:string)=>write(json?JSON.stringify({version:1,type,data})+'\n':approvalDisplayText(text)+'\n');
  try {
    throwIfCancelled(options.signal);const {positionals:p,values:v}=parseArgs({args,allowPositionals:true,options:{json:{type:'boolean'},run:{type:'string'},approve:{type:'string'},resume:{type:'string'},'dry-run':{type:'boolean'},'allow-mutations':{type:'boolean'},'max-output-tokens':{type:'string'}}});
    if(p[0]!=='spawn'||!v.run||(v.resume?p.length!==1||!!v.approve||!!v['dry-run']:p.length!==2))throw new OrchestrationError('invalid',SPAWN_USAGE);
    if(args.some(arg=>arg.length>4096||/[\x00-\x1f\x7f]/.test(arg))||v['dry-run']&&(v.approve||v['allow-mutations']||v['max-output-tokens']))throw new OrchestrationError('invalid',SPAWN_USAGE);
    const raw=v['max-output-tokens'];if(raw!==undefined&&(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1||Number(raw)>100000000))throw new OrchestrationError('invalid',SPAWN_USAGE);
    const runId=v.run!,opts={...options,...(raw?{maxOutputTokens:Number(raw)}:{})};
    const preview=v.resume?{proposal:new SpawnProposalStore((await inspectExecution(cwd,runId,opts)).store).read(v.resume)}:await inspectSpawn(cwd,runId,p[1]!,{...opts,dryRun:!!v['dry-run']});
    const sourceArgument="'"+(p[1]??'children.json').replaceAll("'","'\\''")+"'";
    emit('orchestration.spawn.review',preview,`Review child proposal ${preview.proposal.hash}:\n${JSON.stringify(preview,null,2)}\nApprove: calliope agents spawn ${sourceArgument} --run ${runId} --approve ${preview.proposal.hash}`);
    if(v['dry-run'])return 0;
    if(!v.approve&&!v.resume&&!(options.source==='repl'&&options.approve&&!json))return 5;
    const accepted=await admitSpawn(cwd,runId,v.resume??preview.proposal,v.approve??preview.proposal.hash,opts);
    emit('orchestration.spawn.admitted',accepted,`Admitted ${accepted.admission.proposal.agents.length} children. Waiting for verified task outcomes.`);
    const result=await executeSpawn(cwd,accepted.admission,{...opts,...(v['allow-mutations']?{approve:async()=> 'allow' as const}:{}),onEvent:event=>{options.onEvent?.(event);emit('orchestration.spawn.event',{runId,event},`${event.sequence}. ${event.change.type}`);}});
    emit('orchestration.spawn.result',result,`Child execution ${result.status} · run ${runId} · proposal ${result.proposalHash}`);return result.exitCode;
  }catch(error){
    const cancelled=options.signal?.aborted||isCancellation(error),denied=error instanceof SessionPolicyError||error instanceof ExecutionLimitError||error instanceof OrchestrationError&&error.code==='policy-denied',invalid=error instanceof OrchestrationError&&error.code==='invalid'||error instanceof Error&&'code'in error&&String(error.code).startsWith('ERR_PARSE_ARGS');
    const message=cancelled?'Child operation cancelled; inspect its run and retained budget before resuming.':invalid?SPAWN_USAGE:error instanceof OrchestrationError||error instanceof ExecutionLimitError||error instanceof SessionPolicyError?error.message:'Child operation failed; preserve its proposal and run records for recovery.';
    emit('orchestration.spawn.error',{code:cancelled?'cancelled':denied?'policy-denied':invalid?'invalid':'failed',message},message);return cancelled?130:denied?3:invalid?2:1;
  }
}
