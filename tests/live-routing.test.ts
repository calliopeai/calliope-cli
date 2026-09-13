import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as config from '../src/config.js';
import { clearModelCache, getAvailableModels, getDiscoveredModels, preWarmModelCache } from '../src/model-detection.js';
import { HealthStore, providerTarget } from '../src/health/index.js';
import { selectRoute } from '../src/routing/index.js';

const data: Record<string, unknown[]> = {};
beforeEach(() => {
  config.resetConfig(); clearModelCache();
  for (const provider of config.getProviderNames()) {
    const env = config.getProviderEnvVars(provider);
    for (const key of [env.apiKey, env.baseUrl]) if (key) vi.stubEnv(key, '');
  }
  for (const provider of ['deepseek', 'xai'] as const) {
    config.setProviderCred(provider, { apiKey: 'fake', baseUrl: `https://${provider}.invalid/v1` });
    data[provider] = [{ id: `${provider}-live`, capabilities: { chat: true, tools: true }, pricing: { input: 2, output: 4 } }];
  }
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(String(input));
    expect(url.pathname).toBe('/v1/models');
    return new Response(JSON.stringify({ data: data[url.hostname.split('.')[0]!] }), { headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { config.resetConfig(); clearModelCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const preferences = { providerPool: ['deepseek', 'xai'] as const, costSensitivity: 0.3 };
const automatic = () => ({ provider: 'auto' as const, preferences: { ...preferences, providerPool: [...preferences.providerPool] }, requirements: { tools: true } });

it('selects live models and explains the capability, health, latency and cost evidence', async () => {
  const route = await selectRoute(automatic());
  expect(route).toMatchObject({ version: 1, status: 'selected', selected: { provider: 'deepseek', model: 'deepseek-live', evidence: 'live', estimatedCost: 0.003 } });
  expect(route.reason).toMatch(/capability.*health.*latency.*cost/);
  expect(route.alternatives).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  await selectRoute(automatic());
  expect(fetch).toHaveBeenCalledTimes(2); // Only fresh live evidence is reused.
});

it('rejects live tool incompatibility even for an explicit model and never substitutes a different model', async () => {
  data.deepseek = [{ id: 'unsupported', capabilities: { tools: false } }, { id: 'supported', capabilities: { tools: true } }];
  const denied = await selectRoute({ provider: 'deepseek', model: 'unsupported', requirements: { tools: true } });
  expect(denied.status).toBe('unavailable');
  expect(denied.exclusions).toContainEqual({ provider: 'deepseek', model: 'unsupported', reason: 'discovery-rejects-tools' });
  const missing = await selectRoute({ provider: 'deepseek', model: 'not-listed' });
  expect(missing.status).toBe('unavailable');
  expect(missing.exclusions[0]?.reason).toBe('model-not-in-live-discovery');
});

it('preserves explicit provider/model choices even when another endpoint is cheaper', async () => {
  data.xai = [{ id: 'xai-live', pricing: { input: 0, output: 0 } }];
  const route = await selectRoute({ ...automatic(), provider: 'deepseek', model: 'deepseek-live' });
  expect(route.selected?.provider).toBe('deepseek');
  expect(route.alternatives).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('uses prices without treating missing price as free, and respects configured preference on ties', async () => {
  data.deepseek = [{ id: 'unknown-price' }];
  data.xai = [{ id: 'known-free', pricing: { input: 0, output: 0 } }];
  expect((await selectRoute({ ...automatic(), preferences: { ...automatic().preferences, costSensitivity: 1 } })).selected?.model).toBe('known-free');
  expect((await selectRoute({ ...automatic(), preferences: { ...automatic().preferences, costSensitivity: 0, preferredProviders: ['xai'] } })).selected?.provider).toBe('xai');
});

it('ranks recent measured health and latency and skips quarantine only for automatic selection', async () => {
  const store = new HealthStore();
  for (const provider of ['deepseek', 'xai'] as const) {
    const target = providerTarget(provider);
    store.append({ provider, target: target.key, type: 'attempt', outcome: 'success', durationMs: provider === 'deepseek' ? 4000 : 100 });
  }
  expect((await selectRoute(automatic())).selected?.provider).toBe('xai');
  const target = providerTarget('xai');
  for (let i = 0; i < 3; i++) store.append({ provider: 'xai', target: target.key, type: 'attempt', outcome: 'error', failure: 'server', durationMs: 100 });
  const auto = await selectRoute(automatic());
  expect(auto.selected?.provider).toBe('deepseek');
  expect(auto.exclusions).toContainEqual({ provider: 'xai', reason: 'quarantined' });
  expect((await selectRoute({ provider: 'xai', model: 'xai-live' })).selected?.reason).toContain('explicit quarantine recovery');
});

it('allows a visible unverified explicit choice when discovery fails, while automatic selection fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
  const explicit = await selectRoute({ provider: 'deepseek', model: 'private-model' });
  expect(explicit.selected?.evidence).toBe('explicit-unverified');
  expect(explicit.reason).toContain('without claiming compatibility');
  expect((await selectRoute(automatic())).status).toBe('unavailable');
});

it('invalidates discovery evidence when the configured endpoint changes', async () => {
  await getAvailableModels('deepseek', { throwOnError: true });
  expect(getDiscoveredModels('deepseek')).toHaveLength(1);
  config.setProviderCred('deepseek', { apiKey: 'fake', baseUrl: 'https://xai.invalid/v1' });
  expect(getDiscoveredModels('deepseek')).toBeUndefined();
  const route = await selectRoute({ provider: 'deepseek', model: 'deepseek-live' });
  expect(route.status).toBe('unavailable');
});

it('pins opaque protocol history and refuses an incompatible explicit provider switch', async () => {
  const messages = [{ role: 'assistant' as const, content: 'prior', providerMetadata: { deepseek: { opaque: 'untouched' }, calliopeRouting: { provider: 'deepseek', model: 'deepseek-live' } } }];
  const before = structuredClone(messages);
  expect((await selectRoute({ ...automatic(), messages })).selected?.provider).toBe('deepseek');
  expect((await selectRoute({ provider: 'xai', messages })).status).toBe('unavailable');
  expect(messages).toEqual(before);
});

it('cancels actual discovery HTTP requests before inference and reports a cancelled decision', async () => {
  let started!: () => void, signal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise((_resolve, reject) => {
    signal = init?.signal as AbortSignal; started();
    signal.addEventListener('abort', () => reject(signal!.reason), { once: true });
  })));
  const controller = new AbortController();
  const pending = selectRoute({ ...automatic(), signal: controller.signal });
  await ready; controller.abort();
  expect((await pending).status).toBe('cancelled');
  expect(signal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('cancels background model discovery without caching aborted results', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignal; signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })));
  const controller = new AbortController(), pending = preWarmModelCache(controller.signal);
  await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0)); controller.abort(); await pending;
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(getDiscoveredModels('deepseek')).toBeUndefined();
});

