import type { LLMResponse, Tool, ToolCall, Message, LLMProvider } from '../types.js';
import { cancellable, throwIfCancelled } from '../cancellation.js';
import { ExecutionLimitError } from '../execution/types.js';
import { hostCallback } from './host-callback.js';
import { isLocalBackend, detectMalformedToolCall, buildRepairMessage, buildToolCallEnvelopeSchema, extractRepairedToolCall, getLocalModelProfile } from '../local-model.js';

export interface RepairEvent { call: ToolCall; reason: string; status: 'started' | 'ok' | 'error'; corrected?: ToolCall }

/** One correction per malformed call ID, shared by every client. */
export async function repairToolCalls(options: {
  provider: LLMProvider; model: string; messages: Message[]; tools: Tool[];
  response: LLMResponse; repairedIds: Set<string>; signal?: AbortSignal;
  request: (messages: Message[], format?: unknown) => Promise<LLMResponse>;
  onRepair?: (event: RepairEvent) => void;
}): Promise<LLMResponse> {
  const { response, tools, repairedIds, signal } = options;
  if (!response.toolCalls?.length || !isLocalBackend(options.provider)) return response;
  for (const call of response.toolCalls) {
    if (repairedIds.has(call.id)) continue;
    const fault = detectMalformedToolCall(call, tools);
    if (!fault) continue;
    repairedIds.add(call.id);
    await hostCallback('onRepair', () => options.onRepair?.({ call, reason: fault.reason, status: 'started' }));
    let format: unknown;
    try {
      const profile = await cancellable(getLocalModelProfile(options.provider, options.model), signal);
      if (profile.supportsJsonSchemaFormat) format = buildToolCallEnvelopeSchema(tools.map(tool => tool.name));
    } catch { throwIfCancelled(signal); }
    const messages: Message[] = [
      ...options.messages,
      { role: 'assistant', content: response.content, toolCalls: response.toolCalls },
      ...response.toolCalls.map(tool => ({ role: 'tool' as const, toolCallId: tool.id, content: '[Not executed: correcting a malformed tool call.]' })),
      { role: 'user', content: buildRepairMessage(call, { reason: fault.reason }) },
    ];
    let repaired: LLMResponse;
    try {
      repaired = await options.request(messages, format);
      throwIfCancelled(signal);
    } catch (error) {
      throwIfCancelled(signal);
      if (error instanceof ExecutionLimitError) throw error;
      // The runtime's budget signal must stop the turn, not become a repair failure.
      if (error instanceof Error && error.name === 'RuntimeBudgetExceeded') throw error;
      await hostCallback('onRepair', () => options.onRepair?.({ call, reason: fault.reason, status: 'error' }));
      return response;
    }
    const corrected = extractRepairedToolCall(repaired.content, repaired.toolCalls, call.id);
    const bad = corrected ? detectMalformedToolCall(corrected, tools) : fault;
    await hostCallback('onRepair', () => options.onRepair?.({ call, reason: bad?.reason || fault.reason, status: corrected && !bad ? 'ok' : 'error', corrected: corrected ?? undefined }));
    return corrected ? { ...response, toolCalls: response.toolCalls.map(tool => tool.id === call.id ? corrected : tool) } : response;
  }
  return response;
}
