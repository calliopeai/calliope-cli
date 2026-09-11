/** Actual SDKs parse synthetic HTTP responses. No SDK mocks, no network. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKENDS, TOOL, PROBE_TEXT, invoke, probeMessages, normalize } from '../scripts/conformance/contract.mjs';
import { syntheticWire, wireResponse } from './helpers/provider-wire.js';
import * as anthropic from '../src/providers/anthropic.js';
import * as google from '../src/providers/google.js';
import * as openai from '../src/providers/openai.js';
import * as compat from '../src/providers/compat.js';
import * as ollama from '../src/providers/ollama.js';
import * as bedrock from '../src/providers/bedrock.js';
import * as config from '../src/config.js';
const adapters = { anthropic, google, openai, compat, ollama, bedrock };
const requests: any[] = [];
beforeEach(() => {
  requests.length = 0;
  vi.spyOn(config, 'getApiKey').mockReturnValue('synthetic-test-key');
  vi.spyOn(config, 'getBaseUrl').mockReturnValue('https://replay.invalid/v1');
  vi.spyOn(config, 'getProviderCred').mockReturnValue({ region: 'us-east-1' });
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-access-key'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
for (const backend of BACKENDS) describe(backend.id, () => {
  const model = backend.protocol === 'responses' ? 'gpt-5-test' : 'test-model';
  for (const stream of [false, true]) for (const scenario of ['text', 'tool', 'length'] as const) {
    it(`${stream ? 'fragmented stream' : 'JSON'} ${scenario}: content, usage and finish reason`, async () => {
      const wire = syntheticWire(backend.protocol, scenario, stream);
      vi.stubGlobal('fetch', vi.fn(async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return wireResponse(wire.body, wire.type, stream ? 7 : wire.body.length);
      }));
      const tokens: string[] = [];
      const result = await invoke(adapters, backend, model, probeMessages(scenario), [TOOL], stream ? (token: string) => tokens.push(token) : undefined);
      expect(normalize(result)).toEqual({ content: scenario === 'tool' ? '' : PROBE_TEXT,
        finishReason: scenario === 'tool' ? 'tool_use' : scenario === 'length' ? 'length' : 'stop',
        usage: { inputTokens: 7, outputTokens: 3 }, tools: scenario === 'tool' ? [{ name: 'echo', arguments: { text: 'hello' } }] : [] });
      if (stream) expect(tokens.join('')).toBe(scenario === 'tool' ? '' : PROBE_TEXT);
      expect(requests).toHaveLength(1);
      if (scenario === 'tool') expect(result.toolCalls?.[0].id).toEqual(expect.any(String));
    });
  }
  it('cancels an in-flight HTTP request without fallback', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      queueMicrotask(() => controller.abort());
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(invoke(adapters, backend, model, probeMessages('text'), [], () => {}, controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  if (backend.protocol !== 'ollama') for (const stream of [false, true]) it(`maps a rejected completion to error (${stream ? 'stream' : 'JSON'})`, async () => {
    const wire = syntheticWire(backend.protocol, 'error', stream);
    vi.stubGlobal('fetch', vi.fn(async () => wireResponse(wire.body, wire.type)));
    const response = await invoke(adapters, backend, model, probeMessages('text'), [], stream ? () => {} : undefined);
    expect(response.finishReason).toBe('error');
  });
  it('preserves all system instructions, including a trailing mode directive', async () => {
    const wire = syntheticWire(backend.protocol, 'text', false);
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => { requests.push(JSON.parse(String(init?.body))); return wireResponse(wire.body, wire.type); }));
    await invoke(adapters, backend, model, [
      { role: 'system', content: 'ROOT_INSTRUCTIONS' }, { role: 'user', content: 'USER_PROMPT' }, { role: 'system', content: 'MODE_DIRECTIVE' },
    ], []);
    const body = JSON.stringify(requests[0]); expect(body).toContain('ROOT_INSTRUCTIONS'); expect(body).toContain('MODE_DIRECTIVE');
    if (backend.protocol === 'google') expect(requests[0].contents.at(-1)).toMatchObject({ role: 'user', parts: [{ text: 'USER_PROMPT' }] });
  });
  it('sends a tool result with its call association on the next turn', async () => {
    const wire = syntheticWire(backend.protocol, 'text', false);
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => { requests.push(JSON.parse(String(init?.body))); return wireResponse(wire.body, wire.type); }));
    await invoke(adapters, backend, model, [
      { role: 'user', content: 'echo hello' }, { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'echo', arguments: { text: 'hello' } }] },
      { role: 'tool', toolCallId: 'call_1', content: 'hello' },
    ], [TOOL]);
    const body = JSON.stringify(requests[0]);
    expect(body).toContain('hello');
    if (backend.protocol === 'google') expect(requests[0].contents.at(-1).parts[0]).toMatchObject({ functionResponse: { name: 'echo', response: { result: 'hello' } } });
    else if (backend.protocol === 'responses') expect(requests[0].input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    else if (backend.protocol === 'anthropic') expect(requests[0].messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    else if (backend.protocol === 'bedrock') expect(requests[0].messages.at(-1).content[0]).toMatchObject({ toolResult: { toolUseId: 'call_1' } });
    else if (backend.protocol === 'ollama') expect(requests[0].messages.at(-1)).toMatchObject({ role: 'tool', content: 'hello' });
    else expect(requests[0].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
  });
});

it('caps native Bedrock output before signing the request', async () => {
  const wire = syntheticWire('bedrock', 'text', false);
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => { requests.push(JSON.parse(String(init?.body))); return wireResponse(wire.body, wire.type); }));
  await bedrock.chatBedrock(probeMessages('text'), [], 'test-model', undefined, undefined, 32);
  expect(requests[0].inferenceConfig.maxTokens).toBe(32);
  await expect(bedrock.chatBedrock([], [], 'test-model', undefined, undefined, -1)).rejects.toThrow('positive integer');
});

it.each(['{broken}\n', '{"error":"probe failure"}\n', '{"message":{"content":"partial"},"done":false}\n'])('fails closed on corrupt or incomplete Ollama streams: %s', async body => {
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(Buffer.from(body), 'application/x-ndjson', 1)));
  await expect(ollama.chatOllama(probeMessages('text'), [], 'test-model', () => {})).rejects.toThrow();
});
it('handles an Ollama final frame without a trailing newline', async () => {
  const wire = syntheticWire('ollama', 'text', true);
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(wire.body.subarray(0, wire.body.length - 1), wire.type, 1)));
  expect((await ollama.chatOllama(probeMessages('text'), [], 'test-model', () => {})).content).toBe(PROBE_TEXT);
});
it('rejects an Ollama error envelope with HTTP 200', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(Buffer.from('{"error":"probe failure"}'), 'application/json')));
  await expect(ollama.chatOllama(probeMessages('text'), [], 'test-model')).rejects.toThrow('probe failure');
});

it.each(BACKENDS.filter(backend => backend.protocol === 'chat'))('$id exposes missing streaming usage as unavailable', async backend => {
  const wire = syntheticWire('chat', 'text', true);
  const body = Buffer.from(wire.body.toString().split('\n\n').filter(frame => !frame.includes('"usage"')).join('\n\n'));
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(body, wire.type)));
  const result = await invoke(adapters, backend, 'test-model', probeMessages('text'), [], () => {});
  expect(result.usage).toBeUndefined(); expect(result.warnings?.join(' ')).toContain('incomplete');
});

it('cancels and unlocks an Ollama response body after a malformed frame', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{broken}\n')); }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
  await expect(ollama.chatOllama(probeMessages('text'), [], 'test-model', () => {})).rejects.toThrow('Malformed JSON');
  expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
});
