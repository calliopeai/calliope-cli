/** Real shared adapter and reservation ledger; only the provider HTTP is synthetic. */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as config from '../src/config.js';
import { chat, type ChatOptions, type ProviderResponseCheckpoint } from '../src/providers/index.js';
import { providerTarget } from '../src/health/index.js';
import { HealthStore } from '../src/health/store.js';
import { ExecutionGuard, ReservationLedger, manifestHash, type BillingProfile } from '../src/execution/index.js';
import { clearModelCache } from '../src/model-detection.js';
import { executionManifest } from './helpers/execution-manifest.js';
import { syntheticWire, wireResponse, awsEvent } from './helpers/provider-wire.js';
import type { RouteCandidate } from '../src/routing/index.js';
import type { Message, LLMResponse } from '../src/types.js';
import { ExecutionLimitError } from '../src/execution/types.js';
import { StreamProtocolError } from '../src/errors.js';
import { isRetainableResponseInterruption } from '../src/providers/response-retention.js';

let root: string, project: string, route: RouteCandidate;
let requests: string[], scenario: 'text' | 'tool' | 'error';
let respond: (body: any) => Response;
const messages: Message[] = [{ role: 'user', content: 'Public synthetic checkpoint fixture.' }];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  config.resetConfig(); clearModelCache();
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-provider-checkpoint-')));
  project = join(root, 'project'); fs.mkdirSync(project);
  vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('ANTHROPIC_BASE_URL', '');
  config.setProviderCred('anthropic', { apiKey: 'synthetic-no-vendor-authority', baseUrl: 'https://capture.invalid/v1' });
  route = { provider: 'anthropic', model: 'claude-test-model', target: providerTarget('anthropic').key,
    evidence: 'live', discoveredAt: new Date().toISOString(), capabilities: { chat: true, tools: true, streaming: true },
    contextLength: 1000000, maxOutputTokens: 8192, price: null, estimatedCost: null, latencyMs: null, errorRate: null, score: 0, reason: 'synthetic fixture' };
  const profile: BillingProfile = { provider: 'anthropic', model: route.model, target: route.target, checkedAt: Date.now(), expiresAt: Date.now() + 60000,
    sources: ['https://example.invalid/synthetic-billing'], prices: { input: 2, output: 5 }, capabilities: { tools: true, streaming: true }, admission: 'provider-count-v1' };
  const billing = join(root, 'billing.json'); fs.writeFileSync(billing, JSON.stringify({ version: 1, profiles: [profile] }), { mode: 0o600 }); vi.stubEnv('CALLIOPE_BILLING_FILE', billing);
  requests = []; scenario = 'text';
  respond = body => { const wire = syntheticWire('anthropic', scenario, !!body.stream); return wireResponse(wire.body, wire.type); };
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url); expect(url.hostname).toBe('capture.invalid'); requests.push(url.pathname);
    const body = request.method === 'POST' ? await request.json() : undefined;
    if (url.pathname.endsWith('/count_tokens')) return json({ input_tokens: 7 });
    if (url.pathname.endsWith('/models')) return json({ data: [{ id: route.model, max_input_tokens: 1000000, max_tokens: 8192 }], has_more: false });
    return respond(body);
  }));
});
afterEach(() => { config.resetConfig(); clearModelCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

function accounting(selected = route, measuredInputReservation = false) {
  const manifest = executionManifest(project); manifest.tokenBudget = 100000; manifest.costBudgetNanos = 100000000;
  for (const account of manifest.accounts) {
    account.tokenBudget = account.parentId === null ? 100000 : 50000;
    account.costBudgetNanos = account.parentId === null ? 100000000 : 50000000;
  }
  const ledger = new ReservationLedger(join(root, 'ledger')); ledger.create(manifest);
  const execution = new ExecutionGuard({ ledger, manifestHash: manifestHash(manifest), agentId: 'a', maxOutputTokens: 100, measuredInputReservation }, project);
  return { ledger, budget: execution.budget(selected, messages, [], false) };
}

const streamCases = [
  { provider: 'anthropic' as const, model: 'claude-test-model', protocol: 'anthropic' },
  { provider: 'openai' as const, model: 'gpt-5-test', protocol: 'responses' },
  { provider: 'openai' as const, model: 'gpt-4-test', protocol: 'chat' },
  { provider: 'google' as const, model: 'gemini-test', protocol: 'google' },
  { provider: 'deepseek' as const, model: 'deepseek-test', protocol: 'chat' },
  { provider: 'ollama' as const, model: 'ollama-test', protocol: 'ollama' },
  { provider: 'bedrock' as const, model: 'bedrock-test', protocol: 'bedrock' },
];
const interruptedCases = [
  ...streamCases.flatMap(value => [true, false].map(complete => ({ ...value, stream: true, complete, cancel: true, outputFails: false }))),
  ...streamCases.map(value => ({ ...value, stream: true, complete: false, cancel: false, outputFails: false })),
  ...streamCases.map(value => ({ ...value, stream: true, complete: true, cancel: false, outputFails: true })),
  { provider: 'google' as const, model: 'gemini-test', protocol: 'google', stream: false, complete: true, cancel: true, outputFails: false },
].map(value => ({ ...value, asyncOutput: false }));
interruptedCases.push(...streamCases.map(value => ({ ...value, stream: true, complete: true, cancel: false, outputFails: true, asyncOutput: true })));
it.each(interruptedCases)('retains only complete $provider/$protocol facts across interruption (stream=$stream complete=$complete cancel=$cancel outputFails=$outputFails async=$asyncOutput)', async ({ provider, model, protocol, stream, complete, cancel, outputFails, asyncOutput }) => {
  vi.stubEnv(provider.toUpperCase() + '_API_KEY', ''); vi.stubEnv(provider.toUpperCase() + '_BASE_URL', '');
  if (provider === 'google') vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '');
  if (provider === 'bedrock') {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-access-key'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret-key');
    vi.stubEnv('AWS_SESSION_TOKEN', ''); vi.stubEnv('AWS_PROFILE', ''); vi.stubEnv('AWS_REGION', 'us-east-1');
    config.setProviderCred(provider, { region: 'us-east-1' });
  } else config.setProviderCred(provider, { apiKey: 'synthetic-no-vendor-authority', baseUrl: 'https://capture.invalid/v1' });
  const selected: RouteCandidate = { ...route, provider, model, target: providerTarget(provider).key, price: { input: 2, output: 5 } };
  const { ledger, budget } = accounting(selected, true), controller = new AbortController(), captured: ProviderResponseCheckpoint[] = [];
  let atBoundary!: () => void, release!: () => void, settled!: () => void;
  const boundary = new Promise<void>(resolve => { atBoundary = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const accountingFinished = new Promise<void>(resolve => { settled = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    expect(url.hostname).toBe(provider === 'bedrock' ? 'bedrock-runtime.us-east-1.amazonaws.com' : 'capture.invalid'); requests.push(url.pathname);
    if (url.pathname.endsWith('/count_tokens')) return json({ input_tokens: 7 });
    const wire = syntheticWire(protocol, 'text', stream);
    if (!stream) {
      const response = wireResponse(wire.body, wire.type), parse = response.json.bind(response);
      response.json = async () => { atBoundary(); await released; return parse(); }; return response;
    }
    let body = wire.body;
    if (protocol === 'chat') body = Buffer.from(body.toString().replace('data: [DONE]\n\n', ''));
    if (outputFails && complete && ['chat', 'google', 'ollama'].includes(protocol)) {
      const tool = { id: 'call_terminal', type: 'function', index: 0, function: { name: 'echo', arguments: '{"text":"complete"}' } };
      if (protocol === 'chat') body = Buffer.from('data: ' + JSON.stringify({ id: 'chat_terminal', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, delta: { content: 'Complete terminal text.', tool_calls: [tool] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) + '\n\n');
      else if (protocol === 'google') body = Buffer.from('data: ' + JSON.stringify({ candidates: [{ index: 0, finishReason: 'STOP',
        content: { role: 'model', parts: [{ text: 'Complete terminal text.' }, { functionCall: { name: 'echo', args: { text: 'complete' } } }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } }) + '\n\n');
      else body = Buffer.from(JSON.stringify({ model, done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3,
        message: { role: 'assistant', content: 'Complete terminal text.', tool_calls: [{ function: { name: 'echo', arguments: { text: 'complete' } } }] } }) + '\n');
    }

    if (!complete) {
      if (protocol === 'anthropic' || protocol === 'responses') body = body.subarray(0, body.indexOf(protocol === 'anthropic' ? 'event: message_delta' : 'event: response.completed'));
      else if (protocol === 'chat') body = Buffer.from(body.toString().split('\n\n').filter(event => !event.includes('finish_reason') && !event.includes('usage') && !event.includes('[DONE]')).join('\n\n') + '\n\n');
      else if (protocol === 'google') {
        const chunk = JSON.parse(syntheticWire(protocol, 'text', false).body.toString()); delete chunk.candidates[0].finishReason;
        body = Buffer.from('data: ' + JSON.stringify(chunk) + '\n\n');
      } else if (protocol === 'ollama') body = Buffer.from(body.toString().split('\n').filter(line => line.includes('"done":false')).join('\n') + '\n');
      else {
        let offset = 0;
        while (offset < body.length) {
          const length = body.readUInt32BE(offset), frame = body.subarray(offset, offset + length);
          if (frame.includes(Buffer.from('messageStop'))) break;
          offset += length;
        }
        body = body.subarray(0, offset);
      }
    }
    let delivered = false;
    return new Response(new ReadableStream({ async pull(reader) {
      if (!delivered) { delivered = true; reader.enqueue(body); return; }
      atBoundary(); await released; reader.close();
    } }, { highWaterMark: 0 }), { headers: { 'content-type': wire.type } });
  }));
  const settlements: Parameters<typeof budget.settle>[] = [];
  const result = chat(provider, messages, [], selected.model, stream ? () => { if (outputFails) { if (asyncOutput) return Promise.reject(new Error('Synthetic asynchronous renderer failed')); throw new Error('Synthetic renderer failed'); } } : undefined, undefined, {
    maxProviderRetries: 2, onStreamReset: () => {},
    maxOutputTokens: 100, attemptBudget: { ...budget, settle: async (...args) => { settlements.push(args); await budget.settle(...args); settled(); } },
    signal: controller.signal, onResponseReceived: async checkpoint => { captured.push(checkpoint); },
  });
  const outcome = result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  try {
    await Promise.race([boundary, outcome.then(value => { throw value.error ?? new Error('Provider completed before the controlled boundary'); })]);
    if (cancel) {
      controller.abort(); expect((await outcome).error?.message).toContain('cancelled');
    } else {
      release(); const error = (await outcome).error;
      if (outputFails) expect(error?.message).toContain('Stream output was not acknowledged');
      else expect(error?.message).toMatch(/terminal proof|completion frame/);
    }
  } finally { release(); }
  await accountingFinished;
  expect(settlements).toHaveLength(1); expect(requests.filter(path => !path.endsWith('/count_tokens'))).toHaveLength(1);
  if (complete) {
    expect(captured).toHaveLength(1); expect(captured[0]!.response.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(settlements[0]![2]).toEqual({ inputTokens: 7, outputTokens: 3 }); expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
    if (outputFails && ['chat', 'google', 'ollama'].includes(protocol)) expect(captured[0]!.response.toolCalls).toEqual([expect.objectContaining({ name: 'echo', arguments: { text: 'complete' } })]);
  } else {
    expect(captured).toEqual([]); expect(settlements[0]![2]).toBeUndefined();
    expect(Object.values(ledger.read(project).projection.requests).map(entry => entry.state)).toEqual(['unknown']);
    expect(ledger.read(project).projection.spent.costNanos).toBeGreaterThan(0);
  }
});

it.each(['zero', 'bad-length', 'bad-headers', 'short-header'])('holds a malformed Bedrock trailer without hanging or retrying (%s)', async scenario => {
  const child = join(root, 'child'); fs.mkdirSync(child, { mode: 0o700 });
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/bedrock-frame-retention.mjs', import.meta.url)), child, scenario], {
    timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: join(child, 'home'), CALLIOPE_CONFIG_DIR: join(child, 'config'), CALLIOPE_HEALTH_DIR: join(child, 'health'),
      VITEST: '1', AWS_ACCESS_KEY_ID: 'synthetic-access-key', AWS_SECRET_ACCESS_KEY: 'synthetic-secret-key', AWS_REGION: 'us-east-1', NO_COLOR: '1' },
  });
  const proof = JSON.parse(result.stdout);
  expect(proof.error).toMatch(/invalid frame lengths|header exceeds its frame|malformed JSON|empty event payload|invalid prelude checksum/);
  expect(proof).toMatchObject({ calls: 1, checkpoints: 0, settlements: 1, states: ['unknown'] }); expect(proof.spent.costNanos).toBeGreaterThan(0);
}, 20000);

it('keeps complete terminal facts after a renderer failure followed by presentation-size overflow', async () => {
  vi.stubEnv('GOOGLE_API_KEY', ''); vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '');
  config.setProviderCred('google', { apiKey: 'synthetic', baseUrl: 'https://capture.invalid/v1' });
  const selected: RouteCandidate = { ...route, provider: 'google', model: 'gemini-test', target: providerTarget('google').key, price: { input: 2, output: 5 } };
  const { ledger, budget } = accounting(selected, true), captured: ProviderResponseCheckpoint[] = [], output = vi.fn(() => { throw new Error('Renderer failed'); });
  const content = 'x'.repeat(1024 * 1024 + 1);
  vi.stubGlobal('fetch', vi.fn(async () => {
    const chunks = [{ candidates: [{ content: { role: 'model', parts: [{ text: 'first' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: content }, { functionCall: { name: 'echo', args: { text: 'complete' } } }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } }];
    return new Response(chunks.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  }));
  await expect(chat('google', messages, [], selected.model, output, undefined, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: () => {}, onResponseReceived: async value => { captured.push(value); },
  })).rejects.toThrow('Stream output was not acknowledged');
  expect(fetch).toHaveBeenCalledTimes(1); expect(output).toHaveBeenCalledTimes(1); expect(captured).toHaveLength(1);
  expect(captured[0]!.response.content).toBe('first' + content); expect(captured[0]!.response.toolCalls).toEqual([expect.objectContaining({ name: 'echo', arguments: { text: 'complete' } })]);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});

it.each(['before', 'after', 'empty-after', 'null-before', 'null-after', 'array-after', 'bad-fields-after'])('refuses malformed Bedrock JSON without a completion checkpoint or retry (%s)', async scenario => {
  vi.stubEnv('BEDROCK_BASE_URL', ''); vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-access-key'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret-key');
  vi.stubEnv('AWS_SESSION_TOKEN', ''); vi.stubEnv('AWS_PROFILE', ''); vi.stubEnv('AWS_REGION', 'us-east-1');
  config.setProviderCred('bedrock', { region: 'us-east-1' });
  const selected: RouteCandidate = { ...route, provider: 'bedrock', model: 'bedrock-test', target: providerTarget('bedrock').key, price: { input: 2, output: 5 } };
  const { ledger, budget } = accounting(selected, true), captured = vi.fn(async () => {}), retry = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); expect(url.hostname).toBe('bedrock-runtime.us-east-1.amazonaws.com');
    const wire = syntheticWire('bedrock', 'text', true), bad = scenario.startsWith('null-') ? awsEvent('contentBlockDelta', null) : scenario === 'array-after' ? awsEvent('contentBlockDelta', []) : scenario === 'bad-fields-after' ? awsEvent('contentBlockDelta', { delta: { text: 42 } }) : awsEvent('contentBlockDelta', null, scenario === 'empty-after' ? Buffer.alloc(0) : Buffer.from('{'));
    return wireResponse(scenario.endsWith('before') ? Buffer.concat([bad, wire.body]) : Buffer.concat([wire.body, bad]), wire.type);
  }));
  await expect(chat('bedrock', messages, [], selected.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: () => {}, onResponseReceived: captured,
  })).rejects.toThrow(/malformed JSON|empty event payload|invalid event object|invalid event fields/);
  expect(fetch).toHaveBeenCalledTimes(1); expect(captured).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  const saved = ledger.read(project); expect(Object.values(saved.projection.requests).map(value => value.state)).toEqual(['unknown']); expect(saved.projection.spent.costNanos).toBeGreaterThan(0);
});

