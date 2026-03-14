/**
 * Extended tests for src/model-detection.ts
 *
 * Covers branches not yet reached in model-detection.test.ts:
 * - Ollama /api/show model_info context_length key parsing
 * - Ollama /api/show model_info context_window key parsing
 * - Ollama /api/show parameters num_ctx parsing
 * - Ollama /api/show when showResp is not ok (skip)
 * - Ollama /api/show throws (catch branch)
 * - Together API error (throws)
 * - OpenRouter API error (throws)
 * - OpenAI compatible provider (ai21, huggingface, fireworks) — missing key
 * - preWarmModelCache
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LLMProvider } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => ({
  default: {},
  getApiKey: vi.fn(),
  getBaseUrl: vi.fn(),
  getConfiguredProviders: vi.fn(() => []),
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: vi.fn() }));
vi.mock('openai', () => {
  const MockOpenAI = vi.fn().mockImplementation(function (this: any) {
    this.models = { list: vi.fn().mockResolvedValue({ data: [] }) };
  });
  return { default: MockOpenAI };
});
vi.mock('@inquirer/prompts', () => ({ select: vi.fn() }));

import {
  getAvailableModels,
  clearModelCache,
  preWarmModelCache,
} from '../src/model-detection.js';
import * as config from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  clearModelCache();
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// Ollama /api/show — context length via model_info.context_length
// ===========================================================================

describe('getAvailableModels - ollama /api/show model_info', () => {
  it('should read context length from model_info.context_length key', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3:latest', size: 4294967296 }],
      }),
    });

    // Second call: /api/show for llama3:latest
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: {
          'llm.context_length': 32768,
        },
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    expect(models[0].contextLength).toBe(32768);
  });

  it('should read context length from model_info.context_window key', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'mistral:latest', size: 4294967296 }],
      }),
    });

    // Second call: /api/show for mistral:latest
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: {
          'llm.context_window': 16384,
        },
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    expect(models[0].contextLength).toBe(16384);
  });

  it('should ignore model_info keys that are not numbers', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'phi3:latest', size: 2000000000 }],
      }),
    });

    // Second call: /api/show — model_info has context_length but as a string (not a number)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: {
          'llm.context_length': 'not-a-number',
        },
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    // contextLength should be undefined (no valid number found)
    expect(models[0].contextLength).toBeUndefined();
  });

  it('should read context length from parameters num_ctx', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'qwen2:latest', size: 4000000000 }],
      }),
    });

    // Second call: /api/show with parameters string containing num_ctx
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        parameters: 'temperature 0.7\nnum_ctx 8192\nstop </s>',
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    expect(models[0].contextLength).toBe(8192);
  });

  it('should prefer parameters num_ctx over model_info context_length when both present', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'gemma2:latest', size: 4000000000 }],
      }),
    });

    // Second call: /api/show with both model_info and parameters
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: { 'llm.context_length': 32768 },
        parameters: 'num_ctx 4096',
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    // parameters num_ctx should override model_info (processed last)
    expect(models[0].contextLength).toBe(4096);
  });

  it('should skip context length when showResp is not ok', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3:latest', size: 4294967296 }],
      }),
    });

    // Second call: /api/show returns error
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    // contextLength should be undefined when show fails
    expect(models[0].contextLength).toBeUndefined();
  });

  it('should skip context length when /api/show throws', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3:latest', size: 4294967296 }],
      }),
    });

    // Second call: /api/show throws
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    // contextLength should be undefined on error
    expect(models[0].contextLength).toBeUndefined();
  });

  it('should handle model_info with no context-related keys', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3:latest', size: 4294967296 }],
      }),
    });

    // Second call: /api/show with model_info that has no context keys
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: {
          'llm.feed_forward_length': 14336,
          'llm.attention.head_count': 32,
        },
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    expect(models[0].contextLength).toBeUndefined();
  });

  it('should handle parameters string with no num_ctx', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'mistral:latest', size: 4000000000 }],
      }),
    });

    // Second call: /api/show with parameters but no num_ctx
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        parameters: 'temperature 0.8\nstop </s>',
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(1);
    expect(models[0].contextLength).toBeUndefined();
  });

  it('should process multiple models with /api/show calls', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');

    // First call: /api/tags with two models
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:latest', size: 4294967296 },
          { name: 'mistral:latest', size: 4294967296 },
        ],
      }),
    });

    // Second call: /api/show for llama3:latest
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: { 'llm.context_length': 8192 },
      }),
    });

    // Third call: /api/show for mistral:latest
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        parameters: 'num_ctx 32768',
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models).toHaveLength(2);

    const llama = models.find(m => m.id === 'llama3:latest');
    const mistral = models.find(m => m.id === 'mistral:latest');
    expect(llama?.contextLength).toBe(8192);
    expect(mistral?.contextLength).toBe(32768);
  });
});

// ===========================================================================
// Together API error path
// ===========================================================================

describe('getAvailableModels - together API errors', () => {
  it('should return [] when Together API returns non-ok', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('together');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });

    const models = await getAvailableModels('together');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// OpenRouter API error path (throws)
// ===========================================================================

describe('getAvailableModels - openrouter API errors', () => {
  it('should return [] when OpenRouter API returns non-ok', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });

    const models = await getAvailableModels('openrouter');
    expect(models).toEqual([]);
  });

  it('should return [] when OpenRouter fetch throws', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const models = await getAvailableModels('openrouter');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// OpenAI-compatible providers (ai21, huggingface, fireworks) — no key
// ===========================================================================

describe('getAvailableModels - openai-compatible providers', () => {
  it('should return [] when ai21 has no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('ai21');
    const models = await getAvailableModels('ai21');
    expect(models).toEqual([]);
  });

  it('should return [] when huggingface has no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('huggingface');
    const models = await getAvailableModels('huggingface');
    expect(models).toEqual([]);
  });

  it('should return [] when fireworks has no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('fireworks');
    const models = await getAvailableModels('fireworks');
    expect(models).toEqual([]);
  });

  it('should return models for ai21 when API key is set', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('ai21-key');
    clearModelCache('ai21');

    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'jamba-1.5-mini' },
            { id: 'embed-something' }, // Should be filtered
          ],
        }),
      };
    });

    const models = await getAvailableModels('ai21');
    expect(models.some(m => m.id === 'jamba-1.5-mini')).toBe(true);
    expect(models.some(m => m.id === 'embed-something')).toBe(false);
  });
});

// ===========================================================================
// preWarmModelCache
// ===========================================================================

describe('preWarmModelCache', () => {
  it('should fetch models for all configured providers', async () => {
    vi.mocked(config.getConfiguredProviders).mockReturnValue(['anthropic', 'google'] as LLMProvider[]);
    vi.mocked(config.getApiKey).mockReturnValue('test-key');

    // Two fetch calls: one for each provider (both fail so we use fallbacks)
    mockFetch.mockRejectedValue(new Error('network'));

    await preWarmModelCache();

    // Both providers should now have cached models (from fallback)
    // Verify by checking that fetch was called twice
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should not throw when providers fail to load', async () => {
    vi.mocked(config.getConfiguredProviders).mockReturnValue(['openai'] as LLMProvider[]);
    vi.mocked(config.getApiKey).mockReturnValue(undefined);

    await expect(preWarmModelCache()).resolves.not.toThrow();
  });
});

// ===========================================================================
// Ollama API error (non-ok status)
// ===========================================================================

describe('getAvailableModels - ollama non-ok status re-throws', () => {
  it('should return [] when /api/tags returns 404', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const models = await getAvailableModels('ollama');
    expect(models).toEqual([]);
  });
});
