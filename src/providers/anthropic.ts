/**
 * Anthropic Claude Provider
 */

import Anthropic from '@anthropic-ai/sdk';
import * as config from '../config.js';
import type { Message, Tool, LLMResponse, ToolCall, TextContent, MessageContent } from '../types.js';
import { getTextContent, calculateMaxTokens, debugLog, type StreamCallback } from './types.js';

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
 * Whether a model supports adaptive thinking (Opus 4.6+, Sonnet 4.6, Fable/Mythos 5).
 * Older models (Haiku 4.5, the dated -20250514 ids, Claude 3.x) do not, so we
 * omit the parameter for them to avoid a 400.
 */
function supportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  return /claude-opus-4-[678]/.test(m)
    || m.includes('claude-sonnet-4-6')
    || m.includes('claude-fable-5')
    || m.includes('claude-mythos-5');
}

/**
 * Chat with Anthropic Claude
 */
export async function chatAnthropic(
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

  // Adaptive thinking improves agentic/coding quality on the models that support it (#147).
  const thinking = supportsAdaptiveThinking(model)
    ? { type: 'adaptive' as const }
    : undefined;

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

  // Calculate dynamic max_tokens based on available context space
  const dynamicMaxTokens = calculateMaxTokens('anthropic', model, messages, tools);
  debugLog(`Anthropic request: model=${model}, max_tokens=${dynamicMaxTokens}`);

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
        max_tokens: dynamicMaxTokens,
        system: systemMessage ? getTextContent(systemMessage.content) : '',
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        ...(thinking ? { thinking } : {}),
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
          } else if (event.delta.stop_reason === 'refusal') {
            // Safety classifier declined mid-stream (#147); discard the partial.
            finishReason = 'error';
            content = '[Request refused by the safety classifier]';
            onToken('\n[Request refused by the safety classifier]\n');
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
      // Surface the streaming failure and re-throw so withRetry handles it
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      debugLog('Anthropic streaming failed:', errMsg);
      onToken(`\n[Streaming error: ${errMsg}]\n`);
      throw streamError;
    }
  }

  // Non-streaming request. The SDK rejects create() when max_tokens is large
  // enough to risk the 10-minute request timeout — and output caps are now
  // model-aware (up to 64K-128K, #144). Cap the non-streaming path at a safe
  // ceiling; the interactive streaming path above keeps the full model output.
  const NONSTREAM_MAX_TOKENS = 8192;
  const response = await client.messages.create({
    model,
    max_tokens: Math.min(dynamicMaxTokens, NONSTREAM_MAX_TOKENS),
    system: systemMessage ? getTextContent(systemMessage.content) : '',
    messages: anthropicMessages,
    tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    ...(thinking ? { thinking } : {}),
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
  } else if (response.stop_reason === 'refusal') {
    // Safety classifier declined the request (#147) — content is empty/partial.
    finishReason = 'error';
    if (!content) content = '[Request refused by the safety classifier]';
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