it.each([false, true])('retains exact attempt/response before settlement (stream=%s)', async stream => {
  const { ledger, budget } = accounting(), captured: ProviderResponseCheckpoint[] = [], observedStates: string[] = [];
  const result = await chat('anthropic', messages, [], route.model, stream ? () => {} : undefined, undefined, {
    maxOutputTokens: 100, attemptBudget: budget, onResponseReceived: async checkpoint => {
      captured.push(structuredClone(checkpoint)); observedStates.push(ledger.read(project).projection.requests[checkpoint.reservationId]!.state);
      (checkpoint.response as LLMResponse).content = 'A host observer cannot replace the processed response.';
    },
  });
  expect(captured).toHaveLength(1); expect(observedStates).toEqual(['pending']);
  expect(captured[0]).toMatchObject({ version: 1, provider: 'anthropic', model: route.model, target: route.target, attempt: 1, usageReported: true, response: { finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 3 } } });
  expect(result.content).toBe(captured[0]!.response.content);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});

it.each([false, true])('a lost checkpoint acknowledgment never retries the provider (stream=%s)', async stream => {
  const { ledger, budget } = accounting(), retried = vi.fn(), checkpoint = vi.fn(async () => { throw new Error('Lost original checkpoint acknowledgment'); });
  await expect(chat('anthropic', messages, [], route.model, stream ? () => {} : undefined, retried, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: vi.fn(), onResponseReceived: checkpoint,
  })).rejects.toThrow('response checkpoint was not acknowledged');
  expect(checkpoint).toHaveBeenCalledTimes(1); expect(retried).not.toHaveBeenCalled();
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});

it.each(['remove', 'replace'].flatMap(change => [false, true].map(cancel => ({ change, cancel }))))('pins the original response writer across admission ($change, cancel=$cancel)', async ({ change, cancel }) => {
  const { ledger, budget } = accounting(), controller = new AbortController(), captured: ProviderResponseCheckpoint[] = [], replacement = vi.fn(async () => {});
  let admitted!: () => void, release!: () => void, settled!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const accountingFinished = new Promise<void>(resolve => { settled = resolve; });
  const options: ChatOptions = {
    maxOutputTokens: 100, signal: controller.signal, attemptBudget: { ...budget,
      reserve: async request => { const ticket = await budget.reserve(request); admitted(); await gate; return ticket; },
      settle: async (...args) => { await budget.settle(...args); settled(); },
    },
    onResponseReceived: async value => { captured.push(value); if (cancel) controller.abort(); },
  };
  const pending = chat('anthropic', messages, [], route.model, undefined, undefined, options);
  const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  await Promise.race([admission, outcome.then(value => { throw value.error ?? new Error('Completed before controlled admission'); })]);
  if (change === 'remove') delete options.onResponseReceived;
  else options.onResponseReceived = replacement;
  if (cancel) options.signal = new AbortController().signal;
  release(); const result = await outcome; await accountingFinished;
  if (cancel) expect(result.error?.message).toContain('cancelled');
  else expect(result.value?.finishReason).toBe('stop');
  expect(captured).toHaveLength(1); expect(replacement).not.toHaveBeenCalled();
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1); expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});

it('preserves a received response while cancellation stops further execution', async () => {
  const { ledger, budget } = accounting(), controller = new AbortController(), captured: ProviderResponseCheckpoint[] = [];
  let settled!: () => void, failed!: (error: unknown) => void;
  const accountingFinished = new Promise<void>((resolve, reject) => { settled = resolve; failed = reject; });
  const observedBudget = { ...budget, settle: async (...args: Parameters<typeof budget.settle>) => {
    try { await budget.settle(...args); settled(); } catch (error) { failed(error); throw error; }
  } };
  await expect(chat('anthropic', messages, [], route.model, undefined, undefined, {
    maxOutputTokens: 100, attemptBudget: observedBudget, signal: controller.signal, onResponseReceived: async checkpoint => { captured.push(checkpoint); controller.abort(); },
  })).rejects.toThrow();
  // Cancellation may return before the original accounting write acknowledges.
  await accountingFinished;
  expect(captured).toHaveLength(1); expect(captured[0]!.response.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});

it('keeps absent usage unknown and retains the original reservation', async () => {
  const { ledger, budget } = accounting(), captured: ProviderResponseCheckpoint[] = [];
  respond = () => json({ id: 'msg_missing_usage', type: 'message', role: 'assistant', model: route.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'Synthetic result without usage.' }] });
  await chat('anthropic', messages, [], route.model, undefined, undefined, { maxOutputTokens: 100, attemptBudget: budget, onResponseReceived: async checkpoint => { captured.push(checkpoint); } });
  expect(captured[0]).toMatchObject({ usageReported: false }); expect(captured[0]!.response.usage).toBeUndefined();
  const saved = ledger.read(project); expect(saved.projection.requests[captured[0]!.reservationId]!.state).toBe('unknown'); expect(saved.projection.spent.costNanos).toBeGreaterThan(29000);
});

it('accounts a late response exactly once after caller cancellation', async () => {
  const { ledger, budget } = accounting(), controller = new AbortController();
  let parsing!: () => void, release!: () => void, settled!: () => void;
  const parseStarted = new Promise<void>(resolve => { parsing = resolve; });
  const parseReleased = new Promise<void>(resolve => { release = resolve; });
  const accountingFinished = new Promise<void>(resolve => { settled = resolve; });
  const normal = respond;
  respond = body => {
    const response = normal(body), parse = response.json.bind(response);
    response.json = async () => { parsing(); await parseReleased; return parse(); };
    return response;
  };
  const settlements: Parameters<typeof budget.settle>[] = [], captured: ProviderResponseCheckpoint[] = [];
  const observedBudget = { ...budget, settle: async (...args: Parameters<typeof budget.settle>) => {
    settlements.push(args); await budget.settle(...args); settled();
  } };
  const result = chat('anthropic', messages, [], route.model, undefined, undefined, {
    maxOutputTokens: 100, attemptBudget: observedBudget, signal: controller.signal,
    onResponseReceived: async checkpoint => { captured.push(checkpoint); },
  });
  const cancelled = expect(result).rejects.toThrow('cancelled');
  await parseStarted; controller.abort(); await cancelled;
  // The adapter has not finished: retain its original reservation without
  // committing an irreversible unknown settlement before usage can arrive.
  try {
    expect(settlements).toEqual([]);
    expect(Object.values(ledger.read(project).projection.requests).map(entry => entry.state)).toEqual(['pending']);
  } finally { release(); }
  await accountingFinished;
  expect(captured).toHaveLength(1); expect(settlements).toHaveLength(1);
  expect(settlements[0]).toEqual([captured[0]!.reservationId, 'success', { inputTokens: 7, outputTokens: 3 }]);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
});

it('does not retry failed checkpoint acknowledgment when terminal notification also fails', async () => {
  const { ledger, budget } = accounting(), retry = vi.fn();
  await expect(chat('anthropic', messages, [], route.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2,
    onStreamReset: vi.fn(), onResponseReceived: async () => { throw new Error('Lost checkpoint acknowledgment'); },
    onStreamEvent: event => { if (event.state === 'failed') throw new Error('Lost stream event acknowledgment'); },
  })).rejects.toThrow('response checkpoint was not acknowledged');
  expect(retry).not.toHaveBeenCalled();
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
}, 15000);

it('preserves accounting failure when terminal notification also fails', async () => {
  const { ledger, budget } = accounting(), retry = vi.fn(), failure = new ExecutionLimitError('unavailable', 'Original accounting acknowledgment failed');
  const settlement = vi.fn(async () => { throw failure; });
  await expect(chat('anthropic', messages, [], route.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: { ...budget, settle: settlement }, maxProviderRetries: 2,
    onStreamReset: vi.fn(), onResponseReceived: async () => {},
    onStreamEvent: event => { if (event.state === 'failed') throw new Error('Lost terminal event acknowledgment'); },
  })).rejects.toBe(failure);
  expect(settlement).toHaveBeenCalledTimes(1); expect(retry).not.toHaveBeenCalled();
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
  expect(Object.values(ledger.read(project).projection.requests).map(entry => entry.state)).toEqual(['pending']);
});

it.each([false, true])('does not repeat a completed response after terminal notification fails (checkpoint=%s)', async checkpoint => {
  const { ledger, budget } = accounting(), retry = vi.fn();
  await expect(chat('anthropic', messages, [], route.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: vi.fn(),
    ...(checkpoint ? { onResponseReceived: async () => {} } : {}),
    onStreamEvent: event => { if (event.state === 'completed') throw new Error('Lost completed event acknowledgment'); },
  })).rejects.toThrow('Terminal stream notification was not acknowledged');
  expect(retry).not.toHaveBeenCalled(); expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});

it.each([false, true])('a failed health diagnostic cannot repeat an acknowledged response (stream=%s)', async stream => {
  const { ledger, budget } = accounting(), retry = vi.fn(), warning = vi.fn(() => { throw new Error('Health presentation failed'); });
  const health = join(root, 'broken-health'); vi.stubEnv('CALLIOPE_HEALTH_DIR', health);
  const result = await chat('anthropic', messages, [], route.model, stream ? () => {} : undefined, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: vi.fn(),
    onResponseReceived: async () => { fs.writeFileSync(health, 'A real filesystem failure, not a directory.'); }, onHealthWarning: warning,
  });
  expect(result.finishReason).toBe('stop'); expect(warning).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled(); expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});

it('preserves an accounting failure even if its health diagnostic throws', async () => {
  const { ledger, budget } = accounting(), retry = vi.fn(), failure = new ExecutionLimitError('unavailable', 'Original accounting acknowledgment failed');
  const settlement = vi.fn(async () => { throw failure; }), health = join(root, 'broken-health'); vi.stubEnv('CALLIOPE_HEALTH_DIR', health);
  await expect(chat('anthropic', messages, [], route.model, undefined, retry, {
    maxOutputTokens: 100, attemptBudget: { ...budget, settle: settlement }, maxProviderRetries: 2,
    onResponseReceived: async () => { fs.writeFileSync(health, 'Not a directory.'); },
    onHealthWarning: () => { throw new Error('Health presentation failed'); },
  })).rejects.toBe(failure);
  expect(settlement).toHaveBeenCalledTimes(1); expect(retry).not.toHaveBeenCalled();
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
  expect(Object.values(ledger.read(project).projection.requests).map(entry => entry.state)).toEqual(['pending']);
});

it('settles a failed initial stream notification once without dispatching or retrying inference', async () => {
  const { ledger, budget } = accounting(), retry = vi.fn(), settlement = vi.fn(budget.settle);
  await expect(chat('anthropic', messages, [], route.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: { ...budget, settle: settlement }, maxProviderRetries: 2, onStreamReset: vi.fn(),
    onResponseReceived: async () => {}, onStreamEvent: event => { if (event.state === 'started') throw new Error('Initial notification failed'); },
  })).rejects.toThrow('Stream notification was not acknowledged');
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(0); expect(settlement).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();
  const saved = ledger.read(project); expect(Object.values(saved.projection.requests).map(entry => entry.state)).toEqual(['unknown']);
  expect(saved.projection.spent.costNanos).toBeGreaterThan(0);
});

