import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as config from '../src/config.js';
import { providerTarget } from '../src/health/target.js';
import { calculateMaxTokens, estimateInputTokens } from '../src/providers/types.js';
import { getModelContextLimit, getModelMaxOutput } from '../src/model-detection.js';
import { withReviewedModelLimits, readBillingEvidence } from '../src/execution/billing.js';
import { providerQuote } from '../src/execution/quote.js';
import { autoCompress, configureAutoCompressor } from '../src/auto-compressor.js';
import type { RouteCandidate } from '../src/routing/index.js';

let root: string, project: string, file: string, route: RouteCandidate;
const model = 'fixture-modern-model';
const messages = [{ role: 'user' as const, content: 'x'.repeat(54172) }];
function profile(overrides: Record<string, unknown> = {}) {
  return { version: 2, provider: 'openai', model, target: route.target, checkedAt: Date.now() - 100,
    expiresAt: Date.now() + 60000, sources: ['https://example.com/reviewed-model-limits'],
    prices: { input: 20, output: 75 }, capabilities: { chat: true, tools: true, streaming: true },
    limits: { contextLength: 1050000, maxOutputTokens: 128000 }, admission: 'reviewed-full-context-v1', ...overrides };
}
function write(value = profile()) { fs.writeFileSync(file, JSON.stringify({ version: 2, profiles: [value] }), { mode: 0o600 }); }
beforeEach(() => {
  config.resetConfig(); vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('OPENAI_BASE_URL', '');
  config.setProviderCred('openai', { apiKey: 'fixture', baseUrl: 'https://openai.invalid/v1' });
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-context-admission-')));
  project = join(root, 'project'); fs.mkdirSync(project);
  file = join(root, 'billing.json'); vi.stubEnv('CALLIOPE_BILLING_FILE', file);
  route = { provider: 'openai', model, target: providerTarget('openai').key, evidence: 'live',
    discoveredAt: new Date().toISOString(), capabilities: { chat: true }, contextLength: null,
    maxOutputTokens: null, price: undefined, estimatedCost: null, latencyMs: null, errorRate: null, score: 0, reason: 'fixture' };
  configureAutoCompressor({ enabled: true, triggerThreshold: 80, targetThreshold: 50, preserveRecent: 10, useLlm: false });
});
afterEach(() => { config.resetConfig(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

it('reproduces the real mismatch without dispatching an unusable minimum or discarding the task', async () => {
  expect(estimateInputTokens(messages, [])).toBe(29280);
  const compressed = await autoCompress(messages, 32000, 'openai', model);
  expect(compressed.originalTokens).toBe(29280);
  expect(compressed.messages).toEqual(messages);
  expect(() => calculateMaxTokens('openai', model, messages, [])).toThrow(/leaves 160.*reviewed provider limits/);
  expect(calculateMaxTokens('openai', model, messages, [], 100)).toBe(100);
});

it('uses positive reviewed bounds for the full original task without changing discovery or explicit caps', async () => {
  write(); const original = structuredClone(route);
  expect(getModelContextLimit('openai', model)).toBe(32000);
  await withReviewedModelLimits(route, project, async () => {
    expect(getModelContextLimit('openai', model)).toBe(1050000);
    expect(getModelMaxOutput('openai', model)).toBe(128000);
    expect(calculateMaxTokens('openai', model, messages, [])).toBe(128000);
    expect(calculateMaxTokens('openai', model, messages, [], 16384)).toBe(16384);
    const compressed = await autoCompress(messages, getModelContextLimit('openai', model), 'openai', model);
    expect(compressed.messages).toEqual(messages);
    expect(compressed.originalTokens).toBe(29280);
    const quote = providerQuote(route, messages, [], false, 16384, readBillingEvidence(route, project), undefined, true);
    expect(quote.inputTokens).toBe(29280);
    expect(quote.outputTokens).toBe(16384);
  });
  expect(route).toEqual(original);
  expect(getModelContextLimit('openai', model)).toBe(32000);
});

it('keeps smaller live limits and does not leak one request model into another', () => {
  write();
  withReviewedModelLimits({ ...route, contextLength: 64000, maxOutputTokens: 4096 }, project, () => {
    expect(getModelContextLimit('openai', model)).toBe(64000);
    expect(calculateMaxTokens('openai', model, messages, [])).toBe(4096);
    expect(getModelContextLimit('openai', 'another-fixture')).toBe(32000);
    expect(getModelContextLimit('anthropic', model)).toBe(32000);
  });
});

it('uses fresh live route limits even when a separate model-cache entry or reviewed profile is absent', () => {
  withReviewedModelLimits({ ...route, contextLength: 64000, maxOutputTokens: 4096 }, project, () => {
    expect(calculateMaxTokens('openai', model, messages, [])).toBe(4096);
    expect(getModelContextLimit('openai', model)).toBe(64000);
  });
  expect(getModelContextLimit('openai', model)).toBe(32000);
});

it('keeps a useful explicit output allowance in small live windows and still refuses overflow', () => {
  withReviewedModelLimits({ ...route, contextLength: 900, maxOutputTokens: 100 }, project, () => {
    expect(calculateMaxTokens('openai', model, [{ role: 'user', content: 'A short request' }], [], 100)).toBe(100);
    expect(() => calculateMaxTokens('openai', model, [{ role: 'user', content: 'x'.repeat(1500) }], [], 100)).toThrow(/reduce the input/);
  });
});

it.each(['removed', 'changed', 'expired', 'target'])('refuses %s evidence during a request rather than inheriting old bounds', kind => {
  write();
  withReviewedModelLimits(route, project, () => {
    expect(getModelContextLimit('openai', model)).toBe(1050000);
    if (kind === 'removed') fs.unlinkSync(file);
    else if (kind === 'changed') write(profile({ limits: { contextLength: 64000, maxOutputTokens: 2048 } }));
    else if (kind === 'expired') write(profile({ checkedAt: Date.now() - 10000, expiresAt: Date.now() - 1 }));
    else config.setProviderCred('openai', { apiKey: 'fixture', baseUrl: 'https://another-openai.invalid/v1' });
    expect(() => calculateMaxTokens('openai', model, messages, [])).toThrow();
  });
});

it('isolates concurrent request limits across awaits and restores the ordinary model view', async () => {
  const other = 'fixture-second-model';
  fs.writeFileSync(file, JSON.stringify({ version: 2, profiles: [profile(), profile({ model: other,
    limits: { contextLength: 64000, maxOutputTokens: 4096 } })] }), { mode: 0o600 });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = withReviewedModelLimits(route, project, async () => {
    expect(getModelContextLimit('openai', model)).toBe(1050000);
    await blocked;
    expect(getModelContextLimit('openai', model)).toBe(1050000);
  });
  await withReviewedModelLimits({ ...route, model: other }, project, async () => {
    await Promise.resolve();
    expect(getModelContextLimit('openai', other)).toBe(64000);
    expect(getModelContextLimit('openai', model)).toBe(32000);
    release();
  });
  await first;
  expect(getModelContextLimit('openai', model)).toBe(32000);
});

it.each([{ evidence: 'explicit-unverified' }, { discoveredAt: new Date(0).toISOString() },
  { capabilities: { chat: false } }])('cannot turn rejected or stale discovery into eligibility: %j', patch => {
  write();
  expect(() => withReviewedModelLimits({ ...route, ...patch } as RouteCandidate, project, () => calculateMaxTokens('openai', model, messages, []))).toThrow(/current matching/);
});

it('includes tool definitions in compression and accounting on the same basis', async () => {
  const tools = [{ name: 'read_file', description: 'd'.repeat(4000), parameters: { type: 'object' as const, properties: {} } }];
  const compressed = await autoCompress(messages, 32000, 'openai', model, undefined, undefined, tools);
  expect(compressed.originalTokens).toBe(estimateInputTokens(messages, tools));
  write();
  const quote = providerQuote(route, messages, tools, false, 1024, readBillingEvidence(route, project), undefined, true);
  expect(quote.inputTokens).toBe(compressed.originalTokens);
  expect(() => calculateMaxTokens('openai', model, messages, tools)).toThrow(/reduce the input\/tool context/);
});

it.each([0, -1, 0.5, Infinity, NaN])('refuses an invalid explicit output cap %s', cap => {
  expect(() => calculateMaxTokens('openai', model, [], [], cap)).toThrow(/maxOutputTokens/);
});

it.each([0, -1, Infinity, NaN])('refuses invalid scoped model bounds %s before invoking the request', value => {
  const action=vi.fn();
  expect(() => withReviewedModelLimits({ ...route, contextLength:value, maxOutputTokens:4096 },project,action)).toThrow();
  expect(() => withReviewedModelLimits({ ...route, contextLength:64000, maxOutputTokens:value },project,action)).toThrow();
  expect(action).not.toHaveBeenCalled();
});
