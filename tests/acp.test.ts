/**
 * ACP agent conformance tests (#190).
 *
 * Drives the official ACP SDK's ClientSideConnection against Calliope's
 * `serveAcp` agent over an in-memory duplex stream pair — fully in-process, no
 * editor, no subprocess. The provider (`chat`) and tool runtime (`executeTool`)
 * are mocked so turns are deterministic; the SDK's real JSON-RPC plumbing,
 * capability negotiation, session lifecycle, permission flow, and zod validation
 * of every notification are exercised for real.
 *
 * os.homedir is redirected to a temp dir so the audit run log lands under tmp.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tmpHome } = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'calliope-acp-test-'));
  return { tmpHome: dir };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 10;
    if (key === 'defaultProvider') return 'anthropic';
    if (key === 'defaultModel') return 'claude-sonnet-4-6';
    // audit / policy / hooks all default (undefined) → audit on, policy off.
    return undefined;
  }),
  getConfig: vi.fn(() => ({ defaultProvider: 'anthropic' })),
}));

const mockChat = vi.fn();
const mockExecuteTool = vi.fn();

vi.mock('../src/providers/index.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  selectProvider: (p: string) => (p && p !== 'auto' ? p : 'anthropic'),
}));

vi.mock('../src/tools.js', () => ({
  TOOLS: [],
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
  getTools: vi.fn(() => []),
}));

vi.mock('../src/memory.js', () => ({ buildMemoryContext: vi.fn(() => '') }));

vi.mock('../src/local-model.js', () => ({
  getSystemPromptForProvider: vi.fn(() => 'system'),
  isLocalBackend: vi.fn(() => false),
}));

import * as fs from 'fs';
import * as path from 'path';
import {
  ClientSideConnection,
  type Client,
  type Agent,
  type Stream,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type ClientCapabilities,
} from '@zed-industries/agent-client-protocol';
import { serveAcp } from '../src/acp.js';
import { readRunLog, verifyChain, resetRunLogs, type RunLogLine } from '../src/runlog.js';
import type { ToolCall } from '../src/types.js';

const RUNS_DIR = path.join(tmpHome, '.calliope-cli', 'runs');

// ---------------------------------------------------------------------------
// In-memory transport + test client
// ---------------------------------------------------------------------------

/** A pair of AnyMessage-level streams wired agent<->client (no byte encoding). */
function streamPair(): { agentStream: Stream; clientStream: Stream } {
  const a2c = new TransformStream();
  const c2a = new TransformStream();
  return {
    agentStream: { readable: c2a.readable as Stream['readable'], writable: a2c.writable as Stream['writable'] },
    clientStream: { readable: a2c.readable as Stream['readable'], writable: c2a.writable as Stream['writable'] },
  };
}

class TestClient implements Client {
  updates: SessionNotification[] = [];
  permissionRequests: RequestPermissionRequest[] = [];
  /** How to answer a permission request; default: allow once. */
  permissionResponder: (req: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: 'selected', optionId: 'allow' },
  });
  /** Editor buffers for fs delegation, keyed by absolute path. */
  buffers = new Map<string, string>();
  fsReads: string[] = [];
  fsWrites: { path: string; content: string }[] = [];

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
  }
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(params);
    return this.permissionResponder(params);
  }
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.fsReads.push(params.path);
    if (!this.buffers.has(params.path)) throw new Error(`no buffer for ${params.path}`);
    return { content: this.buffers.get(params.path)! };
  }
  async writeTextFile(params: WriteTextFileRequest): Promise<Record<string, never>> {
    this.fsWrites.push({ path: params.path, content: params.content });
    this.buffers.set(params.path, params.content);
    return {};
  }

  updatesOf(type: string): SessionNotification['update'][] {
    return this.updates.filter((u) => u.update.sessionUpdate === type).map((u) => u.update);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}
async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error('waitFor: condition never became true');
}

/** Spin up an agent + connected test client over an in-memory pair. */
function connect(): { client: TestClient; conn: ClientSideConnection; agent: ReturnType<typeof serveAcp> } {
  const { agentStream, clientStream } = streamPair();
  const agent = serveAcp(agentStream);
  const client = new TestClient();
  const conn = new ClientSideConnection((_agent: Agent) => client, clientStream);
  return { client, conn, agent };
}

