/** Real runtime, guard, journal and provider adapters; only HTTP is synthetic. */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as config from '../src/config.js';
import { runTurn, type TurnOptions, type RuntimeProviderResponseCheckpoint } from '../src/runtime/index.js';
import { ReservationLedger, manifestHash, createLedgerServer, LedgerServerState, mintLedgerToken, connectDelegatedExecution, type ExecutionManifest } from '../src/execution/index.js';
import { runHeadless } from '../src/headless.js';
import { executionManifest } from './helpers/execution-manifest.js';
import { createSession, saveSessionConversation } from '../src/storage.js';
import { RunLog } from '../src/runlog.js';
import { clearModelCache } from '../src/model-detection.js';
import { configureAutoCompressor, resetAutoCompressorState } from '../src/auto-compressor.js';
import { saveHooks } from '../src/hooks.js';
import { getTools } from '../src/tools.js';
import type { TurnRuntimeState, TurnProgress } from '../src/sessions/index.js';

let root: string, project: string, ledger: ReservationLedger, manifest: ExecutionManifest;
let requests: any[], respond: (request: any) => Response;
const realFetch = globalThis.fetch;
let providerFetch: typeof fetch;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const response = (call?: { name: string; arguments: unknown }) => json({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'fixture-model',
  choices: [{ index: 0, message: { role: 'assistant', content: call ? 'Inspecting.' : 'Original task context and acceptance criteria retained.',
    ...(call ? { tool_calls: [{ id: 'original-call', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });

beforeEach(() => {
  config.resetConfig(); clearModelCache(); saveHooks([]); resetAutoCompressorState();
  configureAutoCompressor({ enabled: false, useLlm: true, triggerThreshold: 80, preserveRecent: 10 });
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-runtime-provider-'))); fs.chmodSync(root, 0o700);
  project = join(root, 'project'); fs.mkdirSync(project); fs.mkdirSync(join(project, 'a')); fs.writeFileSync(join(project, 'a/fixture.txt'), 'Public fixture.');
  manifest = executionManifest(project); manifest.tokenBudget = 50000; manifest.costBudgetNanos = 100000000;
  for (const account of manifest.accounts) { account.tokenBudget = account.parentId === null ? 50000 : 25000; account.costBudgetNanos = account.parentId === null ? 100000000 : 50000000; }
  ledger = new ReservationLedger(join(root, 'ledger')); ledger.create(manifest); requests = []; respond = () => response();
  for (const provider of config.getProviderNames()) {
    const env = config.getProviderEnvVars(provider); for (const name of [env.apiKey, env.baseUrl]) if (name) vi.stubEnv(name, '');
  }
  config.setProviderCred('deepseek', { apiKey: 'synthetic', baseUrl: 'https://purpose.invalid/v1' });
  config.setProviderCred('openai-compat', { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1/v1' });
  providerFetch = vi.fn(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    expect(['purpose.invalid', '127.0.0.1']).toContain(url.hostname);
    if (url.pathname === '/v1/models') return json({ data: [{ id: 'fixture-model', context_length: 8192, max_output_tokens: 100,
      pricing: { input: 1, output: 2 }, capabilities: { chat: true, tools: true, streaming: true } }] });
    expect(url.pathname).toBe('/v1/chat/completions'); const body = await request.json(); requests.push(body); return respond(body);
  });
  vi.stubGlobal('fetch', providerFetch);
});
afterEach(() => {
  config.resetConfig(); clearModelCache(); saveHooks([]); resetAutoCompressorState(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
});

function fixture(extra: Partial<TurnOptions> = {}) {
  const session = createSession(project, { activate: false });
  let saved: ReturnType<typeof saveSessionConversation> | undefined;
  const states: TurnRuntimeState[] = [], progress: TurnProgress[] = [];
  const options: TurnOptions = { cwd: project, sessionId: session.id, provider: 'deepseek', model: 'fixture-model', prompt: 'Inspect the public fixture.',
    messages: { current: [{ role: 'user', content: 'Inspect the public fixture.' }] }, confirmation: 'none', maxIterations: 3, tools: () => [],
    runlog: RunLog.open(session.id, { enabled: false }), execution: { ledger, manifestHash: manifestHash(manifest), agentId: 'a', maxOutputTokens: 100 },
    retainRuntimeState: true, runtimeStateVersion: 2,
    onCheckpoint: (messages, status, allowance, state) => {
      saved = saveSessionConversation(session.id, messages, { expectedRevision: saved?.revision ?? null, status, progress: allowance, runtimeState: state });
      if (state) states.push(structuredClone(state)); if (allowance) progress.push(structuredClone(allowance));
    }, ...extra };
  return { options, states, progress };
}

it('retains the original identity and logical provider effect before response settlement', async () => {
  const sdk = await import('../src/index.js');
  expect(sdk.PROVIDER_RESPONSE_CHECKPOINT_PROTOCOL_VERSION).toBe(1);
  expect(sdk.runHeadless).toBe(runHeadless);
  const captured: RuntimeProviderResponseCheckpoint[] = [], f = fixture();
  const sessionId = f.options.sessionId, hash = manifestHash(manifest);
  f.options.onProviderResponseReceived = async checkpoint => {
    expect(ledger.read(project).projection.requests[checkpoint.checkpoint.reservationId]!.state).toBe('pending');
    expect(f.states.at(-1)!.effect).toEqual({ kind: 'provider', id: checkpoint.operationId });
    captured.push(structuredClone(checkpoint)); (checkpoint.checkpoint.response as { content: string }).content = 'Observer mutation';
  };
  const result = await runTurn(f.options);
  expect(result.reason).toBe('completed'); expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ version: 1, sessionId, turnId: f.progress[0]!.turnId, runId: manifest.runId, agentId: 'a', manifestHash: hash,
    purpose: 'primary', parentOperationId: null, iteration: 1, checkpoint: { provider: 'deepseek', model: 'fixture-model', attempt: 1, usageReported: true } });
  expect(captured[0]!.runtimeRequestSha256).toMatch(/^[a-f0-9]{64}$/); expect(f.options.messages.current.at(-1)!.content).not.toBe('Observer mutation');
  expect(ledger.read(project).projection.spent.costNanos).toBe(13000);
});

it('keeps one logical operation across transport retries and distinct original reservations', async () => {
  let calls = 0; respond = () => ++calls === 1 ? json({ error: { message: 'Synthetic overload' } }, 503) : response();
  const captured: RuntimeProviderResponseCheckpoint[] = [], f = fixture({ maxProviderRetries: 1, onProviderResponseReceived: async value => { captured.push(value); } });
  expect((await runTurn(f.options)).reason).toBe('completed'); expect(requests).toHaveLength(2); expect(captured).toHaveLength(1);
  expect(captured[0]!.checkpoint.attempt).toBe(2);
  const effects = f.states.filter(state => state.effect.kind === 'provider').map(state => (state.effect as { id: string }).id);
  expect(new Set(effects)).toEqual(new Set([captured[0]!.operationId])); expect(Object.keys(ledger.read(project).projection.requests)).toHaveLength(2);
}, 15000);

it.each([false, true])('records compression purpose and stops a lost compression acknowledgment (lost=%s)', async lost => {
  configureAutoCompressor({ enabled: true, useLlm: true, triggerThreshold: 1, preserveRecent: 1 });
  const captured: RuntimeProviderResponseCheckpoint[] = [], compressed = vi.fn(), retry = vi.fn(() => 'retry' as const);
  const f = fixture({ onCompression: compressed, onError: retry, onProviderResponseReceived: async value => {
    captured.push(value); if (lost && value.purpose === 'compression') throw new Error('Lost compression receipt');
  } });
  f.options.messages.current = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `Public context ${index}: ` + 'Original task facts. '.repeat(10) }));
  if (lost) {
    await expect(runTurn(f.options)).rejects.toThrow('Runtime provider response checkpoint was not acknowledged');
    expect(requests).toHaveLength(1); expect(compressed).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
    expect(captured.map(value => value.purpose)).toEqual(['compression']);
  } else {
    expect((await runTurn(f.options)).reason).toBe('completed'); expect(requests).toHaveLength(2);
    expect(captured.map(value => value.purpose)).toEqual(['compression', 'primary']);
    expect(new Set(captured.map(value => value.operationId)).size).toBe(2); expect(compressed).toHaveBeenCalledTimes(1);
  }
  expect(new Set(captured.map(value => value.turnId)).size).toBe(1);
});

it.each([false, true])('correlates repair to its primary operation and stops a lost repair acknowledgment (lost=%s)', async lost => {
  let calls = 0; respond = () => ++calls === 1 ? response({ name: 'read_file', arguments: {} })
    : calls === 2 ? response({ name: 'read_file', arguments: { path: 'a/fixture.txt' } }) : response();
  const captured: RuntimeProviderResponseCheckpoint[] = [], tool = vi.fn(), repair = vi.fn(), retry = vi.fn(() => 'retry' as const);
  const f = fixture({ provider: 'openai-compat', tools: () => [getTools().find(value => value.name === 'read_file')!], onToolStart: tool, onError: retry,
    onRepair: repair,
    onProviderResponseReceived: async value => { captured.push(value); if (lost && value.purpose === 'repair') throw new Error('Lost repair receipt'); } });
  if (lost) {
    await expect(runTurn(f.options)).rejects.toThrow('Runtime provider response checkpoint was not acknowledged');
    expect(requests).toHaveLength(2); expect(tool).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
    expect(repair.mock.calls.map(call => call[0].status)).toEqual(['started']);
  } else {
    expect((await runTurn(f.options)).reason).toBe('completed'); expect(requests).toHaveLength(3); expect(tool).toHaveBeenCalledTimes(1);
  }
  expect(captured.slice(0, 2).map(value => value.purpose)).toEqual(['primary', 'repair']);
  expect(captured[1]!.parentOperationId).toBe(captured[0]!.operationId); expect(captured[1]!.operationId).not.toBe(captured[0]!.operationId);
});

it.each([undefined, false, true])('refuses unguarded or malformed runtime retention before provider effects (%s)', async mode => {
  const f = fixture(); f.options.execution = undefined;
  f.options.onProviderResponseReceived = mode === undefined ? async () => {} : mode as unknown as TurnOptions['onProviderResponseReceived'];
  await expect(runTurn(f.options)).rejects.toThrow('Runtime provider checkpoints require'); expect(requests).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});

it.each(['reject', 'invalid-ack'])('stops a primary retention failure without invoking retry policy (%s)', async mode => {
  const retry = vi.fn(() => 'retry' as const), presented = vi.fn();
  const callback = async () => {
    if (mode === 'reject') throw new Error('Lost primary receipt');
    return { accepted: true };
  };
  const f = fixture({ onError: retry, onResponse: presented, maxProviderRetries: 2,
    onProviderResponseReceived: callback as unknown as TurnOptions['onProviderResponseReceived'] });
  await expect(runTurn(f.options)).rejects.toThrow('Runtime provider response checkpoint was not acknowledged');
  expect(requests).toHaveLength(1); expect(retry).not.toHaveBeenCalled(); expect(presented).not.toHaveBeenCalled();
  expect(ledger.read(project).projection.spent.costNanos).toBe(13000);
});

it('pins the validated guard identity and response writer before caller mutations', async () => {
  const captured: RuntimeProviderResponseCheckpoint[] = [], replacement = vi.fn(async () => {});
  const f = fixture({ onProviderResponseReceived: async value => { captured.push(value); } });
  const originalSession = f.options.sessionId, originalHash = manifestHash(manifest);
  respond = () => {
    f.options.onProviderResponseReceived = replacement; f.options.execution!.agentId = 'b';
    f.options.execution!.manifestHash = 'f'.repeat(64); f.options.sessionId = 'caller-mutated-session';
    return response();
  };
  expect((await runTurn(f.options)).reason).toBe('completed'); expect(replacement).not.toHaveBeenCalled();
  expect(captured[0]).toMatchObject({ sessionId: originalSession, manifestHash: originalHash, agentId: 'a', runId: manifest.runId });
  expect(Object.values(ledger.read(project).projection.requests)[0]!.reservation.agentId).toBe('a');
});

it('requires runtime capture even when the execution guard and host writer exist', async () => {
  const f = fixture({ retainRuntimeState: false, onProviderResponseReceived: async () => {} });
  await expect(runTurn(f.options)).rejects.toThrow('Runtime provider checkpoints require'); expect(fetch).not.toHaveBeenCalled();
});

it.each([false, true])('connects headless retention to the original scoped parent ledger (lost=%s)', async lost => {
  const state = new LedgerServerState(join(root, 'server-state'));
  const token = mintLedgerToken(state.secret(), { v: 2, run: manifest.runId, role: 'parent', owner: 'a', exp: manifest.deadline });
  const tokenFile = join(root, 'operator.token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const server = createLedgerServer({ ledger, cwd: project, state, ownerAgentId: 'a' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); return new URL(request.url).origin === url ? realFetch(input, init) : providerFetch(input, init);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true); vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const captured: RuntimeProviderResponseCheckpoint[] = [];
  try {
    const code = await runHeadless({ cwd: project, provider: 'deepseek', model: 'fixture-model', prompt: 'Inspect the public fixture.',
      retainRuntimeState: true, runtimeStateVersion: 2, maxIterations: 2,
      ledger: { url, tokenFile, agentId: 'a', maxOutputTokens: 100 },
      toolRuntime: { version: 1, tools: [], execute: async () => { throw new Error('No tool was admitted'); } },
      onProviderResponseReceived: async value => { captured.push(value); if (lost) throw new Error('Lost headless receipt'); },
    });
    expect(code).toBe(lost ? 1 : 0); expect(requests).toHaveLength(1); expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ manifestHash: manifestHash(manifest), runId: manifest.runId, agentId: 'a', purpose: 'primary', iteration: 1 });
    expect(ledger.read(project).projection.spent.costNanos).toBe(13000);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('denies headless response retention without its original delegated ledger', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true); vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  expect(await runHeadless({ cwd: project, prompt: 'Original task', retainRuntimeState: true, onProviderResponseReceived: async () => {} })).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['compression', 'repair'] as const)('stops %s after an acknowledged response whose original settlement is unavailable', async purpose => {
  const state = new LedgerServerState(join(root, 'settlement-server'));
  const token = mintLedgerToken(state.secret(), { v: 2, run: manifest.runId, role: 'parent', owner: 'a', exp: manifest.deadline });
  const tokenFile = join(root, 'settlement.token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const server = createLedgerServer({ ledger, cwd: project, state, ownerAgentId: 'a' });
  const handlers = server.listeners('request'); server.removeAllListeners('request');
  let refuseSettlement = false, failedSettlements = 0;
  server.on('request', (request, result) => {
    if (refuseSettlement && request.url === '/v1/settle') {
      failedSettlements++; request.resume(); result.writeHead(503, { 'content-type': 'application/json' });
      result.end(JSON.stringify({ ok: false, code: 'unavailable', message: 'Synthetic temporary settlement failure' })); return;
    }
    for (const handler of handlers) handler.call(server, request, result);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); return new URL(request.url).origin === url ? realFetch(input, init) : providerFetch(input, init);
  });
  const captured: RuntimeProviderResponseCheckpoint[] = [], tool = vi.fn(), presented = vi.fn(), compressed = vi.fn(), repair = vi.fn(), retry = vi.fn(() => 'retry' as const);
  const f = fixture({ provider: purpose === 'repair' ? 'openai-compat' : 'deepseek',
    tools: () => purpose === 'repair' ? [getTools().find(value => value.name === 'read_file')!] : [],
    onToolStart: tool, onResponse: presented, onCompression: compressed, onRepair: repair, onError: retry,
    onProviderResponseReceived: async value => { captured.push(value); refuseSettlement = value.purpose === purpose; },
  });
  if (purpose === 'compression') {
    configureAutoCompressor({ enabled: true, useLlm: true, triggerThreshold: 1, preserveRecent: 1 });
    f.options.messages.current = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `Public context ${index}: ` + 'Original task facts. '.repeat(10) }));
  } else {
    let calls = 0; respond = () => ++calls === 1 ? response({ name: 'read_file', arguments: {} }) : response({ name: 'read_file', arguments: { path: 'a/fixture.txt' } });
  }
  try {
    f.options.execution = await connectDelegatedExecution(project, { url, tokenFile, agentId: 'a', maxOutputTokens: 100 });
    await expect(runTurn(f.options)).rejects.toMatchObject({ code: 'unavailable' });
    expect(failedSettlements).toBeGreaterThan(0); expect(captured.at(-1)!.purpose).toBe(purpose);
    expect(requests).toHaveLength(purpose === 'compression' ? 1 : 2);
    expect(tool).not.toHaveBeenCalled(); expect(presented).not.toHaveBeenCalled(); expect(compressed).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
    expect(repair.mock.calls.map(call => call[0].status)).toEqual(purpose === 'repair' ? ['started'] : []);
    const saved = ledger.read(project); expect(Object.values(saved.projection.requests).filter(value => value.state === 'pending')).toHaveLength(1);
    // Readability and remaining capacity are intact; only terminal error propagation stops continuation.
    expect(saved.projection.spent.tokens).toBeLessThan(manifest.accounts[1]!.tokenBudget - 8192);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 15000);

it.each(['primary', 'compression'] as const)('stops ordinary and asynchronous onUsage failures after %s', async purpose => {
  for (const asynchronous of [false, true]) {
    requests.length = 0; resetAutoCompressorState();
    configureAutoCompressor({ enabled: purpose === 'compression', useLlm: true, triggerThreshold: 1, preserveRecent: 1 });
    const retry = vi.fn(() => 'retry' as const), presented = vi.fn(), compressed = vi.fn();
    const fail = () => { throw new Error('Synthetic host notification failure'); };
    const f = fixture({ onUsage: asynchronous ? async () => fail() : fail, onError: retry, onResponse: presented, onCompression: compressed,
      onProviderResponseReceived: async () => {} });
    if (purpose === 'compression') f.options.messages.current = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const, content: `Public context ${index}: ` + 'Original task facts. '.repeat(10) }));
    await expect(runTurn(f.options)).rejects.toThrow('Runtime onUsage callback failed');
    expect(requests).toHaveLength(1); expect(retry).not.toHaveBeenCalled(); expect(presented).not.toHaveBeenCalled(); expect(compressed).not.toHaveBeenCalled();
  }
});

it.each(['ok', 'error'] as const)('stops a rejected repair %s notification without notifying again or executing tools', async status => {
  for (const asynchronous of [false, true]) {
    requests.length = 0;
    let calls = 0; respond = () => ++calls === 1 ? response({ name: 'read_file', arguments: {} })
      : status === 'ok' ? response({ name: 'read_file', arguments: { path: 'a/fixture.txt' } }) : response();
    const retry = vi.fn(() => 'retry' as const), tool = vi.fn(), presented = vi.fn();
    const notify = (event: { status: string }) => { if (event.status === status) throw new Error('Synthetic repair notification failure'); };
    const repair = vi.fn(asynchronous ? async (event: { status: string }) => notify(event) : notify);
    const f = fixture({ provider: 'openai-compat', tools: () => [getTools().find(value => value.name === 'read_file')!],
      onRepair: repair, onToolStart: tool, onResponse: presented, onError: retry, onProviderResponseReceived: async () => {} });
    await expect(runTurn(f.options)).rejects.toThrow('Runtime onRepair callback failed');
    expect(requests).toHaveLength(2); expect(repair.mock.calls.map(call => call[0].status)).toEqual(['started', status]);
    expect(retry).not.toHaveBeenCalled(); expect(tool).not.toHaveBeenCalled(); expect(presented).not.toHaveBeenCalled();
  }
});

it.each(['onResponse', 'onIterationEnd'] as const)('stops rejected %s presentation after a settled response', async name => {
  for (const asynchronous of [false, true]) {
    requests.length = 0;
    const retry = vi.fn(() => 'retry' as const), captured: RuntimeProviderResponseCheckpoint[] = [];
    const fail = () => { throw new Error('Synthetic presentation failure'); };
    const f = fixture({ [name]: asynchronous ? async () => fail() : fail, onError: retry,
      onProviderResponseReceived: async value => { captured.push(value); } });
    await expect(runTurn(f.options)).rejects.toThrow(`Runtime ${name} callback failed`);
    expect(requests).toHaveLength(1); expect(captured).toHaveLength(1); expect(retry).not.toHaveBeenCalled();
    expect(ledger.read(project).projection.requests[captured[0]!.checkpoint.reservationId]!.state).toBe('settled');
  }
});

it('preserves an asynchronous presentation stop without opening another provider request', async () => {
  const retry = vi.fn(() => 'retry' as const), f = fixture({ onResponse: async () => 'stop', onError: retry,
    onProviderResponseReceived: async () => {} });
  expect((await runTurn(f.options)).reason).toBe('stopped');
  expect(requests).toHaveLength(1); expect(retry).not.toHaveBeenCalled();
});

it.each([false, true])('stops a compression notification failure before primary inference (async=%s)', async asynchronous => {
  configureAutoCompressor({ enabled: true, useLlm: true, triggerThreshold: 1, preserveRecent: 1 });
  const fail = () => { throw new Error('Synthetic compression notification failure'); };
  const retry = vi.fn(() => 'retry' as const), captured: RuntimeProviderResponseCheckpoint[] = [];
  const f = fixture({ onCompression: asynchronous ? async () => fail() : fail, onError: retry,
    onProviderResponseReceived: async value => { captured.push(value); } });
  f.options.messages.current = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
    content: `Public context ${index}: ` + 'Original task facts. '.repeat(10) }));
  await expect(runTurn(f.options)).rejects.toThrow('Runtime onCompression callback failed');
  expect(requests).toHaveLength(1); expect(captured.map(value => value.purpose)).toEqual(['compression']); expect(retry).not.toHaveBeenCalled();
});

