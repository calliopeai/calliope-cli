/**
 * Google Gemini Provider
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import * as config from '../config.js';
import type { Message, Tool, LLMResponse, ToolCall } from '../types.js';
import { getTextContent, debugLog, type StreamCallback } from './types.js';

/**
 * Chat with Google Gemini
 */
export async function chatGoogle(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('google');
  if (!apiKey) throw new Error('Google API key not configured');

  const genAI = new GoogleGenerativeAI(apiKey);

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

  // Build history (exclude last message)
  // Handle tool result messages as functionResponse parts for Gemini
  const history: Array<{ role: string; parts: any[] }> = [];
  for (const m of messages.slice(0, -1)) {
    if (m.role === 'system') continue; // system handled via systemInstruction
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

  // Use streaming if callback provided
  if (onToken) {
    let content = '';
    const toolCalls: ToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const streamResult = await chat.sendMessageStream(lastMessageParts);

      for await (const chunk of streamResult.stream) {
        // Extract text from streamed chunks
        const candidates = chunk.candidates || [];
        for (const candidate of candidates) {
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
        finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
        usage: (inputTokens || outputTokens) ? { inputTokens, outputTokens } : undefined,
      };
    } catch (streamError) {
      // Surface the streaming failure and re-throw so withRetry handles it
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      debugLog('Google streaming failed:', errMsg);
      onToken(`\n[Streaming error: ${errMsg}]\n`);
      throw streamError;
    }
  }

  // Non-streaming request
  const result = await chat.sendMessage(lastMessageParts);
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
    finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
    usage: response.usageMetadata ? {
      inputTokens: response.usageMetadata.promptTokenCount || 0,
      outputTokens: response.usageMetadata.candidatesTokenCount || 0,
    } : undefined,
  };
}
