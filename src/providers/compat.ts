/**
 * OpenAI-Compatible Provider
 *
 * Handles OpenRouter, Together, Groq, Fireworks, Mistral, AI21,
 * HuggingFace, Ollama, and LiteLLM via the OpenAI SDK.
 */

import OpenAI from 'openai';
import type { ChatCompletionCreateParamsStreaming, ChatCompletionCreateParamsNonStreaming, ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions.js';
import * as config from '../config.js';
import type { Message, Tool, LLMResponse, LLMProvider } from '../types.js';
import { calculateMaxTokens, debugLog, type StreamCallback } from './types.js';
import { toOpenAIMessages, toOpenAITools, parseOpenAIToolCalls } from './openai.js';
import { getOllamaFallbackModel } from '../model-detection.js';

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

// ---------------------------------------------------------------------------
// OpenAI-Compatible Server Shims
//
// Compatibility shims for popular local inference servers (LM Studio,
// AnythingLLM, vLLM, Jan, LocalAI). Each shim detects its target server by
// URL pattern and transforms request params to work around server-specific
// limitations. Merged from the former standalone shims module (#181).
// ---------------------------------------------------------------------------
export interface CompatShim {
  id: 'lmstudio' | 'anythingllm' | 'vllm' | 'jan' | 'localai' | 'none';
  name: string;
  description: string;
  detect(baseUrl: string): boolean;
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase;
  supportsTools: boolean;
  supportsStreaming: boolean;
}

// ---------------------------------------------------------------------------
// One-time tool-strip warnings (keyed by shim id)
// Exported for test resets via resetToolWarnings()
// ---------------------------------------------------------------------------

const warnedShims = new Set<string>();

/** Reset tool-strip warnings — for use in tests only. */
export function resetToolWarnings(): void {
  warnedShims.clear();
}

// ---------------------------------------------------------------------------
// Shim implementations
// ---------------------------------------------------------------------------

const lmstudioShim: CompatShim = {
  id: 'lmstudio',
  name: 'LM Studio',
  description: 'Local LLM server by LM Studio (default port 1234)',
  supportsTools: true,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':1234');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if (result.max_tokens == null) {
      result.max_tokens = 8192;
    }
    return result;
  },
};

const anythingllmShim: CompatShim = {
  id: 'anythingllm',
  name: 'AnythingLLM',
  description: 'All-in-one AI application (default port 3001, /api/openai path)',
  supportsTools: false,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':3001') || baseUrl.includes('/api/openai');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if ((result.tools || result.tool_choice) && !warnedShims.has('anythingllm')) {
      warnedShims.add('anythingllm');
      process.stderr.write(
        '[openai-compat] AnythingLLM does not support tool_calls — stripping tools and tool_choice\n'
      );
    }
    delete result.tools;
    delete result.tool_choice;
    return result;
  },
};

const vllmShim: CompatShim = {
  id: 'vllm',
  name: 'vLLM',
  description: 'High-throughput inference engine (default port 8000)',
  supportsTools: true,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':8000');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if (result.max_tokens == null) {
      result.max_tokens = 4096;
    }
    return result;
  },
};

const janShim: CompatShim = {
  id: 'jan',
  name: 'Jan',
  description: 'Open-source local AI desktop app (default port 1337)',
  supportsTools: false,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':1337');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if ((result.tools || result.tool_choice) && !warnedShims.has('jan')) {
      warnedShims.add('jan');
      process.stderr.write(
        '[openai-compat] Jan does not support tool_calls — stripping tools and tool_choice\n'
      );
    }
    delete result.tools;
    delete result.tool_choice;
    return result;
  },
};

const localaiShim: CompatShim = {
  id: 'localai',
  name: 'LocalAI',
  description: 'Free, open-source OpenAI alternative (default port 8080)',
  supportsTools: false,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':8080');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if ((result.tools || result.tool_choice) && !warnedShims.has('localai')) {
      warnedShims.add('localai');
      process.stderr.write(
        '[openai-compat] LocalAI does not support tool_calls — stripping tools and tool_choice\n'
      );
    }
    delete result.tools;
    delete result.tool_choice;
    // Convert system role messages to user messages with [SYSTEM] prefix
    if (result.messages) {
      result.messages = result.messages.map((msg) => {
        if (msg.role === 'system') {
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return { role: 'user' as const, content: `[SYSTEM] ${content}` };
        }
        return msg;
      });
    }
    return result;
  },
};

