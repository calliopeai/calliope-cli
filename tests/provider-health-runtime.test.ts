import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as config from '../src/config.js';
import { chat, selectProvider } from '../src/providers/index.js';
import { HealthStore, providerTarget, summarizeHealth } from '../src/health/index.js';
import { handleCommand, type CommandContext } from '../src/ui/commands.js';
import type { Message } from '../src/types.js';

const messages: Message[] = [{ id: 'toy', role: 'user', content: 'Say hello.', timestamp: new Date() }];
const success = () => new Response(JSON.stringify({
  id: 'synthetic', object: 'chat.completion', created: 1, model: 'discovered-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
}), { headers: { 'content-type': 'application/json' } });
const failure = (status: number) => new Response(JSON.stringify({ error: { message: 'Synthetic failure' } }), {
  status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
});
const snapshot = () => {
  const store = new HealthStore();
  return summarizeHealth(store.read(), providerTarget('deepseek'), store.settings);
};

beforeEach(() => {
  config.resetConfig();
  for (const provider of config.getProviderNames()) {
    const vars = config.getProviderEnvVars(provider);
    for (const name of [vars.apiKey, vars.baseUrl]) if (name) vi.stubEnv(name, '');
  }
  for (const name of ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID']) vi.stubEnv(name, '');
  config.setProviderCred('deepseek', { apiKey: 'synthetic-only', baseUrl: 'https://health.invalid/v1' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected networking'); }));
});
afterEach(() => { config.resetConfig(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('quarantines repeated real adapter failures, skips in auto mode and honors explicit recovery', async () => {
  config.setProviderCred('xai', { apiKey: 'synthetic-only' });
  vi.stubGlobal('fetch', vi.fn(async () => failure(401)));
  for (let i = 0; i < 3; i++) await expect(chat('deepseek', messages, [], 'discovered-model')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(snapshot().quarantine).toMatchObject({ active: true, failures: 3, reason: 'authentication' });
  expect(selectProvider('auto')).toBe('xai');
  expect(selectProvider('deepseek')).toBe('deepseek');
  vi.stubGlobal('fetch', vi.fn(async () => success()));
  const warning = vi.fn();
  expect((await chat('deepseek', messages, [], 'discovered-model', undefined, undefined, { onHealthWarning: warning })).content).toBe('Hello.');
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('honoring your explicit selection'));
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('https://health.invalid/v1/chat/completions');
  expect(snapshot()).toMatchObject({ sampleCount: 4, capabilities: { usage: true }, quarantine: { active: false } });
  expect(selectProvider('auto')).toBe('deepseek');
});

it('records each shared retry attempt and successful recovery through the real SDK parser', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(failure(503)).mockImplementation(async () => success()));
  let notify!: () => void;
  const retry = new Promise<void>(resolve => { notify = resolve; });
  const pending = chat('deepseek', messages, [], 'discovered-model', undefined, () => notify());
  await retry;
  await vi.advanceTimersByTimeAsync(30000);
  await pending;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new HealthStore().read().map(e => [e.outcome, e.retryIndex])).toEqual([['error', 0], ['success', 1]]);
  expect(snapshot()).toMatchObject({ errorRate: 0.5, retryRate: 0.5, quarantine: { active: false } });
});

it('cancels an in-flight HTTP request without retries or counting cancellation as a provider failure', async () => {
  let notify!: () => void, signal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { notify = resolve; });
  vi.stubGlobal('fetch', vi.fn((_input, init) => {
    signal = init?.signal as AbortSignal;
    notify();
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  }));
  const controller = new AbortController();
  const pending = chat('deepseek', messages, [], 'discovered-model', undefined, undefined, { signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  await ready; controller.abort(); await rejected;
  expect(signal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(new HealthStore().read()).toEqual([expect.objectContaining({ outcome: 'cancelled', capabilities: { cancellation: true } })]);
  expect(snapshot()).toMatchObject({ sampleCount: 0, quarantine: { active: false } });
});

it('dispatches a keyless configured OpenAI-compatible endpoint and isolates its health target', async () => {
  config.setProviderCred('openai-compat', { baseUrl: 'http://localhost:12345' });
  vi.stubGlobal('fetch', vi.fn(async () => success()));
  await chat('openai-compat', messages, [], 'local-discovered-model');
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('http://localhost:12345/v1/chat/completions');
  expect(new HealthStore().read()[0]).toMatchObject({ provider: 'openai-compat', outcome: 'success' });
  expect(snapshot().sampleCount).toBe(0);
});

it('uses the same doctor JSON contract and cancellation signal in the REPL', async () => {
  const addMessage = vi.fn();
  await handleCommand('/doctor provider deepseek --json', { addMessage } as unknown as CommandContext);
  expect(JSON.parse(addMessage.mock.calls[0]![1])).toMatchObject({ version: 1, localOnly: true, providers: [{ provider: 'deepseek' }] });
  addMessage.mockClear();
  await handleCommand('/doctor provider deepseek --probe --json', { addMessage, signal: AbortSignal.abort() } as unknown as CommandContext);
  expect(addMessage.mock.calls[0]![0]).toBe('error');
  expect(JSON.parse(addMessage.mock.calls[0]![1]).error).toBe('cancelled');
  expect(fetch).not.toHaveBeenCalled();
});
