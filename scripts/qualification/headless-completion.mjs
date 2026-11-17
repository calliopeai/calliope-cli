/** Public compiled SDK, local inference, failed acceptance and actual file repair. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function qualifyHeadlessCompletion() {
  const results = [];
  for (const mode of ['repair', 'host-refuse', 'deadline', 'admission-refuse', 'allowance-refuse', 'allowance-stale']) {
    const root = await mkdtemp(join(tmpdir(), 'calliope520-sdk-'));
    const home = join(root, 'home'), config = join(root, 'config'), project = join(root, 'project');
    await Promise.all([home, config, project].map(path => mkdir(path)));
    let calls = 0, admissions = 0, admitted = false, failure, child, timer, stdout = '', stderr = '';
    const allowances = [];
    let sessionId;
    const server = createServer(async (request, response) => {
      try {
        if (request.method === 'GET') {
          response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model',
            context_length: 32768, max_output_tokens: 1024 }] })); return;
        }
        if (request.url === '/admit') {
          let raw = ''; for await (const chunk of request) raw += chunk;
          const proof = JSON.parse(raw); assert.equal(Object.keys(proof).sort().join(','), 'checksum,revision,sessionId');
          assert.match(proof.checksum, /^[a-f0-9]{64}$/); admissions++;
          sessionId = proof.sessionId;
          assert.equal(calls, 0); admitted = mode !== 'admission-refuse';
          response.statusCode = admitted ? 200 : 409; response.end('{}'); return;
        }
        if (request.url === '/allowance') {
          let raw = ''; for await (const chunk of request) raw += chunk;
          const proof = JSON.parse(raw);
          assert.equal(admitted, true); assert.equal(proof.sessionId, sessionId);
          assert.match(proof.checksum, /^[a-f0-9]{64}$/);
          assert.equal(proof.progress.iterationLimit, 8); assert.equal(proof.progress.completionLimit, 2);
          if (allowances.length) assert.equal(proof.progress.turnId, allowances[0].progress.turnId);
          allowances.push({ ...proof, acknowledged: mode !== 'allowance-refuse' });
          response.statusCode = mode === 'allowance-refuse' ? 409 : 200; response.end('{}'); return;
        }
        assert.equal(admitted, true, 'Inference began before host admission');
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw), index = calls++;
        assert.equal(allowances.at(-1)?.progress.iterations, index + 1, 'Provider ran before host allowance acknowledgment');
        assert.ok(index < (mode === 'repair' ? 4 : 2));
        assert.ok(body.messages.some(message => message.role === 'user' && message.content.includes('Original acceptance goal')));
        if (index >= 2) assert.ok(body.messages.some(message => message.role === 'user' && message.content.includes('must contain María and 東京')));
        const tool = { id: `effect-${index}`, type: 'function', function: { name: 'write_file',
          arguments: JSON.stringify({ path: 'effect.txt', content: index === 0 ? 'Unverified draft.\n' : 'María and 東京\n' }) } };
        const message = index % 2 === 0 ? { role: 'assistant', content: null, tool_calls: [tool] }
          : { role: 'assistant', content: 'The original goal is ready for verification.' };
        const envelope = { id: `fixture-${index}`, model: 'fixture-model', created: 1,
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
        if (body.stream) {
          response.setHeader('Content-Type', 'text/event-stream');
          const delta = index % 2 === 0 ? { role: 'assistant', tool_calls: [{ ...tool, index: 0 }] } : message;
          for (const [value, finish] of [[delta, null], [{}, index % 2 === 0 ? 'tool_calls' : 'stop']])
            response.write('data: ' + JSON.stringify({ ...envelope, object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n');
          response.end('data: [DONE]\n\n');
        } else {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ ...envelope, choices: [{ index: 0, message, finish_reason: index % 2 === 0 ? 'tool_calls' : 'stop' }] }));
        }
      } catch (error) { failure = error; response.statusCode = 500; response.end('{}'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      await writeFile(join(config, 'config.json'), JSON.stringify({ setupComplete: true, autoUpgrade: false,
        defaultProvider: 'openai-compat', defaultModel: 'fixture-model', maxIterations: 8, sandboxMode: 'off',
        routing: { enabled: false }, providers: { 'openai-compat': { apiKey: 'local-fixture-only',
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model' } },
        audit: { enabled: true, dir: join(root, 'runs') } }));
      const sdk = new URL('../../dist/index.js', import.meta.url).href;
      const source = `import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runHeadless,RuntimeControl,CONTROL_CHECKPOINT_PROTOCOL_VERSION,COMPLETION_CHECK_PROTOCOL_VERSION,HEADLESS_PROGRESS_PROTOCOL_VERSION} from ${JSON.stringify(sdk)};
assert.equal(COMPLETION_CHECK_PROTOCOL_VERSION,1);assert.equal(CONTROL_CHECKPOINT_PROTOCOL_VERSION,1);assert.equal(HEADLESS_PROGRESS_PROTOCOL_VERSION,1);
const mode=${JSON.stringify(mode)},sessions=new Set();let checks=0,turnId,acknowledged,checkpointPath;
const snapshot=(dir,id)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
 const file=join(dir,entry.name);if(entry.isDirectory()){const found=snapshot(file,id);if(found)return found;}
 else if(entry.name==='messages.json'){const saved=JSON.parse(readFileSync(file,'utf8'));if(saved.sessionId===id){checkpointPath=file;return saved;}}
}};
const code=await runHeadless({prompt:'Original acceptance goal: effect.txt must contain María and 東京, exactly.',
 provider:'openai-compat',model:'fixture-model',cwd:${JSON.stringify(project)},outputMode:'json',maxCost:.1,
 maxTime:mode==='deadline'?2:15,maxCompletionChecks:2,control:new RuntimeControl(),
 onTurnProgressCommitted:async(proof)=>{
  assert.ok(Object.isFrozen(proof));assert.ok(Object.isFrozen(proof.progress));
  const saved=snapshot(process.env.HOME,proof.sessionId);
  assert.equal(saved.revision,proof.revision);assert.equal(saved.checksum,proof.checksum);assert.deepEqual(saved.progress,proof.progress);
  const response=await fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}/allowance`)},{method:'POST',body:JSON.stringify(proof)});
  if(response.status!==200)throw Error('private allowance authority diagnostic');acknowledged=proof;
  if(mode==='allowance-stale'){
   const {checksum,...body}=saved;body.revision='external-change';
   writeFileSync(checkpointPath,JSON.stringify({...body,checksum:createHash('sha256').update(JSON.stringify(body)).digest('hex')}));
  }
 },
 onControlReady:async(proof)=>{
  assert.ok(Object.isFrozen(proof));const saved=snapshot(process.env.HOME,proof.sessionId);
  assert.equal(saved.revision,proof.revision);assert.equal(saved.checksum,proof.checksum);
  assert.equal(saved.progress.version,1);assert.equal(saved.progress.iterationLimit,8);assert.equal(saved.progress.completionLimit,2);
  assert.equal(saved.progress.iterations,0);assert.equal(saved.progress.completionChecks,0);turnId=saved.progress.turnId;
  const response=await fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}/admit`)},{method:'POST',body:JSON.stringify(proof)});
  if(response.status!==200)throw Error('private initial authority diagnostic');
 },
 completionCheck:async(proposal,signal)=>{
  checks++;sessions.add(proposal.sessionId);assert.equal(sessions.size,1);
  const saved=snapshot(process.env.HOME,proposal.sessionId);
  assert.equal(saved.revision,proposal.revision);assert.equal(saved.checksum,proposal.checksum);
  assert.equal(saved.progress.turnId,turnId);assert.equal(saved.progress.iterations,proposal.iteration);
  assert.equal(saved.progress.completionChecks,checks);assert.equal(saved.progress.completionChecks,proposal.attempt);
  assert.equal(saved.progress.completionLimit,2);
  assert.deepEqual(saved.progress,acknowledged.progress);assert.equal(saved.revision,acknowledged.revision);
  const {checksum,...unsigned}=saved;assert.equal(checksum,createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'));
  if(mode==='host-refuse')throw Error('private verifier output must not be logged');
  if(mode==='deadline')await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
  const actual=readFileSync(${JSON.stringify(join(project, 'effect.txt'))},'utf8');
  if(actual!=='María and 東京\\n')return {accepted:false,feedback:'The original criterion still fails: effect.txt must contain María and 東京, exactly.'};
  return {accepted:true,evidenceSha256:createHash('sha256').update(actual).digest('hex')};
 }});
assert.equal(checks,mode==='repair'?2:['admission-refuse','allowance-refuse','allowance-stale'].includes(mode)?0:1);assert.equal(code,mode==='repair'?0:mode==='deadline'?6:1);
process.exitCode=code;
`;
      child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: project,
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CALLIOPE_CONFIG_DIR: config,
          CALLIOPE_MAX_RETRIES: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      const [exit, signal] = await once(child, 'exit');
      assert.equal(signal, null, stderr);
      assert.equal(exit, mode === 'repair' ? 0 : mode === 'deadline' ? 6 : 1, stderr + stdout);
      if (failure) throw failure;
      assert.equal(calls, mode === 'repair' ? 4 : ['admission-refuse', 'allowance-refuse', 'allowance-stale'].includes(mode) ? 0 : 2);
      assert.equal(admissions, 1);
      assert.equal((stdout + stderr).includes('private initial authority diagnostic'), false);
      assert.equal((stdout + stderr).includes('private verifier output must not be logged'), false);
      assert.equal((stdout + stderr).includes('private allowance authority diagnostic'), false);
      const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
      const done = events.find(event => event.type === 'done');
      if (mode === 'repair') {
        assert.equal(await readFile(join(project, 'effect.txt'), 'utf8'), 'María and 東京\n');
        assert.equal(done.data.verification.checks, 2);
        assert.equal(done.data.inputTokens, 12); assert.equal(done.data.outputTokens, 8);
      } else assert.equal(done?.data.verification, undefined);
      results.push({ mode, exit, initialAdmissions: admissions, providerRequests: calls, allowanceRequests: allowances.length,
        allowanceAcknowledgments: allowances.filter(proof => proof.acknowledged).length, paidRequests: 0 });
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
  return results;
}
