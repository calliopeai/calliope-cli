/** Trusted embedder interface, never loaded from model arguments or project files. */
import type {Tool,ToolCall,ToolResult} from '../types.js';
import {cancellable,throwIfCancelled} from '../cancellation.js';

export interface ArtifactTaskContext {
  version:1;project:{root:string;key:string};runId:string;manifestHash:string;planHash:string;
  approvalRevision:string;taskId:string;agentId:string;sessionId:string;attempt:number;
  startEventId:string;startEventHash:string;
}
export interface ArtifactHost {
  version:1;
  /** A single fixed tool name; the embedding product supplies its artifact schema. */
  tool:Tool;
  execute:(args:Record<string,unknown>,context:ArtifactTaskContext,control:{signal:AbortSignal;assertActive:()=>void})=>Promise<{content:unknown;isError?:boolean}>;
}
export interface BoundArtifactTool {
  execute:(call:ToolCall,signal:AbortSignal|undefined,timeout:number)=>Promise<ToolResult>;
}
export function artifactHostCapabilities() {
  return {version:1,owner:'calliope-cli',tool:'artifact',identity:'native-task-attempt',
    admission:'reviewed-tool-grant-and-host-binding',maxRequestBytes:1048576,maxResponseBytes:2097152} as const;
}
function json(value:unknown,limit:number):string {
  const pending:[unknown,number][]=[[value,0]];let nodes=0;
  while(pending.length){
    const [v,depth]=pending.pop()!;
    if(++nodes>100000||depth>40)throw new Error('Artifact JSON exceeds structural bounds.');
    if(v===null||typeof v==='string'||typeof v==='boolean')continue;
    if(typeof v==='number'&&Number.isFinite(v))continue;
    if(!v||typeof v!=='object'||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype)
      throw new Error('Artifact values must be plain finite JSON.');
    for(const item of Object.values(v))pending.push([item,depth+1]);
  }
  const raw=JSON.stringify(value);
  if(Buffer.byteLength(raw)>limit)throw new Error('Artifact JSON exceeds its byte bound.');
  return raw;
}
export function prepareArtifactHost(host:ArtifactHost):ArtifactHost {
  if(host?.version!==1||typeof host.execute!=='function')throw new Error('Unsupported native artifact host.');
  const tool=JSON.parse(json(host.tool,65536)) as Tool;
  if(tool.name!=='artifact'||typeof tool.description!=='string'||!tool.description.trim()||tool.description.length>4096||
    tool.parameters?.type!=='object'||!tool.parameters.properties||Object.getPrototypeOf(tool.parameters.properties)!==Object.prototype)
    throw new Error('The artifact host must declare the bounded artifact tool.');
  // Snapshot schema and callback once; later descriptor mutation cannot change admission.
  return {version:1,tool,execute:host.execute.bind(host)};
}
export function bindArtifactHost(host:ArtifactHost,context:ArtifactTaskContext,assertActive:()=>void):BoundArtifactTool {
  const snapshot=JSON.parse(json(context,16384)) as ArtifactTaskContext;
  return {execute:async(call,signal,timeout)=>{
    if(call.name!=='artifact')throw new Error('Artifact binding cannot execute another tool.');
    const activeSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(Math.max(1,Math.min(60000,Math.floor(timeout))))]);
    const active=()=>{throwIfCancelled(activeSignal);assertActive();};
    active();
    try {
      const args=JSON.parse(json(call.arguments,1048576)) as Record<string,unknown>;
      if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Artifact arguments must be an object.');
      // Context is separate from model JSON. Each invocation gets a private copy.
      const result=await cancellable(host.execute(args,structuredClone(snapshot),{signal:activeSignal,assertActive:active}),activeSignal);
      active();
      if(!result||typeof result!=='object'||Object.keys(result).some(k=>!['content','isError'].includes(k))||
        !Object.hasOwn(result,'content')||result.isError!==undefined&&typeof result.isError!=='boolean')
        throw new Error('Invalid artifact host result.');
      return {toolCallId:call.id,result:json(result.content,2097152),...(result.isError?{isError:true}:{})};
    }catch(error){
      throwIfCancelled(activeSignal);
      // Provider/session logs must not receive arbitrary host errors or credentials.
      return {toolCallId:call.id,result:'Artifact request was not acknowledged. Inspect its original request receipt before retrying.',isError:true};
    }
  }};
}
