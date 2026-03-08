/**
 * Native Ollama Provider
 *
 * Uses Ollama's native /api/chat endpoint instead of the OpenAI-compatible
 * /v1/chat/completions. Many Ollama models (e.g. devstral) only support
 * tool calling through the native API.
 *
 * Features:
 * - Native /api/chat for reliable tool calling
 * - Auto-detection of tool support (retries without tools on 400)
 * - Model fallback discovery when configured model isn't available
 * - Streaming support with proper tool call collection
 */

import * as config from '../config.js';
import type { Message, Tool, LLMResponse, ToolCall } from '../types.js';
import { debugLog, type StreamCallback } from './types.js';
import { getOllamaFallbackModel } from '../model-detection.js';

// ============================================================================
// Native Ollama Types
// ============================================================================

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream: boolean;
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaStreamChunk {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

// Track which models don't support tools so we don't keep retrying
const toolUnsupportedModels = new Set<string>();

// ============================================================================
// Message Conversion
// ============================================================================

function toOllamaMessages(messages: Message[], stripToolHistory: boolean = false): OllamaMessage[] {
  return messages
    .filter(m => {
      // When stripping tool history, remove tool result messages and
      // assistant messages that only contain tool calls
      if (!stripToolHistory) return true;
      if (m.role === 'tool') return false;
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && !m.content) return false;
      return true;
    })
    .map(m => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        };
      }

      if (!stripToolHistory && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant' as const,
          content: typeof m.content === 'string' ? (m.content || '') : JSON.stringify(m.content),
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }

      const content = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n')
          : JSON.stringify(m.content);

      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content,
      };
    });
}

function toOllamaTools(tools: Tool[]): OllamaTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function parseOllamaToolCalls(toolCalls?: OllamaToolCall[]): ToolCall[] {
  if (!toolCalls || toolCalls.length === 0) return [];

  return toolCalls.map((tc, i) => ({
    id: tc.id || `call_${Date.now()}_${i}`,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));
}

// ============================================================================
// Helpers
// ============================================================================

function getBaseUrl(): string {
  let baseUrl = config.getBaseUrl('ollama') || 'http://localhost:11434';
  if (baseUrl.endsWith('/v1')) {
    baseUrl = baseUrl.slice(0, -3);
  }
  return baseUrl;
}

function isToolError(errText: string): boolean {
  const lower = errText.toLowerCase();
  return lower.includes('tool') ||
    lower.includes('function') ||
    lower.includes('invalid request') ||
    lower.includes('bad request');
}

// ============================================================================
// Chat Function
// ============================================================================

export async function chatOllama(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback
): Promise<LLMResponse> {
  const baseUrl = getBaseUrl();
  const skipTools = toolUnsupportedModels.has(model);
  const ollamaTools = skipTools ? [] : toOllamaTools(tools);
  const ollamaMessages = toOllamaMessages(messages, skipTools);

  if (skipTools && tools.length > 0) {
    debugLog(`ollama: skipping tools for ${model} (known unsupported)`);
  }
  debugLog(`ollama native request: model=${model}, tools=${ollamaTools.length}, stream=${!!onToken}`);

  try {
    return await doChat(baseUrl, model, ollamaMessages, ollamaTools, onToken);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // Model not found — try fallback
    if (errMsg.includes('not found') || errMsg.includes('404')) {
      return tryFallback(baseUrl, model, ollamaMessages, ollamaTools, onToken);
    }

    // Tool-related error (400) — retry without tools
    if (ollamaTools.length > 0 && isToolError(errMsg)) {
      debugLog(`ollama: model "${model}" rejected tools, retrying without tools`);
      toolUnsupportedModels.add(model);
      const cleanMessages = toOllamaMessages(messages, true);
      return doChat(baseUrl, model, cleanMessages, [], onToken);
    }

    throw error;
  }
}

async function doChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  tools: OllamaTool[],
  onToken?: StreamCallback
): Promise<LLMResponse> {
  const requestBody: OllamaChatRequest = {
    model,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    stream: !!onToken,
  };

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama API error ${response.status}: ${errText}`);
  }

  if (onToken) {
    return streamResponse(response, onToken);
  }

  const data = await response.json() as OllamaChatResponse;

  if (data.load_duration && data.load_duration > 10_000_000_000) {
    debugLog(`ollama: cold start for ${model} took ${Math.round(data.load_duration / 1_000_000_000)}s`);
  }

  const toolCalls = parseOllamaToolCalls(data.message?.tool_calls);

  return {
    content: data.message?.content || '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
    usage: {
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
    },
  };
}

async function streamResponse(
  response: Response,
  onToken: StreamCallback
): Promise<LLMResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body from Ollama');

  const decoder = new TextDecoder();
  let content = '';
  let allToolCalls: ToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
      let chunk: OllamaStreamChunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }

      if (chunk.message?.content) {
        content += chunk.message.content;
        onToken(chunk.message.content);
      }

      if (chunk.message?.tool_calls) {
        const parsed = parseOllamaToolCalls(chunk.message.tool_calls);
        allToolCalls.push(...parsed);
      }

      if (chunk.done) {
        if (chunk.prompt_eval_count) promptTokens = chunk.prompt_eval_count;
        if (chunk.eval_count) completionTokens = chunk.eval_count;
      }
    }
  }

  return {
    content,
    toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
    finishReason: allToolCalls.length > 0 ? 'tool_use' : 'stop',
    usage: {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
    },
  };
}

async function tryFallback(
  baseUrl: string,
  originalModel: string,
  messages: OllamaMessage[],
  tools: OllamaTool[],
  onToken?: StreamCallback
): Promise<LLMResponse> {
  const fallback = await getOllamaFallbackModel();
  if (!fallback || fallback === originalModel) {
    throw new Error(`Ollama model "${originalModel}" not found. Pull it with: ollama pull ${originalModel}`);
  }

  debugLog(`Ollama model "${originalModel}" not found, falling back to "${fallback}"`);
  return doChat(baseUrl, fallback, messages, tools, onToken);
}
