import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reserveProbe, reserveWorkflowRequest } from '../scripts/conformance/budget.mjs';
import { createRecorder } from '../scripts/conformance/recorder.mjs';

let directory: string;
let file: string;
const budget = { maxCostUsd: 0.005128, inputRate: 1, outputRate: 1, maxOutputTokens: 128 };
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'probe-budget-')); file = join(directory, 'ledger.json'); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('persists before network use, keeps failure reservations across restarts and refuses overspend', () => {
  const reservation = reserveProbe(file, budget);
  expect(JSON.parse(readFileSync(file, 'utf8')).reservations[0].status).toBe('reserved');
  expect(() => reserveProbe(file, budget)).toThrow();
  reservation.finish('failed');
  expect(existsSync(file + '.lock')).toBe(false);
  expect(() => reserveProbe(file, budget)).toThrow('exhausted');
  expect(JSON.parse(readFileSync(file, 'utf8')).reservations).toHaveLength(1);
});

it('accounts for bounded workflow requests in the same ledger without widening capture probes', () => {
  const options = { maxCostUsd: 0.04, inputRate: 1, outputRate: 2, maxInputTokens: 1000, maxOutputTokens: 8192, runId: 'existing-run', maxRunCostUsd: 0.03 };
  reserveProbe(file, { ...options, maxOutputTokens: 128 }).finish('captured');
  const request = reserveWorkflowRequest(file, options);
  expect(() => reserveWorkflowRequest(file, options)).toThrow();
  const pending = JSON.parse(readFileSync(file, 'utf8'));
  expect(pending.reservations[1]).toMatchObject({ id: request.id, kind: 'workflow', maxOutputTokens: 8192, reservedNanoUsd: 17384000, status: 'reserved', runId: 'existing-run' });
  request.finish('failed');
  expect(() => reserveWorkflowRequest(file, options)).toThrow('run dollar budget exhausted');
  expect(() => reserveProbe(file, options)).toThrow('Invalid');
  expect(() => reserveWorkflowRequest(file, { ...options, maxOutputTokens: 8193 })).toThrow('Invalid');
  expect(() => reserveWorkflowRequest(file, { ...options, maxRunCostUsd: 0.04 })).toThrow('run dollar limit changed');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.reservations).toHaveLength(2);expect(saved.reservations[0]).not.toHaveProperty('kind');
  expect(saved.reservations[1].status).toBe('failed');expect(saved.runs).toEqual([{ id: 'existing-run', limitNanoUsd: 30000000 }]);
  expect(existsSync(file + '.lock')).toBe(false);
});

it('rejects malformed budgets, corrupt ledgers, changing the cap and duplicate completion', () => {
  expect(() => reserveProbe(file, { ...budget, inputRate: NaN })).toThrow('Invalid');
  expect(() => reserveProbe(file, { ...budget, maxOutputTokens: 513 })).toThrow('Invalid');
  expect(() => reserveProbe(file, { ...budget, maxCostUsd: Number.MAX_VALUE })).toThrow('safe');
  writeFileSync(file, '{bad');
  expect(() => reserveProbe(file, budget)).toThrow();
  expect(existsSync(file + '.lock')).toBe(false);
  writeFileSync(file, JSON.stringify({ version: 1, limitNanoUsd: 1, reservations: [] }));
  expect(() => reserveProbe(file, budget)).toThrow('limit changed');
  rmSync(file);
  const reservation = reserveProbe(file, budget);
  reservation.finish('captured');
  expect(() => reservation.finish('captured')).toThrow('already closed');
});

it('bounds free/local loops and rejects unrecognized or secret-bearing outcomes', () => {
  const free = { ...budget, maxCostUsd: 0, inputRate: 0, outputRate: 0 };
  const reservation = reserveProbe(file, free);
  expect(() => reservation.finish('secret-key')).toThrow('outcome');
  expect(readFileSync(file, 'utf8')).not.toContain('secret');
  expect(existsSync(file + '.lock')).toBe(false);
  writeFileSync(file, JSON.stringify({ version: 1, limitNanoUsd: 0, reservations: Array(1000).fill({ reservedNanoUsd: 0 }) }));
  expect(() => reserveProbe(file, free)).toThrow('full');
});