it('does not retry a failed stream output callback', async () => {
  const { ledger, budget } = accounting(), retry = vi.fn();
  await expect(chat('anthropic', messages, [], route.model, () => { throw new Error('Output presentation failed'); }, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: vi.fn(), onResponseReceived: async () => {},
  })).rejects.toThrow('Stream output was not acknowledged');
  expect(retry).not.toHaveBeenCalled(); expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
  expect(Object.values(ledger.read(project).projection.requests).map(entry => entry.state)).toEqual(['settled']);
  expect(ledger.read(project).projection.spent.costNanos).toBe(29000);
});

it('refuses an endpoint change in the started callback before generation dispatch', async () => {
  const { ledger, budget } = accounting(), retry = vi.fn();
  await expect(chat('anthropic', messages, [], route.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: vi.fn(), onResponseReceived: async () => {},
    onStreamEvent: event => { if (event.state === 'started') config.setProviderCred('anthropic', { apiKey: 'synthetic-no-vendor-authority', baseUrl: 'https://unadmitted.invalid/v1' }); },
  })).rejects.toThrow('Provider endpoint changed before dispatch');
  expect(retry).not.toHaveBeenCalled(); expect(requests.filter(path => path === '/v1/messages')).toHaveLength(0);
  expect(Object.values(ledger.read(project).projection.requests).map(entry => entry.state)).toEqual(['unknown']);
});

it('does not block authorized inference when the initial health warning throws', async () => {
  const { budget } = accounting(), health = join(root, 'initial-broken-health'), warning = vi.fn(() => { throw new Error('Health presentation failed'); });
  fs.writeFileSync(health, 'Not a directory.'); vi.stubEnv('CALLIOPE_HEALTH_DIR', health);
  const result = await chat('anthropic', messages, [], route.model, undefined, undefined, {
    maxOutputTokens: 100, attemptBudget: budget, onResponseReceived: async () => {}, onHealthWarning: warning,
  });
  expect(result.finishReason).toBe('stop'); expect(warning).toHaveBeenCalled(); expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
});

it('retains an automatic quarantine denial even when its notification throws', async () => {
  const { budget } = accounting(), health = join(root, 'quarantined-health'); vi.stubEnv('CALLIOPE_HEALTH_DIR', health);
  const store = new HealthStore();
  for (let n = 0; n < 3; n++) store.append({ provider: 'anthropic', target: route.target, type: 'attempt', outcome: 'error', failure: 'server' });
  await expect(chat('anthropic', messages, [], route.model, undefined, undefined, {
    maxOutputTokens: 100, attemptBudget: budget, selectionMode: 'auto', onResponseReceived: async () => {},
    onHealthWarning: () => { throw new Error('Quarantine presentation failed'); },
  })).rejects.toThrow('automatic inference stopped before dispatch');
  expect(requests).toEqual([]);
});

it('captures complete adapter content before common truncation', async () => {
  const { budget } = accounting(), content = 'x'.repeat(2000000), captured: ProviderResponseCheckpoint[] = [];
  respond = () => json({ id: 'msg_long', type: 'message', role: 'assistant', model: route.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: content }], usage: { input_tokens: 7, output_tokens: 3 } });
  const result = await chat('anthropic', messages, [], route.model, undefined, undefined, { maxOutputTokens: 100, attemptBudget: budget, onResponseReceived: async checkpoint => { captured.push(checkpoint); } });
  expect(captured[0]!.response.content).toBe(content); expect(result.content.length).toBeLessThan(content.length); expect(result.content).toContain('[truncated]');
});

it('retains refusal diagnostics before stream rejection', async () => {
  const { budget } = accounting(), captured: ProviderResponseCheckpoint[] = []; scenario = 'error';
  await expect(chat('anthropic', messages, [], route.model, () => {}, undefined, { maxOutputTokens: 100, attemptBudget: budget, onResponseReceived: async checkpoint => { captured.push(checkpoint); } })).rejects.toThrow();
  expect(captured).toHaveLength(1); expect(captured[0]!.response).toMatchObject({ finishReason: 'error', errorCode: 'refusal' });
});

it('keeps tool arguments detached from the host observer', async () => {
  const { budget } = accounting(); scenario = 'tool'; let captured: ProviderResponseCheckpoint | undefined;
  const result = await chat('anthropic', messages, [], route.model, undefined, undefined, {
    maxOutputTokens: 100, attemptBudget: budget, onResponseReceived: async checkpoint => {
      captured = structuredClone(checkpoint);
      checkpoint.response.toolCalls![0]!.arguments.text = 'Observer mutation';
    },
  });
  expect(captured!.response).toMatchObject({ finishReason: 'tool_use', toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'hello' } }] });
  expect(result.toolCalls).toEqual(captured!.response.toolCalls);
});

it('correlates a returned response with its own retry reservation', async () => {
  const { ledger, budget } = accounting(), captured: ProviderResponseCheckpoint[] = [];
  const normal = respond; let calls = 0;
  respond = body => ++calls === 1 ? json({ type: 'error', error: { type: 'overloaded_error', message: 'Synthetic overload' } }, 529) : normal(body);
  await chat('anthropic', messages, [], route.model, undefined, undefined, {
    maxOutputTokens: 100, maxProviderRetries: 1, attemptBudget: budget, onResponseReceived: async checkpoint => { captured.push(checkpoint); },
  });
  expect(calls).toBe(2); expect(captured).toHaveLength(1); expect(captured[0]!.attempt).toBe(2);
  const saved = ledger.read(project); expect(Object.keys(saved.projection.requests)).toHaveLength(2);
  expect(saved.projection.requests[captured[0]!.reservationId]!.reservation.model).toBe(route.model);
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(2);
});

it('distinguishes explicitly reported zero usage from absent usage', async () => {
  const { ledger, budget } = accounting(), captured: ProviderResponseCheckpoint[] = [];
  respond = () => json({ id: 'msg_zero', type: 'message', role: 'assistant', model: route.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'Synthetic zero usage.' }], usage: { input_tokens: 0, output_tokens: 0 } });
  await chat('anthropic', messages, [], route.model, undefined, undefined, { maxOutputTokens: 100, attemptBudget: budget, onResponseReceived: async checkpoint => { captured.push(checkpoint); } });
  expect(captured[0]).toMatchObject({ usageReported: true, response: { usage: { inputTokens: 0, outputTokens: 0 } } });
  expect(ledger.read(project).projection.spent.costNanos).toBe(0);
});

it('refuses an unexpected acknowledgment value without another provider call', async () => {
  const { budget } = accounting();
  const invalid = (async () => ({ accepted: true })) as unknown as ChatOptions['onResponseReceived'];
  await expect(chat('anthropic', messages, [], route.model, undefined, undefined, {
    maxOutputTokens: 100, maxProviderRetries: 2, attemptBudget: budget, onResponseReceived: invalid,
  })).rejects.toThrow('response checkpoint was not acknowledged');
  expect(requests.filter(path => path === '/v1/messages')).toHaveLength(1);
});

it.each([undefined, 'invalid callback'])('refuses an unaccounted or malformed checkpoint host before transport (%s)', async callback => {
  const options = { onResponseReceived: callback ?? (async () => {}) } as unknown as ChatOptions;
  await expect(chat('anthropic', messages, [], route.model, undefined, undefined, options)).rejects.toThrow('Response checkpoints require'); expect(requests).toEqual([]);
});

it.each(['', 'bad\nreservation'])('refuses a malformed native reservation before dispatch (%s)', async reservation => {
  await expect(chat('anthropic', messages, [], route.model, undefined, undefined, {
    maxOutputTokens: 100, attemptBudget: { reserve: async () => reservation, settle: async () => {} }, onResponseReceived: async () => {},
  })).rejects.toThrow('no valid native reservation'); expect(requests).toEqual([]);
});

it.each(['malformed', 'null', 'array', 'fields'])('holds a damaged Ollama trailer after completion without a checkpoint (%s)', async scenario => {
  vi.stubEnv('OLLAMA_BASE_URL', ''); config.setProviderCred('ollama', { baseUrl: 'https://capture.invalid/v1' });
  const selected: RouteCandidate = { ...route, provider: 'ollama', model: 'ollama-test', target: providerTarget('ollama').key, price: { input: 2, output: 5 } };
  const { ledger, budget } = accounting(selected, true), captured = vi.fn(async () => {}), retry = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => {
    const wire = syntheticWire('ollama', 'text', true);
    const trailer = scenario === 'malformed' ? '{' : scenario === 'null' ? 'null' : scenario === 'array' ? '[]' : '{"done":"false"}';
    return wireResponse(Buffer.concat([wire.body, Buffer.from(trailer + '\n')]), wire.type);
  }));
  await expect(chat('ollama', messages, [], selected.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: () => {}, onResponseReceived: captured,
  })).rejects.toThrow(/Malformed JSON|Invalid Ollama stream/);
  expect(fetch).toHaveBeenCalledTimes(1); expect(captured).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  const saved = ledger.read(project); expect(Object.values(saved.projection.requests).map(value => value.state)).toEqual(['unknown']); expect(saved.projection.spent.costNanos).toBeGreaterThan(0);
});

const malformedSdkTrailers = [
  { provider: 'openai' as const, model: 'gpt-4-test', protocol: 'chat', tail: 'data: {"choices":{},"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n' },
  { provider: 'deepseek' as const, model: 'deepseek-test', protocol: 'chat', tail: 'data: {"choices":{},"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n' },
  { provider: 'openai' as const, model: 'gpt-4-test', protocol: 'chat', tail: 'data: {"choices":null}\n\n' },
  { provider: 'deepseek' as const, model: 'deepseek-test', protocol: 'chat', tail: 'data: {"choices":null}\n\n' },
  { provider: 'openai' as const, model: 'gpt-5-test', protocol: 'responses', tail: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":42}\n\n' },
  { provider: 'anthropic' as const, model: 'claude-test-model', protocol: 'anthropic', tail: 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":null}\n\n' },
  { provider: 'google' as const, model: 'gemini-test', protocol: 'google', tail: 'data: {"candidates":42}\n\n' },
];
it.each(malformedSdkTrailers.flatMap(value => [false,true].map(before => ({ ...value, before }))))('holds malformed $provider/$protocol data (before terminal=$before)', async ({ provider, model, protocol, tail, before }) => {
  vi.stubEnv(provider.toUpperCase() + '_API_KEY', ''); vi.stubEnv(provider.toUpperCase() + '_BASE_URL', '');
  if (provider === 'google') vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '');
  config.setProviderCred(provider, { apiKey: 'synthetic', baseUrl: 'https://capture.invalid/v1' });
  const selected: RouteCandidate = { ...route, provider, model, target: providerTarget(provider).key, price: { input: 2, output: 5 } };
  const { ledger, budget } = accounting(selected, true), captured = vi.fn(async () => {}), retry = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/count_tokens')) return json({ input_tokens: 7 });
    const wire = syntheticWire(protocol, 'text', true);
    const body = (before ? '' : wire.body.toString().replace('data: [DONE]\n\n', '')) + tail;
    return wireResponse(Buffer.from(body), wire.type);
  }));
  await expect(chat(provider, messages, [], model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: () => {}, onResponseReceived: captured,
  })).rejects.toBeInstanceOf(Error);
  expect(captured).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  const saved = ledger.read(project); expect(Object.values(saved.projection.requests).map(value => value.state)).toEqual(['unknown']); expect(saved.projection.spent.costNanos).toBeGreaterThan(0);
});

const malformedOllamaTerminals = [
  { name: 'numeric done reason', fields: { done_reason: 42 } },
  { name: 'null done reason', fields: { done_reason: null } },
  { name: 'null tool', fields: { message: { tool_calls: [null] } } },
  { name: 'null tool function', fields: { message: { tool_calls: [{ function: null }] } } },
  { name: 'numeric tool name', fields: { message: { tool_calls: [{ function: { name: 42, arguments: {} } }] } } },
  { name: 'array tool arguments', fields: { message: { tool_calls: [{ function: { name: 'echo', arguments: [] } }] } } },
];
it.each(malformedOllamaTerminals.flatMap(value => [false, true].map(after => ({ ...value, after }))))('holds malformed Ollama terminal $name (after valid terminal=$after)', async ({ fields, after }) => {
  vi.stubEnv('OLLAMA_BASE_URL', ''); config.setProviderCred('ollama', { baseUrl: 'https://capture.invalid/v1' });
  const selected: RouteCandidate = { ...route, provider: 'ollama', model: 'ollama-test', target: providerTarget('ollama').key, price: { input: 2, output: 5 } };
  const { ledger, budget } = accounting(selected, true), captured = vi.fn(async () => {}), retry = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => {
    const wire = syntheticWire('ollama', 'text', true);
    const terminal = JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 0, eval_count: 0, ...fields });
    return wireResponse(Buffer.concat([after ? wire.body : Buffer.alloc(0), Buffer.from(terminal + '\n')]), wire.type);
  }));
  await expect(chat('ollama', messages, [], selected.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: () => {}, onResponseReceived: captured,
  })).rejects.toThrow(/Invalid Ollama stream event fields/);
  expect(fetch).toHaveBeenCalledTimes(1); expect(captured).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  const saved = ledger.read(project); expect(Object.values(saved.projection.requests).map(value => value.state)).toEqual(['unknown']); expect(saved.projection.spent.costNanos).toBeGreaterThan(0);
});

