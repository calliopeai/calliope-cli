/** A child's view of a parent ledger served over delegation-ledger/v1 (#415).
 * It keeps a verified local replay so ExecutionGuard reads stay synchronous; the server decides
 * every reserve/settle. A server history that is not an append-only extension of what this child
 * already saw is refused, so a reset or rollback can never return spent capacity. */
import {canonicalJson} from '../approvals/index.js';
import {cancellableDelay,throwIfCancelled} from '../cancellation.js';
import {checkExecutionIdentity,validateExecutionManifest} from './authority.js';
import {replayReservations} from './ledger.js';
import {ExecutionLimitError,type ChildGrant,type ExecutionManifest,type RequestReservation,type RequestSettlement,type ReservationEvent,type ReservationProjection} from './types.js';
import {LEDGER_PROTOCOL} from './ledger-protocol.js';

export interface RemoteLedgerOptions {
  url:string; token:string;
  /** Local, private directory outside the project (ExecutionGuard checks it is not inside). */
  root:string;
  fetch?:typeof fetch; attempts?:number; timeoutMs?:number;
}
interface Journal {manifest:ExecutionManifest;events:ReservationEvent[]}
const CODES=new Set(['invalid','authority','budget','deadline','unavailable','locked','conflict','limit']);

export class RemoteReservationLedger {
  readonly root:string;
  private journal!:Journal;
  private readonly confirmedRejections=new WeakSet<Error>();
  private constructor(private readonly options:RemoteLedgerOptions){this.root=options.root;}

  static async connect(options:RemoteLedgerOptions):Promise<RemoteReservationLedger> {
    const ledger=new RemoteReservationLedger(options),hello=await ledger.call('hello',{}) as {protocol?:string};
    if(hello.protocol!==LEDGER_PROTOCOL)throw new ExecutionLimitError('unavailable',`Parent ledger speaks ${String(hello.protocol)}, not ${LEDGER_PROTOCOL}.`);
    ledger.accept(await ledger.call('journal',{}));return ledger;
  }
  read(cwd:string):{manifest:ExecutionManifest;events:ReservationEvent[];projection:ReservationProjection} {
    checkExecutionIdentity(this.journal.manifest,cwd);
    return {...this.journal,projection:replayReservations(this.journal.manifest,this.journal.events)};
  }
  async refresh():Promise<void> {this.accept(await this.call('journal',{}));}
  canReleaseFailedReservation(error:unknown):boolean {
    return error instanceof Error&&this.confirmedRejections.has(error);
  }
  async reserve(_cwd:string,manifestHash:string,reservation:RequestReservation,signal?:AbortSignal):Promise<ReservationProjection> {
    return this.write('reserve',{manifestHash,reservation},reservation.id,signal,'Reservation outcome is unknown; no request was authorized.');
  }
  async settle(_cwd:string,manifestHash:string,settlement:RequestSettlement):Promise<ReservationProjection> {
    return this.write('settle',{manifestHash,settlement},settlement.requestId,undefined,'Settlement outcome is unknown; the reservation stays charged.');
  }
  /** Nested allocation from this child's own accounts; returns the grandchild's scoped token. */
  async grantChildren(_cwd:string,manifestHash:string,grant:ChildGrant,signal?:AbortSignal):Promise<{projection:ReservationProjection;token:string}> {
    const result=await this.call('grant',{manifestHash,grant},signal) as Journal&{token:string};this.accept(result);
    return {projection:replayReservations(this.journal.manifest,this.journal.events),token:result.token};
  }

  /** Retries reuse the same id (the server replays it). If every attempt is lost, inspect before
   * deciding: only an outcome the parent recorded counts; otherwise the result is unknown. */
  private async write(op:'reserve'|'settle',body:object,id:string,signal:AbortSignal|undefined,unknown:string):Promise<ReservationProjection> {
    let lost:unknown;
    for(let attempt=0;attempt<(this.options.attempts??3);attempt++){
      throwIfCancelled(signal);
      try{this.accept(await this.call(op,body,signal,lost===undefined));return this.projection();}
      catch(error){if(error instanceof ExecutionLimitError&&error.code!=='unavailable')throw error;lost=error;await cancellableDelay(100*2**attempt,signal);}
    }
    try{
      await this.refresh();const entry=this.projection().requests[id];
      if(op==='reserve'&&entry||op==='settle'&&entry&&entry.state!=='pending')return this.projection();
    }catch{/* Still unreachable: fall through to an explicit unknown outcome. */}
    throw new ExecutionLimitError('unavailable',`${unknown} (${lost instanceof Error?lost.message:'parent ledger unreachable'})`);
  }
  private projection():ReservationProjection {return replayReservations(this.journal.manifest,this.journal.events);}
  /** Validate the hash chain and refuse anything but an append-only extension of what we saw. */
  private accept(value:unknown):void {
    const next=value as Journal;if(!next||!Array.isArray(next.events))throw new ExecutionLimitError('unavailable','Parent ledger returned no history.');
    const manifest=validateExecutionManifest(next.manifest);replayReservations(manifest,next.events);
    if(this.journal){
      if(canonicalJson(this.journal.manifest)!==canonicalJson(manifest)||next.events.length<this.journal.events.length||this.journal.events.some((e,i)=>e.hash!==next.events[i]!.hash))
        throw new ExecutionLimitError('conflict','Parent ledger history was rewritten or rolled back; execution stopped.');
    }
    this.journal={manifest,events:next.events};
  }
  private async call(op:string,body:object,signal?:AbortSignal,firstAttempt=false):Promise<unknown> {
    const timeout=AbortSignal.timeout(this.options.timeoutMs??10000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    let response:Response;
    try{response=await (this.options.fetch??fetch)(`${this.options.url.replace(/\/$/,'')}/v1/${op}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.options.token}`},body:JSON.stringify(body),signal:combined});}
    catch(error){throwIfCancelled(signal);throw new ExecutionLimitError('unavailable',`Parent ledger unreachable: ${(error as Error).message}`);}
    let value:{ok?:boolean;code?:string;message?:string;admission?:string};try{value=await response.json() as typeof value;}catch{throw new ExecutionLimitError('unavailable','Parent ledger returned an unreadable response.');}
    if(!value.ok){
      const error=new ExecutionLimitError(CODES.has(String(value.code))?value.code as ExecutionLimitError['code']:'unavailable',String(value.message??'Parent ledger refused the request.'));
      // Only a server rejection before any lost response proves refusal. Client
      // validation failures and retries can follow an already committed request.
      if(op==='reserve'&&firstAttempt&&value.admission==='refused'&&error.code!=='unavailable')this.confirmedRejections.add(error);
      throw error;
    }
    return value;
  }
}
