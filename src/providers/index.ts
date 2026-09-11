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
import { cancellable, throwIfCancelled } from '../cancellation.js';
import { HealthStore, providerTarget, summarizeHealth, healthFailure, healthOutcome, type HealthProvider } from '../health/index.js';
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
  if (config.getApiKey('huggingface')) providers.push('huggingface');
  if (config.getBaseUrl('litellm')) providers.push('litellm');
  if (config.getBaseUrl('openai-compat')) providers.push('openai-compat');
  if (config.getApiKey('deepseek')) providers.push('deepseek');
  if (config.getApiKey('xai')) providers.push('xai');
  if (config.getApiKey('cerebras')) providers.push('cerebras');
  if (config.getApiKey('bedrock') || config.getBaseUrl('bedrock') || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || nativeBedrockConfigured()) providers.push('bedrock');

  return providers;
}

function nativeBedrockConfigured(): boolean {
  try { const target = providerTarget('bedrock'); return target.protocol === 'bedrock-converse' && target.credentials === 'configured'; }
  catch { return false; }
}

let healthHistoryWarningShown = false;
function healthHistoryWarning(warn?: (message: string) => void): void {
  if (warn) warn('Provider health history is unavailable; run calliope doctor to inspect or restore it.');
  else if (!healthHistoryWarningShown) {
    healthHistoryWarningShown = true;
    process.stderr.write('Provider health history is unavailable; run calliope doctor to inspect or restore it.\n');
  }
}
function quarantined(provider: LLMProvider): boolean {
  try {
    const store = new HealthStore(), target = providerTarget(provider as HealthProvider);
    return summarizeHealth(store.read(), target, store.settings).quarantine.active;
  } catch { healthHistoryWarning(); return false; }
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
  if (provider === 'ai21') {
    return 'ai21 is retired: the AI21 Studio API was sunset on August 9, 2026. Remove the provider or migrate to a supported endpoint such as Hugging Face, Together, or an explicitly configured OpenAI-compatible gateway.';
  }
  const { apiKey, baseUrl } = config.getProviderEnvVars(provider);
  if (provider === 'ollama' || provider === 'litellm' || provider === 'openai-compat') {
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
    if (preferred === 'ai21') throw new ProviderUnavailableError(preferred, unavailableMessage(preferred));
    // For Ollama/LiteLLM, check base URL instead of API key
    if (preferred === 'ollama' || preferred === 'litellm' || preferred === 'openai-compat') {
      if (config.getBaseUrl(preferred)) return preferred;
    } else if (preferred === 'bedrock') {
      if (config.getApiKey('bedrock') || config.getBaseUrl('bedrock') || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || nativeBedrockConfigured()) return preferred;
    } else {
      const key = config.getApiKey(preferred);
      if (key) return preferred;
    }
    // Explicitly requested but unconfigured: never silently switch providers.
    throw new ProviderUnavailableError(preferred, unavailableMessage(preferred));
  }

  // Auto-select: prefer Anthropic > OpenAI > Google > others
  const priority: LLMProvider[] = ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'cerebras', 'mistral', 'openrouter', 'together', 'groq', 'fireworks', 'huggingface', 'bedrock', 'ollama', 'litellm', 'openai-compat'];

  const available = getAvailableProviders();
  for (const p of priority) if (available.includes(p) && !quarantined(p)) return p;

  throw new Error('No API keys configured or all available providers are quarantined. Run `calliope --setup` or `calliope doctor`.');
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
  throwIfCancelled(options?.signal);
  const actualProvider = selectProvider(provider);
  const actualModel = model || DEFAULT_MODELS[actualProvider];
  let health: { store: HealthStore; target: ReturnType<typeof providerTarget> } | undefined;
  let quarantineHalt: string | undefined;
  try {
    const store = new HealthStore(), target = providerTarget(actualProvider as HealthProvider);
    health = { store, target };
    const quarantine = summarizeHealth(store.read(), target, store.settings).quarantine;
    if (quarantine.active) {
      const automatic = options?.selectionMode === 'auto' || provider === 'auto';
      const message = `${actualProvider} is quarantined after ${quarantine.failures} failures (${quarantine.reason}) until ${quarantine.expiresAt}; ${automatic ? 'automatic inference stopped before dispatch' : 'honoring your explicit selection for a recovery attempt'}.`;
      if (automatic) quarantineHalt = message;
      if (options?.onHealthWarning) {
        if (automatic) options.onHealthWarning(message, true);
        else options.onHealthWarning(message);
      }
      else process.stderr.write(message + '\n');
    }
  } catch { healthHistoryWarning(options?.onHealthWarning); }
  if (quarantineHalt) throw new Error(quarantineHalt);
  const callback = onToken;
  if (callback && options?.signal) onToken = token => { if (!options.signal!.aborted) callback(token); };

  // Local backends see a simplified (but execution-lossless) tool schema:
  // first-sentence descriptions, capped enums, and the edit_file anchor_hash
  // param. Cloud providers get the full schema unchanged. This is the single
  // seam for feature 1 — provider functions just serialize whatever they get.
  const backendTools = isLocalBackend(actualProvider) ? simplifyToolsForLocal(tools) : tools;

  const doChat = async (): Promise<LLMResponse> => {
    throwIfCancelled(options?.signal);
    let response: LLMResponse;
    switch (actualProvider) {
      case 'anthropic':
        response = await chatAnthropic(messages, backendTools, actualModel, onToken, options?.signal);
        break;
      case 'google':
        response = await chatGoogle(messages, backendTools, actualModel, onToken, options?.signal);
        break;
      case 'openai':
        response = await chatOpenAI(messages, backendTools, actualModel, onToken, options?.signal);
        break;
      case 'openrouter':
      case 'together':
      case 'groq':
      case 'fireworks':
      case 'mistral':
      case 'ai21':
      case 'huggingface':
      case 'deepseek':
      case 'xai':
      case 'cerebras':
        response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken, options?.signal);
        break;
      case 'ollama':
        response = await chatOllama(messages, backendTools, actualModel, onToken, options);
        break;
      case 'litellm':
      case 'openai-compat':
        response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken, options?.signal);
        break;
      case 'bedrock': {
        const bedrockBase = config.getBaseUrl('bedrock');
        if (bedrockBase) {
          // Gateway/proxy mode (existing)
          response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken, options?.signal);
        } else {
          // Native AWS mode
          response = await chatBedrock(messages, backendTools, actualModel, onToken, options?.signal);
        }
        break;
      }
      default:
        throw new Error(`Provider ${actualProvider} not implemented`);
    }
    // Validate and sanitize response before returning
    throwIfCancelled(options?.signal);
    return validateLLMResponse(response);
  };

  // Wrap with retry logic
  let attempt = 0;
  const observedChat = async (): Promise<LLMResponse> => {
    const started = Date.now(), retryIndex = attempt++;
    const record = (observation: Omit<import('../health/types.js').HealthObservation, 'provider' | 'target' | 'type'>) => {
      if (!health) return;
      try { health.store.append({ provider: health.target.provider, target: health.target.key, type: 'attempt',
        durationMs: Math.max(0, Math.min(86400000, Date.now() - started)), retryIndex, ...observation }); }
      catch { healthHistoryWarning(options?.onHealthWarning); }
    };
    try {
      const response = await cancellable(doChat(), options?.signal);
      const usage = response.usage;
      record({ outcome: response.finishReason === 'error' ? 'error' : 'success',
        ...(response.finishReason === 'error' ? { failure: 'response' as const } : {}),
        capabilities: {
          ...(response.toolCalls?.length ? { tools: true } : {}),
          ...(onToken ? { streaming: true } : {}),
          usage: !!usage && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0,
        } });
      return response;
    } catch (error) {
      const outcome = healthOutcome(error, options?.signal);
      record({ outcome, ...(outcome === 'cancelled' ? { capabilities: { cancellation: true } } : { ...healthFailure(error), ...(outcome === 'timeout' ? { failure: 'timeout' as const } : {}) }) });
      throw error;
    }
  };
  return withRetry(observedChat, {
    signal: options?.signal,
    maxRetries: 2,
    initialDelayMs: 1000,
    onRetry: onRetry,
  });
}

// Re-export everything from sub-modules for public API
export { needsSummarization, getContextHealth, estimateContextUsage } from './types.js';
export type { StreamCallback, RetryCallback, ChatOptions } from './types.js';
export { requiresResponsesAPI, toResponsesInput, toResponsesTools } from './openai.js';
