/**
 * ACP session/load over real stdio (#377): the host-restart case end to end.
 *
 * Compiles today's source into an isolated package, runs `calliope acp` as a
 * child process with a private HOME and config store, and drives it with the
 * official SDK client over NDJSON pipes. Inference comes from a local
 * OpenAI-compatible fake; the read_file tool runs for real. The first process is
 * killed after its turn, and a second process must restore the session from disk.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ReservationLedger, manifestHash, createLedgerServer, LedgerServerState, mintLedgerToken, type ChildGrant } from '../src/execution/index.js';
import { executionManifest } from './helpers/execution-manifest.js';
import { projectIdentity } from '../src/approvals/index.js';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client as createClient, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';

type ChatMessage = { role: string; content: unknown };
let build: string, root: string, server: Server, port: number;
let requests: { stream?: boolean; model?: string; messages: ChatMessage[] }[];
const children: ChildProcess[] = [];

function completion(stream: boolean | undefined, delta: Record<string, unknown>, finish: string): { type: string; body: string } {
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  if (!stream) {
    const message = { role: 'assistant', content: delta.content ?? null, ...(delta.tool_calls ? { tool_calls: delta.tool_calls } : {}) };
    return { type: 'application/json', body: JSON.stringify({ id: 'stdio', object: 'chat.completion', model: 'stdio-model', choices: [{ index: 0, message, finish_reason: finish }], usage }) };
  }
  const chunks = [
    { id: 'stdio', object: 'chat.completion.chunk', model: 'stdio-model', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
    { id: 'stdio', object: 'chat.completion.chunk', model: 'stdio-model', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
  ];
  return { type: 'text/event-stream', body: chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n' };
}

beforeAll(async () => {
  build = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-acp-stdio-build-')));
  execFileSync(resolve('node_modules/.bin/tsc'), ['--outDir', join(build, 'dist'), '--incremental', 'false'], { cwd: process.cwd(), timeout: 60000, stdio: 'pipe' });
  fs.writeFileSync(join(build, 'package.json'), '{"type":"module"}');
  fs.symlinkSync(resolve('node_modules'), join(build, 'node_modules'), 'junction');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: ['stdio-model','stdio-model-b'].map(id=>({ id, context_length: 32768, max_output_tokens: 8192, pricing: { input: 1, output: 2 }, capabilities: { chat: true, tools: true, streaming: true } })) }));
        return;
      }
      if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
      const request = JSON.parse(body) as { stream?: boolean; messages: ChatMessage[] };
      requests.push(request);
      const last = request.messages.at(-1)!;
      const reply = last.role === 'tool' ? completion(request.stream, { content: 'Read it.' }, 'stop')
        : last.content === 'write notes.txt'
          ? completion(request.stream, { tool_calls: [{ index: 0, id: 'stdio-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes.txt', content: 'approved edit' }) } }] }, 'tool_calls')
        : last.content === 'read notes.txt'
          ? completion(request.stream, { tool_calls: [{ index: 0, id: 'stdio-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) } }] }, 'tool_calls')
          : completion(request.stream, { content: `Continuing after ${request.messages.length} messages.` }, 'stop');
      res.writeHead(200, { 'content-type': reply.type });
      res.end(reply.body);
    });
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  port = (server.address() as { port: number }).port;
}, 90000);

afterAll(async () => {
  await new Promise<void>(closed => server.close(() => closed()));
  fs.rmSync(build, { recursive: true, force: true });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(done => child.once('exit', () => done()));
      child.kill('SIGKILL');
      await stopped;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Start `calliope acp` the way an agent host does: stdio pipes, logs on stderr. */
function start(project: string, args: string[] = []) {
  const home = join(root, 'home');
  const child = spawn(process.execPath, [join(build, 'dist', 'bin.js'), 'acp', ...args], {
    cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, CALLIOPE_CONFIG_DIR: join(home, 'config'),
      CALLIOPE_PROVIDER: 'deepseek', CALLIOPE_MODEL: 'stdio-model',
      DEEPSEEK_API_KEY: 'stdio-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
    },
  });
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const updates: SessionNotification[] = [];
  const client = {
    async sessionUpdate(notification: SessionNotification) { updates.push(notification); },
    async requestPermission() { return { outcome: { outcome: 'cancelled' } }; },
    async readTextFile() { throw new Error('fs is not advertised'); },
    async writeTextFile() { throw new Error('fs is not advertised'); },
  };
  const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  const conn = createClient()
    .onNotification('session/update', ({params}) => client.sessionUpdate(params))
    .onRequest('session/request_permission', () => client.requestPermission())
    .onRequest('fs/read_text_file', () => client.readTextFile())
    .onRequest('fs/write_text_file', () => client.writeTextFile())
    .connect(stream);
  const exited = new Promise<number | null>(done => child.once('close', code => done(code)));
  return { child, conn, client, updates, exited, stderr: () => stderr };
}