async function handshake(
  conn: ClientSideConnection,
  clientCapabilities: ClientCapabilities = {},
): Promise<void> {
  await conn.initialize({ protocolVersion: 1, clientCapabilities });
}

async function newSession(conn: ClientSideConnection, cwd = tmpHome): Promise<string> {
  const res = await conn.newSession({ cwd, mcpServers: [] });
  return res.sessionId;
}

// A scripted chat response.
interface ChatStep {
  stream?: string[];
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
}

function scriptChat(steps: ChatStep[]): void {
  let i = 0;
  mockChat.mockImplementation(async (_p: unknown, _m: unknown, _t: unknown, _model: unknown, onToken?: (t: string) => void) => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (step.stream && onToken) for (const t of step.stream) onToken(t);
    return {
      content: step.content ?? (step.stream ? step.stream.join('') : ''),
      toolCalls: step.toolCalls ?? [],
      finishReason: step.finishReason ?? (step.toolCalls?.length ? 'tool_use' : 'stop'),
      usage: { inputTokens: 7, outputTokens: 3 },
    };
  });
}

beforeEach(() => {
  mockChat.mockReset();
  mockExecuteTool.mockReset();
  mockExecuteTool.mockResolvedValue({ toolCallId: 't', result: 'ok', isError: false });
  resetRunLogs();
});

afterEach(() => {
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
});

// ===========================================================================
// initialize / capability negotiation
// ===========================================================================

describe('initialize', () => {
  it('negotiates protocol v1 and advertises the baseline capabilities', async () => {
    const { conn } = connect();
    const res = await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });

    expect(res.protocolVersion).toBe(1);
    expect(res.agentCapabilities?.loadSession).toBe(false);
    expect(res.agentCapabilities?.promptCapabilities).toEqual({ image: false, audio: false, embeddedContext: false });
    expect(res.authMethods).toEqual([]);
  });

  it('clamps an unsupported (newer) protocol version down to what it supports', async () => {
    const { conn } = connect();
    const res = await conn.initialize({ protocolVersion: 99, clientCapabilities: {} });
    expect(res.protocolVersion).toBe(1);
  });
});

// ===========================================================================
// session/new + session/prompt happy path
// ===========================================================================

describe('session/new + session/prompt', () => {
  it('creates a session whose id round-trips and drives a text + tool-call turn', async () => {
    const { client, conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);
    expect(sessionId).toMatch(/^acp_/);

    mockExecuteTool.mockResolvedValue({ toolCallId: 'c1', result: 'FILE BODY', isError: false });
    scriptChat([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }] },
      { stream: ['All ', 'done'] },
    ]);

    const res = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'read a.txt' }] });
    await settle();

    expect(res.stopReason).toBe('end_turn');

    // The tool ran (read_file is read-only → no permission needed).
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    const toolCall = mockExecuteTool.mock.calls[0][0] as ToolCall;
    expect(toolCall.name).toBe('read_file');

    // A tool_call announcement, a completed update carrying the result, and the
    // streamed assistant text all reached the client.
    const toolCalls = client.updatesOf('tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolCallId: 'c1', title: 'read_file: a.txt', kind: 'read', status: 'pending' });

    const completed = client.updatesOf('tool_call_update').find((u) => (u as { status?: string }).status === 'completed');
    expect(JSON.stringify(completed)).toContain('FILE BODY');

    const chunks = client.updatesOf('agent_message_chunk');
    const streamed = chunks.map((c) => (c as { content: { text: string } }).content.text).join('');
    expect(streamed).toBe('All done');
  });

  it('emits the session/update events in a sane order', async () => {
    const { client, conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);

    scriptChat([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'final' },
    ]);

    await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    await settle();

    const seq = client.updates.map((u) => {
      const up = u.update as { sessionUpdate: string; status?: string };
      return up.status ? `${up.sessionUpdate}:${up.status}` : up.sessionUpdate;
    });
    expect(seq).toEqual([
      'tool_call:pending',
      'tool_call_update:in_progress',
      'tool_call_update:completed',
      'agent_message_chunk',
    ]);
  });

  it('reports max_turn_requests when the iteration budget is exhausted', async () => {
    const { conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);

    // Always ask for another tool call → never terminates on its own.
    scriptChat([{ toolCalls: [{ id: 'loop', name: 'read_file', arguments: { path: 'a.txt' } }] }]);

    const res = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'spin' }] });
    expect(res.stopReason).toBe('max_turn_requests');
  });
});

