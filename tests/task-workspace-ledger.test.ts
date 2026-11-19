import { ExecutionLimitError } from '../src/execution/types.js';
import * as config from '../src/config.js';
import { ProjectSpendLedger } from '../src/execution/project-spend.js';
import { projectBudgetPath } from '../src/budget.js';
import type { RouteCandidate } from '../src/routing/index.js';
/** Real ledger/server/checkpoint/guard; no provider or Native cluster calls. */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { projectIdentity } from '../src/approvals/index.js';
import { ReservationLedger, manifestHash, LedgerServerState, createLedgerServer, mintLedgerToken,
  taskWorkspaceLedgerAuthority, TASK_WORKSPACE_LEDGER_PROTOCOL_VERSION, ExecutionGuard,
  RemoteReservationLedger, type ExecutionManifest, type TaskRequestAttribution } from '../src/execution/index.js';
import { executionBinding } from '../src/execution/delegated.js';
import { bindHostToolRuntime } from '../src/runtime/host-tools.js';
import { providerTarget } from '../src/health/target.js';

let root: string, parent: string, first: string, second: string, manifest: ExecutionManifest;
let ledger: ReservationLedger, state: LedgerServerState, servers: Server[];
const identity = (cwd: string) => { const value = projectIdentity(cwd); return { root: value.project, key: value.projectKey }; };
beforeEach(() => {
  config.resetConfig();
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-task-workspace-'))); fs.chmodSync(root, 0o700);
  parent = join(root, 'authority-project'); first = join(root, 'first-checkout'); second = join(root, 'second-checkout');
  for (const path of [parent, first, second]) fs.mkdirSync(path);
  const now = Date.now(), deadline = now + 60000;
  manifest = { version: 1, runId: randomUUID(), planHash: 'a'.repeat(64), project: identity(parent),
    createdAt: now, deadline, tokenBudget: 12, costBudgetNanos: 12000,
    accounts: [{ id: 'worker', parentId: null, tokenBudget: 12, costBudgetNanos: 12000, deadline,
      allowedTools: ['read_file'], allowedPaths: [{ path: '.', access: 'read' }] }] };
  ledger = new ReservationLedger(join(root, 'money')); ledger.create(manifest);
  state = new LedgerServerState(join(root, 'server-state')); servers = [];
});
afterEach(async () => {
  for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks(); config.resetConfig(); fs.rmSync(root, { recursive: true, force: true });
});
async function host(cwd: string, options: { legacy?: boolean; active?: () => void } = {}) {
  const attribution: TaskRequestAttribution = { version: 1, kind: 'task', taskId: randomUUID(), attempt: 1,
    eventId: randomUUID(), eventHash: 'b'.repeat(64), sessionId: 'original-workflow' };
  const project = identity(cwd), hash = manifestHash(manifest);
  const authority = options.legacy ? 'c'.repeat(64) : taskWorkspaceLedgerAuthority({ runId: manifest.runId,
    manifestHash: hash, agentId: 'worker', project, attribution, maxOutputTokens: 100 });
  const task = { attribution, maxOutputTokens: 100, ...(options.legacy ? {} : { project }) };
  const server = createLedgerServer({ ledger, cwd: parent, state, ownerAgentId: 'worker', authority,
    taskExecution: task, assertAuthority: options.active });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = mintLedgerToken(state.secret(), { v: 2, authority, run: manifest.runId, role: 'parent', owner: 'worker', exp: manifest.deadline });
  const cache = join(root, 'cache-' + randomUUID());
  const connect = (actual = cwd, other: { fetch?: typeof fetch; root?: string; token?: string } = {}) => RemoteReservationLedger.connect({
    url, token, root: cache, ...other, execution: { cwd: actual, agentId: 'worker' }, attempts: 1,
  });
  return { server, url, token, attribution, project, authority, connect, cache, task, hash };
}
const request = (attribution: TaskRequestAttribution) => ({ id: randomUUID(), agentId: 'worker', provider: 'deepseek' as const,
  model: 'public-ledger-fixture', target: providerTarget('deepseek').key, inputTokens: 4, outputTokens: 1,
  inputPrice: 1, outputPrice: 1, costNanos: 5000, attribution });