it.each(['prelude', 'message'].flatMap(checksum => ['messageStop', 'metadata', 'trailer'].map(event => ({ checksum, event }))))('holds checksum-invalid Bedrock $event ($checksum)', async ({ checksum, event }) => {
  vi.stubEnv('BEDROCK_BASE_URL', ''); vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-access-key'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret-key');
  vi.stubEnv('AWS_SESSION_TOKEN', ''); vi.stubEnv('AWS_PROFILE', ''); vi.stubEnv('AWS_REGION', 'us-east-1');
  config.setProviderCred('bedrock', { region: 'us-east-1' });
  const selected: RouteCandidate = { ...route, provider: 'bedrock', model: 'bedrock-test', target: providerTarget('bedrock').key, price: { input: 2, output: 5 } };
  const { ledger, budget } = accounting(selected, true), captured = vi.fn(async () => {}), retry = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => {
    const wire = syntheticWire('bedrock', 'text', true), frames: Buffer[] = [];
    for (let offset = 0; offset < wire.body.length;) {
      const length = wire.body.readUInt32BE(offset); frames.push(Buffer.from(wire.body.subarray(offset, offset + length))); offset += length;
    }
    const bad = event === 'messageStop' ? frames.at(-2)! : event === 'metadata' ? frames.at(-1)! : awsEvent('metadata', { usage: { inputTokens: 7, outputTokens: 3 } });
    const index = checksum === 'prelude' ? 8 : bad.length - 4; bad[index] = bad[index]! ^ 1;
    if (event === 'trailer') frames.push(bad);
    return wireResponse(Buffer.concat(frames), wire.type);
  }));
  await expect(chat('bedrock', messages, [], selected.model, () => {}, retry, {
    maxOutputTokens: 100, attemptBudget: budget, maxProviderRetries: 2, onStreamReset: () => {}, onResponseReceived: captured,
  })).rejects.toThrow(`invalid ${checksum} checksum`);
  expect(fetch).toHaveBeenCalledTimes(1); expect(captured).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  const saved = ledger.read(project); expect(Object.values(saved.projection.requests).map(value => value.state)).toEqual(['unknown']); expect(saved.projection.spent.costNanos).toBeGreaterThan(0);
});

it('retains only identified interruption causes and rejects parse failures or cyclic causes', () => {
  const aborted = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  const disconnected = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  const connection = Object.assign(new Error('connection failed'), { name: 'APIConnectionError' });
  for (const error of [aborted, disconnected, connection, new TypeError('terminated', { cause: disconnected })])
    expect(isRetainableResponseInterruption(error)).toBe(true);
  const disguisedParseFailure = Object.assign(new Error('connection wrapper', { cause: new SyntaxError('invalid JSON') }), { name: 'APIConnectionError' });
  const cyclic = Object.assign(new Error('cyclic connection'), { name: 'APIConnectionError' }); cyclic.cause = cyclic;
  for (const error of [new Error('unknown'), new TypeError('invalid shape'), new SyntaxError('invalid JSON'), new StreamProtocolError('invalid frame'), disguisedParseFailure, cyclic])
    expect(isRetainableResponseInterruption(error)).toBe(false);
});

it.each([false, true])('strict native response validates nonstream Ollama completion (%s)', async done => {
  vi.stubEnv('OLLAMA_BASE_URL', ''); config.setProviderCred('ollama', { baseUrl: 'https://capture.invalid/v1' });
  const selected: RouteCandidate = { ...route, provider: 'ollama', model: 'ollama-test', target: providerTarget('ollama').key, price: { input: 2, output: 5 } };
  const { ledger, budget } = accounting(selected, true), captured = vi.fn(async () => {}), retry = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => json({ done, done_reason: 'stop', message: { role: 'assistant', content: 'candidate' }, prompt_eval_count: 7, eval_count: 3 })));
  const operation=chat('ollama',messages,[],selected.model,undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onResponseReceived:captured});
  if (done) { await operation; expect(captured).toHaveBeenCalledTimes(1); expect(ledger.read(project).projection.spent.costNanos).toBe(29000); }
  else { await expect(operation).rejects.toThrow(/incomplete Ollama/); expect(captured).not.toHaveBeenCalled(); expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']); }
  expect(fetch).toHaveBeenCalledTimes(1); expect(retry).not.toHaveBeenCalled();
});
it.each(['', '{"done":', 'utf8'])('strict native response refuses partial Ollama trailer (%s)', async suffix => {
  vi.stubEnv('OLLAMA_BASE_URL', ''); config.setProviderCred('ollama', { baseUrl: 'https://capture.invalid/v1' });
  const selected: RouteCandidate = { ...route, provider: 'ollama', model: 'ollama-test', target: providerTarget('ollama').key, price: { input: 2, output: 5 } };
  const {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
  vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('ollama','text',true);let phase=0;
    return new Response(new ReadableStream({pull(reader){if(phase++===0){reader.enqueue(wire.body);return;}if(phase===2){reader.enqueue(suffix==='utf8'?new Uint8Array([0xc3]):Buffer.from(suffix));return;}reader.error(Object.assign(new Error('synthetic disconnect'),{code:'ECONNRESET'}));}}),{headers:{'content-type':wire.type}});
  }));
  await expect(chat('ollama',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(Error);
  expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();expect(captured).toHaveBeenCalledTimes(suffix?0:1);
  const state=Object.values(ledger.read(project).projection.requests)[0]!.state;expect(state).toBe(suffix?'unknown':'settled');
});
it('strict native response rejects schema TypeError hidden by connection wrapper',()=>{
 const error=Object.assign(new Error('wrapper',{cause:new TypeError('bad schema')}),{name:'APIConnectionError'});
 expect(isRetainableResponseInterruption(error)).toBe(false);
});

it.each(['started','completed','failed','retrying'] as const)('awaits rejected asynchronous stream event %s without provider retry', async state => {
  const {ledger,budget}=accounting(),captured=vi.fn(async()=>{}),retry=vi.fn();
  if (state==='failed'||state==='retrying') respond=()=>json({error:{message:'Synthetic overload'}},503);
  await expect(chat('anthropic',messages,[],route.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured,
    onStreamEvent:async event=>{if(event.state===state)throw new Error('Synthetic asynchronous event rejection');},
  })).rejects.toThrow(`${['completed','failed'].includes(state) ? 'Terminal stream' : 'Stream'} notification was not acknowledged`);
  expect(requests.filter(path=>!path.endsWith('/count_tokens'))).toHaveLength(state==='started'?0:1);
  expect(captured).toHaveBeenCalledTimes(state==='completed'?1:0);expect(retry).not.toHaveBeenCalled();
  expect(Object.keys(ledger.read(project).projection.requests)).toHaveLength(1);
});
it('awaits the started event acknowledgement before provider transport',async()=>{
 const {budget}=accounting();let started!:()=>void,release!:()=>void;
 const observed=new Promise<void>(resolve=>{started=resolve;}),acknowledged=new Promise<void>(resolve=>{release=resolve;});
 const operation=chat('anthropic',messages,[],route.model,()=>{},undefined,{maxOutputTokens:100,attemptBudget:budget,onResponseReceived:async()=>{},onStreamEvent:event=>{if(event.state==='started'){started();return acknowledged;}}});
 await observed;expect(requests.filter(path=>!path.endsWith('/count_tokens'))).toHaveLength(0);release();await operation;
 expect(requests.filter(path=>!path.endsWith('/count_tokens'))).toHaveLength(1);
});

it.each(['openai','deepseek'] as const)('holds regressed cumulative %s usage after a valid completion',async provider=>{
 const model=provider==='openai'?'gpt-4-test':'deepseek-test';vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}};
 const {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('chat','text',true);return wireResponse(Buffer.from(wire.body.toString().replace('data: [DONE]\n\n','')+'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n'),wire.type);}));
 await expect(chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toThrow('Provider chat usage regressed');
 expect(fetch).toHaveBeenCalledTimes(1);expect(captured).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);expect(ledger.read(project).projection.spent.costNanos).toBeGreaterThan(0);
});

const framedSdkCases=streamCases.filter(value=>!['ollama','bedrock'].includes(value.protocol));
it.each(framedSdkCases.flatMap(value=>['','partial','utf8'].map(suffix=>({...value,suffix}))))('SDK framing witness $provider/$protocol trailing $suffix',async({provider,model,protocol,suffix})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');if(provider==='google')vi.stubEnv('GOOGLE_GEMINI_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}};
 const {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();let operations=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});operations++;
   const wire=syntheticWire(protocol,'text',true),prefix=Buffer.from(wire.body.toString().replace('data: [DONE]\n\n',''));let phase=0;
   return new Response(new ReadableStream({pull(reader){if(phase++===0){reader.enqueue(prefix);return;}if(phase===2){reader.enqueue(suffix==='utf8'?new Uint8Array([0xc3]):Buffer.from(suffix?'data: {"usage":':''));return;}reader.error(Object.assign(new Error('Synthetic connection loss'),{code:'ECONNRESET'}));}},{highWaterMark:0}),{headers:{'content-type':wire.type}});
 }));
 await expect(chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(Error);
 expect(operations).toBe(1);expect(retry).not.toHaveBeenCalled();expect(captured).toHaveBeenCalledTimes(suffix?0:1);
 const saved=ledger.read(project);expect(Object.values(saved.projection.requests).map(v=>v.state)).toEqual([suffix?'unknown':'settled']);expect(saved.projection.spent.costNanos).toBeGreaterThan(0);
});

it.each((['openai','deepseek'] as const).flatMap(provider=>[false,true].map(prefix=>({provider,prefix}))))('terminal schemas reject unknown $provider finish reason (after valid proof=$prefix)',async({provider,prefix})=>{
  vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
  const model=provider==='openai'?'gpt-4-test':'deepseek-test',selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}};
  const {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
  vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('chat','text',true);const bad='data: '+JSON.stringify({choices:[{index:0,delta:{content:'candidate'},finish_reason:'not_a_valid_finish_reason'}],usage:{prompt_tokens:7,completion_tokens:3}})+'\n\n';return wireResponse(Buffer.from((prefix?wire.body.toString().replace('data: [DONE]\n\n',''):'')+bad),wire.type);}));
  await expect(chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toThrow('Unsupported or missing chat completion reason');
  expect(fetch).toHaveBeenCalledTimes(1);expect(captured).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);
});
const bedrockCapture=()=>{
 vi.stubEnv('BEDROCK_BASE_URL','');vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred('bedrock',{region:'us-east-1'});
 const selected:RouteCandidate={...route,provider:'bedrock',model:'bedrock-test',target:providerTarget('bedrock').key,price:{input:2,output:5}};return {...accounting(selected,true),selected};
};
it.each(['zero','fraction','unknown-stop'] as const)('terminal schemas hold Bedrock metadata/stop contradiction %s',async mode=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('bedrock','text',true);const trailer=mode==='unknown-stop'?awsEvent('messageStop',{stopReason:'unknown'}):awsEvent('metadata',{usage:{inputTokens:mode==='zero'?0:7,outputTokens:mode==='zero'?0:3.5}});return wireResponse(Buffer.concat([wire.body,trailer]),wire.type);}));
 await expect(chat('bedrock',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(Error);
 expect(fetch).toHaveBeenCalledTimes(1);expect(captured).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);expect(ledger.read(project).projection.spent.costNanos).toBeGreaterThan(0);
});
it.each(['valid','missing-output','missing-message','missing-stop','unknown-stop','bad-text','bad-tool'] as const)('terminal schemas verify nonstream Bedrock %s',async mode=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('bedrock','text',false),value=JSON.parse(wire.body.toString());
 if(mode==='missing-output')delete value.output;else if(mode==='missing-message')value.output={};else if(mode==='missing-stop')delete value.stopReason;else if(mode==='unknown-stop')value.stopReason='unknown';else if(mode==='bad-text')value.output.message.content=[{text:42}];else if(mode==='bad-tool')value.output.message.content=[{toolUse:{toolUseId:'a',name:'echo',input:[]}}];return json(value);}));
 const operation=chat('bedrock',messages,[],selected.model,undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onResponseReceived:captured});
 if(mode==='valid'){await operation;expect(captured).toHaveBeenCalledTimes(1);expect(ledger.read(project).projection.spent.costNanos).toBe(29000);}else{await expect(operation).rejects.toBeInstanceOf(Error);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});

