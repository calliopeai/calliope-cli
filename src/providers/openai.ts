/**
 * OpenAI Provider (Chat Completions + Responses API)
 *
 * Handles both the standard Chat Completions API and the newer Responses API
 * for reasoning models (o3, o4-mini, gpt-5, etc.).
 *
 * Also exports shared OpenAI format converters used by the compat provider.
 */

import OpenAI from 'openai';
import * as config from '../config.js';
import type { Message, Tool, LLMResponse, ToolCall, TextContent, MessageContent } from '../types.js';
import { calculateMaxTokens, debugLog, type StreamCallback } from './types.js';

// ============================================================================
// Shared OpenAI Format Converters (also used by compat provider)
// ============================================================================

/**
 * Convert MessageContent to OpenAI content format
 */
export function toOpenAIContent(content: MessageContent): string | OpenAI.Chat.Completions.ChatCompletionContentPart[] {
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

/**
 * Convert messages to OpenAI format
 */
export function toOpenAIMessages(messages: Message[]) {
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
export function toOpenAITools(tools: Tool[]) {
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
export function parseOpenAIToolCalls(toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined): ToolCall[] {
  if (!toolCalls) return [];

  const result: ToolCall[] = [];
  for (const tc of toolCalls) {
    // The SDK models tool calls as a union; we only ever send function tools,
    // so anything else (custom tools) is not ours to parse.
    if (tc.type !== 'function') continue;

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

interface ResponsesOutputItemDoneEvent {
  type: 'response.output_item.done';
  // The item carries the function name, call_id, and full arguments —
  // response.function_call_arguments.done does NOT (it has only
  // arguments + item_id), which is why collection must happen here.
  item: { type: string } | ResponsesFunctionCallOutput;
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
  | ResponsesOutputItemDoneEvent
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
// Responses API Helpers
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
export function requiresResponsesAPI(model: string): boolean {
  return RESPONSES_API_MODELS.some(m => model.startsWith(m));
}

/**
 * Convert messages to Responses API input format
 */
export function toResponsesInput(messages: Message[]): ResponsesInputItem[] {
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
export function toResponsesTools(tools: Tool[]): ResponsesTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

// Type guards for Responses API events
function isTextDeltaEvent(event: ResponsesStreamEvent): event is ResponsesTextDeltaEvent {
  return event.type === 'response.output_text.delta';
}

function isOutputItemDoneEvent(event: ResponsesStreamEvent): event is ResponsesOutputItemDoneEvent {
  return event.type === 'response.output_item.done';
}

function isCompletedEvent(event: ResponsesStreamEvent): event is ResponsesCompletedEvent {
  return event.type === 'response.completed';
}

function isFunctionCallOutput(item: ResponsesOutputItem): item is ResponsesFunctionCallOutput {
  return item.type === 'function_call';
}

// ============================================================================
// Provider Implementations
// ============================================================================

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

  // Calculate dynamic max_tokens based on available context space
  const dynamicMaxTokens = calculateMaxTokens('openai', model, messages, tools);
  debugLog(`OpenAI Responses API request: model=${model}, max_tokens=${dynamicMaxTokens}`);

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
        max_output_tokens: dynamicMaxTokens,
      } as unknown;
      const stream = client.responses.stream(streamParams as Parameters<typeof client.responses.stream>[0]);

      for await (const event of stream) {
        const typedEvent = event as ResponsesStreamEvent;
        if (isTextDeltaEvent(typedEvent)) {
          content += typedEvent.delta;
          onToken(typedEvent.delta);
        } else if (isOutputItemDoneEvent(typedEvent) && isFunctionCallOutput(typedEvent.item as ResponsesOutputItem)) {
          const item = typedEvent.item as ResponsesFunctionCallOutput;
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = typeof item.arguments === 'string'
              ? JSON.parse(item.arguments || '{}')
              : (item.arguments as Record<string, unknown>) ?? {};
          } catch {
            debugLog(`Failed to parse Responses API tool call arguments for ${item.name}: ${String(item.arguments).substring(0, 200)}`);
          }
          toolCalls.push({
            id: item.call_id || item.id || `call_${Date.now()}`,
            name: item.name,
            arguments: parsedArgs,
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
      // Surface the streaming failure and re-throw so withRetry handles it
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      debugLog('OpenAI Responses API streaming failed:', errMsg);
      onToken(`\n[Streaming error: ${errMsg}]\n`);
      throw streamError;
    }
  }

  // Non-streaming request
  const createParams = {
    model,
    input: responsesInput,
    tools: responsesTools.length > 0 ? responsesTools : undefined,
    max_output_tokens: dynamicMaxTokens,
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
export async function chatOpenAI(
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

  // Calculate dynamic max_tokens based on available context space
  const dynamicMaxTokens = calculateMaxTokens('openai', model, messages, tools);
  debugLog(`OpenAI request: model=${model}, max_tokens=${dynamicMaxTokens}`);

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
      debugLog('OpenAI streaming failed:', errMsg);
      onToken(`\n[Streaming error: ${errMsg}]\n`);
      throw streamError;
    }
  }

  // Non-streaming request
  const response = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    tools: openaiTools.length > 0 ? openaiTools : undefined,
    max_tokens: dynamicMaxTokens,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error('Empty response from OpenAI API');
  }

  const choice = response.choices[0]!;
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