it('rejects oversized prompts and honors the caller cancellation signal before sending a request', async () => {
  const fetch = vi.fn(async () => new Response('ok'));
  const controller = new AbortController(); controller.abort();
  await expect(createRecorder(fetch, { protocol: 'chat' }, 64).fetch('https://probe.invalid/', {
    method: 'POST', body: '{}', signal: controller.signal,
  })).rejects.toThrow();
  await expect(createRecorder(fetch, { protocol: 'chat' }, 64).fetch('https://probe.invalid/', {
    method: 'POST', body: JSON.stringify({ messages: ['x'.repeat(4000)] }),
  })).rejects.toThrow('input');
  expect(fetch).not.toHaveBeenCalled();
});

it('enforces a per-run ceiling across failures, cancellation and restart without resetting the total', () => {
  const scoped = { ...budget, maxCostUsd: 0.015384, runId: 'smoke-1', maxRunCostUsd: 0.010256 };
  reserveProbe(file, scoped).finish('failed');
  reserveProbe(file, scoped).finish('cancelled');
  expect(() => reserveProbe(file, scoped)).toThrow('run dollar budget exhausted');
  expect(() => reserveProbe(file, { ...budget, maxCostUsd: scoped.maxCostUsd })).toThrow('run ID');
  expect(() => reserveProbe(file, { ...scoped, maxRunCostUsd: 0.015384 })).toThrow('run dollar limit changed');
  reserveProbe(file, { ...scoped, runId: 'smoke-2' }).finish('captured');
  expect(() => reserveProbe(file, { ...scoped, runId: 'smoke-3' })).toThrow('Probe dollar budget exhausted');
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  expect(ledger.reservations.map(r => r.status)).toEqual(['failed', 'cancelled', 'captured']);
  expect(ledger.reservations.reduce((sum, r) => sum + r.reservedNanoUsd, 0)).toBe(15384000);
  expect(ledger.runs).toEqual([{ id: 'smoke-1', limitNanoUsd: 10256000 }, { id: 'smoke-2', limitNanoUsd: 10256000 }]);
});

it('rejects malformed run limits and corrupted run history without spending or leaving locks', () => {
  for (const options of [{ runId: 'run' }, { maxRunCostUsd: 1 }, { runId: '../run', maxRunCostUsd: 0 },
    { runId: 'run', maxRunCostUsd: NaN }, { runId: 'run', maxRunCostUsd: -1 }, { runId: 'run', maxRunCostUsd: 1 }]) {
    expect(() => reserveProbe(file, { ...budget, ...options })).toThrow('Invalid probe run');
    expect(existsSync(file)).toBe(false);
  }
  const scoped = { ...budget, maxCostUsd: 1, runId: 'run', maxRunCostUsd: 0.1 };
  for (const runs of [null, {}, [null], [{ id: 'run', limitNanoUsd: -1 }],
    [{ id: 'run', limitNanoUsd: 100 }, { id: 'run', limitNanoUsd: 100 }]]) {
    writeFileSync(file, JSON.stringify({ version: 1, limitNanoUsd: 1e9, reservations: [], runs }));
    expect(() => reserveProbe(file, scoped)).toThrow('Invalid probe run ledger');
    expect(existsSync(file + '.lock')).toBe(false);
  }
  writeFileSync(file, JSON.stringify({ version: 1, limitNanoUsd: 1e9, reservations: [{ reservedNanoUsd: 1, runId: 'orphan' }], runs: [] }));
  expect(() => reserveProbe(file, scoped)).toThrow('Invalid probe run ledger');
});