const validationModes=['valid','valid-tool','unknown-terminal','missing-structure'] as const;
it.each(streamCases.flatMap(value=>[false,true].flatMap(stream=>validationModes.map(mode=>({...value,stream,mode})))) )('cross protocol validation $provider/$protocol stream=$stream $mode',async({provider,model,protocol,stream,mode})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');if(provider==='google')vi.stubEnv('GOOGLE_GEMINI_BASE_URL','');
 if(provider==='bedrock'){vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred(provider,{region:'us-east-1'});}
 else config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}}, {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();let operations=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});operations++;
  const wire=syntheticWire(protocol,mode==='valid-tool'?'tool':'text',stream);if(mode==='valid'||mode==='valid-tool')return wireResponse(wire.body,wire.type);
  if(!stream){const value=JSON.parse(wire.body.toString());if(protocol==='chat'){if(mode==='unknown-terminal')value.choices[0].finish_reason='unknown';else delete value.choices[0].message;}
   else if(protocol==='responses'){if(mode==='unknown-terminal')value.status='unknown';else delete value.output;}
   else if(protocol==='anthropic'){if(mode==='unknown-terminal')value.stop_reason='unknown';else delete value.content;}
   else if(protocol==='google'){if(mode==='unknown-terminal')value.candidates[0].finishReason='UNKNOWN';else delete value.candidates;}
   else if(protocol==='ollama'){if(mode==='unknown-terminal')value.done_reason='unknown';else delete value.message;}
   else{if(mode==='unknown-terminal')value.stopReason='unknown';else delete value.output;}return json(value);
  }
  if(protocol==='bedrock'){const frames:Buffer[]=[];let offset=0;while(offset<wire.body.length){const length=wire.body.readUInt32BE(offset),frame=wire.body.subarray(offset,offset+length);offset+=length;if(frame.includes(Buffer.from('messageStop'))){if(mode==='unknown-terminal')frames.push(awsEvent('messageStop',{stopReason:'unknown'}));}else frames.push(frame);}return wireResponse(Buffer.concat(frames),wire.type);}
  let text=wire.body.toString();if(protocol==='chat')text=text.replace(/"finish_reason":"[^"]*"/g,mode==='unknown-terminal'?'"finish_reason":"unknown"':'"finish_reason":null');
  else if(protocol==='responses')text=text.replace(/"status":"completed"/g,mode==='unknown-terminal'?'"status":"unknown"':'"status":"in_progress"');
  else if(protocol==='anthropic')text=text.replace(/"stop_reason":"[^"]*"/g,mode==='unknown-terminal'?'"stop_reason":"unknown"':'"stop_reason":null');
  else if(protocol==='google')text=text.replace(/"finishReason":"[^"]*"/g,mode==='unknown-terminal'?'"finishReason":"UNKNOWN"':'"finishReason":"FINISH_REASON_UNSPECIFIED"');
  else text=text.replace(/"done_reason":"[^"]*"/g,mode==='unknown-terminal'?'"done_reason":"unknown"':'"done_reason":null');
  return wireResponse(Buffer.from(text),wire.type);
 }));
 const operation=chat(provider,messages,[],model,stream?()=>{}:undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(mode==='valid'||mode==='valid-tool'){const response=await operation;expect(captured).toHaveBeenCalledTimes(1);expect(ledger.read(project).projection.spent.costNanos).toBe(29000);if(mode==='valid-tool')expect(response.toolCalls).toEqual([expect.objectContaining({name:'echo',arguments:{text:'hello'}})]);}
 else{await expect(operation).rejects.toBeInstanceOf(Error);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);expect(ledger.read(project).projection.spent.costNanos).toBeGreaterThan(0);}
 expect(operations).toBe(1);expect(retry).not.toHaveBeenCalled();
});

it.each(['input-only','output-only','empty','lost-thoughts'] as const)('partial Google usage stays unknown rather than reusing stale totals (%s)',async mode=>{
 vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GOOGLE_GEMINI_BASE_URL','');config.setProviderCred('google',{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider:'google',model:'gemini-test',target:providerTarget('google').key,price:{input:2,output:5}}, {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const value=JSON.parse(syntheticWire('google','text',false).body.toString());if(mode==='lost-thoughts'){value.usageMetadata.thoughtsTokenCount=2;value.usageMetadata.totalTokenCount=12;}
 const usageMetadata=mode==='input-only'?{promptTokenCount:7}:mode==='output-only'?{candidatesTokenCount:3}:mode==='empty'?{}:{promptTokenCount:7,candidatesTokenCount:3};
 return new Response('data: '+JSON.stringify(value)+'\n\ndata: '+JSON.stringify({usageMetadata})+'\n\n',{headers:{'content-type':'text/event-stream'}});}));
 const response=await chat('google',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 expect(response.usage).toBeUndefined();expect(captured).toHaveBeenCalledTimes(1);expect(captured.mock.calls[0]?.[0]).toMatchObject({usageReported:false});expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);expect(ledger.read(project).projection.spent.costNanos).toBeGreaterThan(0);
});
it.each([false,true])('Anthropic aggregate cache usage cannot overflow normalized facts (stream=%s)',async stream=>{
 const {ledger,budget}=accounting(route,true),captured=vi.fn(async()=>{}),retry=vi.fn();vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});const wire=syntheticWire('anthropic','text',stream);return wireResponse(Buffer.from(wire.body.toString().replace('"input_tokens":7','"input_tokens":7,"cache_creation_input_tokens":9007199254740991')),wire.type);}));
 await expect(chat('anthropic',messages,[],route.model,stream?()=>{}:undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toThrow('Invalid Anthropic aggregate usage');
 expect(captured).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);expect(ledger.read(project).projection.spent.costNanos).toBeGreaterThan(0);
});


const argumentCases=streamCases.filter(v=>['chat','anthropic','bedrock'].includes(v.protocol));
it.each(argumentCases.flatMap(v=>['{','[]','null','42'].map(argument=>({...v,argument}))))('review tool object validation $provider/$protocol argument=$argument',async({provider,model,protocol,argument})=>{
 if(provider==='bedrock'){vi.stubEnv('BEDROCK_BASE_URL','');vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred('bedrock',{region:'us-east-1'});}else{vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});}
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}};
 const {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();let operations=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});operations++;
 const wire=syntheticWire(protocol,'tool',true);let body:Buffer;
 if(protocol==='bedrock')body=Buffer.concat([awsEvent('contentBlockStart',{contentBlockIndex:0,start:{toolUse:{toolUseId:'call_1',name:'echo'}}}),awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{toolUse:{input:argument}}}),awsEvent('contentBlockStop',{contentBlockIndex:0}),awsEvent('messageStop',{stopReason:'tool_use'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]);
 else body=Buffer.from(wire.body.toString().split('\n\n').map(frame=>frame.split('\n').map(line=>{if(!line.startsWith('data: ')||line==='data: [DONE]')return line;const value=JSON.parse(line.slice(6));if(protocol==='chat'){for(const choice of value.choices??[])for(const tc of choice.delta?.tool_calls??[])if(tc.function?.arguments!==undefined)tc.function.arguments=tc.id?argument:'';}else if(value.delta?.type==='input_json_delta')value.delta.partial_json=argument;return 'data: '+JSON.stringify(value);}).join('\n')).join('\n\n'));
 return wireResponse(body,wire.type);}));
 await expect(chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);
 expect(operations).toBe(1);expect(captured).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);
});
it.each((['openai','deepseek'] as const).flatMap(provider=>['[]','null','42','"scalar"'].map(argument=>({provider,argument}))))('review nonstream tool object $provider argument=$argument',async({provider,argument})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const model=provider==='openai'?'gpt-4-test':'deepseek-test',selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}}, {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const value=JSON.parse(syntheticWire('chat','tool',false).body.toString());value.choices[0].message.tool_calls[0].function.arguments=argument;return json(value);}));
 await expect(chat(provider,messages,[],model,undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);
 expect(fetch).toHaveBeenCalledTimes(1);expect(captured).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);
});
it.each(['empty','partial','preterminal-partial'] as const)('review Bedrock connection trailer $mode',async mode=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('bedrock','text',true);let phase=0;
 return new Response(new ReadableStream({pull(reader){if(phase++===0){reader.enqueue(mode==='preterminal-partial'?awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{text:'partial'}}):wire.body);return;}if(phase===2&&mode!=='empty'){reader.enqueue(new Uint8Array([0]));return;}reader.error(Object.assign(new Error('Synthetic connection loss'),{code:'ECONNRESET'}));}},{highWaterMark:0}),{headers:{'content-type':wire.type}});}));
 const operation=chat('bedrock',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured});
 if(mode==='empty')await expect(operation).rejects.toBeInstanceOf(ExecutionLimitError);else await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();expect(captured).toHaveBeenCalledTimes(mode==='empty'?1:0);expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual([mode==='empty'?'settled':'unknown']);
});
it.each(['text','tool'] as const)('review Bedrock fatal UTF8 $mode',async mode=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const raw=Buffer.concat([Buffer.from(mode==='text'?'{"delta":{"text":"':'{"delta":{"toolUse":{"input":"{\\"text\\":\\"'),new Uint8Array([0xc3]),Buffer.from(mode==='text'?'"}}':'\\"}"}}}')]);
 const body=Buffer.concat([...(mode==='tool'?[awsEvent('contentBlockStart',{contentBlockIndex:0,start:{toolUse:{toolUseId:'call_1',name:'echo'}}})]:[]),awsEvent('contentBlockDelta',{},raw),awsEvent('contentBlockStop',{contentBlockIndex:0}),awsEvent('messageStop',{stopReason:mode==='tool'?'tool_use':'end_turn'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]);return wireResponse(body,'application/vnd.amazon.eventstream');}));
 await expect(chat('bedrock',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);
 expect(fetch).toHaveBeenCalledTimes(1);expect(captured).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);
});
it.each(argumentCases.map(v=>({...v,argument:'{'})))('review retains truncated $provider/$protocol without executable arguments',async({provider,model,protocol,argument})=>{
 if(provider==='bedrock'){vi.stubEnv('BEDROCK_BASE_URL','');vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred('bedrock',{region:'us-east-1'});}else{vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});}
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}};
 const {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();let operations=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});operations++;
 const wire=syntheticWire(protocol,'tool',true);let body:Buffer;
 if(protocol==='bedrock')body=Buffer.concat([awsEvent('contentBlockStart',{contentBlockIndex:0,start:{toolUse:{toolUseId:'call_1',name:'echo'}}}),awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{toolUse:{input:argument}}}),awsEvent('contentBlockStop',{contentBlockIndex:0}),awsEvent('messageStop',{stopReason:'max_tokens'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]);
 else body=Buffer.from(wire.body.toString().split('\n\n').map(frame=>frame.split('\n').map(line=>{if(!line.startsWith('data: ')||line==='data: [DONE]')return line;const value=JSON.parse(line.slice(6));if(protocol==='chat'){for(const choice of value.choices??[])if(choice.finish_reason)choice.finish_reason='length';for(const choice of value.choices??[])for(const tc of choice.delta?.tool_calls??[])if(tc.function?.arguments!==undefined)tc.function.arguments=tc.id?argument:'';}else {if(value.delta?.type==='input_json_delta')value.delta.partial_json=argument;if(value.delta?.stop_reason)value.delta.stop_reason='max_tokens';}return 'data: '+JSON.stringify(value);}).join('\n')).join('\n\n'));
 return wireResponse(body,wire.type);}));
 const response=await chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});expect(response.toolCalls).toBeUndefined();expect(response.truncatedToolCalls).toBe(true);
 expect(operations).toBe(1);expect(captured).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['settled']);
});


it.each(streamCases.filter(v=>v.protocol!=='bedrock').flatMap(v=>['partial','utf8'].map(suffix=>({...v,suffix}))))('preterminal framing $provider/$protocol $suffix stops before retry',async({provider,model,protocol,suffix})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');if(provider==='google')vi.stubEnv('GOOGLE_GEMINI_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();let requests=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});requests++;const wire=syntheticWire(protocol,'text',true);let prefix=wire.body.subarray(0,wire.body.indexOf(protocol==='ollama'?'\n':'\n\n')+(protocol==='ollama'?1:2));
 if(protocol==='google'){const value=JSON.parse(syntheticWire(protocol,'text',false).body.toString());delete value.candidates[0].finishReason;prefix=Buffer.from('data: '+JSON.stringify(value)+'\n\n');}
 let phase=0;return new Response(new ReadableStream({pull(reader){if(phase++===0){reader.enqueue(prefix);return;}if(phase===2){reader.enqueue(suffix==='utf8'?new Uint8Array([0xc3]):Buffer.from(protocol==='ollama'?'{"done":':'data: {"choices":'));return;}reader.error(Object.assign(new Error('Synthetic preterminal disconnect'),{code:'ECONNRESET'}));}},{highWaterMark:0}),{headers:{'content-type':wire.type}});}));
 await expect(chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);
 expect(requests).toBe(1);expect(retry).not.toHaveBeenCalled();expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);
});
it.each(['openai','deepseek'] as const)('empty argument stream $provider refuses fabricated object',async provider=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const model=provider==='openai'?'gpt-4-test':'deepseek-test',selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('chat','tool',true);const body=wire.body.toString().split('\n\n').map(frame=>frame.split('\n').map(line=>{if(!line.startsWith('data: ')||line==='data: [DONE]')return line;const value=JSON.parse(line.slice(6));for(const choice of value.choices??[])for(const tc of choice.delta?.tool_calls??[])if(tc.function?.arguments!==undefined)tc.function.arguments='';return 'data: '+JSON.stringify(value);}).join('\n')).join('\n\n');return wireResponse(Buffer.from(body),wire.type);}));
 await expect(chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);
});
it.each([false,true])('Anthropic context window reason stream=%s remains output-limited',async stream=>{
 const {ledger,budget}=accounting(),captured=vi.fn(async(_checkpoint: ProviderResponseCheckpoint)=>{});respond=()=>{const wire=syntheticWire('anthropic','text',stream);return wireResponse(Buffer.from(wire.body.toString().replaceAll('end_turn','model_context_window_exceeded')),wire.type);};
 const result=await chat('anthropic',messages,[],route.model,stream?()=>{}:undefined,undefined,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:0,onResponseReceived:captured});
 expect(result.finishReason).toBe('length');expect(captured.mock.calls[0]![0].response.finishReason).toBe('length');expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['settled']);
});
it.each([42,'bad',{}, {text:42},{signature:42},{redactedContent:42},{text:'valid',signature:'invalid-union'}].map((fragment,i)=>({fragment,i})))('Bedrock malformed reasoning fragment $i refuses retention',async({fragment})=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('bedrock','text',true);return wireResponse(Buffer.concat([awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{reasoningContent:fragment}}),wire.body]),wire.type);}));
 await expect(chat('bedrock',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['unknown']);
});
it.each([{text:'opaque reasoning'},{signature:'opaque signature'},{redactedContent:'Ynl0ZXM='}])('Bedrock valid reasoning fragment %j remains unchanged',async fragment=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{});vi.stubGlobal('fetch',vi.fn(async()=>{return wireResponse(Buffer.concat([awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{reasoningContent:fragment}}),awsEvent('contentBlockStop',{contentBlockIndex:0}),awsEvent('contentBlockDelta',{contentBlockIndex:1,delta:{text:'Visible answer'}}),awsEvent('contentBlockStop',{contentBlockIndex:1}),awsEvent('messageStop',{stopReason:'end_turn'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]),'application/vnd.amazon.eventstream');}));
 const result=await chat('bedrock',messages,[],selected.model,()=>{},undefined,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:0,onResponseReceived:captured});
 const value=fragment as Record<string,string>;const expected=value.redactedContent!==undefined?{redactedContent:value.redactedContent}:{reasoningText:{text:value.text??'',...(value.signature===undefined?{}:{signature:value.signature})}};expect(result.providerMetadata?.bedrock).toEqual({reasoningContent:[expected]});expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['settled']);
});


