/**
 * Calliope CLI - Model Detection
 *
 * Auto-detects available models for each provider and provides interactive selection.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { select } from '@inquirer/prompts';
import * as config from './config.js';
import type { LLMProvider } from './types.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { cancellable, throwIfCancelled } from './cancellation.js';
import { bindProcessCancellation, detachedProcess } from './process-cancellation.js';
import { createHash } from 'node:crypto';
import { ModelDiscoveryError, compatibleMetadata, anthropicMetadata, openRouterPricing, capability, positiveLimit, price, stringList, validateModels, type ModelInfo, type ModelCapabilities } from './models/index.js';
export type { ModelInfo, ModelCapabilities } from './models/index.js';

const DEBUG = process.env.CALLIOPE_DEBUG === '1';

export interface ModelFetchOptions {
  quiet?: boolean;
  signal?: AbortSignal;
  /** Reuse only fresh, endpoint-matching live evidence. Doctor leaves this unset. */
  cache?: 'live';
  /** Rethrow the underlying error instead of returning []. Use for interactive
   *  flows (like /model) where the user should see the real reason. */
  throwOnError?: boolean;
}

const discoveryContext = new AsyncLocalStorage<ModelFetchOptions & { cleanups: Promise<void>[] }>();
function fetchModelMetadata(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> {
  const signal = discoveryContext.getStore()?.signal;
  throwIfCancelled(signal);
  if (!signal) return init === undefined ? fetch(input) : fetch(input, init);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
}
function discoveryTransportOptions() {
  return discoveryContext.getStore()?.signal ? { fetch: fetchModelMetadata, maxRetries: 0 } : {};
}

/** Follow provider cursors only on the original endpoint, with fixed page/item caps. */
async function modelPages<T>(endpoint: string, kind: 'anthropic' | 'google', headers?: Record<string, string>): Promise<T[]> {
  const models: T[] = [], seen = new Set<string>();
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const url = new URL(endpoint);
    if (cursor) url.searchParams.set(kind === 'anthropic' ? 'after_id' : 'pageToken', cursor);
    const response = await fetchModelMetadata(url.toString(), headers ? { headers } : undefined);
    if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`);
    const data = await response.json() as Record<string, unknown>;
    const items = data[kind === 'anthropic' ? 'data' : 'models'];
    if (!Array.isArray(items) || models.length + items.length > 10000) throw new ModelDiscoveryError('Invalid model discovery page');
    models.push(...items as T[]);
    if (kind === 'anthropic' && data.has_more !== undefined && typeof data.has_more !== 'boolean') throw new ModelDiscoveryError('Invalid discovery pagination');
    if (kind === 'anthropic' && data.has_more && (typeof data.last_id !== 'string' || !data.last_id)) throw new ModelDiscoveryError('Missing discovery cursor');
    const next = kind === 'anthropic' ? (data.has_more ? data.last_id : undefined) : data.nextPageToken;
    if (next === undefined || next === null || next === '') return models;
    if (typeof next !== 'string' || next.length > 4096 || seen.has(next)) throw new ModelDiscoveryError('Invalid model discovery cursor');
    seen.add(next); cursor = next;
  }
  throw new ModelDiscoveryError('Model discovery page budget exceeded');
}

/** Scope transport cancellation to this discovery call, including concurrent probes. */
export async function getAvailableModels(provider: LLMProvider, options: ModelFetchOptions = {}): Promise<ModelInfo[]> {
  throwIfCancelled(options.signal);
  return discoveryContext.run({ ...options, cleanups: [] }, async () => {
    try { return await cancellable(loadAvailableModels(provider, options), options.signal); }
    finally { await Promise.allSettled(discoveryContext.getStore()!.cleanups); }
  });
}

function logModelDetectionWarning(message: string, error?: unknown, options: ModelFetchOptions = {}): void {
  if (options.quiet || !DEBUG) {
    return;
  }

  if (error !== undefined) {
    console.warn(message, error);
    return;
  }

  console.warn(message);
}

// API base URLs for OpenAI-compatible providers
const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  mistral: 'https://api.mistral.ai/v1',
  ai21: 'https://api.ai21.com/studio/v1',
  huggingface: 'https://router.huggingface.co/v1',
  deepseek: 'https://api.deepseek.com',
  xai: 'https://api.x.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  // Bedrock uses a configurable gateway URL, not a fixed URL
};

/**
 * Models that are incompatible with chat-based CLI (per provider)
 */
const INCOMPATIBLE_MODEL_PATTERNS: Record<string, RegExp[]> = {
  openai: [
    /^text-embedding/,      // Embedding models
    /^whisper/,             // Speech-to-text
    /^tts-/,                // Text-to-speech
    /^dall-e/,              // Image generation
    /^davinci/,             // Legacy completions
    /^babbage/,             // Legacy completions
    /^curie/,               // Legacy completions
    /^ada/,                 // Legacy (but not ada in other contexts)
    /^text-davinci/,        // Legacy
    /^text-curie/,          // Legacy
    /^text-babbage/,        // Legacy
    /^text-ada/,            // Legacy
    /^code-/,               // Legacy code models
    /moderation/,           // Moderation models
    /-search-/,             // Search models
    /-similarity-/,         // Similarity models
    /-edit-/,               // Edit models
    /^chatgpt-4o-latest/,   // Internal/unstable aliases
  ],
  google: [
    /^embedding/,           // Embedding models
    /^text-embedding/,      // Text embedding
    /^aqa/,                 // Attributed QA (not chat)
    /embedding$/,           // Any model ending in embedding
  ],
  groq: [
    /^whisper/,             // Speech-to-text
    /^distil-whisper/,      // Distilled whisper
  ],
  mistral: [
    /^mistral-embed/,       // Embedding model
  ],
  together: [
    // Already filtered by type in getTogetherModels
  ],
  openrouter: [
    // Will filter by type field instead
  ],
  ollama: [
    /embed/i,               // Embedding models (nomic-embed, etc.)
    /^all-minilm/,          // Sentence transformers
    /^bge-/,                // BGE embedding models
  ],
  litellm: [
    /embed/i,               // Embedding models
    /whisper/i,             // Speech models
    /dall-e/i,              // Image models
    /tts/i,                 // Text-to-speech
  ],
  ai21: [
    /embed/i,               // Embedding models
  ],
  huggingface: [
    /embed/i,               // Embedding models
    /whisper/i,             // Speech models
    /stable-diffusion/i,    // Image models
    /flux/i,                // Image models
  ],
  fireworks: [
    /embed/i,               // Embedding models
    /whisper/i,             // Speech models
    /stable-diffusion/i,    // Image models
    /flux/i,                // Image models
  ],
  bedrock: [
    /embed/i,               // Embedding models
    /stability\./i,         // Image generation models
    /amazon\.titan-embed/i, // Titan embedding models
  ],
  'openai-compat': [],  // No filtering — return everything from the server
};

/**
 * Check if a model is compatible with chat-based CLI
 */
function isCompatibleModel(modelId: string, provider: string): boolean {
  const patterns = INCOMPATIBLE_MODEL_PATTERNS[provider] || [];
  return !patterns.some(pattern => pattern.test(modelId));
}

// Model cache to avoid repeated API calls
const modelCache = new Map<LLMProvider, { models: ModelInfo[]; timestamp: number; target: string }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const previousDiscovery = new Map<LLMProvider, { models: ModelInfo[]; target: string }>();

/** Stale negative capability evidence still blocks an unverified fallback. */
export function getPreviousDiscoveredModels(provider: LLMProvider): ModelInfo[] | undefined {
  const previous = previousDiscovery.get(provider);
  return previous?.target === modelCacheTarget(provider) ? structuredClone(previous.models) : undefined;
}

function modelCacheTarget(provider: LLMProvider): string {
  const profile = provider === 'bedrock' ? config.getProviderCred(provider) : { profile: undefined, region: undefined };
  return createHash('sha256').update(JSON.stringify([provider, config.getBaseUrl(provider), config.getApiKey(provider), profile.profile, profile.region])).digest('hex');
}
export function getDiscoveredModels(provider: LLMProvider): ModelInfo[] | undefined {
  const cached = modelCache.get(provider);
  if (!cached || cached.target !== modelCacheTarget(provider) || Date.now() - cached.timestamp >= CACHE_DURATION || cached.models.some(model => model.evidence?.source !== 'live')) return undefined;
  return structuredClone(cached.models);
}

/** Anthropic explicitly supports resolving aliases through Models.retrieve. */
export async function resolveModelAlias(provider: LLMProvider, alias: string, signal?: AbortSignal): Promise<ModelInfo | undefined> {
  if (provider !== 'anthropic') return undefined;
  throwIfCancelled(signal);
  const key = config.getApiKey(provider);
  if (!key) return undefined;
  const target = modelCacheTarget(provider);
  const response = await cancellable(fetch(`${(config.getBaseUrl('anthropic') || 'https://api.anthropic.com').replace(/\/v1\/?$/, '').replace(/\/$/, '')}/v1/models/${encodeURIComponent(alias)}`, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal,
  }), signal);
  if (!response.ok) return undefined;
  const body = await cancellable(response.json(), signal) as { id: string; display_name?: string };
  const model: ModelInfo = { id: body.id, name: body.display_name, aliases: [alias], ...anthropicMetadata(body), evidence: { source: 'live', at: new Date().toISOString() } };
  validateModels([model]); throwIfCancelled(signal);
  const cached = modelCache.get(provider);
  if (cached?.target === target && modelCacheTarget(provider) === target) {
    model.aliases = [...new Set([...(cached.models.find(item => item.id === model.id)?.aliases ?? []), alias])];
    cached.models = [...cached.models.filter(item => item.id !== model.id), model];
    previousDiscovery.set(provider, { models: structuredClone(cached.models), target });
  }
  return model;
}

/**
 * Get available models for a provider with interactive selection
 */
export async function selectModelInteractively(provider: LLMProvider): Promise<string | null> {
  try {
    console.log(`\n🔍 Discovering models for ${provider}...`);
    
    const models = await getAvailableModels(provider);
    
    if (models.length === 0) {
      console.log(`❌ No models found for ${provider}`);
      return null;
    }

    console.log(`✨ Found ${models.length} models\n`);

    const choices: Array<{ name: string; value: string | null; description: string }> = models.map(model => ({
      name: formatModelChoice(model),
      value: model.id,
      description: model.description || 'No description available',
    }));

    // Add option to cancel
    choices.push({
      name: '❌ Cancel',
      value: null,
      description: 'Keep current model',
    });

    const selectedModel = await select<string | null>({
      message: `Select a model for ${provider}:`,
      choices,
      pageSize: 15,
    });

    return selectedModel;
  } catch (error) {
    console.log(`❌ Failed to fetch models for ${provider}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Format model choice for display
 */
function formatModelChoice(model: ModelInfo): string {
  let display = model.name || model.id;
  
  if (model.contextLength) {
    display += ` (${formatContextLength(model.contextLength)})`;
  }
  
  if (model.pricing) {
    const inputPrice = model.pricing.input !== undefined ? `$${model.pricing.input.toFixed(2)}/1M` : '';
    const outputPrice = model.pricing.output !== undefined ? `$${model.pricing.output.toFixed(2)}/1M` : '';
    if (inputPrice || outputPrice) {
      display += ` - ${inputPrice}${inputPrice && outputPrice ? '/' : ''}${outputPrice}`;
    }
  }
  
  return display;
}

/**
 * Format context length for display
 */
function formatContextLength(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M tokens`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}K tokens`;
  } else {
    return `${tokens} tokens`;
  }
}

/**
 * Get available models for a provider
 */
async function loadAvailableModels(provider: LLMProvider, options: ModelFetchOptions): Promise<ModelInfo[]> {
  // Check cache first
  const cached = modelCache.get(provider);
  const target = modelCacheTarget(provider);
  // Strict callers require current wire evidence; a cached emergency fallback
  // must never masquerade as successful live discovery.
  if (cached?.target === target && Date.now() - cached.timestamp < CACHE_DURATION &&
      (!options.throwOnError || (options.cache === 'live' && cached.models.every(model => model.evidence?.source === 'live')))) {
    return structuredClone(cached.models);
  }

  let models: ModelInfo[] = [];

  try {
    switch (provider) {
      case 'anthropic':
        models = await getAnthropicModels(options);
        break;
      case 'google':
        models = await getGoogleModels(options);
        break;
      case 'openai':
        models = await getOpenAIModels();
        break;
      case 'openrouter':
        models = await getOpenRouterModels();
        break;
      case 'together':
        models = await getTogetherModels();
        break;
      case 'groq':
        models = await getGroqModels();
        break;
      case 'mistral':
        models = await getMistralModels();
        break;
      case 'ollama':
        models = await getOllamaModels();
        break;
      case 'litellm':
        models = await getLiteLLMModels();
        break;
      case 'ai21':
      case 'huggingface':
      case 'fireworks':
      case 'deepseek':
      case 'xai':
      case 'cerebras':
        models = await getOpenAICompatibleModels(provider);
        break;
      case 'bedrock':
        models = await getBedrockModels();
        break;
      case 'openai-compat':
        models = await getOpenAICompatModels();
        break;
      default:
        throw new Error(`Model detection not implemented for ${provider}`);
    }

    throwIfCancelled(options.signal);
    // Cache the results
    const timestamp = Date.now();
    models = validateModels(models).map(model => ({ ...model, evidence: model.evidence ?? { source: 'live', at: new Date(timestamp).toISOString() } }));
    // Endpoint/credential changes during discovery cannot populate a new target's cache.
    if (modelCacheTarget(provider) === target) {
      modelCache.set(provider, { models: structuredClone(models), timestamp, target });
      if (models.every(model => model.evidence?.source === 'live')) previousDiscovery.set(provider, { models: structuredClone(models), target });
    }
  } catch (error) {
    logModelDetectionWarning(`Failed to fetch models for ${provider}:`, error, options);
    if (options.throwOnError) throw error;
  }

  return models;
}

/**
 * Get Anthropic models dynamically from API
 */
async function getAnthropicModels(options: ModelFetchOptions = {}): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('anthropic');
  if (!apiKey) throw new Error('Anthropic API key not configured');

  try {
    const models = await modelPages<{ id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number; capabilities?: { image_input?: unknown; thinking?: unknown; structured_outputs?: unknown } }>(
      `${(config.getBaseUrl('anthropic') || 'https://api.anthropic.com').replace(/\/v1\/?$/, '').replace(/\/$/, '')}/v1/models`, 'anthropic', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });

    return models
      .filter(model => model.id.startsWith('claude'))
      .map(model => ({
        id: model.id,
        name: model.display_name || formatModelName(model.id),
        description: getAnthropicModelDescription(model.id),
        ...anthropicMetadata(model),
      }))
      .sort((a, b) => b.id.localeCompare(a.id)); // Newest first
  } catch (error) {
    // Emergency fallback when the API is unreachable. Keep these as the current
    // shipping models — discovery is the source of truth; this is the offline net.
    if (options.throwOnError) throw error;
    logModelDetectionWarning('Failed to fetch Anthropic models, using fallback list', error, options);
    return [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', description: 'Most capable model', contextLength: 1000000 },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Balanced intelligence and speed', contextLength: 1000000 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fast and affordable', contextLength: 200000 },
    ].map(model => ({ ...model, evidence: { source: 'emergency' as const, at: new Date().toISOString() } }));
  }
}

