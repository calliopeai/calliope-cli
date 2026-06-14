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
  const MockOpenAI = vi.fn().mockImplementation(function (this: any) {
    this.models = { list: vi.fn().mockResolvedValue({ data: [] }) };
  });
  return { default: MockOpenAI };
});
vi.mock('@inquirer/prompts', () => ({ select: vi.fn() }));

import {
  getModelContextLimit,
  getModelMaxOutput,
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
      // Cache should now contain the fallback Anthropic models with their context windows
      const info = getModelInfo('anthropic', 'claude-sonnet-4-6');
      expect(info).toBeDefined();
      expect(info?.contextLength).toBe(1000000);

      // getModelContextLimit should use the cached info
      const limit = getModelContextLimit('anthropic', 'claude-sonnet-4-6');
      expect(limit).toBe(1000000);
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

  it('should give current 1M-context Claude models their real window', () => {
    // Current models are 1M; only Haiku 4.5 (and 3.x / legacy ids) stay at 200K.
    expect(getModelContextLimit('anthropic', 'claude-opus-4-8')).toBe(1000000);
    expect(getModelContextLimit('anthropic', 'claude-sonnet-4-6')).toBe(1000000);
    expect(getModelContextLimit('anthropic', 'claude-haiku-4-5')).toBe(200000);
    // Legacy/dated ids fall through to the generic 200K claude entry.
    expect(getModelContextLimit('anthropic', 'claude-sonnet-4-20250514')).toBe(200000);
  });
});

// ===========================================================================
// getModelMaxOutput
// ===========================================================================

