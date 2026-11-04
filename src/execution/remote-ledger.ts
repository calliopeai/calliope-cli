import {validateRemoteTaskAdmission,type RemoteTaskAdmission} from '../orchestration/remote-task-capacity.js';
/** A child's view of a parent ledger served over delegation-ledger/v1 (#415).
 * It keeps a verified local replay so ExecutionGuard reads stay synchronous; the server decides
 * every reserve/settle. A server history that is not an append-only extension of what this child
 * already saw is refused, so a reset or rollback can never return spent capacity. */
import {cancellableDelay,throwIfCancelled} from '../cancellation.js';
import {canonicalJson,projectIdentity} from '../approvals/index.js';
import {checkExecutionIdentity,integer,shape,validateExecutionProject} from './authority.js';
import {validateRequestAttribution,type TaskRequestAttribution} from './attribution.js';
import {executionProjectForAccount} from './child-grants.js';
import {replayReservations} from './ledger.js';
import {ExecutionLimitError,type ChildGrant,type ExecutionManifest,type ReservationEvent,type RequestReservation,type RequestSettlement,type ReservationProjection} from './types.js';
import type {ReviewedLedgerContext} from './types.js';
import {LEDGER_PROTOCOL} from './ledger-protocol.js';
import {RemoteLedgerCheckpoint,verifiedJournal,extendsJournal,type RemoteJournal as Journal} from './remote-checkpoint.js';

export interface RemoteLedgerOptions {
  url:string; token:string;
  /** Persistent private directory outside the project; reuse it after reconnect/restart. */
  root:string;
  /** Explicit host invocation; the server must verify the account and local project binding. */
  execution?:{cwd:string;agentId:string};
  /** Accounting-only connection; it cannot reserve, grant or execute. */
  reconciliation?:{cwd:string;agentId:string};
  reviewed?:ReviewedLedgerContext;
  fetch?:typeof fetch; attempts?:number; timeoutMs?:number; signal?:AbortSignal;
}
const CODES=new Set(['invalid','authority','budget','deadline','unavailable','locked','conflict','limit']);

export class RemoteReservationLedger {
  readonly root:string;
  private operations:string[]=[];
  private journal!:Journal;
  private readonly checkpoint:RemoteLedgerCheckpoint;
  private readonly confirmedRejections=new WeakSet<Error>();
  private binding?:{agentId:string;project:ExecutionManifest['project']};
  private executionOperation:'execution'|'task-execution'='execution';
  private taskBinding?:{attribution:TaskRequestAttribution;maxOutputTokens:number};
  get supportsTaskCapacity():boolean{return this.operations.includes('task-admit')&&this.operations.includes('task-release');}
  get taskExecutionBinding(){return this.taskBinding?structuredClone(this.taskBinding):undefined;}
  private constructor(private readonly options:RemoteLedgerOptions){
    this.checkpoint=new RemoteLedgerCheckpoint(options.root);this.root=this.checkpoint.root;
    const saved=this.checkpoint.read();if(saved)this.journal=saved;
  }

