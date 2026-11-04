import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import * as config from '../src/config.js';
import { ChatGPTStore, ChatGPTQuotaError, fallbackPolicy, validateFallbackPolicy, openQuotaCircuit, quotaCircuit, publicFallbackHistory, fallbackHistory, runFallbackCommand, withAPIKeyAccess } from '../src/auth/chatgpt/index.js';
import { chatGPTSelected, chatChatGPT, chatGPTModels } from '../src/providers/chatgpt.js';
import type { Message } from '../src/types.js';
const policy = { model: 'gpt-test', maxProjectCostUsd: 1, maxOutputTokens: 100, cooldownSeconds: 3600 };
const store = new ChatGPTStore();
beforeEach(async () => {
  config.resetConfig(); config.set('budget', {}); config.setProviderCred('openai', { accessMethod: 'chatgpt', apiKey: 'api-key' });
  rmSync(store.directory, { recursive: true, force: true });
  await store.update(s => { s.active = 'oaiapp_test'; s.accounts.oaiapp_test = { clientId: 'oaiapp_test', subject: 'user', accessToken: 'plan-token', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] }; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); config.resetConfig(); rmSync(store.directory, { recursive: true, force: true }); });
it('defaults to no paid fallback and validates all policy bounds', () => {
  expect(fallbackPolicy()).toBeUndefined();
  expect(validateFallbackPolicy(policy)).toEqual(policy);
  for (const patch of [{ model: '' }, { model: 'bad\nmodel' }, { maxProjectCostUsd: 0 }, { maxProjectCostUsd: Infinity }, { maxProjectCostUsd: 1000001 }, { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 }, { cooldownSeconds: 0 }, { cooldownSeconds: 86401 }]) expect(() => validateFallbackPolicy({ ...policy, ...patch })).toThrow('Invalid');
});
it('isolates concurrent API access without changing the saved selection', async () => {
  const outcomes = await Promise.all([withAPIKeyAccess(async () => { await Promise.resolve(); return chatGPTSelected(); }), Promise.resolve(chatGPTSelected())]);
  expect(outcomes).toEqual([false, true]); expect(chatGPTSelected()).toBe(true);
});
it('persists a quota circuit across store instances and expires without resetting billing', async () => {
  await openQuotaCircuit('oaiapp_test', 'quota');
  const breaker = quotaCircuit(new ChatGPTStore())!;
  expect(breaker.reason).toBe('quota'); expect(breaker.until - Date.now()).toBeGreaterThan(3500000);
  expect(quotaCircuit(store, breaker.until)).toBeUndefined(); expect(chatGPTSelected()).toBe(true);
});
it('uses a short rate-limit cooldown and never poisons another account', async () => {
  await openQuotaCircuit('oaiapp_test', 'rate-limit'); expect(quotaCircuit()!.until - Date.now()).toBeLessThanOrEqual(60000);
  await openQuotaCircuit('oaiapp_missing', 'quota'); expect(quotaCircuit()!.reason).toBe('rate-limit');
});
it('rejects a corrupt persistent circuit', async () => {
  await store.update(s => { s.accounts.oaiapp_test!.quotaCircuit = { reason: 'quota', until: NaN }; });
  expect(() => store.read()).toThrow('unreadable');
});
it('fails before any network request while the circuit is open', async () => {
  await openQuotaCircuit('oaiapp_test', 'quota'); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(chatChatGPT([{ role: 'user', content: 'hello' }], [], 'gpt-test')).rejects.toBeInstanceOf(ChatGPTQuotaError);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([['subscription_sharing_usage_limit_exceeded', 'quota'], ['rate_limit_exceeded', 'rate-limit']])('records HTTP quota error %s without leaking upstream text', async (code, reason) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ models: [{ slug: 'gpt-test', display_name: 'M', visibility: 'list' }] })).mockResolvedValueOnce(Response.json({ error: { code, message: 'SECRET' } }, { status: 429 })));
  await expect(chatChatGPT([{ role: 'user', content: 'hello' }], [], 'gpt-test')).rejects.toThrow(/ChatGPT/);
  expect(quotaCircuit()!.reason).toBe(reason);
});
it('records discovery throttling so runtime can choose the paid route before inference', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 })));
  await expect(chatGPTModels()).rejects.toBeInstanceOf(ChatGPTQuotaError); expect(quotaCircuit()!.reason).toBe('quota');
});
it('marks streamed quota errors after visible output as unsafe to replay', async () => {
  const events = [{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ models: [{ slug: 'gpt-test', display_name: 'M', visibility: 'list' }] })).mockResolvedValueOnce(new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })));
  await expect(chatChatGPT([{ role: 'user', content: 'hello' }], [], 'gpt-test')).rejects.toMatchObject({ partial: true, reason: 'quota' });
});
const history: Message[] = [{ role: 'assistant', content: 'Reading', toolCalls: [{ id: 'call', name: 'read_file', arguments: { path: 'ok' } }], providerMetadata: { openai: { chatgpt: { clientId: 'oaiapp_test', model: 'plan-model', output: [{ type: 'reasoning', encrypted_content: 'PRIVATE' }] } }, calliopeRouting: { provider: 'openai', model: 'plan-model' } } }, { role: 'tool', toolCallId: 'call', content: 'hello' }];
it('preserves visible tool context, strips opaque state and pins paid history', () => {
  const copy = publicFallbackHistory(history, 'oaiapp_test', 'gpt-test');
  expect(JSON.stringify(copy)).not.toContain('PRIVATE'); expect(copy[0]!.toolCalls).toEqual(history[0]!.toolCalls); expect(copy[1]!.toolCallId).toBe('call');
  expect(fallbackHistory(copy)).toEqual({ clientId: 'oaiapp_test', model: 'gpt-test' }); expect(JSON.stringify(history)).toContain('PRIVATE');
  expect(() => publicFallbackHistory(copy, 'oaiapp_other', 'gpt-test')).toThrow('changed');
  expect(() => publicFallbackHistory(copy, 'oaiapp_test', 'different')).toThrow('changed');
});
it('refuses other account and other provider state', () => {
  expect(() => publicFallbackHistory(history, 'oaiapp_other', 'gpt-test')).toThrow('different account');
  expect(() => publicFallbackHistory([{ role: 'assistant', content: '', providerMetadata: { anthropic: {} } }], 'oaiapp_test', 'gpt-test')).toThrow('Other provider');
});
it('offers explicit enable/status/reset/disable controls without changing billing selection', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runFallbackCommand(['enable', 'gpt-test', '2', '100']); expect(fallbackPolicy()).toEqual({ ...policy, maxProjectCostUsd: 2 });
  await openQuotaCircuit('oaiapp_test', 'quota'); await runFallbackCommand(['status']); expect(output).toHaveBeenLastCalledWith(expect.stringContaining('"enabled": true'));
  await runFallbackCommand(['reset']); expect(quotaCircuit()).toBeUndefined();
  await runFallbackCommand(['disable']); expect(fallbackPolicy()).toBeUndefined(); expect(chatGPTSelected()).toBe(true);
});
it('does not save invalid configuration or accept unknown commands', async () => {
  await expect(runFallbackCommand(['enable', 'gpt-test', 'NaN'])).rejects.toThrow('Invalid'); expect(fallbackPolicy()).toBeUndefined();
  await expect(runFallbackCommand(['unknown'])).rejects.toThrow('Usage');
});
