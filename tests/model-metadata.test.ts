/** Real provider discovery transports; synthetic schemas, no model catalogue. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as config from '../src/config.js';
import { getAvailableModels, getDiscoveredModels, getModelInfo, clearModelCache, resolveModelAlias } from '../src/model-detection.js';
import { ModelDiscoveryError, anthropicMetadata, compatibleMetadata, openRouterPricing, validateModels, price } from '../src/models/index.js';
import { selectRoute } from '../src/routing/index.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  config.resetConfig(); clearModelCache();
  for (const provider of config.getProviderNames()) {
    const env = config.getProviderEnvVars(provider);
    for (const name of [env.apiKey, env.baseUrl]) if (name) vi.stubEnv(name, '');
    config.setProviderCred(provider, { apiKey: 'fake', ...(['anthropic', 'google'].includes(provider) ? {} : { baseUrl: `https://${provider}.invalid/v1` }) });
  }
  vi.stubGlobal('fetch', vi.fn(async () => json({})));
});
afterEach(() => { config.resetConfig(); clearModelCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('reads Anthropic input/output limits and capability objects from every page', async () => {
  vi.mocked(fetch).mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.searchParams.has('after_id')) {
      expect(url.searchParams.get('after_id')).toBe('page/one');
      expect(url.origin).toBe('https://api.anthropic.com');
      return json({ data: [{ id: 'claude-new', max_input_tokens: 64000, max_tokens: 5000, capabilities: { image_input: { supported: true }, thinking: { supported: false } } }], has_more: false });
    }
    return json({ data: [{ id: 'claude-first' }], has_more: true, last_id: 'page/one' });
  });
  const models = await getAvailableModels('anthropic', { throwOnError: true });
  expect(models.find(model => model.id === 'claude-new')).toMatchObject({ contextLength: 64000, maxOutputTokens: 5000, capabilities: { chat: true, vision: true, thinking: false }, evidence: { source: 'live' } });
  expect(models.find(model => model.id === 'claude-first')?.contextLength).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('resolves verified Anthropic aliases without substring matching or losing earlier aliases', async () => {
  vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/models')
    ? json({ data: [{ id: 'claude-canonical' }] })
    : json({ id: 'claude-canonical', max_input_tokens: 99000 }));
  await getAvailableModels('anthropic', { throwOnError: true });
  await resolveModelAlias('anthropic', 'claude-alias-a');
  await resolveModelAlias('anthropic', 'claude-alias-b');
  expect(getModelInfo('anthropic', 'claude-alias-a')).toMatchObject({ id: 'claude-canonical', aliases: ['claude-alias-a', 'claude-alias-b'], contextLength: 99000 });
  expect(getModelInfo('anthropic', 'claude-can')).toBeUndefined();
  expect((await selectRoute({ provider: 'anthropic', model: 'claude-alias-b' })).selected?.model).toBe('claude-alias-b');
  vi.mocked(fetch).mockResolvedValue(json({}, 404));
  expect(await resolveModelAlias('anthropic', 'missing')).toBeUndefined();
  expect(await resolveModelAlias('xai', 'irrelevant')).toBeUndefined();
});

it('uses Google supported generation methods and paginated token limits', async () => {
  vi.mocked(fetch).mockImplementation(async input => {
    const url = new URL(String(input));
    return url.searchParams.has('pageToken')
      ? json({ models: [{ name: 'models/gemini-text', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 32000, outputTokenLimit: 3000, thinking: true }] })
      : json({ models: [{ name: 'models/gemini-batch', supportedGenerationMethods: ['batchGenerateContent'] }], nextPageToken: 'page two' });
  });
  const models = await getAvailableModels('google', { throwOnError: true });
  expect(models.find(model => model.id === 'gemini-text')).toMatchObject({ contextLength: 32000, maxOutputTokens: 3000, capabilities: { chat: true, thinking: true } });
  expect((await selectRoute({ provider: 'google', model: 'gemini-batch' })).exclusions).toContainEqual({ provider: 'google', model: 'gemini-batch', reason: 'discovery-rejects-chat' });
});

it.each([
  { data: {}, has_more: false },
  { data: [], has_more: 'yes' },
  { data: [], has_more: true },
  { data: [], has_more: true, last_id: 4 },
])('rejects malformed Anthropic pagination: %j', async body => {
  vi.mocked(fetch).mockResolvedValue(json(body));
  await expect(getAvailableModels('anthropic', { throwOnError: true })).rejects.toBeInstanceOf(ModelDiscoveryError);
  expect(getDiscoveredModels('anthropic')).toBeUndefined();
});

it('refuses repeated pagination cursors and enforces a 20-page request budget', async () => {
  vi.mocked(fetch).mockImplementation(async () => json({ models: [], nextPageToken: 'again' }));
  await expect(getAvailableModels('google', { throwOnError: true })).rejects.toThrow('cursor');
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.mocked(fetch).mockReset();
  let page = 0;
  vi.mocked(fetch).mockImplementation(async () => json({ data: [], has_more: true, last_id: String(++page) }));
  await expect(getAvailableModels('anthropic', { throwOnError: true })).rejects.toThrow('page budget');
  expect(fetch).toHaveBeenCalledTimes(20);
});

it('keeps fallback catalogues separate from live discovery and invalidates credentials', async () => {
  vi.mocked(fetch).mockResolvedValue(json({}, 503));
  const fallback = await getAvailableModels('google');
  expect(fallback.every(model => model.evidence?.source === 'emergency')).toBe(true);
  expect(getDiscoveredModels('google')).toBeUndefined();
  vi.mocked(fetch).mockImplementation(async () => json({ data: [{ id: 'private-chat' }] }));
  const live = await getAvailableModels('xai', { throwOnError: true });
  live[0]!.id = 'caller-mutation';
  expect(getDiscoveredModels('xai')?.[0]?.id).toBe('private-chat');
  config.setProviderCred('xai', { apiKey: 'different-fake', baseUrl: 'https://xai.invalid/v1' });
  expect(getDiscoveredModels('xai')).toBeUndefined();
  expect(getModelInfo('xai', 'private-chat')).toBeUndefined();
});

it('uses Mistral aliases and explicit negative capabilities from the SDK response', async () => {
  vi.mocked(fetch).mockImplementation(async () => json({ data: [{ id: 'mistral-canonical', aliases: ['mistral-alias'], max_context_length: 48000,
    capabilities: { completion_chat: true, function_calling: false, vision: true } }] }));
  const route = await selectRoute({ provider: 'mistral', model: 'mistral-alias', requirements: { tools: true } });
  expect(route.exclusions).toContainEqual({ provider: 'mistral', model: 'mistral-canonical', reason: 'discovery-rejects-tools' });
  expect(getModelInfo('mistral', 'mistral-alias')?.contextLength).toBe(48000);
});

it('keeps missing and zero OpenRouter prices distinct and honors tool/vision metadata', async () => {
  vi.mocked(fetch).mockImplementation(async () => json({ data: [
    { id: 'vendor/unknown', architecture: { modality: 'text->text', input_modalities: ['text'] }, supported_parameters: [] },
    { id: 'vendor/free', architecture: { modality: 'text->text', input_modalities: ['text', 'image'] }, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' }, context_length: 8000 },
  ] }));
  const models = await getAvailableModels('openrouter', { throwOnError: true });
  expect(models.find(model => model.id === 'vendor/unknown')).toMatchObject({ pricing: { input: undefined, output: undefined }, capabilities: { tools: false, vision: false } });
  expect(models.find(model => model.id === 'vendor/free')).toMatchObject({ pricing: { input: 0, output: 0 }, capabilities: { tools: true, vision: true } });
});

it('routes with conservative OpenRouter context-tier and cache-write rates from live discovery', async () => {
  vi.mocked(fetch).mockImplementation(async () => json({ data: [{ id: 'vendor/tiered', context_length: 1000000,
    top_provider: { max_completion_tokens: 8000 }, supported_parameters: ['tools'],
    pricing: { prompt: '0.00001', completion: '0.00005', input_cache_read: '0.000001', web_search: '0.01',
      overrides: [{ min_prompt_tokens: 200000, prompt: '0.00002', completion: '0.000075', input_cache_write: '0.000025' }] } }] }));
  const route = await selectRoute({ provider: 'openrouter', model: 'vendor/tiered', requirements: { tools: true } });
  expect(route.selected).toMatchObject({ model: 'vendor/tiered', price: { input: 25, output: 75 }, contextLength: 1000000 });
});

it.each([null, [], 'bad', { prompt: '0' }, { prompt: '0', completion: -1 },
  ...[null, {}, Array(101).fill({}), [null], [[]], [{}], [{ min_prompt_tokens: -1 }], [{ min_prompt_tokens: 1.5 }],
    [{ min_prompt_tokens: 5, prompt: 'bad' }], [{ min_prompt_tokens: 5, completion: null }], [{ min_prompt_tokens: 5, request: '0.1' }]]
    .map(overrides => ({ prompt: '0', completion: '0', overrides })),
  ...['request', 'image', 'internal_reasoning', 'future_fee'].map(key => ({ prompt: '0', completion: '0', [key]: '0.1' })),
  { prompt: '0', completion: '0', input_cache_write: 'Infinity' }, { prompt: '0', completion: '0', web_search: '' },
])('does not authorize spend from malformed or unaccounted OpenRouter pricing %#', pricing => {
  expect(openRouterPricing(pricing)).toEqual({ input: undefined, output: undefined });
});

it('keeps inherited tier rates and permits explicit zero non-token fees', () => {
  expect(openRouterPricing({ prompt: '0.000001', completion: '0.000002', request: '0', image: 0,
    overrides: [{ min_prompt_tokens: 0, input_cache_read: '0.000003' }, { min_prompt_tokens: 100, completion: '0.000001' }] }))
    .toEqual({ input: 3, output: 2 });
});

it('uses Ollama show capabilities and actual num_ctx overrides', async () => {
  vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/api/tags')
    ? json({ models: [{ name: 'local-custom', size: 1 }] })
    : json({ capabilities: ['completion', 'tools', 'vision'], model_info: { 'custom.context_length': 32000 }, parameters: 'num_ctx 12000' }));
  const route = await selectRoute({ provider: 'ollama', model: 'local-custom', requirements: { tools: true, vision: true } });
  expect(route.selected).toMatchObject({ model: 'local-custom', contextLength: 12000, capabilities: { tools: true, thinking: false, vision: true } });
});

it.each([undefined, null, ''])('discovers Bedrock native models with terminal cursor %s and follows profile evidence', async terminal => {
  config.set('providers', { ...config.get('providers'), bedrock: {} });
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'fake'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fake');
  vi.stubEnv('AWS_PROFILE', ''); vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.mocked(fetch).mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/foundation-models') return json({ modelSummaries: [
      { modelId: 'newvendor.custom-model', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], responseStreamingSupported: false },
      { modelId: 'newvendor.other-model', inputModalities: ['TEXT'], outputModalities: ['TEXT'] },
    ] });
    return url.searchParams.has('nextToken') ? json({ inferenceProfileSummaries: [], nextToken: terminal }) : json({ inferenceProfileSummaries: [
      { inferenceProfileId: 'custom-profile', models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/newvendor.custom-model' }] },
    ], nextToken: 'next' });
  });
  const models = await getAvailableModels('bedrock', { throwOnError: true });
  expect(models.map(model => model.id)).toEqual(['custom-profile', 'newvendor.other-model']);
  expect(models[0]).toMatchObject({ capabilities: { streaming: false, vision: true } });
  expect(models[0]?.capabilities?.tools).toBeUndefined();
  expect(models[0]?.contextLength).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(['deepseek', 'openai-compat', 'litellm', 'ollama', 'bedrock'] as const)('refuses malformed %s discovery instead of granting an explicit fallback', async provider => {
  vi.mocked(fetch).mockImplementation(async () => json({ data: 'wrong', models: null }));
  const route = await selectRoute({ provider, model: 'arbitrary' });
  expect(route.status).toBe('unavailable');
  expect(route.exclusions).toContainEqual({ provider, reason: 'invalid-discovery-response' });
});

it('validates identities and finite numeric metadata while keeping absent capabilities unknown', () => {
  for (const models of [[{ id: '' }], [{ id: 'duplicate' }, { id: 'duplicate' }], [{ id: 'x', contextLength: -1 }], [{ id: 'x', pricing: { input: Infinity } }]]) expect(() => validateModels(models)).toThrow(ModelDiscoveryError);
  expect(anthropicMetadata({ capabilities: { structured_outputs: { supported: true } } }).capabilities?.json).toBe(true);
  expect(compatibleMetadata({ archived: true, pricing: { input: '', output: 'invalid' } })).toMatchObject({ capabilities: { chat: false }, pricing: { input: undefined, output: undefined } });
  expect(compatibleMetadata({ capabilities: { function_calling: { supported: false }, streaming: true } }).capabilities).toMatchObject({ tools: false, streaming: true });
  expect(price('0')).toBe(0); expect(price(-1)).toBeUndefined(); expect(price(Number.MAX_VALUE, 1000000)).toBeUndefined();
});

it('discovers individual reasoning effort values and never infers support from a model name',async()=>{
  expect(anthropicMetadata({capabilities:{effort:{supported:true,low:{supported:true},medium:{supported:false},high:null,max:{supported:'yes'}}}}).reasoningEfforts).toEqual(['low']);
  expect(anthropicMetadata({capabilities:{effort:{supported:false,low:{supported:true}}}}).reasoningEfforts).toEqual([]);
  expect(anthropicMetadata({id:'claude-fable-5-1'}).reasoningEfforts).toBeUndefined();
  for(const levels of [['low','low'],['invented'],'low',null])expect(()=>validateModels([{id:'toy',reasoningEfforts:levels as any}])).toThrow();
  vi.mocked(fetch).mockResolvedValue(json({data:[{id:'claude-any-name',capabilities:{effort:{supported:true,low:{supported:true}}}}],has_more:false}));
  const selected=await selectRoute({provider:'anthropic',model:'claude-any-name',requirements:{reasoningEffort:'low'}});
  expect(selected.selected,JSON.stringify(selected)).toMatchObject({reasoningEffort:'low'});expect(selected.reason).toContain('live reasoning effort low');
  expect((await selectRoute({provider:'anthropic',model:'claude-any-name',requirements:{reasoningEffort:'high'}})).selected).toBeNull();
  expect((await selectRoute({provider:'deepseek',model:'claude-any-name',requirements:{reasoningEffort:'low'}})).selected).toBeNull();
  clearModelCache();vi.mocked(fetch).mockResolvedValue(json({},503));
  expect((await selectRoute({provider:'anthropic',model:'claude-any-name',requirements:{reasoningEffort:'low'}})).selected).toBeNull();
});