  static async connect(options:RemoteLedgerOptions):Promise<RemoteReservationLedger> {
    const ledger=new RemoteReservationLedger(options),hello=await ledger.call('hello',{}) as {protocol?:string;operations?:string[];reviewed?:ReviewedLedgerContext};
    if(hello.protocol!==LEDGER_PROTOCOL)throw new ExecutionLimitError('unavailable',`Parent ledger speaks ${String(hello.protocol)}, not ${LEDGER_PROTOCOL}.`);
    ledger.operations=Array.isArray(hello.operations)?hello.operations:[];
    if(options.reviewed&&canonicalJson(hello.reviewed??null)!==canonicalJson(options.reviewed))throw new ExecutionLimitError('authority','Parent reviewed authority changed.');
    if(options.execution&&options.reconciliation)throw new ExecutionLimitError('invalid','Choose execution or reconciliation.');
    if(options.execution){
      if(!Array.isArray(hello.operations)||!hello.operations.some(op=>op==='execution'||op==='task-execution'))throw new ExecutionLimitError('unavailable','Parent ledger lacks workspace-bound execution; upgrade the parent CLI before starting this child.');
      ledger.executionOperation=hello.operations.includes('task-execution')?'task-execution':'execution';
      await ledger.refreshAuthority(options.execution.cwd,options.execution.agentId);
    }else {
      await ledger.accept(await ledger.call('journal',{}));
      if(options.reconciliation){
        const {cwd,agentId}=options.reconciliation,{project,projectKey}=projectIdentity(cwd);
        ledger.binding={agentId,project:{root:project,key:projectKey}};ledger.executionProject(cwd,agentId);
      }
    }
    return ledger;
  }
  read(cwd:string):{manifest:ExecutionManifest;events:ReservationEvent[];projection:ReservationProjection} {
    if(this.binding)this.executionProject(cwd,this.binding.agentId);else checkExecutionIdentity(this.journal.manifest,cwd);
    return {...structuredClone(this.journal),projection:replayReservations(this.journal.manifest,this.journal.events)};
  }
  executionProject(cwd:string,agentId:string):ExecutionManifest['project'] {
    const declared=executionProjectForAccount(this.journal.manifest,this.projection(),agentId);
    if(this.binding?agentId!==this.binding.agentId||canonicalJson(declared)!==canonicalJson(this.binding.project):canonicalJson(declared)!==canonicalJson(this.journal.manifest.project))throw new ExecutionLimitError('authority','Account requires its own verified workspace binding.');
    checkExecutionIdentity({...this.journal.manifest,project:declared},cwd);return declared;
  }
  /** A journal read is available for reconciliation even when its owner has stopped. */
  async refreshAuthority(cwd:string,agentId:string,signal?:AbortSignal):Promise<void> {
    if(this.options.reconciliation)throw new ExecutionLimitError('authority','Reconciliation does not authorize execution.');
    const {project,projectKey}=projectIdentity(cwd),expected={agentId,project:{root:project,key:projectKey}};
    if(this.binding&&canonicalJson(this.binding)!==canonicalJson(expected))throw new ExecutionLimitError('authority','Execution binding cannot be replaced.');
    const floor=this.journal,response=await this.call(this.executionOperation,expected,signal) as Journal&{binding:unknown};
    const isTask=this.executionOperation==='task-execution';
    shape(response.binding,isTask?['version','agentId','project','attribution','maxOutputTokens']:['version','agentId','project']);
    if(response.binding.version!==(isTask?2:1)||response.binding.agentId!==expected.agentId||canonicalJson(validateExecutionProject(response.binding.project))!==canonicalJson(expected.project))throw new ExecutionLimitError('authority','Parent returned a different execution binding.');
    let taskBinding:typeof this.taskBinding;
    if(isTask){
      const attribution=validateRequestAttribution(response.binding.attribution);
      if(attribution.kind!=='task')throw new ExecutionLimitError('authority','Parent returned a non-task execution binding.');
      integer(response.binding.maxOutputTokens,1,100000000);
      taskBinding={attribution,maxOutputTokens:response.binding.maxOutputTokens};
      if(this.taskBinding&&canonicalJson(this.taskBinding)!==canonicalJson(taskBinding))throw new ExecutionLimitError('authority','Native task execution binding cannot be replaced.');
    }
    await this.accept(response,floor,signal);this.binding=expected;this.executionProject(cwd,agentId);
    this.taskBinding=taskBinding;
  }
  async admitTask(value:RemoteTaskAdmission,cwd:string,signal?:AbortSignal):Promise<void> {
    if(this.options.reconciliation||!this.operations.includes('task-admit'))throw new ExecutionLimitError('authority','Parent cannot admit remote execution.');
    const admission=validateRemoteTaskAdmission(value),{project,projectKey}=projectIdentity(cwd);
    while(true){
      throwIfCancelled(signal);if(Date.now()>=admission.deadline)throw new ExecutionLimitError('deadline','Remote task admission deadline expired.');
      try{const result=await this.call('task-admit',{admission,project:{root:project,key:projectKey}},signal) as {admissionId:string};if(result.admissionId!==admission.id)throw new ExecutionLimitError('authority','Parent returned another remote admission.');return;}
      catch(error){if(!(error instanceof ExecutionLimitError)||!['limit','locked','unavailable'].includes(error.code))throw error;await cancellableDelay(100,signal);}
    }
  }
  async releaseTask(value:RemoteTaskAdmission,signal?:AbortSignal):Promise<void> {
    if(!this.operations.includes('task-release'))throw new ExecutionLimitError('unavailable','Parent cannot release remote execution.');
    const admission=validateRemoteTaskAdmission(value),result=await this.call('task-release',{admission},signal) as {admissionId:string};
    if(result.admissionId!==admission.id)throw new ExecutionLimitError('authority','Parent acknowledged another remote admission.');
  }
  async refresh():Promise<void> {const floor=this.journal;await this.accept(await this.call('journal',{}),floor);}
  canReleaseFailedReservation(error:unknown):boolean {
    return error instanceof Error&&this.confirmedRejections.has(error);
  }
  async reserve(_cwd:string,manifestHash:string,reservation:RequestReservation,signal?:AbortSignal):Promise<ReservationProjection> {
    if(this.options.reconciliation)throw new ExecutionLimitError('authority','Reconciliation cannot reserve.');
    return this.write('reserve',{manifestHash,reservation},reservation.id,signal,'Reservation outcome is unknown; no request was authorized.');
  }
  async settle(_cwd:string,manifestHash:string,settlement:RequestSettlement):Promise<ReservationProjection> {
    return this.write('settle',{manifestHash,settlement},settlement.requestId,undefined,'Settlement outcome is unknown; the reservation stays charged.');
  }
  /** Nested allocation from this child's own accounts; returns the grandchild's scoped token. */
  async grantChildren(_cwd:string,manifestHash:string,grant:ChildGrant,signal?:AbortSignal):Promise<{projection:ReservationProjection;token:string}> {
    if(this.options.reconciliation)throw new ExecutionLimitError('authority','Reconciliation cannot grant.');
    const floor=this.journal,result=await this.call('grant',{manifestHash,grant},signal) as Journal&{token:string};await this.accept(result,floor,signal);
    return {projection:replayReservations(this.journal.manifest,this.journal.events),token:result.token};
  }