async function post(url: string, token: string, operation: string, body: object = {}) {
  const response = await fetch(url + '/v1/' + operation, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  return { status: response.status, value: await response.json() };
}

it('shares one original account, cap, deadline and unknown hold across two physical task checkouts', async () => {
  expect(TASK_WORKSPACE_LEDGER_PROTOCOL_VERSION).toBe(1);
  const original = ledger.read(parent), a = await host(first), b = await host(second);
  const one = await a.connect(), two = await b.connect(), r1 = request(a.attribution), r2 = request(b.attribution);
  expect(one.taskExecutionBinding!.workspaceProject).toEqual(identity(first));
  expect(two.taskExecutionBinding!.workspaceProject).toEqual(identity(second));
  await one.reserve(first, a.hash, r1); await two.reserve(second, b.hash, r2);
  expect(ledger.read(parent).projection.spent).toMatchObject({ tokens: 10, costNanos: 10000 });
  await expect(one.reserve(first, a.hash, request(a.attribution))).rejects.toThrow();
  await one.settle(first, a.hash, { requestId: r1.id, outcome: 'error' });
  await two.settle(second, b.hash, { requestId: r2.id, outcome: 'success', usage: { inputTokens: 2, outputTokens: 1 } });
  const saved = ledger.read(parent), restarted = await a.connect();
  expect(saved.manifest).toEqual(original.manifest); expect(saved.projection.manifestHash).toBe(original.projection.manifestHash);
  expect(saved.projection.requests[r1.id]!.state).toBe('unknown');
  expect(saved.projection.spent).toMatchObject({ tokens: 8, costNanos: 8000 });
  expect(Object.keys(saved.projection.accounts)).toEqual(['worker']); expect(saved.projection.childGrants ?? []).toEqual([]);
  expect(restarted.read(first).projection).toEqual(saved.projection);
  await expect(restarted.reserve(first, a.hash, request(a.attribution))).rejects.toThrow();
  expect(ledger.read(parent).manifest.deadline).toBe(manifest.deadline);
});

it('accepts only the fixed task workspace and audience; ordinary task execution stays project-bound', async () => {
  const a = await host(first), b = await host(second), before = ledger.read(parent);
  await expect(a.connect(second)).rejects.toThrow(); await expect(b.connect(second, { token: a.token })).rejects.toThrow();
  const legacy = await host(first, { legacy: true }); await expect(legacy.connect()).rejects.toThrow();
  const hello = await post(a.url, a.token, 'hello');
  expect(hello.value.operations).toEqual(['hello', 'journal', 'task-workspace-execution', 'reserve', 'settle']);
  for (const operation of ['execution', 'task-execution', 'grant', 'revoke']) expect((await post(a.url, a.token, operation)).status).toBe(404);
  expect(ledger.read(parent)).toEqual(before);
});

it('requires the exact accounted host and blocks SDK-local access for a task workspace', async () => {
  const a = await host(first), client = await a.connect();
  const execution = { ledger: client, manifestHash: a.hash, agentId: 'worker', attribution: a.attribution, maxOutputTokens: 100 };
  const guard = new ExecutionGuard(execution, first), call = { id: 'original-call', name: 'read_file', arguments: { path: 'private.txt' } };
  expect(guard.requiresHostedTools).toBe(true); expect(guard.check(call)).toContain('accounted tool host'); expect(guard.tools([])).toEqual([]);
  const tool = { name: 'read_file', description: 'Read the declared Native sandbox.', parameters: { type: 'object' as const, properties: { path: { type: 'string' } } } };
  const runtime = { version: 2 as const, executionBinding: executionBinding(execution), tools: [tool], execute: async () => ({ toolCallId: call.id, result: 'Public sandbox fixture.' }) };
  expect(bindHostToolRuntime(runtime, execution)!.accounted).toBe(true);
  expect(guard.hostedTools([tool])).toEqual([tool]); expect(guard.checkHosted(call)).toBeUndefined();
  expect(() => new ExecutionGuard({ ...execution, attribution: { ...a.attribution, taskId: randomUUID() } }, first)).toThrow();
  expect(() => new ExecutionGuard({ ...execution, workspace: { filesRoot: join(root, 'local-files'), assertIdentity() {} } }, first)).toThrow();
});

it.each(['workspace', 'version', 'attribution', 'project-budget', 'project-cap'] as const)('refuses a live %s binding substitution without changing its verified binding', async field => {
  const a = await host(first); let changed = false;
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (!changed || !String(input).endsWith('/task-workspace-execution')) return response;
    const body = await response.json();
    if (field === 'workspace') body.binding.project = identity(second);
    else if (field === 'version') body.binding.version = 2;
    else if (field === 'attribution') body.binding.attribution.taskId = randomUUID();
    else if (field === 'project-budget') body.projectBudget.projectKey = 'f'.repeat(64);
    else body.projectBudget.capNanos = true;
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  };
  const client = await a.connect(first, { fetch: transport }), binding = client.taskExecutionBinding;
  changed = true; await expect(client.refreshAuthority(first, 'worker')).rejects.toThrow();
  expect(client.taskExecutionBinding).toEqual(binding); expect(client.executionProject(first, 'worker')).toEqual(identity(first));
});

