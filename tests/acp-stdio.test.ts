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
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, type Client, type SessionNotification } from '@zed-industries/agent-client-protocol';

type ChatMessage = { role: string; content: unknown };
let build: string, root: string, server: Server, port: number;
let requests: { stream?: boolean; messages: ChatMessage[] }[];
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
        res.end(JSON.stringify({ data: [{ id: 'stdio-model', context_length: 32768, max_output_tokens: 1024, capabilities: { chat: true, tools: true, streaming: true } }] }));
        return;
      }
      if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
      const request = JSON.parse(body) as { stream?: boolean; messages: ChatMessage[] };
      requests.push(request);
      const last = request.messages.at(-1)!;
      const reply = last.role === 'tool' ? completion(request.stream, { content: 'Read it.' }, 'stop')
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
function start(project: string) {
  const home = join(root, 'home');
  const child = spawn(process.execPath, [join(build, 'dist', 'bin.js'), 'acp'], {
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
  const client: Client = {
    async sessionUpdate(notification) { updates.push(notification); },
    async requestPermission() { return { outcome: { outcome: 'cancelled' } }; },
    async readTextFile() { throw new Error('fs is not advertised'); },
    async writeTextFile() { throw new Error('fs is not advertised'); },
  };
  const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  const conn = new ClientSideConnection(() => client, stream);
  const exited = new Promise<number | null>(done => child.once('exit', code => done(code)));
  return { child, conn, updates, exited, stderr: () => stderr };
}

it('restores a session with its history in a new process after the first one is killed', async () => {
  requests = [];
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-acp-stdio-')));
  const project = join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(join(project, 'notes.txt'), 'stdio evidence line\n');

  const first = start(project);
  expect((await first.conn.initialize({ protocolVersion: 1, clientCapabilities: {} })).agentCapabilities?.loadSession).toBe(true);
  const { sessionId } = await first.conn.newSession({ cwd: project, mcpServers: [] });
  expect((await first.conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'read notes.txt' }] })).stopReason, first.stderr()).toBe('end_turn');
  expect(requests).toHaveLength(2);
  first.child.kill('SIGKILL');
  await first.exited;

  const second = start(project);
  await second.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
  expect(await second.conn.loadSession({ sessionId, cwd: project, mcpServers: [] })).toEqual({});
  const replay = second.updates.map(update => update.update);
  expect(second.updates.every(update => update.sessionId === sessionId)).toBe(true);
  expect(replay.map(update => update.sessionUpdate)).toEqual(['user_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
  expect(replay[0]).toMatchObject({ content: { type: 'text', text: 'read notes.txt' } });
  expect(replay[1]).toMatchObject({ toolCallId: 'stdio-read', title: 'read_file: notes.txt', kind: 'read' });
  expect(replay[2]).toMatchObject({ toolCallId: 'stdio-read', status: 'completed' });
  expect(JSON.stringify(replay[2])).toContain('stdio evidence line');
  expect(replay[3]).toMatchObject({ content: { type: 'text', text: 'Read it.' } });
  expect(requests).toHaveLength(2);

  expect((await second.conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'what did it say?' }] })).stopReason, second.stderr()).toBe('end_turn');
  const resumed = requests.at(-1)!.messages;
  expect(resumed.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
  expect(JSON.stringify(resumed)).toContain('stdio evidence line');
  expect(second.updates.map(update => update.update).filter(update => update.sessionUpdate === 'agent_message_chunk').at(-1))
    .toMatchObject({ content: { text: 'Continuing after 6 messages.' } });

  second.child.stdin!.end();
  expect(await second.exited).toBe(0);
}, 60000);