it('assembly review preserves explicit streaming Bedrock HTTP retry',async()=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();let calls=0;
 vi.stubGlobal('fetch',vi.fn(async()=>{if(calls++===0)return json({message:'Synthetic overload'},503);const wire=syntheticWire('bedrock','text',true);return wireResponse(wire.body,wire.type);}));
 const result=await chat('bedrock',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured});
 expect(result.content).toContain('Hello');expect(calls).toBe(2);expect(retry).toHaveBeenCalledTimes(1);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests).at(-1)!.state).toBe('settled');
}, 20_000);
it.each(['tool_use','max_tokens'])('assembly review absent Bedrock arguments %s never execute',async reason=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>wireResponse(Buffer.concat([awsEvent('contentBlockStart',{contentBlockIndex:0,start:{toolUse:{toolUseId:'call_1',name:'echo'}}}),awsEvent('contentBlockStop',{contentBlockIndex:0}),awsEvent('messageStop',{stopReason:reason}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]),'application/vnd.amazon.eventstream')));
 const operation=chat('bedrock',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured});
 if(reason==='max_tokens'){const result=await operation;expect(result.toolCalls).toBeUndefined();expect(result.truncatedToolCalls).toBe(true);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});
it('assembly review refuses Bedrock tool deltas from another block',async()=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>wireResponse(Buffer.concat([awsEvent('contentBlockStart',{contentBlockIndex:0,start:{toolUse:{toolUseId:'call_1',name:'echo'}}}),awsEvent('contentBlockDelta',{contentBlockIndex:1,delta:{toolUse:{input:'{"text":"wrong block"}'}}}),awsEvent('contentBlockStop',{contentBlockIndex:1}),awsEvent('messageStop',{stopReason:'tool_use'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]),'application/vnd.amazon.eventstream')));
 await expect(chat('bedrock',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');
});
it.each(['missing-id','different-id','different-name','different-arguments'] as const)('assembly review Responses intermediate $mode uses validated terminal identity',async mode=>{
 vi.stubEnv('OPENAI_API_KEY','');vi.stubEnv('OPENAI_BASE_URL','');config.setProviderCred('openai',{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider:'openai',model:'gpt-5-test',target:providerTarget('openai').key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async(_value:ProviderResponseCheckpoint)=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('responses','tool',true);const body=wire.body.toString().split('\n\n').map(frame=>frame.split('\n').map(line=>{if(!line.startsWith('data: '))return line;const value=JSON.parse(line.slice(6));if(value.type==='response.output_item.done'){if(mode==='missing-id')delete value.item.call_id;else if(mode==='different-id')value.item.call_id='different-id';else if(mode==='different-name')value.item.name='different_tool';else value.item.arguments='{"text":"different"}';}return 'data: '+JSON.stringify(value);}).join('\n')).join('\n\n');return wireResponse(Buffer.from(body),wire.type);}));
 const operation=chat('openai',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured});
 if(mode==='missing-id'||mode==='different-id'){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{let result:LLMResponse|undefined,error:unknown;try{result=await operation;}catch(caught){error=caught;}if(error){expect(error).toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}else{expect(result!.toolCalls?.[0]).toMatchObject({id:'call_1',name:'echo',arguments:{text:'hello'}});expect(captured.mock.calls[0]![0].response.toolCalls?.[0]).toMatchObject({id:'call_1',name:'echo',arguments:{text:'hello'}});}}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});
it.each(['role','text-type'] as const)('assembly review Anthropic malformed stream $mode stops before accumulation',async mode=>{
 const {ledger,budget}=accounting(),captured=vi.fn(async()=>{}),retry=vi.fn();respond=()=>{const wire=syntheticWire('anthropic','text',true);const body=wire.body.toString().split('\n\n').map(frame=>frame.split('\n').map(line=>{if(!line.startsWith('data: '))return line;const value=JSON.parse(line.slice(6));if(mode==='role'&&value.type==='message_start')value.message.role='user';if(mode==='text-type'&&value.type==='content_block_delta'&&value.delta.type==='text_delta')value.delta.text=42;return 'data: '+JSON.stringify(value);}).join('\n')).join('\n\n');return wireResponse(Buffer.from(body),wire.type);};
 await expect(chat('anthropic',messages,[],route.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);
 expect(requests.filter(p=>p.endsWith('/messages'))).toHaveLength(1);expect(retry).not.toHaveBeenCalled();expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');
});
it('assembly review assembles full Bedrock reasoning blocks for a separately admitted next turn',async()=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{});let calls=0,secondBody:any;
 vi.stubGlobal('fetch',vi.fn(async(input,init)=>{const body=JSON.parse(new Request(input,init).method==='POST'?String(init?.body):'{}');if(calls++===0)return wireResponse(Buffer.concat([awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{reasoningContent:{text:'opaque thought'}}}),awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{reasoningContent:{signature:'opaque signature'}}}),awsEvent('contentBlockStop',{contentBlockIndex:0}),awsEvent('contentBlockDelta',{contentBlockIndex:1,delta:{text:'Visible answer'}}),awsEvent('contentBlockStop',{contentBlockIndex:1}),awsEvent('messageStop',{stopReason:'end_turn'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]),'application/vnd.amazon.eventstream');secondBody=body;const wire=syntheticWire('bedrock','text',false);return wireResponse(wire.body,wire.type);}));
 const first=await chat('bedrock',messages,[],selected.model,()=>{},undefined,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:0,onResponseReceived:captured});
 const history:Message[]=[...messages,{role:'assistant',content:first.content,providerMetadata:first.providerMetadata}];const m=ledger.read(project).manifest;
 const nextBudget=new ExecutionGuard({ledger,manifestHash:manifestHash(m),agentId:'a',maxOutputTokens:100,measuredInputReservation:true},project).budget(selected,history,[],false);
 await chat('bedrock',history,[],selected.model,undefined,undefined,{maxOutputTokens:100,attemptBudget:nextBudget,maxProviderRetries:0,onResponseReceived:captured});
 expect(calls).toBe(2);expect(secondBody.messages.at(-1).content.filter((block:any)=>block.reasoningContent)).toEqual([{reasoningContent:{reasoningText:{text:'opaque thought',signature:'opaque signature'}}}]);expect(captured).toHaveBeenCalledTimes(2);expect(Object.values(ledger.read(project).projection.requests).map(v=>v.state)).toEqual(['settled','settled']);
});

it('assembly review Responses terminal text cannot be replaced by conflicting deltas',async()=>{
 vi.stubEnv('OPENAI_API_KEY','');vi.stubEnv('OPENAI_BASE_URL','');config.setProviderCred('openai',{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider:'openai',model:'gpt-5-test',target:providerTarget('openai').key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async(_value:ProviderResponseCheckpoint)=>{}),retry=vi.fn();
 const expected=JSON.parse(syntheticWire('responses','text',false).body.toString()).output[0].content[0].text;
 vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('responses','text',true);const body=wire.body.toString().split('\n\n').map(frame=>frame.split('\n').map(line=>{if(!line.startsWith('data: '))return line;const value=JSON.parse(line.slice(6));if(value.type==='response.output_text.delta')value.delta='Conflicting intermediate text';return 'data: '+JSON.stringify(value);}).join('\n')).join('\n\n');return wireResponse(Buffer.from(body),wire.type);}));
 let result:LLMResponse|undefined,error:unknown;try{result=await chat('openai',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:1,onStreamReset:()=>{},onResponseReceived:captured});}catch(caught){error=caught;}
 if(error){expect(error).toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{expect(result!.content).toBe(expected);expect(captured.mock.calls[0]![0].response.content).toBe(expected);}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});


it.each((['openai','deepseek'] as const).flatMap(provider=>['id','name','duplicate','same'].map(mode=>({provider,mode}))))('slot identity $provider $mode remains bound before arguments are appended',async({provider,mode})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const model=provider==='openai'?'gpt-4-test':'deepseek-test',selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async(_value:ProviderResponseCheckpoint)=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{
 const base={id:'chat_slots',object:'chat.completion.chunk',created:1,model};
 const deltas=[{index:0,id:'call_a',type:'function',function:{name:'echo_a',arguments:mode==='duplicate'?'{}':'{"text":'}},
 {index:mode==='duplicate'?1:0,id:mode==='id'?'call_b':'call_a',type:'function',function:{name:mode==='name'?'echo_b':'echo_a',arguments:mode==='duplicate'?'{}':'"hello"}'}}];
 const chunks=[...deltas.map(tc=>({...base,choices:[{index:0,delta:{tool_calls:[tc]}}]})),{...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},{...base,choices:[],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}];
 return wireResponse(Buffer.from(chunks.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n'),'text/event-stream');}));
 const operation=chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(mode==='same'){const result=await operation;expect(result.toolCalls).toEqual([{id:'call_a',name:'echo_a',arguments:{text:'hello'}}]);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});
it.each((['bedrock','ollama'] as const).flatMap(provider=>['assistant','user',42].map(role=>({provider,role}))))('native role $provider/$role validates before accumulation',async({provider,role})=>{
 let selected:RouteCandidate,ledger:ReservationLedger,budget:ReturnType<ExecutionGuard['budget']>;
 if(provider==='bedrock'){const f=bedrockCapture();selected=f.selected;ledger=f.ledger;budget=f.budget;}
 else{vi.stubEnv('OLLAMA_BASE_URL','');config.setProviderCred('ollama',{baseUrl:'https://capture.invalid/v1'});selected={...route,provider,model:'ollama-test',target:providerTarget(provider).key,price:{input:2,output:5}};const f=accounting(selected,true);ledger=f.ledger;budget=f.budget;}
 const captured=vi.fn(async()=>{}),retry=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire(provider,'text',true);
 if(provider==='bedrock')return wireResponse(Buffer.concat([awsEvent('messageStart',{role}),wire.body]),wire.type);
 let first=true;return wireResponse(Buffer.from(wire.body.toString().split('\n').map(line=>{if(!line)return line;const value=JSON.parse(line);if(first){value.message.role=role;first=false;}return JSON.stringify(value);}).join('\n')),wire.type);}));
 const operation=chat(provider,messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(role==='assistant'){await operation;expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});


it.each(streamCases.filter(value=>value.protocol!=='google').flatMap(value=>[false,true].map(duplicate=>({...value,duplicate}))))('complete identities $provider/$protocol duplicate=$duplicate validated before capture',async({provider,model,protocol,duplicate})=>{
 if(provider==='bedrock'){vi.stubEnv('BEDROCK_BASE_URL','');vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred(provider,{region:'us-east-1'});}else{vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});}
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});const value=JSON.parse(syntheticWire(protocol,'tool',false).body.toString()),second=duplicate?'call_1':'call_2';
 if(protocol==='chat'){const item=structuredClone(value.choices[0].message.tool_calls[0]);item.id=second;value.choices[0].message.tool_calls.push(item);}
 else if(protocol==='responses'){const item=structuredClone(value.output[0]);item.id='fc_2';item.call_id=second;value.output.push(item);}
 else if(protocol==='anthropic'){const item=structuredClone(value.content[0]);item.id=second;value.content.push(item);}
 else if(protocol==='bedrock'){const item=structuredClone(value.output.message.content[0]);item.toolUse.toolUseId=second;value.output.message.content.push(item);}
 else{value.message.tool_calls[0].id='call_1';const item=structuredClone(value.message.tool_calls[0]);item.id=second;value.message.tool_calls.push(item);}
 return json(value);}));
 const operation=chat(provider,messages,[],model,undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onResponseReceived:captured});
 if(duplicate){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{const result=await operation;expect(result.toolCalls).toHaveLength(2);expect(new Set(result.toolCalls!.map(call=>call.id)).size).toBe(2);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 expect(fetch).toHaveBeenCalledTimes(protocol==='anthropic'?2:1);expect(retry).not.toHaveBeenCalled();
});
it('complete identities Ollama fallback spans chunks even within the same millisecond',async()=>{
 vi.stubEnv('OLLAMA_BASE_URL','');config.setProviderCred('ollama',{baseUrl:'https://capture.invalid/v1'});const selected:RouteCandidate={...route,provider:'ollama',model:'ollama-test',target:providerTarget('ollama').key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async(_value:ProviderResponseCheckpoint)=>{});const fixed=Date.now();vi.spyOn(Date,'now').mockReturnValue(fixed);
 vi.stubGlobal('fetch',vi.fn(async()=>{const values=[...['first','second'].map(text=>({model:'ollama-test',done:false,message:{role:'assistant',content:'',tool_calls:[{function:{name:'echo',arguments:{text}}}]}})),{model:'ollama-test',done:true,done_reason:'stop',message:{role:'assistant',content:''},prompt_eval_count:7,eval_count:3}];return wireResponse(Buffer.from(values.map(value=>JSON.stringify(value)+'\n').join('')),'application/x-ndjson');}));
 const result=await chat('ollama',messages,[],selected.model,()=>{},undefined,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:0,onResponseReceived:captured});expect(result.toolCalls).toHaveLength(2);expect(new Set(result.toolCalls!.map(call=>call.id)).size).toBe(2);expect(captured.mock.calls[0]![0].response.toolCalls).toEqual(result.toolCalls);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');expect(fetch).toHaveBeenCalledTimes(1);
});