describe('getModelMaxOutput', () => {
  it('should derive output ceiling per model family, not a global 8192', () => {
    expect(getModelMaxOutput('anthropic', 'claude-opus-4-8')).toBe(128000);
    expect(getModelMaxOutput('anthropic', 'claude-sonnet-4-6')).toBe(64000);
    expect(getModelMaxOutput('anthropic', 'claude-haiku-4-5')).toBe(64000);
  });

  it('should fall back to a conservative 8192 for unknown/local models', () => {
    expect(getModelMaxOutput('ollama', 'some-unknown-local-model')).toBe(8192);
    expect(getModelMaxOutput('anthropic', 'claude-3-opus-20240229')).toBe(8192);
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

    const info = getModelInfo('anthropic', 'claude-sonnet-4-6');
    expect(info).toBeDefined();
    expect(info?.id).toBe('claude-sonnet-4-6');
  });

  it('should find model by unambiguous prefix (dated id of a cached family)', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network'));
    await getAvailableModels('anthropic');

    // Dated id "claude-haiku-4-5-20251001" uniquely prefix-matches cached "claude-haiku-4-5"
    const info = getModelInfo('anthropic', 'claude-haiku-4-5-20251001');
    expect(info).toBeDefined();
    expect(info?.id).toBe('claude-haiku-4-5');
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

    expect(getModelInfo('anthropic', 'claude-sonnet-4-6')).toBeDefined();

    clearModelCache('anthropic');
    expect(getModelInfo('anthropic', 'claude-sonnet-4-6')).toBeUndefined();
  });

  it('should clear all caches when no provider specified', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    mockFetch.mockRejectedValueOnce(new Error('network'));
    await getAvailableModels('anthropic');

    clearModelCache();
    expect(getModelInfo('anthropic', 'claude-sonnet-4-6')).toBeUndefined();
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
  it('should return empty array when no base URL', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('bedrock');

    const models = await getAvailableModels('bedrock');
    expect(models).toEqual([]);
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

  it('should return empty array when gateway fails', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://my-gateway.com/v1');
    vi.mocked(config.getApiKey).mockReturnValue('gw-key');
    clearModelCache('bedrock');
    mockFetch.mockRejectedValueOnce(new Error('gateway down'));

    const models = await getAvailableModels('bedrock');
    expect(models).toEqual([]);
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

// ===========================================================================
// getAvailableModels — OpenAI
// ===========================================================================

describe('getAvailableModels - openai', () => {
  it('should return [] when no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('openai');
    const models = await getAvailableModels('openai');
    expect(models).toEqual([]);
  });

  it('should filter for chat-compatible GPT and reasoning models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openai');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'gpt-4o' },
            { id: 'gpt-4o-mini' },
            { id: 'gpt-4-turbo-preview' },
            { id: 'gpt-3.5-turbo' },
            { id: 'o1-preview' },
            { id: 'o3-mini' },
            { id: 'o4-mini' },
            { id: 'gpt-5-preview' },
            { id: 'text-embedding-ada-002' },
            { id: 'whisper-1' },
            { id: 'tts-1' },
            { id: 'dall-e-3' },
            { id: 'davinci-002' },
            { id: 'babbage-002' },
            { id: 'chatgpt-4o-latest' },
            { id: 'text-davinci-003' },
            { id: 'code-davinci-002' },
            { id: 'text-moderation-latest' },
            { id: 'random-non-chat-model' },
          ],
        }),
      };
    });

    const models = await getAvailableModels('openai');
    const ids = models.map(m => m.id);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('gpt-4o-mini');
    expect(ids).toContain('gpt-4-turbo-preview');
    expect(ids).toContain('gpt-3.5-turbo');
    expect(ids).toContain('o1-preview');
    expect(ids).toContain('o3-mini');
    expect(ids).toContain('o4-mini');
    expect(ids).toContain('gpt-5-preview');
    // Filtered out
    expect(ids).not.toContain('text-embedding-ada-002');
    expect(ids).not.toContain('whisper-1');
    expect(ids).not.toContain('tts-1');
    expect(ids).not.toContain('dall-e-3');
    expect(ids).not.toContain('davinci-002');
    expect(ids).not.toContain('babbage-002');
    expect(ids).not.toContain('chatgpt-4o-latest');
    expect(ids).not.toContain('text-davinci-003');
    expect(ids).not.toContain('code-davinci-002');
    expect(ids).not.toContain('text-moderation-latest');
    expect(ids).not.toContain('random-non-chat-model');
  });

  it('should assign correct OpenAI model descriptions', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openai');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'gpt-5-preview' },
            { id: 'o4-mini-2025' },
            { id: 'o3-pro-2025' },
            { id: 'o3-mini-2025' },
            { id: 'o3-2025' },
            { id: 'o1-preview' },
            { id: 'gpt-4o-mini' },
            { id: 'gpt-4-turbo-preview' },
            { id: 'gpt-4-0613' },
            { id: 'gpt-3.5-turbo' },
          ],
        }),
      };
    });

    const models = await getAvailableModels('openai');
    const byId = (id: string) => models.find(m => m.id === id);

    expect(byId('gpt-5-preview')?.description).toContain('reasoning');
    expect(byId('o4-mini-2025')?.description).toContain('reasoning');
    expect(byId('o3-pro-2025')?.description).toContain('reasoning');
    expect(byId('o3-mini-2025')?.description).toContain('reasoning');
    expect(byId('o3-2025')?.description).toContain('reasoning');
    expect(byId('o1-preview')?.description).toContain('Reasoning');
    expect(byId('gpt-4o-mini')?.description).toContain('Flagship');
    expect(byId('gpt-4-turbo-preview')?.description).toContain('multimodal');
    expect(byId('gpt-4-0613')?.description).toContain('intelligence');
    expect(byId('gpt-3.5-turbo')?.description).toContain('inexpensive');
  });

  it('should return generic description for unknown OpenAI model', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openai');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [{ id: 'gpt-future-model' }],
        }),
      };
    });

    const models = await getAvailableModels('openai');
    expect(models[0].description).toBe('OpenAI language model');
  });

  it('should sort models alphabetically', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openai');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'gpt-4o' },
            { id: 'gpt-3.5-turbo' },
            { id: 'gpt-4o-mini' },
          ],
        }),
      };
    });

    const models = await getAvailableModels('openai');
    expect(models[0].id).toBe('gpt-3.5-turbo');
    expect(models[1].id).toBe('gpt-4o');
    expect(models[2].id).toBe('gpt-4o-mini');
  });
});

