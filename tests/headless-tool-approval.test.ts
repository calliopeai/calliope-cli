import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const chat = vi.fn();
const realFetch = globalThis.fetch;

import { runHeadless, type HeadlessOptions, type HeadlessToolApprovalRequest } from '../src/headless.js';
import * as config from '../src/config.js';
import { projectIdentity } from '../src/approvals/index.js';
import { ReservationLedger, LedgerServerState, createLedgerServer, mintLedgerToken,
  taskWorkspaceLedgerAuthority, RemoteReservationLedger, manifestHash,
  type ExecutionManifest, type TaskRequestAttribution } from '../src/execution/index.js';
import { executionBinding } from '../src/execution/delegated.js';
import { clearModelCache } from '../src/model-detection.js';
import { saveHooks } from '../src/hooks.js';
import * as hooks from '../src/hooks.js';
import { readSessionConversation, saveSessionConversation } from '../src/storage.js';
import type { ToolCall } from '../src/types.js';

let root: string, project: string, workspace: string, server: Server;
let ledger: ReservationLedger, manifest: ExecutionManifest, options: HeadlessOptions;
let call: ToolCall, executed: ToolCall[];
let output: string, active: boolean;
const identity = (cwd: string) => { const p = projectIdentity(cwd); return { root: p.project, key: p.projectKey }; };
const completion = (tool?: ToolCall) => Response.json({ id: 'public-approval-fixture', object: 'chat.completion', model: 'public-approval-fixture',
  choices: [{ index: 0, message: { role: 'assistant', content: tool ? 'Working.' : 'Done.',
    ...(tool ? { tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : {}) },
    finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });

beforeEach(async () => {
  config.resetConfig(); clearModelCache(); saveHooks([]); chat.mockReset(); executed = []; output = ''; active = true;
  for (const provider of config.getProviderNames()) {
    const names = config.getProviderEnvVars(provider);
    for (const name of [names.apiKey, names.baseUrl]) if (name) vi.stubEnv(name, '');
  }
  config.setProviderCred('deepseek', { apiKey: 'public-synthetic-fixture', baseUrl: 'https://approval.invalid/v1' });
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-headless-approval-'))); fs.chmodSync(root, 0o700);
  project = join(root, 'authority'); workspace = join(root, 'checkout'); fs.mkdirSync(project); fs.mkdirSync(workspace);
  const now = Date.now(), deadline = now + 60000;
  manifest = { version: 1, runId: randomUUID(), planHash: 'a'.repeat(64), project: identity(project),
    createdAt: now, deadline, tokenBudget: 200000, costBudgetNanos: 1000000000,
    accounts: [{ id: 'worker', parentId: null, deadline, tokenBudget: 200000, costBudgetNanos: 1000000000,
      allowedTools: ['write_file', 'shell'], allowedPaths: [{ path: '.', access: 'write' }] }] };
  ledger = new ReservationLedger(join(root, 'ledger')); ledger.create(manifest);
  const state = new LedgerServerState(join(root, 'server'));
  const attribution: TaskRequestAttribution = { version: 1, kind: 'task', taskId: randomUUID(), attempt: 1,
    eventId: randomUUID(), eventHash: 'b'.repeat(64), sessionId: 'original-workflow' };
  const task = { attribution, maxOutputTokens: 128, project: identity(workspace) }, hash = manifestHash(manifest);
  const authority = taskWorkspaceLedgerAuthority({ runId: manifest.runId, manifestHash: hash, agentId: 'worker', ...task });
  server = createLedgerServer({ ledger, cwd: project, state, ownerAgentId: 'worker', authority, taskExecution: task,
    assertAuthority: () => { if (!active) throw new Error('Original task owner revoked'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    if (request.url.startsWith(url + '/')) return realFetch(input, init);
    if (request.url === 'https://approval.invalid/v1/models') return Response.json({ data: [{ id: 'public-approval-fixture',
      context_length: 100000, max_output_tokens: 128, pricing: { input: 1, output: 1 }, capabilities: { chat: true, tools: true, streaming: true } }] });
    expect(request.url).toBe('https://approval.invalid/v1/chat/completions');
    return chat(input, init);
  });
  const token = mintLedgerToken(state.secret(), { v: 2, authority, run: manifest.runId, role: 'parent', owner: 'worker', exp: deadline });
  const tokenFile = join(root, 'token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const client = await RemoteReservationLedger.connect({ url, token, root: join(root, 'cache'), execution: { cwd: workspace, agentId: 'worker' }, attempts: 1 });
  const binding = executionBinding({ ledger: client, manifestHash: hash, agentId: 'worker', attribution, maxOutputTokens: 128 });
  options = { cwd: workspace, provider: 'deepseek', model: 'public-approval-fixture', prompt: 'Write the fixture result.', outputMode: 'json',
    ledger: { url, tokenFile, agentId: 'worker' }, toolRuntime: { version: 2, executionBinding: binding,
      tools: [
        { name: 'write_file', description: 'Write a declared fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
        { name: 'shell', description: 'Run the exact fixture command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
      ], execute: async candidate => {
        executed.push(structuredClone(candidate));
        if (candidate.name === 'write_file') {
          expect(candidate.arguments.path).toBe('result.txt');
          fs.writeFileSync(join(workspace, 'result.txt'), String(candidate.arguments.content));
        } else {
          expect(candidate.arguments.command).toBe('write-approved-fixture');
          execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync('result.txt','approved')"], { cwd: workspace });
        }
        return { toolCallId: candidate.id, result: 'Fixture effect completed.' };
      } } };
  call = { id: 'original-tool', name: 'write_file', arguments: { path: 'result.txt', content: 'approved' } };
  chat.mockImplementationOnce(async () => completion(call)).mockImplementation(async () => completion());
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(async context => {
  vi.restoreAllMocks();
  const errors = output?.split('\n').filter(line => line.includes('"type":"error"') || line.includes('"type":"budget_exceeded"'));
  if (context.task.result?.state === 'fail' && errors?.length) console.error(errors.join('\n'));
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  config.resetConfig(); clearModelCache(); saveHooks([]); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function originalAccounting() {
  const saved = ledger.read(project);
  expect(saved.manifest).toEqual(manifest);
  expect(Object.keys(saved.projection.accounts)).toEqual(['worker']);
  expect(saved.projection.childGrants ?? []).toEqual([]);
  expect(Object.keys(saved.projection.requests)).toHaveLength(2);
  expect(Object.values(saved.projection.requests).every(row => row.state === 'settled')).toBe(true);
  expect(saved.projection.spent).toMatchObject({ tokens: 22, costNanos: 22000 });
}

it.each(['write_file', 'shell'])('executes explicitly approved %s under the original task ledger', async name => {
  call = name === 'shell' ? { ...call, name, arguments: { command: 'write-approved-fixture' } } : call;
  const approveTool = vi.fn(async (request: HeadlessToolApprovalRequest, signal?: AbortSignal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(request.call).toEqual(call); expect(request.decision.decision).toBe('confirm');
    expect(request.sessionId).toBeTruthy(); expect(request.revision).toBeTruthy(); expect(request.checksum).toMatch(/^[a-f0-9]{64}$/);
    return 'allow' as const;
  });
  expect(await runHeadless({ ...options, approveTool })).toBe(0);
  expect(approveTool).toHaveBeenCalledOnce(); expect(executed).toEqual([call]);
  expect(fs.readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('approved'); originalAccounting();
});

it('keeps a hosted mutation refused when the headless host supplies no approval callback', async () => {
  expect(await runHeadless(options)).toBe(0); expect(executed).toEqual([]);
  expect(fs.existsSync(join(workspace, 'result.txt'))).toBe(false); originalAccounting();
});

it.each(['reject', 'throw', 'invalid'] as const)('does not execute after a %s approval decision', async decision => {
  const approveTool = vi.fn(async () => { if (decision === 'throw') throw new Error('Approval transport unavailable'); return decision === 'reject' ? 'reject' : 'unexpected'; });
  expect(await runHeadless({ ...options, approveTool: approveTool as HeadlessOptions['approveTool'] })).toBe(0);
  expect(approveTool).toHaveBeenCalledOnce(); expect(executed).toEqual([]); originalAccounting();
});

it('rejects an approval after its saved conversation changes', async () => {
  const approveTool = vi.fn(async (request: HeadlessToolApprovalRequest) => {
    const old = readSessionConversation(request.sessionId);
    saveSessionConversation(request.sessionId, [...old.messages, { role: 'user', content: 'A different checkpoint.' }], { expectedRevision: old.revision, status: 'active' });
    return 'allow' as const;
  });
  await runHeadless({ ...options, approveTool });
  expect(approveTool).toHaveBeenCalledOnce();
  expect(executed).toEqual([]); expect(fs.existsSync(join(workspace, 'result.txt'))).toBe(false);
});

it('refuses an external checkpoint change before approval begins', async () => {
  let sessionId: string | undefined, changed = false;
  const approveTool = vi.fn(async () => 'allow' as const);
  vi.spyOn(hooks, 'checkHooksAllow').mockImplementation(async () => {
    if (!changed) {
      expect(sessionId).toBeTruthy();
      const saved = readSessionConversation(sessionId!);
      saveSessionConversation(sessionId!, [...saved.messages, { role: 'user', content: 'Concurrent host edit before approval.' }],
        { expectedRevision: saved.revision, status: 'active' });
      changed = true;
    }
    return { allowed: true };
  });
  await runHeadless({ ...options, approveTool, retainRuntimeState: true, runtimeStateVersion: 2,
    onRuntimeStateCommitted: async proof => { sessionId = proof.sessionId; } });
  expect(changed).toBe(true); expect(executed).toEqual([]); expect(approveTool).not.toHaveBeenCalled();
  expect(fs.existsSync(join(workspace, 'result.txt'))).toBe(false);
});

it('refuses a checkpoint change during post-approval checks before dispatch', async () => {
  let sessionId: string | undefined, checks = 0;
  const approveTool = vi.fn(async () => 'allow' as const);
  vi.spyOn(hooks, 'checkHooksAllow').mockImplementation(async () => {
    if (++checks === 2) {
      const saved = readSessionConversation(sessionId!);
      saveSessionConversation(sessionId!, [...saved.messages, { role: 'user', content: 'Concurrent edit during final permission checks.' }],
        { expectedRevision: saved.revision, status: 'active' });
    }
    return { allowed: true };
  });
  await runHeadless({ ...options, approveTool, retainRuntimeState: true, runtimeStateVersion: 2,
    onRuntimeStateCommitted: async proof => { sessionId = proof.sessionId; } });
  expect(checks).toBeGreaterThanOrEqual(2); expect(approveTool).toHaveBeenCalledOnce(); expect(executed).toEqual([]);
  expect(fs.existsSync(join(workspace, 'result.txt'))).toBe(false);
});

it('rechecks remote task ownership after approval and before the hosted effect', async () => {
  const approveTool = vi.fn(async () => { active = false; return 'allow' as const; });
  expect(await runHeadless({ ...options, approveTool })).toBe(1);
  expect(approveTool).toHaveBeenCalledOnce(); expect(executed).toEqual([]);
  const saved = ledger.read(project);
  expect(saved.manifest).toEqual(manifest); expect(Object.keys(saved.projection.requests)).toHaveLength(1);
  expect(saved.projection.spent).toEqual({ tokens: 11, costNanos: 11000 });
});

it('does not ask for approval for a tool outside the original grant', async () => {
  call = { ...call, name: 'execute_code', arguments: { code: 'ungranted' } };
  const approveTool = vi.fn(async () => 'allow' as const);
  expect(await runHeadless({ ...options, approveTool })).toBe(0);
  expect(approveTool).not.toHaveBeenCalled(); expect(executed).toEqual([]); originalAccounting();
});

it('does not turn a question-answer callback into a tool approval', async () => {
  const answerQuestion = vi.fn(async () => 'Approved');
  expect(await runHeadless({ ...options, answerQuestion })).toBe(0);
  expect(answerQuestion).not.toHaveBeenCalled(); expect(executed).toEqual([]); originalAccounting();
});

it('does not execute when the host cancels a pending approval', async () => {
  const controller = new AbortController();
  const approveTool = vi.fn(async (_request: HeadlessToolApprovalRequest, signal?: AbortSignal) => {
    expect(signal).toBeDefined(); expect(signal).not.toBe(controller.signal); controller.abort(); return 'allow' as const;
  });
  expect(await runHeadless({ ...options, signal: controller.signal, approveTool })).toBe(130);
  expect(approveTool).toHaveBeenCalledOnce(); expect(executed).toEqual([]);
});

it('does not let an approval callback modify the tool request that will execute', async () => {
  const original = structuredClone(call);
  const approveTool = async (request: HeadlessToolApprovalRequest) => {
    request.call.arguments.path = '../outside.txt'; request.call.arguments.content = 'changed';
    return 'allow' as const;
  };
  expect(await runHeadless({ ...options, approveTool })).toBe(0);
  expect(executed).toEqual([original]); expect(fs.readFileSync(join(workspace, 'result.txt'), 'utf8')).toBe('approved');
  expect(fs.existsSync(join(root, 'outside.txt'))).toBe(false);
});

it('refuses an invalid callback before inference or tool dispatch', async () => {
  expect(await runHeadless({ ...options, approveTool: true as unknown as HeadlessOptions['approveTool'] })).toBe(2);
  expect(chat).not.toHaveBeenCalled(); expect(executed).toEqual([]);
});
