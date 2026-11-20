import { StreamFramingWitness } from './stream-framing.js';
import { assertChatToolIdentity, parseCapturedToolArguments, assertChatStreamChunk, assertChatTerminalResponse, assertResponsesTerminalResponse, assertUsagePair } from './stream-validation.js';
/**
 * OpenAI Provider (Chat Completions + Responses API)
 *
 * Handles both the standard Chat Completions API and the newer Responses API
 * for reasoning models (o3, o4-mini, gpt-5, etc.).
 *
 * Also exports shared OpenAI format converters used by the compat provider.
 */

import OpenAI from 'openai';
import { getDiscoveredModels } from '../model-detection.js';
import { isReasoningEffort } from '../models/metadata.js';
import { requestModelLimits } from '../models/request-limits.js';
import { ExecutionLimitError } from '../execution/types.js';
import { interruptCompletedResponse, throwUnverifiedStreamFailure } from './response-retention.js';
import { StreamProtocolError } from '../errors.js';
import { isCancellation, throwIfCancelled } from '../cancellation.js';
import * as config from '../config.js';
import type { Message, Tool, LLMResponse, ToolCall, TextContent, MessageContent } from '../types.js';
import { normalizeFinishReason, calculateMaxTokens, debugLog, type StreamCallback, type AdapterLimits } from './types.js';

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
export function parseOpenAIToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
  finishReason?: LLMResponse['finishReason'],
  onTruncated?: () => void,
): ToolCall[] {
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
      // Output limit cut the arguments short: skip the call and report it (#487).
      if (finishReason === 'length') {
        onTruncated?.();
        continue;
      }
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
  type: 'response.completed' | 'response.incomplete' | 'response.failed';
  response: {
    status: 'completed' | 'incomplete' | 'failed';
    output: ResponsesOutputItem[];
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
const RESPONSES_API_MODELS = ['o3', 'o4-mini'];

/** Select the request protocol, not model availability. The live catalog owns
 * eligibility; newer GPT generations need Responses for reasoning with tools.
 */
export function requiresResponsesAPI(model: string): boolean {
  const generation = /^gpt-(\d+)(?:[.-]|$)/.exec(model)?.[1];
  return (generation !== undefined && Number(generation) >= 5) ||
    RESPONSES_API_MODELS.some(m => model.startsWith(m));
}

/** Recheck live eligibility and revocable operator evidence before every request. */
export function assertOpenAIEffort(model:string,effort:AdapterLimits['reasoningEffort']):void {
  if (effort === undefined) return;
  const discovered=getDiscoveredModels('openai')?.find(m=>m.id===model||m.aliases?.includes(model));
  const reviewed=requestModelLimits('openai',model)?.reasoningEfforts;
  if (!isReasoningEffort(effort)||!requiresResponsesAPI(model)||!discovered||
      !(discovered.reasoningEfforts??reviewed)?.includes(effort))
    throw new ExecutionLimitError('authority','Live discovery or current reviewed metadata does not confirm the requested OpenAI reasoning effort.');
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
  return ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type);
}

function isFunctionCallOutput(item: ResponsesOutputItem): item is ResponsesFunctionCallOutput {
  return item.type === 'function_call';
}

/** Decode only a settled complete batch; partial or malformed calls never become tools. */
function responsesToolFrame(items: ResponsesOutputItem[], status: ResponsesAPIResponse['status'] | undefined, captured = false):
  Pick<LLMResponse, 'toolCalls' | 'finishReason' | 'truncatedToolCalls' | 'warnings' | 'errorCode'> {
  const calls = items.filter(isFunctionCallOutput);
  if (status === 'incomplete') return {
    finishReason: 'length', ...(calls.length ? { truncatedToolCalls: true } : {}),
  };
  if (status !== 'completed') return { finishReason: 'error' };
  try {
    const toolCalls = calls.map(item => {
      const args: unknown = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid argument object');
      return { id: captured ? item.call_id : item.call_id || item.id || `call_${Date.now()}`, name: item.name,
        arguments: args as Record<string, unknown> };
    });
    return { toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: normalizeFinishReason(status, toolCalls.length > 0) };
  } catch {
    return { finishReason: 'error', errorCode: 'invalid_tool_arguments',
      warnings: ['OpenAI returned malformed tool arguments; no tools were executed.'] };
  }
}

/** Terminal output is authoritative for captured text and tools, not provisional deltas. */
function responsesOutputText(items: ResponsesOutputItem[]): string {
  return items.flatMap(item => item.type === 'message'
    ? ((item as {type: string; content: {type: string; text?: string}[]}).content).filter(part => part.type === 'output_text').map(part => part.text!)
    : []).join('');
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
  onToken?: StreamCallback,
  signal?: AbortSignal,
  limits?: AdapterLimits
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const framing = limits?.retainCompletedResponse && onToken ? new StreamFramingWitness() : undefined;
  const client = new OpenAI({ apiKey, baseURL: config.getBaseUrl('openai'), ...(framing ? { fetch: framing.fetch } : {}), ...(limits?.bounded ? { maxRetries: 0 } : {}) });
  const responsesInput = toResponsesInput(messages);
  const responsesTools = toResponsesTools(tools);

  // Calculate dynamic max_tokens based on available context space
  const dynamicMaxTokens = calculateMaxTokens('openai', model, messages, tools, limits?.maxOutputTokens);
  debugLog(`OpenAI Responses API request: model=${model}, max_tokens=${dynamicMaxTokens}`);

  // Use streaming if callback provided
  if (onToken) {
    let content = '';
    const outputItems: ResponsesOutputItem[] = [];
    let terminalOutput: ResponsesOutputItem[] = [];
    let terminalStatus: ResponsesAPIResponse['status'] | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageSeen = false;
    let observedUsage: {inputTokens:number;outputTokens:number} | undefined;
    const hasTerminal = () => terminalStatus === 'completed' || terminalStatus === 'incomplete' || terminalStatus === 'failed';
    const normalized = (): LLMResponse => ({ content: limits?.retainCompletedResponse ? responsesOutputText(terminalOutput) : content,
      ...responsesToolFrame(limits?.retainCompletedResponse ? terminalOutput : outputItems, terminalStatus, limits?.retainCompletedResponse),
      usage: usageSeen ? { inputTokens, outputTokens } : undefined });

    try {
      // Note: OpenAI SDK types don't fully match Responses API yet
      // We use our own type definitions and cast through unknown for SDK interop
      const streamParams = {
        model,
        input: responsesInput,
        tools: responsesTools.length > 0 ? responsesTools : undefined,
        max_output_tokens: dynamicMaxTokens,
        // Keep bounded probes and orchestration turns from spending the entire
        // output budget on hidden reasoning before producing visible output.
        ...(limits?.reasoningEffort ? { reasoning: { effort: limits.reasoningEffort } } : {}),
      } as unknown;
      const stream = client.responses.stream(streamParams as Parameters<typeof client.responses.stream>[0], signal ? { signal } : undefined);

      for await (const event of stream) {
        const typedEvent = event as ResponsesStreamEvent;
        if(limits?.retainCompletedResponse){
          if(hasTerminal())throw new StreamProtocolError('Responses data followed terminal proof; its reservation remains charged.');
          const snapshot=(event as {response?:{usage?:{input_tokens:number;output_tokens:number}}}).response;
          if(snapshot?.usage){assertUsagePair(snapshot.usage,'input_tokens','output_tokens',observedUsage);observedUsage={inputTokens:snapshot.usage.input_tokens,outputTokens:snapshot.usage.output_tokens};}
          if(isCompletedEvent(typedEvent))assertResponsesTerminalResponse(typedEvent.response,typedEvent.type.slice('response.'.length));
        }
        if (isTextDeltaEvent(typedEvent)) {
          content += typedEvent.delta;
          onToken(typedEvent.delta);
        } else if (!limits?.retainCompletedResponse && isOutputItemDoneEvent(typedEvent) && isFunctionCallOutput(typedEvent.item as ResponsesOutputItem)) {
          outputItems.push(typedEvent.item as ResponsesFunctionCallOutput);
        } else if (isCompletedEvent(typedEvent)) {
          const response = typedEvent.response;
          if (limits?.retainCompletedResponse) terminalOutput = structuredClone(response.output);
          if (response?.usage) {
            usageSeen = typeof response.usage.input_tokens === 'number' && typeof response.usage.output_tokens === 'number';
            inputTokens = response.usage.input_tokens || 0;
            outputTokens = response.usage.output_tokens || 0;
          }
          terminalStatus = response?.status ?? (typedEvent.type === 'response.completed' ? 'completed'
            : typedEvent.type === 'response.incomplete' ? 'incomplete' : 'failed');
        }
      }

      throwIfCancelled(signal);
      if (limits?.retainCompletedResponse && !hasTerminal()) throw new StreamProtocolError('OpenAI Responses stream ended without terminal proof; its reservation remains charged.');
      framing?.assertBoundary();
      return normalized();
    } catch (streamError) {
      if (limits?.retainCompletedResponse && streamError instanceof StreamProtocolError) throw streamError;
      if (limits?.retainCompletedResponse) framing?.assertInterruptionBoundary();
      if (limits?.retainCompletedResponse && hasTerminal())
        interruptCompletedResponse(normalized(), streamError);
      if (limits?.retainCompletedResponse) throwUnverifiedStreamFailure(streamError);
      throwIfCancelled(signal);
      if (isCancellation(streamError)) throw streamError;
      // Keep diagnostics out of assistant tokens; shared retry handling owns errors.
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      debugLog('OpenAI Responses API streaming failed:', errMsg);
      throw streamError;
    }
  }

  // Non-streaming request
  const createParams = {
    model,
    input: responsesInput,
    tools: responsesTools.length > 0 ? responsesTools : undefined,
    max_output_tokens: dynamicMaxTokens,
    ...(limits?.reasoningEffort ? { reasoning: { effort: limits.reasoningEffort } } : {}),
  } as unknown;
  const response = await client.responses.create(
    createParams as Parameters<typeof client.responses.create>[0], signal ? { signal } : undefined
  ) as unknown as ResponsesAPIResponse;

  if (limits?.retainCompletedResponse) assertResponsesTerminalResponse(response);

  // Extract content and tool calls from response
  let content = limits?.retainCompletedResponse ? responsesOutputText(response.output) : response.output_text || '';
  return {
    content,
    ...responsesToolFrame(response.output, response.status, limits?.retainCompletedResponse),
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
  onToken?: StreamCallback,
  signal?: AbortSignal,
  limits?: AdapterLimits
): Promise<LLMResponse> {
  assertOpenAIEffort(model,limits?.reasoningEffort);
  // Route to Responses API for models that require it (o3, o4-mini, etc.)
  if (requiresResponsesAPI(model)) {
    return chatOpenAIResponses(messages, tools, model, onToken, signal, limits);
  }

  const apiKey = config.getApiKey('openai');
  if (!apiKey) throw new Error('OpenAI API key not configured');

  const framing = limits?.retainCompletedResponse && onToken ? new StreamFramingWitness() : undefined;
  const client = new OpenAI({ apiKey, baseURL: config.getBaseUrl('openai'), ...(framing ? { fetch: framing.fetch } : {}), ...(limits?.bounded ? { maxRetries: 0 } : {}) });
  const openaiMessages = toOpenAIMessages(messages);
  const openaiTools = toOpenAITools(tools);

  // Calculate dynamic max_tokens based on available context space
  const dynamicMaxTokens = calculateMaxTokens('openai', model, messages, tools, limits?.maxOutputTokens);
  debugLog(`OpenAI request: model=${model}, max_tokens=${dynamicMaxTokens}`);

  // Use streaming if callback provided
  // Stream text content while collecting tool calls
  if (onToken) {
    let content = '';
    let toolCallDeltas: Record<number, { id: string; name: string; arguments: string }> = {};
    let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';
    let usage: LLMResponse['usage'];

    let completed = false;
    const normalized = (): LLMResponse => {
      // Convert tool call deltas to tool calls
      let truncatedToolCalls = false;
      const toolCalls: ToolCall[] = [];
      for (const tc of Object.values(toolCallDeltas)) {
        const capturedArgs = limits?.retainCompletedResponse ? parseCapturedToolArguments(tc.arguments, finishReason === 'length') : undefined;
        if (!tc.id || !tc.name) {
          if (limits?.retainCompletedResponse && finishReason !== 'length') throw new StreamProtocolError('Incomplete provider tool identity; its reservation remains charged.');
          if (limits?.retainCompletedResponse) truncatedToolCalls = true;
          continue;
        }
        if (finishReason === 'length' && !tc.arguments.trim()) {
          truncatedToolCalls = true;
          continue;
        }
        let parsedArgs: Record<string, unknown> = {};
        try {
          if (limits?.retainCompletedResponse) {
            const parsed = capturedArgs;
            if (parsed === undefined) { truncatedToolCalls = true; continue; }
            parsedArgs = parsed;
          } else parsedArgs = JSON.parse(tc.arguments || '{}');
        } catch (error) {
          if (limits?.retainCompletedResponse && error instanceof StreamProtocolError) throw error;
          debugLog(`Failed to parse streaming tool call arguments for ${tc.name}: ${tc.arguments?.substring(0, 200)}`);
          // Output limit cut the arguments short: drop the call and flag it (#487).
          if (finishReason === 'length') {
            truncatedToolCalls = true;
            continue;
          }
          if (limits?.retainCompletedResponse) throw new StreamProtocolError('Malformed provider tool arguments; its reservation remains charged.');
        }
        toolCalls.push({ id: tc.id, name: tc.name, arguments: parsedArgs });
      }

      finishReason = normalizeFinishReason(finishReason, toolCalls.length > 0);

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        ...(truncatedToolCalls ? { truncatedToolCalls: true } : {}),
        usage,
        warnings: usage ? undefined : ['Streaming usage was not reported; token and cost totals are incomplete.'],
      };
    };
    try {
      const stream = await client.chat.completions.create({
        model,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        // Current OpenAI models reject the deprecated max_tokens name.
        max_completion_tokens: dynamicMaxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }, signal ? { signal } : undefined);

      for await (const chunk of stream) {
        if (limits?.retainCompletedResponse) assertChatStreamChunk(chunk, usage);
        if(limits?.retainCompletedResponse && completed && chunk.choices?.length) throw new StreamProtocolError('Chat data followed terminal proof; its reservation remains charged.');
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
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
            if (limits?.retainCompletedResponse) assertChatToolIdentity(tc.index, tc, toolCallDeltas);
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
        if (choice.finish_reason) { finishReason = normalizeFinishReason(choice.finish_reason); completed = true; }
      }

      // The SDK's async iterator can end normally after an abort.
      throwIfCancelled(signal);
      if (limits?.retainCompletedResponse && !completed) throw new StreamProtocolError('OpenAI Chat stream ended without terminal proof; its reservation remains charged.');
      framing?.assertBoundary();
      return normalized();
    } catch (streamError) {
      if (limits?.retainCompletedResponse && streamError instanceof StreamProtocolError) throw streamError;
      if (limits?.retainCompletedResponse) framing?.assertInterruptionBoundary();
      if (limits?.retainCompletedResponse && completed) interruptCompletedResponse(normalized(), streamError);
      if (limits?.retainCompletedResponse) throwUnverifiedStreamFailure(streamError);
      throwIfCancelled(signal);
      if (isCancellation(streamError)) throw streamError;
      // Keep diagnostics out of assistant tokens; shared retry handling owns errors.
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      debugLog('OpenAI streaming failed:', errMsg);
      throw streamError;
    }
  }

  // Non-streaming request
  const response = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    tools: openaiTools.length > 0 ? openaiTools : undefined,
    max_completion_tokens: dynamicMaxTokens,
  }, signal ? { signal } : undefined);

  if (limits?.retainCompletedResponse) assertChatTerminalResponse(response);

  if (!response.choices || response.choices.length === 0) {
    throw new Error('Empty response from OpenAI API');
  }

  const choice = response.choices[0]!;
  const message = choice.message;
  let truncatedToolCalls = false;
  const toolCalls = parseOpenAIToolCalls(message.tool_calls, normalizeFinishReason(choice.finish_reason), () => {
    truncatedToolCalls = true;
  });

  // Map OpenAI finish reasons
  const finishReason = normalizeFinishReason(choice.finish_reason, toolCalls.length > 0);

  return {
    content: message.content || '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    ...(truncatedToolCalls ? { truncatedToolCalls: true } : {}),
    usage: response.usage ? {
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
    } : undefined,
  };
}