it('keeps original reservation replay and settlement available after owner fencing, with no new admission', async () => {
  let active = true; const a = await host(first, { active() { if (!active) throw new Error('Original owner fenced'); } });
  const client = await a.connect(), saved = request(a.attribution); await client.reserve(first, a.hash, saved); active = false;
  await expect(client.refreshAuthority(first, 'worker')).rejects.toThrow();
  await client.reserve(first, a.hash, saved); await expect(client.reserve(first, a.hash, request(a.attribution))).rejects.toThrow();
  await client.settle(first, a.hash, { requestId: saved.id, outcome: 'error' });
  expect(ledger.read(parent).projection.requests[saved.id]!.state).toBe('unknown');
});

it('binds the workspace, task and output ceiling into the owner token audience', async () => {
  const a = await host(first), base = { runId: manifest.runId, manifestHash: a.hash, agentId: 'worker', project: a.project,
    attribution: a.attribution, maxOutputTokens: 100 };
  for (const changed of [{ project: identity(second) }, { attribution: { ...a.attribution, taskId: randomUUID() } }, { maxOutputTokens: 99 }])
    expect(taskWorkspaceLedgerAuthority({ ...base, ...changed })).not.toBe(a.authority);
  expect(() => createLedgerServer({ ledger, cwd: parent, state, ownerAgentId: 'worker', authority: 'd'.repeat(64), taskExecution: a.task })).toThrow();
});


it('enforces a prior original-project hold through actual guard budgets from both task checkouts', async () => {
  manifest.tokenBudget = 10000; manifest.costBudgetNanos = 10000000;
  manifest.accounts[0]!.tokenBudget = 10000; manifest.accounts[0]!.costBudgetNanos = 10000000;
  ledger = new ReservationLedger(join(root, 'larger-original-run')); ledger.create(manifest);
  config.set('budget', { maxCostPerProject: 0.0004 });
  const originalProject = new ProjectSpendLedger(projectBudgetPath(parent));
  const existing = randomUUID(); await originalProject.reserve(existing, randomUUID(), 300000, 1000000);
  const route: RouteCandidate = { provider: 'deepseek', model: 'public-quote-fixture', target: providerTarget('deepseek').key,
    evidence: 'live', discoveredAt: new Date().toISOString(), contextLength: 256, maxOutputTokens: 1,
    price: { input: 1, output: 1 }, capabilities: { chat: true, tools: true, streaming: true },
    estimatedCost: null, latencyMs: null, errorRate: null, score: 0, reason: 'Public offline billing fixture' };
  for (const cwd of [first, second]) {
    const a = await host(cwd), client = await a.connect();
    const guard = new ExecutionGuard({ ledger: client, manifestHash: a.hash, agentId: 'worker', attribution: a.attribution, maxOutputTokens: 1 }, cwd);
    const budget = guard.budget(route, [{ role: 'user', content: 'Public fixture.' }], [], false);
    await expect(budget.reserve({ provider: 'deepseek', model: route.model, target: route.target, maxOutputTokens: 1 })).rejects.toThrow('project cost budget');
    expect(new ProjectSpendLedger(projectBudgetPath(cwd)).read().spentUsd).toBe(0);
  }
  expect(originalProject.read().spentUsd).toBe(0.0003);
  expect(Object.keys(ledger.read(parent).projection.requests)).toEqual([]);
});


