import {expect,it} from 'vitest';
import {z} from 'zod';
import {assertAcpInputBounds,ACP_INPUT_LIMITS,boundAcpInput,ACP_INPUT_LIMIT_METHOD} from '../src/acp/input.js';

it('accepts bounded ordinary protocol payloads',()=>{
  expect(()=>assertAcpInputBounds({jsonrpc:'2.0',id:1,method:'session/prompt',params:{sessionId:'fixture',prompt:[{type:'text',text:'public fixture'}]}})).not.toThrow();
});
it('refuses oversized collections before inspecting their members',()=>{
  expect(()=>assertAcpInputBounds(Array(ACP_INPUT_LIMITS.collection+1).fill(null))).toThrow(/complexity limit/);
  expect(()=>assertAcpInputBounds(Array(1000000))).toThrow(/complexity limit/);
});
it('bounds aggregate nodes and nesting independently',()=>{
  expect(()=>assertAcpInputBounds(Array.from({length:100},()=>Array(200).fill(null)))).toThrow(/complexity limit/);
  let nested:unknown=null;
  for(let i=0;i<=ACP_INPUT_LIMITS.depth;i++)nested={next:nested};
  expect(()=>assertAcpInputBounds(nested)).toThrow(/complexity limit/);
});
it('uses patched Zod collection limits before evaluating invalid members',()=>{
  let inspected=0;
  const schema=z.array(z.preprocess(value=>{inspected++;return value;},z.string())).max(4);
  const result=schema.safeParse(Array(10000).fill(0));
  expect(result.success).toBe(false);
  expect(inspected).toBe(0);
  if(!result.success)expect(result.error.issues).toHaveLength(1);
});

it('bounds cumulative string bytes independently of collection size',()=>{
  expect(()=>assertAcpInputBounds(Array(33).fill('x'.repeat(1024*1024)))).toThrow(/complexity limit/);
});

async function filtered(messages:any[]) {
  const input=new ReadableStream<any>({start(controller){for(const message of messages)controller.enqueue(message);controller.close();}});
  const reader=boundAcpInput(input).getReader(),out:any[]=[];
  while(true){const value=await reader.read();if(value.done)return out;out.push(value.value);}
}

it('returns bounded errors for oversized requests and replies while dropping notifications',async()=>{
  const oversized=Array(4097).fill(null),normal={jsonrpc:'2.0',id:4,method:'initialize',params:{protocolVersion:1}};
  const output=await filtered([
    {jsonrpc:'2.0',id:'request',method:'session/new',params:{oversized}},
    {jsonrpc:'2.0',id:2,result:{oversized}},
    {jsonrpc:'2.0',method:'session/update',params:{oversized}},
    {jsonrpc:'2.0',id:'x'.repeat(257),method:'session/new',params:{oversized}},
    normal,
  ]);
  expect(output).toEqual([
    {jsonrpc:'2.0',id:'request',method:ACP_INPUT_LIMIT_METHOD},
    {jsonrpc:'2.0',id:2,error:{code:-32602,message:'ACP input complexity limit exceeded.'}},
    normal,
  ]);
});
