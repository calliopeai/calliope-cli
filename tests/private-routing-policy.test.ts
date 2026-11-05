/** Private data policy: only user-declared provider+endpoint targets are routable. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import * as modelDetection from '../src/model-detection.js';
import { clearModelCache } from '../src/model-detection.js';
import { selectRoute } from '../src/routing/index.js';
import { endpointIdentity } from '../src/health/index.js';
import { runTurn, type TurnOptions } from '../src/runtime/turn.js';
import { ChatGPTStore, openQuotaCircuit, fallbackHistory } from '../src/auth/chatgpt/index.js';
import type { Message } from '../src/types.js';
import { RunLog, readRunLog, runLogPath } from '../src/runlog.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const endpoint = (provider: string) => `https://${provider}.invalid/v1`;
let fetchSpy: ReturnType<typeof vi.fn>;
const declare = (...providers: string[]) => config.set('routing', { enabled: true, costSensitivity: 0.3, dataPolicy: 'private', privateTargets: providers.map(provider => ({ provider, endpoint: endpoint(provider) })) });

beforeEach(() => {
  config.resetConfig(); clearModelCache();
  for (const provider of config.getProviderNames()) {
    const env = config.getProviderEnvVars(provider);
    for (const name of [env.apiKey, env.baseUrl]) if (name) vi.stubEnv(name, '');
  }
  for (const provider of ['deepseek', 'xai'] as const) config.setProviderCred(provider, { apiKey: 'fake', baseUrl: endpoint(provider) });
  fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input)), provider = url.hostname.split('.')[0]!;
    return json({ data: [{ id: `${provider}-live`, capabilities: { tools: true } }] });
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { config.resetConfig(); clearModelCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('selects only declared targets automatically and excludes the rest', async () => {
  declare('deepseek');
  const decision = await selectRoute({ provider: 'auto', messages: [] });
  expect(decision.selected?.provider).toBe('deepseek');
  expect(decision.exclusions).toContainEqual({ provider: 'xai', reason: 'outside-private-policy' });
  expect(decision.exclusions.some(e => e.provider === 'deepseek' && e.reason === 'outside-private-policy')).toBe(false);
});

it('refuses an explicit undeclared selection before discovery or any request', async () => {
  declare('deepseek');
  const discovery = vi.spyOn(modelDetection, 'getAvailableModels');
  const decision = await selectRoute({ provider: 'xai', model: 'xai-live', messages: [] });
  expect(decision.selected).toBeNull();
  expect(decision.reason).toContain('outside-private-policy');
  expect(decision.exclusions).toContainEqual({ provider: 'xai', reason: 'outside-private-policy' });
  expect(discovery).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('excludes a declared provider whose endpoint changed', async () => {
  declare('deepseek', 'xai');
  config.setProviderCred('deepseek', { baseUrl: 'https://elsewhere.invalid/v1' });
  const decision = await selectRoute({ provider: 'auto', messages: [] });
  expect(decision.selected?.provider).toBe('xai');
  expect(decision.exclusions).toContainEqual({ provider: 'deepseek', reason: 'outside-private-policy' });
});

it('cannot be loosened by request preferences, pools or pins', async () => {
  declare('deepseek');
  const withPrefs = await selectRoute({ provider: 'auto', messages: [], preferences: {} as never });
  expect(withPrefs.selected?.provider).toBe('deepseek');
  expect(withPrefs.exclusions).toContainEqual({ provider: 'xai', reason: 'outside-private-policy' });
  const pooled = await selectRoute({ provider: 'auto', messages: [], preferences: { enabled: true, costSensitivity: 0.3, providerPool: ['xai'] } });
  expect(pooled.selected).toBeNull();
  expect(pooled.exclusions).toContainEqual({ provider: 'xai', reason: 'outside-private-policy' });
  const pinned = await selectRoute({ provider: 'auto', messages: [{ role: 'assistant', content: 'x', providerMetadata: { xai: {} } }] });
  expect(pinned.selected).toBeNull();
  expect(pinned.exclusions).toContainEqual({ provider: 'xai', reason: 'outside-private-policy' });
});

it('fails closed with nothing declared, and without the policy undeclared targets stay selectable', async () => {
  config.set('routing', { enabled: true, costSensitivity: 0.3, dataPolicy: 'private' });
  const closed = await selectRoute({ provider: 'auto', messages: [] });
  expect(closed.selected).toBeNull();
  expect(closed.reason).toContain('outside-private-policy');
  expect(closed.exclusions.filter(e => e.reason === 'outside-private-policy').length).toBe(config.getProviderNames().length);
  expect(fetchSpy).not.toHaveBeenCalled();
  config.set('routing', { enabled: true, costSensitivity: 0.3 });
  const open = await selectRoute({ provider: 'xai', messages: [] });
  expect(open.selected?.provider).toBe('xai');
});

it('never matches credential-bearing or non-http endpoints', async () => {
  expect(endpointIdentity('https://h.invalid/v1?key=1')).toBeNull();
  expect(endpointIdentity('https://user:pw@h.invalid/v1')).toBeNull();
  expect(endpointIdentity('file:///etc')).toBeNull();
  expect(endpointIdentity('https://h.invalid/v1')).toBe('https://h.invalid/v1');
  declare('deepseek');
  config.setProviderCred('deepseek', { baseUrl: `${endpoint('deepseek')}?token=abc` });
  const decision = await selectRoute({ provider: 'auto', messages: [] });
  expect(decision.selected).toBeNull();
  expect(decision.exclusions).toContainEqual({ provider: 'deepseek', reason: 'outside-private-policy' });
});

it('keeps escalation inside the declared set', async () => {
  declare('deepseek');
  const policy = { version: 1 as const, profile: 'cost' as const, pool: [{ provider: 'deepseek' as const }], escalationPool: [{ provider: 'deepseek' as const }, { provider: 'xai' as const }] };
  const smart = { policy, stage: 'escalation' as const, evidenceId: randomUUID() };
  const decision = await selectRoute({ provider: 'auto', messages: [], smart });
  expect(decision.selected?.provider).toBe('deepseek');
  expect(decision.alternatives.some(c => c.provider === 'xai')).toBe(false);
  declare('xai');
  const other = await selectRoute({ provider: 'auto', messages: [], smart });
  expect(other.selected?.provider).toBe('xai');
  expect(other.exclusions).toContainEqual({ provider: 'deepseek', reason: 'outside-private-policy' });
});

it('validates the config schema', () => {
  const base = { enabled: true, costSensitivity: 0.3, dataPolicy: 'private' as const };
  expect(() => config.set('routing', { ...base, privateTargets: Array(33).fill({ provider: 'xai', endpoint: endpoint('xai') }) })).toThrow();
  expect(() => config.set('routing', { ...base, privateTargets: [{ provider: 'xai', endpoint: 'ftp://x' }] })).toThrow();
  expect(() => config.set('routing', { ...base, privateTargets: [{ provider: 'xai', endpoint: endpoint('xai'), extra: 1 }] } as never)).toThrow();
  expect(() => config.set('routing', { ...base, dataPolicy: 'public' } as never)).toThrow();
  expect(() => config.set('routing', { ...base, privateTargets: [{ provider: 'xai', endpoint: endpoint('xai') }] })).not.toThrow();
});

// ChatGPT quota fallback under the policy.
const store = new ChatGPTStore();
let root: string, planRequests: number, paidRequests: number;
async function fallbackSetup() {
  config.setProviderCred('openai', { accessMethod: 'chatgpt', apiKey: 'paid-fixture-key' });
  config.set('chatgptFallback', { model: 'gpt-paid-test', maxProjectCostUsd: 0.01, maxOutputTokens: 20, cooldownSeconds: 3600 });
  rmSync(store.directory, { recursive: true, force: true });
  await store.update(s => { s.active = 'oaiapp_test'; s.accounts.oaiapp_test = { clientId: 'oaiapp_test', subject: 'user', accessToken: 'plan-fixture-token', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] }; });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-private-fallback-')));
  planRequests = paidRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url), authorization = new Headers(init?.headers).get('authorization');
    if (target.endsWith('/models')) {
      if (authorization === 'Bearer plan-fixture-token') return Response.json({ models: [{ slug: 'gpt-plan-test', display_name: 'Plan model', visibility: 'list' }] });
      return Response.json({ object: 'list', data: [{ id: 'gpt-paid-test', created: 1, context_length: 100, max_output_tokens: 30, capabilities: { chat: true, tools: true, streaming: true }, pricing: { input: 1, output: 2 } }] });
    }
    if (target.endsWith('/responses')) { planRequests++; return Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'quota' } }, { status: 429 }); }
    if (target.endsWith('/chat/completions')) {
      paidRequests++;
      return Response.json({ id: 'r', object: 'chat.completion', created: 1, model: 'gpt-paid-test', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    }
    throw new Error('Unexpected fixture endpoint');
  }));
  await openQuotaCircuit('oaiapp_test', 'quota');
}
const turn = (extra: Partial<TurnOptions> = {}): TurnOptions => ({ sessionId: 'private-fallback', cwd: root, provider: 'openai', model: 'gpt-plan-test', prompt: 'hi', messages: { current: [{ role: 'user', content: 'hi' }] },
  confirmation: 'none', maxIterations: 2, tools: () => [], disableCompression: true, runlog: RunLog.open('private-fallback', { dir: join(root, 'runs') }), ...extra });

it('refuses the paid fallback before conversion, checkpoint or any request when its target is undeclared', async () => {
  await fallbackSetup();
  declare('deepseek');
  const original = [{ role: 'user' as const, content: 'hi' }];
  const checkpoints: Message[][] = [];
  const options = turn({ messages: { current: structuredClone(original) }, onCheckpoint: messages => { checkpoints.push(messages); } });
  await expect(runTurn(options)).rejects.toThrow(/outside-private-policy/);
  expect(options.messages.current).toEqual(original);
  expect(fallbackHistory(options.messages.current)).toBeUndefined();
  expect(checkpoints.every(messages => fallbackHistory(messages) === undefined)).toBe(true);
  expect(paidRequests).toBe(0);
  await options.runlog!.flush();
  const denied = readRunLog(runLogPath('private-fallback', join(root, 'runs'))).filter(line => JSON.stringify(line).includes('chatgpt-fallback'));
  expect(JSON.stringify(denied)).toContain('deny');
  rmSync(root, { recursive: true, force: true }); rmSync(store.directory, { recursive: true, force: true });
});

it('allows the paid fallback when the API-key target is declared', async () => {
  await fallbackSetup();
  config.set('routing', { enabled: true, costSensitivity: 0.3, dataPolicy: 'private', privateTargets: [{ provider: 'openai', endpoint: 'https://api.openai.com/v1' }] });
  const result = await runTurn(turn());
  expect(result.reason).toBe('completed');
  expect(paidRequests).toBe(1);
  rmSync(root, { recursive: true, force: true }); rmSync(store.directory, { recursive: true, force: true });
});
