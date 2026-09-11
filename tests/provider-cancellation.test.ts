/** Synthetic transport faults exercise real adapters; these are not wire captures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, Message } from '../src/types.js';

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('openai', () => ({ default: class {
  chat = { completions: { create: transport.request } };
  responses = {
    create: transport.request,
    stream: (body: unknown, options: unknown) => ({
      async *[Symbol.asyncIterator]() { await transport.request(body, options); },
    }),
  };
} }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  messages = { create: transport.request, stream: transport.request };
} }));
vi.mock('@google/genai', () => ({ GoogleGenAI: class {
  getGenerativeModel() { return { startChat: () => ({ sendMessage: transport.request, sendMessageStream: transport.request }) }; }
} }));
vi.mock('../src/config.js', () => ({
  getApiKey: () => 'synthetic-test-key',
  getBaseUrl: () => 'http://fixture.invalid',
  getProviderCred: () => ({ region: 'us-east-1' }),
}));
vi.mock('../src/model-detection.js', () => ({ getModelContextLimit: () => 128000, getModelMaxOutput: () => 8192 }));

import { chatAnthropic } from '../src/providers/anthropic.js';
import { chatOpenAI } from '../src/providers/openai.js';
import { chatGoogle } from '../src/providers/google.js';
import { chatOllama } from '../src/providers/ollama.js';
import { chatBedrock } from '../src/providers/bedrock.js';
import { chatOpenAICompatible } from '../src/providers/compat.js';

const messages: Message[] = [{ role: 'user', content: 'test' }];
type Request = (signal: AbortSignal, stream?: (text: string) => void) => Promise<unknown>;
const cases: [string, Request][] = [
  ['Anthropic', (signal, stream) => chatAnthropic(messages, [], 'fixture-model', stream, signal)],
  ['OpenAI Chat Completions', (signal, stream) => chatOpenAI(messages, [], 'fixture-model', stream, signal)],
  ['OpenAI Responses', (signal, stream) => chatOpenAI(messages, [], 'o3-fixture', stream, signal)],
  ['Google', (signal, stream) => chatGoogle(messages, [], 'fixture-model', stream, signal)],
  ['Ollama', (signal, stream) => chatOllama(messages, [], 'fixture-model', stream, { signal })],
  ['Bedrock native', (signal, stream) => chatBedrock(messages, [], 'fixture-model', stream, signal)],
  ...(['openrouter', 'together', 'groq', 'fireworks', 'mistral', 'ai21', 'huggingface', 'litellm', 'bedrock', 'openai-compat'] as LLMProvider[])
    .map(provider => [provider, (signal, stream) => chatOpenAICompatible(provider, messages, [], 'fixture-model', stream, signal)] as [string, Request]),
];

beforeEach(() => {
  transport.request.mockReset();
  transport.request.mockImplementation((_body: unknown, options: { signal?: AbortSignal }) => {
    if (!options?.signal) throw new Error('Transport did not receive AbortSignal');
    return new Promise((_, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (options.signal!.aborted) abort();
      else options.signal!.addEventListener('abort', abort, { once: true });
    });
  });
  vi.stubGlobal('fetch', transport.request);
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic-access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-secret-key');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

for (const streaming of [false, true]) {
  describe(streaming ? 'streaming cancellation' : 'request cancellation', () => {
    it.each(cases)('%s reaches the underlying transport', async (_label, request) => {
      const controller = new AbortController();
      const output = vi.fn();
      const result = request(controller.signal, streaming ? output : undefined);
      const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(transport.request).toHaveBeenCalledTimes(1));
      expect(transport.request.mock.calls[0]![1].signal).toBe(controller.signal);
      controller.abort();
      await assertion;
      expect(output).not.toHaveBeenCalled();
      expect(transport.request).toHaveBeenCalledTimes(1);
    });
  });
}
