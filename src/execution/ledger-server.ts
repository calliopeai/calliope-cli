import {validateRemoteTaskAdmission,type RemoteTaskAdmission} from '../orchestration/remote-task-capacity.js';
/** Serve one run's ReservationLedger over delegation-ledger/v1 (#415). The ledger stays the only
 * authority: this adds authentication, per-account ownership, idempotent replay and grant fencing. */
import * as http from 'node:http';
import {canonicalJson} from '../approvals/index.js';
import {ReservationLedger} from './ledger.js';
import {ExecutionLimitError,type ChildGrant,type RequestReservation,type RequestSettlement,type ReviewedLedgerContext} from './types.js';
import {accountLineage,identifier,integer,hex,validateExecutionProject,validateReviewedLedgerContext} from './authority.js';
import {validateRequestAttribution,type TaskRequestAttribution} from './attribution.js';
import {effectiveExecutionManifest,executionProjectForAccount} from './child-grants.js';
import {LEDGER_PROTOCOL,LEDGER_OPERATIONS,MAX_LEDGER_REQUEST_BYTES,LedgerServerState,mintLedgerToken,verifyLedgerToken,type LedgerTokenClaims} from './ledger-protocol.js';

export interface LedgerServerOptions {
  ledger:ReservationLedger;
  /** The parent's project root: the server checks project identity on every write. */
  cwd:string;
  state:LedgerServerState;
  now?:()=>number;
  /** Restrict this endpoint to one owner subtree, even for otherwise valid tokens. */
  ownerAgentId?:string;
  /** Exact reviewed-host audience; authenticated tokens cannot downgrade to raw serving. */
  authority?:string;
  /** A separately negotiated endpoint for one immutable native worker attempt. */
  admitRemoteTask?:(admission:RemoteTaskAdmission)=>Promise<void>;
  releaseRemoteTask?:(admission:RemoteTaskAdmission)=>Promise<void>;
  reviewedContext?:ReviewedLedgerContext;
  taskExecution?:{attribution:TaskRequestAttribution;maxOutputTokens:number};
  /** Trusted reviewed host: target-account lifecycle and existing native grant checks. */
  assertAccountAuthority?:(agentId:string)=>void;
  assertReservationAuthority?:(reservation:RequestReservation)=>void;
  assertGrantAuthority?:(grant:ChildGrant)=>void;
  /** Trusted owner lifecycle check, e.g. prepareAgentExecution().assertAuthority.
   * Fences new reservations/grants under the writer lock; reads, replay and
   * settlement remain available to reconcile already admitted requests. */
  assertAuthority?:()=>void;
}
const STATUS:Record<ExecutionLimitError['code'],number>={invalid:400,authority:403,budget:409,deadline:409,conflict:409,limit:409,locked:503,unavailable:503};
interface AdmissionOutcome {admission:'refused'|'unknown'}