it.each([false,true].flatMap(stream=>['stop','length'].flatMap(reason=>[
 {name:'parameters',body:'<parameter=text>hello</parameter>',valid:true,args:{text:'hello'}},
 {name:'empty',body:'',valid:true,args:{}},
 {name:'unclosed-parameter',body:'<parameter=text>unfinished',valid:false},
 {name:'unparsed-body',body:'unexpected <parameter=text>hello</parameter>',valid:false},
 {name:'duplicate-parameter',body:'<parameter=text>one</parameter><parameter=text>two</parameter>',valid:false},
 {name:'unclosed-function',body:'<parameter=text>hello</parameter>',valid:false,unclosed:true},
].map(sample=>({...sample,stream,reason})))))('Ollama text capture $name stream=$stream reason=$reason',async({body,valid,args,unclosed,stream,reason})=>{
 vi.stubEnv('OLLAMA_BASE_URL','');config.setProviderCred('ollama',{baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider:'ollama',model:'ollama-test',target:providerTarget('ollama').key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async(_value:ProviderResponseCheckpoint)=>{}),retry=vi.fn();
 const content='<function=echo>'+body+(unclosed?'':'</function>');
 vi.stubGlobal('fetch',vi.fn(async()=>{const message={role:'assistant',content};return stream?wireResponse(Buffer.from(JSON.stringify({model:selected.model,message,done:false})+'\n'+JSON.stringify({model:selected.model,message:{role:'assistant',content:''},done:true,done_reason:reason,prompt_eval_count:7,eval_count:3})+'\n'),'application/x-ndjson'):json({model:selected.model,message,done:true,done_reason:reason,prompt_eval_count:7,eval_count:3});}));
 const operation=chat('ollama',messages,[],selected.model,stream?()=>{}:undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(!valid&&reason==='stop'){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{const result=await operation;if(valid){expect(result.toolCalls).toHaveLength(1);expect(result.toolCalls![0]!.arguments).toEqual(args);expect(result.truncatedToolCalls).not.toBe(true);}else{expect(result.toolCalls??[]).toHaveLength(0);expect(result.truncatedToolCalls).toBe(true);expect(result.finishReason).toBe('length');}expect(captured).toHaveBeenCalledTimes(1);expect(captured.mock.calls[0]![0].response).toEqual(result);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});

it.each([false,true].flatMap(stream=>['stop','length'].flatMap(reason=>[
 {name:'nested-open',body:'<parameter=text>hello<parameter=other>unfinished</parameter>',valid:false},
 {name:'nested-function',body:'<parameter=text>hello<function=other></parameter>',valid:false},
 {name:'unmatched-function-close',body:'<parameter=text>hello</function></parameter>',valid:false},
 {name:'prototype-key',body:'<parameter=__proto__>{"text":"hello"}</parameter>',valid:true,args:JSON.parse('{"__proto__":{"text":"hello"}}')},
 {name:'plain-text-value',body:'<parameter=text>1 < 2 and "hello"</parameter>',valid:true,args:{text:'1 < 2 and "hello"'}},
].map(sample=>({...sample,stream,reason})))))('Ollama flat grammar $name stream=$stream reason=$reason',async({body,valid,args,unclosed,stream,reason})=>{
 vi.stubEnv('OLLAMA_BASE_URL','');config.setProviderCred('ollama',{baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider:'ollama',model:'ollama-test',target:providerTarget('ollama').key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async(_value:ProviderResponseCheckpoint)=>{}),retry=vi.fn();
 const content='<function=echo>'+body+(unclosed?'':'</function>');
 vi.stubGlobal('fetch',vi.fn(async()=>{const message={role:'assistant',content};return stream?wireResponse(Buffer.from(JSON.stringify({model:selected.model,message,done:false})+'\n'+JSON.stringify({model:selected.model,message:{role:'assistant',content:''},done:true,done_reason:reason,prompt_eval_count:7,eval_count:3})+'\n'),'application/x-ndjson'):json({model:selected.model,message,done:true,done_reason:reason,prompt_eval_count:7,eval_count:3});}));
 const operation=chat('ollama',messages,[],selected.model,stream?()=>{}:undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(!valid&&reason==='stop'){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{const result=await operation;if(valid){expect(result.toolCalls).toHaveLength(1);expect(result.toolCalls![0]!.arguments).toEqual(args);expect(result.truncatedToolCalls).not.toBe(true);}else{expect(result.toolCalls??[]).toHaveLength(0);expect(result.truncatedToolCalls).toBe(true);expect(result.finishReason).toBe('length');}expect(captured).toHaveBeenCalledTimes(1);expect(captured.mock.calls[0]![0].response).toEqual(result);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});


it.each(['sequential','interleaved','direct','wrong-index','repeated-start','duplicate-id'])('stream association Anthropic %s',async mode=>{
 const {ledger,budget}=accounting(route,true),captured=vi.fn(async(_value:ProviderResponseCheckpoint)=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});
 const start=(index:number,id:string,name:string,input={})=>({type:'content_block_start',index,content_block:{type:'tool_use',id,name,input}}),delta=(index:number,text:string)=>({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify({text})}}),stop=(index:number)=>({type:'content_block_stop',index});
 const head={type:'message_start',message:{id:'msg_association',type:'message',role:'assistant',model:route.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:7,output_tokens:0}}};
 const a=[start(0,'call_a','tool_a'),delta(0,'A'),stop(0)],b=[start(1,mode==='duplicate-id'?'call_a':'call_b','tool_b'),delta(1,'B'),stop(1)];
 let middle=mode==='interleaved'?[a[0],b[0],a[1],a[2],b[1],b[2]]:mode==='direct'?[start(0,'call_a','tool_a',{text:'direct'}),stop(0)]:[...a,...b];
 if(mode==='wrong-index')middle=[a[0],delta(1,'A'),a[2]];if(mode==='repeated-start')middle=[a[0],a[0],a[1],a[2]];
 const events=[head,...middle,{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:3}},{type:'message_stop'}];
 return wireResponse(Buffer.from(events.map(value=>'event: '+value!.type+'\ndata: '+JSON.stringify(value)+'\n\n').join('')),'text/event-stream');}));
 const operation=chat('anthropic',messages,[],route.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(['sequential','interleaved','direct'].includes(mode)){const result=await operation;expect(result.toolCalls).toEqual(mode==='direct'?[{id:'call_a',name:'tool_a',arguments:{text:'direct'}}]:[{id:'call_a',name:'tool_a',arguments:{text:'A'}},{id:'call_b',name:'tool_b',arguments:{text:'B'}}]);expect(captured.mock.calls[0]![0].response).toEqual(result);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(fetch).toHaveBeenCalledTimes(2);expect(retry).not.toHaveBeenCalled();
});
it.each((['openai','deepseek'] as const).flatMap(provider=>['omitted','function','custom','numeric','duplicate-choices'].map(mode=>({provider,mode}))))('stream association Chat $provider/$mode',async({provider,mode})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});const selected:RouteCandidate={...route,provider,model:provider==='openai'?'gpt-4-test':'deepseek-chat-test',target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const tool={index:0,id:'call_1',...(mode==='omitted'?{}:{type:mode==='numeric'?42:mode==='custom'?'custom':'function'}),function:{name:'echo',arguments:'{"text":"hello"}'}};
 const events=mode==='duplicate-choices'?[{choices:[{index:0,delta:{content:'first'},finish_reason:'stop'},{index:0,delta:{content:'second'},finish_reason:'length'}]}]:[{choices:[{index:0,delta:{tool_calls:[tool]}}]},{choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}];
 return wireResponse(Buffer.from([...events,{choices:[],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}].map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n'),'text/event-stream');}));
 const operation=chat(provider,messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(['omitted','function'].includes(mode)){const result=await operation;expect(result.toolCalls).toEqual([{id:'call_1',name:'echo',arguments:{text:'hello'}}]);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});


it.each((['openai','deepseek'] as const).flatMap(provider=>['function','custom','numeric','omitted','null'].map(kind=>({provider,kind}))))('terminal kinds Chat $provider/$kind',async({provider,kind})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});const selected:RouteCandidate={...route,provider,model:provider==='openai'?'gpt-4-test':'deepseek-chat-test',target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const value=JSON.parse(syntheticWire('chat','tool',false).body.toString());const tool=value.choices[0].message.tool_calls[0];if(kind==='omitted')delete tool.type;else tool.type=kind==='numeric'?42:kind==='null'?null:kind;return json(value);}));
 const operation=chat(provider,messages,[],selected.model,undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onResponseReceived:captured});
 if(kind==='function'){const result=await operation;expect(result.toolCalls).toHaveLength(1);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});
it.each([false,true])('terminal kinds Bedrock restart=%s',async restart=>{
 const {ledger,budget,selected}=bedrockCapture(),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const start=()=>awsEvent('messageStart',{role:'assistant'}),block=(index:number,id:string,text:string)=>[awsEvent('contentBlockStart',{contentBlockIndex:index,start:{toolUse:{toolUseId:id,name:'echo'}}}),awsEvent('contentBlockDelta',{contentBlockIndex:index,delta:{toolUse:{input:JSON.stringify({text})}}}),awsEvent('contentBlockStop',{contentBlockIndex:index})];return wireResponse(Buffer.concat([start(),...block(0,'call_a','A'),...(restart?[start()]:[]),...block(1,'call_b','B'),awsEvent('messageStop',{stopReason:'tool_use'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]),'application/vnd.amazon.eventstream');}));
 const operation=chat('bedrock',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(restart){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{const result=await operation;expect(result.toolCalls).toEqual([{id:'call_a',name:'echo',arguments:{text:'A'}},{id:'call_b',name:'echo',arguments:{text:'B'}}]);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});
it.each(streamCases)('terminal kinds empty tool name $provider/$protocol',async({provider,model,protocol})=>{
 if(provider==='bedrock'){vi.stubEnv('BEDROCK_BASE_URL','');vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred(provider,{region:'us-east-1'});}else{vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});}
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();let calls=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});calls++;const value=JSON.parse(syntheticWire(protocol,'tool',false).body.toString());
 if(protocol==='chat')value.choices[0].message.tool_calls[0].function.name='';else if(protocol==='responses')value.output[0].name='';else if(protocol==='anthropic')value.content[0].name='';else if(protocol==='bedrock')value.output.message.content[0].toolUse.name='';else if(protocol==='google')value.candidates[0].content.parts[0].functionCall.name='';else value.message.tool_calls[0].function.name='';return json(value);}));
 await expect(chat(provider,messages,[],model,undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onResponseReceived:captured})).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');expect(calls).toBe(1);expect(retry).not.toHaveBeenCalled();
});


const terminalOwnershipFixture=(protocol:string)=>{
 const spec=streamCases.find(value=>value.protocol===protocol)!;const {provider,model}=spec;
 if(provider==='bedrock'){vi.stubEnv('BEDROCK_BASE_URL','');vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred(provider,{region:'us-east-1'});}else{vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});}
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}};return {...spec,selected,...accounting(selected,true)};
};
it.each([false,true].flatMap(stream=>['tool','text'].flatMap(kind=>['completed','incomplete'].flatMap(parent=>['completed','incomplete','in_progress','omitted'].map(child=>({stream,kind,parent,child}))))))('terminal ownership Responses stream=$stream kind=$kind parent=$parent child=$child',async({stream,kind,parent,child})=>{
 const {selected,ledger,budget}=terminalOwnershipFixture('responses'),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const wire=syntheticWire('responses',kind==='tool'?'tool':'text',stream);const change=(value:any)=>{value.status=parent;if(parent==='incomplete')value.incomplete_details={reason:'max_output_tokens'};if(child==='omitted')delete value.output[0].status;else value.output[0].status=child;return value;};
 if(!stream)return json(change(JSON.parse(wire.body.toString())));
 return wireResponse(Buffer.from(wire.body.toString().split('\n\n').filter(Boolean).map(frame=>{let value=JSON.parse(frame.split('\n').find(line=>line.startsWith('data: '))!.slice(6));if(value.type==='response.completed'){value.type='response.'+parent;value.response=change(value.response);}return 'event: '+value.type+'\ndata: '+JSON.stringify(value)+'\n\n';}).join('')),'text/event-stream');}));
 const operation=chat('openai',messages,[],selected.model,stream?()=>{}:undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(parent==='completed'&&!['completed','omitted'].includes(child)){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{const result=await operation;expect(captured).toHaveBeenCalledTimes(1);if(parent==='incomplete'){expect(result.finishReason).toBe('length');expect(result.toolCalls??[]).toHaveLength(0);}else if(kind==='tool')expect(result.toolCalls).toHaveLength(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});
it.each([{first:0,last:0},{first:0,last:1},{first:undefined,last:0},{first:1,last:1}])('terminal ownership Google candidate $first/$last',async({first,last})=>{
 const {selected,ledger,budget}=terminalOwnershipFixture('google'),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const events=[{candidates:[{...(first===undefined?{}:{index:first}),content:{role:'model',parts:[{functionCall:{name:'echo',args:{text:'original'}}}]}}]},{candidates:[{index:last,finishReason:'STOP'}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:3}}];return wireResponse(Buffer.from(events.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')),'text/event-stream');}));
 const operation=chat('google',messages,[],selected.model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if((first??0)!==0||last!==0){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{const result=await operation;expect(result.toolCalls).toHaveLength(1);expect(result.toolCalls![0]!.arguments).toEqual({text:'original'});expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});
it.each(['anthropic','bedrock','responses'].flatMap(protocol=>[false,true].map(duplicate=>({protocol,duplicate}))))('terminal ownership raw truncated IDs $protocol duplicate=$duplicate',async({protocol,duplicate})=>{
 const {provider,model,ledger,budget}=terminalOwnershipFixture(protocol),captured=vi.fn(async()=>{}),retry=vi.fn();let calls=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});calls++;const value=JSON.parse(syntheticWire(protocol as any,'tool',false).body.toString());
 if(protocol==='anthropic'){const item=structuredClone(value.content[0]);item.id=duplicate?'call_1':'call_2';item.input={text:'second'};value.content.push(item);value.stop_reason='max_tokens';}
 else if(protocol==='bedrock'){const item=structuredClone(value.output.message.content[0]);item.toolUse.toolUseId=duplicate?'call_1':'call_2';item.toolUse.input={text:'second'};value.output.message.content.push(item);value.stopReason='max_tokens';}
 else{const item=structuredClone(value.output[0]);item.id='fc_2';item.call_id=duplicate?'call_1':'call_2';value.output.push(item);value.status='incomplete';value.incomplete_details={reason:'max_output_tokens'};}
 return json(value);}));
 const operation=chat(provider,messages,[],model,undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onResponseReceived:captured});
 if(duplicate){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{const result=await operation;expect(result.truncatedToolCalls).toBe(true);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 expect(calls).toBe(1);expect(retry).not.toHaveBeenCalled();
});


it.each((['openai','deepseek'] as const).flatMap(provider=>[false,true].map(duplicate=>({provider,duplicate}))))('raw Chat truncation $provider duplicate=$duplicate',async({provider,duplicate})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});const selected:RouteCandidate={...route,provider,model:provider==='openai'?'gpt-4-test':'deepseek-chat-test',target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{const value=JSON.parse(syntheticWire('chat','tool',false).body.toString()),calls=value.choices[0].message.tool_calls,second=structuredClone(calls[0]);second.id=duplicate?'call_1':'call_2';second.function.arguments='{"text":';calls.push(second);value.choices[0].finish_reason='length';return json(value);}));
 const operation=chat(provider,messages,[],selected.model,undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onResponseReceived:captured});
 if(duplicate){await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{const result=await operation;expect(result.toolCalls).toEqual([{id:'call_1',name:'echo',arguments:{text:'hello'}}]);expect(result.truncatedToolCalls).toBe(true);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});


