/**
 * Provider Module - Entry Point
 *
 * Provider selection, routing, and re-exports.
 */

import * as config from '../config.js';
import { withRetry } from '../errors.js';
import type { Message, Tool, LLMResponse, LLMProvider } from '../types.js';
import { DEFAULT_MODELS } from '../types.js';
import { validateLLMResponse, type StreamCallback, type RetryCallback } from './types.js';
import { chatAnthropic } from './anthropic.js';
import { chatGoogle } from './google.js';
import { chatOpenAI } from './openai.js';
import { chatOpenAICompatible } from './compat.js';

/**
 * Get available providers based on configured API keys
 */
export function getAvailableProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];

  if (config.getApiKey('anthropic')) providers.push('anthropic');
  if (config.getApiKey('google')) providers.push('google');
  if (config.getApiKey('openai')) providers.push('openai');
  if (config.getApiKey('openrouter')) providers.push('openrouter');
  if (config.getApiKey('together')) providers.push('together');
  if (config.getApiKey('groq')) providers.push('groq');
  if (config.getApiKey('mistral')) providers.push('mistral');
  if (config.getBaseUrl('ollama')) providers.push('ollama');
  if (config.getApiKey('ai21')) providers.push('ai21');
  if (config.getApiKey('huggingface')) providers.push('huggingface');
  if (config.getBaseUrl('litellm')) providers.push('litellm');

  return providers;
}

/**
 * Select the best available provider
 */
export function selectProvider(preferred: LLMProvider): LLMProvider {
  if (preferred !== 'auto') {
    // For Ollama/LiteLLM, check base URL instead of API key
    if (preferred === 'ollama' || preferred === 'litellm') {
      if (config.getBaseUrl(preferred)) return preferred;
    } else {
      const key = config.getApiKey(preferred);
      if (key) return preferred;
    }
  }

  // Auto-select: prefer Anthropic > OpenAI > Google > others
  const priority: LLMProvider[] = ['anthropic', 'openai', 'google', 'mistral', 'openrouter', 'together', 'groq', 'ollama', 'litellm'];

  for (const p of priority) {
    if (p === 'ollama' || p === 'litellm') {
      if (config.getBaseUrl(p)) return p;
    } else if (config.getApiKey(p)) {
      return p;
    }
  }

  throw new Error('No API keys configured. Run `calliope --setup` to configure.');
}

/**
 * Chat with the selected provider (with automatic retry)
 */
export async function chat(
  provider: LLMProvider,
  messages: Message[],
  tools: Tool[],
  model?: string,
  onToken?: StreamCallback,
  onRetry?: RetryCallback
): Promise<LLMResponse> {
  const actualProvider = selectProvider(provider);
  const actualModel = model || DEFAULT_MODELS[actualProvider];

  const doChat = async (): Promise<LLMResponse> => {
    let response: LLMResponse;
    switch (actualProvider) {
      case 'anthropic':
        response = await chatAnthropic(messages, tools, actualModel, onToken);
        break;
      case 'google':
        response = await chatGoogle(messages, tools, actualModel);
        break;
      case 'openai':
        response = await chatOpenAI(messages, tools, actualModel, onToken);
        break;
      case 'openrouter':
      case 'together':
      case 'groq':
      case 'fireworks':
      case 'mistral':
      case 'ai21':
      case 'huggingface':
      case 'ollama':
      case 'litellm':
        response = await chatOpenAICompatible(actualProvider, messages, tools, actualModel, onToken);
        break;
      default:
        throw new Error(`Provider ${actualProvider} not implemented`);
    }
    // Validate and sanitize response before returning
    return validateLLMResponse(response);
  };

  // Wrap with retry logic
  return withRetry(doChat, {
    maxRetries: 2,
    initialDelayMs: 1000,
    onRetry: onRetry,
  });
}

// Re-export everything from sub-modules for public API
export { needsSummarization, getContextHealth, estimateContextUsage } from './types.js';
export type { StreamCallback, RetryCallback } from './types.js';
export { requiresResponsesAPI, toResponsesInput, toResponsesTools } from './openai.js';
