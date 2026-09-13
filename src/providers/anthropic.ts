/**
 * Anthropic Claude Provider
 */

import Anthropic from '@anthropic-ai/sdk';
import {createHash} from 'node:crypto';
import {getDiscoveredModels} from '../model-detection.js';
import {isReasoningEffort} from '../models/index.js';
import {ExecutionLimitError} from '../execution/types.js';
import {validateInputCount,type InputCount} from '../execution/billing.js';
import { isCancellation, throwIfCancelled } from '../cancellation.js';
import * as config from '../config.js';
import type { Message, Tool, LLMResponse, ToolCall, TextContent, MessageContent } from '../types.js';
import { getTextContent, calculateMaxTokens, limitOutputTokens, debugLog, type StreamCallback, type AdapterLimits } from './types.js';

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

/** Rechecked before admission and after its asynchronous reservation boundary. */
export function assertAnthropicEffort(model:string,effort:AdapterLimits['reasoningEffort']):void {
  if (effort !== undefined) {
    const discovered = getDiscoveredModels('anthropic')?.find(m => m.id === model || m.aliases?.includes(model));
    if (!isReasoningEffort(effort) || !discovered?.reasoningEfforts?.includes(effort))
      throw new ExecutionLimitError('authority', 'Live discovery does not confirm the requested reasoning effort; refresh models or remove the explicit effort setting.');
  }
}

function prepareAnthropicRequest(messages:Message[],tools:Tool[],model:string,streaming:boolean,limits?:AdapterLimits):Anthropic.MessageCreateParamsNonStreaming {
  assertAnthropicEffort(model,limits?.reasoningEffort);
  // Extract system message
  const systemInstruction = messages.filter(m => m.role === 'system').map(m => getTextContent(m.content)).join('\n\n');
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
  const dynamicMaxTokens = limitOutputTokens(calculateMaxTokens('anthropic', model, messages, tools), limits?.maxOutputTokens);
  debugLog(`Anthropic request: model=${model}, max_tokens=${dynamicMaxTokens}`);

  return {model,max_tokens:streaming?dynamicMaxTokens:Math.min(dynamicMaxTokens,8192),system:systemInstruction,messages:anthropicMessages,
    tools:anthropicTools.length?anthropicTools:undefined,...(thinking?{thinking}:{}),
    ...(limits?.reasoningEffort !== undefined ? {output_config:{effort:limits.reasoningEffort}} : {})};
}
function requestHash(request:Anthropic.MessageCreateParamsNonStreaming,streaming:boolean):string {
  return createHash('sha256').update(JSON.stringify({request,streaming})).digest('hex');
}
/** Free preflight on the exact selected model; never reuse a different model's tokenizer. */
export async function countAnthropicInput(messages:Message[],tools:Tool[],model:string,streaming:boolean,signal?:AbortSignal,limits?:AdapterLimits):Promise<InputCount> {
  throwIfCancelled(signal);
  const apiKey=config.getApiKey('anthropic');if(!apiKey)throw new Error('Anthropic API key not configured');
  const request=prepareAnthropicRequest(messages,tools,model,streaming,limits);
  const hash=requestHash(request,streaming),{max_tokens:_,...input}=request;
  const client=new Anthropic({apiKey,baseURL:config.getBaseUrl('anthropic')?.replace(/\/v1\/?$/,''),maxRetries:0,timeout:15000});
  const result=await client.messages.countTokens(input,{signal});
  throwIfCancelled(signal);
  return validateInputCount({version:1,method:'anthropic-count-tokens',requestHash:hash,inputTokens:result.input_tokens,at:Date.now()});
}

/**
 * Chat with Anthropic Claude
 */
export async function chatAnthropic(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback,
  signal?: AbortSignal,
  limits?: AdapterLimits
): Promise<LLMResponse> {
  const apiKey = config.getApiKey('anthropic');
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const client = new Anthropic({ apiKey, baseURL: config.getBaseUrl('anthropic')?.replace(/\/v1\/?$/, ''), ...(limits?.bounded ? { maxRetries: 0 } : {}) });

  const request=prepareAnthropicRequest(messages,tools,model,!!onToken,limits);
  if(limits?.inputCount){
    const count=validateInputCount(limits.inputCount);
    if(count.requestHash!==requestHash(request,!!onToken)||count.at>Date.now()+1000||Date.now()-count.at>60000)
      throw new ExecutionLimitError('authority','Anthropic request changed after token counting.');
  }
  throwIfCancelled(signal);

  // Use streaming if callback provided - handles both text and tool calls
  if (onToken) {
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let inputUsageSeen = false, outputUsageSeen = false;
    const toolCalls: ToolCall[] = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';
    let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';

    try {
      const stream = await client.messages.stream(request, signal ? { signal } : undefined);

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
            outputUsageSeen = typeof event.usage.output_tokens === 'number';
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
          inputTokens = event.message.usage.input_tokens + (event.message.usage.cache_creation_input_tokens || 0) + (event.message.usage.cache_read_input_tokens || 0);
          inputUsageSeen = typeof event.message.usage.input_tokens === 'number';
        }
      }

      return {
        content,
        toolCalls: finishReason !== 'error' && toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        ...(finishReason === 'error' ? { errorCode: 'refusal' as const } : {}),
        usage: limits?.bounded && (!inputUsageSeen || !outputUsageSeen) ? undefined : { inputTokens, outputTokens },
      };
    } catch (streamError) {
      throwIfCancelled(signal);
      if (isCancellation(streamError)) throw streamError;
      // Keep diagnostics out of assistant tokens; shared retry handling owns errors.
      const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
      debugLog('Anthropic streaming failed:', errMsg);
      throw streamError;
    }
  }

  const response = await client.messages.create(request, signal ? { signal } : undefined);

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
    toolCalls: finishReason !== 'error' && toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    ...(response.stop_reason === 'refusal' ? { errorCode: 'refusal' as const } : {}),
    usage: response.usage ? {
      inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens || 0) + (response.usage.cache_read_input_tokens || 0),
      outputTokens: response.usage.output_tokens,
    } : undefined,
  };
}