it.each(streamCases.filter(value=>['anthropic','bedrock','chat'].includes(value.protocol)).flatMap(value=>[false,true].flatMap(length=>['{}','{"text":','', '[]','null','42','"text"'].filter(root=>!(value.protocol==='anthropic'&&root==='')).map(root=>({...value,length,root})))) )('typed truncation $provider/$protocol length=$length root=$root',async({provider,model,protocol,length,root})=>{
 if(provider==='bedrock'){vi.stubEnv('BEDROCK_BASE_URL','');vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred(provider,{region:'us-east-1'});}else{vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});}
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();let calls=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});calls++;
 if(protocol==='bedrock')return wireResponse(Buffer.concat([awsEvent('messageStart',{role:'assistant'}),awsEvent('contentBlockStart',{contentBlockIndex:0,start:{toolUse:{toolUseId:'call_1',name:'echo'}}}),awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{toolUse:{input:root}}}),awsEvent('contentBlockStop',{contentBlockIndex:0}),awsEvent('messageStop',{stopReason:length?'max_tokens':'tool_use'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]),'application/vnd.amazon.eventstream');
 if(protocol==='chat'){const base={id:'chat_typed',object:'chat.completion.chunk',created:1,model};const events=[{...base,choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'echo',arguments:root}}]}}]},{...base,choices:[{index:0,delta:{},finish_reason:length?'length':'tool_calls'}]},{...base,choices:[],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}];return wireResponse(Buffer.from(events.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n'),'text/event-stream');}
 const wire=syntheticWire(protocol as any,'tool',true);return wireResponse(Buffer.from(wire.body.toString().split('\n\n').filter(Boolean).map(frame=>{const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data||data==='data: [DONE]')return frame+'\n\n';const value=JSON.parse(data.slice(6));if(protocol==='anthropic'){if(value.type==='content_block_delta')value.delta.partial_json=root;if(value.type==='message_delta')value.delta.stop_reason=length?'max_tokens':'tool_use';}else{for(const choice of value.choices??[]){if(choice.delta?.tool_calls)choice.delta.tool_calls[0].function.arguments=root;if(choice.finish_reason)choice.finish_reason=length?'length':'tool_calls';}}return (protocol==='anthropic'?'event: '+value.type+'\n':'')+'data: '+JSON.stringify(value)+'\n\n';}).join('')),wire.type);}));
 const operation=chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 const truncated=length&&['{"text":',''].includes(root);
 if(root==='{}'||truncated){const result=await operation;if(truncated){expect(result.toolCalls??[]).toHaveLength(0);expect(result.truncatedToolCalls).toBe(true);}else expect(result.toolCalls![0]!.arguments).toEqual({});expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(calls).toBe(1);expect(retry).not.toHaveBeenCalled();
});


it.each(streamCases.filter(value=>['anthropic','bedrock'].includes(value.protocol)).flatMap(value=>[false,true].flatMap(length=>['{}','{"text":','', '[]','null','42','"text"'].filter(root=>!(value.protocol==='anthropic'&&root==='')).map(root=>({...value,length,root})))) )('unclosed truncation $provider/$protocol length=$length root=$root',async({provider,model,protocol,length,root})=>{
 if(provider==='bedrock'){vi.stubEnv('BEDROCK_BASE_URL','');vi.stubEnv('AWS_ACCESS_KEY_ID','synthetic-access-key');vi.stubEnv('AWS_SECRET_ACCESS_KEY','synthetic-secret-key');vi.stubEnv('AWS_SESSION_TOKEN','');vi.stubEnv('AWS_PROFILE','');vi.stubEnv('AWS_REGION','us-east-1');config.setProviderCred(provider,{region:'us-east-1'});}else{vi.stubEnv(provider.toUpperCase()+'_API_KEY','');vi.stubEnv(provider.toUpperCase()+'_BASE_URL','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});}
 const selected:RouteCandidate={...route,provider,model,target:providerTarget(provider).key,price:{input:2,output:5}},{ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();let calls=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});calls++;
 if(protocol==='bedrock')return wireResponse(Buffer.concat([awsEvent('messageStart',{role:'assistant'}),awsEvent('contentBlockStart',{contentBlockIndex:0,start:{toolUse:{toolUseId:'call_1',name:'echo'}}}),awsEvent('contentBlockDelta',{contentBlockIndex:0,delta:{toolUse:{input:root}}}),awsEvent('messageStop',{stopReason:length?'max_tokens':'tool_use'}),awsEvent('metadata',{usage:{inputTokens:7,outputTokens:3}})]),'application/vnd.amazon.eventstream');
 if(protocol==='chat'){const base={id:'chat_typed',object:'chat.completion.chunk',created:1,model};const events=[{...base,choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'echo',arguments:root}}]}}]},{...base,choices:[{index:0,delta:{},finish_reason:length?'length':'tool_calls'}]},{...base,choices:[],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}];return wireResponse(Buffer.from(events.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n'),'text/event-stream');}
 const wire=syntheticWire(protocol as any,'tool',true);return wireResponse(Buffer.from(wire.body.toString().split('\n\n').filter(Boolean).map(frame=>{const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data||data==='data: [DONE]')return frame+'\n\n';const value=JSON.parse(data.slice(6));if(value.type==='content_block_stop')return '';if(protocol==='anthropic'){if(value.type==='content_block_delta')value.delta.partial_json=root;if(value.type==='message_delta')value.delta.stop_reason=length?'max_tokens':'tool_use';}else{for(const choice of value.choices??[]){if(choice.delta?.tool_calls)choice.delta.tool_calls[0].function.arguments=root;if(choice.finish_reason)choice.finish_reason=length?'length':'tool_calls';}}return (protocol==='anthropic'?'event: '+value.type+'\n':'')+'data: '+JSON.stringify(value)+'\n\n';}).join('')),wire.type);}));
 const operation=chat(provider,messages,[],model,()=>{},retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 const truncated=length&&['{}','{"text":',''].includes(root);
 if(truncated){const result=await operation;if(truncated){expect(result.toolCalls??[]).toHaveLength(0);expect(result.truncatedToolCalls).toBe(true);}else expect(result.toolCalls![0]!.arguments).toEqual({});expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(calls).toBe(1);expect(retry).not.toHaveBeenCalled();
});


it.each([
 ...(['openai','deepseek'] as const).flatMap(provider=>['id','name','both'].map(missing=>({provider,protocol:'chat' as const,stream:true,missing}))),
 ...[false,true].map(stream=>({provider:'openai' as const,protocol:'responses' as const,stream,missing:'none'})),
].flatMap(value=>['{}','{"text":','', '[]','null','42','"text"'].map(root=>({...value,root}))))('all truncation $provider/$protocol stream=$stream missing=$missing root=$root',async({provider,protocol,stream,missing,root})=>{
 vi.stubEnv(provider.toUpperCase()+'_API_KEY','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider,model:protocol==='responses'?'gpt-6-test':provider==='openai'?'gpt-4-test':'deepseek-chat-test',target:providerTarget(provider).key,price:{input:2,output:5}}, {ledger,budget}=accounting(selected,true),captured=vi.fn(async()=>{}),retry=vi.fn();
 vi.stubGlobal('fetch',vi.fn(async()=>{
  if(protocol==='chat'){
   const tool={index:0,...(missing==='id'||missing==='both'?{}:{id:'call_1'}),type:'function',function:{...(missing==='name'||missing==='both'?{}:{name:'echo'}),arguments:root}};
   const events=[{choices:[{index:0,delta:{tool_calls:[tool]}}]},{choices:[{index:0,delta:{},finish_reason:'length'}]},{choices:[],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}];
   return wireResponse(Buffer.from(events.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('')+'data: [DONE]\n\n'),'text/event-stream');
  }
  const value=JSON.parse(syntheticWire('responses','tool',false).body.toString());value.status='incomplete';value.incomplete_details={reason:'max_output_tokens'};value.output[0].arguments=root;value.output[0].status='incomplete';
  if(!stream)return json(value);
  const wire=syntheticWire('responses','tool',true);
  return wireResponse(Buffer.from(wire.body.toString().split('\n\n').filter(Boolean).map(frame=>{const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data)return frame+'\n\n';const event=JSON.parse(data.slice(6));if(event.type==='response.completed')return 'event: response.incomplete\ndata: '+JSON.stringify({type:'response.incomplete',response:value})+'\n\n';return frame+'\n\n';}).join('')),'text/event-stream');
 }));
 const operation=chat(provider,messages,[],selected.model,stream?()=>{}:undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(['{}','{"text":',''].includes(root)){const result=await operation;expect(result.toolCalls??[]).toHaveLength(0);expect(result.truncatedToolCalls).toBe(true);expect(captured).toHaveBeenCalledTimes(1);expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('settled');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(fetch).toHaveBeenCalledTimes(1);expect(retry).not.toHaveBeenCalled();
});


it.each([{protocol:'anthropic' as const,stream:true},{protocol:'responses' as const,stream:false},{protocol:'responses' as const,stream:true}].flatMap(value=>['{}','[]','null','42','"text"'].map(root=>({...value,root}))))('refusal root $protocol stream=$stream root=$root',async({protocol,stream,root})=>{
 const provider=protocol==='anthropic'?'anthropic':'openai';vi.stubEnv(provider.toUpperCase()+'_API_KEY','');config.setProviderCred(provider,{apiKey:'synthetic',baseUrl:'https://capture.invalid/v1'});
 const selected:RouteCandidate={...route,provider,model:protocol==='responses'?'gpt-6-test':route.model,target:providerTarget(provider).key,price:{input:2,output:5}}, {ledger,budget}=accounting(selected,true),captured=vi.fn(async(_value:ProviderResponseCheckpoint)=>{}),retry=vi.fn();let calls=0;
 vi.stubGlobal('fetch',vi.fn(async input=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.pathname.endsWith('/count_tokens'))return json({input_tokens:7});calls++;
  const wire=syntheticWire(protocol,'tool',stream);
  if(!stream){const value=JSON.parse(wire.body.toString());value.status='failed';value.output[0].arguments=root;return json(value);}
  return wireResponse(Buffer.from(wire.body.toString().split('\n\n').filter(Boolean).map(frame=>{const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data)return frame+'\n\n';const event=JSON.parse(data.slice(6));if(protocol==='anthropic'){if(event.type==='content_block_delta')event.delta.partial_json=root;if(event.type==='message_delta')event.delta.stop_reason='refusal';}else if(event.type==='response.completed'){event.type='response.failed';event.response.status='failed';event.response.output[0].arguments=root;}return 'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n';}).join('')),wire.type);
 }));
 const operation=chat(provider,messages,[],selected.model,stream?()=>{}:undefined,retry,{maxOutputTokens:100,attemptBudget:budget,maxProviderRetries:2,onStreamReset:()=>{},onResponseReceived:captured});
 if(root==='{}'){if(stream)await expect(operation).rejects.toBeInstanceOf(Error);else expect((await operation).finishReason).toBe('error');expect(captured).toHaveBeenCalledTimes(1);expect(captured.mock.calls[0]![0].response.finishReason).toBe('error');expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 else{await expect(operation).rejects.toBeInstanceOf(StreamProtocolError);expect(captured).not.toHaveBeenCalled();expect(Object.values(ledger.read(project).projection.requests)[0]!.state).toBe('unknown');}
 expect(calls).toBe(1);expect(retry).not.toHaveBeenCalled();
});
