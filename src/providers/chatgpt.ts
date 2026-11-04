import OpenAI from 'openai';
import { apiKeyAccessActive, ChatGPTQuotaError, quotaCircuit, openQuotaCircuit } from '../auth/chatgpt/fallback.js';
import * as config from '../config.js';
import { ChatGPTStore, accessToken, RESOURCE, ChatGPTAuthError } from '../auth/chatgpt/index.js';
import type { Message, Tool, LLMResponse } from '../types.js';
import type { ModelInfo } from '../models/index.js';
import { ExecutionLimitError } from '../execution/types.js';
import { StreamProtocolError } from '../errors.js';
import { throwIfCancelled } from '../cancellation.js';
import type { AdapterLimits, StreamCallback } from './types.js';
export function chatGPTSelected(): boolean { return !apiKeyAccessActive() && config.getProviderCred('openai').accessMethod === 'chatgpt'; }
export function chatGPTAccountKey(): string { const a = new ChatGPTStore().active(); return a?.accessToken ? a.clientId : 'signed-out'; }
export function assertChatGPTLimits(limits?: AdapterLimits): void {
  const budget = config.get('budget');
  if (limits?.bounded || limits?.maxOutputTokens !== undefined || budget?.maxCostPerRun !== undefined || budget?.maxCostPerProject !== undefined)
    throw new ExecutionLimitError('authority', 'ChatGPT plan access cannot enforce API dollar budgets or output-token caps. Explicitly select API-key access for bounded runs.');
}
export async function chatGPTModels(signal?: AbortSignal): Promise<ModelInfo[]> {
  const credential = await accessToken(undefined, signal);
  const response = await fetch(`${RESOURCE}/models`, { redirect: 'error', headers: { Authorization: `Bearer ${credential.token}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { code?: string } };
    const failure = subscriptionFailure(body.error?.code, response.status);
    if (failure instanceof ChatGPTQuotaError) { await openQuotaCircuit(credential.clientId, failure.reason); throw failure; }
    throw new ChatGPTAuthError(`ChatGPT model discovery failed (HTTP ${response.status}).`);
  }
  const body = await response.json() as { models?: { slug: string; display_name: string; visibility: string }[] };
  if (!Array.isArray(body.models)) throw new ChatGPTAuthError('Invalid ChatGPT model catalog.');
  if (chatGPTAccountKey() !== credential.clientId) throw new ChatGPTAuthError('ChatGPT account changed during model discovery.');
  return body.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string' && !!m.slug && typeof m.display_name === 'string').map(m => ({ id: m.slug, name: m.display_name, description: 'ChatGPT plan usage', evidence: { source: 'live', at: new Date().toISOString() } }));
}
export function chatGPTInput(messages: Message[], account?: string, model?: string): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInput = [];
  for (const m of messages) {
    const saved = (m.providerMetadata?.openai as { chatgpt?: { clientId: string; model: string; output: OpenAI.Responses.ResponseOutputItem[] } } | undefined)?.chatgpt;
    if (saved) {
      if (m.role !== 'assistant' || saved.clientId !== account || saved.model !== model || !Array.isArray(saved.output)) throw new ChatGPTAuthError('ChatGPT history belongs to a different account or model. Start a new session.');
      for (const item of saved.output) {
        if (item.type !== 'message' && item.type !== 'function_call' && item.type !== 'reasoning') throw new ChatGPTAuthError('Unsupported ChatGPT history item. Start a new session.');
        input.push(item);
      }
      continue;
    }
    if (m.role === 'tool') {
      if (!m.toolCallId) throw new StreamProtocolError('Tool history is missing a call ID.');
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    } else {
      const text = typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (m.role === 'user') input.push({ role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map(b => b.type === 'text' ? { type: 'input_text' as const, text: b.text } : { type: 'input_image' as const, image_url: `data:${b.mediaType};base64,${b.data}`, detail: 'auto' as const }) });
      else if (text) input.push({ role: m.role === 'system' ? 'developer' : 'assistant', content: text });
      for (const t of m.toolCalls ?? []) input.push({ type: 'function_call', namespace: 'calliope', call_id: t.id, name: t.name, arguments: JSON.stringify(t.arguments) });
    }
  }
  return input;
}

function subscriptionFailure(code: unknown, status?: number, partial = false): StreamProtocolError {
  if (code === 'subscription_sharing_usage_limit_exceeded' || code === 'insufficient_quota') return new ChatGPTQuotaError('quota', partial);
  if (status === 429 || code === 'rate_limit_exceeded') return new ChatGPTQuotaError('rate-limit', partial);
  const recovery: Record<string, string> = {
    subscription_sharing_usage_limit_exceeded: 'ChatGPT plan usage limit reached. Wait for the limit to reset or explicitly select another billing method.',
    subscription_sharing_usage_unavailable: 'ChatGPT plan usage is currently unavailable. Check plan settings and retry later.',
    subscription_sharing_unsupported_capability: 'This request uses a capability unsupported by ChatGPT plan access.',
    subscription_sharing_invalid_user: 'ChatGPT could not validate this session. Sign in again.',
    chatpass_v2_scope_not_authorized: 'ChatGPT plan permission is missing. Sign in again and enable plan usage.',
  };
  return new StreamProtocolError(typeof code === 'string' && Object.hasOwn(recovery, code) ? recovery[code]! : 'ChatGPT subscription request failed or was incomplete. Check plan availability or sign in again.');
}

export async function chatChatGPT(messages: Message[], tools: Tool[], model: string, onToken?: StreamCallback, signal?: AbortSignal, limits?: AdapterLimits): Promise<LLMResponse> {
  assertChatGPTLimits(limits); throwIfCancelled(signal);
  const circuit = quotaCircuit();
  if (circuit) throw new ChatGPTQuotaError(circuit.reason);
  const credential = await accessToken(undefined, signal);
  const models = await chatGPTModels(signal);
  if (!models.some(m => m.id === model)) throw new ChatGPTAuthError('Selected model is not available to this ChatGPT account. Refresh the model picker.');
  if (chatGPTAccountKey() !== credential.clientId) throw new ChatGPTAuthError('ChatGPT account changed before inference.');
  const client = new OpenAI({ apiKey: credential.token, baseURL: RESOURCE, maxRetries: 0,
    // Disallow credential forwarding through redirects and suppress SDK debug output.
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }), logLevel: 'off' });
  const request: OpenAI.Responses.ResponseCreateParamsStreaming = { model, store: false, stream: true, input: chatGPTInput(messages, credential.clientId, model), include: ['reasoning.encrypted_content'],
    ...(tools.length ? { tools: [{ type: 'namespace', name: 'calliope', description: 'Calliope AI runtime tools', tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })) }] } : {}),
    ...(limits?.reasoningEffort ? { reasoning: { effort: limits.reasoningEffort } } : {}) };
  let completed: OpenAI.Responses.Response | undefined;
  let partial = false;
  try {
    const stream = await client.responses.create(request, { signal });
    for await (const event of stream) {
      throwIfCancelled(signal);
      if (event.type === 'response.output_text.delta') { partial ||= !!event.delta; onToken?.(event.delta); }
      if (event.type === 'response.failed' || event.type === 'response.incomplete') throw subscriptionFailure(event.response?.error?.code, undefined, partial);
      if (event.type === 'error') throw subscriptionFailure(event.code, undefined, partial);
      if (event.type === 'response.completed') completed = event.response;
    }
  } catch (error) {
    throwIfCancelled(signal);
    const failure = error instanceof OpenAI.APIError ? subscriptionFailure(error.code, error.status, partial) : error;
    if (failure instanceof ChatGPTQuotaError) await openQuotaCircuit(credential.clientId, failure.reason);
    if (failure instanceof StreamProtocolError) throw failure;
    throw new StreamProtocolError('ChatGPT subscription request failed. Check your connection, plan limits and sign-in status.');
  }
  throwIfCancelled(signal);
  if (!completed || completed.status !== 'completed') throw new StreamProtocolError('ChatGPT stream ended without successful completion.');
  const toolCalls: NonNullable<LLMResponse['toolCalls']> = [];
  let content = '';
  for (const item of completed.output) {
    if (item.type === 'message') for (const part of item.content) {
      if (part.type === 'refusal') return { content: '', finishReason: 'error', errorCode: 'refusal', billing: 'subscription', usage: completed.usage ? { inputTokens: completed.usage.input_tokens, outputTokens: completed.usage.output_tokens } : undefined };
      if (part.type === 'output_text') content += part.text;
    }
    if (item.type === 'function_call') {
      if (item.namespace !== 'calliope' || !tools.some(t => t.name === item.name)) throw new StreamProtocolError('ChatGPT returned an unknown tool.');
      let args: unknown; try { args = JSON.parse(item.arguments); } catch { throw new StreamProtocolError('ChatGPT returned malformed tool arguments.'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new StreamProtocolError('ChatGPT returned invalid tool arguments.');
      toolCalls.push({ id: item.call_id, name: item.name, arguments: args as Record<string, unknown> });
    }
  }
  return { content, providerMetadata: { openai: { chatgpt: { clientId: credential.clientId, model, output: completed.output } } }, ...(toolCalls.length ? { toolCalls } : {}), finishReason: toolCalls.length ? 'tool_use' : 'stop', billing: 'subscription',
    usage: completed.usage ? { inputTokens: completed.usage.input_tokens, outputTokens: completed.usage.output_tokens } : undefined,
    warnings: ['ChatGPT plan usage: USD totals exclude subscription consumption; plan limits are managed by ChatGPT.'] };
}
