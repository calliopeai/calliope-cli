/** Real installed SDK serializers over synthetic transports, with no paid requests. */
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {BACKENDS,TOOL,invoke,probeMessages} from '../scripts/conformance/contract.mjs';
import {syntheticWire,wireResponse} from './helpers/provider-wire.js';
import * as anthropic from '../src/providers/anthropic.js';
import * as google from '../src/providers/google.js';
import * as openai from '../src/providers/openai.js';
import * as compat from '../src/providers/compat.js';
import * as ollama from '../src/providers/ollama.js';
import * as bedrock from '../src/providers/bedrock.js';
import * as config from '../src/config.js';
import {chat} from '../src/providers/index.js';
import {ExecutionLimitError} from '../src/execution/index.js';
const adapters={anthropic,google,openai,compat,ollama,bedrock};
function withoutUsage(body:Buffer,type:string):Buffer {
  if(type==='application/vnd.amazon.eventstream') {
    const frames:Buffer[]=[];for(let offset=0;offset<body.length;){const length=body.readUInt32BE(offset),frame=body.subarray(offset,offset+length);if(!frame.includes(Buffer.from('metadata')))frames.push(frame);offset+=length;}return Buffer.concat(frames);
  }
  const strip=(text:string)=>JSON.stringify(JSON.parse(text), (key,value)=>['usage','usageMetadata','prompt_eval_count','eval_count'].includes(key)?undefined:value);
  if(type==='text/event-stream')return Buffer.from(body.toString().split('\n').map(line=>line.startsWith('data: ')&&line!=='data: [DONE]'?'data: '+strip(line.slice(6)):line).join('\n'));
  if(type==='application/x-ndjson')return Buffer.from(body.toString().split('\n').map(line=>line?strip(line):line).join('\n'));
  return Buffer.from(strip(body.toString()));
}
beforeEach(()=>{
  vi.spyOn(config,'getApiKey').mockReturnValue('synthetic-test-key');vi.spyOn(config,'getBaseUrl').mockReturnValue('https://bounded.invalid/v1');vi.spyOn(config,'getProviderCred').mockReturnValue({region:'us-east-1'});
  vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret');
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.useRealTimers();});
for(const backend of BACKENDS)describe(backend.id,()=>{
  const model=backend.protocol==='responses'?'gpt-5-test':'toy-model';
  for(const stream of [false,true])for(const scenario of ['text','tool'] as const)it(`bounds ${scenario} output over ${stream?'stream':'JSON'}`,async()=>{
    const bodies:any[]=[];const wire=syntheticWire(backend.protocol,scenario,stream);
    vi.stubGlobal('fetch',vi.fn(async(input,init)=>{bodies.push(await new Request(input,init).json());return wireResponse(wire.body,wire.type);}));
    const response=await invoke(adapters,backend,model,probeMessages(scenario),scenario==='tool'?[TOOL]:[],stream?()=>{}:undefined,undefined,{maxOutputTokens:13});
    expect(response.usage).toEqual({inputTokens:7,outputTokens:3});expect(bodies).toHaveLength(1);
    const body=bodies[0],maximum=backend.protocol==='google'?body.generationConfig.maxOutputTokens:backend.protocol==='bedrock'?body.inferenceConfig.maxTokens:backend.protocol==='ollama'?body.options.num_predict:backend.protocol==='responses'?body.max_output_tokens:body.max_completion_tokens??body.max_tokens;
    expect(maximum).toBe(13);
  });
  it('does not hide extra SDK retries or fallback attempts inside a failed admission',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:{message:'Synthetic unavailable'}}),{status:503,headers:{'content-type':'application/json'}})));
    await expect(invoke(adapters,backend,model,probeMessages('text'),[],undefined,undefined,{maxOutputTokens:13})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
  });
  for(const stream of [false,true])it(`preserves absent ${stream?'stream':'JSON'} usage as unknown instead of zero`,async()=>{
    const wire=syntheticWire(backend.protocol,'text',stream),body=withoutUsage(wire.body,wire.type);vi.stubGlobal('fetch',vi.fn(async()=>wireResponse(body,wire.type)));
    if(backend.protocol==='anthropic'&&stream){
      // The installed SDK rejects missing required usage fields. The reservation must stay charged.
      const settle=vi.fn(async()=>{});await expect(chat('anthropic',probeMessages('text'),[],model,()=>{},undefined,{maxOutputTokens:13,attemptBudget:{reserve:async()=>'missing-usage',settle}})).rejects.toThrow();
      expect(settle).toHaveBeenCalledWith('missing-usage','error',undefined);expect(fetch).toHaveBeenCalledTimes(1);return;
    }
    const response=await invoke(adapters,backend,model,probeMessages('text'),[],stream?()=>{}:undefined,undefined,{maxOutputTokens:13});expect(response.usage).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(1);
  });
});
for(const stream of [false,true])it(`counts reasoning and cache input in ${stream?'stream':'JSON'} usage`,async()=>{
  const googleWire=syntheticWire('google','text',stream);vi.stubGlobal('fetch',vi.fn(async()=>wireResponse(Buffer.from(googleWire.body.toString().replace('"totalTokenCount":10','"totalTokenCount":15,"thoughtsTokenCount":5')),googleWire.type)));
  expect((await google.chatGoogle(probeMessages('text'),[],'toy',stream?()=>{}:undefined,undefined,{bounded:true,maxOutputTokens:13})).usage).toEqual({inputTokens:7,outputTokens:8});
  const anthropicWire=syntheticWire('anthropic','text',stream);vi.stubGlobal('fetch',vi.fn(async()=>wireResponse(Buffer.from(anthropicWire.body.toString().replaceAll('"input_tokens":7','"input_tokens":7,"cache_creation_input_tokens":4,"cache_read_input_tokens":2')),anthropicWire.type)));
  expect((await anthropic.chatAnthropic(probeMessages('text'),[],'toy',stream?()=>{}:undefined,undefined,{bounded:true,maxOutputTokens:13})).usage).toEqual({inputTokens:13,outputTokens:3});
});
it('reserves each shared retry before HTTP and settles each attempt once',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const order:string[]=[];let n=0;
  vi.stubGlobal('fetch',vi.fn(async()=>{order.push('http');if(n++===0)return new Response('{}',{status:503});const wire=syntheticWire('chat','text',false);return wireResponse(wire.body,wire.type);}));
  let retry!:()=>void;const ready=new Promise<void>(resolve=>{retry=resolve;});
  const reserve=vi.fn(async()=>{const id=String(order.length);order.push('reserve');return id;}),settle=vi.fn(async(_id,outcome)=>{order.push(outcome);});
  const pending=chat('deepseek',probeMessages('text'),[],'toy',undefined,()=>retry(),{maxOutputTokens:13,attemptBudget:{reserve,settle}});
  await ready;await vi.advanceTimersByTimeAsync(30000);await pending;
  expect(order).toEqual(['reserve','http','error','reserve','http','success']);expect(reserve).toHaveBeenCalledTimes(2);expect(settle).toHaveBeenCalledTimes(2);
});
it('never dispatches on failed admission or retries after failed settlement',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('chat','text',false);return wireResponse(wire.body,wire.type);}));
  const settle=vi.fn();await expect(chat('deepseek',probeMessages('text'),[],'toy',undefined,undefined,{maxOutputTokens:13,attemptBudget:{reserve:async()=>{throw new ExecutionLimitError('budget','No capacity.');},settle}})).rejects.toThrow('No capacity');expect(fetch).not.toHaveBeenCalled();expect(settle).not.toHaveBeenCalled();
  await expect(chat('deepseek',probeMessages('text'),[],'toy',undefined,undefined,{maxOutputTokens:13,attemptBudget:{reserve:async()=>'ticket',settle:async()=>{throw new Error('disk failure');}}})).rejects.toMatchObject({name:'ExecutionLimitError'});expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not retry storage failures, cancelled admission, or a changed endpoint',async()=>{
  vi.stubGlobal('fetch',vi.fn());const settle=vi.fn(async()=>{}),reserve=vi.fn(async()=>{throw new Error('network timeout in budget storage');});
  await expect(chat('deepseek',probeMessages('text'),[],'toy',undefined,undefined,{maxOutputTokens:13,attemptBudget:{reserve,settle}})).rejects.toMatchObject({name:'ExecutionLimitError',code:'unavailable'});expect(reserve).toHaveBeenCalledTimes(1);expect(fetch).not.toHaveBeenCalled();
  const controller=new AbortController();await expect(chat('deepseek',probeMessages('text'),[],'toy',undefined,undefined,{signal:controller.signal,maxOutputTokens:13,attemptBudget:{reserve:async()=>{controller.abort();return 'cancelled';},settle}})).rejects.toThrow();expect(settle).toHaveBeenCalledWith('cancelled','cancelled',undefined);
  await expect(chat('deepseek',probeMessages('text'),[],'toy',undefined,undefined,{maxOutputTokens:13,attemptBudget:{reserve:async()=>{vi.mocked(config.getBaseUrl).mockReturnValue('https://changed.invalid/v1');return 'changed';},settle}})).rejects.toMatchObject({code:'authority'});expect(fetch).not.toHaveBeenCalled();expect(settle).toHaveBeenCalledWith('changed','error',undefined);
});
it('rejects incompatible shims and malformed output limits without HTTP',async()=>{
  vi.stubGlobal('fetch',vi.fn());vi.stubEnv('OPENAI_COMPAT_SHIM','jan');
  await expect(compat.chatOpenAICompatible('openai-compat',probeMessages('tool'),[TOOL],'toy',undefined,undefined,{bounded:true,maxOutputTokens:10})).rejects.toThrow(/preserves/);
  for(const max of [0,-1,1.5,NaN,Infinity])await expect(ollama.chatOllama(probeMessages('text'),[],'toy',undefined,{bounded:true,maxOutputTokens:max})).rejects.toThrow();
  await expect(ollama.chatOllama(probeMessages('text'),[],'toy',undefined,{bounded:true})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it.each([['does not support tools',400],['model not found',404],['invalid format',400]] as const)('keeps bounded Ollama %s failures to one attempt',async(message,status)=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:message}),{status})));
  await expect(ollama.chatOllama(probeMessages('tool'),[TOOL],'toy',undefined,{bounded:true,maxOutputTokens:10,format:'json'})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it('cancels Google HTTP transport and settles a bounded attempt as unknown',async()=>{
  let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});let wireSignal:AbortSignal;
  vi.stubGlobal('fetch',vi.fn(async(input,init)=>{wireSignal=new Request(input,init).signal;ready();return new Promise((_resolve,reject)=>wireSignal.addEventListener('abort',()=>reject(wireSignal.reason),{once:true}));}));
  const controller=new AbortController(),settle=vi.fn(async()=>{});
  const pending=chat('google',probeMessages('text'),[],'toy',undefined,undefined,{signal:controller.signal,maxOutputTokens:13,attemptBudget:{reserve:async()=>'ticket',settle}});const rejected=expect(pending).rejects.toThrow();await started;controller.abort();await rejected;
  expect(wireSignal!.aborted).toBe(true);expect(settle).toHaveBeenCalledWith('ticket','cancelled',undefined);expect(fetch).toHaveBeenCalledTimes(1);
});
