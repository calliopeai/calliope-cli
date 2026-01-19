/**
 * Calliope CLI - LLM Providers
 *
 * Handles communication with different LLM providers.
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import * as config from './config.js';
import { withRetry, classifyError, type RetryOptions } from './errors.js';
import type { Message, Tool, LLMResponse, ToolCall, LLMProvider, MessageContent, TextContent, ImageContent } from './types.js';
import { DEFAULT_MODELS } from './types.js';

/**
 * Extract text from MessageContent
 */
function getTextContent(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter(block => block.type === 'text')
    .map(block => (block as TextContent).text)
    .join('\n');
}

/**
 * Convert MessageContent to Anthropic content format
 */
function toAnthropicContent(content: MessageContent): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') {
    return content;
  }

  return content.map(block => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    } else if (block.type === 'image') {
      return {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: block.mediaType,
          data: block.data,
        },
      };
    }
    return { type: 'text' as const, text: '' };
  });
}

/**
 * Convert MessageContent to OpenAI content format
 */
function toOpenAIContent(content: MessageContent): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  return content.map(block => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    } else if (block.type === 'image') {
      return {
        type: 'image_url' as const,
        image_url: {
          url: `data:${block.mediaType};base64,${block.data}`,
        },
      };
    }
    return { type: 'text' as const, text: '' };
  });
}

// Constants
const MAX_TOKENS = 8192;