it.each(['owner', 'client'] as const)('atomically shares the %s project ceiling across different original run ledgers', async policy => {
  if (policy === 'owner') config.set('budget', { maxCostPerProject: 0.000009 });
  const firstLedger = ledger, a = await host(first), one = await a.connect();
  manifest = { ...manifest, runId: randomUUID() }; ledger = new ReservationLedger(join(root, 'second-original-run')); ledger.create(manifest);
  const b = await host(second), two = await b.connect();
  const cap = policy === 'client' ? 9000 : 1000000;
  const outcomes = await Promise.allSettled([
    one.reserveProjectAccounted(first, a.hash, request(a.attribution), cap),
    two.reserveProjectAccounted(second, b.hash, request(b.attribution), cap),
  ]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
  expect(new ProjectSpendLedger(projectBudgetPath(parent)).readAccounting().spentNanos).toBe(5000);
  expect(Object.keys(firstLedger.read(parent).projection.requests).length + Object.keys(ledger.read(parent).projection.requests).length).toBe(1);
});

it('replays concurrent original reservation and settlement without double project charges', async () => {
  const a = await host(first), client = await a.connect(), saved = request(a.attribution);
  await Promise.all([client.reserve(first, a.hash, saved), client.reserve(first, a.hash, saved)]);
  const settlement = { requestId: saved.id, outcome: 'success' as const, usage: { inputTokens: 2, outputTokens: 1 } };
  await Promise.all([client.settle(first, a.hash, settlement), client.settle(first, a.hash, settlement)]);
  const project = new ProjectSpendLedger(projectBudgetPath(parent)).readAccounting();
  expect(project.spentNanos).toBe(3000);
  expect(project.events.filter(value => value.change.type === 'reserve')).toHaveLength(1);
  expect(project.events.filter(value => value.change.type === 'settle')).toHaveLength(1);
  expect(ledger.read(parent).events).toHaveLength(2);
});

it('rechecks owner project tightening inside the original reservation writer lock', async () => {
  config.set('budget', { maxCostPerProject: 0.000009 });
  const a = await host(first), client = await a.connect(), saved = request(a.attribution);
  const lock = join(ledger.root, 'writer.lock'); fs.writeFileSync(lock, String(process.pid), { mode: 0o600, flag: 'wx' });
  let entered!: () => void; const boundary = new Promise<void>(resolve => { entered = resolve; });
  const realReserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, 'reserve').mockImplementation((...args) => { entered(); return realReserve(...args); });
  const operation = client.reserve(first, a.hash, saved); const refused = expect(operation).rejects.toThrow('project cost budget');
  try { await boundary; config.set('budget', { maxCostPerProject: 0.000004 }); }
  finally { fs.rmSync(lock); }
  await refused;
  expect(ledger.read(parent).projection.spent.costNanos).toBe(0);
  expect(new ProjectSpendLedger(projectBudgetPath(parent)).readAccounting().spentNanos).toBe(0);
});

it('requires owner project settlement acknowledgment, then reuses the original fact after a lost reply', async () => {
  const a = await host(first); let lose = true;
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (lose && String(input).endsWith('/settle')) { await response.text(); lose = false; throw new Error('Synthetic reply lost after real settlement'); }
    return response;
  };
  const client = await a.connect(first, { fetch: transport }), saved = request(a.attribution);
  await client.reserve(first, a.hash, saved);
  const settlement = { requestId: saved.id, outcome: 'success' as const, usage: { inputTokens: 2, outputTokens: 1 } };
  await expect(client.settle(first, a.hash, settlement)).rejects.toThrow('Settlement outcome is unknown');
  await client.settle(first, a.hash, settlement);
  const project = new ProjectSpendLedger(projectBudgetPath(parent)).readAccounting();
  expect(project.spentNanos).toBe(3000); expect(project.events.filter(value => value.change.type === 'settle')).toHaveLength(1);
});


it('does not turn a retained project hold into a new run admission after the project is blocked', async () => {
  const a = await host(first), saved = request(a.attribution), project = new ProjectSpendLedger(projectBudgetPath(parent));
  await project.reserveOnce(saved.id, manifest.runId, saved.costNanos, Number.MAX_SAFE_INTEGER);
  const invalid = randomUUID(); await project.reserve(invalid, randomUUID(), 1, Number.MAX_SAFE_INTEGER);
  await project.settle(invalid, null, true);
  const client = await a.connect();
  await expect(client.reserve(first, a.hash, saved)).rejects.toThrow('project cost policy');
  expect(ledger.read(parent).projection.spent.costNanos).toBe(0);
  expect(project.readAccounting()).toMatchObject({ spentNanos: 5001, blocked: true });
});


