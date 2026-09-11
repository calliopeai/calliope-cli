import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as config from '../src/config.js';
import { HealthStore, providerTarget, summarizeHealth, healthDigest, validateHealthEvent, healthSettings, healthFailure, healthOutcome, healthRemediation } from '../src/health/index.js';
import type { HealthEvent } from '../src/health/index.js';

let directory: string, now: number, store: HealthStore;
beforeEach(() => {
  config.resetConfig();
  directory = fs.mkdtempSync(join(tmpdir(), 'calliope-health-'));
  now = Date.parse('2026-09-11T00:00:00Z');
  store = new HealthStore(directory, {}, () => now);
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); config.resetConfig(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const target = () => providerTarget('openai');
function attempt(outcome: 'error' | 'success' | 'cancelled' | 'timeout', retryIndex = 0) {
  now += 10;
  return store.append({ provider: 'openai', target: target().key, type: 'attempt', outcome, retryIndex, durationMs: 120,
    ...(outcome === 'error' ? { failure: 'server' as const } : {}) });
}
const snapshot = () => summarizeHealth(store.read(), target(), store.settings, now);

it('persists observations across restart with immutable IDs, private permissions and measured rates', () => {
  attempt('error'); attempt('timeout', 1); attempt('success', 2); attempt('cancelled');
  store = new HealthStore(directory, {}, () => now);
  const health = snapshot();
  expect(health).toMatchObject({ sampleCount: 3, latencyMs: 120, errorRate: 2 / 3, retryRate: 2 / 3, timeoutRate: 1 / 3 });
  expect(health.lastFailure?.at).toBeTruthy(); expect(health.lastSuccessAt).toBeTruthy();
  expect(new Set(store.read().map(event => event.id)).size).toBe(4);
  if (process.platform !== 'win32') expect(fs.statSync(join(directory, fs.readdirSync(directory)[0]!)).mode & 0o777).toBe(0o600);
});

it('quarantines repeated failures, ignores user cancellation, expires and recovers on success or manual reset', () => {
  attempt('error'); attempt('cancelled'); attempt('error');
  expect(snapshot().quarantine.active).toBe(false);
  attempt('error'); expect(snapshot().quarantine).toMatchObject({ active: true, reason: 'server', failures: 3 });
  now += 60001; expect(snapshot().quarantine.active).toBe(false);
  attempt('error'); expect(snapshot().quarantine.active).toBe(true);
  attempt('success'); expect(snapshot().quarantine.active).toBe(false);
  attempt('error'); attempt('error'); attempt('error');
  store.append({ provider: 'openai', target: target().key, type: 'reset' });
  expect(snapshot().quarantine.active).toBe(false);
  expect(store.read().filter(e => e.type === 'attempt')).toHaveLength(9);
});

it('preserves sequential event order within one clock tick and honors custom failure windows', () => {
  for (let i = 0; i < 3; i++) store.append({ provider: 'openai', target: target().key, type: 'attempt', outcome: 'error' });
  store.append({ provider: 'openai', target: target().key, type: 'reset' });
  expect(snapshot().quarantine.active).toBe(false);
  now += 301000;
  expect(snapshot().sampleCount).toBe(0);
  expect(snapshot().errorRate).toBeNull();
});

it('keeps the configured quarantine expiry when it outlives the failure-counting window', () => {
  store = new HealthStore(directory, { failureThreshold: 2, failureWindowMs: 1000, quarantineMs: 60000 }, () => now);
  attempt('error'); attempt('error');
  const expiry = snapshot().quarantine.expiresAt;
  now += 2000;
  expect(snapshot()).toMatchObject({ sampleCount: 0, quarantine: { active: true, expiresAt: expiry, failures: 2 } });
  now += 60000;
  expect(snapshot().quarantine.active).toBe(false);
});

it('rotates only expired/excess health events and leaves unrelated files and prior IDs intact', () => {
  store = new HealthStore(directory, { retentionEvents: 10, retentionDays: 1 }, () => now);
  fs.writeFileSync(join(directory, 'unrelated.json'), 'leave intact');
  for (let i = 0; i < 15; i++) attempt('success');
  const ids = store.read().map(event => event.id);
  expect(ids).toHaveLength(10);
  expect(fs.readdirSync(directory)).toHaveLength(11);
  now += 86400001; attempt('success');
  expect(store.read()).toHaveLength(1);
  expect(fs.readFileSync(join(directory, 'unrelated.json'), 'utf8')).toBe('leave intact');
});

it('validates the entire import before writing and prevents imported reset/failure events from affecting local health', () => {
  attempt('error'); attempt('error'); attempt('error');
  const bundle = store.export();
  const other = new HealthStore(join(directory, 'ci'), {}, () => now);
  expect(other.import(bundle)).toBe(3);
  expect(other.import(bundle)).toBe(0);
  expect(summarizeHealth(other.read(), target(), other.settings, now)).toMatchObject({ sampleCount: 0, importedEvents: 3, quarantine: { active: false } });
  const good = other.append({ provider: 'openai', target: target().key, type: 'reset' });
  expect(store.import({ version: 1, events: [good] })).toBe(1);
  expect(snapshot().quarantine.active).toBe(true);
  const before = other.read();
  expect(() => other.import({ version: 1, events: [bundle.events[0], { version: 99 }] })).toThrow();
  expect(other.read()).toEqual(before);
  expect(() => other.import({ version: 1, events: [], apiKey: 'never-save' })).toThrow();
});

it('refuses corrupted, renamed and symlinked history instead of silently resetting it', () => {
  const event = attempt('success');
  const file = join(directory, fs.readdirSync(directory)[0]!);
  fs.writeFileSync(file, JSON.stringify({ ...event, outcome: 'error' }));
  expect(() => store.read()).toThrow('validation');
  fs.writeFileSync(file, JSON.stringify(event));
  const alternate = file.replace(event.id, '00000000-0000-4000-8000-000000000000');
  fs.renameSync(file, alternate);
  expect(() => store.read()).toThrow('validation');
  fs.unlinkSync(alternate); fs.symlinkSync(join(directory, 'unrelated.json'), file);
  expect(() => store.read()).toThrow('validation');
});

it('rejects malformed schema, secret-bearing payloads and invalid settings', () => {
  const event = attempt('success');
  for (const patch of [{ prompt: 'private' }, { apiKey: 'private' }, { target: '../escape' }, { durationMs: NaN }, { retryIndex: -1 }, { provider: 'invented' }, { capabilities: { tools: 'yes' } }, { version: 2 }, { at: '2099-01-01T00:00:00.000Z' }]) {
    const { sha256: _sha, ...body } = { ...event, ...patch };
    expect(() => validateHealthEvent({ ...body, sha256: healthDigest(body) }, now)).toThrow();
  }
  expect(() => store.append({ provider: 'openai', target: target().key, type: 'conformance', outcome: 'success' })).toThrow();
  expect(() => healthSettings({ failureThreshold: 0 })).toThrow();
  expect(() => config.set('providerHealth', { quarantineMs: -1 })).toThrow();
});

it('keeps prompts/errors/credential-bearing URL components out of reports and persisted observations', () => {
  config.setProviderCred('deepseek', { apiKey: 'fake', baseUrl: 'https://user:secret@example.invalid/private-key-route?api_key=private#secret' });
  const endpoint = providerTarget('deepseek');
  expect(endpoint.endpoint).toBe('https://example.invalid/[configured-path]');
  expect(JSON.stringify(endpoint)).not.toContain('private-key-route');
  const error = Object.assign(new Error('private prompt and Bearer fake'), { status: 401 });
  const classification = healthFailure(error);
  expect(classification).toEqual({ failure: 'authentication', httpStatus: 401 });
  store.append({ provider: endpoint.provider, target: endpoint.key, type: 'attempt', outcome: 'error', ...classification });
  expect(JSON.stringify(store.export())).not.toMatch(/private|Bearer|fake/);
  expect(providerTarget('openai-compat').credentials).toBe('missing');
  expect(() => providerTarget('ai21')).toThrow('retired');
});

it('reports capability and conformance observations without inferring missing evidence', () => {
  expect(snapshot().capabilities).toEqual({ tools: 'unknown', streaming: 'unknown', cancellation: 'unknown', usage: 'unknown' });
  store.append({ provider: 'openai', target: target().key, type: 'conformance', outcome: 'success', evidenceHash: 'a'.repeat(64), capabilities: { tools: true, streaming: true, usage: false } });
  expect(snapshot().lastSuccessfulConformanceAt).toBeTruthy();
  expect(snapshot().capabilities).toEqual({ tools: true, streaming: true, cancellation: 'unknown', usage: false });
  expect(healthRemediation(target(), snapshot()).join(' ')).toContain('discovery');
});

it.each([
  [429, 'Too many requests', 'rate_limit'], [429, 'quota exhausted', 'quota'],
  [504, 'gateway', 'timeout'], [500, 'failure', 'server'], [400, 'bad model', 'invalid_request'],
  [undefined, 'ECONNREFUSED', 'network'], [undefined, 'uncategorized', 'unknown'],
] as const)('classifies %s without retaining upstream text', (status, message, kind) => {
  expect(healthFailure(Object.assign(new Error(message), { status })).failure).toBe(kind);
});
it('distinguishes timeout from user cancellation', () => {
  expect(healthOutcome(new DOMException('stop', 'AbortError'))).toBe('cancelled');
  expect(healthOutcome(new Error('timeout'))).toBe('timeout');
  expect(healthOutcome(new Error('failure'))).toBe('error');
  expect(healthOutcome(new Error('failure'), AbortSignal.abort(new DOMException('deadline', 'TimeoutError')))).toBe('timeout');
});