it('rejects malformed preferences without making a request', async () => {
  expect((await selectRoute({ provider: 'auto', preferences: { costSensitivity: NaN } })).status).toBe('unavailable');
  expect((await selectRoute({ provider: 'deepseek', model: '\nunsafe' })).status).toBe('unavailable');
  expect((await selectRoute({ provider: 'deepseek', requirements: { inputTokens: -1 } })).status).toBe('unavailable');
  expect(fetch).not.toHaveBeenCalled();
});

it('retains stale negative evidence after a discovery outage and permits recovery only with fresh evidence', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  data.deepseek = [{ id: 'old', capabilities: { tools: false } }];
  await getAvailableModels('deepseek', { throwOnError: true });
  vi.setSystemTime(Date.now() + 301000);
  vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 503 }));
  const denied = await selectRoute({ provider: 'deepseek', model: 'old', requirements: { tools: true } });
  expect(denied.exclusions).toContainEqual({ provider: 'deepseek', model: 'old', reason: 'previous-discovery-rejects-tools' });
  expect(denied.status).toBe('unavailable');
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'old', capabilities: { tools: true } }] }), { headers: { 'content-type': 'application/json' } }));
  expect((await selectRoute({ provider: 'deepseek', model: 'old', requirements: { tools: true } })).status).toBe('selected');
  vi.useRealTimers();
});

it('rejects mixed protocol owners before contacting any provider', async () => {
  const messages = ['deepseek', 'xai'].map(provider => ({ role: 'assistant' as const, content: '', providerMetadata: { [provider]: {}, calliopeRouting: { provider, model: 'model' } } }));
  expect((await selectRoute({ ...automatic(), messages })).reason).toContain('conflicting protocol');
  expect(fetch).not.toHaveBeenCalled();
});

