/** `calliope ledger serve`: serve one run's reservation ledger to its children (#415).
 *
 *   calliope ledger serve --budget DIR --project DIR --token-file FILE [--host 127.0.0.1] [--port 0]
 *
 * Prints {protocol, url, runId} as one JSON line once listening. The parent token is written to
 * --token-file (mode 0600, created new) and never printed. Children receive scoped tokens from
 * the grant operation. Stops on SIGINT/SIGTERM; reservations stay in the ledger directory. */
import * as fs from 'node:fs';
import type {AddressInfo} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {assertExecutionStoreOutsideProject} from './authority.js';
import {privateDirectory} from '../orchestration/execution-store.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import {ReservationLedger} from './ledger.js';
import {createLedgerServer} from './ledger-server.js';
import {LEDGER_PROTOCOL,LedgerServerState,mintLedgerToken} from './ledger-protocol.js';

function option(args:string[],name:string):string|undefined {const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}

export async function runLedgerCommand(args:string[],write:(text:string)=>void=t=>process.stdout.write(t),options:RunActionOptions={}):Promise<number> {
  const reviewed=args[0]==='serve-reviewed',budget=option(args,'--budget'),project=option(args,'--project'),tokenFile=option(args,'--token-file');
  const runId=option(args,'--run'),agentId=option(args,'--agent'),maxOutput=option(args,'--max-output-tokens');
  const flags=new Set(['--run','--agent','--max-output-tokens','--project','--token-file','--host','--port']),seen=new Set<string>();
  let valid=true;
  if(reviewed)for(let n=1;n<args.length;n+=2){const flag=args[n]!;if(!flags.has(flag)||seen.has(flag)||!args[n+1]||args[n+1]!.startsWith('--'))valid=false;seen.add(flag);}
  if(!project||!tokenFile||(reviewed?(!runId||!agentId||!maxOutput||!valid):(args[0]!=='serve'||!budget))){
    process.stderr.write('usage: calliope ledger serve --budget DIR --project DIR --token-file FILE [--host 127.0.0.1] [--port 0]\n       calliope ledger serve-reviewed --run ID --agent ID --max-output-tokens N --project DIR --token-file FILE [--host 127.0.0.1] [--port 0]\n');return 2;
  }
  const cwd=resolve(project!),file=resolve(tokenFile!),host=option(args,'--host')??'127.0.0.1',port=Number(option(args,'--port')??0);
  let server:ReturnType<typeof createLedgerServer>,token:string,id:string,metadata:object={};
  if(reviewed){
    assertExecutionStoreOutsideProject(cwd,file);privateDirectory(dirname(file));
    const {prepareReviewedLedger}=await import('../orchestration/reviewed-ledger.js');
    const prepared=await prepareReviewedLedger(cwd,runId!,agentId!,Number(maxOutput),options);
    server=prepared.server;token=prepared.ownerToken;id=runId!;metadata={ownerAgentId:agentId,deadline:prepared.deadline,reviewed:prepared.capability};
  }else{
    const ledger=new ReservationLedger(resolve(budget!)),{manifest}=ledger.read(cwd),state=new LedgerServerState(join(dirname(ledger.root),`${manifest.runId}.ledger-server`));
    token=mintLedgerToken(state.secret(),{v:1,run:manifest.runId,role:'parent',exp:manifest.deadline});server=createLedgerServer({ledger,cwd,state});id=manifest.runId;
  }
  let stop:(()=>void)|undefined;
  try{
    await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(port,host,()=>{server.off('error',fail);ok();});});
    fs.writeFileSync(file,token,{mode:0o600,flag:'wx'});
    const {port:boundPort}=server.address() as AddressInfo;
    write(JSON.stringify({protocol:LEDGER_PROTOCOL,url:`http://${host.includes(':')?`[${host}]`:host}:${boundPort}`,runId:id,...metadata})+'\n');
    await new Promise<void>(done=>{stop=done;for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,stop);});
    return 0;
  }finally{
    if(stop)for(const signal of ['SIGINT','SIGTERM'] as const)process.off(signal,stop);
    if(server.listening)await new Promise<void>(done=>server.close(()=>done()));
  }
}