// Debug logging helper
const DEBUG = process.env.CALLIOPE_DEBUG === '1';
function debugLog(message: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[DEBUG] ${message}`, ...args);
}

// ============================================================================
// OpenAI Responses API Types (for o3, o4-mini, gpt-5, etc.)
// ============================================================================

/** Input message types for Responses API */
type ResponsesInputItem =
  | { role: 'developer' | 'user' | 'assistant'; content: string | ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: { url: string } };

/** Tool definition for Responses API */
interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

/** Streaming event types from Responses API */
interface ResponsesTextDeltaEvent {
  type: 'response.output_text.delta';
  delta: string;
}

interface ResponsesFunctionCallDoneEvent {
  type: 'response.function_call_arguments.done';
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesCompletedEvent {
  type: 'response.completed';
  response: {
    status: 'completed' | 'incomplete' | 'failed';
    usage?: { input_tokens: number; output_tokens: number };
  };
}

type ResponsesStreamEvent =
  | ResponsesTextDeltaEvent
  | ResponsesFunctionCallDoneEvent
  | ResponsesCompletedEvent
  | { type: string }; // Other events we don't handle

/** Output item types from non-streaming response */
interface ResponsesFunctionCallOutput {
  type: 'function_call';
  call_id: string;
  id?: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

interface ResponsesTextOutput {
  type: 'text';
  text: string;
}

type ResponsesOutputItem = ResponsesFunctionCallOutput | ResponsesTextOutput | { type: string };

/** Full response structure */
interface ResponsesAPIResponse {
  output_text: string;
  output: ResponsesOutputItem[];
  status: 'completed' | 'incomplete' | 'failed';
  usage?: { input_tokens: number; output_tokens: number };
}

// ============================================================================
// LLM Response Validation
// ============================================================================

/** Maximum allowed content length (1MB) to prevent memory issues */
const MAX_CONTENT_LENGTH = 1024 * 1024;

/**
 * Validate and sanitize LLM response
 */
function validateLLMResponse(response: LLMResponse): LLMResponse {
  // Ensure content is a string
  if (response.content === null || response.content === undefined) {
    response.content = '';
  } else if (typeof response.content !== 'string') {
    response.content = String(response.content);
  }

  // Truncate if too long to prevent memory issues
  if (response.content.length > MAX_CONTENT_LENGTH) {
    debugLog('Response content truncated from', response.content.length, 'to', MAX_CONTENT_LENGTH);
    response.content = response.content.slice(0, MAX_CONTENT_LENGTH) + '\n... [truncated]';
  }

  // Validate tool calls if present
  if (response.toolCalls) {
    response.toolCalls = response.toolCalls.filter(call => {
      if (!call.id || typeof call.id !== 'string') {
        debugLog('Invalid tool call: missing or invalid id', call);
        return false;
      }
      if (!call.name || typeof call.name !== 'string') {
        debugLog('Invalid tool call: missing or invalid name', call);
        return false;
      }
      if (call.arguments === null || call.arguments === undefined) {
        call.arguments = {};
      }
      return true;
    });

    if (response.toolCalls.length === 0) {
      response.toolCalls = undefined;
    }
  }

  // Ensure valid finish reason
  if (!['stop', 'tool_use', 'length', 'error'].includes(response.finishReason)) {
    response.finishReason = 'stop';
  }

  return response;
}

// ============================================================================

/**
 * Models that require the Responses API instead of Chat Completions
 * These are OpenAI's newer reasoning models that only work with /v1/responses
 */
const RESPONSES_API_MODELS = [
  'o3',
  'o3-mini',
  'o3-pro',
  'o4-mini',
  'gpt-5',
];

/**
 * Check if a model requires the Responses API
 */
function requiresResponsesAPI(model: string): boolean {
  return RESPONSES_API_MODELS.some(m => model.startsWith(m));
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
};

/**
 * Convert messages to OpenAI format
 */
function toOpenAIMessages(messages: Message[]) {
  return messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: m.toolCallId || '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant' as const,
        content: typeof m.content === 'string' ? m.content : (m.content ? JSON.stringify(m.content) : null),
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

    // Handle multi-modal content for user messages
    if (m.role === 'user' && Array.isArray(m.content)) {
      return {
        role: 'user' as const,
        content: toOpenAIContent(m.content),
      };
    }

    return {
      role: m.role as 'system' | 'user' | 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    };
  });
}

/**
 * Convert tools to OpenAI format
 */
function toOpenAITools(tools: Tool[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Parse tool calls from OpenAI response
 */
function parseOpenAIToolCalls(toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined): ToolCall[] {
  if (!toolCalls) return [];

  const result: ToolCall[] = [];
  for (const tc of toolCalls) {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.function.arguments);
    } catch (error) {
      const parseError = error instanceof SyntaxError ? error.message : 'Unknown parse error';
      throw new Error(`Invalid tool arguments from LLM: ${parseError}. Raw: ${tc.function.arguments.substring(0, 200)}`);
    }
    result.push({
      id: tc.id,
      name: tc.function.name,
      arguments: parsedArgs,
    });
  }
  return result;
}

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
 * Streaming callback type
 */
export type StreamCallback = (token: string) => void;

/**
 * Retry callback type for UI updates
 */
export type RetryCallback = (attempt: number, error: Error, delayMs: number) => void;

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

/**
 * Chat with Anthropic Claude
 */
async function chatAnthropic(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback
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
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }],
      };
    }

    if (m.toolCalls && m.toolCalls.length > 0) {
      const textContent = typeof m.content === 'string' ? m.content :
        (Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => (b as TextContent).text).join('\n') : '');
      return {
        role: 'assistant' as const,
        content: [
          ...(textContent ? [{ type: 'text' as const, text: textContent }] : []),
          ...m.toolCalls.map(tc => ({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          })),
        ],
      };
    }

    // Handle multi-modal content for user messages
    if (m.role === 'user' && Array.isArray(m.content)) {
      return {
        role: 'user' as const,
        content: toAnthropicContent(m.content),
      };
    }

    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return {
      role: m.role as 'user' | 'assistant',
      // Anthropic requires non-empty content for all non-final messages
      content: content || '(continued)',
    };
  });

  // Convert tools to Anthropic format
  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  // Use streaming if callback provided - handles both text and tool calls
  if (onToken) {
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls: ToolCall[] = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';

    try {
      const stream = await client.messages.stream({
        model,
        max_tokens: MAX_TOKENS,
        system: systemMessage ? getTextContent(systemMessage.content) : '',
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInput = '';
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const text = event.delta.text;
            content += text;
            onToken(text);
          } else if (event.delta.type === 'input_json_delta') {
            currentToolInput += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolId && currentToolName) {
            try {
              toolCalls.push({
                id: currentToolId,
                name: currentToolName,
                arguments: JSON.parse(currentToolInput || '{}'),
              });
            } catch {
              toolCalls.push({
                id: currentToolId,
                name: currentToolName,
                arguments: {},
              });
            }
            currentToolId = '';
            currentToolName = '';
            currentToolInput = '';
          }
        } else if (event.type === 'message_delta') {
          if (event.usage) {
            outputTokens = event.usage.output_tokens;
          }
          if (event.delta.stop_reason === 'tool_use') {
            finishReason = 'tool_use';
          } else if (event.delta.stop_reason === 'max_tokens') {
            finishReason = 'length';
          }
        } else if (event.type === 'message_start' && event.message.usage) {
          inputTokens = event.message.usage.input_tokens;
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        usage: { inputTokens, outputTokens },
      };
    } catch (streamError) {
      // Fall back to non-streaming on error
      console.error('Anthropic streaming failed, falling back:', streamError);
    }
  }

  // Non-streaming request
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: systemMessage ? getTextContent(systemMessage.content) : '',
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

  // Map Anthropic stop reasons to our finish reasons
  let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';
  if (response.stop_reason === 'tool_use') {
    finishReason = 'tool_use';
  } else if (response.stop_reason === 'max_tokens') {
    finishReason = 'length';
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
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
    parts: [{ text: getTextContent(m.content) }],
  }));

  if (messages.length === 0) {
    throw new Error('No messages provided');
  }
  const lastMessage = messages[messages.length - 1];
  const systemMessage = messages.find(m => m.role === 'system');

  const chat = genModel.startChat({
    history,
    systemInstruction: systemMessage ? getTextContent(systemMessage.content) : undefined,
  });

  // Convert last message to Gemini format (with image support)
  const lastMessageParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (typeof lastMessage.content === 'string') {
    lastMessageParts.push({ text: lastMessage.content });
  } else {
    for (const block of lastMessage.content) {
      if (block.type === 'text') {
        lastMessageParts.push({ text: block.text });
      } else if (block.type === 'image') {
        lastMessageParts.push({
          inlineData: {
            mimeType: block.mediaType,
            data: block.data,
          },
        });
      }
    }
  }

  const result = await chat.sendMessage(lastMessageParts);
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
 * Convert messages to Responses API input format
 */
function toResponsesInput(messages: Message[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      // System messages become developer messages in Responses API
      input.push({
        role: 'developer' as const,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    } else if (m.role === 'tool') {
      // Tool results become function_call_output items
      input.push({
        type: 'function_call_output' as const,
        call_id: m.toolCallId || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    } else if (m.role === 'assistant') {
      // Assistant messages with tool calls
      if (m.toolCalls && m.toolCalls.length > 0) {
        // First add any text content as a message
        const textContent = typeof m.content === 'string' ? m.content :
          (Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => (b as TextContent).text).join('\n') : '');
        if (textContent) {
          input.push({
            role: 'assistant' as const,
            content: textContent,
          });
        }
        // Then add each tool call as a function_call item
        for (const tc of m.toolCalls) {
          input.push({
            type: 'function_call' as const,
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
      } else {
        input.push({
          role: 'assistant' as const,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
      }
    } else if (m.role === 'user') {
      // Handle multi-modal content for user messages
      if (Array.isArray(m.content)) {
        const parts: ResponsesContentPart[] = [];
        for (const block of m.content) {
          if (block.type === 'text') {
            parts.push({ type: 'input_text', text: block.text });
          } else if (block.type === 'image') {
            parts.push({
              type: 'input_image',
              image_url: { url: `data:${block.mediaType};base64,${block.data}` },
            });
          }
        }
        input.push({ role: 'user' as const, content: parts });
      } else {
        input.push({
          role: 'user' as const,
          content: m.content,
        });
      }
    }
  }

  return input;
}

/**
 * Convert tools to Responses API format
 */
function toResponsesTools(tools: Tool[]): ResponsesTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

/**
 * Type guard for text delta events
 */
function isTextDeltaEvent(event: ResponsesStreamEvent): event is ResponsesTextDeltaEvent {
  return event.type === 'response.output_text.delta';
}

/**
 * Type guard for function call done events
 */
function isFunctionCallDoneEvent(event: ResponsesStreamEvent): event is ResponsesFunctionCallDoneEvent {
  return event.type === 'response.function_call_arguments.done';
}

/**
 * Type guard for completed events
 */
function isCompletedEvent(event: ResponsesStreamEvent): event is ResponsesCompletedEvent {
  return event.type === 'response.completed';
}

/**
 * Type guard for function call output items
 */
function isFunctionCallOutput(item: ResponsesOutputItem): item is ResponsesFunctionCallOutput {
  return item.type === 'function_call';
}

/**
 * Chat with OpenAI using the Responses API (for o3, o4-mini, etc.)
 */
async function chatOpenAIResponses(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const client = new OpenAI({ apiKey });
  const responsesInput = toResponsesInput(messages);
  const responsesTools = toResponsesTools(tools);

  // Use streaming if callback provided
  if (onToken) {
    let content = '';
    const toolCalls: ToolCall[] = [];
    let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      // Note: OpenAI SDK types don't fully match Responses API yet
      // We use our own type definitions and cast through unknown for SDK interop
      const streamParams = {
        model,
        input: responsesInput,
        tools: responsesTools.length > 0 ? responsesTools : undefined,
        max_output_tokens: MAX_TOKENS,
      } as unknown;
      const stream = client.responses.stream(streamParams as Parameters<typeof client.responses.stream>[0]);

      for await (const event of stream) {
        const typedEvent = event as ResponsesStreamEvent;
        if (isTextDeltaEvent(typedEvent)) {
          content += typedEvent.delta;
          onToken(typedEvent.delta);
        } else if (isFunctionCallDoneEvent(typedEvent)) {
          toolCalls.push({
            id: typedEvent.call_id || `call_${Date.now()}`,
            name: typedEvent.name,
            arguments: JSON.parse(typedEvent.arguments || '{}'),
          });
          finishReason = 'tool_use';
        } else if (isCompletedEvent(typedEvent)) {
          const response = typedEvent.response;
          if (response?.usage) {
            inputTokens = response.usage.input_tokens || 0;
            outputTokens = response.usage.output_tokens || 0;
          }
          if (response?.status === 'incomplete') {
            finishReason = 'length';
          }
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        usage: { inputTokens, outputTokens },
      };
    } catch (streamError) {
      debugLog('Responses API streaming failed, falling back to non-streaming:', streamError);
    }
  }

  // Non-streaming request
  const createParams = {
    model,
    input: responsesInput,
    tools: responsesTools.length > 0 ? responsesTools : undefined,
    max_output_tokens: MAX_TOKENS,
  } as unknown;
  const response = await client.responses.create(
    createParams as Parameters<typeof client.responses.create>[0]
  ) as unknown as ResponsesAPIResponse;

  // Extract content and tool calls from response
  let content = response.output_text || '';
  const toolCalls: ToolCall[] = [];

  // Process output items for tool calls
  for (const item of response.output) {
    if (isFunctionCallOutput(item)) {
      toolCalls.push({
        id: item.call_id || item.id || `call_${Date.now()}`,
        name: item.name,
        arguments: typeof item.arguments === 'string'
          ? JSON.parse(item.arguments)
          : item.arguments as Record<string, unknown>,
      });
    }
  }

  // Determine finish reason
  let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';
  if (toolCalls.length > 0) {
    finishReason = 'tool_use';
  } else if (response.status === 'incomplete') {
    finishReason = 'length';
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    usage: response.usage ? {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    } : undefined,
  };
}

/**
 * Chat with OpenAI
 */
async function chatOpenAI(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback
): Promise<LLMResponse> {
  // Route to Responses API for models that require it (o3, o4-mini, etc.)
  if (requiresResponsesAPI(model)) {
    return chatOpenAIResponses(messages, tools, model, onToken);
  }

  const apiKey = config.getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const client = new OpenAI({ apiKey });
  const openaiMessages = toOpenAIMessages(messages);
  const openaiTools = toOpenAITools(tools);

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
        max_tokens: MAX_TOKENS,
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
        .map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.arguments || '{}'),
        }));

      if (toolCalls.length > 0) {
        finishReason = 'tool_use';
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
      };
    } catch (streamError) {
      // Fall back to non-streaming on error
      console.error('Streaming failed, falling back to non-streaming:', streamError);
    }
  }

  // Non-streaming request
  const response = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    tools: openaiTools.length > 0 ? openaiTools : undefined,
    max_tokens: MAX_TOKENS,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error('Empty response from OpenAI API');
  }

  const choice = response.choices[0];
  const message = choice.message;
  const toolCalls = parseOpenAIToolCalls(message.tool_calls);

  // Map OpenAI finish reasons
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

/**
 * Chat with OpenAI-compatible APIs (OpenRouter, Together, Groq, Mistral, etc.)
 */
async function chatOpenAICompatible(
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
  } else {
    apiKey = config.getApiKey(provider);
    if (!apiKey) throw new Error(`${provider} API key not configured`);

    baseURL = PROVIDER_BASE_URLS[provider];
    if (!baseURL) throw new Error(`Unknown provider: ${provider}`);
  }

  const client = new OpenAI({ apiKey, baseURL });
  const openaiMessages = toOpenAIMessages(messages);
  const openaiTools = toOpenAITools(tools);

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
        max_tokens: MAX_TOKENS,
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
        .map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.arguments || '{}'),
        }));

      if (toolCalls.length > 0) {
        finishReason = 'tool_use';
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
      };
    } catch (streamError) {
      // Fall back to non-streaming on error
      console.error('Streaming failed, falling back to non-streaming:', streamError);
    }
  }

  // Non-streaming request
  const response = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    tools: openaiTools.length > 0 ? openaiTools : undefined,
    max_tokens: MAX_TOKENS,
  });

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
