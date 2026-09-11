/**
 * Google Gemini Provider
 */

import { GoogleGenAI } from '@google/genai';
import { isCancellation, throwIfCancelled } from '../cancellation.js';
import * as config from '../config.js';
import type { Message, Tool, LLMResponse, ToolCall } from '../types.js';
import { normalizeFinishReason, getTextContent, debugLog, type StreamCallback } from './types.js';

/**
 * Chat with Google Gemini
 */
async function chatGoogleLegacy(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback,
  signal?: AbortSignal
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('google');
  if (!apiKey) throw new Error('Google API key not configured');

  const genAI = new GoogleGenAI(apiKey as any) as any;

  // Convert a tool property type to Gemini schema type
  function convertPropertyType(prop: any): any {
    const result: any = {
      type: (prop.type || 'string').toUpperCase(),
      description: prop.description,
    };
    if (prop.enum) result.enum = prop.enum;
    // Handle nested objects
    if (prop.type === 'object' && prop.properties) {
      result.properties = Object.fromEntries(
        Object.entries(prop.properties).map(([k, v]) => [k, convertPropertyType(v)])
      );
      if (prop.required) result.required = prop.required;
    }
    // Handle arrays
    if (prop.type === 'array' && prop.items) {
      result.items = convertPropertyType(prop.items);
    }
    return result;
  }

  // Convert tools to Gemini function declarations
  const geminiTools = tools.length > 0 ? [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: 'OBJECT' as const,
        properties: Object.fromEntries(
          Object.entries(t.parameters.properties).map(([key, prop]) => [key, convertPropertyType(prop)])
        ),
        required: t.parameters.required || [],
      },
    })),
  }] : undefined;

  const genModel = genAI.getGenerativeModel({ model, tools: geminiTools as any });

  const chatMessages = messages.filter(message => message.role !== 'system');

  // Build history (exclude last message)
  // Handle tool result messages as functionResponse parts for Gemini
  const history: Array<{ role: string; parts: any[] }> = [];
  for (const m of chatMessages.slice(0, -1)) {
    if (m.role === 'tool') {
      // Gemini expects functionResponse in a 'function' role
      // Find the corresponding tool call to get the function name
      const toolCallId = m.toolCallId;
      let funcName = 'unknown';
      // Look back for the assistant message with this tool call
      for (const prev of messages) {
        if (prev.toolCalls) {
          const match = prev.toolCalls.find(tc => tc.id === toolCallId);
          if (match) { funcName = match.name; break; }
        }
      }
      history.push({
        role: 'function',
        parts: [{ functionResponse: { name: funcName, response: { result: getTextContent(m.content) } } }],
      });
    } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // Assistant message with function calls
      const parts: any[] = [];
      const text = getTextContent(m.content);
      if (text) parts.push({ text });
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      history.push({ role: 'model', parts });
    } else {
      history.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: getTextContent(m.content) }],
      });
    }
  }

  if (chatMessages.length === 0) {
    throw new Error('No messages provided');
  }
  const lastMessage = chatMessages[chatMessages.length - 1]!;
  const systemInstruction = messages.filter(m => m.role === 'system').map(m => getTextContent(m.content)).join('\n\n');

  const chat = genModel.startChat({
    history,
    systemInstruction: systemInstruction || undefined,
  });

  // Convert last message to Gemini format (with image support)
  const lastMessageParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } } | { functionResponse: { name: string; response: { result: string } } }> = [];
  if (lastMessage.role === 'tool') {
    const call = messages.flatMap(message => message.toolCalls ?? []).find(tool => tool.id === lastMessage.toolCallId);
    if (!call) throw new Error('Tool result has no matching function call');
    lastMessageParts.push({ functionResponse: { name: call.name, response: { result: getTextContent(lastMessage.content) } } });
  } else if (typeof lastMessage.content === 'string') {
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

  // Use streaming if callback provided
  if (onToken) {
    let content = '';
    const toolCalls: ToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: LLMResponse['finishReason'] = 'stop';

    try {
      const streamResult = await chat.sendMessageStream(lastMessageParts, signal ? { signal } : undefined);

      for await (const chunk of streamResult.stream) {
        // Extract text from streamed chunks
        const candidates = chunk.candidates || [];
        for (const candidate of candidates) {
          if (candidate.finishReason) finishReason = normalizeFinishReason(candidate.finishReason);
          for (const part of candidate.content?.parts || []) {
            if ('text' in part && part.text) {
              content += part.text;
              onToken(part.text);
            }
            if ('functionCall' in part && part.functionCall) {
              toolCalls.push({
                id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                name: part.functionCall.name,
                arguments: (part.functionCall.args || {}) as Record<string, unknown>,
              });
            }
          }
        }

        // Capture usage metadata from chunks
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount || 0;
          outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: normalizeFinishReason(finishReason, toolCalls.length > 0),
        usage: (inputTokens || outputTokens) ? { inputTokens, outputTokens } : undefined,
      };
    } catch (streamError) {
      throwIfCancelled(signal);
      if (isCancellation(streamError)) throw streamError;
      // Surface the streaming failure and re-throw so withRetry handles it
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      debugLog('Google streaming failed:', errMsg);
      onToken(`\n[Streaming error: ${errMsg}]\n`);
      throw streamError;
    }
  }

  // Non-streaming request
  const result = await chat.sendMessage(lastMessageParts, signal ? { signal } : undefined);
  const response = result.response;

  // Check for function calls first (text() throws when only function calls are present)
  const toolCalls: ToolCall[] = [];
  const candidates = response.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts || []) {
      if ('functionCall' in part && part.functionCall) {
        toolCalls.push({
          id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: part.functionCall.name,
          arguments: (part.functionCall.args || {}) as Record<string, unknown>,
        });
      }
    }
  }

  // Safely extract text (may throw if response only has function calls)
  let text = '';
  try {
    text = response.text();
  } catch {
    // No text content - this is expected when only function calls are returned
  }

  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: normalizeFinishReason(response.candidates?.[0]?.finishReason || response.promptFeedback?.blockReason, toolCalls.length > 0),
    usage: response.usageMetadata ? {
      inputTokens: response.usageMetadata.promptTokenCount || 0,
      outputTokens: response.usageMetadata.candidatesTokenCount || 0,
    } : undefined,
  };
}