// ===========================================================================
// getAvailableModels — Groq
// ===========================================================================

describe('getAvailableModels - groq', () => {
  it('should return [] when no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('groq');
    const models = await getAvailableModels('groq');
    expect(models).toEqual([]);
  });

  it('should filter out whisper models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('groq');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'llama-3.3-70b-versatile' },
            { id: 'mixtral-8x7b-32768' },
            { id: 'whisper-large-v3' },
            { id: 'distil-whisper-large-v3-en' },
          ],
        }),
      };
    });

    const models = await getAvailableModels('groq');
    const ids = models.map(m => m.id);
    expect(ids).toContain('llama-3.3-70b-versatile');
    expect(ids).toContain('mixtral-8x7b-32768');
    expect(ids).not.toContain('whisper-large-v3');
    expect(ids).not.toContain('distil-whisper-large-v3-en');
  });

  it('should set description to "High-speed inference model"', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('groq');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [{ id: 'llama-3.3-70b-versatile' }],
        }),
      };
    });

    const models = await getAvailableModels('groq');
    expect(models[0].description).toBe('High-speed inference model');
  });
});

// ===========================================================================
// getAvailableModels — Mistral
// ===========================================================================

describe('getAvailableModels - mistral', () => {
  it('should return [] when no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('mistral');
    const models = await getAvailableModels('mistral');
    expect(models).toEqual([]);
  });

  it('should filter out mistral-embed and assign descriptions', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('mistral');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'mistral-large-latest' },
            { id: 'mistral-medium-latest' },
            { id: 'mistral-small-latest' },
            { id: 'mistral-embed' },
            { id: 'open-mistral-nemo' },
          ],
        }),
      };
    });

    const models = await getAvailableModels('mistral');
    const ids = models.map(m => m.id);
    expect(ids).toContain('mistral-large-latest');
    expect(ids).toContain('mistral-medium-latest');
    expect(ids).toContain('mistral-small-latest');
    expect(ids).toContain('open-mistral-nemo');
    expect(ids).not.toContain('mistral-embed');

    const large = models.find(m => m.id === 'mistral-large-latest');
    expect(large?.description).toContain('capable');

    const medium = models.find(m => m.id === 'mistral-medium-latest');
    expect(medium?.description).toContain('Balanced');

    const small = models.find(m => m.id === 'mistral-small-latest');
    expect(small?.description).toContain('efficient');

    const nemo = models.find(m => m.id === 'open-mistral-nemo');
    expect(nemo?.description).toBe('Mistral language model');
  });
});

// ===========================================================================
// getAvailableModels — AI21, HuggingFace, Fireworks (OpenAI-compatible)
// ===========================================================================

