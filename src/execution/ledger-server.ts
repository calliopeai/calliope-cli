/** Serve one run's ReservationLedger over delegation-ledger/v1 (#415). The ledger stays the only
 * authority: this adds authentication, per-account ownership, idempotent replay and grant fencing. */
import * as http from 'node:http';
import {canonicalJson} from '../approvals/index.js';
import {ReservationLedger} from './ledger.js';
import {ExecutionLimitError,type ChildGrant,type RequestReservation,type RequestSettlement} from './types.js';
import {accountLineage} from './authority.js';
import {effectiveExecutionManifest} from './child-grants.js';
import {LEDGER_PROTOCOL,LEDGER_OPERATIONS,MAX_LEDGER_REQUEST_BYTES,LedgerServerState,mintLedgerToken,verifyLedgerToken,type LedgerTokenClaims} from './ledger-protocol.js';

export interface LedgerServerOptions {
  ledger:ReservationLedger;
  /** The parent's project root: the server checks project identity on every write. */
  cwd:string;
  state:LedgerServerState;
  now?:()=>number;
}
const STATUS:Record<ExecutionLimitError['code'],number>={invalid:400,authority:403,budget:409,deadline:409,conflict:409,limit:409,locked:503,unavailable:503};

export function createLedgerServer(options:LedgerServerOptions):http.Server {
  const {ledger,cwd,state}=options,now=options.now??Date.now,secret=state.secret();
  const current=()=>ledger.read(cwd);
  const journal=()=>{const {manifest,events}=current();return {manifest,events};};
  const claims=(req:http.IncomingMessage):LedgerTokenClaims=>{
    const header=req.headers.authorization??'';const run=current().manifest.runId;
    const token=verifyLedgerToken(secret,header.startsWith('Bearer ')?header.slice(7):undefined,run,now());
    if(token.role==='child'&&(token.epoch!==state.epoch(token.grant!)||revokedLineage(token.accounts!)))throw new ExecutionLimitError('authority','This child grant or one of its ancestors was revoked; no further requests are authorized.');
    return token;
  };
  /** Revoking a grant fences every descendant account, whichever token it was minted under. */
  const revokedLineage=(accounts:string[]):boolean=>{
    const saved=current(),effective=effectiveExecutionManifest(saved.manifest,saved.projection),records=saved.projection.childGrants??[];
    return accounts.some(id=>accountLineage(effective,id).some(a=>records.some(r=>state.isRevoked(r.grant.id)&&r.grant.accounts.some(g=>g.id===a.id))));
  };
  /** A child may act only for its own accounts and their descendants (grandchildren it granted). */
  const owns=(token:LedgerTokenClaims,agentId:string)=>{
    if(token.role==='parent')return;
    const saved=current(),effective=effectiveExecutionManifest(saved.manifest,saved.projection);
    if(!accountLineage(effective,agentId).some(a=>token.accounts!.includes(a.id)))throw new ExecutionLimitError('authority','This token cannot act for that account.');
  };
  const handlers:Record<string,(token:LedgerTokenClaims,body:Record<string,unknown>)=>Promise<unknown>>={
    hello:async()=>{const {manifest}=current();return {protocol:LEDGER_PROTOCOL,operations:LEDGER_OPERATIONS,runId:manifest.runId};},
    journal:async()=>journal(),
    reserve:async(token,body)=>{
      const reservation=body.reservation as RequestReservation,hash=String(body.manifestHash);owns(token,reservation?.agentId);
      const prior=current().projection.requests[reservation?.id];
      // Replay with the same id answers the original admission; a different body is a conflict.
      if(prior){if(canonicalJson(prior.reservation)!==canonicalJson(reservation))throw new ExecutionLimitError('conflict','Reservation id already admitted a different request.');return {...journal(),replayed:true};}
      await ledger.reserve(cwd,hash,reservation);return journal();
    },
    settle:async(token,body)=>{
      const settlement=body.settlement as RequestSettlement,hash=String(body.manifestHash);
      const saved=current(),entry=saved.projection.requests[settlement?.requestId];
      if(!entry)throw new ExecutionLimitError('conflict','Request was never reserved.');owns(token,entry.reservation.agentId);
      if(entry.state!=='pending'){
        const settled=saved.events.find(e=>e.change.type==='settle'&&e.change.settlement.requestId===settlement.requestId);
        if(settled&&settled.change.type==='settle'&&canonicalJson(settled.change.settlement)===canonicalJson(settlement))return {...journal(),replayed:true};
        throw new ExecutionLimitError('conflict','Request was already settled differently.');
      }
      await ledger.settle(cwd,hash,settlement);return journal();
    },
    grant:async(token,body)=>{
      const grant=body.grant as ChildGrant,hash=String(body.manifestHash);owns(token,grant?.parentId);
      if(grant?.id&&state.isRevoked(grant.id))throw new ExecutionLimitError('authority','This child grant was revoked and cannot be reissued.');
      await ledger.grantChildren(cwd,hash,grant);
      const deadline=Math.min(...grant.accounts.map(a=>a.deadline));
      const child=mintLedgerToken(secret,{v:1,run:current().manifest.runId,role:'child',grant:grant.id,epoch:state.epoch(grant.id),accounts:grant.accounts.map(a=>a.id),exp:deadline});
      return {...journal(),token:child};
    },
    revoke:async(token,body)=>{
      if(token.role!=='parent')throw new ExecutionLimitError('authority','Only the parent can revoke a child grant.');
      const grant=String(body.grant);if(!current().projection.childGrants?.some(r=>r.grant.id===grant))throw new ExecutionLimitError('conflict','No such child grant.');
      return {grant,epoch:state.revoke(grant)};
    },
  };
  return http.createServer((req,res)=>{
    const reply=(status:number,value:unknown)=>{const raw=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(raw);};
    const op=(req.url??'').replace(/^\/v1\//,'');
    if(req.method!=='POST'||!Object.hasOwn(handlers,op)){reply(404,{ok:false,code:'invalid',message:'Unknown ledger operation.'});return;}
    const chunks:Buffer[]=[];let size=0;
    req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_LEDGER_REQUEST_BYTES){reply(413,{ok:false,code:'limit',message:'Ledger request is too large.'});req.destroy();}else chunks.push(chunk);});
    req.on('end',()=>{void (async()=>{
      try{
        const token=claims(req);let body:unknown;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new ExecutionLimitError('invalid','Ledger request is not JSON.');}
        if(!body||typeof body!=='object'||Array.isArray(body))throw new ExecutionLimitError('invalid','Ledger request must be an object.');
        reply(200,{ok:true,...(await handlers[op]!(token,body as Record<string,unknown>)) as object});
      }catch(error){
        // Only typed ledger outcomes cross the wire; anything else is an opaque unavailability.
        if(error instanceof ExecutionLimitError)reply(STATUS[error.code],{ok:false,code:error.code,message:error.message});
        else reply(503,{ok:false,code:'unavailable',message:'Ledger is unavailable; no request was authorized.'});
      }
    })();});
  });
}