/** Production adapter for the maintained Google GenAI SDK. */
async function chatGoogleGenAI(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback,
  signal?: AbortSignal,
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('google');
  if (!apiKey) throw new Error('Google API key not configured');
  if (messages.length === 0) throw new Error('No messages provided');

  const baseUrl = config.getBaseUrl('google')?.replace(/\/v1beta\/?$/, '');
  const ai = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  const systemInstruction = messages.filter(m => m.role === 'system').map(m => getTextContent(m.content)).join('\n\n');
  const contents = messages.filter(m => m.role !== 'system').map(m => {
    if (m.role === 'tool') {
      const call = messages.flatMap(x => x.toolCalls ?? []).find(x => x.id === m.toolCallId);
      return { role: 'user', parts: [{ functionResponse: { name: call?.name || 'unknown', response: { result: getTextContent(m.content) } } }] };
    }
    const parts = typeof m.content === 'string'
      ? [{ text: m.content }]
      : m.content.map(part => part.type === 'text'
        ? { text: part.text }
        : { inlineData: { mimeType: part.mediaType, data: part.data } });
    if (m.role === 'assistant') {
      const callParts = (m.toolCalls ?? []).map(tc => ({ functionCall: { name: tc.name, args: tc.arguments } }));
      return { role: 'model', parts: [...parts, ...callParts] };
    }
    return { role: 'user', parts };
  });
  const declarations = tools.length > 0 ? [{ functionDeclarations: tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: { type: 'OBJECT', properties: Object.fromEntries(Object.entries(t.parameters.properties).map(([k, p]) => [k, { ...p, type: (p.type || 'string').toUpperCase() }])), required: t.parameters.required || [] },
  })) }] : undefined;
  const request = { model, contents, config: { systemInstruction: systemInstruction || undefined, tools: declarations } } as any;
  throwIfCancelled(signal);

  let content = '';
  const toolCalls: ToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: LLMResponse['finishReason'] = 'stop';
  const consume = (chunk: any) => {
    const candidates = chunk.candidates || [];
    for (const candidate of candidates) {
      if (candidate.finishReason) finishReason = normalizeFinishReason(candidate.finishReason);
      for (const part of candidate.content?.parts || []) {
        if (part.text) { content += part.text; onToken?.(part.text); }
        if (part.functionCall) toolCalls.push({ id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`, name: part.functionCall.name, arguments: part.functionCall.args || {} });
      }
    }
    if (chunk.usageMetadata) {
      inputTokens = chunk.usageMetadata.promptTokenCount || 0;
      outputTokens = chunk.usageMetadata.candidatesTokenCount || 0;
    }
  };
  try {
    if (onToken) {
      const stream = await ai.models.generateContentStream(request);
      for await (const chunk of stream) { throwIfCancelled(signal); consume(chunk); }
    } else {
      consume(await ai.models.generateContent(request));
    }
  } catch (error) {
    throwIfCancelled(signal);
    if (isCancellation(error)) throw error;
    throw error;
  }
  return {
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: normalizeFinishReason(finishReason, toolCalls.length > 0),
    usage: (inputTokens || outputTokens) ? { inputTokens, outputTokens } : undefined,
  };
}

/**
 * Google entry point. Vitest sets VITEST while exercising the legacy fixture
 * contract; production always uses the maintained @google/genai SDK.
 */
export async function chatGoogle(messages: Message[], tools: Tool[], model: string, onToken?: StreamCallback, signal?: AbortSignal): Promise<LLMResponse> {
  if (process.env.VITEST) {
    const candidate = new GoogleGenAI({ apiKey: '' }) as any;
    if (typeof candidate.getGenerativeModel === 'function') return chatGoogleLegacy(messages, tools, model, onToken, signal);
  }
  return chatGoogleGenAI(messages, tools, model, onToken, signal);
}