describe('getAvailableModels - openai-compatible providers', () => {
  it('ai21: should return [] when no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('ai21');
    const models = await getAvailableModels('ai21');
    expect(models).toEqual([]);
  });

  it('ai21: should filter out embed models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('ai21');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'jamba-1.5-large' },
            { id: 'jamba-1.5-mini' },
            { id: 'jamba-embed-v1' },
          ],
        }),
      };
    });

    const models = await getAvailableModels('ai21');
    const ids = models.map(m => m.id);
    expect(ids).toContain('jamba-1.5-large');
    expect(ids).toContain('jamba-1.5-mini');
    expect(ids).not.toContain('jamba-embed-v1');
  });

  it('huggingface: should filter out embed, whisper, stable-diffusion, and flux models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('huggingface');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'meta-llama/Llama-3-70b' },
            { id: 'sentence-transformers/all-MiniLM-embed' },
            { id: 'openai/whisper-large' },
            { id: 'stabilityai/stable-diffusion-xl' },
            { id: 'black-forest-labs/flux-1' },
          ],
        }),
      };
    });

    const models = await getAvailableModels('huggingface');
    const ids = models.map(m => m.id);
    expect(ids).toContain('meta-llama/Llama-3-70b');
    expect(ids).not.toContain('sentence-transformers/all-MiniLM-embed');
    expect(ids).not.toContain('openai/whisper-large');
    expect(ids).not.toContain('stabilityai/stable-diffusion-xl');
    expect(ids).not.toContain('black-forest-labs/flux-1');
  });

  it('fireworks: should filter out embed, whisper, stable-diffusion, and flux models', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('fireworks');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'accounts/fireworks/models/llama-v3-70b' },
            { id: 'accounts/fireworks/models/nomic-embed-text' },
            { id: 'accounts/fireworks/models/whisper-v3' },
            { id: 'accounts/fireworks/models/stable-diffusion-xl' },
            { id: 'accounts/fireworks/models/flux-1-dev' },
          ],
        }),
      };
    });

    const models = await getAvailableModels('fireworks');
    const ids = models.map(m => m.id);
    expect(ids).toContain('accounts/fireworks/models/llama-v3-70b');
    expect(ids).not.toContain('accounts/fireworks/models/nomic-embed-text');
    expect(ids).not.toContain('accounts/fireworks/models/whisper-v3');
    expect(ids).not.toContain('accounts/fireworks/models/stable-diffusion-xl');
    expect(ids).not.toContain('accounts/fireworks/models/flux-1-dev');
  });
});

// ===========================================================================
// Together model descriptions
// ===========================================================================

describe('together model descriptions', () => {
  it('should assign correct descriptions based on model ID', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('together');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { id: 'meta-llama/llama-3-70b-chat', type: 'chat' },
        { id: 'mistralai/mixtral-8x7b', type: 'chat' },
        { id: 'qwen/qwen2-72b', type: 'chat' },
        { id: 'some-org/random-model', type: 'chat' },
      ]),
    });

    const models = await getAvailableModels('together');
    const byId = (id: string) => models.find(m => m.id === id);

    expect(byId('meta-llama/llama-3-70b-chat')?.description).toContain('Llama');
    expect(byId('mistralai/mixtral-8x7b')?.description).toContain('mixture-of-experts');
    expect(byId('qwen/qwen2-72b')?.description).toContain('Qwen');
    expect(byId('some-org/random-model')?.description).toBe('Open source language model');
  });

  it('should include pricing when available', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('together');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { id: 'model-with-pricing', type: 'chat', pricing: { input: 0.2, output: 0.6 } },
        { id: 'model-no-pricing', type: 'chat' },
      ]),
    });

    const models = await getAvailableModels('together');
    const withPricing = models.find(m => m.id === 'model-with-pricing');
    const noPricing = models.find(m => m.id === 'model-no-pricing');

    expect(withPricing?.pricing?.input).toBe(0.2);
    expect(withPricing?.pricing?.output).toBe(0.6);
    expect(noPricing?.pricing).toBeUndefined();
  });
});

// ===========================================================================
// selectModelInteractively
// ===========================================================================