  /** Retries reuse the same id (the server replays it). If every attempt is lost, inspect before
   * deciding: only an outcome the parent recorded counts; otherwise the result is unknown. */
  private async write(op:'reserve'|'settle',body:object,id:string,signal:AbortSignal|undefined,unknown:string):Promise<ReservationProjection> {
    let lost:unknown;
    for(let attempt=0;attempt<(this.options.attempts??3);attempt++){
      throwIfCancelled(signal);
      try{const floor=this.journal;await this.accept(await this.call(op,body,signal,lost===undefined),floor,signal);return this.projection();}
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
  private async accept(value:unknown,floor=this.journal,signal?:AbortSignal):Promise<void> {
    const next=verifiedJournal(value);
    if(floor&&!extendsJournal(floor,next))throw new ExecutionLimitError('conflict','Parent ledger history was rewritten or rolled back; execution stopped.');
    const deadline=Date.now()+Math.min(1000,this.options.timeoutMs??1000);
    while(true){
      throwIfCancelled(signal);throwIfCancelled(this.options.signal);
      try{this.journal=this.checkpoint.save(next,this.journal,this.options.execution?projectIdentity(this.options.execution.cwd).project:undefined);return;}
      catch(error){if(!(error instanceof ExecutionLimitError)||error.code!=='locked'||Date.now()>=deadline)throw error;await cancellableDelay(Math.min(25,Math.max(1,deadline-Date.now())),signal??this.options.signal);}
    }
  }
  private async call(op:string,body:object,signal?:AbortSignal,firstAttempt=false):Promise<unknown> {
    const timeout=AbortSignal.timeout(this.options.timeoutMs??10000),combined=AbortSignal.any([timeout,...(signal?[signal]:[]),...(this.options.signal?[this.options.signal]:[])]);
    let response:Response;
    try{response=await (this.options.fetch??fetch)(`${this.options.url.replace(/\/$/,'')}/v1/${op}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.options.token}`},body:JSON.stringify(body),signal:combined});}
    catch(error){throwIfCancelled(signal);throwIfCancelled(this.options.signal);throw new ExecutionLimitError('unavailable',`Parent ledger unreachable: ${(error as Error).message}`);}
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
