/**
 * OpenAI-Compatible Provider
 *
 * Handles OpenRouter, Together, Groq, Fireworks, Mistral, AI21,
 * HuggingFace, Ollama, and LiteLLM via the OpenAI SDK.
 */

import OpenAI from 'openai';
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

    baseURL = PROVIDER_BASE_URLS[provider];
    if (!baseURL) throw new Error(`Unknown provider: ${provider}`);
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
      const stream = await client.chat.completions.create({
        model,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        max_tokens: dynamicMaxTokens,
        stream: true,
      });

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
            if (tc.id) toolCallDeltas[tc.index].id = tc.id;
            if (tc.function?.name) toolCallDeltas[tc.index].name = tc.function.name;
            if (tc.function?.arguments) toolCallDeltas[tc.index].arguments += tc.function.arguments;
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
    response = await client.chat.completions.create({
      model: actualModel,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      max_tokens: dynamicMaxTokens,
    });
  } catch (error: unknown) {
    // Ollama model not found - try fallback discovery
    const status = (error as { status?: number })?.status;
    if (provider === 'ollama' && (status === 404 || String(error).includes('not found'))) {
      const fallback = await getOllamaFallbackModel();
      if (fallback && fallback !== model) {
        debugLog(`Ollama model "${model}" not found, falling back to "${fallback}"`);
        actualModel = fallback;
        response = await client.chat.completions.create({
          model: actualModel,
          messages: openaiMessages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
          max_tokens: dynamicMaxTokens,
        });
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

  const choice = response.choices[0];
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
