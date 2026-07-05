/**
 * Bench 2 — Keystroke-to-paint.
 *
 * Mounts the REAL decomposed TerminalChat tree (heavy I/O modules mocked, reusing
 * the exact mock surface from tests/ui-render-isolation.test.ts), writes single
 * characters to stdin, and measures the time from stdin.write to the frame that
 * echoes the character in the input line.
 *
 * WHAT THE NUMBER MEANS. ink-testing-library renders with `debug: true`, which
 * disables Ink's production render throttle (Ink: `unthrottled = options.debug`).
 * So this measures the *unthrottled per-keystroke render-compute cost* — input
 * parse + React re-render + Yoga layout + string paint — which is exactly the
 * work the 16ms (one 60fps frame) budget targets. Production additionally caps
 * output at ~30fps (leading-edge), so an isolated keystroke still paints on the
 * leading edge; this harness isolates the compute, not the frame cap.
 *
 * Runs a 10-sample warmup (discarded) then >=100 measured samples; gates p95.
 *
 * NOTE: this file lives under bench/ and is NOT matched by the default vitest
 * include (tests/**), so `npm test` never runs it. It runs only under the
 * explicit bench config (bench/vitest.bench.config.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { render } from 'ink-testing-library';
import { summarize } from './lib/stats.mjs';
import { budget, CI } from './budgets.mjs';

// ---------------------------------------------------------------------------
// Mock heavy / IO-bound modules before importing the tree under test.
// Mirrors tests/ui-render-isolation.test.ts so the mounted tree is identical.
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => {
  const get = vi.fn((key: string) => {
    switch (key) {
      case 'defaultProvider': return 'anthropic';
      case 'defaultModel': return 'claude-3-5-sonnet';
      case 'maxIterations': return 10;
      case 'circuitBreakersEnabled': return false;
      case 'collapseTools': return false;
      case 'toolDisplayLimit': return 0;
      case 'sessionLogLimit': return 0;
      default: return undefined;
    }
  });
  const api = {
    get,
    set: vi.fn(),
    getApiKey: vi.fn(() => undefined),
    getBaseUrl: vi.fn(() => undefined),
    setProviderCred: vi.fn(),
  };
  return { default: api, ...api };
});

vi.mock('../src/storage.js', () => ({
  getOrCreateSession: vi.fn(() => ({ id: 'test-session', projectPath: '/tmp/test-project' })),
  saveIterationLedger: vi.fn(),
  loadIterationLedger: vi.fn(() => undefined),
  addChatMessage: vi.fn(),
  loadMessageHistory: vi.fn(() => null),
  getChatHistory: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  listSessions: vi.fn(() => []),
}));

vi.mock('../src/memory.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
}));

vi.mock('../src/hooks.js', () => ({
  executeHooks: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/fleet.js', () => ({
  fleetInit: vi.fn(() => Promise.resolve(false)),
  fleetStatus: vi.fn(() => null),
  fleetActive: vi.fn(() => false),
  fleetStartPolling: vi.fn(),
  fleetPostOnline: vi.fn(),
  fleetPostOffline: vi.fn(() => Promise.resolve()),
  fleetPostMessage: vi.fn(),
}));

vi.mock('../src/model-detection.js', () => ({
  getModelContextLimit: vi.fn(() => 128000),
  preWarmModelCache: vi.fn(() => Promise.resolve()),
  getAvailableModels: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../src/providers/index.js', () => ({
  selectProvider: (p: string) => p || 'anthropic',
}));

vi.mock('../src/git-status.js', () => ({
  getGitStatus: vi.fn(() => null),
}));

import { TerminalChat } from '../src/ui/index.js';

const h = React.createElement;

const CURSOR = '▌';
const PROMPT = 'calliope> ';
const EMPTY_MARK = `${PROMPT}${CURSOR}`;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

// Broadly strip ANSI (CSI + OSC) so we can match the plain input line.
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('keystroke-to-paint', () => {
  it('p95 stdin.write -> frame-containing-char stays within budget', async () => {
    const { stdin, lastFrame, unmount } = render(h(TerminalChat));

    const frameText = () => stripAnsi(lastFrame() ?? '');

    async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
      const start = performance.now();
      while (!predicate()) {
        if (performance.now() - start > timeoutMs) {
          throw new Error(`waitFor timed out (${label}). Last input frame:\n${frameText()}`);
        }
        await new Promise((r) => setImmediate(r));
      }
    }

    // Let the initial render + mount effects settle to an empty prompt.
    await waitFor(() => frameText().includes(EMPTY_MARK), 'initial empty prompt', 5000);

    const WARMUP = 10;
    const MEASURED = 120;
    const latencies: number[] = [];

    for (let i = 0; i < WARMUP + MEASURED; i++) {
      const ch = ALPHABET[i % ALPHABET.length];

      // Timed region: keystroke -> frame echoes the char right after the prompt.
      const t0 = performance.now();
      stdin.write(ch);
      await waitFor(() => frameText().includes(`${PROMPT}${ch}`), `echo '${ch}'`);
      const latency = performance.now() - t0;

      if (i >= WARMUP) latencies.push(latency);

      // Reset the input to empty (untimed) so the next sample starts clean.
      stdin.write('\x7f');
      await waitFor(() => frameText().includes(EMPTY_MARK), 'reset to empty');
    }

    unmount();

    const s = summarize(latencies);
    const p95Budget = budget('keystrokeP95Ms');

    // eslint-disable-next-line no-console
    console.log(
      `\n=== Bench 2: Keystroke-to-paint (n=${s.n}${CI ? ', CI mode' : ''}) ===\n` +
        `  min ${s.min.toFixed(2)}ms  median ${s.median.toFixed(2)}ms  ` +
        `p95 ${s.p95.toFixed(2)}ms  max ${s.max.toFixed(2)}ms\n` +
        `  budget: p95 <= ${p95Budget}ms${CI ? ' (CI x2)' : ''}  ->  ${s.p95 <= p95Budget ? 'PASS' : 'FAIL'}\n`,
    );

    mkdirSync(join(__dirname, '.results'), { recursive: true });
    writeFileSync(
      join(__dirname, '.results', 'keystroke.json'),
      JSON.stringify(
        {
          bench: 'keystroke',
          ci: CI,
          budgetP95Ms: p95Budget,
          pass: s.p95 <= p95Budget,
          samples: s.n,
          min: s.min,
          median: s.median,
          p95: s.p95,
          max: s.max,
        },
        null,
        2,
      ),
    );

    expect(s.n).toBeGreaterThanOrEqual(100);
    expect(s.p95).toBeLessThanOrEqual(p95Budget);
  }, 60_000);
});