it('accounts for discovered capacity and refuses an impossible output budget', async () => {
  data.deepseek = [{ id: 'small', context_length: 1000, max_output_tokens: 100 }];
  data.xai = [{ id: 'large', context_length: 64000, max_output_tokens: 8000 }];
  const route = await selectRoute({ ...automatic(), preferences: { ...automatic().preferences, costSensitivity: 0 }, requirements: { inputTokens: 10000, outputTokens: 250, minOutputTokens: 250 } });
  expect(route.selected?.model).toBe('large');
  expect(route.exclusions).toContainEqual({ provider: 'deepseek', model: 'small', reason: 'discovery-rejects-output-budget' });
  expect((await selectRoute({ provider: 'deepseek', model: 'small', requirements: { inputTokens: 10000, outputTokens: 50 } })).status).toBe('selected'); // Input can be compacted by the runtime.
});

it('rejects malformed capability flags, duplicate model identities and overflowing cost estimates', async () => {
  expect((await selectRoute({ provider: 'deepseek', requirements: { tools: 'yes' as never } })).status).toBe('unavailable');
  data.deepseek = [{ id: 'same' }, { id: 'same' }];
  expect((await selectRoute({ provider: 'deepseek', model: 'same' })).exclusions).toContainEqual({ provider: 'deepseek', reason: 'invalid-discovery-response' });
  data.deepseek = [{ id: 'huge', pricing: { input: Number.MAX_VALUE, output: Number.MAX_VALUE } }];
  expect((await selectRoute({ provider: 'deepseek', model: 'huge', requirements: { inputTokens: Number.MAX_SAFE_INTEGER } })).exclusions).toContainEqual({ provider: 'deepseek', model: 'huge', reason: 'invalid-cost-estimate' });
});

it('honors stored provider model preferences and disabling optimization preserves configured order', async () => {
  data.deepseek = [{ id: 'first', pricing: { input: 0, output: 0 } }, { id: 'preferred', pricing: { input: 30, output: 90 } }];
  config.setProviderCred('deepseek', { model: 'preferred' });
  expect((await selectRoute({ provider: 'deepseek' })).selected?.model).toBe('preferred');
  const route = await selectRoute({ ...automatic(), preferences: { ...automatic().preferences, enabled: false } });
  expect(route.selected?.model).toBe('preferred');
  expect(route.reason).toContain('optimization disabled');
});

it('treats an empty provider pool as no automatic targets while preserving explicit choices', async () => {
  expect((await selectRoute({ provider: 'auto', preferences: { providerPool: [] } })).status).toBe('unavailable');
  expect(fetch).not.toHaveBeenCalled();
  expect((await selectRoute({ provider: 'deepseek', model: 'deepseek-live', preferences: { providerPool: [] } })).selected?.model).toBe('deepseek-live');
});

it('refuses metadata if configuration changes while discovery is in flight', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    config.setProviderCred('deepseek', { apiKey: 'different-fake' });
    return new Response(JSON.stringify({ data: [{ id: 'model' }] }), { headers: { 'content-type': 'application/json' } });
  }));
  const route = await selectRoute({ provider: 'deepseek', model: 'model' });
  expect(route.exclusions).toContainEqual({ provider: 'deepseek', reason: 'configuration-changed-during-discovery' });
});

