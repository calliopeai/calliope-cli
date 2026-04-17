/**
 * Calliope CLI - Model Detection
 *
 * Auto-detects available models for each provider and provides interactive selection.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { select } from '@inquirer/prompts';
import * as config from './config.js';
import type { LLMProvider } from './types.js';

const DEBUG = process.env.CALLIOPE_DEBUG === '1';

interface ModelFetchOptions {
  quiet?: boolean;
  /** Rethrow the underlying error instead of returning []. Use for interactive
   *  flows (like /model) where the user should see the real reason. */
  throwOnError?: boolean;
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
  huggingface: 'https://api-inference.huggingface.co/v1',
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
const modelCache = new Map<LLMProvider, { models: ModelInfo[]; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  pricing?: {
    input?: number;
    output?: number;
  };
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
    const inputPrice = model.pricing.input ? `$${model.pricing.input.toFixed(2)}/1M` : '';
    const outputPrice = model.pricing.output ? `$${model.pricing.output.toFixed(2)}/1M` : '';
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
export async function getAvailableModels(provider: LLMProvider, options: ModelFetchOptions = {}): Promise<ModelInfo[]> {
  // Check cache first
  const cached = modelCache.get(provider);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.models;
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

    // Cache the results
    modelCache.set(provider, { models, timestamp: Date.now() });
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
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as { data: Array<{ id: string; display_name?: string; created_at?: string }> };

    return data.data
      .filter(model => model.id.startsWith('claude'))
      .map(model => ({
        id: model.id,
        name: model.display_name || formatModelName(model.id),
        description: getAnthropicModelDescription(model.id),
        contextLength: 200000,
      }))
      .sort((a, b) => b.id.localeCompare(a.id)); // Newest first
  } catch (error) {
    // Fallback to known models if API fails
    logModelDetectionWarning('Failed to fetch Anthropic models, using fallback list', error, options);
    return [
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', description: 'Most capable model', contextLength: 200000 },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', description: 'Balanced intelligence and speed', contextLength: 200000 },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', description: 'Previous gen flagship', contextLength: 200000 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', description: 'Fast and affordable', contextLength: 200000 },
    ];
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
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);

    if (!response.ok) {
      throw new Error(`Google API error: ${response.status}`);
    }

    const data = await response.json() as { models: Array<{ name: string; displayName?: string; description?: string; inputTokenLimit?: number }> };

    return data.models
      .filter(model => {
        const modelId = model.name.replace('models/', '');
        return model.name.includes('gemini') && isCompatibleModel(modelId, 'google');
      })
      .map(model => ({
        id: model.name.replace('models/', ''),
        name: model.displayName || model.name.replace('models/', ''),
        description: model.description || 'Google Gemini model',
        contextLength: model.inputTokenLimit || 1048576,
      }))
      .sort((a, b) => b.id.localeCompare(a.id)); // Newest first
  } catch (error) {
    // Fallback to known models if API fails
    logModelDetectionWarning('Failed to fetch Google models, using fallback list', error, options);
    return [
      { id: 'gemini-2.5-pro-preview-06-05', name: 'Gemini 2.5 Pro', description: 'Most capable', contextLength: 1048576 },
      { id: 'gemini-2.5-flash-preview-05-20', name: 'Gemini 2.5 Flash', description: 'Fast next-gen', contextLength: 1048576 },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: 'Multimodal', contextLength: 1048576 },
      { id: 'gemini-1.5-pro-latest', name: 'Gemini 1.5 Pro', description: 'Complex reasoning', contextLength: 2097152 },
      { id: 'gemini-1.5-flash-latest', name: 'Gemini 1.5 Flash', description: 'Fast and versatile', contextLength: 1048576 },
    ];
  }
}

/**
 * Get OpenAI models
 */
async function getOpenAIModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const client = new OpenAI({ apiKey });
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
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get OpenRouter models
 */
