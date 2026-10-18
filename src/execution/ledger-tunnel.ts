/** A private reverse HTTP connection to the original reviewed ledger (cykick#19).
 * The host supplies authenticated, non-replayed exec streams. This module does
 * not authenticate an Astrolift user, enroll a task, mint a token or grant budget.
 * HTTP framing/backpressure runs over those streams; no public listener is needed
 * on the owner. Only the task listens, on its predeclared loopback port.
 */
import * as http from 'node:http';
import type {Socket} from 'node:net';
import {Duplex,Transform,Readable,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../approvals/index.js';
import {hex,uuid} from './authority.js';
import {MAX_RESERVATION_BYTES} from './ledger.js';
import {LEDGER_OPERATIONS,MAX_LEDGER_REQUEST_BYTES} from './ledger-protocol.js';
import {ExecutionLimitError} from './types.js';

export const LEDGER_TUNNEL_CAPABILITY=Object.freeze({version:1,transport:'http-exec-v1',tokenVersion:2,role:'child',replay:false});
const PING='/bridge/v1/ping',HEADER='x-calliope-ledger-binding';
// Journals are bounded at source. Allow space for the manifest and JSON envelope.
const MAX_RESPONSE_BYTES=2*MAX_RESERVATION_BYTES;
const operations=new Set(LEDGER_OPERATIONS.filter(op=>op!=='revoke').map(op=>`/v1/${op}`));
const unavailable=()=>new ExecutionLimitError('unavailable','The private ledger connection is unavailable; retain the original enrollment.');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Supplied by the trusted dispatch owner from the original admitted credential.
 * Decoding claims adds restrictions; only the native ledger verifies authority.
 */
export interface LedgerTunnelBinding {
  version:1;credentialSha256:string;runId:string;grantId:string;authority:string;deadline:number;
}
interface TunnelOptions {
  input:Readable;output:Writable;binding:LedgerTunnelBinding;signal?:AbortSignal;
  /** Bounds a request and loss-of-owner detection, including stalled stream writes. */
  timeoutMs?:number;
}
export interface LedgerTunnelHandle {close:()=>Promise<void>;closed:Promise<void>}

function settings(options:TunnelOptions){
  const binding=structuredClone(options.binding),timeout=options.timeoutMs??15000;
  if(!binding||Object.keys(binding).sort().join(',')!=='authority,credentialSha256,deadline,grantId,runId,version'||
      binding.version!==1||!hex(binding.credentialSha256)||!hex(binding.authority)||!uuid(binding.runId)||!uuid(binding.grantId)||
      !Number.isSafeInteger(binding.deadline)||binding.deadline<=Date.now()||
      !Number.isInteger(timeout)||timeout<100||timeout>30000||options.signal?.aborted)throw unavailable();
  return {binding,timeout,fingerprint:digest(canonicalJson(binding))};
}
function credential(header:unknown,binding:LedgerTunnelBinding):string {
  if(typeof header!=='string'||!header.startsWith('Bearer ')||header.length>8199)throw unavailable();
  const token=header.slice(7);
  if(digest(token)!==binding.credentialSha256)throw unavailable();
  try{
    const [body,mac,extra]=token.split('.');if(!body||!mac||extra!==undefined)throw unavailable();
    const claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(claims.v!==2||claims.role!=='child'||claims.owner!==undefined||claims.run!==binding.runId||
        claims.grant!==binding.grantId||claims.authority!==binding.authority||claims.exp!==binding.deadline||
        Date.now()>=binding.deadline)throw unavailable();
  }catch{throw unavailable();}
  return token;
}
function refuse(response:http.ServerResponse,status=503){
  // No admission:'refused': a broken transport cannot prove non-admission.
  if(response.headersSent){response.destroy();return;}
  response.writeHead(status,{'content-type':'application/json','connection':'close'});
  response.end(JSON.stringify({ok:false,code:'unavailable',message:'Private ledger connection unavailable.'}));
}
async function body(request:http.IncomingMessage):Promise<Buffer>{
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>MAX_LEDGER_REQUEST_BYTES)throw unavailable();chunks.push(chunk);}
  return Buffer.concat(chunks,size);
}
/** One exec stream is one connection. Never fall back to a network socket or
 * reuse a closed stream. Override TCP-only keepalive/ref calls for generic pipes.
 */