it('restores a session with its history in a new process after the first one is killed', async () => {
  requests = [];
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-acp-stdio-')));
  const project = join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(join(project, 'notes.txt'), 'stdio evidence line\n');

  const first = start(project);
  expect((await first.conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} })).agentCapabilities?.loadSession).toBe(true);
  const { sessionId } = await first.conn.agent.request('session/new', { cwd: project, mcpServers: [] });
  expect((await first.conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read notes.txt' }] })).stopReason, first.stderr() + JSON.stringify(first.updates)).toBe('end_turn');
  expect(requests).toHaveLength(2);
  first.child.kill('SIGKILL');
  await first.exited;

  const second = start(project);
  await second.conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  expect(await second.conn.agent.request('session/load', { sessionId, cwd: project, mcpServers: [] })).toMatchObject({modes:{currentModeId:'work'},configOptions:[{id:'model',currentValue:'default'}]});
  const replay = second.updates.map(update => update.update);
  expect(second.updates.every(update => update.sessionId === sessionId)).toBe(true);
  expect(replay.map(update => update.sessionUpdate)).toEqual(['user_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
  expect(replay[0]).toMatchObject({ content: { type: 'text', text: 'read notes.txt' } });
  expect(replay[1]).toMatchObject({ toolCallId: 'stdio-read', title: 'read_file: notes.txt', kind: 'read' });
  expect(replay[2]).toMatchObject({ toolCallId: 'stdio-read', status: 'completed' });
  expect(JSON.stringify(replay[2])).toContain('stdio evidence line');
  expect(replay[3]).toMatchObject({ content: { type: 'text', text: 'Read it.' } });
  expect(requests).toHaveLength(2);

  expect((await second.conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'what did it say?' }] })).stopReason, second.stderr()).toBe('end_turn');
  const resumed = requests.at(-1)!.messages;
  expect(resumed.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
  expect(JSON.stringify(resumed)).toContain('stdio evidence line');
  expect(second.updates.map(update => update.update).filter(update => update.sessionUpdate === 'agent_message_chunk').at(-1))
    .toMatchObject({ content: { text: 'Continuing after 6 messages.' } });

  second.child.stdin!.end();
  expect(await second.exited).toBe(0);
}, 60000);

it('retains selected model and plan mode across real process restart without allowing writes', async () => {
  requests=[];
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-acp-controls-')));
  const project=join(root,'project');fs.mkdirSync(project);
  const first=start(project);await first.conn.agent.request('initialize',{protocolVersion:1,clientCapabilities:{}});
  const {sessionId}=await first.conn.agent.request('session/new',{cwd:project,mcpServers:[]});
  await first.conn.agent.request('session/set_config_option',{sessionId,configId:'model',value:'model:stdio-model-b'});
  await first.conn.agent.request('session/set_mode',{sessionId,modeId:'plan'});
  let approvals=0;
  first.client.requestPermission=async()=>{approvals++;return {outcome:{outcome:'selected',optionId:'allow'}};};
  expect((await first.conn.agent.request('session/prompt',{sessionId,prompt:[{type:'text',text:'write notes.txt'}]})).stopReason).toBe('end_turn');
  expect(approvals).toBe(0);expect(fs.existsSync(join(project,'notes.txt'))).toBe(false);
  expect(requests).toHaveLength(2);expect(requests.every(request=>request.model==='stdio-model-b')).toBe(true);
  first.child.kill('SIGKILL');await first.exited;
  const second=start(project);await second.conn.agent.request('initialize',{protocolVersion:1,clientCapabilities:{}});
  expect(await second.conn.agent.request('session/load',{sessionId,cwd:project,mcpServers:[]})).toMatchObject({modes:{currentModeId:'plan'},configOptions:[{id:'model',currentValue:'model:stdio-model-b'}]});
  second.client.requestPermission=async()=>({outcome:{outcome:'selected',optionId:'allow'}});
  await second.conn.agent.request('session/set_mode',{sessionId,modeId:'work'});
  expect((await second.conn.agent.request('session/prompt',{sessionId,prompt:[{type:'text',text:'write notes.txt'}]})).stopReason).toBe('end_turn');
  expect(fs.readFileSync(join(project,'notes.txt'),'utf8')).toBe('approved edit');
  expect(requests.at(-1)?.model).toBe('stdio-model-b');
  second.child.stdin!.end();expect(await second.exited).toBe(0);
},60000);


