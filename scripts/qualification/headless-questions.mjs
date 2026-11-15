/** Compiled public SDK and real local provider transport; no paid model or operator store. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const sdk=new URL('../../dist/index.js',import.meta.url).href;
export async function qualifyHeadlessQuestions() {
const results=[];
for(const mode of ['answer','cancel','deadline']){
 const root=await mkdtemp(join(tmpdir(),'calliope512-sdk-')),home=join(root,'home'),config=join(root,'config'),project=join(root,'project');
 await Promise.all([home,config,project].map(p=>mkdir(p)));
 let calls=0,failure,output='',stderr='';
 const server=createServer(async(req,res)=>{try{
  if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'fixture-model',object:'model',context_length:32768,max_output_tokens:1024}]}));return;}
  assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer local-fixture-only');
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),first=calls++===0;
  if(!first){assert.equal(mode,'answer');assert.ok(body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='audience'&&m.content==='Operators'));}
  const call={id:'audience',type:'function',function:{name:'ask_question',arguments:JSON.stringify({question:'Which audience?',options:['Engineers','Operators']})}};
  const message=first?{role:'assistant',content:null,tool_calls:[call]}:{role:'assistant',content:'Report for operators.'};
  const envelope={id:'fixture-response',model:'fixture-model',created:1,usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}};
  if(body.stream){res.setHeader('Content-Type','text/event-stream');for(const [delta,finish] of [[first?{role:'assistant',tool_calls:[{...call,index:0}]}:message,null],[{},first?'tool_calls':'stop']])res.write('data: '+JSON.stringify({...envelope,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');res.end('data: [DONE]\n\n');}
  else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...envelope,object:'chat.completion',choices:[{index:0,message,finish_reason:first?'tool_calls':'stop'}]}));}
 }catch(e){failure=String(e);res.statusCode=500;res.end('Fixture refused request');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');let child,timer;
 try{
  await writeFile(join(config,'config.json'),JSON.stringify({setupComplete:true,autoUpgrade:false,defaultProvider:'openai-compat',defaultModel:'fixture-model',maxIterations:3,sandboxMode:'off',routing:{enabled:false},providers:{'openai-compat':{apiKey:'local-fixture-only',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-model'}},audit:{enabled:true,dir:join(root,'runs')}}));
  const script=join(root,'client.mjs');await writeFile(script,`import {runHeadless} from ${JSON.stringify(sdk)};const mode=${JSON.stringify(mode)},controller=new AbortController();const code=await runHeadless({prompt:'Write a report',provider:'openai-compat',model:'fixture-model',outputMode:'json',cwd:${JSON.stringify(project)},signal:controller.signal,...(mode==='deadline'?{maxTime:1}:{}),answerQuestion:async(call,signal)=>{if(call.id!=='audience'||call.name!=='ask_question')throw new Error('Wrong question');console.error('HOST_QUESTION_RECEIVED');if(mode==='answer')return 'Operators';if(mode==='cancel')controller.abort();return new Promise(resolve=>{signal.addEventListener('abort',()=>resolve('Too late'),{once:true});});}});process.exitCode=code;`);
  child=spawn(process.execPath,[script],{cwd:project,env:{PATH:process.env.PATH,HOME:home,USERPROFILE:home,CALLIOPE_CONFIG_DIR:config,CALLIOPE_MAX_RETRIES:'0',NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>stderr+=c);
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Fixture exceeded15s'));},15000);});
  const [code]=await Promise.race([once(child,'exit'),deadline]);assert.equal(failure,undefined,failure);assert.ok(stderr.includes('HOST_QUESTION_RECEIVED'),stderr+output);
  assert.equal(code,mode==='answer'?0:mode==='cancel'?130:6,stderr+output);assert.equal(calls,mode==='answer'?2:1);
  const events=output.trim().split('\n').map(s=>JSON.parse(s));const done=events.at(-1);assert.equal(done.type,'done');assert.equal(done.data.reason,mode==='answer'?'completed':mode==='cancel'?'cancelled':'budget');
  if(mode!=='answer')assert.ok(!events.some(e=>e.type==='tool_result'&&e.data.result==='Too late'));
  results.push({mode,exit:code,providerRequests:calls,outcome:done.data.reason,usage:done.data});
 }finally{clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
}
return results;
}