const noneShim: CompatShim = {
  id: 'none',
  name: 'None (pass-through)',
  description: 'No shim applied — pass requests through unchanged',
  supportsTools: true,
  supportsStreaming: true,
  detect(_baseUrl: string): boolean {
    return false;
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    return params;
  },
};

// ---------------------------------------------------------------------------
// Detection order (priority: env var → URL pattern → fallback)
// ---------------------------------------------------------------------------

const ALL_SHIMS: CompatShim[] = [lmstudioShim, anythingllmShim, vllmShim, janShim, localaiShim];

const SHIM_MAP: Record<string, CompatShim> = {
  lmstudio: lmstudioShim,
  anythingllm: anythingllmShim,
  vllm: vllmShim,
  jan: janShim,
  localai: localaiShim,
  none: noneShim,
};

/**
 * Detect which compatibility shim to use for the given base URL.
 *
 * Priority:
 * 1. `OPENAI_COMPAT_SHIM` env var (exact match to shim id)
 * 2. URL pattern matching (in order: lmstudio, anythingllm, vllm, jan, localai)
 * 3. Fallback to pass-through (none)
 */
export function detectShim(baseUrl: string): CompatShim {
  // 1. Env var override
  const envShim = process.env.OPENAI_COMPAT_SHIM;
  if (envShim && envShim in SHIM_MAP) {
    const shim = SHIM_MAP[envShim]!;
    if (shim.id !== 'none') {
      process.stderr.write(`[openai-compat] Detected ${shim.name} — applying compatibility shim\n`);
    }
    return shim;
  }

  // 2. URL pattern matching
  for (const shim of ALL_SHIMS) {
    if (shim.detect(baseUrl)) {
      process.stderr.write(`[openai-compat] Detected ${shim.name} — applying compatibility shim\n`);
      return shim;
    }
  }

  // 3. Pass-through
  return noneShim;
}

/**
 * Chat with OpenAI-compatible APIs (OpenRouter, Together, Groq, Mistral, etc.)
 */
