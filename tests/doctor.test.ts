import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { delimiter } from 'node:path';
import * as config from '../src/config.js';
import { HealthStore, providerTarget } from '../src/health/index.js';
import { diagnoseProviders, formatDoctor, runDoctor } from '../src/doctor.js';
import { clearModelCache } from '../src/model-detection.js';

beforeEach(() => { config.resetConfig(); clearModelCache(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected networking'); })); });
afterEach(() => { config.resetConfig(); clearModelCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('reports every registered provider locally with explicit missing/unknown fields and JSON contracts', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  expect(await runDoctor(['--json'])).toBe(0);
  const report = JSON.parse(String(write.mock.calls[0]![0]));
  expect(report).toMatchObject({ version: 1, type: 'provider-health', localOnly: true });
  expect(report.providers.map((p: { provider: string }) => p.provider)).toEqual(config.getProviderNames());
  expect(report.providers.find((p: { provider: string }) => p.provider === 'deepseek')).toMatchObject({ credentials: 'missing', latencyMs: null, errorRate: null, capabilities: { tools: 'unknown' } });
  expect(fetch).not.toHaveBeenCalled();
  expect(formatDoctor(report)).toContain('unknown means unverified');
});

it.each([['provider', 'unknown'], ['provider'], ['wrong'], ['--unknown'], ['--reset'], ['--timeout-ms', '100'], ['--probe', '--timeout-ms', 'NaN'], ['--probe', '--timeout-ms', '0'], ['--export', 'x', '--probe']])('rejects malformed arguments %j without I/O', async (...args) => {
  const result = await diagnoseProviders(args);
  expect(result).toMatchObject({ exitCode: 2, report: { error: 'invalid-arguments', version: 1 } });
  expect(fetch).not.toHaveBeenCalled();
  expect(formatDoctor(result.report)).toContain('calliope doctor');
});

it('probes live discovery explicitly, records safe evidence, and never sends an inference request', async () => {
  config.setProviderCred('deepseek', { apiKey: 'private-probe-key', baseUrl: 'https://probe.invalid/v1' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'live-chat-model' }] }), { headers: { 'content-type': 'application/json' } })));
  const result = await diagnoseProviders(['provider', 'deepseek', '--probe', '--json']);
  expect(result.exitCode).toBe(0);
  expect(result.report.providers[0]!.discovery).toMatchObject({ status: 'success', modelCount: 1 });
  expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('https://probe.invalid/v1/models');
  expect(JSON.stringify(new HealthStore().export())).not.toContain('private-probe-key');
});

it('records discovery errors with no credential or prompt leak', async () => {
  config.setProviderCred('google', { apiKey: 'private-key' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private upstream response', { status: 400 })));
  const result = await diagnoseProviders(['provider', 'google', '--probe']);
  expect(result.exitCode).toBe(1);
  expect(result.report.providers[0]!.discovery.status).toBe('error');
  expect(JSON.stringify(result.report)).not.toMatch(/private|upstream response/);
  expect(formatDoctor(result.report)).toContain('probe-failed');
});

it('never reports a requested probe with missing credentials as passing', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  const result = await diagnoseProviders(['provider', 'deepseek', '--probe']);
  expect(result).toMatchObject({ exitCode: 1, report: { error: 'probe-failed', providers: [{ credentials: 'missing', discovery: { status: 'unknown' } }] } });
  expect(fetch).not.toHaveBeenCalled();
});

it('bounds discovery time and propagates external cancellation to actual HTTP requests', async () => {
  config.setProviderCred('google', { apiKey: 'private-key' });
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_input, init) => {
    requestSignal = init?.signal as AbortSignal;
    started();
    return new Promise((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true }));
  }));
  const controller = new AbortController();
  const pending = diagnoseProviders(['provider', 'google', '--probe'], { signal: controller.signal });
  await ready; controller.abort();
  expect((await pending).exitCode).toBe(130);
  expect(requestSignal?.aborted).toBe(true);
  const timeout = await diagnoseProviders(['provider', 'google', '--probe', '--timeout-ms', '100']);
  expect(timeout.exitCode).toBe(1);
  expect(timeout.report.providers[0]!.discovery.status).toBe('timeout');
  expect(new HealthStore().read().filter(e => e.type === 'attempt')).toHaveLength(0);
});

