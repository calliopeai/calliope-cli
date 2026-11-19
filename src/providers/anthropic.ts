import { AnthropicBlocks } from './anthropic-blocks.js';
import { assertToolArgumentObject, assertAnthropicTerminalResponse, assertAnthropicInputUsage, assertTerminalReason } from './stream-validation.js';
import { StreamFramingWitness } from './stream-framing.js';
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
import { interruptCompletedResponse, throwUnverifiedStreamFailure } from './response-retention.js';
import { StreamProtocolError } from '../errors.js';
import type { Message, Tool, LLMResponse, ToolCall, TextContent, MessageContent } from '../types.js';
import { normalizeFinishReason, getTextContent, calculateMaxTokens, debugLog, type StreamCallback, type AdapterLimits } from './types.js';

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
 * Whether a model supports adaptive thinking. Live discovery answers this
 * (`capabilities.thinking.types.adaptive`); the name check is only the offline
 * fallback (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5). Older models (Haiku 4.5,
 * the dated -20250514 ids, Claude 3.x) do not, so we omit the parameter for
 * them to avoid a 400.
 */
function supportsAdaptiveThinking(model: string): boolean {
  const discovered = getDiscoveredModels('anthropic')?.find(m => m.id === model || m.aliases?.includes(model));
  if (discovered?.capabilities?.adaptiveThinking !== undefined) return discovered.capabilities.adaptiveThinking;
  const m = model.toLowerCase();
  return /claude-opus-(4-[678]|5)/.test(m)
    || /claude-sonnet-(4-6|5)/.test(m)
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
  const dynamicMaxTokens = calculateMaxTokens('anthropic', model, messages, tools, limits?.maxOutputTokens, streaming);
  debugLog(`Anthropic request: model=${model}, max_tokens=${dynamicMaxTokens}`);

  return {model,max_tokens:dynamicMaxTokens,system:systemInstruction,messages:anthropicMessages,
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

  const framing = limits?.retainCompletedResponse && onToken ? new StreamFramingWitness() : undefined;
  const client = new Anthropic({ apiKey, ...(framing ? { fetch: framing.fetch } : {}), baseURL: config.getBaseUrl('anthropic')?.replace(/\/v1\/?$/, ''), ...(limits?.bounded ? { maxRetries: 0 } : {}) });

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
    let terminalReasonSeen = false, messageStarted = false;
    const toolCalls: ToolCall[] = [];
    let currentToolId = '';
    const unparsedToolIds = new Set<string>();
    let currentToolName = '';
    let currentToolInput = '';
    let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';

    const blocks = limits?.retainCompletedResponse ? new AnthropicBlocks() : undefined;
    let terminalReason: string | undefined;
    let completed = false;
    const normalized = (): LLMResponse => {
      let truncatedToolCalls = false;
      let keptToolCalls = toolCalls;
      if (finishReason === 'length') {
        truncatedToolCalls = unparsedToolIds.size > 0 || Boolean(currentToolId);
        keptToolCalls = toolCalls.filter((tc) => !unparsedToolIds.has(tc.id));
      }

      if (limits?.retainCompletedResponse && finishReason !== 'length' && (unparsedToolIds.size || currentToolId))
        throw new StreamProtocolError('Malformed or incomplete provider tool arguments; its reservation remains charged.');
      const captured = blocks?.result(finishReason);
      if (captured) { keptToolCalls = captured.toolCalls; truncatedToolCalls = captured.truncatedToolCalls; }
      return {
        content: finishReason === 'error' ? content : captured?.content ?? content,
        toolCalls: finishReason !== 'error' && keptToolCalls.length > 0 ? keptToolCalls : undefined,
        finishReason,
        ...(truncatedToolCalls ? { truncatedToolCalls: true } : {}),
        ...(finishReason === 'error' ? { errorCode: 'refusal' as const } : {}),
        usage: limits?.bounded && (!inputUsageSeen || !outputUsageSeen) ? undefined : { inputTokens, outputTokens },
      };
    };
    try {
      const stream = await client.messages.stream(request, signal ? { signal } : undefined);

      for await (const event of stream) {
        if(limits?.retainCompletedResponse){
          if(completed)throw new StreamProtocolError('Anthropic data followed terminal proof; its reservation remains charged.');
          if(event.type==='message_start'){
            if (!event.message || event.message.role !== 'assistant' || !Array.isArray(event.message.content) || event.message.content.length)
              throw new StreamProtocolError('Invalid Anthropic stream message; its reservation remains charged.');
            if(messageStarted)throw new StreamProtocolError('Anthropic message restarted within one response; its reservation remains charged.');
            messageStarted=true;
            if(event.message.usage){assertAnthropicInputUsage(event.message.usage);if(!Number.isSafeInteger(event.message.usage.output_tokens)||event.message.usage.output_tokens<0)throw new StreamProtocolError('Invalid Anthropic starting usage; its reservation remains charged.');outputTokens=event.message.usage.output_tokens;}
          }
          if(event.type==='message_delta'){
            if(event.delta?.stop_reason!=null){assertTerminalReason(event.delta.stop_reason,'anthropic');if(terminalReasonSeen && terminalReason!==event.delta.stop_reason)throw new StreamProtocolError('Anthropic completion reason changed; its reservation remains charged.');terminalReason=event.delta.stop_reason;terminalReasonSeen=true;}
            if(event.usage && (!Number.isSafeInteger(event.usage.output_tokens) || event.usage.output_tokens<outputTokens))
              throw new StreamProtocolError('Invalid or regressed Anthropic usage; its reservation remains charged.');
          }
          if(event.type==='message_stop'&&!terminalReasonSeen)throw new StreamProtocolError('Missing Anthropic completion reason; its reservation remains charged.');
        }
        if (blocks && event.type.startsWith('content_block_')) {
          if (!messageStarted || terminalReasonSeen) throw new StreamProtocolError('Anthropic block outside its message; its reservation remains charged.');
          if (event.type === 'content_block_start') blocks.start(event.index, event.content_block);
          else if (event.type === 'content_block_delta') blocks.delta(event.index, event.delta);
          else if (event.type === 'content_block_stop') blocks.stop(event.index);
        }
        if (event.type === 'content_block_start') {
          if (!blocks && event.content_block.type === 'tool_use') {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInput = '';
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const text = event.delta.text;
            content += text;
            onToken(text);
          } else if (!blocks && event.delta.type === 'input_json_delta') {
            currentToolInput += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop') {
          if (!blocks && currentToolId && currentToolName) {
            try {
              const parsed = JSON.parse(currentToolInput || '{}');
              if (limits?.retainCompletedResponse) assertToolArgumentObject(parsed);
              toolCalls.push({
                id: currentToolId,
                name: currentToolName,
                arguments: parsed,
              });
            } catch {
              unparsedToolIds.add(currentToolId);
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
          if (event.delta.stop_reason) finishReason = normalizeFinishReason(event.delta.stop_reason);
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
        } else if (event.type === 'message_stop') {
          completed = true;
        } else if (event.type === 'message_start' && event.message.usage) {
          inputTokens = event.message.usage.input_tokens + (event.message.usage.cache_creation_input_tokens || 0) + (event.message.usage.cache_read_input_tokens || 0);
          inputUsageSeen = typeof event.message.usage.input_tokens === 'number';
        }
      }

      if (limits?.retainCompletedResponse && !completed) throw new StreamProtocolError('Anthropic stream ended without terminal proof; its reservation remains charged.');
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
      debugLog('Anthropic streaming failed:', errMsg);
      throw streamError;
    }
  }

  const response = await client.messages.create(request, signal ? { signal } : undefined);
  if(limits?.retainCompletedResponse)assertAnthropicTerminalResponse(response);

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
  let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = normalizeFinishReason(response.stop_reason);
  if (response.stop_reason === 'tool_use') {
    finishReason = 'tool_use';
  } else if (response.stop_reason === 'max_tokens') {
    finishReason = 'length';
  } else if (response.stop_reason === 'refusal') {
    // Safety classifier declined the request (#147) — content is empty/partial.
    finishReason = 'error';
    if (!content) content = '[Request refused by the safety classifier]';
  }

  // Output limit inside a tool block: the cut-off call must not run (#487).
  let truncatedToolCalls = false;
  if (finishReason === 'length' && response.content[response.content.length - 1]?.type === 'tool_use') {
    toolCalls.pop();
    truncatedToolCalls = true;
  }

  return {
    content,
    toolCalls: finishReason !== 'error' && toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    ...(truncatedToolCalls ? { truncatedToolCalls: true } : {}),
    ...(response.stop_reason === 'refusal' ? { errorCode: 'refusal' as const } : {}),
    usage: response.usage ? {
      inputTokens: response.usage.input_tokens + (response.usage.cache_creation_input_tokens || 0) + (response.usage.cache_read_input_tokens || 0),
      outputTokens: response.usage.output_tokens,
    } : undefined,
  };
}