export async function chatOpenAICompatible(
  provider: LLMProvider,
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback
): Promise<LLMResponse> {
  // Ollama and LiteLLM use base URL, others use API key
  let apiKey: string | undefined;
  let baseURL: string;

  if (provider === 'ollama') {
    const ollamaBase = config.getBaseUrl('ollama') || 'http://localhost:11434';
    // Append /v1 for OpenAI-compatible endpoint, unless already present
    baseURL = ollamaBase.endsWith('/v1') ? ollamaBase : `${ollamaBase}/v1`;
    apiKey = 'ollama'; // Ollama doesn't require a real API key
  } else if (provider === 'litellm') {
    const litellmBase = config.getBaseUrl('litellm') || 'http://localhost:4000';
    // Append /v1 for OpenAI-compatible endpoint, unless already present
    baseURL = litellmBase.endsWith('/v1') ? litellmBase : `${litellmBase}/v1`;
    apiKey = config.getApiKey('litellm') || 'litellm'; // LiteLLM may or may not require key
  } else if (provider === 'bedrock') {
    const bedrockBase = config.getBaseUrl('bedrock');
    if (!bedrockBase) throw new Error('Bedrock base URL not configured. Set BEDROCK_BASE_URL to your Bedrock gateway/proxy endpoint.');
    // Append /v1 for OpenAI-compatible endpoint, unless already present
    baseURL = bedrockBase.endsWith('/v1') ? bedrockBase : `${bedrockBase}/v1`;
    apiKey = config.getApiKey('bedrock') || 'bedrock'; // Key depends on gateway setup
  } else if (provider === 'openai-compat') {
    const rawBase = config.getBaseUrl('openai-compat') || 'http://localhost:1234';
    baseURL = rawBase.endsWith('/v1') ? rawBase : `${rawBase}/v1`;
    apiKey = config.getApiKey('openai-compat') || 'openai-compat';
  } else {
    apiKey = config.getApiKey(provider);
    if (!apiKey) throw new Error(`${provider} API key not configured`);

    const resolvedBase = PROVIDER_BASE_URLS[provider];
    if (!resolvedBase) throw new Error(`Unknown provider: ${provider}`);
    baseURL = resolvedBase;
  }

  // Apply openai-compat shim if applicable
  let activeShim: CompatShim | null = null;
  if (provider === 'openai-compat') {
    activeShim = detectShim(baseURL);
  }

  const client = new OpenAI({ apiKey, baseURL });
  const openaiMessages = toOpenAIMessages(messages);
  const openaiTools = toOpenAITools(tools);

  // Calculate dynamic max_tokens based on available context space
  const dynamicMaxTokens = calculateMaxTokens(provider, model, messages, tools);
  debugLog(`${provider} request: model=${model}, max_tokens=${dynamicMaxTokens}`);

  // Use streaming if callback provided
  // Stream text content while collecting tool calls
  if (onToken) {
    let content = '';
    let toolCallDeltas: Record<number, { id: string; name: string; arguments: string }> = {};
    let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';

    try {
      let streamParams: ChatCompletionCreateParamsStreaming = {
        model,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        max_tokens: dynamicMaxTokens,
        stream: true,
      };
      if (activeShim) streamParams = activeShim.transformRequest(streamParams) as ChatCompletionCreateParamsStreaming;
      const stream = await client.chat.completions.create(streamParams);

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        // Handle text content
        const textDelta = choice.delta?.content;
        if (textDelta) {
          content += textDelta;
          onToken(textDelta);
        }

        // Handle tool calls (collect deltas)
        const toolCallDelta = choice.delta?.tool_calls;
        if (toolCallDelta) {
          for (const tc of toolCallDelta) {
            if (!toolCallDeltas[tc.index]) {
              toolCallDeltas[tc.index] = { id: '', name: '', arguments: '' };
            }
            const slot = toolCallDeltas[tc.index]!;
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
          }
        }

        // Track finish reason
        if (choice.finish_reason === 'tool_calls') {
          finishReason = 'tool_use';
        } else if (choice.finish_reason === 'length') {
          finishReason = 'length';
        }
      }

      // Convert tool call deltas to tool calls
      const toolCalls = Object.values(toolCallDeltas)
        .filter(tc => tc.id && tc.name)
        .map(tc => {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(tc.arguments || '{}');
          } catch {
            debugLog(`Failed to parse streaming tool call arguments for ${tc.name}: ${tc.arguments?.substring(0, 200)}`);
          }
          return {
            id: tc.id,
            name: tc.name,
            arguments: parsedArgs,
          };
        });

      if (toolCalls.length > 0) {
        finishReason = 'tool_use';
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
      };
    } catch (streamError) {
      // Surface the streaming failure and re-throw so withRetry handles it
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      debugLog(`${provider} streaming failed:`, errMsg);
      onToken(`\n[Streaming error: ${errMsg}]\n`);
      throw streamError;
    }
  }

  // Non-streaming request with Ollama fallback (#41)
  let actualModel = model;
  let response;
  try {
    let reqParams: ChatCompletionCreateParamsNonStreaming = {
      model: actualModel,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      max_tokens: dynamicMaxTokens,
    };
    if (activeShim) reqParams = activeShim.transformRequest(reqParams) as ChatCompletionCreateParamsNonStreaming;
    response = await client.chat.completions.create(reqParams);
  } catch (error: unknown) {
    // Ollama model not found - try fallback discovery
    const status = (error as { status?: number })?.status;
    if (provider === 'ollama' && (status === 404 || String(error).includes('not found'))) {
      const fallback = await getOllamaFallbackModel();
      if (fallback && fallback !== model) {
        debugLog(`Ollama model "${model}" not found, falling back to "${fallback}"`);
        actualModel = fallback;
        let fallbackParams: ChatCompletionCreateParamsNonStreaming = {
          model: actualModel,
          messages: openaiMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          max_tokens: dynamicMaxTokens,
        };
        if (activeShim) fallbackParams = activeShim.transformRequest(fallbackParams) as ChatCompletionCreateParamsNonStreaming;
        response = await client.chat.completions.create(fallbackParams);
      } else {
        throw new Error(`Ollama model "${model}" not found. Pull it with: ollama pull ${model}`);
      }
    } else {
      throw error;
    }
  }

  if (!response.choices || response.choices.length === 0) {
    throw new Error(`Empty response from ${provider} API`);
  }

  const choice = response.choices[0]!;
  const message = choice.message;
  const toolCalls = parseOpenAIToolCalls(message.tool_calls);

  // Map finish reasons
  let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';
  if (choice.finish_reason === 'tool_calls') {
    finishReason = 'tool_use';
  } else if (choice.finish_reason === 'length') {
    finishReason = 'length';
  }

  return {
    content: message.content || '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    usage: response.usage ? {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    } : undefined,
  };
}