it('requires owner project settlement ACK even through a reconciliation-only connection', async () => {
  const a = await host(first), client = await a.connect(), saved = request(a.attribution);
  await client.reserve(first, a.hash, saved);
  const accounting = await RemoteReservationLedger.connect({ url: a.url, token: a.token, root: join(root, 'reconciliation-cache'),
    reconciliation: { cwd: parent, agentId: 'worker' }, attempts: 1 });
  const original = ProjectSpendLedger.prototype.settleOnce;
  const failure = vi.spyOn(ProjectSpendLedger.prototype, 'settleOnce').mockImplementation(async function (...args) {
    if (args[0] === saved.id) throw new ExecutionLimitError('unavailable', 'Synthetic owner project settlement unavailable');
    return original.apply(this, args);
  });
  const settlement = { requestId: saved.id, outcome: 'success' as const, usage: { inputTokens: 2, outputTokens: 1 } };
  await expect(accounting.settle(parent, a.hash, settlement)).rejects.toThrow('Settlement outcome is unknown');
  expect(new ProjectSpendLedger(projectBudgetPath(parent)).readAccounting().spentNanos).toBe(5000);
  failure.mockRestore(); await accounting.settle(parent, a.hash, settlement);
  expect(new ProjectSpendLedger(projectBudgetPath(parent)).readAccounting().spentNanos).toBe(3000);
});

it.each(['tokens', 'cost'] as const)('rechecks current owner run %s policy under the writer lock', async limit => {
  const a = await host(first), client = await a.connect(), saved = request(a.attribution);
  const lock = join(ledger.root, 'writer.lock'); fs.writeFileSync(lock, String(process.pid), { mode: 0o600, flag: 'wx' });
  let entered!: () => void; const boundary = new Promise<void>(resolve => { entered = resolve; });
  const realReserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, 'reserve').mockImplementation((...args) => { entered(); return realReserve(...args); });
  const operation = client.reserve(first, a.hash, saved); const refused = expect(operation).rejects.toThrow('owner run policy');
  try { await boundary; config.set('budget', limit === 'tokens' ? { maxTokensPerRun: 4 } : { maxCostPerRun: 0.000004 }); }
  finally { fs.rmSync(lock); }
  await refused;
  expect(ledger.read(parent).projection.spent.costNanos).toBe(0);
  expect(new ProjectSpendLedger(projectBudgetPath(parent)).readAccounting().spentNanos).toBe(0);
});


it('releases only a proven owner refusal and cannot reopen its settled project reservation', async () => {
  const money = new ProjectSpendLedger(projectBudgetPath(parent));
  let refuseAfterFunding = true;
  const a = await host(first, { active() {
    if (refuseAfterFunding && money.readAccounting().spentNanos > 0)
      throw new ExecutionLimitError('authority', 'Original owner fenced after project funding');
  } });
  const client = await a.connect(), value = request(a.attribution), original = ledger.read(parent).manifest;
  const failure = await client.reserve(first, a.hash, value).catch(error => error);
  expect(failure).toMatchObject({ code: 'authority' });
  expect(client.canReleaseFailedReservation(failure)).toBe(true);
  expect(ledger.read(parent).projection.requests[value.id]).toBeUndefined();
  expect(money.readAccounting().spentNanos).toBe(0);
  expect(money.readAccounting().events.filter(event => event.change.type === 'settle')).toHaveLength(1);
  refuseAfterFunding = false;
  await expect(client.reserve(first, a.hash, value)).rejects.toMatchObject({ code: 'conflict' });
  expect(money.readAccounting().spentNanos).toBe(0);
  const fresh = request(a.attribution);
  await client.reserve(first, a.hash, fresh);
  expect(ledger.read(parent).projection.requests[fresh.id]!.state).toBe('pending');
  expect(money.readAccounting().spentNanos).toBe(fresh.costNanos);
  expect(ledger.read(parent).manifest).toEqual(original);
});
