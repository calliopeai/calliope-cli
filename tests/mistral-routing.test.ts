/**
 * Regression tests for issue #145 (finding MODEL-mistral).
 *
 * Hosted OpenAI-compatible providers (mistral, together, groq, fireworks,
 * openrouter, ai21, huggingface) must route through chatOpenAICompatible —
 * which resolves the provider's hosted base URL + API key — NOT through
 * chatOllama, which hard-codes the local Ollama endpoint and ignores the
 * configured key. `ollama` must still route through chatOllama, and
 * `litellm` / `bedrock` routing must be unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider } from '../src/types.js';

// ---------------------------------------------------------------------------
// Config: every hosted provider has a key, ollama/litellm have a base URL.
// ---------------------------------------------------------------------------

const apiKeys: Record<string, string | undefined> = {
  openrouter: 'key-openrouter',
  together: 'key-together',
  groq: 'key-groq',
  fireworks: 'key-fireworks',
  mistral: 'key-mistral',
  ai21: 'key-ai21',
  huggingface: 'key-hf',
};

const baseUrls: Record<string, string | undefined> = {
  ollama: 'http://localhost:11434',
  litellm: 'http://localhost:4000',
  bedrock: 'https://bedrock-gw.example.com',
};

vi.mock('../src/config.js', () => ({
  getApiKey: vi.fn((provider: string) => apiKeys[provider]),
  getBaseUrl: vi.fn((provider: string) => baseUrls[provider]),
}));

// Disable retry wrapping so we observe a single dispatch per call.
vi.mock('../src/errors.js', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

// Each handler records which provider it was asked to serve. Mock factories
// are hoisted above imports, so handlers are created via vi.hoisted().
const okResponse = { content: 'ok', finishReason: 'stop' as const };

const handlers = vi.hoisted(() => {
  const ok = { content: 'ok', finishReason: 'stop' as const };
  const compatCalls: string[] = [];
  const ollamaCalls: string[] = [];
  const bedrockNativeCalls: string[] = [];
  return {
    compatCalls,
    ollamaCalls,
    bedrockNativeCalls,
    chatOpenAICompatible: vi.fn(async (provider: string) => {
      compatCalls.push(provider);
      return ok;
    }),
    chatOllama: vi.fn(async () => {
      ollamaCalls.push('ollama');
      return ok;
    }),
    chatBedrock: vi.fn(async () => {
      bedrockNativeCalls.push('bedrock');
      return ok;
    }),
  };
});

const { chatOpenAICompatible, chatOllama, chatBedrock } = handlers;

vi.mock('../src/providers/compat.js', () => ({ chatOpenAICompatible: handlers.chatOpenAICompatible }));
vi.mock('../src/providers/ollama.js', () => ({ chatOllama: handlers.chatOllama }));
vi.mock('../src/providers/bedrock.js', () => ({ chatBedrock: handlers.chatBedrock }));
vi.mock('../src/providers/anthropic.js', () => ({ chatAnthropic: vi.fn(async () => okResponse) }));
vi.mock('../src/providers/google.js', () => ({ chatGoogle: vi.fn(async () => okResponse) }));
vi.mock('../src/providers/openai.js', () => ({
  chatOpenAI: vi.fn(async () => okResponse),
  requiresResponsesAPI: vi.fn(),
  toResponsesInput: vi.fn(),
  toResponsesTools: vi.fn(),
}));

import { chat } from '../src/providers/index.js';

const HOSTED_COMPAT: LLMProvider[] = [
  'openrouter',
  'together',
  'groq',
  'fireworks',
  'mistral',
  'ai21',
  'huggingface',
];

beforeEach(() => {
  handlers.compatCalls.length = 0;
  handlers.ollamaCalls.length = 0;
  handlers.bedrockNativeCalls.length = 0;
  chatOpenAICompatible.mockClear();
  chatOllama.mockClear();
  chatBedrock.mockClear();
});

describe('chat() provider routing (#145)', () => {
  // Happy path: each hosted provider reaches chatOpenAICompatible, never chatOllama.
  for (const provider of HOSTED_COMPAT) {
    it(`routes ${provider} through chatOpenAICompatible, not chatOllama`, async () => {
      await chat(provider, [{ role: 'user', content: 'hi' }], [], 'some-model');

      expect(handlers.compatCalls).toEqual([provider]);
      expect(chatOpenAICompatible).toHaveBeenCalledWith(
        provider,
        expect.anything(),
        expect.anything(),
        'some-model',
        undefined,
      );
      // Failure path the bug produced: must NOT hit the local Ollama handler.
      expect(chatOllama).not.toHaveBeenCalled();
      expect(handlers.ollamaCalls).toEqual([]);
    });
  }

  it('mistral specifically does not get sent to chatOllama (localhost:11434)', async () => {
    await chat('mistral', [{ role: 'user', content: 'hi' }], [], 'mistral-large');
    expect(chatOllama).not.toHaveBeenCalled();
    expect(chatOpenAICompatible).toHaveBeenCalledTimes(1);
    expect(handlers.compatCalls).toEqual(['mistral']);
  });

  it('ollama still routes through chatOllama, not chatOpenAICompatible', async () => {
    await chat('ollama', [{ role: 'user', content: 'hi' }], [], 'llama3.3');
    expect(chatOllama).toHaveBeenCalledTimes(1);
    expect(handlers.ollamaCalls).toEqual(['ollama']);
    expect(chatOpenAICompatible).not.toHaveBeenCalled();
  });

  it('litellm routing is unchanged (chatOpenAICompatible)', async () => {
    await chat('litellm', [{ role: 'user', content: 'hi' }], [], 'gpt-4o');
    expect(handlers.compatCalls).toEqual(['litellm']);
    expect(chatOllama).not.toHaveBeenCalled();
  });

  it('bedrock gateway mode (base URL set) routes through chatOpenAICompatible', async () => {
    await chat('bedrock', [{ role: 'user', content: 'hi' }], [], 'claude-via-bedrock');
    expect(handlers.compatCalls).toEqual(['bedrock']);
    expect(chatBedrock).not.toHaveBeenCalled();
  });

  it('bedrock native mode (no base URL) routes through chatBedrock', async () => {
    const configMod = await import('../src/config.js');
    vi.mocked(configMod.getBaseUrl).mockImplementation((p: string) =>
      p === 'bedrock' ? undefined : baseUrls[p],
    );
    // With no bedrock base URL, selectProvider falls back to AWS credentials.
    const prevProfile = process.env.AWS_PROFILE;
    process.env.AWS_PROFILE = 'test-profile';

    await chat('bedrock', [{ role: 'user', content: 'hi' }], [], 'claude-via-bedrock');
    expect(handlers.bedrockNativeCalls).toEqual(['bedrock']);
    expect(handlers.compatCalls).toEqual([]);

    if (prevProfile === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = prevProfile;
    vi.mocked(configMod.getBaseUrl).mockImplementation((p: string) => baseUrls[p]);
  });
});
