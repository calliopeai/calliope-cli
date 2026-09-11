/** Real routing, runtime, permission resolver, audit store and SDK transport. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import { clearModelCache } from '../src/model-detection.js';
import { runTurn, type TurnOptions } from '../src/runtime/index.js';
import { RunLog, readRunLog, verifyChain, resetRunLogs } from '../src/runlog.js';
import { renderReplay } from '../src/replay.js';
import { runHeadless } from '../src/headless.js';
import type { Message } from '../src/types.js';
import { saveProjectDefaults } from '../src/preferences/index.js';
import { trustProject } from '../src/trust.js';

let root: string, requests: { model: string; messages: unknown[] }[];
let toolSupport: boolean;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const completion = (model: string) => json({ id: 'toy-response', object: 'chat.completion', model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
beforeEach(() => {
  config.resetConfig(); clearModelCache(); resetRunLogs();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-routing-runtime-')));
  requests = []; toolSupport = true;
  for (const provider of config.getProviderNames()) {
    const env = config.getProviderEnvVars(provider);
    for (const name of [env.apiKey, env.baseUrl]) if (name) vi.stubEnv(name, '');
  }
  for (const provider of ['deepseek', 'xai'] as const) config.setProviderCred(provider, { apiKey: 'fake', baseUrl: `https://${provider}.invalid/v1` });
  config.set('routing', { enabled: true, costSensitivity: 1, providerPool: ['deepseek', 'xai'] });
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input)), provider = url.hostname.split('.')[0]!;
    if (url.pathname === '/v1/models') return json({ data: [{ id: `${provider}-live`, capabilities: { tools: toolSupport }, pricing: { input: provider === 'xai' ? 1 : 3, output: provider === 'xai' ? 1 : 9 } }] });
    expect(url.pathname).toBe('/v1/chat/completions');
    const body = JSON.parse(String(init?.body)); requests.push(body); return completion(body.model);
  }));
});
afterEach(() => { config.resetConfig(); clearModelCache(); resetRunLogs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
function options(extra: Partial<TurnOptions> = {}): TurnOptions {
  return { client: 'headless', sessionId: 'route-runtime', cwd: root, provider: 'auto', prompt: 'Say done.',
    messages: { current: [{ role: 'user', content: 'Say done.' }] }, confirmation: 'none', maxIterations: 2, tools: () => [],
    runlog: RunLog.open('route-runtime', { dir: join(root, 'runs') }), ...extra };
}

it('uses project, environment and explicit invocation preferences in headless JSON without persisting overrides', async () => {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true; });
  trustProject(root); await saveProjectDefaults(root, { provider: 'deepseek', model: 'deepseek-live' });
  const invoke = (provider?: 'deepseek') => runHeadless({ cwd: root, provider, prompt: 'Say done.', maxIterations: 1, outputMode: 'json' });
  expect(await invoke()).toBe(0);
  vi.stubEnv('CALLIOPE_PROVIDER', 'xai');
  expect(await invoke()).toBe(0);
  expect(await invoke('deepseek')).toBe(0);
  expect(requests.map(request => request.model)).toEqual(['deepseek-live', 'xai-live', 'deepseek-live']);
  const events = chunks.join('').trim().split('\n').map(line => JSON.parse(line));
  const sources = events.filter(event => event.data.routing).map(event => event.data.routing.preferenceSources.provider);
  expect(sources).toEqual(['project', 'project', 'environment', 'environment', 'turn', 'turn']);
  expect(events.filter(event => event.type === 'done')).toHaveLength(3);
  expect(config.get('defaultProvider')).toBe('auto');
});

it('reports malformed project or invocation preferences in the headless error envelope before inference', async () => {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true; });
  expect(await runHeadless({ cwd: root, model: '', prompt: 'No inference', outputMode: 'json' })).toBe(2);
  trustProject(root); writeFileSync(join(root, '.calliope-models.json'), '{');
  expect(await runHeadless({ cwd: root, prompt: 'No inference', outputMode: 'json' })).toBe(2);
  expect(chunks.map(line => JSON.parse(line)).every(event => event.type === 'error' && typeof event.data.message === 'string')).toBe(true);
  expect(requests).toEqual([]);
});

it.each(['terminal', 'headless', 'acp', 'library'] as const)('routes %s runtime requests using live metadata and keeps original preferences in the audit trail', async client => {
  const opts = options({ client }), onRoute = vi.fn();
  expect((await runTurn({ ...opts, onRoute })).reason).toBe('completed');
  expect(requests.map(request => request.model)).toEqual(['xai-live']);
  expect(onRoute.mock.calls.every(([decision]) => decision.requested.provider === 'auto')).toBe(true);
  expect(opts.messages.current.at(-1)?.providerMetadata).toMatchObject({ calliopeRouting: { provider: 'xai', model: 'xai-live' } });
  const events = readRunLog(opts.runlog!.filePath), chain = verifyChain(events);
  expect(chain).toEqual({ ok: true });
  expect(events.filter(event => event.type === 'routing_decision')).toHaveLength(2);
  expect(renderReplay(events, chain)).toContain('route: xai/xai-live');
  expect(renderReplay(events, chain)).toBe(renderReplay(readRunLog(opts.runlog!.filePath), chain));
});

it('stops incompatible explicit models before any inference or filesystem mutation', async () => {
  toolSupport = false;
  const opts = options({ provider: 'deepseek', model: 'deepseek-live', tools: () => [{ name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: {}, required: [] } }] });
  await expect(runTurn(opts)).rejects.toThrow('No eligible');
  expect(requests).toEqual([]);
  expect(existsSync(join(root, 'should-not-exist'))).toBe(false);
  const event = readRunLog(opts.runlog!.filePath).find(item => item.type === 'routing_decision');
  expect(event?.decision).toMatchObject({ status: 'unavailable', exclusions: [{ reason: 'discovery-rejects-tools' }] });
});

it('prevents client prepare callbacks from replacing an explicit provider', async () => {
  await expect(runTurn(options({ provider: 'deepseek', model: 'deepseek-live', prepare: async request => ({ ...request, provider: 'xai', model: 'xai-live' }) }))).rejects.toThrow('cannot change');
  expect(requests).toHaveLength(0);
});

it('validates compression models before sending auxiliary inference', async () => {
  const compressor = await import('../src/auto-compressor.js');
  vi.spyOn(compressor, 'autoCompress').mockImplementationOnce(async (messages, _limit, _provider, _model, _signal, request) => {
    await request!(messages, 'unavailable-summary-model');
    throw new Error('should not pass routing');
  });
  const opts = options({ provider: 'deepseek', model: 'deepseek-live' });
  await expect(runTurn(opts)).rejects.toThrow('No eligible');
  expect(requests).toEqual([]);
  const decisions = readRunLog(opts.runlog!.filePath).filter(event => event.type === 'routing_decision');
  expect(decisions.at(-1)?.decision).toMatchObject({ status: 'unavailable', exclusions: [{ reason: 'model-not-in-live-discovery' }] });
});

it('cancels discovery before dispatch and persists a cancellation decision', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignal; started();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })));
  const controller = new AbortController(), opts = options({ signal: controller.signal });
  const pending = runTurn(opts); await ready; controller.abort();
  expect((await pending).reason).toBe('cancelled');
  expect(readRunLog(opts.runlog!.filePath).find(event => event.type === 'routing_decision')?.decision).toMatchObject({ status: 'cancelled' });
  expect(requests).toEqual([]);
});

it('exposes automatic selection through stable headless JSON status events', async () => {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { chunks.push(String(chunk)); return true; });
  expect(await runHeadless({ cwd: root, provider: 'auto', prompt: 'Say done.', maxIterations: 1, outputMode: 'json' })).toBe(0);
  const events = chunks.join('').trim().split('\n').map(line => JSON.parse(line));
  expect(events.every(event => typeof event.type === 'string' && typeof event.timestamp === 'string' && typeof event.data === 'object')).toBe(true);
  expect(events.find(event => event.data.routing)?.data).toMatchObject({ provider: 'xai', model: 'xai-live', routing: { version: 1, requested: { provider: 'auto', model: null } } });
  expect(events.find(event => event.type === 'message')?.data.content).toBe('Done.');
  expect(events.at(-1)?.type).toBe('done');
  expect(requests.map(request => request.model)).toEqual(['xai-live']);
});

it('records a recoverable model error and revalidates the pinned route on retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const transport = vi.mocked(fetch).getMockImplementation()!;
  let failed = false, notify!: () => void;
  const errorSeen = new Promise<void>(resolve => { notify = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    if (String(input).endsWith('/chat/completions') && !failed) { failed = true; return new Response('{"error":{"message":"synthetic rejection"}}', { status: 401, headers: { 'content-type': 'application/json' } }); }
    return transport(input, init);
  }));
  const opts = options({ provider: 'deepseek', model: 'deepseek-live', onError: () => { notify(); return 'retry'; } });
  const pending = runTurn(opts); await errorSeen; await vi.advanceTimersByTimeAsync(2000);
  expect((await pending).reason).toBe('completed');
  expect(requests).toHaveLength(1);
  expect(readRunLog(opts.runlog!.filePath).filter(event => event.type === 'routing_decision')).toHaveLength(3);
});

it('uses discovered prices for actual usage and labels the audit cost source', async () => {
  const opts = options(), usage = vi.fn();
  const result = await runTurn({ ...opts, onUsage: usage });
  expect(result.totals.cost).toBeCloseTo(0.000015, 10);
  expect(usage.mock.calls[0]?.[2]).toBeCloseTo(result.totals.cost);
  expect(readRunLog(opts.runlog!.filePath).find(event => event.type === 'assistant_message')).toMatchObject({ costSource: 'discovery', cost: result.totals.cost });
});

it('adapts the built-in prompt before inference while preserving loaded project instructions', async () => {
  const { getSystemPromptForProvider } = await import('../src/local-model.js');
  const suffix = '\n\n--- Project Context ---\nUser-loaded project instruction.';
  const opts = options({ messages: { current: [{ role: 'system', content: getSystemPromptForProvider('ollama') + suffix }, { role: 'user', content: 'go' }] } });
  await runTurn(opts);
  expect(requests[0]?.messages[0]).toMatchObject({ role: 'system', content: getSystemPromptForProvider('xai') + suffix });
  expect(opts.messages.current[0]?.content).toBe(getSystemPromptForProvider('xai') + suffix);
});

it('keeps custom system prompts intact', async () => {
  const opts = options({ messages: { current: [{ role: 'system', content: 'Custom caller instructions.' }, { role: 'user', content: 'go' }] } });
  await runTurn(opts);
  expect(requests[0]?.messages[0]).toMatchObject({ content: 'Custom caller instructions.' });
});

it('still enforces non-interactive mutation permissions after automatic routing', async () => {
  const transport = vi.mocked(fetch).getMockImplementation()!;
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    if (String(input).endsWith('/chat/completions') && calls++ === 0) return json({ id: 'tool-response', model: 'xai-live', choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'should-not-exist', content: 'denied' }) } }] }, finish_reason: 'tool_calls' }] });
    return transport(input, init);
  }));
  const opts = options({ confirmation: 'mutating', tools: () => [{ name: 'write_file', description: 'Write', parameters: { type: 'object', properties: {}, required: [] } }] });
  await runTurn(opts);
  expect(existsSync(join(root, 'should-not-exist'))).toBe(false);
  expect(readRunLog(opts.runlog!.filePath).filter(event => event.type === 'policy_event')).toEqual(expect.arrayContaining([expect.objectContaining({ decision: 'confirm', source: 'confirmation' })]));
  expect(opts.messages.current.find(message => message.role === 'tool')?.content).toContain('confirmation required');
});

it('halts automatic dispatch if health changes after route selection without claiming an explicit recovery', async () => {
  const { HealthStore, providerTarget } = await import('../src/health/index.js');
  let decisions = 0;
  const warnings: string[] = [];
  const opts = options({ onRoute: decision => {
    if (!decision.selected || ++decisions !== 2) return;
    const provider = decision.selected.provider, store = new HealthStore(), target = providerTarget(provider);
    for (let i = 0; i < 3; i++) store.append({ provider, target: target.key, type: 'attempt', outcome: 'error', failure: 'server' });
  }, onWarning: warning => warnings.push(warning) });
  await expect(runTurn(opts)).rejects.toThrow('automatic inference stopped');
  expect(requests).toHaveLength(0);
  expect(readRunLog(opts.runlog!.filePath).find(event => event.type === 'policy_event')).toMatchObject({ source: 'provider-health', decision: 'deny' });
  expect(warnings.join(' ')).not.toContain('explicit selection');
});

it.each(['anthropic', 'openai', 'google'] as const)('uses the same custom %s endpoint for discovery, diagnostics and inference', async provider => {
  const model = provider === 'anthropic' ? 'claude-custom' : provider === 'openai' ? 'gpt-custom' : 'gemini-custom';
  const baseUrl = `https://${provider}.invalid/proxy${provider === 'google' ? '/v1beta' : '/v1'}`;
  config.setProviderCred(provider, { apiKey: 'fake', baseUrl });
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(String(input)); seen.push(url.href);
    expect(url.href.startsWith(baseUrl + '/')).toBe(true);
    if (url.pathname.endsWith('/models')) return json(provider === 'google' ? { models: [{ name: `models/${model}`, supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: model }] });
    if (provider === 'anthropic') return json({ id: 'response', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
    if (provider === 'google') return json({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });
    return completion(model);
  }));
  const opts = options({ provider, model });
  expect((await runTurn(opts)).reason).toBe('completed');
  expect(seen).toHaveLength(2);
  const { providerTarget } = await import('../src/health/index.js');
  expect(providerTarget(provider).endpoint).toBe(`https://${provider}.invalid/[configured-path]`);
});
