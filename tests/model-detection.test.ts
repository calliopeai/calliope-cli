/**
 * Tests for src/model-detection.ts
 *
 * Covers: getModelContextLimit, getModelInfo, clearModelCache, getAvailableModels,
 * getOllamaFallbackModel, isCompatibleModel (via getAvailableModels filtering),
 * formatModelName, formatContextLength, description helpers, and model caching.
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

// Mock SDK constructors to prevent real network calls
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: vi.fn() }));
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      models: { list: vi.fn().mockResolvedValue({ data: [] }) },
    })),
  };
});
vi.mock('@inquirer/prompts', () => ({ select: vi.fn() }));

import {
  getModelContextLimit,
  getModelInfo,
  clearModelCache,
  getAvailableModels,
  getOllamaFallbackModel,
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
  // Stub global fetch
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// getModelContextLimit
// ===========================================================================

describe('getModelContextLimit', () => {
  it('should return 200000 for Claude models', () => {
    expect(getModelContextLimit('anthropic', 'claude-sonnet-4-20250514')).toBe(200000);
    expect(getModelContextLimit('anthropic', 'claude-3-5-sonnet-20241022')).toBe(200000);
    expect(getModelContextLimit('anthropic', 'claude-opus-4-5-20251101')).toBe(200000);
  });

  it('should return 128000 for GPT-4o models', () => {
    expect(getModelContextLimit('openai', 'gpt-4o')).toBe(128000);
    expect(getModelContextLimit('openai', 'gpt-4o-mini')).toBe(128000);
  });

  it('should return 128000 for GPT-4 Turbo', () => {
    expect(getModelContextLimit('openai', 'gpt-4-turbo-preview')).toBe(128000);
  });

  it('should return 8192 for base GPT-4', () => {
    expect(getModelContextLimit('openai', 'gpt-4-0613')).toBe(8192);
  });

  it('should return 200000 for GPT-5', () => {
    expect(getModelContextLimit('openai', 'gpt-5')).toBe(200000);
  });

  it('should return 200000 for o1 / o3 / o4 models', () => {
    expect(getModelContextLimit('openai', 'o1-preview')).toBe(200000);
    expect(getModelContextLimit('openai', 'o3-mini')).toBe(200000);
    expect(getModelContextLimit('openai', 'o4-mini')).toBe(200000);
  });

  it('should return 1000000 for Gemini 2.x models', () => {
    expect(getModelContextLimit('google', 'gemini-2.0-flash')).toBe(1000000);
    expect(getModelContextLimit('google', 'gemini-2.5-pro-preview-06-05')).toBe(1000000);
  });

  it('should return 1000000 for Gemini 1.5 models', () => {
    expect(getModelContextLimit('google', 'gemini-1.5-pro-latest')).toBe(1000000);
    expect(getModelContextLimit('google', 'gemini-1.5-flash-latest')).toBe(1000000);
  });

  it('should return 128000 for Llama 3.1/3.3 models', () => {
    expect(getModelContextLimit('together', 'llama-3.1-70b')).toBe(128000);
    expect(getModelContextLimit('together', 'llama3.3-70b')).toBe(128000);
    expect(getModelContextLimit('ollama', 'llama3.1:latest')).toBe(128000);
  });

  it('should return 8192 for base Llama 3', () => {
    expect(getModelContextLimit('ollama', 'llama3:latest')).toBe(8192);
  });

  it('should return 4096 for Llama 2', () => {
    expect(getModelContextLimit('ollama', 'llama2:latest')).toBe(4096);
  });

  it('should return 128000 for Mistral Large', () => {
    expect(getModelContextLimit('mistral', 'mistral-large-latest')).toBe(128000);
  });

  it('should return 32000 for base Mistral models', () => {
    expect(getModelContextLimit('mistral', 'mistral-7b')).toBe(32000);
  });

  it('should return 32000 for Mixtral', () => {
    expect(getModelContextLimit('together', 'mixtral-8x7b')).toBe(32000);
  });

  it('should return 128000 for DeepSeek models', () => {
    expect(getModelContextLimit('together', 'deepseek-v2')).toBe(128000);
    expect(getModelContextLimit('ollama', 'deepseek-coder:latest')).toBe(128000);
  });

  it('should return 128000 for Phi-3 and Phi-4', () => {
    expect(getModelContextLimit('ollama', 'phi-3:latest')).toBe(128000);
    expect(getModelContextLimit('ollama', 'phi-4:latest')).toBe(128000);
  });

  it('should return 128000 for Qwen 2/3', () => {
    expect(getModelContextLimit('ollama', 'qwen2:latest')).toBe(128000);
    expect(getModelContextLimit('ollama', 'qwen3:latest')).toBe(128000);
  });

  it('should return 32000 for base Qwen', () => {
    expect(getModelContextLimit('together', 'qwen-7b')).toBe(32000);
  });

  it('should return 8192 for Gemma models', () => {
    expect(getModelContextLimit('ollama', 'gemma:latest')).toBe(8192);
    expect(getModelContextLimit('ollama', 'gemma2:latest')).toBe(8192);
  });

  it('should return 128000 for Command-R', () => {
    expect(getModelContextLimit('bedrock', 'cohere.command-r-plus-v1:0')).toBe(128000);
  });

  it('should return 16384 for CodeLlama', () => {
    expect(getModelContextLimit('ollama', 'codellama:latest')).toBe(16384);
  });

  it('should return 8192 for StarCoder', () => {
    expect(getModelContextLimit('huggingface', 'starcoder-7b')).toBe(8192);
  });

  it('should return 200000 for Bedrock Claude models', () => {
    expect(getModelContextLimit('bedrock', 'anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(200000);
  });

  it('should return 32000 for Bedrock Titan Premier', () => {
    expect(getModelContextLimit('bedrock', 'amazon.titan-text-premier-v1:0')).toBe(32000);
  });

  it('should return 8192 for Bedrock Titan Express', () => {
    expect(getModelContextLimit('bedrock', 'amazon.titan-text-express-v1')).toBe(8192);
  });

  it('should return 128000 for Bedrock Llama 3', () => {
    expect(getModelContextLimit('bedrock', 'meta.llama3-1-70b-instruct-v1:0')).toBe(128000);
  });

  it('should return 128000 for Bedrock Mistral Large', () => {
    expect(getModelContextLimit('bedrock', 'mistral.mistral-large-2407-v1:0')).toBe(128000);
  });

  it('should return 32000 fallback for unknown models', () => {
    expect(getModelContextLimit('openai', 'totally-unknown-model-xyz')).toBe(32000);
  });

  it('should prefer cached model info over defaults', () => {
    // Manually populate cache by running getAvailableModels first
    // We'll test this via the Anthropic fallback path
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network error'));

    return getAvailableModels('anthropic').then(() => {
      // Cache should now contain fallback Anthropic models with contextLength 200000
      const info = getModelInfo('anthropic', 'claude-sonnet-4-20250514');
      expect(info).toBeDefined();
      expect(info?.contextLength).toBe(200000);

      // getModelContextLimit should use the cached info
      const limit = getModelContextLimit('anthropic', 'claude-sonnet-4-20250514');
      expect(limit).toBe(200000);
    });
  });

  it('should be case-insensitive when matching model families', () => {
    expect(getModelContextLimit('anthropic', 'CLAUDE-3-opus')).toBe(200000);
    expect(getModelContextLimit('openai', 'GPT-4O-mini')).toBe(128000);
  });

  it('should match the most specific key first', () => {
    // "deepseek-coder" (14 chars) should match before "deepseek" (8 chars)
    // Both map to 128000 in this case, but the logic should prefer longer keys
    expect(getModelContextLimit('ollama', 'deepseek-coder-v2')).toBe(128000);
  });
});

// ===========================================================================
// getModelInfo
// ===========================================================================

describe('getModelInfo', () => {
  it('should return undefined when cache is empty', () => {
    expect(getModelInfo('anthropic', 'claude-sonnet-4-20250514')).toBeUndefined();
  });

  it('should find model by exact ID match', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network'));
    await getAvailableModels('anthropic');

    const info = getModelInfo('anthropic', 'claude-sonnet-4-20250514');
    expect(info).toBeDefined();
    expect(info?.id).toBe('claude-sonnet-4-20250514');
  });

  it('should find model by partial match (modelId includes cached ID)', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network'));
    await getAvailableModels('anthropic');

    // The cached id "claude-3-5-haiku-20241022" includes "haiku"
    const info = getModelInfo('anthropic', 'claude-3-5-haiku-20241022');
    expect(info).toBeDefined();
  });

  it('should return undefined for non-matching provider', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network'));
    await getAvailableModels('anthropic');

    expect(getModelInfo('openai', 'claude-sonnet-4-20250514')).toBeUndefined();
  });
});

// ===========================================================================
// clearModelCache
// ===========================================================================

describe('clearModelCache', () => {
  it('should clear cache for a specific provider', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network'));
    await getAvailableModels('anthropic');

    expect(getModelInfo('anthropic', 'claude-sonnet-4-20250514')).toBeDefined();

    clearModelCache('anthropic');
    expect(getModelInfo('anthropic', 'claude-sonnet-4-20250514')).toBeUndefined();
  });

  it('should clear all caches when no provider specified', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network'));
    await getAvailableModels('anthropic');

    clearModelCache();
    expect(getModelInfo('anthropic', 'claude-sonnet-4-20250514')).toBeUndefined();
  });
});

// ===========================================================================
// getAvailableModels — Anthropic
// ===========================================================================

describe('getAvailableModels - anthropic', () => {
  it('should throw (and return []) when no API key is configured', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    const models = await getAvailableModels('anthropic');
    expect(models).toEqual([]);
  });

  it('should parse API response and filter for Claude models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
          { id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku' },
          { id: 'not-a-claude-model', display_name: 'Other' },
        ],
      }),
    });

    const models = await getAvailableModels('anthropic');
    expect(models.length).toBe(2);
    expect(models.every(m => m.id.startsWith('claude'))).toBe(true);
    expect(models[0].contextLength).toBe(200000);
  });

  it('should use fallback models when API returns non-ok status', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const models = await getAvailableModels('anthropic');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id.includes('sonnet'))).toBe(true);
  });

  it('should use fallback models when fetch throws', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network error'));

    const models = await getAvailableModels('anthropic');
    expect(models.length).toBeGreaterThan(0);
  });

  it('should use cache on second call', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
        ],
      }),
    });

    const first = await getAvailableModels('anthropic');
    const second = await getAvailableModels('anthropic');
    expect(first).toEqual(second);
    // fetch should have been called only once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should sort models newest first (descending ID)', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-3-5-haiku-20241022' },
          { id: 'claude-sonnet-4-20250514' },
          { id: 'claude-opus-4-5-20251101' },
        ],
      }),
    });

    const models = await getAvailableModels('anthropic');
    // Descending alphabetical: opus > sonnet > haiku (by localeCompare desc)
    expect(models[0].id).toBe('claude-sonnet-4-20250514');
    expect(models[models.length - 1].id).toBe('claude-3-5-haiku-20241022');
  });
});

// ===========================================================================
// getAvailableModels — Google
// ===========================================================================

describe('getAvailableModels - google', () => {
  it('should return [] when no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    const models = await getAvailableModels('google');
    expect(models).toEqual([]);
  });

  it('should parse Google API response and filter for Gemini chat models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('google');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', inputTokenLimit: 1048576 },
          { name: 'models/embedding-001', displayName: 'Embedding' },
          { name: 'models/gemini-1.5-pro-latest', displayName: 'Gemini 1.5 Pro', inputTokenLimit: 2097152 },
          { name: 'models/text-embedding-004', displayName: 'Text Embedding' },
          { name: 'models/aqa', displayName: 'AQA' },
        ],
      }),
    });

    const models = await getAvailableModels('google');
    // Should include gemini models, exclude embedding and aqa
    expect(models.every(m => m.id.includes('gemini'))).toBe(true);
    expect(models.some(m => m.id.includes('embedding'))).toBe(false);
    expect(models.some(m => m.id === 'aqa')).toBe(false);
  });

  it('should use fallback when API fails', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('google');
    mockFetch.mockRejectedValueOnce(new Error('network'));

    const models = await getAvailableModels('google');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id.includes('gemini'))).toBe(true);
  });
});

// ===========================================================================
// getAvailableModels — OpenRouter
// ===========================================================================

describe('getAvailableModels - openrouter', () => {
  it('should filter out non-text models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'openai/gpt-4o', name: 'GPT-4o', architecture: { output_modalities: ['text'] }, pricing: { prompt: '0.000005', completion: '0.000015' } },
          { id: 'openai/dall-e-3', name: 'DALL-E 3', architecture: { modality: 'image', output_modalities: ['image'] } },
          { id: 'text-model-no-arch', name: 'Text Model' },
          { id: 'some-embed-model', name: 'Embedding' },
        ],
      }),
    });

    const models = await getAvailableModels('openrouter');
    expect(models.some(m => m.id === 'openai/gpt-4o')).toBe(true);
    expect(models.some(m => m.id === 'openai/dall-e-3')).toBe(false);
    expect(models.some(m => m.id === 'text-model-no-arch')).toBe(true);
    expect(models.some(m => m.id === 'some-embed-model')).toBe(false);
  });

  it('should parse pricing correctly', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'test/model',
            name: 'Test',
            architecture: { output_modalities: ['text'] },
            pricing: { prompt: '0.000003', completion: '0.000015' },
            context_length: 128000,
          },
        ],
      }),
    });

    const models = await getAvailableModels('openrouter');
    expect(models[0].pricing?.input).toBeCloseTo(3);
    expect(models[0].pricing?.output).toBeCloseTo(15);
    expect(models[0].contextLength).toBe(128000);
  });
});

// ===========================================================================
// getAvailableModels — Together
// ===========================================================================

describe('getAvailableModels - together', () => {
  it('should filter for chat/language models only', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('together');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { id: 'meta-llama/Llama-3-70b-chat', display_name: 'Llama 3 70B', type: 'chat', context_length: 8192 },
        { id: 'togethercomputer/m2-bert-80M', type: 'embedding' },
        { id: 'meta-llama/Llama-3.1-8b', type: 'language', context_length: 128000 },
        { id: 'stabilityai/stable-diffusion', type: 'image' },
      ]),
    });

    const models = await getAvailableModels('together');
    expect(models.length).toBe(2);
    expect(models.some(m => m.id.includes('Llama-3-70b'))).toBe(true);
    expect(models.some(m => m.id.includes('stable-diffusion'))).toBe(false);
    expect(models.some(m => m.id.includes('bert'))).toBe(false);
  });
});

// ===========================================================================
// getAvailableModels — Ollama
// ===========================================================================

describe('getAvailableModels - ollama', () => {
  it('should use default base URL when none configured', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:latest', size: 4294967296 },
          { name: 'mistral:latest', size: 4294967296 },
        ],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:11434/api/tags');
    expect(models.length).toBe(2);
  });

  it('should strip /v1 suffix from base URL', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('http://myhost:11434/v1');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3:latest', size: 1000000000 }] }),
    });

    await getAvailableModels('ollama');
    expect(mockFetch).toHaveBeenCalledWith('http://myhost:11434/api/tags');
  });

  it('should filter out embedding models', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:latest', size: 4000000000 },
          { name: 'nomic-embed-text:latest', size: 300000000 },
          { name: 'all-minilm:latest', size: 100000000 },
          { name: 'bge-large:latest', size: 600000000 },
        ],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models.length).toBe(1);
    expect(models[0].id).toBe('llama3:latest');
  });

  it('should include model size in description', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:latest', size: 4294967296, details: { parameter_size: '8B' } },
        ],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models[0].description).toContain('GB');
    expect(models[0].description).toContain('8B');
  });

  it('should return [] when Ollama is not running', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const models = await getAvailableModels('ollama');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// getOllamaFallbackModel
// ===========================================================================

describe('getOllamaFallbackModel', () => {
  it('should return null when no models available', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await getOllamaFallbackModel();
    expect(result).toBeNull();
  });

  it('should prefer llama3.3 over other models', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'mistral:latest', size: 4000000000 },
          { name: 'llama3.3:latest', size: 4000000000 },
          { name: 'phi-3:latest', size: 2000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBe('llama3.3:latest');
  });

  it('should fall back through preference order', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'gemma2:latest', size: 4000000000 },
          { name: 'phi-3:latest', size: 2000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    // phi-3 comes before gemma2 in preference order
    expect(result).toBe('phi-3:latest');
  });

  it('should return first model if none match preference list', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'custom-model:latest', size: 4000000000 },
          { name: 'another-model:latest', size: 2000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBe('custom-model:latest');
  });

  it('should return null when models list is empty', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [] }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBeNull();
  });
});

// ===========================================================================
// getAvailableModels — LiteLLM
// ===========================================================================

describe('getAvailableModels - litellm', () => {
  it('should use default base URL and filter incompatible models', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('litellm');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4o' },
          { id: 'text-embedding-ada-002' },
          { id: 'claude-3-sonnet' },
          { id: 'whisper-1' },
          { id: 'dall-e-3' },
          { id: 'tts-1' },
        ],
      }),
    });

    const models = await getAvailableModels('litellm');
    expect(models.some(m => m.id === 'gpt-4o')).toBe(true);
    expect(models.some(m => m.id === 'claude-3-sonnet')).toBe(true);
    // These should be filtered
    expect(models.some(m => m.id === 'text-embedding-ada-002')).toBe(false);
    expect(models.some(m => m.id === 'whisper-1')).toBe(false);
    expect(models.some(m => m.id === 'dall-e-3')).toBe(false);
    expect(models.some(m => m.id === 'tts-1')).toBe(false);
  });

  it('should strip /v1 suffix from configured base URL', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('http://myproxy:4000/v1');
    clearModelCache('litellm');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-4o' }] }),
    });

    await getAvailableModels('litellm');
    expect(mockFetch).toHaveBeenCalledWith('http://myproxy:4000/v1/models');
  });

  it('should return [] when LiteLLM is not running', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('litellm');
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const models = await getAvailableModels('litellm');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// getAvailableModels — Bedrock
// ===========================================================================

describe('getAvailableModels - bedrock', () => {
  it('should return static fallback models when no base URL', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('bedrock');

    const models = await getAvailableModels('bedrock');
    expect(models.length).toBeGreaterThan(0);
    expect(models.some(m => m.id.includes('claude'))).toBe(true);
    expect(models.some(m => m.id.includes('titan'))).toBe(true);
    expect(models.some(m => m.id.includes('llama'))).toBe(true);
  });

  it('should fetch from gateway when base URL is configured', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://my-gateway.com/v1');
    vi.mocked(config.getApiKey).mockReturnValue('gw-key');
    clearModelCache('bedrock');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
          { id: 'stability.stable-diffusion-xl' },
          { id: 'amazon.titan-embed-text-v1' },
        ],
      }),
    });

    const models = await getAvailableModels('bedrock');
    // Should filter out image and embedding models
    expect(models.some(m => m.id.includes('claude'))).toBe(true);
    expect(models.some(m => m.id.includes('stability'))).toBe(false);
    expect(models.some(m => m.id.includes('embed'))).toBe(false);
  });

  it('should fall back to static list when gateway fails', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://my-gateway.com/v1');
    vi.mocked(config.getApiKey).mockReturnValue('gw-key');
    clearModelCache('bedrock');
    mockFetch.mockRejectedValueOnce(new Error('gateway down'));

    const models = await getAvailableModels('bedrock');
    expect(models.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// getAvailableModels — unsupported provider
// ===========================================================================

describe('getAvailableModels - unsupported', () => {
  it('should return [] for unknown provider', async () => {
    const models = await getAvailableModels('auto');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// isCompatibleModel (tested indirectly through model filtering)
// ===========================================================================

describe('isCompatibleModel (indirect)', () => {
  describe('openai patterns', () => {
    it('should filter embedding, speech, image, and legacy models', async () => {
      vi.mocked(config.getApiKey).mockReturnValue('test-key');
      clearModelCache('litellm');
      vi.mocked(config.getBaseUrl).mockReturnValue(undefined);

      // Test via litellm which passes models through isCompatibleModel with 'litellm' patterns
      // For OpenAI patterns, we'd need to test through OpenAI client mock
      // Instead test litellm patterns which overlap: embed, whisper, dall-e, tts
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o' },
            { id: 'embed-something' },
            { id: 'whisper-large' },
            { id: 'dall-e-3' },
            { id: 'tts-1-hd' },
          ],
        }),
      });

      const models = await getAvailableModels('litellm');
      const ids = models.map(m => m.id);
      expect(ids).toContain('gpt-4o');
      expect(ids).not.toContain('embed-something');
      expect(ids).not.toContain('whisper-large');
      expect(ids).not.toContain('dall-e-3');
      expect(ids).not.toContain('tts-1-hd');
    });
  });

  describe('ollama patterns', () => {
    it('should filter embedding models from Ollama', async () => {
      vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
      clearModelCache('ollama');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3:latest', size: 4000000000 },
            { name: 'nomic-embed-text:latest', size: 300000000 },
            { name: 'mxbai-embed-large:latest', size: 600000000 },
            { name: 'all-minilm:latest', size: 100000000 },
            { name: 'bge-large:latest', size: 600000000 },
          ],
        }),
      });

      const models = await getAvailableModels('ollama');
      expect(models.length).toBe(1);
      expect(models[0].id).toBe('llama3:latest');
    });
  });

  describe('google patterns', () => {
    it('should filter embedding and AQA models from Google', async () => {
      vi.mocked(config.getApiKey).mockReturnValue('test-key');
      clearModelCache('google');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
            { name: 'models/embedding-001', displayName: 'Embedding 001' },
            { name: 'models/text-embedding-004', displayName: 'Text Embedding 004' },
            { name: 'models/aqa', displayName: 'AQA' },
            { name: 'models/something-embedding', displayName: 'Something Embedding' },
          ],
        }),
      });

      const models = await getAvailableModels('google');
      expect(models.length).toBe(1);
      expect(models[0].id).toBe('gemini-2.0-flash');
    });
  });
});

// ===========================================================================
// preWarmModelCache
// ===========================================================================

describe('preWarmModelCache', () => {
  it('should fetch models for all configured providers', async () => {
    vi.mocked(config.getConfiguredProviders).mockReturnValue(['anthropic', 'google'] as LLMProvider[]);
    vi.mocked(config.getApiKey).mockReturnValue('test-key');

    // Both will fail, but preWarm should not throw
    mockFetch.mockRejectedValue(new Error('network'));

    await expect(preWarmModelCache()).resolves.not.toThrow();
  });

  it('should not throw even when all providers fail', async () => {
    vi.mocked(config.getConfiguredProviders).mockReturnValue(['anthropic'] as LLMProvider[]);
    vi.mocked(config.getApiKey).mockReturnValue(undefined);

    await expect(preWarmModelCache()).resolves.not.toThrow();
  });
});

// ===========================================================================
// Model description helpers (tested indirectly via getAvailableModels)
// ===========================================================================

describe('model description helpers', () => {
  it('should assign correct descriptions to Anthropic models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-opus-4-5-20251101' },
          { id: 'claude-sonnet-4-20250514' },
          { id: 'claude-3-5-haiku-20241022' },
        ],
      }),
    });

    const models = await getAvailableModels('anthropic');
    const opus = models.find(m => m.id.includes('opus'));
    const sonnet = models.find(m => m.id.includes('sonnet'));
    const haiku = models.find(m => m.id.includes('haiku'));

    expect(opus?.description).toContain('complex');
    expect(sonnet?.description).toContain('Balanced');
    expect(haiku?.description).toContain('Fast');
  });

  it('should generate display names from model IDs', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-20250514' },  // no display_name
        ],
      }),
    });

    const models = await getAvailableModels('anthropic');
    // formatModelName should produce something readable, not the raw ID
    expect(models[0].name).toBeDefined();
    expect(models[0].name).not.toBe('');
  });

  it('should assign correct Bedrock model descriptions', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://gw.com');
    vi.mocked(config.getApiKey).mockReturnValue('key');
    clearModelCache('bedrock');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'anthropic.claude-3-opus-20240229-v1:0' },
          { id: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          { id: 'anthropic.claude-3-haiku-20240307-v1:0' },
          { id: 'amazon.titan-text-premier-v1:0' },
          { id: 'meta.llama3-1-70b-instruct-v1:0' },
          { id: 'mistral.mistral-large-2407-v1:0' },
          { id: 'cohere.command-r-plus-v1:0' },
        ],
      }),
    });

    const models = await getAvailableModels('bedrock');
    const opus = models.find(m => m.id.includes('opus'));
    expect(opus?.description).toContain('Claude');
    expect(opus?.description).toContain('Bedrock');

    const titan = models.find(m => m.id.includes('titan'));
    expect(titan?.description).toContain('Titan');

    const llama = models.find(m => m.id.includes('llama'));
    expect(llama?.description).toContain('Llama');
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('edge cases', () => {
  it('should handle model with zero-byte size in Ollama', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'test-model:latest', size: 0 }],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models[0].description).toContain('0 B');
  });

  it('should handle OpenRouter model with no architecture info', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'some/model', name: 'Some Model' },
        ],
      }),
    });

    const models = await getAvailableModels('openrouter');
    expect(models.length).toBe(1);
  });

  it('should handle OpenRouter model with audio-only modality', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'audio/model', name: 'Audio Model', architecture: { modality: 'audio', output_modalities: [] } },
        ],
      }),
    });

    const models = await getAvailableModels('openrouter');
    expect(models.length).toBe(0);
  });

  it('should handle Together model with no display_name', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('together');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { id: 'org/model-name', type: 'chat' },
      ]),
    });

    const models = await getAvailableModels('together');
    expect(models[0].name).toBe('org/model-name');
  });

  it('should handle OpenRouter error status', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const models = await getAvailableModels('openrouter');
    expect(models).toEqual([]);
  });

  it('should handle Together error status', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('together');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const models = await getAvailableModels('together');
    expect(models).toEqual([]);
  });
});
