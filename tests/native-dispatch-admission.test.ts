/** Production permission, policy process and filesystem dispatch; only inference
 * is a deterministic fixture. This is not client/wire conformance evidence. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMResponse, ToolCall } from '../src/types.js';
import type { TurnOptions } from '../src/runtime/turn.js';
const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../src/providers/index.js', () => ({ chat }));
import { runTurn } from '../src/runtime/index.js';
import { ApprovalStore, SESSION_GRANT_TTL, describeApproval } from '../src/approvals/index.js';
import * as config from '../src/config.js';
import { scopeManager } from '../src/scope.js';
import { RunLog } from '../src/runlog.js';
import { clearModelCache } from '../src/model-detection.js';

let root: string, policyInputs: string;
const call = (): ToolCall => ({ id: 'native-call', name: 'write_file', arguments: { path: 'effect.txt', content: 'authorized' } });
const response = (tool?: ToolCall): LLMResponse => ({ content: 'fixture', finishReason: tool ? 'tool_use' : 'stop',
  usage: { inputTokens: 1, outputTokens: 1 }, ...(tool ? { toolCalls: [tool] } : {}) });
const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

function policy(code: number): string {
  const script = join(root, `policy-${code}.mjs`);
  writeFileSync(script, `import fs from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;` +
    `fs.appendFileSync(${JSON.stringify(policyInputs)},input+'\\n');process.exit(${code});`);
  return `${shellQuote(process.execPath)} ${shellQuote(script)}`;
}

async function exercise(extra: Partial<TurnOptions> = {}, invocation = call()): Promise<void> {
  chat.mockResolvedValueOnce(response(invocation)).mockResolvedValueOnce(response());
  await runTurn({ sessionId: 'native-session', cwd: root, provider: 'openai', model: 'fixture-model', prompt: 'fixture',
    messages: { current: [{ role: 'user', content: 'fixture' }] }, confirmation: 'none', maxIterations: 2,
    runlog: RunLog.open('native-session', { enabled: false }), ...extra });
}

beforeEach(() => {
  chat.mockReset(); clearModelCache();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-native-admission-')));
  policyInputs = join(root, 'policy-inputs.jsonl');
  config.set('budget', {}); config.set('hooks', { enabled: false }); config.set('sandboxMode', 'off');
  config.set('policy', { command: policy(0) });
  scopeManager.reset(root);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('executes only the exact invocation delivered to the real policy process', async () => {
  await exercise();
  expect(readFileSync(join(root, 'effect.txt'), 'utf8')).toBe('authorized');
  expect(JSON.parse(readFileSync(policyInputs, 'utf8').trim())).toEqual(call());
});

it('a client cannot turn a real policy denial into execution by editing its notification', async () => {
  config.set('policy', { command: policy(1) });
  await exercise({ onPermission: (_call, decision) => { decision.decision = 'allow'; } });
  expect(existsSync(join(root, 'effect.txt'))).toBe(false);
});

it('client tool notifications cannot replace the arguments seen by policy or execution', async () => {
  await exercise({ onToolStart: tool => { tool.arguments.content = 'replacement'; },
    onPermission: tool => { tool.arguments.path = 'replacement.txt'; },
    beforeTool: tool => { tool.arguments.content = 'replacement'; } });
  expect(readFileSync(join(root, 'effect.txt'), 'utf8')).toBe('authorized');
  expect(existsSync(join(root, 'replacement.txt'))).toBe(false);
  expect(JSON.parse(readFileSync(policyInputs, 'utf8').trim())).toEqual(call());
});

it('a model response notification cannot replace the original pending tool invocation', async () => {
  await exercise({ onResponse: model => { if (model.toolCalls?.length) model.toolCalls[0].arguments.content = 'replacement'; } });
  expect(readFileSync(join(root, 'effect.txt'), 'utf8')).toBe('authorized');
  expect(JSON.parse(readFileSync(policyInputs, 'utf8').trim())).toEqual(call());
});

it('policy configuration changed during the final client wait invalidates admission', async () => {
  await exercise({ beforeTool: () => { config.set('policy', { command: policy(1) }); } });
  expect(existsSync(join(root, 'effect.txt'))).toBe(false);
});

it('a project disappearing during the final wait refuses dispatch without recreating it', async () => {
  const original = root;
  let reason = '';
  await exercise({ beforeTool: () => {
    const moved = `${root}-moved`;
    renameSync(root, moved); root = moved;
  }, onToolResult: (_tool, result) => {
    expect(result.isError).toBe(true); reason = result.result;
  } });
  expect(reason).toBe('[resolver] Execution admission could not be validated; tool refused.');
  expect(existsSync(original)).toBe(false);
  expect(existsSync(join(root, 'effect.txt'))).toBe(false);
});

it.each(['expire', 'revoke'] as const)('a reusable approval cannot %s during the final wait and still execute', async action => {
  let now = Date.now();
  const approvals = new ApprovalStore(join(root, 'approvals'), () => now);
  await exercise({ confirmation: 'mutating', approvals, approve: async () => 'allow_session', beforeTool: () => {
    const request = describeApproval(call(), root);
    const grant = approvals.find(request, 'native-session')!;
    expect(grant).toBeDefined();
    if (action === 'expire') now += SESSION_GRANT_TTL;
    else approvals.revoke(request.projectKey, grant.id);
  } });
  expect(existsSync(join(root, 'effect.txt'))).toBe(false);
});

it.each(['session', 'project', 'mode'] as const)('changing %s during a final client wait cannot transfer admission', async change => {
  const otherProject = join(root, 'other-project'); mkdirSync(otherProject);
  const options: Partial<TurnOptions> = { beforeTool: () => {
    if (change === 'session') options.sessionId = 'replacement-session';
    else if (change === 'project') options.cwd = otherProject;
    else options.mode = 'plan';
  } };
  // The runtime receives this same options object so the live client state can change.
  chat.mockResolvedValueOnce(response(call())).mockResolvedValueOnce(response());
  Object.assign(options, { sessionId: 'native-session', cwd: root, provider: 'openai', model: 'fixture-model', prompt: 'fixture',
    messages: { current: [{ role: 'user', content: 'fixture' }] }, confirmation: 'none', maxIterations: 2,
    runlog: RunLog.open('native-session', { enabled: false }) });
  await runTurn(options as TurnOptions);
  expect(existsSync(join(root, 'effect.txt'))).toBe(false);
  expect(existsSync(join(otherProject, 'effect.txt'))).toBe(false);
});

it('cancellation during the final wait cannot produce a native file effect', async () => {
  const controller = new AbortController();
  await exercise({ signal: controller.signal, beforeTool: () => { controller.abort(); } });
  expect(existsSync(join(root, 'effect.txt'))).toBe(false);
});

it('a transient read retry must obtain a new real policy decision before the delegate runs', async () => {
  const script = join(root, 'policy-retry.mjs');
  writeFileSync(script, `import fs from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;` +
    `const path=${JSON.stringify(policyInputs)};const retry=fs.existsSync(path);fs.appendFileSync(path,input+'\\n');process.exit(retry?1:0);`);
  config.set('policy', { command: `${shellQuote(process.execPath)} ${shellQuote(script)}` });
  writeFileSync(join(root, 'read.txt'), 'source');
  const calls = join(root, 'delegate-calls');
  await exercise({ maxRetries: 1, toolOptions: { fs: { readTextFile: async () => {
    writeFileSync(calls, existsSync(calls) ? 'called-twice' : 'called-once');
    throw new Error('ETIMEDOUT: transient reader timeout');
  } } } }, { id: 'native-call', name: 'read_file', arguments: { path: 'read.txt' } });
  expect(readFileSync(calls, 'utf8')).toBe('called-once');
  const inputs = readFileSync(policyInputs, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toEqual(inputs[1]);
});
