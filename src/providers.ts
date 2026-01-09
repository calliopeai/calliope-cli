/**
 * Calliope CLI - LLM Providers
 *
 * Handles communication with different LLM providers.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import * as config from './config.js';
import type { Message, Tool, LLMResponse, ToolCall, LLMProvider } from './types.js';
import { DEFAULT_MODELS } from './types.js';

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
 * Chat with the selected provider
 */
export async function chat(
  provider: LLMProvider,
  messages: Message[],
  tools: Tool[],
  model?: string
): Promise<LLMResponse> {
  const actualProvider = selectProvider(provider);
  const actualModel = model || DEFAULT_MODELS[actualProvider];

  switch (actualProvider) {
    case 'anthropic':
      return chatAnthropic(messages, tools, actualModel);
    case 'google':
      return chatGoogle(messages, tools, actualModel);
    case 'openai':
      return chatOpenAI(messages, tools, actualModel);
    case 'openrouter':
    case 'together':
    case 'groq':
    case 'fireworks':
    case 'mistral':
    case 'ai21':
    case 'huggingface':
    case 'ollama':
    case 'litellm':
      return chatOpenAICompatible(actualProvider, messages, tools, actualModel);
    default:
      throw new Error(`Provider ${actualProvider} not implemented`);
  }
}

/**
 * Chat with Anthropic Claude
 */
async function chatAnthropic(
  messages: Message[],
  tools: Tool[],
  model: string
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('anthropic');
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const client = new Anthropic({ apiKey });

  // Extract system message
  const systemMessage = messages.find(m => m.role === 'system');
  const chatMessages = messages.filter(m => m.role !== 'system');

  // Convert to Anthropic format
  const anthropicMessages = chatMessages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'user' as const,
        content: [{
          type: 'tool_result' as const,
          tool_use_id: m.toolCallId || '',
          content: m.content,
        }],
      };
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant' as const,
        content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map(tc => ({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          })),
        ],
      };
    }

    return {
      role: m.role as 'user' | 'assistant',
      content: m.content,
    };
  });

  // Convert tools to Anthropic format
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: systemMessage?.content || '',
    messages: anthropicMessages,
    tools: anthropicTools.length > 0 ? anthropicTools : undefined,
  });

  // Parse response
  let content = '';
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: response.stop_reason === 'tool_use' ? 'tool_use' : 'stop',
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/**
 * Chat with Google Gemini
 */
async function chatGoogle(
  messages: Message[],
  tools: Tool[],
  model: string
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('google');
  if (!apiKey) throw new Error('Google API key not configured');

  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model });

  // Build history (exclude last message)
  const history = messages.slice(0, -1).filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  if (messages.length === 0) {
    throw new Error('No messages provided');
  }
  const lastMessage = messages[messages.length - 1];
  const systemMessage = messages.find(m => m.role === 'system');

  const chat = genModel.startChat({
    history,
    systemInstruction: systemMessage?.content,
  });

  const result = await chat.sendMessage(lastMessage.content);
  const response = result.response;
  const text = response.text();

  // Check for function calls
  const toolCalls: ToolCall[] = [];
  const candidates = response.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts || []) {
      if ('functionCall' in part && part.functionCall) {
        toolCalls.push({
          id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args as Record<string, unknown>,
        });
      }
    }
  }

  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
  };
}

/**
 * Chat with OpenAI
 */
async function chatOpenAI(
  messages: Message[],
  tools: Tool[],
  model: string
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const client = new OpenAI({ apiKey });

  // Convert to OpenAI format
  const openaiMessages = messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: m.toolCallId || '',
        content: m.content,
      };
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    return {
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    };
  });

  // Convert tools to OpenAI format
  const openaiTools = tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const response = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    tools: openaiTools.length > 0 ? openaiTools : undefined,
    max_tokens: 8192,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error('Empty response from OpenAI API');
  }

  const choice = response.choices[0];
  const message = choice.message;

  const toolCalls: ToolCall[] = [];
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        throw new Error(`Invalid tool arguments from LLM: ${tc.function.arguments}`);
      }
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      });
    }
  }

  return {
    content: message.content || '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'stop',
    usage: response.usage ? {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    } : undefined,
  };
}

/**
 * Chat with OpenAI-compatible APIs (OpenRouter, Together, Groq, Mistral, etc.)
 */
async function chatOpenAICompatible(
  provider: LLMProvider,
  messages: Message[],
  tools: Tool[],
  model: string
): Promise<LLMResponse> {
  // Ollama and LiteLLM use base URL, others use API key
  let apiKey: string | undefined;
  let baseURL: string;

  if (provider === 'ollama') {
    baseURL = config.getBaseUrl('ollama') || 'http://localhost:11434/v1';
    apiKey = 'ollama'; // Ollama doesn't require a real API key
  } else if (provider === 'litellm') {
    baseURL = config.getBaseUrl('litellm') || 'http://localhost:4000/v1';
    apiKey = config.getApiKey('litellm') || 'litellm'; // LiteLLM may or may not require key
  } else {
    apiKey = config.getApiKey(provider);
    if (!apiKey) throw new Error(`${provider} API key not configured`);

    const baseURLs: Record<string, string> = {
      openrouter: 'https://openrouter.ai/api/v1',
      together: 'https://api.together.xyz/v1',
      groq: 'https://api.groq.com/openai/v1',
      fireworks: 'https://api.fireworks.ai/inference/v1',
      mistral: 'https://api.mistral.ai/v1',
      ai21: 'https://api.ai21.com/studio/v1',
      huggingface: 'https://api-inference.huggingface.co/v1',
    };

    baseURL = baseURLs[provider];
    if (!baseURL) throw new Error(`Unknown provider: ${provider}`);
  }

  const client = new OpenAI({
    apiKey,
    baseURL,
  });

  // Convert to OpenAI format (same as chatOpenAI)
  const openaiMessages = messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: m.toolCallId || '',
        content: m.content,
      };
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    return {
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    };
  });

  const openaiTools = tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const response = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    tools: openaiTools.length > 0 ? openaiTools : undefined,
    max_tokens: 8192,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error(`Empty response from ${provider} API`);
  }

  const choice = response.choices[0];
  const message = choice.message;

  const toolCalls: ToolCall[] = [];
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        throw new Error(`Invalid tool arguments from LLM: ${tc.function.arguments}`);
      }
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      });
    }
  }

  return {
    content: message.content || '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'stop',
    usage: response.usage ? {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    } : undefined,
  };
}