async function getOpenRouterModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('openrouter');
  if (!apiKey) throw new Error('OpenRouter API key not configured');

  const response = await fetch('https://openrouter.ai/api/v1/models', {
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
      pricing?: { prompt?: string; completion?: string };
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
      contextLength: model.context_length,
      pricing: {
        input: parseFloat(model.pricing?.prompt || '0') * 1000000, // Convert to per 1M tokens
        output: parseFloat(model.pricing?.completion || '0') * 1000000
      }
    }));
}

/**
 * Get Together models
 */
async function getTogetherModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('together');
  if (!apiKey) throw new Error('Together API key not configured');

  // Together's API returns a raw array, not wrapped in { data: [...] } like OpenAI
  const response = await fetch('https://api.together.xyz/v1/models', {
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
      contextLength: model.context_length,
      pricing: model.pricing ? {
        input: model.pricing.input,
        output: model.pricing.output,
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
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1'
  });

  const response = await client.models.list();
  return response.data
    .filter(model => isCompatibleModel(model.id, 'groq'))
    .map(model => ({
      id: model.id,
      name: model.id,
      description: 'High-speed inference model',
    }));
}

/**
 * Get Mistral models
 */
async function getMistralModels(): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey('mistral');
  if (!apiKey) throw new Error('Mistral API key not configured');

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.mistral.ai/v1'
  });

  const response = await client.models.list();
  return response.data
    .filter(model => isCompatibleModel(model.id, 'mistral'))
    .map(model => ({
      id: model.id,
      name: model.id,
      description: getMistralModelDescription(model.id),
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
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json() as { models: Array<{ name: string; size: number; details?: { parameter_size?: string; family?: string } }> };
    const models = data.models.filter(model => isCompatibleModel(model.name, 'ollama'));

    // Query actual num_ctx for each model via /api/show
    const results: ModelInfo[] = [];
    for (const model of models) {
      let contextLength: number | undefined;
      try {
        const showResp = await fetch(`${baseUrl}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model.name }),
        });
        if (showResp.ok) {
          const showData = await showResp.json() as {
            model_info?: Record<string, unknown>;
            parameters?: string;
          };
          // Check model_info for context length keys
          if (showData.model_info) {
            const ctxKey = Object.keys(showData.model_info).find(k =>
              k.includes('context_length') || k.includes('context_window')
            );
            if (ctxKey && typeof showData.model_info[ctxKey] === 'number') {
              contextLength = showData.model_info[ctxKey] as number;
            }
          }
          // Also check Modelfile parameters for num_ctx override
          if (showData.parameters) {
            const numCtxMatch = showData.parameters.match(/num_ctx\s+(\d+)/);
            if (numCtxMatch) {
              contextLength = parseInt(numCtxMatch[1], 10);
            }
          }
        }
      } catch {
        // Skip — we'll use the default context limit
      }

      results.push({
        id: model.name,
        name: model.name,
        description: `Size: ${formatSize(model.size)}${model.details?.parameter_size ? ` (${model.details.parameter_size})` : ''}`,
        contextLength,
      });
    }

    return results;
  } catch (error) {
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
    return models[0].id;
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
    const response = await fetch(`${baseUrl}/v1/models`);
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
      }));
  } catch (error) {
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
    const response = await fetch(modelsUrl, { headers });
    if (response.ok) {
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data
        .filter(model => isCompatibleModel(model.id, 'bedrock'))
        .map(model => ({
          id: model.id,
          name: model.id,
          description: getBedrockModelDescription(model.id),
          contextLength: getBedrockContextLength(model.id),
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
    let output = '';
    try {
      output = execFileSync(
        'aws',
        ['configure', 'export-credentials', '--profile', profile, '--format', 'env-no-export'],
        { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch {
      output = execFileSync(
        'aws',
        ['configure', 'export-credentials', '--profile', profile, '--format', 'env'],
        { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }
    const envs: Record<string, string> = {};
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      const match = line.match(/^(?:export\s+)?([A-Z_]+)\s*=\s*(.+)$/);
      if (!match) continue;
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      envs[match[1]] = val;
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
  const profile = process.env.AWS_PROFILE || config.get('awsProfile') || 'default';

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
        section = secMatch[1].replace(/^profile\s+/, '');
        sections[section] = sections[section] || {};
        continue;
      }
      const kvMatch = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
      if (kvMatch && section) sections[section][kvMatch[1].trim()] = kvMatch[2].trim();
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

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || config.get('awsRegion') || 'us-east-1';
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
    const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k].trim()}`).join('\n') + '\n';
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
    return fetch(url, { headers });
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
    }>;
  };

  const foundationModels: ModelInfo[] = (foundationData.modelSummaries || [])
    .filter(m => m.inputModalities?.includes('TEXT') && m.outputModalities?.includes('TEXT'))
    .filter(m => bedrockSupportsConverseTools(m.modelId))
    .map(m => ({
      id: m.modelId,
      name: m.modelName || m.modelId,
      description: `${m.providerName || 'Unknown'} — ${getBedrockModelDescription(m.modelId)}`,
      contextLength: getBedrockContextLength(m.modelId),
    }));

  // 2. ListInferenceProfiles — cross-region profile IDs (e.g. us.anthropic.claude-sonnet-4-5-*).
  // Many modern models are ONLY reachable via these, not direct foundation-model IDs.
  // Failures here are non-fatal (older accounts / regions may not support it).
  let profileModels: ModelInfo[] = [];
  try {
    const profileResp = await signedGet('/inference-profiles', '');
    if (profileResp.ok) {
      const profileData = await profileResp.json() as {
        inferenceProfileSummaries?: Array<{
          inferenceProfileId: string;
          inferenceProfileName?: string;
          status?: string;
          type?: string;
        }>;
      };
      profileModels = (profileData.inferenceProfileSummaries || [])
        .filter(p => p.status !== 'INACTIVE')
        .filter(p => bedrockSupportsConverseTools(p.inferenceProfileId))
        .map(p => ({
          id: p.inferenceProfileId,
          name: p.inferenceProfileName || p.inferenceProfileId,
          description: `Inference profile — ${getBedrockModelDescription(p.inferenceProfileId)}`,
          contextLength: getBedrockContextLength(p.inferenceProfileId),
        }));
    }
  } catch {
    // Non-fatal — foundation models alone is still useful.
  }

  // Merge. For every inference profile, strip the region prefix (e.g. `us.`,
  // `eu.`, `apac.`, `jp.`) to get the base foundation-model ID it wraps, and
  // drop that base from the foundation list — because newer Claude 4.x / Haiku
  // 4.5 models can ONLY be invoked via their inference profile on on-demand
  // throughput. Showing both would let users pick the invokable-broken raw ID.
  const coveredBaseIds = new Set<string>();
  for (const p of profileModels) {
    const base = p.id.replace(/^[a-z]{2,5}\./, '');
    if (base !== p.id) coveredBaseIds.add(base);
  }
  const filteredFoundation = foundationModels.filter(m => !coveredBaseIds.has(m.id));

  const merged = new Map<string, ModelInfo>();
  for (const m of filteredFoundation) merged.set(m.id, m);
  for (const m of profileModels) merged.set(m.id, m);
  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Bedrock Converse API tool-calling support. Maintained as a local allowlist
 * because AWS doesn't expose per-model tool capability via the list APIs.
 * See: https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html
 * Matches both raw foundation model IDs (e.g. anthropic.claude-3-5-sonnet-*)
 * and cross-region inference profile IDs (e.g. us.anthropic.claude-sonnet-4-5-*).
 */
function bedrockSupportsConverseTools(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // Anthropic Claude 3, 3.5, 3.7, 4, 4.5 (all support tools). Excludes Claude 2.x / Instant.
  if (/anthropic\.claude-(3|opus-4|sonnet-4|haiku-4|3-5|3-7)/.test(id)) return true;
  // Amazon Nova (Pro / Lite / Micro support Converse tools; Nova Canvas/Reel are image models — excluded)
  if (/amazon\.nova-(pro|lite|micro|premier)/.test(id)) return true;
  // Cohere Command R / R+ support tools (older Command models do not)
  if (/cohere\.command-r/.test(id)) return true;
  // Mistral Large (2402, 2407), Pixtral Large, Mistral Small, Nemo
  if (/mistral\.(mistral-large|pixtral|mistral-small|mistral-nemo)/.test(id)) return true;
  // Meta Llama 3.1+ supports tools via Converse (3.0 and earlier do not)
  if (/meta\.llama(3-1|3-2|3-3|4)/.test(id)) return true;
  // AI21 Jamba 1.5 supports tools
  if (/ai21\.jamba-1-5/.test(id)) return true;
  // DeepSeek R1 supports tools
  if (/deepseek\.r1/.test(id)) return true;
  return false;
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

function getBedrockContextLength(modelId: string): number {
  if (modelId.includes('claude')) return 200000;
  if (modelId.includes('llama3-1') || modelId.includes('llama3.1')) return 128000;
  if (modelId.includes('mistral-large')) return 128000;
  if (modelId.includes('command-r')) return 128000;
  if (modelId.includes('titan-text-premier')) return 32000;
  if (modelId.includes('titan-text-express')) return 8192;
  return 32000;
}

/**
 * Get models from a generic OpenAI-compatible server (e.g. LM Studio, Jan, LocalAI, vLLM)
 */
async function getOpenAICompatModels(): Promise<ModelInfo[]> {
  let baseUrl = config.getBaseUrl('openai-compat') || 'http://localhost:1234';
  if (!baseUrl.endsWith('/v1')) baseUrl = `${baseUrl}/v1`;
  const apiKey = config.getApiKey('openai-compat') || 'openai-compat';

  const response = await fetch(`${baseUrl}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compat server error: ${response.status}`);
  }

  const data = await response.json() as { data?: Array<{ id: string }> };
  const models = data.data ?? [];
  return models.map(m => ({ id: m.id, name: m.id, description: 'OpenAI-compatible server' }));
}

/**
 * Get models for OpenAI-compatible providers
 */
async function getOpenAICompatibleModels(provider: LLMProvider): Promise<ModelInfo[]> {
  const apiKey = config.getApiKey(provider);
  if (!apiKey) throw new Error(`${provider} API key not configured`);

  const baseURL = PROVIDER_BASE_URLS[provider];
  if (!baseURL) throw new Error(`Unknown provider: ${provider}`);

  const client = new OpenAI({ apiKey, baseURL });
  const response = await client.models.list();

  return response.data
    .filter(model => isCompatibleModel(model.id, provider))
    .map(model => ({
      id: model.id,
      name: model.id,
    }));
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
  } else {
    modelCache.clear();
  }
}

/**
 * Pre-warm model cache for configured providers
 * Runs in background, doesn't block startup
 */
export async function preWarmModelCache(): Promise<void> {
  const configuredProviders = config.getConfiguredProviders();

  // Fetch models for all configured providers in parallel
  await Promise.allSettled(
    configuredProviders.map(provider => getAvailableModels(provider, { quiet: true }))
  );
}

/**
 * Get model info from cache by ID
 */
export function getModelInfo(provider: LLMProvider, modelId: string): ModelInfo | undefined {
  const cached = modelCache.get(provider);
  if (!cached) return undefined;
  return cached.models.find(m => m.id === modelId || m.id.includes(modelId) || modelId.includes(m.id));
}

/**
 * Default context limits by model family (fallback when API doesn't provide it)
 */
const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
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