describe('selectModelInteractively', () => {
  it('should return null when no models found', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('anthropic');

    const { selectModelInteractively } = await import('../src/model-detection.js');
    const result = await selectModelInteractively('anthropic');
    expect(result).toBeNull();
  });

  it('should return selected model from interactive prompt', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
        ],
      }),
    });

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce('claude-sonnet-4-20250514');

    const { selectModelInteractively } = await import('../src/model-detection.js');
    const result = await selectModelInteractively('anthropic');
    expect(result).toBe('claude-sonnet-4-20250514');
  });

  it('should return null when user cancels', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
        ],
      }),
    });

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValueOnce(null);

    const { selectModelInteractively } = await import('../src/model-detection.js');
    const result = await selectModelInteractively('anthropic');
    expect(result).toBeNull();
  });

  it('should return null when select throws an error', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
        ],
      }),
    });

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockRejectedValueOnce(new Error('user interrupted'));

    const { selectModelInteractively } = await import('../src/model-detection.js');
    const result = await selectModelInteractively('anthropic');
    expect(result).toBeNull();
  });

  it('should format choices with context length and pricing', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'openai/gpt-4o',
            name: 'GPT-4o',
            context_length: 128000,
            architecture: { output_modalities: ['text'] },
            pricing: { prompt: '0.000005', completion: '0.000015' },
          },
        ],
      }),
    });

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockImplementation(async (opts: any) => {
      // Verify the choices are formatted correctly
      const firstChoice = opts.choices[0];
      expect(firstChoice.name).toContain('128K tokens');
      expect(firstChoice.name).toContain('$');
      return 'openai/gpt-4o';
    });

    const { selectModelInteractively } = await import('../src/model-detection.js');
    await selectModelInteractively('openrouter');
  });

  it('should format context length as M tokens for 1M+', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('google');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', inputTokenLimit: 1048576 },
        ],
      }),
    });

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockImplementation(async (opts: any) => {
      const firstChoice = opts.choices[0];
      expect(firstChoice.name).toContain('M tokens');
      return 'gemini-2.0-flash';
    });

    const { selectModelInteractively } = await import('../src/model-detection.js');
    await selectModelInteractively('google');
  });

  it('should format model choice with no contextLength and no pricing', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('groq');
    const OpenAI = (await import('openai')).default;
    vi.mocked(OpenAI).mockImplementation(function (this: any) {
      this.models = {
        list: vi.fn().mockResolvedValue({
          data: [{ id: 'llama-3.3-70b-versatile' }],
        }),
      };
    });

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockImplementation(async (opts: any) => {
      const firstChoice = opts.choices[0];
      // Should just be the name, no context length or pricing suffix
      expect(firstChoice.name).toBe('llama-3.3-70b-versatile');
      return 'llama-3.3-70b-versatile';
    });

    const { selectModelInteractively } = await import('../src/model-detection.js');
    await selectModelInteractively('groq');
  });
});

// ===========================================================================
// OpenRouter name-based filtering (flux, imagen, stable-diffusion, whisper)
// ===========================================================================

describe('OpenRouter name-based model filtering', () => {
  it('should filter out flux, imagen, stable-diffusion, whisper models by name', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'good/text-model', name: 'Good Model' },
          { id: 'org/flux-pro', name: 'Flux Pro' },
          { id: 'org/imagen-3', name: 'Imagen 3' },
          { id: 'org/stable-diffusion-xl', name: 'SDXL' },
          { id: 'org/whisper-large', name: 'Whisper' },
          { id: 'org/dall-e-3', name: 'DALL-E 3' },
          { id: 'org/embed-v2', name: 'Embed' },
        ],
      }),
    });

    const models = await getAvailableModels('openrouter');
    const ids = models.map(m => m.id);
    expect(ids).toContain('good/text-model');
    expect(ids).not.toContain('org/flux-pro');
    expect(ids).not.toContain('org/imagen-3');
    expect(ids).not.toContain('org/stable-diffusion-xl');
    expect(ids).not.toContain('org/whisper-large');
    expect(ids).not.toContain('org/dall-e-3');
    expect(ids).not.toContain('org/embed-v2');
  });

  it('should filter by modality field when no output_modalities', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'image-model', name: 'Image Model', architecture: { modality: 'image', output_modalities: [] } },
          { id: 'audio-model', name: 'Audio Model', architecture: { modality: 'audio', output_modalities: [] } },
          { id: 'embedding-model', name: 'Embedding Model', architecture: { modality: 'embedding', output_modalities: [] } },
          { id: 'text-model', name: 'Text Model', architecture: { modality: 'text', output_modalities: [] } },
        ],
      }),
    });

    const models = await getAvailableModels('openrouter');
    const ids = models.map(m => m.id);
    expect(ids).not.toContain('image-model');
    expect(ids).not.toContain('audio-model');
    expect(ids).not.toContain('embedding-model');
    expect(ids).toContain('text-model');
  });
});

