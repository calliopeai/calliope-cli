/** Synthetic provider transport; real SDK, runtime and conversation persistence. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {chat,deepSeekReasoning,toDeepSeekMessages,MAX_DEEPSEEK_REASONING_BYTES} from '../src/providers/index.js';
import {clearModelCache} from '../src/model-detection.js';
import {runTurn} from '../src/runtime/index.js';
import {RunLog} from '../src/runlog.js';
import {readConversation,writeConversation} from '../src/sessions/index.js';
import type {Message,Tool} from '../src/types.js';
import {wireResponse} from './helpers/provider-wire.js';

let root:string,requests:any[],respond:(body:any,signal:AbortSignal)=>Promise<Response>;
const metadata=(reasoningContent:string)=>({deepseek:{version:1,reasoningContent}});
const messages:Message[]=[{role:'user',content:'Read public.txt'}];
const tools:Tool[]=[{name:'read_file',description:'Read a public file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}];
const toolCalls=[{id:'read',type:'function',function:{name:'read_file',arguments:'{"path":"public.txt"}'}}];
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
function reply(reasoning:unknown,tool=false,stream=false){
  const message={role:'assistant',content:tool?'':'Public answer',reasoning_content:reasoning,...(tool?{tool_calls:toolCalls}:{})},finish=tool?'tool_calls':'stop';
  if(!stream)return json({id:'toy',object:'chat.completion',choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:7,completion_tokens:3}});
  const deltas=typeof reasoning==='string'?[{reasoning_content:reasoning.slice(0,2)},{reasoning_content:reasoning.slice(2)}]:[{reasoning_content:reasoning}];
  const events=[...deltas.map(delta=>({choices:[{index:0,delta}]})),{choices:[{index:0,delta:{content:message.content,...(tool?{tool_calls:toolCalls.map(t=>({...t,index:0}))}:{})},finish_reason:finish}]},{choices:[],usage:{prompt_tokens:7,completion_tokens:3}}];
  return wireResponse(Buffer.from(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n'),'text/event-stream',typeof reasoning==='string'&&reasoning.length>8192?8192:3);
}
beforeEach(()=>{
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-deepseek-')));fs.writeFileSync(join(root,'public.txt'),'Public file evidence');config.resetConfig();clearModelCache();requests=[];
  for(const provider of ['deepseek','groq'] as const){vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://reasoning.invalid/v1'});}
  respond=async body=>reply('opaque public protocol state',!body.messages.some((m:any)=>m.role==='tool'),!!body.stream);
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{const req=new Request(input,init);expect(new URL(req.url).origin).toBe('https://reasoning.invalid');if(req.url.endsWith('/models'))return json({data:[{id:'reasoning-toy',context_length:8192,max_output_tokens:1024,capabilities:{chat:true,tools:true,streaming:true}}]});const body=await req.json();requests.push(body);return respond(body,init?.signal??req.signal);}));
});
afterEach(()=>{config.resetConfig();clearModelCache();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(root,{recursive:true,force:true});});

it.each([false,true])('preserves exact reasoning across JSON/fragmented stream text and tool turns (stream=%s)',async stream=>{
  const history:Message[]=structuredClone(messages),tokens:string[]=[];
  for(let turn=0;turn<3;turn++){
    if(turn===2)history.push({role:'user',content:'One more public answer'});
    const response=await chat('deepseek',history,tools,'reasoning-toy',stream?t=>tokens.push(t):undefined);
    expect(response.providerMetadata).toEqual(metadata('opaque public protocol state'));expect(response.usage).toEqual({inputTokens:7,outputTokens:3});
    history.push({role:'assistant',content:response.content,...(response.toolCalls?{toolCalls:response.toolCalls}:{}),providerMetadata:response.providerMetadata});
    if(response.toolCalls)history.push({role:'tool',toolCallId:'read',content:'Public file evidence'});
  }
  for(const body of requests.slice(1))for(const message of body.messages.filter((m:any)=>m.role==='assistant'))expect(message.reasoning_content).toBe('opaque public protocol state');
  expect(requests[2].messages.filter((m:any)=>m.role==='assistant')).toHaveLength(2);expect(tokens.join('')).not.toContain('opaque');expect(requests[1].messages.find((m:any)=>m.role==='tool')).not.toHaveProperty('reasoning_content');
});
it.each([false,true])('retains a present empty field while treating null/missing as absent (stream=%s)',async stream=>{
  for(const value of ['',null,undefined]){respond=async()=>reply(value,false,stream);const response=await chat('deepseek',messages,tools,'reasoning-toy',stream?()=>{}:undefined);expect(response.providerMetadata).toEqual(value===''?metadata(''):undefined);}
  expect(toDeepSeekMessages([{role:'assistant',content:'',providerMetadata:metadata('')}])[0]).toHaveProperty('reasoning_content','');
});
it('does not replay or parse DeepSeek metadata for another compatible provider',async()=>{
  respond=async()=>reply({malformed:'must be ignored for another provider'},false);
  const response=await chat('groq',[...messages,{role:'assistant',content:'Public prior reply',providerMetadata:metadata('private protocol marker')}],tools,'reasoning-toy');
  expect(response.providerMetadata).toBeUndefined();expect(JSON.stringify(requests)).not.toContain('private protocol marker');
});
it.each([false,true])('fails closed on malformed or oversized incoming reasoning without echoing it (stream=%s)',async stream=>{
  for(const value of [{private:'sensitive marker'},7,'x'.repeat(MAX_DEEPSEEK_REASONING_BYTES+1)]){respond=async()=>reply(value,false,stream);await expect(chat('deepseek',messages,[], 'reasoning-toy',stream?()=>{}:undefined)).rejects.toThrow(/reasoning metadata/);}
  expect(requests).toHaveLength(3);expect(deepSeekReasoning('é'.repeat(MAX_DEEPSEEK_REASONING_BYTES/2))).toHaveLength(MAX_DEEPSEEK_REASONING_BYTES/2);expect(()=>deepSeekReasoning('é','x'.repeat(MAX_DEEPSEEK_REASONING_BYTES-1))).toThrow(/limit/);
});
it('rejects malformed stored metadata before transport and leaves non-assistant data alone',async()=>{
  for(const value of [null,[],{}, {version:2,reasoningContent:'private marker'},{version:1,reasoningContent:3},{version:1,reasoningContent:'x',extra:true}])await expect(chat('deepseek',[{role:'assistant',content:'public',providerMetadata:{deepseek:value}}],tools,'reasoning-toy')).rejects.toThrow(/metadata/);
  expect(fetch).not.toHaveBeenCalled();expect(toDeepSeekMessages([{role:'user',content:'public',providerMetadata:metadata('ignored')}])[0]).not.toHaveProperty('reasoning_content');
});
it('persists a real runtime tool cycle and replays its opaque state after reloading the private snapshot',async()=>{
  const dir=join(root,'session');fs.mkdirSync(dir);let revision:string|null=null;const history={current:structuredClone(messages)};
  respond=async body=>{const replayed=body.messages.filter((m:any)=>m.role==='assistant');for(const m of replayed)expect(m.reasoning_content).toBe('opaque public protocol state');return reply('opaque public protocol state',replayed.length===0);};
  const result=await runTurn({cwd:root,provider:'deepseek',model:'reasoning-toy',sessionId:randomUUID(),prompt:'Read public.txt',messages:history,confirmation:'none',maxIterations:3,tools:()=>tools,runlog:RunLog.open(randomUUID(),{enabled:false}),onCheckpoint:(messages,status)=>{revision=writeConversation(dir,'test',messages,{expectedRevision:revision,status}).revision;}});
  expect(result.reason).toBe('completed');expect(requests).toHaveLength(2);expect(requests[1].messages.find((m:any)=>m.role==='tool').content).toContain('Public file evidence');const saved=readConversation(dir,'test');expect(saved.messages).toEqual(history.current);const before=fs.readFileSync(join(dir,'messages.json'));
  await chat('deepseek',[...saved.messages,{role:'user',content:'Continue'}],tools,'reasoning-toy');expect(requests[2].messages.filter((m:any)=>m.role==='assistant')).toHaveLength(2);expect(fs.readFileSync(join(dir,'messages.json'))).toEqual(before);
});
it('cancels a partial reasoning stream without emitting it or returning reusable metadata',async()=>{
  const controller=new AbortController(),tokens:string[]=[];respond=async()=>new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'partial opaque'}}]})+'\n\n'));setTimeout(()=>controller.abort(),5);}}),{headers:{'content-type':'text/event-stream'}});
  await expect(chat('deepseek',messages,tools,'reasoning-toy',t=>tokens.push(t),undefined,{signal:controller.signal})).rejects.toThrow();expect(requests).toHaveLength(1);expect(tokens).toEqual([]);
});
it('discards partial reasoning on a shared transport retry instead of duplicating it in the completed response',async()=>{
  let attempt=0;respond=async()=>++attempt===1?new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'discard this failed attempt'}}]})+'\n\n'));setTimeout(()=>c.error(new Error('network interrupted')),5);}}),{headers:{'content-type':'text/event-stream'}}):reply('keep the successful attempt',true,true);
  const tokens:string[]=[],retries=vi.fn(),response=await chat('deepseek',messages,tools,'reasoning-toy',t=>tokens.push(t),retries);
  expect(retries).toHaveBeenCalledTimes(1);expect(requests).toHaveLength(2);expect(response.providerMetadata).toEqual(metadata('keep the successful attempt'));expect(tokens).toEqual([]);expect(response.toolCalls).toHaveLength(1);
},10000);