// ===========================================================================
// permission flow
// ===========================================================================

describe('session/request_permission', () => {
  it('asks for permission on a mutating tool and runs it when granted', async () => {
    const { client, conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);

    client.permissionResponder = () => ({ outcome: { outcome: 'selected', optionId: 'allow' } });
    mockExecuteTool.mockResolvedValue({ toolCallId: 'w1', result: 'wrote', isError: false });
    scriptChat([
      { toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } }] },
      { content: 'done' },
    ]);

    const res = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'write out.txt' }] });
    await settle();

    expect(res.stopReason).toBe('end_turn');
    expect(client.permissionRequests).toHaveLength(1);
    expect(client.permissionRequests[0].toolCall.toolCallId).toBe('w1');
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    const completed = client.updatesOf('tool_call_update').find((u) => (u as { status?: string }).status === 'completed');
    expect(completed).toBeDefined();
  });

  it('does NOT run the tool when permission is rejected', async () => {
    const { client, conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);

    client.permissionResponder = () => ({ outcome: { outcome: 'selected', optionId: 'reject' } });
    scriptChat([
      { toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } }] },
      { content: 'ok anyway' },
    ]);

    const res = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'write out.txt' }] });
    await settle();

    expect(res.stopReason).toBe('end_turn');
    expect(client.permissionRequests).toHaveLength(1);
    expect(mockExecuteTool).not.toHaveBeenCalled();
    const failed = client.updatesOf('tool_call_update').find((u) => (u as { status?: string }).status === 'failed');
    expect(JSON.stringify(failed)).toContain('Permission denied');
  });

  it('reads are allowed without asking for permission', async () => {
    const { client, conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);

    mockExecuteTool.mockResolvedValue({ toolCallId: 'r1', result: 'body', isError: false });
    scriptChat([
      { toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);

    await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'read' }] });
    await settle();

    expect(client.permissionRequests).toHaveLength(0);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// session/cancel
// ===========================================================================

describe('session/cancel', () => {
  it('aborts an in-flight turn and returns stopReason cancelled', async () => {
    const { conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);

    let started = false;
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    mockChat.mockImplementationOnce(async () => {
      started = true;
      await blocked;
      return { content: 'too late', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const promptPromise = conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'long task' }] });
    await waitFor(() => started); // chat is now blocking mid-turn
    await conn.cancel({ sessionId });
    // The agent processes stream messages in order, so a request sent AFTER the
    // cancel notification only resolves once the cancel was already handled —
    // deterministic, no reliance on timer settling.
    await conn.authenticate({ methodId: 'noop' });
    release();

    const res = await promptPromise;
    expect(res.stopReason).toBe('cancelled');
  });
});

// ===========================================================================
// fs delegation threading (advertised vs not)
// ===========================================================================

describe('fs capability delegation', () => {
  it('threads a client fs delegate into executeTool when fs is advertised', async () => {
    const { conn } = connect();
    await handshake(conn, { fs: { readTextFile: true, writeTextFile: true } });
    const sessionId = await newSession(conn);

    scriptChat([
      { toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);
    await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'read' }] });
    await settle();

    const opts = mockExecuteTool.mock.calls[0][4] as { fs?: { readTextFile?: unknown; writeTextFile?: unknown } };
    expect(opts.fs).toBeDefined();
    expect(typeof opts.fs?.readTextFile).toBe('function');
    expect(typeof opts.fs?.writeTextFile).toBe('function');
  });

  it('the threaded delegate actually calls back to the client filesystem', async () => {
    const { client, conn } = connect();
    await handshake(conn, { fs: { readTextFile: true, writeTextFile: true } });
    const sessionId = await newSession(conn);
    const abs = path.join(tmpHome, 'buf.txt');
    client.buffers.set(abs, 'FROM EDITOR BUFFER');

    // A real-ish executeTool that consults the supplied fs delegate.
    mockExecuteTool.mockImplementation(async (tc: ToolCall, _cwd: string, _to: number, _o: unknown, options: { fs?: { readTextFile?: (p: string) => Promise<string> } }) => {
      const content = await options.fs!.readTextFile!(abs);
      return { toolCallId: tc.id, result: content, isError: false };
    });
    scriptChat([
      { toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'buf.txt' } }] },
      { content: 'done' },
    ]);

    await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'read buf' }] });
    await settle();

    expect(client.fsReads).toContain(abs);
    const completed = client.updatesOf('tool_call_update').find((u) => (u as { status?: string }).status === 'completed');
    expect(JSON.stringify(completed)).toContain('FROM EDITOR BUFFER');
  });

  it('passes no fs delegate when the client does not advertise fs', async () => {
    const { conn } = connect();
    await handshake(conn, {}); // no fs capability
    const sessionId = await newSession(conn);

    scriptChat([
      { toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);
    await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'read' }] });
    await settle();

    const opts = mockExecuteTool.mock.calls[0][4] as { fs?: unknown };
    expect(opts.fs).toBeUndefined();
  });
});

