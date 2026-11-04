import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn, type TurnOptions } from '../src/runtime/turn.js';
import { ChatGPTStore, openQuotaCircuit, publicFallbackHistory, fallbackHistory, withAPIKeyAccess, runFallbackCommand } from '../src/auth/chatgpt/index.js';
import * as config from '../src/config.js';
import { clearModelCache } from '../src/model-detection.js';
import { loadProjectSpend } from '../src/budget.js';
import { RunLog } from '../src/runlog.js';
import { ProjectSpendLedger } from '../src/execution/project-spend.js';
import { providerTarget } from '../src/health/index.js';
import { getTools } from '../src/tools.js';
import type { Message } from '../src/types.js';

let billingDirectory: string;
let root: string, paidBodies: Record<string, unknown>[], planRequests: number;
let apiFailure: boolean, partial: boolean, withTool: boolean, missingPrices: boolean, discoveryQuota: boolean;
const store = new ChatGPTStore();
const policy = { model: 'gpt-paid-test', maxProjectCostUsd: 0.01, maxOutputTokens: 20, cooldownSeconds: 3600 };
const messages = (): Message[] => [{ role: 'user', content: 'read ok.txt and summarize briefly' }];
function options(extra: Partial<TurnOptions> = {}): TurnOptions {
  return { sessionId: 'fallback-runtime-test', cwd: root, provider: 'openai', model: 'gpt-plan-test', prompt: 'read', messages: { current: messages() }, confirmation: 'none', maxIterations: 3, tools: () => [], disableCompression: true, runlog: RunLog.open('fallback-runtime-test', { enabled: false }), ...extra };
}
beforeEach(async () => {
  config.resetConfig(); config.set('budget', {}); config.set('sandbox', 'none'); config.set('policy', {});
  config.setProviderCred('openai', { accessMethod: 'chatgpt', apiKey: 'paid-fixture-key' }); config.set('chatgptFallback', policy);
  clearModelCache(); rmSync(store.directory, { recursive: true, force: true });
  await store.update(s => { s.active = 'oaiapp_test'; s.accounts.oaiapp_test = { clientId: 'oaiapp_test', subject: 'user', accessToken: 'plan-fixture-token', refreshToken: 'refresh', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] }; });
  billingDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-fallback-billing-')));
  root = mkdtempSync(join(tmpdir(), 'calliope-fallback-runtime-')); writeFileSync(join(root, 'ok.txt'), 'hello');
  paidBodies = []; planRequests = 0; apiFailure = partial = withTool = missingPrices = discoveryQuota = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(url), authorization = new Headers(init?.headers).get('authorization');
    if (endpoint.endsWith('/models')) {
      if (authorization === 'Bearer plan-fixture-token') return discoveryQuota ? Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }) : Response.json({ models: [{ slug: 'gpt-plan-test', display_name: 'Plan model', visibility: 'list' }] });
      return Response.json({ object: 'list', data: [{ id: 'gpt-paid-test', created: 1, context_length: 100, max_output_tokens: 30, capabilities: { chat: true, tools: true, streaming: true }, ...(missingPrices ? {} : { pricing: { input: 1, output: 2 } }) }] });
    }
    if (endpoint.endsWith('/responses')) {
      planRequests++;
      if (partial) return new Response([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'quota' } }, { status: 429 });
    }
    if (endpoint.endsWith('/chat/completions')) {
      paidBodies.push(JSON.parse(String(init?.body)));
      if (apiFailure) return Response.json({ error: { code: 'insufficient_quota', message: 'paid account exhausted' } }, { status: 429 });
      const tool = withTool && paidBodies.length === 1;
      return Response.json({ id: 'result', object: 'chat.completion', created: 1, model: 'gpt-paid-test', choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: { role: 'assistant', content: tool ? null : 'done', ...(tool ? { tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"ok.txt"}' } }] } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    }
    throw new Error('Unexpected fixture endpoint');
  }));
});
afterEach(() => { rmSync(billingDirectory, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); config.resetConfig(); clearModelCache(); rmSync(store.directory, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
it('switches once after quota, reserves paid spend, records billing and preserves the global selection', async () => {
  const onWarning = vi.fn(), opts = options({ onWarning });
  const result = await runTurn(opts);
  expect(result.reason).toBe('completed'); expect(planRequests).toBe(1); expect(paidBodies).toHaveLength(1);
  expect(paidBodies[0]).toMatchObject({ model: 'gpt-paid-test', max_completion_tokens: 20 });
  expect(result.totals.cost).toBeCloseTo(0.000014); expect(loadProjectSpend(root).spentUsd).toBeCloseTo(0.000014);
  expect(fallbackHistory(opts.messages.current)).toEqual({ clientId: 'oaiapp_test', model: 'gpt-paid-test' });
  expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('paid OpenAI')); expect(config.getProviderCred('openai').accessMethod).toBe('chatgpt');
});
it('continues real tool results on the paid route without repeating the exhausted subscription', async () => {
  withTool = true;
  const opts = options({ tools: () => getTools().filter(t => t.name === 'read_file') });
  const result = await runTurn(opts);
  expect(result.reason).toBe('completed'); expect(result.totals.toolCalls).toBe(1); expect(planRequests).toBe(1); expect(paidBodies).toHaveLength(2);
  expect(JSON.stringify(paidBodies[1])).toContain('hello'); expect(loadProjectSpend(root).spentUsd).toBeCloseTo(0.000028);
});
it('refuses disabled fallback with no paid request', async () => {
  config.set('chatgptFallback', null);
  await expect(runTurn(options())).rejects.toThrow('plan usage limit'); expect(paidBodies).toHaveLength(0);
});
it('keeps a persisted paid session on its configured route after circuit expiry', async () => {
  const history = publicFallbackHistory(messages(), 'oaiapp_test', 'gpt-paid-test');
  await runTurn(options({ messages: { current: history } })); expect(planRequests).toBe(0); expect(paidBodies).toHaveLength(1);
});
it('skips exhausted subscription calls on a fresh session during cooldown', async () => {
  await openQuotaCircuit('oaiapp_test', 'quota'); await runTurn(options()); expect(planRequests).toBe(0); expect(paidBodies).toHaveLength(1);
});
it('falls back when discovery itself reports quota exhaustion', async () => {
  discoveryQuota = true; await runTurn(options()); expect(planRequests).toBe(0); expect(paidBodies).toHaveLength(1);
});
it('rejects a shared cap before sending paid inference and retains prior project spend', async () => {
  config.set('chatgptFallback', { ...policy, maxProjectCostUsd: 0.000001 });
  await expect(runTurn(options())).resolves.toMatchObject({ reason: 'budget' }); expect(paidBodies).toHaveLength(0); expect(loadProjectSpend(root).spentUsd).toBe(0);
});
it('refuses missing verified prices instead of sending an unbounded paid request', async () => {
  missingPrices = true; await expect(runTurn(options())).resolves.toMatchObject({ reason: 'budget', budget: { message: expect.stringMatching(/prices|billing/) } }); expect(paidBodies).toHaveLength(0);
});
it('never replays quota failures after partial subscription output', async () => {
  partial = true;
  await expect(runTurn(options({ onToken: vi.fn(), onStreamReset: vi.fn() }))).rejects.toThrow('plan usage limit'); expect(paidBodies).toHaveLength(0);
});
it('does not convert cancellation into paid fallback', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(runTurn(options({ signal: controller.signal }))).resolves.toMatchObject({ reason: 'cancelled' }); expect(paidBodies).toHaveLength(0); expect(planRequests).toBe(0);
});
it('preserves visible subscription history while dropping encrypted reasoning', async () => {
  const history: Message[] = [{ role: 'assistant', content: 'Earlier visible answer', providerMetadata: { openai: { chatgpt: { clientId: 'oaiapp_test', model: 'gpt-plan-test', output: [{ type: 'reasoning', encrypted_content: 'OPAQUE-PRIVATE' }] } }, calliopeRouting: { provider: 'openai', model: 'gpt-plan-test' } } }, ...messages()];
  await runTurn(options({ messages: { current: history } }));
  expect(JSON.stringify(paidBodies)).toContain('Earlier visible answer'); expect(JSON.stringify(paidBodies)).not.toContain('OPAQUE-PRIVATE');
});
it('refuses changed account ownership for a saved paid session', async () => {
  const history = publicFallbackHistory(messages(), 'oaiapp_other', 'gpt-paid-test');
  await expect(runTurn(options({ messages: { current: history } }))).rejects.toThrow('changed'); expect(paidBodies).toHaveLength(0);
});

it('does not retry a drained API account or bounce back to the subscription', async () => {
  apiFailure = true;
  await expect(runTurn(options({ onError: () => 'retry' }))).rejects.toThrow('API-key fallback quota');
  expect(planRequests).toBe(1); expect(paidBodies).toHaveLength(1);
  expect(loadProjectSpend(root).spentUsd).toBeGreaterThan(0);
});
it('applies the shared cap across separate turns without resetting spend', async () => {
  await runTurn(options());
  const spent = loadProjectSpend(root).spentUsd;
  config.set('chatgptFallback', { ...policy, maxProjectCostUsd: spent });
  await expect(runTurn(options())).resolves.toMatchObject({ reason: 'budget' });
  expect(paidBodies).toHaveLength(1); expect(loadProjectSpend(root).spentUsd).toBe(spent);
});
it('fails closed if fallback is disabled for an existing paid conversation', async () => {
  const history = publicFallbackHistory(messages(), 'oaiapp_test', 'gpt-paid-test');
  config.set('chatgptFallback', null);
  await expect(runTurn(options({ messages: { current: history } }))).rejects.toThrow('enabled policy');
  expect(paidBodies).toHaveLength(0); expect(planRequests).toBe(0);
});
it('shares the paid ceiling across concurrent fallback turns', async () => {
  config.set('chatgptFallback', { ...policy, maxProjectCostUsd: 0.000145 });
  await openQuotaCircuit('oaiapp_test', 'quota');
  const results = await Promise.all([runTurn(options()), runTurn(options())]);
  expect(results.map(r => r.reason).sort()).toEqual(['budget', 'completed']); expect(paidBodies).toHaveLength(1);
});
it('refuses automatic billing changes under reviewed Smart authority', async () => {
  await openQuotaCircuit('oaiapp_test', 'quota');
  await expect(runTurn(options({ smart: {} as NonNullable<TurnOptions['smart']> }))).rejects.toThrow('Reviewed execution');
  expect(planRequests).toBe(0); expect(paidBodies).toHaveLength(0);
});
it('does not dispatch paid inference when the transition checkpoint fails', async () => {
  await expect(runTurn(options({ onCheckpoint: async history => { if (fallbackHistory(history)) throw Error('checkpoint failed'); } }))).rejects.toThrow('checkpoint failed');
  expect(paidBodies).toHaveLength(0);
});

it('refuses paid continuation after local logout', async () => {
  const history = publicFallbackHistory(messages(), 'oaiapp_test', 'gpt-paid-test');
  await store.update(s => { delete s.accounts.oaiapp_test!.accessToken; delete s.accounts.oaiapp_test!.refreshToken; });
  await expect(runTurn(options({ messages: { current: history } }))).rejects.toThrow('signed-in account');
  expect(paidBodies).toHaveLength(0);
});
it('honors a stricter existing project ceiling on the paid route', async () => {
  config.set('budget', { maxCostPerProject: 0.000001 });
  await openQuotaCircuit('oaiapp_test', 'quota');
  await expect(runTurn(options())).resolves.toMatchObject({ reason: 'budget' });
  expect(paidBodies).toHaveLength(0);
});

it('uses reviewed billing bounds for real API catalogs without prices and reports the reserved rates', async () => {
  missingPrices = true;
  const file = join(billingDirectory, 'billing.json'), now = Date.now();
  writeFileSync(file, JSON.stringify({version:2,profiles:[{version:2,provider:'openai',model:'gpt-paid-test',target:withAPIKeyAccess(()=>providerTarget('openai').key),checkedAt:now,expiresAt:now+60000,sources:['https://example.test/pricing'],prices:{input:10,output:20},capabilities:{chat:true,tools:true,streaming:true},limits:{contextLength:100,maxOutputTokens:30},admission:'reviewed-full-context-v1'}]}), {mode:0o600});
  vi.stubEnv('CALLIOPE_BILLING_FILE',file);
  const result = await runTurn(options());
  expect(result.reason).toBe('completed'); expect(result.totals.cost).toBeCloseTo(0.00014);
  expect(loadProjectSpend(root).spentUsd).toBeCloseTo(result.totals.cost); expect(paidBodies).toHaveLength(1);
});

it('keeps API routing scoped when quota appears during a later discovery', async () => {
  await runTurn(options({onRoute: decision => { if (decision.selected?.model === 'gpt-plan-test') { discoveryQuota = true; clearModelCache(); } }}));
  expect(planRequests).toBe(0); expect(paidBodies).toHaveLength(1);
});

it('discovers paid models and their billing target without switching the selected access method', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runFallbackCommand(['models']);
  const result = JSON.parse(output.mock.calls.at(-1)![0]);
  expect(result.models.map((m: {id:string}) => m.id)).toEqual(['gpt-paid-test']);
  expect(result.target).toBe(withAPIKeyAccess(()=>providerTarget('openai').key));
  expect(config.getProviderCred('openai').accessMethod).toBe('chatgpt');
  expect(planRequests).toBe(0); expect(paidBodies).toHaveLength(0);
});

it.each(['disable','lower','account'])('rechecks %s changes after queued admission and before paid HTTP', async change => {
  const reserve = ProjectSpendLedger.prototype.reserve;
  vi.spyOn(ProjectSpendLedger.prototype, 'reserve').mockImplementation(async function(this: ProjectSpendLedger, ...args: Parameters<ProjectSpendLedger['reserve']>) {
    const result = await reserve.apply(this, args);
    if (change === 'disable') config.set('chatgptFallback', null);
    if (change === 'lower') config.set('chatgptFallback', {...policy,maxProjectCostUsd:0.000001});
    if (change === 'account') await store.update(s => {s.accounts.oaiapp_other={...s.accounts.oaiapp_test!,clientId:'oaiapp_other',subject:'other'};s.active='oaiapp_other';});
    return result;
  });
  await expect(runTurn(options())).rejects.toThrow(/changed|disabled/);
  expect(paidBodies).toHaveLength(0); expect(loadProjectSpend(root).spentUsd).toBeGreaterThan(0);
});