// ===========================================================================
// Bedrock context length helper
// ===========================================================================

describe('Bedrock context length via gateway', () => {
  it('should assign correct context lengths to Bedrock models from gateway', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://gw.com/v1');
    vi.mocked(config.getApiKey).mockReturnValue('key');
    clearModelCache('bedrock');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'anthropic.claude-3-sonnet-20240229-v1:0' },
          { id: 'meta.llama3-1-70b-instruct-v1:0' },
          { id: 'mistral.mistral-large-2407-v1:0' },
          { id: 'cohere.command-r-plus-v1:0' },
          { id: 'amazon.titan-text-premier-v1:0' },
          { id: 'amazon.titan-text-express-v1' },
          { id: 'some.unknown-model-v1' },
        ],
      }),
    });

    const models = await getAvailableModels('bedrock');
    const byId = (id: string) => models.find(m => m.id === id);

    expect(byId('anthropic.claude-3-sonnet-20240229-v1:0')?.contextLength).toBe(200000);
    expect(byId('meta.llama3-1-70b-instruct-v1:0')?.contextLength).toBe(128000);
    expect(byId('mistral.mistral-large-2407-v1:0')?.contextLength).toBe(128000);
    expect(byId('cohere.command-r-plus-v1:0')?.contextLength).toBe(128000);
    expect(byId('amazon.titan-text-premier-v1:0')?.contextLength).toBe(32000);
    expect(byId('amazon.titan-text-express-v1')?.contextLength).toBe(8192);
    expect(byId('some.unknown-model-v1')?.contextLength).toBe(32000);
  });

  it('should construct correct gateway URL without /v1 suffix', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://gw.com');
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('bedrock');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'anthropic.claude-3-sonnet' }] }),
    });

    await getAvailableModels('bedrock');
    expect(mockFetch).toHaveBeenCalledWith('https://gw.com/v1/models', { headers: {} });
  });

  it('should construct correct gateway URL with /v1 suffix', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://gw.com/v1');
    vi.mocked(config.getApiKey).mockReturnValue('my-key');
    clearModelCache('bedrock');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'anthropic.claude-3-sonnet' }] }),
    });

    await getAvailableModels('bedrock');
    expect(mockFetch).toHaveBeenCalledWith('https://gw.com/v1/models', {
      headers: { Authorization: 'Bearer my-key' },
    });
  });

  it('should assign correct Bedrock descriptions for all model families', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://gw.com');
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('bedrock');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'anthropic.claude-3-opus-v1' },
          { id: 'anthropic.claude-3-sonnet-v1' },
          { id: 'anthropic.claude-3-haiku-v1' },
          { id: 'amazon.titan-text-v1' },
          { id: 'meta.llama3-70b-v1' },
          { id: 'mistral.mistral-7b-v1' },
          { id: 'cohere.command-r-v1' },
          { id: 'some.other-model-v1' },
        ],
      }),
    });

    const models = await getAvailableModels('bedrock');
    const byId = (id: string) => models.find(m => m.id === id);

    expect(byId('anthropic.claude-3-opus-v1')?.description).toContain('Most capable');
    expect(byId('anthropic.claude-3-sonnet-v1')?.description).toContain('Balanced');
    expect(byId('anthropic.claude-3-haiku-v1')?.description).toContain('Fast');
    expect(byId('amazon.titan-text-v1')?.description).toContain('Titan');
    expect(byId('meta.llama3-70b-v1')?.description).toContain('Llama');
    expect(byId('mistral.mistral-7b-v1')?.description).toContain('Mistral');
    expect(byId('cohere.command-r-v1')?.description).toContain('Cohere');
    expect(byId('some.other-model-v1')?.description).toBe('AWS Bedrock model');
  });

  it('should return empty array when gateway returns non-ok', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://gw.com');
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('bedrock');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const models = await getAvailableModels('bedrock');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// Bedrock incompatible model patterns
// ===========================================================================

describe('Bedrock incompatible model patterns', () => {
  it('should filter stability and titan-embed models', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue('https://gw.com');
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('bedrock');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'anthropic.claude-3-sonnet-v1' },
          { id: 'stability.stable-diffusion-xl-v1' },
          { id: 'amazon.titan-embed-text-v1' },
          { id: 'some-embed-model' },
        ],
      }),
    });

    const models = await getAvailableModels('bedrock');
    const ids = models.map(m => m.id);
    expect(ids).toContain('anthropic.claude-3-sonnet-v1');
    expect(ids).not.toContain('stability.stable-diffusion-xl-v1');
    expect(ids).not.toContain('amazon.titan-embed-text-v1');
    expect(ids).not.toContain('some-embed-model');
  });
});

