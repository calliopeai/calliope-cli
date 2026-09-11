import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reserveProbe } from '../scripts/conformance/budget.mjs';
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
