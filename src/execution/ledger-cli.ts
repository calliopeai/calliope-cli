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
import {ReservationLedger} from './ledger.js';
import {createLedgerServer} from './ledger-server.js';
import {LEDGER_PROTOCOL,LedgerServerState,mintLedgerToken} from './ledger-protocol.js';

function option(args:string[],name:string):string|undefined {const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}

export async function runLedgerCommand(args:string[],write:(text:string)=>void=t=>process.stdout.write(t)):Promise<number> {
  const budget=option(args,'--budget'),project=option(args,'--project'),tokenFile=option(args,'--token-file');
  if(args[0]!=='serve'||!budget||!project||!tokenFile){
    process.stderr.write('usage: calliope ledger serve --budget DIR --project DIR --token-file FILE [--host 127.0.0.1] [--port 0]\n');return 2;
  }
  const ledger=new ReservationLedger(resolve(budget)),cwd=resolve(project),{manifest}=ledger.read(cwd);
  const state=new LedgerServerState(join(dirname(ledger.root),`${manifest.runId}.ledger-server`));
  fs.writeFileSync(resolve(tokenFile),mintLedgerToken(state.secret(),{v:1,run:manifest.runId,role:'parent',exp:manifest.deadline}),{mode:0o600,flag:'wx'});
  const server=createLedgerServer({ledger,cwd,state}),host=option(args,'--host')??'127.0.0.1';
  await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(Number(option(args,'--port')??0),host,ok);});
  const {port}=server.address() as AddressInfo;
  write(JSON.stringify({protocol:LEDGER_PROTOCOL,url:`http://${host.includes(':')?`[${host}]`:host}:${port}`,runId:manifest.runId})+'\n');
  await new Promise<void>(done=>{for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>server.close(()=>done()));});
  return 0;
}
