import {it,expect,vi} from 'vitest';
import {artifactHostCapabilities,prepareArtifactHost,bindArtifactHost,type ArtifactHost,type ArtifactTaskContext} from '../src/orchestration/artifact-host.js';
import {executeTool} from '../src/tools.js';

const context:ArtifactTaskContext={version:1,project:{root:'/fixture',key:'a'.repeat(64)},runId:'native-run',manifestHash:'b'.repeat(64),planHash:'c'.repeat(64),approvalRevision:'native-approval',taskId:'native-task',agentId:'native-agent',sessionId:'native-session',attempt:2,startEventId:'native-start',startEventHash:'d'.repeat(64)};
const tool={name:'artifact',description:'Operate on reviewed draft artifacts.',parameters:{type:'object' as const,properties:{operation:{type:'string',description:'Artifact operation'}}}};
const call={id:'call',name:'artifact',arguments:{operation:'read'}};
const host=(execute:ArtifactHost['execute']):ArtifactHost=>prepareArtifactHost({version:1,tool,execute});

it('snapshots native context separately from arguments and isolates callback mutation across calls',async()=>{
  const seen:ArtifactTaskContext[]=[];const original=structuredClone(context);
  const binding=bindArtifactHost(host(async(args,identity,control)=>{control.assertActive();seen.push(structuredClone(identity));identity.sessionId='mutated';identity.project.root='mutated';return {content:{received:args.sessionId}};}),original,()=>{});
  original.sessionId='changed-after-binding';
  const request={...call,arguments:{operation:'read',sessionId:'untrusted'}};
  for(let i=0;i<2;i++)expect(JSON.parse((await binding.execute(request,undefined,1000)).result)).toEqual({received:'untrusted'});
  expect(seen).toEqual([context,context]);
});
it('requires the execution authority and binding at the actual dispatcher',async()=>{
  const invoke=vi.fn(async()=>({content:{ok:true}}));const binding=bindArtifactHost(host(invoke),context,()=>{});
  expect((await executeTool(call,'/fixture',1000,undefined,{artifact:binding})).isError).toBe(true);
  expect((await executeTool(call,'/fixture',1000,undefined,{authority:()=>undefined})).isError).toBe(true);
  expect((await executeTool(call,'/fixture',1000,undefined,{artifact:binding,authority:()=> 'revoked'})).isError).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
});
it('refuses another tool and revoked authority before invoking the host',async()=>{
  const invoke=vi.fn(async()=>({content:{ok:true}}));
  const binding=bindArtifactHost(host(invoke),context,()=>{throw Error('revoked');});
  await expect(binding.execute(call,undefined,1000)).rejects.toThrow('revoked');
  await expect(binding.execute({...call,name:'shell'},undefined,1000)).rejects.toThrow('another tool');
  expect(invoke).not.toHaveBeenCalled();
});
it('bounds request structure and bytes before dispatch and sanitizes host failures',async()=>{
  const invoke=vi.fn(async()=>{throw Error('credential=private');});const binding=bindArtifactHost(host(invoke),context,()=>{});
  const loop:Record<string,unknown>={};loop.self=loop;
  for(const args of [loop,{bad:NaN},{bad:undefined},{bad:new Date()},{bad:'x'.repeat(1048577)},[],null,'read'])expect((await binding.execute({...call,arguments:args as never},undefined,1000)).isError).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
  const result=await binding.execute(call,undefined,1000);expect(result.isError).toBe(true);expect(result.result).not.toContain('private');expect(invoke).toHaveBeenCalledTimes(1);
});
it('bounds responses and preserves explicit product refusal without retrying',async()=>{
  for(const result of [{content:'x'.repeat(2097153)},{content:NaN},{content:{ok:true},secret:'not allowed'},{content:{ok:true},isError:'yes'}]){
    const invoke=vi.fn(async()=>result as never),binding=bindArtifactHost(host(invoke),context,()=>{});
    expect((await binding.execute(call,undefined,1000)).isError).toBe(true);expect(invoke).toHaveBeenCalledTimes(1);
  }
  const binding=bindArtifactHost(host(async()=>({content:{code:'access-required'},isError:true})),context,()=>{});
  expect(await binding.execute(call,undefined,1000)).toEqual({toolCallId:'call',result:'{"code":"access-required"}',isError:true});
});
it('cancels in-flight work and gives the host a live check before any later mutation',async()=>{
  const controller=new AbortController();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let writes=0;
  const binding=bindArtifactHost(host(async(_args,_identity,control)=>{entered();await gate;control.assertActive();writes++;return {content:{ok:true}};}),context,()=>{});
  const running=binding.execute(call,controller.signal,1000);await started;controller.abort();release();
  await expect(running).rejects.toThrow();expect(writes).toBe(0);
});
it('times out a host that does not reply and refuses a result after authority revocation',async()=>{
  const waiting=bindArtifactHost(host(async()=>new Promise(()=>{})),context,()=>{});
  await expect(waiting.execute(call,undefined,5)).rejects.toThrow();
  let active=true;const binding=bindArtifactHost(host(async()=>{active=false;return {content:{private:'stale'}};}),context,()=>{if(!active)throw Error('revoked');});
  const result=await binding.execute(call,undefined,1000);expect(result.isError).toBe(true);expect(result.result).not.toContain('stale');
});
it('validates and snapshots the host descriptor without admitting a replacement tool',()=>{
  const input:ArtifactHost={version:1,tool:structuredClone(tool),execute:async()=>({content:null})};const prepared=prepareArtifactHost(input);
  input.tool.description='changed';expect(prepared.tool.description).toBe(tool.description);
  for(const invalid of [{...input,version:2},{...input,execute:null},{...input,tool:{...tool,name:'shell'}},{...input,tool:{...tool,description:'x'.repeat(4097)}},{...input,tool:{...tool,parameters:{type:'object',properties:'bad'}}}])expect(()=>prepareArtifactHost(invalid as never)).toThrow();
  expect(artifactHostCapabilities()).toMatchObject({version:1,tool:'artifact',identity:'native-task-attempt'});
});
