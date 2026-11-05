import { AsyncLocalStorage } from 'node:async_hooks';
import * as config from '../../config.js';
import { StreamProtocolError } from '../../errors.js';
import type { Message } from '../../types.js';
import { ChatGPTStore } from './store.js';
import { ChatGPTAuthError } from './protocol.js';

const apiAccess = new AsyncLocalStorage<boolean>();
export const apiKeyAccessActive = () => apiAccess.getStore() === true;
export const withAPIKeyAccess = <T>(action: () => T): T => apiAccess.run(true, action);
export interface ChatGPTFallbackPolicy { model: string; maxProjectCostUsd: number; maxOutputTokens: number; cooldownSeconds: number }
export class ChatGPTQuotaError extends StreamProtocolError {
  constructor(readonly reason: 'quota' | 'rate-limit', readonly partial = false) {
    super(reason === 'quota' ? 'ChatGPT plan usage limit reached. Subscription inference is paused; configure API-key fallback or wait for the cooldown.' : 'ChatGPT rate limit reached. Subscription inference is paused until the cooldown.');
    this.name = 'ChatGPTQuotaError';
  }
}
export function fallbackPolicy(): ChatGPTFallbackPolicy | undefined {
  const p = config.get('chatgptFallback');
  return p == null ? undefined : validateFallbackPolicy(p);
}
export function validateFallbackPolicy(p: ChatGPTFallbackPolicy): ChatGPTFallbackPolicy {
  if (!p || typeof p.model !== 'string' || !p.model.trim() || p.model.length > 512 || /[\x00-\x20\x7f]/.test(p.model) ||
      !Number.isFinite(p.maxProjectCostUsd) || p.maxProjectCostUsd <= 0 || p.maxProjectCostUsd > 1000000 ||
      !Number.isSafeInteger(p.maxOutputTokens) || p.maxOutputTokens < 1 || p.maxOutputTokens > 100000000 ||
      !Number.isSafeInteger(p.cooldownSeconds) || p.cooldownSeconds < 1 || p.cooldownSeconds > 86400 ||
      Object.keys(p).some(k => !['model','maxProjectCostUsd','maxOutputTokens','cooldownSeconds'].includes(k)))
    throw new ChatGPTAuthError('Invalid ChatGPT fallback configuration. Configure it again before using paid fallback.');
  return { ...p };
}
export function quotaCircuit(store = new ChatGPTStore(), now = Date.now()) {
  const breaker = store.active()?.quotaCircuit;
  return breaker && breaker.until > now ? { ...breaker } : undefined;
}
export async function openQuotaCircuit(clientId: string, reason: 'quota' | 'rate-limit', store = new ChatGPTStore()) {
  const configured = config.get('chatgptFallback')?.cooldownSeconds;
  const seconds = reason === 'rate-limit' ? 60 : Number.isSafeInteger(configured) && configured! >= 1 && configured! <= 86400 ? configured! : 3600;
  await store.update(state => {
    const a = state.accounts[clientId];
    if (a) a.quotaCircuit = { reason, until: Date.now() + seconds * 1000 };
  });
}
export function fallbackHistory(messages: Message[]): { clientId: string; model: string } | undefined {
  let found: { clientId: string; model: string } | undefined;
  for (const m of messages) {
    const marker = (m.providerMetadata?.openai as { chatgptFallback?: { clientId: string; model: string } } | undefined)?.chatgptFallback;
    if (!marker) continue;
    if (!/^oaiapp_[\w-]+$/.test(marker.clientId) || typeof marker.model !== 'string' || !marker.model ||
        found && (found.clientId !== marker.clientId || found.model !== marker.model))
      throw new ChatGPTAuthError('Inconsistent API-key fallback history. Start a new session.');
    found = { clientId: marker.clientId, model: marker.model };
  }
  return found;
}
/** Preserve visible conversation and completed tool pairs; never send encrypted plan state to an API key. */
export function publicFallbackHistory(messages: Message[], clientId: string, model: string): Message[] {
  const existing = fallbackHistory(messages);
  if (existing && (existing.clientId !== clientId || existing.model !== model)) throw new ChatGPTAuthError('Fallback account or model changed. Start a new session.');
  const result = messages.map(m => {
    const metadata = m.providerMetadata;
    if (metadata && Object.keys(metadata).some(k => k !== 'openai' && k !== 'calliopeRouting'))
      throw new ChatGPTAuthError('Other provider state cannot be converted to API-key fallback. Start a new session.');
    if (metadata?.openai && Object.keys(metadata.openai).some(k => k !== 'chatgpt' && k !== 'chatgptFallback'))
      throw new ChatGPTAuthError('Unknown OpenAI state cannot be converted to API-key fallback. Start a new session.');
    const saved = (metadata?.openai as { chatgpt?: { clientId: string } } | undefined)?.chatgpt;
    if (saved && saved.clientId !== clientId) throw new ChatGPTAuthError('ChatGPT history belongs to a different account. Start a new session.');
    const { providerMetadata: _opaque, ...publicMessage } = m;
    return structuredClone(publicMessage) as Message;
  });
  const last = result.at(-1);
  if (last) last.providerMetadata = { openai: { chatgptFallback: { clientId, model } }, calliopeRouting: { provider: 'openai', model } };
  return result;
}
export async function runFallbackCommand(args: string[], signal?: AbortSignal): Promise<void> {
  const store = new ChatGPTStore();
  if (args.length === 1 && args[0] === 'models') {
    if (!config.getApiKey('openai')) throw new ChatGPTAuthError('Configure an OpenAI API key before listing paid fallback models.');
    const { getAvailableModels } = await import('../../model-detection.js');
    const { providerTarget } = await import('../../health/index.js');
    const result = await withAPIKeyAccess(async () => ({ target: providerTarget('openai').key, models: await getAvailableModels('openai', {signal,quiet:true,throwOnError:true}) }));
    console.log(JSON.stringify(result, null, 2));
  } else if (args[0] === 'enable' && (args.length === 3 || args.length === 4)) {
    if (!config.getApiKey('openai')) throw new ChatGPTAuthError('Configure an OpenAI API key before enabling paid fallback.');
    config.set('chatgptFallback', validateFallbackPolicy({ model: args[1]!, maxProjectCostUsd: Number(args[2]), maxOutputTokens: Number(args[3] ?? 4096), cooldownSeconds: 3600 }));
    console.log('Paid OpenAI API-key fallback enabled. Each request requires live model discovery, verified billing bounds and a shared project-budget reservation. Existing project spend counts toward this cap.');
  } else if (args.length === 1 && args[0] === 'disable') {
    config.set('chatgptFallback', null); console.log('Automatic paid fallback disabled.');
  } else if (args.length === 1 && args[0] === 'reset') {
    await store.update(s => { if (s.active) delete s.accounts[s.active]!.quotaCircuit; });
    console.log('Subscription quota circuit reset. Existing API-key fallback sessions stay on the paid route; start a new session to try the plan again.');
  } else if (args.length === 1 && args[0] === 'status') {
    console.log(JSON.stringify({ enabled: !!fallbackPolicy(), policy: fallbackPolicy() ?? null, circuit: quotaCircuit(store) ?? null }, null, 2));
  } else throw new ChatGPTAuthError('Usage: calliope auth chatgpt fallback enable <api-model> <max-project-cost-usd> [max-output-tokens] | models | disable | status | reset');
}
