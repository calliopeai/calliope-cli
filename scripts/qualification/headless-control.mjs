/** Public compiled SDK, local HTTP inference and real file tools; no operator credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sdk = new URL('../../dist/index.js', import.meta.url).href;
const note = '  Keep the original criteria; include María and 東京.\n';
const effect = 'Verified control fixture.\n';
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function snapshot(directory, id, withPath = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { const found = await snapshot(path, id, withPath); if (found) return found; }
    else if (entry.name === 'messages.json') {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (saved.sessionId === id) return withPath ? { path, saved } : saved;
    }
  }
}

export async function qualifyHeadlessControl() {
  const results = [];
  for (const mode of ['pause-steer', 'tool-pause', 'policy-revoked', 'question-pause', 'cancel', 'deadline', 'host-refuse', 'stale', 'preflight-invalid', 'preflight-cancel']) {
    const root = await mkdtemp(join(tmpdir(), 'calliope518-sdk-'));
    const fixtureHome = join(root, 'home'), config = join(root, 'config'), project = join(root, 'project');
    await Promise.all([fixtureHome, config, project].map(path => mkdir(path)));
    let calls = 0, questionAcks = 0, failure, output = '', stderr = '', child, timer;
    const receipts = [];
    let providerStarted, releaseProvider;
    const providerReady = new Promise(resolve => { providerStarted = resolve; });
    const providerRelease = new Promise(resolve => { releaseProvider = resolve; });
    const policyState = join(root, 'policy-state'), policyInputs = join(root, 'policy-inputs');
    const server = createServer(async (request, response) => {
      try {
        if (request.url === '/host/provider-ready') { await providerReady; response.end('{}'); return; }
        if (request.url === '/host/release-provider') { releaseProvider(); response.end('{}'); return; }
        if (request.method === 'GET') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model',
            context_length: 32768, max_output_tokens: 1024 }] })); return;
        }
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        if (request.url === '/host/stable') {
          assert.equal(mode, 'question-pause');
          const saved = await snapshot(fixtureHome, body.sessionId);
          assert.equal(saved.revision, body.revision);
          assert.equal(saved.messages.some(message => message.role === 'tool' && message.toolCallId === 'audience'), false);
          response.end('{}'); return;
        }
        if (request.url === '/host/control' || request.url === '/host/question') {
          const saved = await snapshot(fixtureHome, body.sessionId);
          assert.ok(saved, 'The public SDK receipt must name a real saved conversation');
          assert.equal(body.revision, saved.revision); assert.equal(body.checksum, saved.checksum);
          const { checksum, ...unsigned } = saved;
          assert.equal(checksum, createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'));
          if (request.url === '/host/question') {
            assert.equal(mode, 'question-pause'); assert.equal(calls, 1);
            assert.deepEqual(saved.messages.at(-1), { role: 'tool', toolCallId: 'audience', content: 'Operators' });
            assert.equal(body.answerSha256, createHash('sha256').update('Operators').digest('hex'));
            questionAcks++;
          } else {
            if (body.kind === 'paused') {
              assert.equal(calls, ['question-pause', 'tool-pause'].includes(mode) ? 1 : 0);
              assert.equal(existsSync(join(project, 'effect.txt')), false);
              if (mode === 'policy-revoked') {
                assert.equal(await readFile(policyState, 'utf8'), 'allow');
                await writeFile(policyState, 'deny');
              }
            }
            if (body.kind === 'steered') assert.equal(saved.messages.at(-1).content, note);
            receipts.push(body);
            if (mode === 'host-refuse') { response.statusCode = 409; response.end('{}'); return; }
            if (mode === 'stale') {
              // An independent actor changes the persisted snapshot while the SDK
              // waits for acknowledgment. No private SDK API is imported by the client.
              const file = await snapshot(fixtureHome, body.sessionId, true);
              const { checksum: oldChecksum, ...changed } = file.saved;
              changed.revision = 'external-change';
              await writeFile(file.path, JSON.stringify({ ...changed,
                checksum: createHash('sha256').update(JSON.stringify(changed)).digest('hex') }));
            }
          }
          response.end('{}'); return;
        }
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer local-fixture-only');
        assert.ok(['pause-steer', 'tool-pause', 'policy-revoked', 'question-pause'].includes(mode), 'A stopped/paused SDK admitted inference');
        const index = calls++;
        if (mode === 'tool-pause' && index === 0) { providerStarted(); await providerRelease; }
        assert.ok(body.messages.some(message => message.role === 'user' && message.content.includes('Original control goal')));
        if (mode === 'pause-steer') {
          assert.deepEqual(receipts.map(receipt => receipt.kind), ['paused', 'resumed', 'steered']);
          assert.ok(body.messages.some(message => message.role === 'user' && message.content === note));
        }
        if (mode === 'question-pause' && index > 0) {
          assert.deepEqual(receipts.map(receipt => receipt.kind), ['paused', 'resumed']);
          assert.equal(questionAcks, 1);
          assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'audience'
            && message.content === 'Operators'));
        }
        const asking = mode === 'question-pause' && index === 0;
        const writing = mode === 'question-pause' ? index === 1 : index === 0;
        if (mode === 'policy-revoked' && index > 0) {
          assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'effect'
            && message.content.includes('Policy denied')));
        }
        const call = asking ? { id: 'audience', type: 'function', function: { name: 'ask_question',
          arguments: JSON.stringify({ question: 'Who is this for?', options: ['Operators'] }) } }
          : { id: 'effect', type: 'function', function: { name: 'write_file',
            arguments: JSON.stringify({ path: 'effect.txt', content: effect }) } };
        const hasTool = asking || writing;
        const message = hasTool ? { role: 'assistant', content: null, tool_calls: [call] }
          : { role: 'assistant', content: 'Verified control fixture completed.' };
        const envelope = { id: 'control-fixture', model: 'fixture-model', created: 1,
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
        if (body.stream) {
          response.setHeader('Content-Type', 'text/event-stream');
          for (const [delta, finish] of [[hasTool ? { role: 'assistant', tool_calls: [{ ...call, index: 0 }] } : message, null],
            [{}, hasTool ? 'tool_calls' : 'stop']]) response.write('data: ' + JSON.stringify({ ...envelope,
            object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
          response.end('data: [DONE]\n\n');
        } else {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ ...envelope, choices: [{ index: 0, message,
            finish_reason: hasTool ? 'tool_calls' : 'stop' }] }));
        }
      } catch (error) { failure = String(error); response.statusCode = 500; response.end('Control fixture refused request'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const policyScript = join(root, 'policy.cjs');
      await writeFile(policyState, 'allow');
      await writeFile(policyScript, `const f=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const state=f.readFileSync(${JSON.stringify(policyState)},'utf8');f.appendFileSync(${JSON.stringify(policyInputs)},JSON.stringify({state,call:JSON.parse(input)})+'\\n');if(state!=='allow')process.stderr.write('Permission revoked during pause');process.exit(state==='allow'?0:2)});`);
      await writeFile(join(config, 'config.json'), JSON.stringify({ setupComplete: true, autoUpgrade: false,
        defaultProvider: 'openai-compat', defaultModel: 'fixture-model', maxIterations: 4, sandboxMode: 'off',
        routing: { enabled: false }, providers: { 'openai-compat': { apiKey: 'local-fixture-only',
          baseUrl: base + '/v1', model: 'fixture-model' } }, audit: { enabled: true, dir: join(root, 'runs') },
        ...(mode === 'policy-revoked' ? { policy: { command: `${shellQuote(process.execPath)} ${shellQuote(policyScript)}`, timeoutMs: 5000 } } : {}) }));
      const script = join(root, 'client.mjs');
      await writeFile(script, `
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {runHeadless,RuntimeControl} from ${JSON.stringify(sdk)};
const mode=${JSON.stringify(mode)},control=new RuntimeControl(),cancel=new AbortController();
let asked,answer;const question=new Promise(resolve=>{asked=resolve});const answerWait=new Promise(resolve=>{answer=resolve});
const initial=['question-pause','tool-pause'].includes(mode)?null:control.pause('pause-before-provider');
if(mode==='preflight-cancel')cancel.abort();
const running=runHeadless({prompt:'Original control goal: verify a real file write.',provider:'openai-compat',
 model:'fixture-model',cwd:${JSON.stringify(project)},outputMode:'json',control,signal:cancel.signal,
 ...(mode==='preflight-invalid'?{reasoningEffort:'invalid'}:{}),
 ...(mode==='deadline'?{maxTime:3}:{}),
 answerQuestion:async()=>{asked();return answerWait},
 onQuestionCommitted:async receipt=>{const r=await fetch(${JSON.stringify(base + '/host/question')},{method:'POST',body:JSON.stringify(receipt)});assert.equal(r.status,200)},
 onControlCommitted:async receipt=>{
  const r=await fetch(${JSON.stringify(base + '/host/control')},{method:'POST',body:JSON.stringify(receipt)});
  if(!r.ok)throw new Error('Host refused execution control');
 }});
if(mode==='host-refuse'||mode==='stale'||mode.startsWith('preflight-'))await assert.rejects(initial);
else{
 if(mode==='question-pause')await question;
 let toolPause;
 if(mode==='tool-pause'){
  await fetch(${JSON.stringify(base + '/host/provider-ready')});toolPause=control.pause('pause-before-tool');
  assert.equal(control.state.phase,'pausing');await fetch(${JSON.stringify(base + '/host/release-provider')});
 }
 const paused=await(initial??toolPause??control.pause('question-pause'));
 assert.equal(control.state.phase,'paused');
 assert.throws(()=>control.resume({...paused,revision:'stale'}));
 if(mode==='cancel')cancel.abort();
 else if(mode!=='deadline'){
  let steering;
  if(mode==='pause-steer'){const intent={requestId:'note',sessionId:paused.sessionId,revision:paused.revision,text:${JSON.stringify(note)}};steering=control.steer(intent);assert.equal(control.steer(intent),steering)}
  else if(mode==='question-pause'){answer('Operators');await turn();const stable=await fetch(${JSON.stringify(base + '/host/stable')},{method:'POST',body:JSON.stringify(paused)});assert.equal(stable.status,200)}
  await control.resume(paused);await steering;
 }
}
const code=await running;assert.equal(control.state.phase,'stopped');process.exitCode=code;
`);
      child = spawn(process.execPath, [script], { cwd: project, env: { PATH: process.env.PATH, HOME: fixtureHome,
        USERPROFILE: fixtureHome, CALLIOPE_CONFIG_DIR: config, CALLIOPE_MAX_RETRIES: '0', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL');
        reject(new Error('Compiled control qualification exceeded 20s')); }, 20000); });
      const [code] = await Promise.race([once(child, 'exit'), timeout]);
      assert.equal(failure, undefined, failure);
      if (mode.startsWith('preflight-')) assert.equal(receipts.length, 0);
      else assert.ok(receipts.length > 0, stderr + output);
      const success = ['pause-steer', 'tool-pause', 'policy-revoked', 'question-pause'].includes(mode);
      assert.equal(code, success ? 0 : ['cancel', 'preflight-cancel'].includes(mode) ? 130
        : mode === 'preflight-invalid' ? 2 : mode === 'deadline' ? 6 : 1, stderr + output);
      assert.equal(calls, success ? mode === 'question-pause' ? 3 : 2 : 0, stderr + output);
      const wrote = success && mode !== 'policy-revoked';
      if (wrote) assert.equal(await readFile(join(project, 'effect.txt'), 'utf8'), effect);
      else assert.equal(existsSync(join(project, 'effect.txt')), false);
      if (mode === 'policy-revoked') {
        const judgments = (await readFile(policyInputs, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.ok(judgments.length > 0);
        assert.ok(judgments.every(value => value.state === 'deny' && value.call.name === 'write_file'));
      }
      const events = output.trim().split('\n').map(line => JSON.parse(line));
      if (success) assert.equal(events.at(-1).data.reason, 'completed');
      results.push({ mode, exit: code, providerRequests: calls, controlReceipts: receipts.map(receipt => receipt.kind),
        questionAcknowledgments: questionAcks, realFileVerified: wrote, paidRequests: 0 });
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
  return results;
}