class StreamAgent extends http.Agent {
  private used=false;
  constructor(private readonly stream:Duplex){
    super({keepAlive:true,maxSockets:1,maxTotalSockets:1});
    // Pipes have no socket handle to ref. Keep the native agent's reuse cleanup.
    Object.assign(stream,{ref:()=>stream});
  }
  override createConnection(_options:unknown,callback?:(error:Error|null,stream:Duplex)=>void):Socket|undefined {
    if(this.used||this.stream.destroyed){callback?.(unavailable(),this.stream);return undefined;}
    this.used=true;return this.stream as Socket;
  }
  override keepSocketAlive():boolean{return true;}
}
function lifetime(options:TunnelOptions,server:http.Server,timeout:number){
  const stream=Duplex.fromWeb({readable:Readable.toWeb(options.input),writable:Writable.toWeb(options.output)});
  const deadline=options.binding.deadline;
  const controller=new AbortController();let finish!:()=>void,closing:Promise<void>|undefined;
  const closed=new Promise<void>(resolve=>{finish=resolve;});
  const close=():Promise<void>=>{
    if(closing)return closing;
    closing=closed;clearInterval(watch);options.signal?.removeEventListener('abort',stop);
    controller.abort();server.closeAllConnections();stream.destroy();
    if(server.listening)server.close(()=>finish());else finish();
    return closed;
  };
  const stop=()=>{void close();};let seen=Date.now();
  const watch=setInterval(()=>{if(Date.now()-seen>=timeout||Date.now()>=deadline)stop();},Math.max(25,Math.floor(timeout/4)));
  stream.on('error',stop);stream.once('close',stop);stream.once('end',stop);
  server.on('error',stop);server.on('clientError',(_error,socket)=>{socket.destroy();});
  server.on('connect',(_request,socket)=>{socket.destroy();});server.on('upgrade',(_request,socket)=>{socket.destroy();});
  options.signal?.addEventListener('abort',stop,{once:true});
  return {stream,controller,close,closed,touch:()=>{seen=Date.now();}};
}
async function exchange(url:URL,path:string,headers:Record<string,string>,bytes:Buffer,signal:AbortSignal,agent?:http.Agent):Promise<http.IncomingMessage>{
  return new Promise((resolve,reject)=>{
    const request=http.request(url,{method:'POST',path,headers:{...headers,'content-length':String(bytes.length)},agent,signal},resolve);
    request.once('error',()=>reject(unavailable()));request.end(bytes);
  });
}
async function forward(response:http.IncomingMessage,output:http.ServerResponse,signal:AbortSignal){
  if(!response.statusCode||response.statusCode<200||response.statusCode>=600||response.statusCode>=300&&response.statusCode<400){response.destroy();throw unavailable();}
  let bytes=0;
  const bound=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>MAX_RESPONSE_BYTES?unavailable():null,chunk);}});
  output.writeHead(response.statusCode,{'content-type':'application/json'});
  await pipeline(response,bound,output,{signal});
}

/** Owner side: accepts HTTP only on the injected private stream. ledgerUrl must
 * come from the owned prepareReviewedLedger listener, never from a task/model.
 * The host rechecks its authenticated task/placement lease through assertConnection.
 */
