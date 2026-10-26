/** Real reviewed parent transport and built headless children; no paid inference.
 * Run after npm run build. Keep this executable example independent of test mocks.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const packagePath = process.env.CALLIOPE_REVIEWED_HOST_PACKAGE;
const packageRoot = packagePath ? fs.realpathSync(packagePath) : fileURLToPath(new URL('../../', import.meta.url));
const nativeBinary = process.env.CALLIOPE_REVIEWED_HOST_BINARY;
assert.ok(!(packagePath && nativeBinary), 'Choose either an extracted npm package or a standalone binary');
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-reviewed-example-')));
fs.chmodSync(root, 0o700);
const home = join(root, 'home'), config = join(root, 'config'), project = join(root, 'project');
for (const dir of [home, config, project]) fs.mkdirSync(dir, {mode: 0o700});
// Configure before loading any library module with process-level configuration.
process.env.CALLIOPE_CONFIG_DIR = config;
process.env.HOME = home;
process.env.USERPROFILE = home;
const binary = join(packageRoot, 'dist/bin.js');
const command = nativeBinary || process.execPath;
const prefix = nativeBinary ? [] : [binary];
const {RunStore, prepareRun, changePreparedRun, prepareAgentExecution, prepareReviewedLedger,
  ExecutionStore} = await import(pathToFileURL(join(packageRoot, 'dist/orchestration/index.js')).href);
const {RemoteReservationLedger} = await import(pathToFileURL(join(packageRoot, 'dist/execution/index.js')).href);
let inference = 0;
const servers = [], children = new Set();
const listen = async server => {
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const provider = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({object:'list',data:[{id:'reviewed-fixture',object:'model',context_length:32768,
      max_output_tokens:4096,pricing:{input:0,output:0},capabilities:{chat:true,tools:true,streaming:true}}]}));
    return;
  }
  let raw=''; for await (const chunk of request) raw+=chunk;
  assert.equal(request.url, '/v1/chat/completions');
  const body=JSON.parse(raw); inference++;
  const envelope={id:'reviewed-'+inference,model:'reviewed-fixture',created:1,
    usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
  if(body.stream){
    response.setHeader('content-type','text/event-stream');
    response.write('data: '+JSON.stringify({...envelope,object:'chat.completion.chunk',choices:[{index:0,
      delta:{role:'assistant',content:'Reviewed child completed.'},finish_reason:null}]})+'\n\n');
    response.write('data: '+JSON.stringify({...envelope,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');
    response.end('data: [DONE]\n\n');
  }else{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({...envelope,object:'chat.completion',choices:[{index:0,
      message:{role:'assistant',content:'Reviewed child completed.'},finish_reason:'stop'}]}));
  }
});
try {
  const providerUrl=await listen(provider);
  fs.writeFileSync(join(config,'config.json'),JSON.stringify({setupComplete:true,autoUpgrade:false,
    defaultProvider:'openai-compat',defaultModel:'reviewed-fixture',maxIterations:1,sandboxMode:'off',
    providers:{'openai-compat':{apiKey:'local-fixture-only',baseUrl:providerUrl+'/v1',model:'reviewed-fixture'}},
    routing:{enabled:false},audit:{enabled:false}}),{mode:0o600});
  const worker=id=>({id,parentId:'coordinator',role:'Fixture worker',objective:'Return a public fixture response.',
    inputs:[],allowedTools:['read_file'],allowedPaths:[{path:id,access:'write'}],preference:{provider:'openai-compat',model:'reviewed-fixture'},
    tokenBudget:100000,costBudgetUsd:0.01,timeBudgetMs:120000,maxChildDepth:0,maxChildCount:0,
    acceptanceCriteria:['Return the fixture response.'],escalationPolicy:{onFailure:'parent',maxRetries:0}});
  for(const id of ['a','b']) fs.mkdirSync(join(project,id));
  const plan={version:2,id:'reviewed-host-example',goal:'Qualify actual child transport under one reviewed parent.',
    workspace:{id:'fixture',root:'.',allowedTools:['read_file'],allowedPaths:[{path:'.',access:'write'}]},
    limits:{maxAgents:3,maxTasks:2,maxDepth:1,maxConcurrent:2,tokenBudget:200000,costBudgetUsd:0.02,timeBudgetMs:120000},
    agents:[{...worker('coordinator'),parentId:null,tokenBudget:200000,costBudgetUsd:0.02,maxChildDepth:1,maxChildCount:2,
      allowedPaths:[{path:'.',access:'write'}],escalationPolicy:{onFailure:'human',maxRetries:0}},worker('a'),worker('b')],
    tasks:['a','b'].map(id=>({id:'inspect-'+id,agentId:id,objective:'Return a public response.',inputs:[],
      outputs:[{id:'report-'+id,kind:'report',description:'Fixture report.',path:id+'/report.txt'}],dependencies:[],
      acceptanceCriteria:['Return the fixture response.'],acceptanceChecks:[{id:'check-'+id,artifactId:'report-'+id,
        kind:'contains',expected:'Reviewed child completed.',criteria:['task:0','agent:0']}]}))};
  fs.writeFileSync(join(project,'plan.json'),JSON.stringify(plan));
  const runs=new RunStore(),prepared=await prepareRun(project,'plan.json',{store:runs});
  const reviewed=await changePreparedRun(project,prepared.run.id,'approved',{store:runs});
  const authority=await prepareAgentExecution(project,reviewed.run.id,'coordinator',4096,{store:runs});
  const initial=authority.ledger.read(project);
  new ExecutionStore(join(runs.root,reviewed.run.id),reviewed.manifest).create({version:1,runId:reviewed.run.id,
    manifestHash:reviewed.manifest.hash,approvalRevision:reviewed.run.revision,
    createdAt:new Date(initial.manifest.createdAt).toISOString(),deadline:initial.manifest.deadline});
  let host=await prepareReviewedLedger(project,reviewed.run.id,'coordinator',4096,{store:runs});
  let url=await listen(host.server);
  const env={PATH:process.env.PATH,HOME:home,USERPROFILE:home,CALLIOPE_CONFIG_DIR:config,
    CALLIOPE_MAX_RETRIES:'0',NO_COLOR:'1'};
  const bindings={};let generation=0;
  const stopHost=async binding=>{
    const exited=once(binding.process,'exit');binding.process.kill('SIGTERM');
    await exited;children.delete(binding.process);
  };
  const bindChildren=async(first)=>{
    generation++;
    for(const id of ['a','b']){
      const tokenFile=join(root,id+'.token'),issued=first?tokenFile:join(root,id+'.'+generation+'.token');
      const processHost=spawn(command,[...prefix,'ledger','serve-reviewed','--run',reviewed.run.id,'--agent',id,
        '--max-output-tokens','4096','--project',project,'--token-file',issued],
        {cwd:project,env,stdio:['ignore','pipe','pipe']});
      children.add(processHost);let output='',error='';
      processHost.stderr.on('data',value=>{error=(error+value).slice(-4000);});
      const metadata=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Reviewed host did not listen: '+error)),15000);
        processHost.once('exit',code=>{clearTimeout(timer);reject(new Error('Reviewed host exited '+code+': '+error));});
        processHost.stdout.on('data',value=>{
          output+=value;
          if(output.includes('\n')){
            clearTimeout(timer);
            try{resolve(JSON.parse(output.split('\n')[0]));}catch(e){reject(e);}
          }
        });
      });
      assert.equal(metadata.protocol,'delegation-ledger/v1');
      assert.equal(metadata.ownerAgentId,id);assert.equal(metadata.reviewed.tokenVersion,2);
      assert.equal(metadata.deadline,initial.manifest.deadline);
      if(!first)assert.equal(fs.readFileSync(issued,'utf8'),fs.readFileSync(tokenFile,'utf8'));
      bindings[id]={process:processHost,url:metadata.url,tokenFile};
    }
  };
  await bindChildren(true);
  const run=async(agentId,cwd=project,credentialOwner=agentId)=>{
    const binding=bindings[credentialOwner];
    const child=spawn(command,[...prefix,'--headless','--json','--provider','openai-compat','--model','reviewed-fixture',
      '--ledger-url',binding.url,'--ledger-token-file',binding.tokenFile,'--ledger-agent',agentId,'Return the fixture response.'],
      {cwd,env,stdio:['ignore','pipe','pipe']});
    children.add(child);let stdout='',stderr='';
    child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),45000);
    try {const [code,signal]=await once(child,'exit');assert.equal(signal,null,stderr);return {code,stdout,stderr};}
    finally{clearTimeout(timer);children.delete(child);}
  };
  const completed=await Promise.all([run('a'),run('b')]);
  for(const result of completed){assert.equal(result.code,0,result.stdout+result.stderr);assert.match(result.stdout,/Reviewed child completed/);}
  assert.equal(inference,2,'Both native children must reach the local provider exactly once');
  let saved=authority.ledger.read(project);
  assert.equal(saved.projection.spent.tokens,4,'Both children must settle into one parent');
  // Exhaust each account with an explicitly retained unknown request. This also
  // proves a host restart cannot erase unresolved work or replenish the parent.
  const client=await RemoteReservationLedger.connect({url,token:host.ownerToken,root:join(root,'verified-parent')});
  for(const id of ['a','b']){
    await client.reserve(project,authority.manifestHash,{id:randomUUID(),agentId:id,provider:'openai-compat',model:'reviewed-fixture',
      target:'a'.repeat(64),inputTokens:99997,outputTokens:1,inputPrice:0,outputPrice:0,costNanos:0});
  }
  saved=authority.ledger.read(project);assert.equal(saved.projection.spent.tokens,200000);
  await Promise.all([close(host.server),...Object.values(bindings).map(stopHost)]);
  host=await prepareReviewedLedger(project,reviewed.run.id,'coordinator',4096,{store:runs});
  url=await listen(host.server);
  await bindChildren(false);
  assert.deepEqual(authority.ledger.read(project),saved,'Restart must preserve the original journal');
  const denied=await run('a');assert.notEqual(denied.code,0);assert.match(denied.stdout,/budget|allowance|capacity/i);
  assert.equal(inference,2,'Exhaustion must stop the actual CLI before inference');
  const foreign=join(root,'foreign');fs.mkdirSync(foreign);
  const wrongProject=await run('a',foreign);assert.notEqual(wrongProject.code,0);assert.match(wrongProject.stdout,/project|workspace/i);
  const sibling=await run('b',project,'a');assert.notEqual(sibling.code,0);assert.match(sibling.stdout,/authority|scope|account|refus/i);
  await changePreparedRun(project,reviewed.run.id,'cancelled',{store:runs});
  const cancelled=await run('b');assert.notEqual(cancelled.code,0);assert.match(cancelled.stdout,/authority|cancel|refus/i);
  assert.equal(inference,2,'Neither another project nor cancelled authority may infer');
  console.log(JSON.stringify({protocol:'reviewed-host-qualification/v1',artifact:nativeBinary?'standalone':packagePath?'npm-package':'node',inferenceRequests:inference,
    concurrentChildren:2,parentTokens:200000,restartPreserved:true,exhaustionRefused:true,
    foreignProjectRefused:true,siblingRefused:true,revocationRefused:true,paidRequests:0}));
} finally {
  await Promise.all([...children].map(async child=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  }));
  for(const server of servers) if(server.listening) await close(server);
  fs.rmSync(root,{recursive:true,force:true});
}
