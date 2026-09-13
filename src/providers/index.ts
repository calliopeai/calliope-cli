/**
 * Provider Module - Entry Point
 *
 * Provider selection, routing, and re-exports.
 */

import * as config from '../config.js';
import { withRetry, StreamProtocolError, ProviderRefusalError } from '../errors.js';
import { ExecutionLimitError } from '../execution/types.js';
import { StreamAttempt, MAX_STREAM_ATTEMPTS } from './stream-attempt.js';
import type { Message, Tool, LLMResponse, LLMProvider } from '../types.js';
import { DEFAULT_MODELS } from '../types.js';
import { validateLLMResponse, type StreamCallback, type RetryCallback, type ChatOptions, type AdapterLimits } from './types.js';
import { cancellable, throwIfCancelled } from '../cancellation.js';
import { HealthStore, providerTarget, summarizeHealth, healthFailure, healthOutcome, type HealthProvider } from '../health/index.js';
import { isLocalBackend, simplifyToolsForLocal } from '../local-model.js';
import { chatAnthropic, countAnthropicInput, assertAnthropicEffort } from './anthropic.js';
import { chatGoogle } from './google.js';
import { chatOpenAI } from './openai.js';
import { chatOpenAICompatible } from './compat.js';
import { openRouterBounds } from './openrouter-bounds.js';
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
  const bounded = !!options?.attemptBudget || !!options?.bounded;
  const maxOutputTokens = options?.maxOutputTokens;
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 100000000) || bounded && maxOutputTokens === undefined)
    throw new ExecutionLimitError('invalid','A bounded provider call requires a positive integer output limit.');
  const limits:AdapterLimits = { maxOutputTokens, bounded, reasoningEffort: options?.reasoningEffort };
  const attemptBudget = options?.attemptBudget;
  const actualProvider = selectProvider(provider);
  const actualModel = model || DEFAULT_MODELS[actualProvider];
  if (bounded && actualProvider === 'openrouter') {
    const ceiling = attemptBudget ? attemptBudget.priceCeiling : options?.priceCeiling;
    openRouterBounds(ceiling);
    limits.priceCeiling = Object.freeze({ ...ceiling! });
  }
  if (limits.reasoningEffort !== undefined && actualProvider !== 'anthropic')
    throw new ExecutionLimitError('authority', 'Explicit reasoning effort is supported only by the native Anthropic adapter.');
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

  // Local backends see a simplified (but execution-lossless) tool schema:
  // first-sentence descriptions, capped enums, and the edit_file anchor_hash
  // param. Cloud providers get the full schema unchanged. This is the single
  // seam for feature 1 — provider functions just serialize whatever they get.
  const backendTools = isLocalBackend(actualProvider) ? simplifyToolsForLocal(tools) : tools;

  const doChat = async (onToken?: StreamCallback): Promise<LLMResponse> => {
    throwIfCancelled(options?.signal);
    let response: LLMResponse;
    switch (actualProvider) {
      case 'anthropic':
        response = await chatAnthropic(messages, backendTools, actualModel, onToken, options?.signal, limits);
        break;
      case 'google':
        response = await chatGoogle(messages, backendTools, actualModel, onToken, options?.signal, limits);
        break;
      case 'openai':
        response = await chatOpenAI(messages, backendTools, actualModel, onToken, options?.signal, limits);
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
        response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken, options?.signal, limits);
        break;
      case 'ollama':
        response = await chatOllama(messages, backendTools, actualModel, onToken, { ...options, ...limits });
        break;
      case 'litellm':
      case 'openai-compat':
        response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken, options?.signal, limits);
        break;
      case 'bedrock': {
        const bedrockBase = config.getBaseUrl('bedrock');
        if (bedrockBase) {
          // Gateway/proxy mode (existing)
          response = await chatOpenAICompatible(actualProvider, messages, backendTools, actualModel, onToken, options?.signal, limits);
        } else {
          // Native AWS mode
          response = await chatBedrock(messages, backendTools, actualModel, onToken, options?.signal, maxOutputTokens);
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
  let lastStream: StreamAttempt | undefined;
  const observedChat = async (): Promise<LLMResponse> => {
    throwIfCancelled(options?.signal);
    const target = attemptBudget ? providerTarget(actualProvider as HealthProvider).key : undefined;
    // Admission errors are not provider failures and must not create a network retry.
    let ticket: string | undefined;
    try {
      if(actualProvider==='anthropic')assertAnthropicEffort(actualModel,limits.reasoningEffort);
      if(attemptBudget?.inputCounting){
        if(actualProvider!=='anthropic')throw new ExecutionLimitError('authority','Input counting is unavailable for this provider protocol.');
        limits.inputCount=await cancellable(countAnthropicInput(messages,backendTools,actualModel,!!onToken,options?.signal,limits),options?.signal);
        if(providerTarget(actualProvider as HealthProvider).key!==target)throw new ExecutionLimitError('authority','Provider endpoint changed during token counting.');
      }
      ticket = attemptBudget ? await attemptBudget.reserve({provider:actualProvider,model:actualModel,target:target!,maxOutputTokens:maxOutputTokens!,...(limits.inputCount?{inputCount:limits.inputCount}:{}),...(limits.priceCeiling?{priceCeiling:limits.priceCeiling}:{})}) : undefined;
    }
    catch (error) {
      throwIfCancelled(options?.signal);
      if (error instanceof ExecutionLimitError) throw error;
      throw new ExecutionLimitError('unavailable','Request admission could not be committed; no provider request was sent.');
    }
    let settlementStarted = false;
    const settle = async (outcome:'success'|'error'|'cancelled', usage?:LLMResponse['usage']) => {
      if (!attemptBudget || ticket === undefined || settlementStarted) return;
      settlementStarted = true;
      try { await attemptBudget.settle(ticket,outcome,usage); }
      catch (error) { if (error instanceof ExecutionLimitError) throw error; throw new ExecutionLimitError('unavailable','Provider outcome could not be committed; its reservation remains charged.'); }
    };
    const started = Date.now(), retryIndex = attempt++;
    const stream = onToken ? new StreamAttempt(retryIndex + 1, onToken, options?.onStreamEvent, options?.signal) : undefined;
    lastStream = stream;
    const record = (observation: Omit<import('../health/types.js').HealthObservation, 'provider' | 'target' | 'type'>) => {
      if (!health) return;
      try { health.store.append({ provider: health.target.provider, target: health.target.key, type: 'attempt',
        durationMs: Math.max(0, Math.min(86400000, Date.now() - started)), retryIndex, ...observation }); }
      catch { healthHistoryWarning(options?.onHealthWarning); }
    };
    try {
      throwIfCancelled(options?.signal);
      if (attemptBudget && providerTarget(actualProvider as HealthProvider).key !== target) throw new ExecutionLimitError('authority','Provider endpoint changed during budget admission.');
      const response = await cancellable(doChat(stream?.push), options?.signal);
      if (stream && response.errorCode === 'refusal') {
        await settle('error', response.usage);
        throw new ProviderRefusalError();
      }
      if (stream && response.finishReason === 'error') throw new StreamProtocolError('Provider returned an unsuccessful stream completion.');
      await settle(response.finishReason === 'error' ? 'error' : 'success', response.usage);
      stream?.finish('completed');
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
      await settle(outcome === 'cancelled' ? 'cancelled' : 'error');
      stream?.finish(outcome === 'cancelled' ? 'cancelled' : 'failed');
      record({ outcome, ...(outcome === 'cancelled' ? { capabilities: { cancellation: true } } : { ...healthFailure(error), ...(outcome === 'timeout' ? { failure: 'timeout' as const } : {}) }) });
      throw outcome === 'cancelled' ? error : stream?.failure(error, !!options?.onStreamReset) ?? error;
    }
  };
  try { return await withRetry(observedChat, {
    signal: options?.signal,
    maxRetries: MAX_STREAM_ATTEMPTS - 1,
    initialDelayMs: 1000,
    onRetry: (attempt, error, delayMs) => {
      throwIfCancelled(options?.signal);
      options?.onStreamReset?.();
      lastStream?.retry(delayMs);
      onRetry?.(attempt, error, delayMs);
    },
  }); } catch (error) {
    if (options?.signal?.aborted) lastStream?.finish('cancelled');
    throw error;
  }
}

// Re-export everything from sub-modules for public API
export { needsSummarization, getContextHealth, estimateContextUsage } from './types.js';
export type { StreamCallback, RetryCallback, ChatOptions } from './types.js';
export { requiresResponsesAPI, toResponsesInput, toResponsesTools } from './openai.js';

export type { StreamAttemptEvent } from './stream-attempt.js';