// ===========================================================================
// formatSize edge cases
// ===========================================================================

describe('formatSize (via Ollama model descriptions)', () => {
  it('should format KB sizes', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'tiny-model:latest', size: 512000 }],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models[0].description).toContain('KB');
  });

  it('should format MB sizes', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'small-model:latest', size: 52428800 }],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models[0].description).toContain('MB');
  });

  it('should format TB sizes', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'huge-model:latest', size: 1099511627776 }],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models[0].description).toContain('TB');
  });

  it('should include parameter_size when available', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'model:latest', size: 4000000000, details: { parameter_size: '70B', family: 'llama' } }],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models[0].description).toContain('70B');
  });

  it('should omit parameter_size when not available', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: 'model:latest', size: 4000000000 }],
      }),
    });

    const models = await getAvailableModels('ollama');
    expect(models[0].description).toContain('GB');
    expect(models[0].description).not.toContain('(');
  });
});

// ===========================================================================
// getOllamaFallbackModel — additional preference order tests
// ===========================================================================

describe('getOllamaFallbackModel - preference order', () => {
  it('should prefer llama3.1 over llama3', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3:latest', size: 4000000000 },
          { name: 'llama3.1:latest', size: 4000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBe('llama3.1:latest');
  });

  it('should prefer qwen3 over qwen2.5', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen2.5:latest', size: 4000000000 },
          { name: 'qwen3:latest', size: 4000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBe('qwen3:latest');
  });

  it('should find deepseek model', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'deepseek-coder:latest', size: 4000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBe('deepseek-coder:latest');
  });

  it('should find codellama model', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'codellama:latest', size: 4000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBe('codellama:latest');
  });

  it('should find gemma model when no higher priority available', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'gemma:latest', size: 4000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBe('gemma:latest');
  });

  it('should find gemma2 model', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'gemma2:latest', size: 4000000000 },
        ],
      }),
    });

    const result = await getOllamaFallbackModel();
    expect(result).toBe('gemma2:latest');
  });
});

// ===========================================================================
// Ollama API error status
// ===========================================================================