it.each([null, 'wrong', [], { provider: 'auto', messages: {} }, { provider: 'auto', messages: [null] }, { provider: 'auto', signal: {} }])('returns an unavailable decision for malformed request %j', async request => {
  const route = await selectRoute(request as never);
  expect(route).toMatchObject({ version: 1, status: 'unavailable', reason: 'Invalid routing request.' });
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps Smart routing opt-in and restricts automatic choices to the reviewed pool',async()=>{
  data.deepseek=[{id:'cheap',pricing:{input:0,output:0}},{id:'approved',pricing:{input:2,output:4}}];
  expect((await selectRoute(automatic())).selected?.model).toBe('cheap');
  const route=await selectRoute({...automatic(),smart:{policy:{version:1,profile:'cost',pool:[{provider:'deepseek',model:'approved'}]},stage:'initial'}});
  expect(route.selected?.model).toBe('approved');expect(route.alternatives).toEqual([]);expect(route.smart).toEqual({profile:'cost',stage:'initial'});expect(route.reason).toContain('Smart cost');
  expect(route.exclusions).toContainEqual({provider:'deepseek',model:'cheap',reason:'outside-smart-pool'});
});
it('uses explicit Smart profiles even when legacy score optimization is disabled',async()=>{
  data.deepseek=[{id:'a-expensive',pricing:{input:20,output:40}},{id:'z-economical',pricing:{input:0,output:0}}];
  const route=await selectRoute({...automatic(),preferences:{enabled:false,providerPool:['deepseek']},smart:{policy:{version:1,profile:'cost',pool:[{provider:'deepseek'}]},stage:'initial'}});
  expect(route.selected?.model).toBe('z-economical');expect(route.reason).not.toContain('disabled');
});
it('preserves explicit Smart pins outside a pool while still checking live incompatibility',async()=>{
  const smart={policy:{version:1 as const,profile:'balanced' as const,pool:[{provider:'xai' as const}]},stage:'initial' as const};
  expect((await selectRoute({...automatic(),provider:'deepseek',model:'deepseek-live',smart})).selected?.model).toBe('deepseek-live');
  expect((await selectRoute({...automatic(),provider:'deepseek',smart})).selected?.provider).toBe('deepseek');
  clearModelCache();data.deepseek=[{id:'deepseek-live',capabilities:{tools:false}}];
  expect((await selectRoute({...automatic(),provider:'deepseek',model:'deepseek-live',smart})).status).toBe('unavailable');
});
it('selects an escalation pool only with a bounded selection and retains the evidence reference',async()=>{
  const policy={version:1 as const,profile:'balanced' as const,pool:[{provider:'deepseek' as const}],escalationPool:[{provider:'xai' as const}]},evidenceId='00000000-0000-4000-8000-000000000001';
  const route=await selectRoute({...automatic(),smart:{policy,stage:'escalation',evidenceId}});
  expect(route.selected?.provider).toBe('xai');expect(route.smart).toMatchObject({stage:'escalation',evidenceId});expect(route.reason).toContain(evidenceId);
  for(const smart of [{policy,stage:'escalation'},{policy,stage:'initial',evidenceId},{policy:{...policy,pool:[]},stage:'initial'},{policy,stage:'unknown'}])expect((await selectRoute({...automatic(),smart:smart as never})).reason).toBe('Invalid Smart routing selection.');
});
it('keeps an automatic Smart continuation inside its captured pool and honors cancellation',async()=>{
  const smart={policy:{version:1 as const,profile:'speed' as const,pool:[{provider:'deepseek' as const}]},stage:'initial' as const};
  expect((await selectRoute({...automatic(),provider:'xai',model:'xai-live',origin:{provider:'auto'},smart})).status).toBe('unavailable');
  expect((await selectRoute({...automatic(),signal:AbortSignal.abort(),smart})).status).toBe('cancelled');
});

it('keeps quarantine and visibly unverified explicit recovery in Smart mode',async()=>{
  const smart={policy:{version:1 as const,profile:'speed' as const,pool:[{provider:'deepseek' as const},{provider:'xai' as const}]},stage:'initial' as const};
  const store=new HealthStore(),target=providerTarget('deepseek');for(let n=0;n<3;n++)store.append({provider:'deepseek',target:target.key,type:'attempt',outcome:'error',failure:'server',durationMs:10});
  const route=await selectRoute({...automatic(),smart});expect(route.selected?.provider).toBe('xai');expect(route.exclusions).toContainEqual({provider:'deepseek',reason:'quarantined'});
  clearModelCache();vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('Synthetic offline endpoint');}));
  const pinned=await selectRoute({provider:'deepseek',model:'explicit-local-model',smart});expect(pinned.selected?.evidence).toBe('explicit-unverified');expect(pinned.reason).toContain('unverified');
});

it('lets the operator trade cost against observed latency without changing the eligible model pool',async()=>{
  data.deepseek=[{id:'fast',pricing:{input:20,output:40},capabilities:{tools:true}}];data.xai=[{id:'economical',pricing:{input:0.5,output:0.5},capabilities:{tools:true}}];
  const store=new HealthStore();for(const provider of ['deepseek','xai'] as const)store.append({provider,target:providerTarget(provider).key,type:'attempt',outcome:'success',durationMs:provider==='deepseek'?20:4000});
  const pool=[{provider:'deepseek' as const},{provider:'xai' as const}];
  const cost=await selectRoute({...automatic(),smart:{policy:{version:1,profile:'cost',pool},stage:'initial'}}),speed=await selectRoute({...automatic(),smart:{policy:{version:1,profile:'speed',pool},stage:'initial'}});
  expect(cost.selected?.model).toBe('economical');expect(speed.selected?.model).toBe('fast');expect(cost.alternatives[0]?.model).toBe('fast');expect(speed.alternatives[0]?.model).toBe('economical');
});