it('keeps concurrent discovery cancellation scoped to the correct provider', async () => {
  config.setProviderCred('deepseek', { apiKey: 'synthetic', baseUrl: 'https://deepseek.invalid/v1' });
  config.setProviderCred('xai', { apiKey: 'synthetic', baseUrl: 'https://xai.invalid/v1' });
  const signals: AbortSignal[] = [];
  let finishSecond!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal('fetch', vi.fn((input, init) => new Promise((resolve, reject) => {
    const signal = init!.signal as AbortSignal;
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    if (String(input).includes('xai.invalid')) finishSecond = () => resolve(new Response(JSON.stringify({ data: [{ id: 'live-chat-model' }] }), { headers: { 'content-type': 'application/json' } }));
    if (signals.length === 2) started();
  })));
  const controller = new AbortController();
  const first = diagnoseProviders(['provider', 'deepseek', '--probe'], { signal: controller.signal });
  const second = diagnoseProviders(['provider', 'xai', '--probe']);
  await ready; controller.abort();
  expect((await first).exitCode).toBe(130);
  expect(signals.filter(signal => signal.aborted)).toHaveLength(1);
  finishSecond();
  expect((await second).report.providers[0]!.discovery.status).toBe('success');
});

it.skipIf(process.platform === 'win32')('cancels and reaps a real AWS credential helper before returning', async () => {
  const directory = fs.mkdtempSync(join(process.env.CALLIOPE_CONFIG_DIR!, 'aws-helper-'));
  const pidFile = join(directory, 'pid');
  fs.writeFileSync(join(directory, 'aws'), '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nrequire("node:fs").writeFileSync(process.env.CALLIOPE_AWS_PID, String(process.pid));\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  vi.stubEnv('PATH', directory + delimiter + process.env.PATH);
  vi.stubEnv('CALLIOPE_AWS_PID', pidFile);
  for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'BEDROCK_BASE_URL']) vi.stubEnv(name, '');
  config.setProviderCred('bedrock', { profile: 'synthetic-test-profile' });
  const controller = new AbortController();
  const pending = diagnoseProviders(['provider', 'bedrock', '--probe'], { signal: controller.signal });
  let pid: number | undefined;
  try {
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 3000, interval: 10 });
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    controller.abort();
    expect((await pending).exitCode).toBe(130);
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 1000, interval: 10 });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    await pending;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('resets quarantine by appending an event and performs bounded non-overwriting import/export', async () => {
  const store = new HealthStore(), target = providerTarget('openai');
  for (let i = 0; i < 3; i++) store.append({ provider: target.provider, target: target.key, type: 'attempt', outcome: 'error', failure: 'server' });
  const output = join(process.env.CALLIOPE_CONFIG_DIR!, 'health-export.json');
  fs.rmSync(output, { force: true });
  expect((await diagnoseProviders(['--export', output])).exitCode).toBe(0);
  expect((await diagnoseProviders(['--export', output])).exitCode).toBe(1);
  const reset = await diagnoseProviders(['provider', 'openai', '--reset']);
  expect(reset.report.providers[0]!.quarantine.active).toBe(false);
  expect(store.read()).toHaveLength(4);
  const imported = await diagnoseProviders(['--import', output], { store: new HealthStore(join(process.env.CALLIOPE_HEALTH_DIR!, 'ci')) });
  expect(imported.report.imported).toBe(3);
  expect(imported.report.providers.find(p => p.provider === 'openai')!.sampleCount).toBe(0);
});

it('fails visibly on filesystem denial/corruption without resetting history or exposing paths', async () => {
  const directory = join(process.env.CALLIOPE_CONFIG_DIR!, 'not-a-directory');
  fs.writeFileSync(directory, 'private');
  const result = await diagnoseProviders([], { store: new HealthStore(directory) });
  expect(result.exitCode).toBe(1);
  expect(result.report.error).toBe('diagnostics-unavailable');
  expect(JSON.stringify(result.report)).not.toContain(directory);
  expect(formatDoctor(result.report)).toContain('permissions');
  const cancelled = await diagnoseProviders(['--probe'], { signal: AbortSignal.abort() });
  expect(cancelled.exitCode).toBe(130);
  expect(fetch).not.toHaveBeenCalled();
});