it.each(['onStreamReset', 'onRetry'] as const)('stops a rejected %s notification without runtime retry', async name => {
  for (const asynchronous of [false, true]) {
    requests.length = 0; respond = () => json({ error: { message: 'Synthetic overload' } }, 503);
    const fail = () => { throw new Error('Synthetic retry notification failure'); };
    const retry = vi.fn(() => 'retry' as const), f = fixture({ maxProviderRetries: 1,
      [name]: asynchronous ? async () => fail() : fail, onError: retry, onProviderResponseReceived: async () => {} });
    await expect(runTurn(f.options)).rejects.toThrow('Provider retry notification failed');
    expect(requests).toHaveLength(1); expect(retry).not.toHaveBeenCalled();
  }
});

it.each([false, true])('stops continuation notification failure after retained length response (async=%s)', async asynchronous => {
  respond = () => json({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Original partial answer.' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  const fail = () => { throw new Error('Synthetic continuation notification failure'); };
  const retry = vi.fn(() => 'retry' as const), f = fixture({ continueOnLength: true,
    onContinue: asynchronous ? async () => fail() : fail, onError: retry, onProviderResponseReceived: async () => {} });
  await expect(runTurn(f.options)).rejects.toThrow('Runtime onContinue callback failed');
  expect(requests).toHaveLength(1); expect(retry).not.toHaveBeenCalled();
});