// ===========================================================================
// edge cases + lifecycle
// ===========================================================================

describe('edge cases', () => {
  it('rejects a prompt for an unknown session', async () => {
    const { conn } = connect();
    await handshake(conn);
    await expect(conn.prompt({ sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] })).rejects.toThrow();
  });

  it('surfaces a provider error as a JSON-RPC error from prompt', async () => {
    const { conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);
    mockChat.mockRejectedValueOnce(new Error('provider exploded'));
    await expect(conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })).rejects.toThrow();
  });

  it('maps a length finish reason to stopReason max_tokens', async () => {
    const { conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);
    scriptChat([{ content: 'truncated', finishReason: 'length' }]);
    const res = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    expect(res.stopReason).toBe('max_tokens');
  });

  it('flattens resource_link and embedded resource blocks into the prompt text', async () => {
    const { conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);
    let captured: { role: string; content: string }[] = [];
    mockChat.mockImplementation(async (_p: unknown, messages: { role: string; content: string }[]) => {
      captured = messages;
      return { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    await conn.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'look at' },
        { type: 'resource_link', uri: 'file:///x.ts', name: 'x.ts' },
        { type: 'resource', resource: { uri: 'file:///y.ts', text: 'inline body', mimeType: 'text/plain' } },
      ],
    });
    const userMsg = captured.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('look at');
    expect(userMsg?.content).toContain('@file:///x.ts');
    expect(userMsg?.content).toContain('inline body');
  });

  it('denies a mutating tool when the client cannot handle permission requests', async () => {
    const { client, conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);
    client.permissionResponder = () => {
      throw new Error('permission not supported');
    };
    scriptChat([
      { toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'x' } }] },
      { content: 'moving on' },
    ]);
    const res = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'write' }] });
    await settle();
    expect(res.stopReason).toBe('end_turn');
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('treats a cancelled permission outcome as turn cancellation', async () => {
    const { client, conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);
    client.permissionResponder = () => ({ outcome: { outcome: 'cancelled' } });
    scriptChat([{ toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'o.txt', content: 'x' } }] }]);
    const res = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'write' }] });
    expect(res.stopReason).toBe('cancelled');
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('shutdown() closes the audit trace with a run_end', async () => {
    const { conn, agent } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);
    scriptChat([{ content: 'done' }]);
    await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    await settle();
    await agent.shutdown();

    const lines = readRunLog(path.join(RUNS_DIR, `${sessionId}.jsonl`));
    expect(lines.some((l) => l.type === 'run_end')).toBe(true);
    expect(verifyChain(lines).ok).toBe(true);
  });
});

// ===========================================================================
// audit trail
// ===========================================================================

describe('audit run log', () => {
  it('writes an audit trace tagged mode: acp with a valid hash chain', async () => {
    const { conn } = connect();
    await handshake(conn);
    const sessionId = await newSession(conn);

    mockExecuteTool.mockResolvedValue({ toolCallId: 'c1', result: 'body', isError: false });
    scriptChat([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } }] },
      { content: 'done' },
    ]);
    await conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'read a.txt' }] });
    await settle();

    const file = path.join(RUNS_DIR, `${sessionId}.jsonl`);
    const lines: RunLogLine[] = readRunLog(file);

    const runStart = lines.find((l) => l.type === 'run_start');
    expect(runStart).toBeDefined();
    expect((runStart as { mode?: string }).mode).toBe('acp');
    expect(lines.some((l) => l.type === 'user_prompt')).toBe(true);
    expect(lines.some((l) => l.type === 'tool_call')).toBe(true);
    expect(lines.some((l) => l.type === 'tool_result')).toBe(true);
    expect(verifyChain(lines).ok).toBe(true);
  });
});