export function createLedgerServer(options:LedgerServerOptions):http.Server {
  const {ledger,cwd,state}=options,now=options.now??Date.now,secret=state.secret();
  const reviewed=options.reviewedContext?validateReviewedLedgerContext(options.reviewedContext):undefined;
  if(reviewed&&(reviewed.authority!==options.authority||reviewed.runId!==ledger.read(cwd).manifest.runId))throw new ExecutionLimitError('invalid','Invalid reviewed ledger context.');
  const task=options.taskExecution?structuredClone(options.taskExecution):undefined;
  if(task){
    if(!options.authority||!options.ownerAgentId||validateRequestAttribution(task.attribution).kind!=='task')throw new ExecutionLimitError('invalid','Task execution requires reviewed owner authority.');
    integer(task.maxOutputTokens,1,100000000);
  }
  const operations:readonly string[]=task?['hello','journal','task-execution','reserve','settle']:LEDGER_OPERATIONS.filter(op=>!['task-admit','task-release'].includes(op)||!!options.admitRemoteTask&&!!options.releaseRemoteTask);
  if(options.authority!==undefined&&!hex(options.authority))throw new ExecutionLimitError('invalid','Invalid ledger authority binding.');
  const current=()=>ledger.read(cwd);
  if(options.ownerAgentId!==undefined){identifier(options.ownerAgentId);const saved=current();accountLineage(effectiveExecutionManifest(saved.manifest,saved.projection),options.ownerAgentId);}
  const journal=()=>{const {manifest,events}=current();return {manifest,events};};
  const assertActive=(token:LedgerTokenClaims)=>{
    if(token.exp<=now())throw new ExecutionLimitError('authority','Ledger token expired; no further requests are authorized.');
    if(token.role==='child'&&(token.epoch!==state.epoch(token.grant!)||revokedLineage(token.accounts!)))throw new ExecutionLimitError('authority','This child grant or one of its ancestors was revoked; no further requests are authorized.');
  };
  const claims=(req:http.IncomingMessage):LedgerTokenClaims=>{
    const header=req.headers.authorization??'';const run=current().manifest.runId;
    const token=verifyLedgerToken(secret,header.startsWith('Bearer ')?header.slice(7):undefined,run,now());
    if(token.authority!==options.authority)throw new ExecutionLimitError('authority','Ledger token belongs to another authority binding.');
    assertActive(token);
    if(options.ownerAgentId!==undefined){
      const roots=token.role==='child'?token.accounts!:token.v===2?[token.owner!]:[];
      if(!roots.length||roots.some(id=>!within(id,options.ownerAgentId!)))throw new ExecutionLimitError('authority','Ledger token belongs to another owner scope.');
    }
    return token;
  };
  /** Revoking a grant fences every descendant account, whichever token it was minted under. */
  const revokedLineage=(accounts:string[]):boolean=>{
    const saved=current(),effective=effectiveExecutionManifest(saved.manifest,saved.projection),records=saved.projection.childGrants??[];
    return accounts.some(id=>accountLineage(effective,id).some(a=>records.some(r=>state.isRevoked(r.grant.id)&&r.grant.accounts.some(g=>g.id===a.id))));
  };
  const within=(agentId:string,owner:string):boolean=>{
    const saved=current();return accountLineage(effectiveExecutionManifest(saved.manifest,saved.projection),agentId).some(a=>a.id===owner);
  };
  /** Token scope survives reuse at another endpoint serving the same run. */
  const owns=(token:LedgerTokenClaims,agentId:string)=>{
    identifier(agentId);
    if(options.ownerAgentId!==undefined&&!within(agentId,options.ownerAgentId))throw new ExecutionLimitError('authority','This endpoint cannot act for that account.');
    if(token.role==='parent'){
      if(token.v===2&&!within(agentId,token.owner!))throw new ExecutionLimitError('authority','This parent token cannot act for that account.');
    }else if(!token.accounts!.some(owner=>within(agentId,owner)))throw new ExecutionLimitError('authority','This token cannot act for that account.');
  };
  const assertTaskRequest=(reservation:RequestReservation)=>{
    if(task&&(reservation.agentId!==options.ownerAgentId||canonicalJson(reservation.attribution??null)!==canonicalJson(task.attribution)))throw new ExecutionLimitError('authority','Request does not match the bound native task attempt.');
  };
  const handlers:Record<string,(token:LedgerTokenClaims,body:Record<string,unknown>,outcome:AdmissionOutcome)=>Promise<unknown>>={
    'task-admit':async(token,body)=>{
      if(!options.admitRemoteTask)throw new ExecutionLimitError('unavailable','Remote task admission is unavailable.');
      const admission=validateRemoteTaskAdmission(body.admission);owns(token,admission.agentId);assertActive(token);options.assertAuthority?.();options.assertAccountAuthority?.(admission.agentId);
      const saved=current(),project=validateExecutionProject(body.project);if(canonicalJson(project)!==canonicalJson(executionProjectForAccount(saved.manifest,saved.projection,admission.agentId)))throw new ExecutionLimitError('authority','Remote task workspace changed.');
      await options.admitRemoteTask(admission);return {admissionId:admission.id};
    },
    'task-release':async(token,body)=>{
      if(!options.releaseRemoteTask)throw new ExecutionLimitError('unavailable','Remote task release is unavailable.');
      const admission=validateRemoteTaskAdmission(body.admission);owns(token,admission.agentId);
      await options.releaseRemoteTask(admission);return {admissionId:admission.id};
    },
    hello:async()=>{const {manifest}=current();return {protocol:LEDGER_PROTOCOL,operations,runId:manifest.runId,...(reviewed?{reviewed:structuredClone(reviewed)}:{})};},
    journal:async()=>journal(),
    execution:async(token,body)=>{
      identifier(body.agentId);owns(token,body.agentId);
      const project=validateExecutionProject(body.project),saved=current();
      if(canonicalJson(project)!==canonicalJson(executionProjectForAccount(saved.manifest,saved.projection,body.agentId)))throw new ExecutionLimitError('authority','Workspace does not match the owner-declared child project.');
      options.assertAuthority?.();options.assertAccountAuthority?.(body.agentId);
      return {...journal(),binding:{version:1,agentId:body.agentId,project}};
    },
    'task-execution':async(token,body)=>{
      identifier(body.agentId);owns(token,body.agentId);
      if(!task||body.agentId!==options.ownerAgentId)throw new ExecutionLimitError('authority','Task execution belongs to another account.');
      const project=validateExecutionProject(body.project),saved=current();
      if(canonicalJson(project)!==canonicalJson(executionProjectForAccount(saved.manifest,saved.projection,body.agentId)))throw new ExecutionLimitError('authority','Workspace does not match the owner-declared child project.');
      options.assertAuthority?.();options.assertAccountAuthority?.(body.agentId);
      return {...journal(),binding:{version:2,agentId:body.agentId,project,attribution:structuredClone(task.attribution),maxOutputTokens:task.maxOutputTokens}};
    },
    reserve:async(token,body,outcome)=>{
      const reservation=body.reservation as RequestReservation,hash=String(body.manifestHash);owns(token,reservation?.agentId);
      assertTaskRequest(reservation);
      const prior=current().projection.requests[reservation?.id];
      // Replay with the same id answers the original admission; a different body is a conflict.
      if(prior){if(canonicalJson(prior.reservation)!==canonicalJson(reservation))throw new ExecutionLimitError('conflict','Reservation id already admitted a different request.');return {...journal(),replayed:true};}
      const assertAdmission=()=>{
        assertActive(token);owns(token,reservation.agentId);options.assertAuthority?.();options.assertAccountAuthority?.(reservation.agentId);
        assertTaskRequest(reservation);
        if(task&&reservation.outputTokens>task.maxOutputTokens)throw new ExecutionLimitError('budget','Request exceeds the bound task output limit.');
        options.assertReservationAuthority?.(reservation);
      };
      try{assertAdmission();await ledger.reserve(cwd,hash,reservation,undefined,assertAdmission);}
      catch(error){
        // The local operation has finished. Prove non-admission from the same
        // authority before calling this a refusal; failed reads stay unknown.
        try{const saved=current();if(saved.projection.manifestHash===hash&&!saved.projection.requests[reservation.id])outcome.admission='refused';}catch{/* Preserve uncertainty. */}
        throw error;
      }
      return journal();
    },
    settle:async(token,body)=>{
      const settlement=body.settlement as RequestSettlement,hash=String(body.manifestHash);
      const saved=current(),entry=saved.projection.requests[settlement?.requestId];
      if(!entry)throw new ExecutionLimitError('conflict','Request was never reserved.');owns(token,entry.reservation.agentId);
      assertTaskRequest(entry.reservation);
      if(entry.state!=='pending'){
        const settled=saved.events.find(e=>e.change.type==='settle'&&e.change.settlement.requestId===settlement.requestId);
        if(settled&&settled.change.type==='settle'&&canonicalJson(settled.change.settlement)===canonicalJson(settlement)){
          if(saved.manifest.parent)await ledger.settle(cwd,hash,settlement);
          return {...journal(),replayed:true};
        }
        throw new ExecutionLimitError('conflict','Request was already settled differently.');
      }
      await ledger.settle(cwd,hash,settlement);return journal();
    },
    grant:async(token,body)=>{
      const grant=body.grant as ChildGrant,hash=String(body.manifestHash);owns(token,grant?.parentId);
      if(grant?.version===2&&token.role!=='parent')throw new ExecutionLimitError('authority','Only the ledger owner can bind a child to another workspace.');
      const assertGrant=()=>{
        assertActive(token);
        owns(token,grant?.parentId);options.assertAuthority?.();options.assertAccountAuthority?.(grant?.parentId);options.assertGrantAuthority?.(grant);
        if(grant?.id&&state.isRevoked(grant.id))throw new ExecutionLimitError('authority','This child grant was revoked and cannot be reissued.');
      };
      assertGrant();await ledger.grantChildren(cwd,hash,grant,undefined,assertGrant);assertGrant();
      const deadline=Math.min(token.exp,...grant.accounts.map(a=>a.deadline));
      const child=mintLedgerToken(secret,{v:token.authority?2:1,...(token.authority?{authority:token.authority}:{}),run:current().manifest.runId,role:'child',grant:grant.id,epoch:state.epoch(grant.id),accounts:grant.accounts.map(a=>a.id),exp:deadline});
      return {...journal(),token:child};
    },
    revoke:async(token,body)=>{
      if(token.role!=='parent')throw new ExecutionLimitError('authority','Only the parent can revoke a child grant.');
      const grant=String(body.grant),record=current().projection.childGrants?.find(r=>r.grant.id===grant);if(!record)throw new ExecutionLimitError('conflict','No such child grant.');
      owns(token,record.grant.parentId);return {grant,epoch:state.revoke(grant)};
    },
  };
  return http.createServer((req,res)=>{
    const reply=(status:number,value:unknown)=>{const raw=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(raw);};
    const op=(req.url??'').replace(/^\/v1\//,'');
    if(req.method!=='POST'||!operations.includes(op)||!Object.hasOwn(handlers,op)){reply(404,{ok:false,code:'invalid',message:'Unknown ledger operation.'});return;}
    const chunks:Buffer[]=[];let size=0;
    req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_LEDGER_REQUEST_BYTES){reply(413,{ok:false,code:'limit',message:'Ledger request is too large.'});req.destroy();}else chunks.push(chunk);});
    req.on('end',()=>{void (async()=>{
      const outcome:AdmissionOutcome={admission:'unknown'};
      try{
        const token=claims(req);let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new ExecutionLimitError('invalid','Ledger request is not JSON.');}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new ExecutionLimitError('invalid','Ledger request must be an object.');
        reply(200,{ok:true,...(await handlers[op]!(token,body as Record<string,unknown>,outcome)) as object});
      }catch(error){
        // Only typed ledger outcomes cross the wire; anything else is an opaque unavailability.
        if(error instanceof ExecutionLimitError)reply(STATUS[error.code],{ok:false,code:error.code,message:error.message,...(op==='reserve'?outcome:{})});
        else reply(503,{ok:false,code:'unavailable',message:'Ledger is unavailable; no request was authorized.'});
      }
    })();});
  });
}