it('retains the parent account, workspace, history and spent allowance over a native ACP process restart', async () => {
  requests = [];
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-acp-delegated-')));
  const project = join(root, 'source'), copy = join(root, 'copy');
  for (const directory of [project, copy]) fs.mkdirSync(directory);
  fs.writeFileSync(join(copy, 'notes.txt'), 'delegated evidence');
  fs.writeFileSync(join(copy, 'README.md'), 'allowed automatic context');
  fs.writeFileSync(join(copy, 'CALLIOPE.md'), '## Context\n- DENIED automatic context\n');
  const home = join(root, 'home'); fs.mkdirSync(join(home, '.calliope-cli'), { recursive: true });
  fs.writeFileSync(join(home, '.calliope-cli', 'trusted-projects.json'), JSON.stringify({ [copy]: { trusted: true, addedAt: new Date().toISOString() } }));
  const manifest = executionManifest(project);
  manifest.deadline = Date.now() + 120000;
  manifest.tokenBudget = 300000; manifest.costBudgetNanos = 1000000000;
  for (const account of manifest.accounts) account.deadline = manifest.deadline;
  Object.assign(manifest.accounts[0]!, { tokenBudget: manifest.tokenBudget, costBudgetNanos: manifest.costBudgetNanos });
  const ledger = new ReservationLedger(join(root, 'budget')); ledger.create(manifest);
  const hash = manifestHash(manifest), state = new LedgerServerState(join(root, 'ledger-server'));
  const token = mintLedgerToken(state.secret(), { v: 1, run: manifest.runId, role: 'parent', exp: manifest.deadline });
  const service = createLedgerServer({ ledger, cwd: project, state });
  await new Promise<void>(ready => service.listen(0, '127.0.0.1', ready));
  const url = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
  try {
    const identity = projectIdentity(copy);
    const grant: ChildGrant = { version: 2, project: { root: identity.project, key: identity.projectKey },
      id: randomUUID(), proposalHash: 'b'.repeat(64), previousGraphHash: manifest.planHash,
      planHash: 'c'.repeat(64), runManifestHash: 'd'.repeat(64), approvalRevision: randomUUID(), parentId: 'root',
      accounts: ['child', 'sibling'].map(id => ({ ...manifest.accounts[1]!, id, parentId: 'root', tokenBudget: 100000, costBudgetNanos: 100000000,
        allowedPaths: [{ path: 'notes.txt', access: 'write' as const }, { path: 'README.md', access: 'read' as const }] })) };
    const response = await fetch(`${url}/v1/grant`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ manifestHash: hash, grant }) });
    const grantResponse = await response.json() as { token: string };
    expect(response.ok, JSON.stringify(grantResponse)).toBe(true);
    const childToken = grantResponse.token, file = join(root, 'child.token');
    fs.writeFileSync(file, childToken, { mode: 0o600 });
    const args = ['--ledger-url', url, '--ledger-token-file', file, '--ledger-agent', 'child'];
    const first = start(copy, args);
    const init = await first.conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    expect(init.agentCapabilities?._meta).toMatchObject({ calliopeDelegation: { version: 1, workspaceBinding: 1, sessionBinding: 1 } });
    await expect(first.conn.agent.request('session/new', { cwd: project, mcpServers: [] })).rejects.toMatchObject({ code: -32602 });
    const { sessionId } = await first.conn.agent.request('session/new', { cwd: copy, mcpServers: [] });
    await expect(first.conn.agent.request('session/set_config_option',{sessionId,configId:'model',value:'model:stdio-model-b'})).rejects.toMatchObject({code:-32602});
    expect(requests).toHaveLength(0);
    await first.conn.agent.request('session/set_mode',{sessionId,modeId:'plan'});
    await first.conn.agent.request('session/set_mode',{sessionId,modeId:'work'});
    expect((await first.conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read notes.txt' }] })).stopReason, first.stderr() + JSON.stringify(first.updates)).toBe('end_turn');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).toContain('allowed automatic context');
    expect(JSON.stringify(requests)).not.toContain('DENIED automatic context');
    expect(ledger.read(project).projection.accounts.child!.tokens).toBe(24);
    first.child.kill('SIGKILL'); await first.exited;

    // A plain process and a different valid account both refuse the retained session.
    for (const options of [[], [...args.slice(0, -1), 'sibling']]) {
      const denied = start(copy, options);
      await denied.conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      await expect(denied.conn.agent.request('session/load', { sessionId, cwd: copy, mcpServers: [] })).rejects.toMatchObject({ code: -32602 });
      expect(denied.updates).toEqual([]);
      denied.child.stdin!.end(); expect(await denied.exited, denied.stderr()).toBe(0);
    }
    expect(requests).toHaveLength(2);
    const second = start(copy, args);
    await second.conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    expect(await second.conn.agent.request('session/load', { sessionId, cwd: copy, mcpServers: [] })).toMatchObject({modes:{currentModeId:'work'},configOptions:[{id:'model',currentValue:'default'}]});
    expect((await second.conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'continue' }] })).stopReason, second.stderr()).toBe('end_turn');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain('delegated evidence');
    const spent = ledger.read(project);
    expect(spent.projection.accounts.child!.tokens).toBe(36);
    expect(spent.projection.accounts.root!.tokens).toBe(36);
    expect(spent.manifest).toEqual(manifest);

    // Delegation retains native one-time permissions and cancellation.
    second.client.requestPermission = async () => ({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect((await second.conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write notes.txt' }] })).stopReason).toBe('end_turn');
    expect(fs.readFileSync(join(copy, 'notes.txt'), 'utf8')).toBe('delegated evidence');
    second.client.requestPermission = async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } });
    expect((await second.conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write notes.txt' }] })).stopReason).toBe('end_turn');
    expect(fs.readFileSync(join(copy, 'notes.txt'), 'utf8')).toBe('approved edit');
    let notifyPermission!: () => void;
    const permissionReady = new Promise<void>(ready => { notifyPermission = ready; });
    let resolvePermission!: (value: import('@zed-industries/agent-client-protocol').RequestPermissionResponse) => void;
    second.client.requestPermission = async () => { notifyPermission(); return new Promise(resolve => { resolvePermission = resolve; }); };
    const pending = second.conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write notes.txt' }] });
    await permissionReady;
    await second.conn.agent.notify('session/cancel', { sessionId });
    expect((await pending).stopReason).toBe('cancelled');
    resolvePermission({ outcome: { outcome: 'selected', optionId: 'allow' } });
    const requestsBeforeExhaustion = requests.length;
    expect(requestsBeforeExhaustion).toBe(8);
    const charged = ledger.read(project).projection.accounts.child!.tokens;
    expect(charged).toBe(96);

    // Pending work consumes the remaining allowance. Continuing cannot mint another.
    await ledger.reserve(project, hash, { id: randomUUID(), agentId: 'child', provider: 'deepseek', model: 'stdio-model', target: 'a'.repeat(64), inputTokens: 100000 - charged - 1, outputTokens: 1, inputPrice: 0, outputPrice: 0, costNanos: 0 });
    expect((await second.conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'exhausted' }] })).stopReason, second.stderr()).toBe('refusal');
    expect(requests).toHaveLength(requestsBeforeExhaustion);
    expect(ledger.read(project).projection.accounts.child!.tokens).toBe(100000);
    second.child.stdin!.end(); expect(await second.exited, second.stderr()).toBe(0);
  } finally { await new Promise<void>(done => service.close(() => done())); }
}, 60000);


it.each([
  ['--ledger-agent', 'child'],
  ['--ledger-url=x', '--ledger-token-file=y', '--ledger-agent=z'],
  ['--ledger-agent', 'child', '--ledger-agent', 'sibling'],
].map(args => ({ args })))('rejects malformed ACP delegation arguments before protocol or inference: $args', async ({ args }) => {
  requests = [];
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-acp-bad-args-')));
  const child = start(root, args);
  expect(await child.exited, child.stderr()).toBe(2);
  expect(requests).toEqual([]);
  expect(child.updates).toEqual([]);
});
