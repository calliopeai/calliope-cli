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

// API base URLs for OpenAI-compatible providers
const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  mistral: 'https://api.mistral.ai/v1',
  ai21: 'https://api.ai21.com/studio/v1',
  huggingface: 'https://api-inference.huggingface.co/v1',
};

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
export async function getAvailableModels(provider: LLMProvider): Promise<ModelInfo[]> {
  // Check cache first
  const cached = modelCache.get(provider);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.models;
  }

  let models: ModelInfo[] = [];

  try {
    switch (provider) {
      case 'anthropic':
        models = await getAnthropicModels();
        break;
      case 'google':
        models = await getGoogleModels();
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
      default:
        throw new Error(`Model detection not implemented for ${provider}`);
    }

    // Cache the results
    modelCache.set(provider, { models, timestamp: Date.now() });
  } catch (error) {
    console.warn(`Failed to fetch models for ${provider}:`, error);
  }

  return models;
}

/**
 * Get Anthropic models dynamically from API
 */
async function getAnthropicModels(): Promise<ModelInfo[]> {
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
    console.warn('Failed to fetch Anthropic models, using fallback list');
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
async function getGoogleModels(): Promise<ModelInfo[]> {
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
      .filter(model => model.name.includes('gemini'))
      .map(model => ({
        id: model.name.replace('models/', ''),
        name: model.displayName || model.name.replace('models/', ''),
        description: model.description || 'Google Gemini model',
        contextLength: model.inputTokenLimit || 1048576,
      }))
      .sort((a, b) => b.id.localeCompare(a.id)); // Newest first
  } catch (error) {
    // Fallback to known models if API fails
    console.warn('Failed to fetch Google models, using fallback list');
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
  
  return response.data
    .filter(model => model.id.includes('gpt') || model.id.includes('o1'))
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

  const data = await response.json() as { data: Array<{ id: string; name: string; description?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }> };
  return data.data.map((model) => ({
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

  const client = new OpenAI({ 
    apiKey, 
    baseURL: 'https://api.together.xyz/v1' 
  });
  
  const response = await client.models.list();
  return response.data.map(model => ({
    id: model.id,
    name: model.id,
    description: getTogetherModelDescription(model.id),
  }));
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
  return response.data.map(model => ({
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
  return response.data.map(model => ({
    id: model.id,
    name: model.id,
    description: getMistralModelDescription(model.id),
  }));
}

/**
 * Get Ollama models
 */
async function getOllamaModels(): Promise<ModelInfo[]> {
  const baseUrl = config.getBaseUrl('ollama') || 'http://localhost:11434';
  
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }
    
    const data = await response.json() as { models: Array<{ name: string; size: number }> };
    return data.models.map((model) => ({
      id: model.name,
      name: model.name,
      description: `Size: ${formatSize(model.size)}`,
    }));
  } catch (error) {
    throw new Error(`Failed to connect to Ollama at ${baseUrl}`);
  }
}

/**
 * Get LiteLLM models
 */
async function getLiteLLMModels(): Promise<ModelInfo[]> {
  const baseUrl = config.getBaseUrl('litellm') || 'http://localhost:4000';

  try {
    const response = await fetch(`${baseUrl}/v1/models`);
    if (!response.ok) {
      throw new Error(`LiteLLM API error: ${response.status}`);
    }

    const data = await response.json() as { data: Array<{ id: string }> };
    return data.data.map((model) => ({
      id: model.id,
      name: model.id,
      description: 'Proxied via LiteLLM',
    }));
  } catch (error) {
    throw new Error(`Failed to connect to LiteLLM at ${baseUrl}`);
  }
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
  
  return response.data.map(model => ({
    id: model.id,
    name: model.id,
  }));
}

/**
 * Helper functions for model descriptions
 */
function getOpenAIModelDescription(modelId: string): string {
  if (modelId.includes('gpt-4o')) return 'Flagship model for complex, multi-step tasks';
  if (modelId.includes('gpt-4-turbo')) return 'Previous generation multimodal model';
  if (modelId.includes('gpt-4')) return 'High-intelligence model for complex tasks';
  if (modelId.includes('gpt-3.5-turbo')) return 'Fast, inexpensive model for simple tasks';
  if (modelId.includes('o1')) return 'Reasoning model for complex problems';
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