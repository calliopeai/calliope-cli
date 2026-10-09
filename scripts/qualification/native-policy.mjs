/** Built CLI + actual SDK transports + local inference + real policy processes.
 * No production credential or paid model is used. POSIX + Python 3 required.
 * Run after npm run build. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const binary = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const terminalBridge = fileURLToPath(new URL('./terminal-pty.py', import.meta.url));
const args = { path: 'effect.txt', content: 'native-effect café\n' };
const finalText = 'Native policy fixture completed.';
const fileFixtureCall = { id: 'native_fixture_call', type: 'function', function: { name: 'write_file', arguments: JSON.stringify(args) } };
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function stop(child) {
  if (child) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
}

async function exercise(client, decision) {
  const root = await mkdtemp(join(tmpdir(), 'calliope-native-client-'));
  const home = join(root, 'home'), project = join(root, 'project'), config = join(root, 'config');
  await Promise.all([mkdir(home), mkdir(project), mkdir(config)]);
  const inputs = join(root, 'policy-inputs.jsonl'), marker = join(project, args.path);
  const continuing = decision.endsWith('-child'), shellCancelling = decision.startsWith('cancel-shell');
  const cancelling = decision.startsWith('cancel');
  const outcome = continuing ? decision.slice(0, -6) : decision;
  const ready = join(root, 'policy-ready'), descendantPid = join(root, 'policy-child.pid'), lateEffect = join(root, 'policy-late-effect');
  const shellScript = join(project, 'native-shell.cjs'), shellChild = join(project, 'native-child.cjs');
  const invocationArgs = shellCancelling ? { command: `${shellQuote(process.execPath)} ${shellQuote(shellScript)}` } : args;
  const fixtureCall = shellCancelling ? { ...fileFixtureCall, function: { name: 'shell', arguments: JSON.stringify(invocationArgs) } } : fileFixtureCall;
  let completions = 0, child, stderr = '', stdout = '', permissions = 0, editorWrites = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model', context_length: 32768, max_output_tokens: 1024 }] }));
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer native-fixture-key');
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), first = completions++ === 0;
      const message = first ? { role: 'assistant', content: null, tool_calls: [fixtureCall] }
        : { role: 'assistant', content: finalText };
      const finish = first ? 'tool_calls' : 'stop';
      const envelope = { id: 'fixture-response', model: 'fixture-model', created: 1,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      if (body.stream) {
        response.setHeader('Content-Type', 'text/event-stream');
        const delta = first ? { role: 'assistant', tool_calls: [{ ...fixtureCall, index: 0 }] } : message;
        for (const [value, reason] of [[delta, null], [{}, finish]])
          response.write('data: ' + JSON.stringify({ ...envelope, object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: value, finish_reason: reason }] }) + '\n\n');
        response.end('data: [DONE]\n\n');
      } else {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ...envelope, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }] }));
      }
    } catch (error) {
      response.statusCode = 500; response.end('Fixture request rejected');
      stderr += String(error);
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let timeout;
  try {
    if (shellCancelling) {
      await writeFile(shellChild, `const fs=require('node:fs');process.on('SIGTERM',()=>{});` +
        `fs.writeFileSync(${JSON.stringify(descendantPid)},String(process.pid));fs.writeFileSync(${JSON.stringify(ready)},'ready');` +
        `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(marker)},'late-tool-effect');process.exit(0)},2000);`);
      await writeFile(shellScript, `require('node:child_process').spawn(process.execPath,[${JSON.stringify(shellChild)}],{stdio:'ignore'});` +
        `process.on('SIGTERM',()=>process.exit(0));setTimeout(()=>process.exit(0),5000);`);
    }
    const script = join(root, 'policy.mjs');
    const descendant = join(root, 'policy-child.mjs');
    if (continuing || cancelling && !shellCancelling) await writeFile(descendant, `import fs from 'node:fs';process.on('SIGTERM',()=>{});` +
      `fs.writeFileSync(${JSON.stringify(descendantPid)},String(process.pid));fs.writeFileSync(${JSON.stringify(ready)},'ready');` +
      `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(lateEffect)},'late-effect');process.exit(0)},2000);`);
    await writeFile(script, `import fs from 'node:fs';let raw='';for await(const chunk of process.stdin)raw+=chunk;` +
      `fs.appendFileSync(${JSON.stringify(inputs)},raw+'\\n');const input=JSON.parse(raw);` +
      `if(input.name!=='write_file')process.exit(0);` +
      (continuing ? `const {spawn}=await import('node:child_process');spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});` +
        `const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(wait);` +
        (outcome === 'timeout' ? `setInterval(()=>{},1000);` : `process.exit(${outcome === 'allow' ? 0 : 2});`) + `}},5);`
        : cancelling ? `const {spawn}=await import('node:child_process');spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});` +
          `setTimeout(()=>process.exit(0),2000);`
        : decision === 'timeout' ? 'setTimeout(()=>process.exit(0),3000);' : `process.exit(${decision === 'allow' ? 0 : 2});`));
    const command = decision === 'offline' ? 'calliope-missing-policy-fixture-command'
      : `${shellQuote(process.execPath)} ${shellQuote(script)}`;
    await writeFile(join(config, 'config.json'), JSON.stringify({ setupComplete: true, autoUpgrade: false,
      defaultProvider: 'openai-compat', defaultModel: 'fixture-model', maxIterations: 3, sandboxMode: 'off',
      providers: { 'openai-compat': { apiKey: 'native-fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture-model' } },
      routing: { enabled: false }, policy: { command, timeoutMs: cancelling ? 5000 : 500 }, audit: { enabled: true, dir: join(root, 'runs') } }));
    // A fresh process environment/home prevents startup dotenv/config loading
    // from finding real provider credentials or touching the operator's stores.
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TERM: 'xterm-256color',
      CALLIOPE_CONFIG_DIR: config, CALLIOPE_MAX_RETRIES: '0', NO_COLOR: '1' };
    const cliArgs = [binary, ...(client === 'headless'
      ? ['--headless', '--auto', '--json', '--provider', 'openai-compat', '--model', 'fixture-model', 'Run the fixture command.']
      : client === 'terminal' ? ['--auto', '--provider', 'openai-compat', '--model', 'fixture-model'] : ['acp'])];
    child = client === 'terminal'
      ? spawn('python3', [terminalBridge, process.execPath, ...cliArgs], { cwd: project, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(process.execPath, cliArgs, { cwd: project, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-20000); });
    const deadline = new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Native ${client} ${decision} exceeded 25 seconds: ${stdout}${stderr}`)), 25000); });
    const cancelWhenReady = async action => {
      const started = Date.now();
      while (!existsSync(ready)) {
        assert.ok(Date.now() - started < 5000, 'Policy did not become ready for cancellation');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      action();
    };
    if (client === 'headless') {
      child.stdin.end();
      if (cancelling) await cancelWhenReady(() => child.kill('SIGINT'));
      const [code] = await Promise.race([exited, deadline]);
      assert.equal(code, cancelling ? 130 : 0, stdout + stderr);
      const events = stdout.trim().split('\n').map(line => JSON.parse(line));
      const result = events.find(event => event.type === 'tool_result' && event.data.toolCallId === fixtureCall.id);
      if (cancelling) assert.equal(events.find(event => event.type === 'done')?.data.reason, 'cancelled', stdout + stderr);
      else {
        assert.ok(result, stdout + stderr);
        assert.equal(result.data.isError, outcome !== 'allow', stdout + stderr);
      }
    } else if (client === 'terminal') {
      let submitted = false, enterSent = false, finished = false, exitEnterSent = false, cancelledAt, finishedAt;
      child.stdout.on('data', chunk => {
        if (!submitted && stdout.includes('calliope>')) {
          submitted = true;
          // Ink treats a text+Return chunk as pasted text. Wait for the actual
          // rendered input acknowledgment before sending Return: elapsed time
          // alone cannot prevent PTY input coalescing under CPU contention.
          setTimeout(() => {
            if (child.stdin.destroyed) return;
            child.stdin.write('Run the fixture command.');
          }, 100);
        }
        if (submitted && !enterSent && stdout.includes('Run the fixture command.')) {
          enterSent = true;
          if (!child.stdin.destroyed) child.stdin.write('\r');
        }
        const turnFinished = cancelling ? cancelledAt !== undefined && stdout.includes('Cancellation requested.') : stdout.includes(finalText);
        if (!finished && turnFinished && chunk.toString().includes('calliope>')) {
          finished = true;
          finishedAt = Date.now();
          // Wait for the idle input frame and acknowledge the exit text too.
          setTimeout(() => {
            if (child.stdin.destroyed) return;
            child.stdin.write('/exit');
          }, 150);
        }
        if (finished && !exitEnterSent && stdout.includes('/exit')) {
          exitEnterSent = true;
          if (!child.stdin.destroyed) child.stdin.write('\r');
        }
      });
      if (cancelling) await cancelWhenReady(() => {
        cancelledAt = Date.now();
        child.stdin.write(decision.endsWith('-ctrl-c') ? '\x03' : '\x1b');
      });
      const [code] = await Promise.race([exited, deadline]);
      assert.equal(code, 0, stdout + stderr);
      assert.ok(submitted && finished, stdout + stderr);
      assert.ok(!stdout.includes('Approve once'), '--auto must skip ordinary confirmation while retaining policy');
      if (cancelling) {
        assert.ok(finishedAt - cancelledAt < 1500, 'Cancellation must return before the late allow or policy deadline');
        assert.ok(!stdout.includes(finalText), 'Cancellation must stop the active turn');
      }
    } else {
      let next = 1; const pending = new Map();
      const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
      const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = next++; pending.set(id, { resolve, reject }); send({ id, method, params });
      });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.method === 'session/request_permission') {
            permissions++; send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
          } else if (message.method === 'fs/write_text_file') {
            assert.equal(message.params.path, marker);
            editorWrites++;
            writeFile(marker, message.params.content).then(() => send({ id: message.id, result: {} }), error => pending.forEach(p => p.reject(error)));
          } else if (pending.has(message.id)) {
            const waiter = pending.get(message.id); pending.delete(message.id);
            if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
          }
        } catch (error) { pending.forEach(p => p.reject(error)); }
      });
      await Promise.race([rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { writeTextFile: true } },
        clientInfo: { name: 'native-policy-fixture', version: '1' } }), deadline]);
      const session = await Promise.race([rpc('session/new', { cwd: project, mcpServers: [] }), deadline]);
      const prompt = rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Run the fixture command.' }] });
      if (cancelling) await cancelWhenReady(() => send({ method: 'session/cancel', params: { sessionId: session.sessionId } }));
      const promptResult = await Promise.race([prompt, deadline]);
      if (cancelling) assert.equal(promptResult.stopReason, 'cancelled');
      assert.equal(editorWrites, outcome === 'allow' ? 1 : 0);
      assert.equal(permissions > 0, outcome === 'allow' || shellCancelling, 'Policy denial must not reach ordinary confirmation');
      child.stdin.end();
      const [code] = await Promise.race([exited, deadline]);
      assert.equal(code, 0, stderr);
      lines.close();
    }
    assert.ok(completions >= (cancelling ? 1 : 2), 'The real tool result must reach the local fixture model');
    assert.equal(existsSync(marker), outcome === 'allow', `Unexpected native ${client} file effect`);
    if (outcome === 'allow') assert.ok((await readFile(marker, 'utf8')).startsWith(args.content));
    if (continuing || cancelling) {
      assert.ok(existsSync(ready), 'Native descendant must have actually started');
      await new Promise(resolve => setTimeout(resolve, 2200));
      assert.equal(existsSync(lateEffect), false, 'Completed policy group must not retain a child that produces later effects');
      if (shellCancelling) assert.equal(existsSync(marker), false, 'Cancelled tool group must not produce a delayed effect');
    }
    if (decision !== 'offline') {
      const calls = (await readFile(inputs, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const tool = calls.find(call => call.name === fixtureCall.function.name);
      assert.deepEqual(tool, { id: fixtureCall.id, name: fixtureCall.function.name, arguments: invocationArgs });
    }
  } finally {
    clearTimeout(timeout);
    if (existsSync(descendantPid)) {
      try { process.kill(Number(await readFile(descendantPid, 'utf8')), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await stop(child);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

for (const client of ['headless', 'acp', 'terminal'])
  for (const decision of ['allow', 'deny', 'timeout', 'offline', 'allow-child', 'deny-child', 'timeout-child', 'cancel', 'cancel-shell', ...(client === 'terminal' ? ['cancel-ctrl-c', 'cancel-shell-ctrl-c'] : [])])
    test(`built ${client}: ${decision} policy controls the real file effect`, { timeout: 30000 }, () => exercise(client, decision));
