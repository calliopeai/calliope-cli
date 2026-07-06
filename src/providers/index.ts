/**
 * Provider Module - Entry Point
 *
 * Provider selection, routing, and re-exports.
 */

import * as config from '../config.js';
import { withRetry } from '../errors.js';
import type { Message, Tool, LLMResponse, LLMProvider } from '../types.js';
import { DEFAULT_MODELS } from '../types.js';
import { validateLLMResponse, type StreamCallback, type RetryCallback, type ChatOptions } from './types.js';
import { isLocalBackend, simplifyToolsForLocal } from '../local-model.js';
import { chatAnthropic } from './anthropic.js';
import { chatGoogle } from './google.js';
import { chatOpenAI } from './openai.js';
import { chatOpenAICompatible } from './compat.js';
import { chatOllama } from './ollama.js';
import { chatBedrock } from './bedrock.js';

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
  if (config.getApiKey('fireworks')) providers.push('fireworks');
  if (config.getApiKey('mistral')) providers.push('mistral');
  if (config.getBaseUrl('ollama')) providers.push('ollama');
  if (config.getApiKey('ai21')) providers.push('ai21');
  if (config.getApiKey('huggingface')) providers.push('huggingface');
  if (config.getBaseUrl('litellm')) providers.push('litellm');
  if (config.getApiKey('bedrock') || config.getBaseUrl('bedrock') || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) providers.push('bedrock');

  return providers;
}

/**
 * Thrown by selectProvider when an explicitly-chosen provider (i.e. not 'auto')
 * has no usable credential. Carries the provider plus a message listing concrete
 * fix steps. Exported so callers can catch it and surface the fix rather than
 * crash or silently switch to a different provider (#217).
 */
export class ProviderUnavailableError extends Error {
  readonly provider: LLMProvider;
  constructor(provider: LLMProvider, message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
  }
}

/** Join fix clauses as "a, b, or c" (Oxford-style, single element passes through). */
function joinFixes(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

/** Build the actionable "how to fix" message for an unconfigured provider. */
function unavailableMessage(provider: LLMProvider): string {
  const { apiKey, baseUrl } = config.getProviderEnvVars(provider);
  if (provider === 'ollama' || provider === 'litellm') {
    const fixes = ['calliope --setup', `/config set providers.${provider}.baseUrl <url>`];
    if (baseUrl) fixes.push(`export ${baseUrl}`);
    return `${provider} is selected but has no base URL. Fix: ${joinFixes(fixes)}.`;
  }
  if (provider === 'bedrock') {
    const fixes = ['calliope --setup', 'set AWS_PROFILE or AWS_ACCESS_KEY_ID', '/config set providers.bedrock.apiKey <key>'];
    return `bedrock is selected but has no AWS credentials. Fix: ${joinFixes(fixes)}.`;
  }
  const fixes = ['calliope --setup', `/config set providers.${provider}.apiKey <key>`];
  if (apiKey) fixes.push(`export ${apiKey}`);
  return `${provider} is selected but has no API key. Fix: ${joinFixes(fixes)}.`;
}

/**
 * Select the provider to serve a request.
 *
 * An explicit provider ('anthropic', 'openai', …) is honored only if it has a
 * usable credential; otherwise this throws ProviderUnavailableError rather than
 * silently falling through to a different provider (#217). Only 'auto' walks the
 * priority list and falls back.
 */
export function selectProvider(preferred: LLMProvider): LLMProvider {
  if (preferred !== 'auto') {
    // For Ollama/LiteLLM, check base URL instead of API key
    if (preferred === 'ollama' || preferred === 'litellm') {
      if (config.getBaseUrl(preferred)) return preferred;
    } else if (preferred === 'bedrock') {
      if (config.getApiKey('bedrock') || config.getBaseUrl('bedrock') || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return preferred;
    } else {
      const key = config.getApiKey(preferred);
      if (key) return preferred;
    }
    // Explicitly requested but unconfigured: never silently switch providers.
    throw new ProviderUnavailableError(preferred, unavailableMessage(preferred));
  }

  // Auto-select: prefer Anthropic > OpenAI > Google > others
  const priority: LLMProvider[] = ['anthropic', 'openai', 'google', 'mistral', 'openrouter', 'together', 'groq', 'fireworks', 'ai21', 'huggingface', 'bedrock', 'ollama', 'litellm'];

  for (const p of priority) {
    if (p === 'ollama' || p === 'litellm') {
      if (config.getBaseUrl(p)) return p;
    } else if (p === 'bedrock') {
      if (config.getApiKey('bedrock') || config.getBaseUrl('bedrock') || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return p;
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
  onRetry?: RetryCallback,
  options?: ChatOptions
): Promise<LLMResponse> {
  const actualProvider = selectProvider(provider);
  const actualModel = model || DEFAULT_MODELS[actualProvider];

  // Local backends see a simplified (but execution-lossless) tool schema:
  // first-sentence descriptions, capped enums, and the edit_file anchor_hash
  // param. Cloud providers get the full schema unchanged. This is the single
  // seam for feature 1 — provider functions just serialize whatever they get.
  const backendTools = isLocalBackend(actualProvider) ? simplifyToolsForLocal(tools) : tools;

  const doChat = async (): Promise<LLMResponse> => {
    let response: LLMResponse;
    switch (actualProvider) {
      case 'anthropic':
        response = await chatAnthropic(messages, backendTools, actualModel, onToken);
        break;
      case 'google':
        response = await chatGoogle(messages, backendTools, actualModel, onToken);
        break;
      case 'openai':
        response = await chatOpenAI(messages, backendTools, actualModel, onToken);
        break;
      case 'openrouter':
      case 'together':
      case 'groq':
      case 'fireworks':
      case 'mistral':
      case 'ai21':
      case 'huggingface':
        response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken);
        break;
      case 'ollama':
        response = await chatOllama(messages, backendTools, actualModel, onToken, options);
        break;
      case 'litellm':
        response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken);
        break;
      case 'bedrock': {
        const bedrockBase = config.getBaseUrl('bedrock');
        if (bedrockBase) {
          // Gateway/proxy mode (existing)
          response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken);
        } else {
          // Native AWS mode
          response = await chatBedrock(messages, backendTools, actualModel, onToken);
        }
        break;
      }
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
export type { StreamCallback, RetryCallback, ChatOptions } from './types.js';
export { requiresResponsesAPI, toResponsesInput, toResponsesTools } from './openai.js';
