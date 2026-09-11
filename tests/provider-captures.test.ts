/** Captured wire replay stays separate from synthetic protocol tests. */
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BACKENDS, TOOL, invoke, probeMessages, normalize } from '../scripts/conformance/contract.mjs';
import { digest, validateCapture, replayFetch, missingCaptures } from '../scripts/conformance/captures.mjs';
import { createRecorder } from '../scripts/conformance/recorder.mjs';
import { syntheticWire } from './helpers/provider-wire.js';
import * as anthropic from '../src/providers/anthropic.js';
import * as google from '../src/providers/google.js';
import * as openai from '../src/providers/openai.js';
import * as compat from '../src/providers/compat.js';
import * as ollama from '../src/providers/ollama.js';
import * as bedrock from '../src/providers/bedrock.js';
import * as config from '../src/config.js';
const adapters = { anthropic, google, openai, compat, ollama, bedrock };
const directory = new URL('./fixtures/provider-wire/', import.meta.url);
const captures = readdirSync(directory).filter(file => file.endsWith('.json')).map(file => validateCapture(JSON.parse(readFileSync(new URL(file, directory), 'utf8'))));
beforeEach(() => {
  vi.spyOn(config, 'getApiKey').mockReturnValue('offline-replay');
  vi.spyOn(config, 'getBaseUrl').mockReturnValue('https://replay.invalid/v1');
  vi.spyOn(config, 'getProviderCred').mockReturnValue({ region: 'us-east-1' });
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'offline-replay'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'offline-replay');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
for (const capture of captures) it(`captured ${capture.backend}/${capture.scenario}/${capture.stream ? 'stream' : 'json'}`, async () => {
  const replay = replayFetch(capture); vi.stubGlobal('fetch', replay.fetch);
  const backend = BACKENDS.find(backend => backend.id === capture.backend)!;
  // Preserve a private gateway's path prefix without contacting its origin.
  const endpointPath = capture.exchanges[0].request.path;
  if (backend.protocol === 'ollama') vi.mocked(config.getBaseUrl).mockReturnValue('https://replay.invalid' + endpointPath.replace(/\/api\/chat$/, ''));
  else if (backend.protocol === 'google') vi.mocked(config.getBaseUrl).mockReturnValue('https://replay.invalid' + endpointPath.replace(/\/v1beta\/models\/.*$/, ''));
  else if (backend.protocol === 'chat' && backend.provider !== 'openai') vi.mocked(config.getBaseUrl).mockReturnValue('https://replay.invalid' + endpointPath.replace(/\/chat\/completions$/, ''));
  const result = await invoke(adapters, backend, capture.model,
    probeMessages(capture.scenario), capture.scenario === 'tool' ? [TOOL] : [], capture.stream ? () => {} : undefined);
  expect(normalize(result)).toEqual(capture.expected);
  replay.assertConsumed();
});
it.skipIf(!process.env.CALLIOPE_REQUIRE_WIRE_CAPTURES)('release gate: captured text and tools, streaming and JSON, for every adapter', () => {
  expect(missingCaptures(captures), 'Real captured coverage is incomplete; synthetic responses do not satisfy this gate').toEqual([]);
});
// Harness tests use manufactured metadata only in memory; they are not entered
// into the captured corpus or counted toward its release gate.
function manufacturedCapture() {
  const wire = syntheticWire('chat', 'text', false);
  return { version: 1, backend: 'openai-chat', model: 'test-model', scenario: 'text', stream: false,
    provenance: { kind: 'captured', capturedAt: '2026-01-01T00:00:00Z', sdkVersions: { test: 'test' } }, expected: { content: 'Hello π', finishReason: 'stop', tools: [] },
    exchanges: [{ request: { method: 'POST', path: '/v1/chat/completions' }, status: 200, headers: { 'content-type': wire.type }, body: wire.body.toString('base64'), sha256: digest(wire.body) }] };
}
it('rejects synthetic provenance and altered bytes from the captured corpus', () => {
  const value = manufacturedCapture(); value.provenance.kind = 'synthetic'; expect(() => validateCapture(value)).toThrow('provenance');
  value.provenance.kind = 'captured'; value.exchanges[0].body = Buffer.from('altered').toString('base64'); expect(() => validateCapture(value)).toThrow('checksum');
});
it('rejects credential headers, wrong endpoints and extra replay requests', async () => {
  const value = manufacturedCapture(); (value.exchanges[0].headers as Record<string, string>).authorization = 'must-not-persist'; expect(() => validateCapture(value)).toThrow('headers');
  delete (value.exchanges[0].headers as Record<string, string>).authorization;
  const wrong = replayFetch(value); await expect(wrong.fetch('https://replay.invalid/other', { method: 'POST' })).rejects.toThrow('endpoint');
  const replay = replayFetch(value); expect(() => replay.assertConsumed()).toThrow('consumed');
  const response = await replay.fetch('https://replay.invalid/v1/chat/completions', { method: 'POST' }); expect((await response.json()).choices[0].message.content).toContain('Hello'); replay.assertConsumed();
  await expect(replay.fetch('https://replay.invalid/v1/chat/completions', { method: 'POST' })).rejects.toThrow('Unexpected');
});
it('keeps missing real evidence visible in the readiness report', () => {
  expect(missingCaptures([])).toHaveLength(BACKENDS.length * 4);
});

it('records response bytes without credentials and enforces the one-request limit', async () => {
  const fetch = vi.fn(async (_url, _init) => new Response('toy response', { headers: { 'content-type': 'text/plain', 'set-cookie': 'secret-cookie' } }));
  const recorder = createRecorder(fetch, { protocol: 'chat' }, 64, undefined);
  await recorder.fetch('https://probe.invalid/v1/chat/completions?api_key=secret-query', { method: 'POST', headers: { authorization: 'Bearer secret-key' }, body: JSON.stringify({ max_tokens: 8192, messages: [] }) });
  expect(JSON.parse(fetch.mock.calls[0][1].body).max_tokens).toBe(64);
  const record = JSON.stringify(recorder.exchanges);
  expect(record).not.toContain('secret'); expect(record).not.toContain('authorization');
  expect(recorder.exchanges[0].headers).toEqual({ 'content-type': 'text/plain' });
  expect(Buffer.from(recorder.exchanges[0].body, 'base64').toString()).toBe('toy response');
  await expect(recorder.fetch('https://probe.invalid/', {})).rejects.toThrow('request limit'); expect(fetch).toHaveBeenCalledTimes(1);
});
it('preserves a provider quota error through the real SDK without retry traffic', async () => {
  const upstream = vi.fn(async () => new Response(JSON.stringify({ error: {
    message: 'No credits remaining', type: 'insufficient_quota', code: 'credit_balance_exhausted',
  } }), { status: 429, headers: { 'content-type': 'application/json' } }));
  const recorder = createRecorder(upstream, { protocol: 'chat' }, 32);
  vi.stubGlobal('fetch', recorder.fetch);
  await expect(openai.chatOpenAI(probeMessages('text'), [], 'test-model')).rejects.toMatchObject({
    status: 429, code: 'credit_balance_exhausted',
  });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(recorder.exchanges[0].headers).toEqual({ 'content-type': 'application/json' });
});
it.each([
  ['google', { generationConfig: { temperature: 0 } }, { generationConfig: { temperature: 0, maxOutputTokens: 32 } }],
  ['ollama', { options: { temperature: 0 } }, { options: { temperature: 0, num_predict: 32 } }],
  ['responses', {}, { max_output_tokens: 32 }],
])('caps %s probe output while preserving other settings', async (protocol, input, expected) => {
  const fetch = vi.fn(async () => new Response('ok'));
  const recorder = createRecorder(fetch, { protocol }, 32, undefined);
  await recorder.fetch('https://probe.invalid/', { method: 'POST', body: JSON.stringify(input) });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(expected);
});
it('keeps signed Bedrock bytes unchanged and rejects an excessive signed cap', async () => {
  const fetch = vi.fn(async () => new Response('ok'));
  const original = '{ "inferenceConfig": { "maxTokens": 16 } }';
  const recorder = createRecorder(fetch, { protocol: 'bedrock' }, 32, undefined);
  await recorder.fetch('https://probe.invalid/', { method: 'POST', body: original });
  expect(fetch.mock.calls[0][1].body).toBe(original);
  await expect(createRecorder(fetch, { protocol: 'bedrock' }, 8).fetch('https://probe.invalid/', { method: 'POST', body: original })).rejects.toThrow('signed output cap');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('bounds captured bytes even when the response is streamed', async () => {
  const recorder = createRecorder(async () => new Response(new Uint8Array(1024 * 1024 + 1)), { protocol: 'chat' }, 32);
  await expect(recorder.fetch('https://probe.invalid/', { method: 'POST', body: '{}' })).rejects.toThrow('1 MiB');
});