export function attachLedgerTunnel(options:TunnelOptions&{ledgerUrl:string;assertConnection:()=>void}):LedgerTunnelHandle {
  const {binding,timeout,fingerprint}=settings(options);let url:URL;
  try{url=new URL(options.ledgerUrl);}catch{throw unavailable();}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw unavailable();
  options.assertConnection();
  const server=http.createServer({maxHeaderSize:16384,requestTimeout:timeout,headersTimeout:timeout});
  // Pings own the idle deadline; Node's HTTP keepalive timeout must not close the exec stream.
  server.keepAliveTimeout=0;
  const life=lifetime(options,server,timeout);let busy=false;
  server.on('request',async(request,response)=>{
    if(busy){refuse(response);void life.close();return;}
    busy=true;
    try{
      options.assertConnection();
      if(request.method!=='POST'||request.headers[HEADER]!==fingerprint)throw unavailable();
      const signal=AbortSignal.any([life.controller.signal,AbortSignal.timeout(timeout)]);
      const abort=()=>{request.destroy();};signal.addEventListener('abort',abort,{once:true});
      let bytes:Buffer;
      try{bytes=await body(request);}finally{signal.removeEventListener('abort',abort);}
      if(request.url===PING){
        if(bytes.length||request.headers.authorization)throw unavailable();
        response.writeHead(204,{[HEADER]:fingerprint});response.end();
      }else{
        if(!operations.has(request.url!))throw unavailable();
        const token=credential(request.headers.authorization,binding);
        options.assertConnection();
        const incoming=await exchange(url,request.url!,{authorization:`Bearer ${token}`,'content-type':'application/json'},bytes,signal);
        options.assertConnection();await forward(incoming,response,signal);
      }
      life.touch();
    }catch{refuse(response);void life.close();}finally{busy=false;}
  });
  server.emit('connection',life.stream);
  return {close:life.close,closed:life.closed};
}

/** Task side: caller must pin the original port and binding before launch. A
 * conflict never selects another port. Reconnect uses the same token/checkpoint;
 * it is a new authenticated stream, not a new allowance or token enrollment.
 */
export async function listenLedgerTunnel(options:TunnelOptions&{port:number}):Promise<LedgerTunnelHandle&{url:string}> {
  const {binding,timeout,fingerprint}=settings(options);
  if(!Number.isInteger(options.port)||options.port<1||options.port>65535)throw unavailable();
  const server=http.createServer({maxHeaderSize:16384,requestTimeout:timeout,headersTimeout:timeout});server.maxConnections=8;
  const life=lifetime(options,server,timeout),agent=new StreamAgent(life.stream);
  const url=new URL(`http://127.0.0.1:${options.port}`);let busy=false,pinging:Promise<void>|undefined;
  const signal=()=>AbortSignal.any([life.controller.signal,AbortSignal.timeout(timeout)]);
  const ping=async()=>{
    const incoming=await exchange(url,PING,{[HEADER]:fingerprint},Buffer.alloc(0),signal(),agent);
    if(incoming.statusCode!==204||incoming.headers[HEADER]!==fingerprint){incoming.destroy();throw unavailable();}
    incoming.resume();await new Promise<void>((resolve,reject)=>{incoming.once('end',resolve);incoming.once('error',()=>reject(unavailable()));});life.touch();
  };
  const heartbeat=setInterval(()=>{
    if(busy||pinging)return;
    pinging=ping().catch(()=>life.close()).finally(()=>{pinging=undefined;});
  },Math.max(25,Math.floor(timeout/3)));
  void life.closed.then(()=>{clearInterval(heartbeat);agent.destroy();});
  server.on('request',async(request,response)=>{
    if(busy){refuse(response);return;}
    let token:string;
    try{if(request.method!=='POST'||!operations.has(request.url!))throw unavailable();token=credential(request.headers.authorization,binding);}
    catch{refuse(response,403);return;}
    busy=true;
    try{
      const requestSignal=signal(),abort=()=>{request.destroy();};requestSignal.addEventListener('abort',abort,{once:true});
      let bytes:Buffer;try{bytes=await body(request);}finally{requestSignal.removeEventListener('abort',abort);}
      // One task request may wait behind the in-flight heartbeat. A health
      // probe must not make native hello/execution negotiation spuriously fail.
      await pinging;
      const incoming=await exchange(url,request.url!,{[HEADER]:fingerprint,authorization:`Bearer ${token}`,'content-type':'application/json'},bytes,requestSignal,agent);
      await forward(incoming,response,requestSignal);life.touch();
    }catch{refuse(response);void life.close();}finally{busy=false;}
  });
  try{
    busy=true;await ping();busy=false;
    if(life.controller.signal.aborted)throw unavailable();
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    if(life.controller.signal.aborted){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));throw unavailable();}
    return {url:url.origin,close:life.close,closed:life.closed};
  }catch{await life.close();throw unavailable();}
}