function formatModelName(modelId: string): string {
  // Convert claude-opus-4-5-20251101 to Claude Opus 4.5
  return modelId
    .replace(/^claude-/, 'Claude ')
    .replace(/-(\d+)-(\d+)-\d+$/, ' $1.$2')
    .replace(/-(\d+)-\d+$/, ' $1')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function getAnthropicModelDescription(modelId: string): string {
  if (modelId.includes('opus')) return 'Most capable model for complex tasks';
  if (modelId.includes('sonnet')) return 'Balanced intelligence and speed';
  if (modelId.includes('haiku')) return 'Fast and affordable';
  return 'Claude language model';
}

/**
 * Get Google models dynamically from API
 */
async function getGoogleModels(options: ModelFetchOptions = {}): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('google');
  if (!apiKey) throw new Error('Google API key not configured');

  try {
    // Use REST API directly for model listing
    const models = await modelPages<{ name: string; displayName?: string; description?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[]; thinking?: boolean }>(
      `${(config.getBaseUrl('google') || 'https://generativelanguage.googleapis.com').replace(/\/v1beta\/?$/, '').replace(/\/$/, '')}/v1beta/models?key=${encodeURIComponent(apiKey)}`, 'google');

    return models
      .filter(model => {
        const modelId = model.name.replace('models/', '');
        return model.name.includes('gemini') && isCompatibleModel(modelId, 'google');
      })
      .map(model => ({
        id: model.name.replace('models/', ''),
        name: model.displayName || model.name.replace('models/', ''),
        description: model.description || 'Google Gemini model',
        contextLength: positiveLimit(model.inputTokenLimit),
        maxOutputTokens: positiveLimit(model.outputTokenLimit),
        capabilities: { chat: stringList(model.supportedGenerationMethods)?.includes('generateContent'), thinking: capability(model.thinking) },
      }))
      .sort((a, b) => b.id.localeCompare(a.id)); // Newest first
  } catch (error) {
    // Fallback to known models if API fails
    if (options.throwOnError) throw error;
    logModelDetectionWarning('Failed to fetch Google models, using fallback list', error, options);
    return [
      { id: 'gemini-2.5-pro-preview-06-05', name: 'Gemini 2.5 Pro', description: 'Most capable', contextLength: 1048576 },
      { id: 'gemini-2.5-flash-preview-05-20', name: 'Gemini 2.5 Flash', description: 'Fast next-gen', contextLength: 1048576 },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Multimodal', contextLength: 1048576 },
      { id: 'gemini-1.5-pro-latest', name: 'Gemini 1.5 Pro', description: 'Complex reasoning', contextLength: 2097152 },
      { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash', description: 'Fast and versatile', contextLength: 1048576 },
    ].map(model => ({ ...model, evidence: { source: 'emergency' as const, at: new Date().toISOString() } }));
  }
}

/**
 * Get OpenAI models
 */
async function getOpenAIModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const client = new OpenAI({ apiKey, baseURL: config.getBaseUrl('openai'), ...discoveryTransportOptions() });
  const response = await client.models.list();

  // Filter for chat-compatible models (GPT and reasoning models)
  return response.data
    .filter(model =>
      isCompatibleModel(model.id, 'openai') && (
        model.id.includes('gpt') ||
        model.id.startsWith('o1') ||
        model.id.startsWith('o3') ||
        model.id.startsWith('o4') ||
        model.id.startsWith('gpt-5')
      )
    )
    .map(model => ({
      id: model.id,
      name: model.id,
      description: getOpenAIModelDescription(model.id),
      ...compatibleMetadata(model),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get OpenRouter models
 */
async function getOpenRouterModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('openrouter');
  if (!apiKey) throw new Error('OpenRouter API key not configured');

  const response = await fetchModelMetadata(`${(config.getBaseUrl('openrouter') || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/models`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://calliope.ai',
      'X-Title': 'Calliope CLI'
    }
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status}`);
  }

  const data = await response.json() as {
    data: Array<{
      id: string;
      name: string;
      description?: string;
      context_length?: number;
      architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
      pricing?: unknown;
      supported_parameters?: string[];
      top_provider?: { max_completion_tokens?: number };
    }>
  };

  // Filter for text generation models (exclude image-only, embedding, etc.)
  return data.data
    .filter(model => {
      // Check if model supports text output
      const outputModalities = model.architecture?.output_modalities || [];
      const inputModalities = model.architecture?.input_modalities || [];
      const modality = model.architecture?.modality || '';

      // Include if it has text output capability or no architecture info (assume text)
      if (outputModalities.length > 0) {
        return outputModalities.includes('text');
      }
      // Exclude known non-text modalities
      if (modality === 'image' || modality === 'audio' || modality === 'embedding') {
        return false;
      }
      // Exclude by name patterns
      if (model.id.includes('embed') || model.id.includes('whisper') ||
          model.id.includes('dall-e') || model.id.includes('stable-diffusion') ||
          model.id.includes('flux') || model.id.includes('imagen')) {
        return false;
      }
      return true;
    })
    .map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      contextLength: positiveLimit(model.context_length),
      maxOutputTokens: positiveLimit(model.top_provider?.max_completion_tokens),
      capabilities: { chat: true, tools: model.supported_parameters ? model.supported_parameters.includes('tools') : undefined,
        vision: model.architecture?.input_modalities ? model.architecture.input_modalities.includes('image') : undefined },
      pricing: openRouterPricing(model.pricing)
    }));
}

/**
 * Get Together models
 */
async function getTogetherModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('together');
  if (!apiKey) throw new Error('Together API key not configured');

  // Together's API returns a raw array, not wrapped in { data: [...] } like OpenAI
  const response = await fetchModelMetadata(`${(config.getBaseUrl('together') || 'https://api.together.xyz/v1').replace(/\/+$/, '')}/models`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    }
  });

  if (!response.ok) {
    throw new Error(`Together API error: ${response.status}`);
  }

  const models = await response.json() as Array<{
    id: string;
    display_name?: string;
    type?: string;
    context_length?: number;
    pricing?: { input?: number; output?: number };
  }>;

  // Filter for chat models and sort by display name
  return models
    .filter(model => model.type === 'chat' || model.type === 'language')
    .map(model => ({
      id: model.id,
      name: model.display_name || model.id,
      description: getTogetherModelDescription(model.id),
      ...compatibleMetadata(model),
      contextLength: positiveLimit(model.context_length),
      pricing: model.pricing ? {
        input: price(model.pricing.input),
        output: price(model.pricing.output),
      } : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get Groq models
 */
async function getGroqModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('groq');
  if (!apiKey) throw new Error('Groq API key not configured');

  const client = new OpenAI({
    ...discoveryTransportOptions(),
    apiKey,
    baseURL: config.getBaseUrl('groq') || 'https://api.groq.com/openai/v1'
  });

  const response = await client.models.list();
  return response.data
    .filter(model => isCompatibleModel(model.id, 'groq'))
    .map(model => ({
      id: model.id,
      name: model.id,
      description: 'High-speed inference model',
      ...compatibleMetadata(model),
    }));
}

/**
 * Get Mistral models
 */
async function getMistralModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('mistral');
  if (!apiKey) throw new Error('Mistral API key not configured');

  const client = new OpenAI({
    ...discoveryTransportOptions(),
    apiKey,
    baseURL: config.getBaseUrl('mistral') || 'https://api.mistral.ai/v1'
  });

  const response = await client.models.list();
  return response.data
    .filter(model => isCompatibleModel(model.id, 'mistral'))
    .map(model => ({
      id: model.id,
      name: model.id,
      description: getMistralModelDescription(model.id),
      ...compatibleMetadata(model),
    }));
}

/**
 * Get Ollama models
 */
async function getOllamaModels(): Promise<ModelInfo[]> {
  let baseUrl = config.getBaseUrl('ollama') || 'http://localhost:11434';
  // Strip /v1 suffix if present (native Ollama API doesn't use it)
  if (baseUrl.endsWith('/v1')) {
    baseUrl = baseUrl.slice(0, -3);
  }

  try {
    const response = await fetchModelMetadata(`${baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as { models: Array<{ name: string; size: number; details?: { parameter_size?: string; family?: string } }> };
    const models = data.models.filter(model => isCompatibleModel(model.name, 'ollama'));

    // Query actual num_ctx for each model via /api/show
    const results: ModelInfo[] = [];
    for (const model of models) {
      let contextLength: number | undefined;
      let capabilities: ModelCapabilities | undefined;
      try {
        const showResp = await fetchModelMetadata(`${baseUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model.name }),
        });
        if (showResp.ok) {
          const showData = await showResp.json() as {
            model_info?: Record<string, unknown>;
            parameters?: string;
            capabilities?: string[];
          };
          const supported = stringList(showData.capabilities);
          if (supported) capabilities = { chat: supported.includes('completion'), tools: supported.includes('tools'), vision: supported.includes('vision'), thinking: supported.includes('thinking') };
          // Check model_info for context length keys
          if (showData.model_info) {
            const ctxKey = Object.keys(showData.model_info).find(k =>
              k.includes('context_length') || k.includes('context_window')
            );
            if (ctxKey && typeof showData.model_info[ctxKey] === 'number') {
              contextLength = positiveLimit(showData.model_info[ctxKey]);
            }
          }
          // Also check Modelfile parameters for num_ctx override
          if (showData.parameters) {
            const numCtxMatch = showData.parameters.match(/num_ctx\s+(\d+)/);
            if (numCtxMatch) {
              contextLength = positiveLimit(parseInt(numCtxMatch[1]!, 10));
            }
          }
        }
      } catch {
        // Skip — we'll use the default context limit
      }

      results.push({
        id: model.name,
        capabilities,
        name: model.name,
        description: `Size: ${formatSize(model.size)}${model.details?.parameter_size ? ` (${model.details.parameter_size})` : ''}`,
        contextLength,
        // Ollama does not expose a separate output limit. Bound generation by
        // the live context window so execution admission can remain fail-closed.
        maxOutputTokens: contextLength === undefined ? undefined : Math.min(contextLength, 8192),
      });
    }

    return results;
  } catch (error) {
    if (error instanceof ModelDiscoveryError || error instanceof SyntaxError || error instanceof TypeError) throw error;
    throw new Error(`Failed to connect to Ollama at ${baseUrl}. Is Ollama running? Try: ollama serve`);
  }
}

/**
 * Discover available Ollama models and return the best fallback.
 * Called when the configured model isn't available.
 */
export async function getOllamaFallbackModel(): Promise<string | null> {
  try {
    const models = await getOllamaModels();
    if (models.length === 0) return null;

    // Preference order for fallback models (larger/better models first)
    const preferenceOrder = [
      'llama3.3', 'llama3.1', 'llama3', 'qwen3', 'qwen2.5', 'deepseek',
      'codellama', 'mistral', 'phi-3', 'gemma2', 'gemma',
    ];

    for (const pref of preferenceOrder) {
      const match = models.find(m => m.id.toLowerCase().startsWith(pref));
      if (match) return match.id;
    }

    // If no preferred model found, return the first available one
    return models[0]!.id;
  } catch {
    return null;
  }
}

/**
 * Get LiteLLM models
 */
async function getLiteLLMModels(): Promise<ModelInfo[]> {
  let baseUrl = config.getBaseUrl('litellm') || 'http://localhost:4000';
  // Strip /v1 suffix if present to avoid double /v1
  if (baseUrl.endsWith('/v1')) {
    baseUrl = baseUrl.slice(0, -3);
  }

  try {
    const response = await fetchModelMetadata(`${baseUrl}/v1/models`);
    if (!response.ok) {
      throw new Error(`LiteLLM API error: ${response.status}`);
    }

    const data = await response.json() as { data: Array<{ id: string }> };
    return data.data
      .filter(model => isCompatibleModel(model.id, 'litellm'))
      .map((model) => ({
        id: model.id,
        name: model.id,
        description: 'Proxied via LiteLLM',
        ...compatibleMetadata(model),
      }));
  } catch (error) {
    if (error instanceof ModelDiscoveryError || error instanceof SyntaxError || error instanceof TypeError) throw error;
    throw new Error(`Failed to connect to LiteLLM at ${baseUrl}`);
  }
}

/**
 * Get Bedrock models — dynamic discovery via AWS APIs, gateway, or minimal fallback
 */
async function getBedrockModels(): Promise<ModelInfo[]> {
  const baseUrl = config.getBaseUrl('bedrock');
  const apiKey = config.getApiKey('bedrock');

  // 1. Try gateway/proxy model listing (OpenAI-compatible)
  if (baseUrl) {
    const modelsUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const response = await fetchModelMetadata(modelsUrl, { headers });
    if (response.ok) {
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data
        .filter(model => isCompatibleModel(model.id, 'bedrock'))
        .map(model => ({
          id: model.id,
          name: model.id,
          description: getBedrockModelDescription(model.id),
          ...compatibleMetadata(model),
        }));
    }
    throw new Error(`Bedrock gateway ${baseUrl} returned ${response.status}. Check BEDROCK_BASE_URL / BEDROCK_API_KEY.`);
  }

  // 2. Native AWS path — let errors bubble up so the user sees the real reason.
  return discoverBedrockModelsNative();
}

/**
 * Resolve AWS credentials via the `aws` CLI. Handles SSO profiles,
 * role-assumption profiles, and anything else `aws` knows about.
 * Returns null if the CLI isn't installed or the profile resolution fails.
 */
async function resolveAwsCredentialsViaCli(profile: string): Promise<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} | null> {
  try {
    const { execFileSync } = await import('child_process');
    const signal = discoveryContext.getStore()?.signal;
    const read = async (format: string): Promise<string> => {
      const args = ['configure', 'export-credentials', '--profile', profile, '--format', format];
      if (!signal) return execFileSync('aws', args, { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      throwIfCancelled(signal);
      const { spawn } = await import('node:child_process');
      throwIfCancelled(signal);
      return new Promise<string>((resolve, reject) => {
        const capacity = new AbortController();
        const combined = AbortSignal.any([signal, AbortSignal.timeout(10000), capacity.signal]);
        const child = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: detachedProcess });
        const cleanup = bindProcessCancellation(child, combined);
        discoveryContext.getStore()?.cleanups.push(cleanup);
        const chunks: Buffer[] = []; let size = 0;
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) capacity.abort();
          else chunks.push(chunk);
        });
        child.stderr.resume();
        child.once('error', () => { void cleanup.then(() => reject(new Error('AWS profile credential resolution failed'))); });
        child.once('close', code => { void cleanup.then(() => code === 0 && !combined.aborted
          ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('AWS profile credential resolution failed'))); });
      });
    };
    let output = '';
    try {
      output = await read('env-no-export');
    } catch {
      throwIfCancelled(signal);
      output = await read('env');
    }
    const envs: Record<string, string> = {};
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      const match = line.match(/^(?:export\s+)?([A-Z_]+)\s*=\s*(.+)$/);
      if (!match) continue;
      let val = match[2]!.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      envs[match[1]!] = val;
    }
    if (envs.AWS_ACCESS_KEY_ID && envs.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: envs.AWS_ACCESS_KEY_ID,
        secretAccessKey: envs.AWS_SECRET_ACCESS_KEY,
        sessionToken: envs.AWS_SESSION_TOKEN,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Discover Bedrock models using the native AWS ListFoundationModels API.
 * Uses SigV4 signing from the bedrock provider — no AWS SDK needed.
 */
async function discoverBedrockModelsNative(): Promise<ModelInfo[]> {
  const { createHash, createHmac } = await import('crypto');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const { existsSync, readFileSync } = await import('fs');

  // Resolve credentials (same logic as bedrock.ts)
  let accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
  let secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
  let sessionToken = process.env.AWS_SESSION_TOKEN;
  const profile = config.getProviderCred('bedrock').profile || 'default';

  // Parse an INI-style AWS file. Handles both ~/.aws/credentials sections
  // ([name]) and ~/.aws/config sections ([profile name]).
  const readIni = (path: string): Record<string, Record<string, string>> => {
    if (!existsSync(path)) return {};
    const content = readFileSync(path, 'utf-8');
    const sections: Record<string, Record<string, string>> = {};
    let section = '';
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      const secMatch = trimmed.match(/^\[(.+)\]$/);
      if (secMatch) {
        section = secMatch[1]!.replace(/^profile\s+/, '');
        sections[section] = sections[section] || {};
        continue;
      }
      const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
      if (kvMatch && section) sections[section]![kvMatch[1]!.trim()] = kvMatch[2]!.trim();
    }
    return sections;
  };

  if (!accessKeyId || !secretAccessKey) {
    // Try ~/.aws/credentials (static keys) first, then ~/.aws/config (also
    // used by some setups that put static keys alongside SSO config).
    const credSections = readIni(join(homedir(), '.aws', 'credentials'));
    const configSections = readIni(join(homedir(), '.aws', 'config'));
    const cred = credSections[profile] || configSections[profile];
    if (cred?.aws_access_key_id) {
      accessKeyId = cred.aws_access_key_id;
      secretAccessKey = cred.aws_secret_access_key || '';
      sessionToken = cred.aws_session_token;
    }
  }

  // Last resort: shell out to the AWS CLI. This resolves SSO / role-assumption
  // profiles that can't be parsed from the INI files alone.
  if (!accessKeyId || !secretAccessKey) {
    const cliCreds = await resolveAwsCredentialsViaCli(profile);
    if (cliCreds) {
      accessKeyId = cliCreds.accessKeyId;
      secretAccessKey = cliCreds.secretAccessKey;
      sessionToken = cliCreds.sessionToken;
    }
  }

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `No AWS credentials found for profile "${profile}". ` +
      `Try: aws sso login --profile ${profile}  (for SSO), or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.`
    );
  }

  const region = config.getProviderCred('bedrock').region || 'us-east-1';
  const host = `bedrock.${region}.amazonaws.com`;

  const signedGet = async (path: string, query: string): Promise<Response> => {
    const url = `https://${host}${path}${query ? '?' + query : ''}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const sha256Fn = (d: string) => createHash('sha256').update(d).digest('hex');
    const hmacFn = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();

    const headers: Record<string, string> = { host, 'x-amz-date': amzDate };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;

    const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
    const signedHeaders = signedHeaderKeys.join(';');
    const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k]!.trim()}`).join('\n') + '\n';
    const payloadHash = sha256Fn('');
    // AWS SigV4: non-S3 services require the canonical URI to be URI-encoded
    // TWICE. Paths here don't currently contain special chars but we normalise
    // for consistency with the chat signing path.
    const canonicalPath = path.split('/').map(s => encodeURIComponent(s)).join('/');
    const canonicalRequest = ['GET', canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${region}/bedrock/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Fn(canonicalRequest)].join('\n');

    const kDate = hmacFn('AWS4' + secretAccessKey, dateStamp);
    const kRegion = hmacFn(kDate, region);
    const kService = hmacFn(kRegion, 'bedrock');
    const signingKey = hmacFn(kService, 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return fetchModelMetadata(url, { headers });
  };

  // 1. ListFoundationModels (direct on-demand access).
  // Dropped the byInferenceType=ON_DEMAND filter — newer Claude models are only
  // accessible via cross-region inference profiles and don't have ON_DEMAND flag.
  const foundationResp = await signedGet('/foundation-models', 'byOutputModality=TEXT');
  if (!foundationResp.ok) {
    let body = '';
    try { body = (await foundationResp.text()).slice(0, 400); } catch { /* ignore */ }
    throw new Error(
      `AWS Bedrock ListFoundationModels returned ${foundationResp.status} in region ${region}. ` +
      (body || 'Common causes: (1) no Bedrock access in this region — try us-east-1 or us-west-2; ' +
       '(2) IAM role missing bedrock:ListFoundationModels; (3) SSO token expired — run `aws sso login`.')
    );
  }
  const foundationData = await foundationResp.json() as {
    modelSummaries?: Array<{
      modelId: string;
      modelName?: string;
      providerName?: string;
      inputModalities?: string[];
      outputModalities?: string[];
      responseStreamingSupported?: boolean;
    }>;
  };

  if (!Array.isArray(foundationData.modelSummaries)) throw new ModelDiscoveryError('Invalid Bedrock foundation discovery');
  const foundationModels: ModelInfo[] = foundationData.modelSummaries
    .filter(m => m.inputModalities?.includes('TEXT') && m.outputModalities?.includes('TEXT'))
    .map(m => ({
      id: m.modelId,
      name: m.modelName || m.modelId,
      description: `${m.providerName || 'Unknown'} — ${getBedrockModelDescription(m.modelId)}`,
      capabilities: { streaming: capability(m.responseStreamingSupported), vision: stringList(m.inputModalities)?.includes('IMAGE') },
    }));

  // 2. ListInferenceProfiles — cross-region profile IDs (e.g. us.anthropic.claude-sonnet-4-5-*).
  // Many modern models are ONLY reachable via these, not direct foundation-model IDs.
  // Failures here are non-fatal (older accounts / regions may not support it).
  const profileModels: ModelInfo[] = [], coveredBaseIds = new Set<string>();
  const seen = new Set<string>();
  let nextToken = '';
  for (let page = 0; page < 20; page++) {
    const profileResp = await signedGet('/inference-profiles', nextToken ? `nextToken=${encodeURIComponent(nextToken)}` : '');
    if (!profileResp.ok) break; // Profiles are optional; foundation evidence remains usable.
    const data = await profileResp.json() as {
      inferenceProfileSummaries?: { inferenceProfileId: string; inferenceProfileName?: string; status?: string; models?: { modelArn: string }[] }[];
      nextToken?: unknown;
    };
    if (!Array.isArray(data.inferenceProfileSummaries) || profileModels.length + data.inferenceProfileSummaries.length > 10000) throw new ModelDiscoveryError('Invalid Bedrock profile discovery');
    for (const profile of data.inferenceProfileSummaries) {
      if (profile.status === 'INACTIVE') continue;
      const baseIds = profile.models?.map(model => model.modelArn.split(':foundation-model/')[1]).filter((id): id is string => !!id) ?? [];
      const bases = baseIds.map(id => foundationModels.find(model => model.id === id));
      // Only profile-provided ARNs establish a relationship to foundation models.
      // Inherit a capability only when every regional model reports the same value.
      const shared = (key: keyof ModelCapabilities): boolean | undefined => {
        const values = bases.map(model => model?.capabilities?.[key]);
        return values.length && values.every(value => value === values[0]) ? values[0] : undefined;
      };
      for (const id of baseIds) coveredBaseIds.add(id);
      profileModels.push({ id: profile.inferenceProfileId, name: profile.inferenceProfileName || profile.inferenceProfileId,
        description: 'Bedrock inference profile', capabilities: { streaming: shared('streaming'), vision: shared('vision') } });
    }
    if (data.nextToken == null || data.nextToken === '') break;
    if (typeof data.nextToken !== 'string' || data.nextToken.length > 2048 || seen.has(data.nextToken)) throw new ModelDiscoveryError('Invalid Bedrock discovery cursor');
    seen.add(data.nextToken); nextToken = data.nextToken;
    if (page === 19) throw new ModelDiscoveryError('Bedrock discovery page budget exceeded');
  }
  const filteredFoundation = foundationModels.filter(model => !coveredBaseIds.has(model.id));

  const merged = new Map<string, ModelInfo>();
  for (const m of filteredFoundation) merged.set(m.id, m);
  for (const m of profileModels) merged.set(m.id, m);
  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function getBedrockModelDescription(modelId: string): string {
  if (modelId.includes('claude') && modelId.includes('opus')) return 'Most capable Claude model on Bedrock';
  if (modelId.includes('claude') && modelId.includes('sonnet')) return 'Balanced Claude model on Bedrock';
  if (modelId.includes('claude') && modelId.includes('haiku')) return 'Fast Claude model on Bedrock';
  if (modelId.includes('titan')) return 'Amazon Titan model';
  if (modelId.includes('llama')) return 'Meta Llama model on Bedrock';
  if (modelId.includes('mistral')) return 'Mistral model on Bedrock';
  if (modelId.includes('cohere')) return 'Cohere model on Bedrock';
  return 'AWS Bedrock model';
}

/**
 * Get models from a generic OpenAI-compatible server (e.g. LM Studio, Jan, LocalAI, vLLM)
 */
async function getOpenAICompatModels(): Promise<ModelInfo[]> {
  let baseUrl = config.getBaseUrl('openai-compat') || 'http://localhost:1234';
  if (!baseUrl.endsWith('/v1')) baseUrl = `${baseUrl}/v1`;
  const apiKey = config.getApiKey('openai-compat') || 'openai-compat';

  const response = await fetchModelMetadata(`${baseUrl}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compat server error: ${response.status}`);
  }

  const data = await response.json() as { data?: Array<{ id: string }> };
  if (!Array.isArray(data.data)) throw new ModelDiscoveryError('Invalid model discovery response');
  const models = data.data;
  return models.map(m => ({ id: m.id, name: m.id, description: 'OpenAI-compatible server', ...compatibleMetadata(m) }));
}

/**
 * Get models for OpenAI-compatible providers
 */
async function getOpenAICompatibleModels(provider: LLMProvider): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey(provider);
  if (!apiKey) throw new Error(`${provider} API key not configured`);

  const baseURL = config.getBaseUrl(provider) || PROVIDER_BASE_URLS[provider];
  if (!baseURL) throw new Error(`Unknown provider: ${provider}`);

  // Cerebras exposes richer limits, pricing and capability metadata on its
  // public catalog; the OpenAI-compatible /v1/models endpoint only returns
  // identifiers, which makes bounded tool execution impossible to quote.
  if (provider === 'cerebras') {
    const publicUrl = `${new URL(baseURL).origin}/public/v1/models`;
    const metadataResponse = await fetchModelMetadata(publicUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (metadataResponse.ok) {
      const payload = await metadataResponse.json() as { data?: unknown[] };
      if (!Array.isArray(payload.data)) throw new ModelDiscoveryError('Invalid Cerebras model discovery response');
      return payload.data
        .filter(model => { const id = typeof model === 'object' && model !== null ? (model as { id?: unknown }).id : undefined; return typeof id === 'string' && isCompatibleModel(id, provider); })
        .map(model => { const id = (model as { id: string }).id; return { id, name: id, ...compatibleMetadata(model) }; });
    }
  }
  const client = new OpenAI({ apiKey, baseURL, ...discoveryTransportOptions() });
  const response = await client.models.list();
  return response.data.filter(model => isCompatibleModel(model.id, provider)).map(model => ({ id: model.id, name: model.id, ...compatibleMetadata(model) }));
}

/**
 * Helper functions for model descriptions
 */
function getOpenAIModelDescription(modelId: string): string {
  if (modelId.startsWith('gpt-5')) return 'Most capable reasoning model';
  if (modelId.startsWith('o4-mini')) return 'Fast reasoning model with tool use';
  if (modelId.startsWith('o3-pro')) return 'Extended reasoning for hard problems';
  if (modelId.startsWith('o3-mini')) return 'Efficient reasoning model';
  if (modelId.startsWith('o3')) return 'Advanced reasoning model';
  if (modelId.startsWith('o1')) return 'Reasoning model for complex problems';
  if (modelId.includes('gpt-4o')) return 'Flagship model for complex, multi-step tasks';
  if (modelId.includes('gpt-4-turbo')) return 'Previous generation multimodal model';
  if (modelId.includes('gpt-4')) return 'High-intelligence model for complex tasks';
  if (modelId.includes('gpt-3.5-turbo')) return 'Fast, inexpensive model for simple tasks';
  return 'OpenAI language model';
}

function getTogetherModelDescription(modelId: string): string {
  if (modelId.includes('llama')) return 'Meta\'s Llama model';
  if (modelId.includes('mixtral')) return 'Mistral\'s mixture-of-experts model';
  if (modelId.includes('qwen')) return 'Alibaba\'s Qwen model';
  return 'Open source language model';
}

function getMistralModelDescription(modelId: string): string {
  if (modelId.includes('large')) return 'Most capable Mistral model';
  if (modelId.includes('medium')) return 'Balanced performance and efficiency';
  if (modelId.includes('small')) return 'Fast and efficient for simple tasks';
  return 'Mistral language model';
}

function formatSize(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Clear model cache for a provider
 */
export function clearModelCache(provider?: LLMProvider): void {
  if (provider) {
    modelCache.delete(provider);
    previousDiscovery.delete(provider);
  } else {
    modelCache.clear();
    previousDiscovery.clear();
  }
}

/**
 * Pre-warm model cache for configured providers
 * Runs in background, doesn't block startup
 */
export async function preWarmModelCache(parentSignal?: AbortSignal): Promise<void> {
  const configuredProviders = config.getConfiguredProviders();
  const deadline = AbortSignal.timeout(30000);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;

  // Fetch models for all configured providers in parallel
  await Promise.allSettled(
    configuredProviders.map(provider => getAvailableModels(provider, { quiet: true, signal }))
  );
}

/**
 * Get model info from cache by ID
 */
export function getModelInfo(provider: LLMProvider, modelId: string): ModelInfo | undefined {
  const cached = modelCache.get(provider);
  if (!cached || cached.target !== modelCacheTarget(provider) || Date.now() - cached.timestamp >= CACHE_DURATION) return undefined;
  // Exact match first.
  const exact = cached.models.find(m => m.id === modelId || m.aliases?.includes(modelId));
  if (exact) return structuredClone(exact);
  if (cached.models.every(model => model.evidence?.source === 'live')) return undefined;
  // Otherwise only accept an UNAMBIGUOUS prefix relationship. Loose substring
  // matching wrongly resolved e.g. `gpt-4` -> `gpt-4o` or `claude-opus-4` ->
  // `claude-opus-4-8`, returning a different model's context/pricing.
  const related = cached.models.filter(m => m.id.startsWith(modelId) || modelId.startsWith(m.id));
  return related.length === 1 ? structuredClone(related[0]) : undefined;
}

/**
 * Default context limits by model family (fallback when API doesn't provide it)
 */
const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic — current 1M-context models matched first (longest key wins).
  // Everything else (Haiku 4.5, Claude 3.x, and the older -20250514 IDs) falls
  // through to the generic `claude` 200K entry below.
  'claude-fable-5': 1000000,
  'claude-opus-4-8': 1000000,
  'claude-opus-4-7': 1000000,
  'claude-opus-4-6': 1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-haiku-4-5': 200000,
  'claude': 200000,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-5': 200000,
  'o1': 200000,
  'o3': 200000,
  'o4': 200000,
  'gemini-2': 1000000,
  'gemini-1.5': 1000000,
  'llama-3.3': 128000,
  'llama3.3': 128000,
  'llama-3.1': 128000,
  'llama3.1': 128000,
  'llama-3': 8192,
  'llama3': 8192,
  'llama2': 4096,
  'mistral-large': 128000,
  'mixtral': 32000,
  'mistral': 32000,
  'codellama': 16384,
  'deepseek-coder': 128000,
  'deepseek': 128000,
  'phi-4': 128000,
  'phi-3': 128000,
  'qwen3': 128000,
  'qwen2': 128000,
  'qwen': 32000,
  'gemma': 8192,
  'gemma2': 8192,
  'command-r': 128000,
  'starcoder': 8192,
  // AWS Bedrock model IDs
  'anthropic.claude': 200000,
  'amazon.titan-text-premier': 32000,
  'amazon.titan-text-express': 8192,
  'meta.llama3': 128000,
  'mistral.mistral-large': 128000,
  'cohere.command-r': 128000,
};

/**
 * Get context limit for a model - uses cached model info first, falls back to defaults
 */
export function getModelContextLimit(provider: LLMProvider, modelId: string): number {
  // First check cached model info from API
  const modelInfo = getModelInfo(provider, modelId);
  if (modelInfo?.contextLength) {
    return modelInfo.contextLength;
  }

  // Fall back to defaults based on model family (sort by key length desc for most specific match)
  const lowerModel = modelId.toLowerCase();
  const sortedEntries = Object.entries(DEFAULT_CONTEXT_LIMITS)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [key, limit] of sortedEntries) {
    if (lowerModel.includes(key.toLowerCase())) {
      return limit;
    }
  }

  // Ultimate fallback
  return 32000;
}

/**
 * Default max OUTPUT tokens by model family (fallback when the API doesn't
 * report it). Replaces the old global 8192 cap so modern models can use their
 * real output ceiling. Unknown models fall through to a conservative 8192.
 */
const DEFAULT_MAX_OUTPUT: Record<string, number> = {
  'claude-fable-5': 128000,
  'claude-opus-4-8': 128000,
  'claude-opus-4-7': 128000,
  'claude-opus-4-6': 128000,
  'claude-sonnet-4-6': 64000,
  'claude-haiku-4-5': 64000,
  'claude': 8192,
  'gpt-5': 128000,
  'o1': 100000,
  'o3': 100000,
  'gpt-4o': 16384,
  'gpt-4': 8192,
  'gemini-2': 8192,
  'gemini-1.5': 8192,
};

/**
 * Get the max output-token ceiling for a model - cached API info first, then
 * family fallback. Conservative 8192 default keeps unknown/local models safe.
 */
export function getModelMaxOutput(provider: LLMProvider, modelId: string): number {
  const modelInfo = getModelInfo(provider, modelId);
  if (modelInfo?.maxOutputTokens) {
    return modelInfo.maxOutputTokens;
  }
  const lowerModel = modelId.toLowerCase();
  const sortedEntries = Object.entries(DEFAULT_MAX_OUTPUT)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [key, limit] of sortedEntries) {
    if (lowerModel.includes(key.toLowerCase())) {
      return limit;
    }
  }
  return 8192;
}