describe('getAvailableModels - ollama API errors', () => {
  it('should return [] when Ollama returns non-ok status', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('ollama');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const models = await getAvailableModels('ollama');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// LiteLLM API error status
// ===========================================================================

describe('getAvailableModels - litellm API errors', () => {
  it('should return [] when LiteLLM returns non-ok status', async () => {
    vi.mocked(config.getBaseUrl).mockReturnValue(undefined);
    clearModelCache('litellm');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const models = await getAvailableModels('litellm');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// Anthropic model without display_name (formatModelName branch)
// ===========================================================================

describe('formatModelName (via Anthropic API)', () => {
  it('should generate a readable name when no display_name provided', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-opus-4-5-20251101' },
        ],
      }),
    });

    const models = await getAvailableModels('anthropic');
    // formatModelName converts dashes to spaces and capitalizes
    expect(models[0].name).toBeDefined();
    expect(models[0].name!.length).toBeGreaterThan(0);
    // Should contain "Claude" (from the id transformation)
    expect(models[0].name).toContain('Claude');
  });

  it('should use display_name when provided', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-sonnet-4-20250514', display_name: 'My Custom Name' },
        ],
      }),
    });

    const models = await getAvailableModels('anthropic');
    expect(models[0].name).toBe('My Custom Name');
  });

  it('should handle generic Claude model ID for description', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('anthropic');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-unknown-variant-20250514' },
        ],
      }),
    });

    const models = await getAvailableModels('anthropic');
    expect(models[0].description).toBe('Claude language model');
  });
});

// ===========================================================================
// Google model with no description or inputTokenLimit
// ===========================================================================

describe('getAvailableModels - google edge cases', () => {
  it('should handle models with no description or inputTokenLimit', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('google');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.0-flash' },
        ],
      }),
    });

    const models = await getAvailableModels('google');
    expect(models[0].description).toBe('Google Gemini model');
    expect(models[0].contextLength).toBe(1048576);
  });

  it('should handle non-ok Google API response', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('google');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const models = await getAvailableModels('google');
    // Should return fallback models
    expect(models.length).toBeGreaterThan(0);
  });

  it('should use displayName when available', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('google');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
        ],
      }),
    });

    const models = await getAvailableModels('google');
    expect(models[0].name).toBe('Gemini 2.0 Flash');
  });

  it('should use model name as fallback when no displayName', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('google');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          { name: 'models/gemini-2.0-flash' },
        ],
      }),
    });

    const models = await getAvailableModels('google');
    expect(models[0].name).toBe('gemini-2.0-flash');
  });
});

// ===========================================================================
// OpenRouter no API key
// ===========================================================================

describe('getAvailableModels - openrouter no key', () => {
  it('should return [] when no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('openrouter');
    const models = await getAvailableModels('openrouter');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// Together no API key
// ===========================================================================

describe('getAvailableModels - together no key', () => {
  it('should return [] when no API key', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    clearModelCache('together');
    const models = await getAvailableModels('together');
    expect(models).toEqual([]);
  });
});

// ===========================================================================
// selectModelInteractively with small token context (< 1000)
// ===========================================================================

describe('selectModelInteractively - small token formatting', () => {
  it('should format small context as raw token count', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'test/tiny-model',
            name: 'Tiny Model',
            context_length: 512,
            architecture: { output_modalities: ['text'] },
          },
        ],
      }),
    });

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockImplementation(async (opts: any) => {
      const firstChoice = opts.choices[0];
      expect(firstChoice.name).toContain('512 tokens');
      return 'test/tiny-model';
    });

    const { selectModelInteractively } = await import('../src/model-detection.js');
    await selectModelInteractively('openrouter');
  });
});

// ===========================================================================
// selectModelInteractively - pricing with only input or only output
// ===========================================================================

describe('selectModelInteractively - partial pricing', () => {
  it('should show only input price when output is zero', async () => {
    vi.mocked(config.getApiKey).mockReturnValue('test-key');
    clearModelCache('openrouter');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'test/input-only',
            name: 'Input Only',
            architecture: { output_modalities: ['text'] },
            pricing: { prompt: '0.000005', completion: '0' },
          },
        ],
      }),
    });

    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockImplementation(async (opts: any) => {
      const firstChoice = opts.choices[0];
      expect(firstChoice.name).toContain('$');
      return 'test/input-only';
    });

    const { selectModelInteractively } = await import('../src/model-detection.js');
    await selectModelInteractively('openrouter');
  });
});
