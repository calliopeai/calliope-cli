/**
 * Bench 3 — Memory flatness over a long session.
 *
 * Simulates a ~4h / 500-message session through the REAL pieces that accumulate
 * state as a session grows:
 *   - the real transcript state hook   (src/ui/state/use-transcript-state.ts)
 *   - the real Static scrollback        (src/ui/regions/static-scrollback.tsx,
 *     Ink <Static> — write-once history)
 *   - the real streaming flusher        (createStreamFlusher, src/streaming.ts)
 *
 * These are composed in a minimal host with an imperative handle (the same thing
 * the agent loop does: call addMessage / drive setStreaming), then driven:
 *   - 500 messages, realistic 1-5KB bodies, types cycling user/assistant/tool
 *   - every 10th message produced via a real 200-token streaming burst (50 bursts)
 * Post-GC heapUsed is sampled every 50 messages.
 *
 * GATES:
 *   - OLS slope of post-GC heapUsed over the FINAL 300 messages <= budget KB/msg.
 *     A transcript is a scrollback, so heap is EXPECTED to grow ~linearly with
 *     retained message bodies; the budget = observed retention + headroom, so it
 *     trips on a real leak (streaming buffers, listeners, fibers, undo growth)
 *     ON TOP of expected retention — not on the retention itself.
 *   - absolute post-GC growth across the session < 40MB.
 *
 * HARNESS NOTE: this renders via Ink's own render() with a DISCARDING stdout.
 * ink-testing-library keeps every frame in an unbounded `frames` array
 * (this.frames.push(frame)); that would masquerade as a heap leak. A real
 * terminal consumes writes and drops them — the sink stdout models that.
 *
 * Requires --expose-gc (the bench script sets NODE_OPTIONS=--expose-gc).
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { render as inkRender, Box, Text } from 'ink';
import { linregSlope, fmtKb, fmtMb } from './lib/stats.mjs';
import { BASE_BUDGETS } from './budgets.mjs';

// ---------------------------------------------------------------------------
// Mock external I/O only. The transcript state, Static scrollback and streaming
// flusher under test are all REAL. config/storage are the session's disk/config
// boundary — mocked so addMessage doesn't fsync 500 times and config doesn't hit
// the real store; neither is the thing being measured.
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => {
  const get = vi.fn((key: string) => {
    switch (key) {
      case 'collapseTools': return false;
      case 'toolDisplayLimit': return 0;
      default: return undefined;
    }
  });
  const api = { get, set: vi.fn(), getApiKey: vi.fn(() => undefined), getBaseUrl: vi.fn(() => undefined) };
  return { default: api, ...api };
});

vi.mock('../src/storage.js', () => ({
  addChatMessage: vi.fn(),
}));

import { useTranscriptState } from '../src/ui/state/use-transcript-state.js';
import { StaticScrollback } from '../src/ui/regions/static-scrollback.js';
import { createStreamFlusher } from '../src/streaming.js';
import type { UIMessage } from '../src/ui/types.js';

const h = React.createElement;

// ---------------------------------------------------------------------------
// Discarding stdio for Ink (models a real terminal: writes are consumed, not
// retained). Ink 6 needs columns/rows + write on stdout, and a TTY-ish stdin.
// ---------------------------------------------------------------------------

class SinkStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  writes = 0;
  write = (chunk: string): boolean => {
    this.writes++;
    return true;
  };
}

class SinkStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic content generation (seeded) so the run is reproducible.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation'.split(' ');

/** Build a markdown-ish body of roughly `targetBytes` (exercises renderMarkdown). */
function makeBody(rand: () => number, targetBytes: number): string {
  const parts: string[] = [`## ${WORDS[Math.floor(rand() * WORDS.length)]} summary`, ''];
  let size = parts.join('\n').length;
  while (size < targetBytes) {
    const roll = rand();
    let line: string;
    if (roll < 0.12) {
      line = '```ts\nconst x = foo(bar, baz); // note\n```';
    } else if (roll < 0.25) {
      line = `- ${WORDS[Math.floor(rand() * WORDS.length)]} ${WORDS[Math.floor(rand() * WORDS.length)]}`;
    } else {
      const n = 8 + Math.floor(rand() * 24);
      line = Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ') + '.';
    }
    parts.push(line);
    size += line.length + 1;
  }
  return parts.join('\n');
}

interface MemHandle {
  addMessage: (type: UIMessage['type'], content: string) => void;
  setStreaming: (s: string) => void;
}

function MemHost({ handleRef }: { handleRef: { current: MemHandle | null } }) {
  const { messages, collapseSettings, addMessage } = useTranscriptState();
  const [streaming, setStreaming] = React.useState('');

  React.useEffect(() => {
    handleRef.current = { addMessage, setStreaming };
    return () => {
      handleRef.current = null;
    };
  }, [addMessage]);

  // Same two-zone shape as TranscriptRegion: write-once Static history plus a
  // live streaming block.
  return h(
    React.Fragment,
    null,
    h(StaticScrollback, { messages, collapseSettings }),
    streaming ? h(Box, { flexDirection: 'column' }, h(Text, null, streaming)) : null,
  );
}

const nextTick = () => new Promise((r) => setImmediate(r));

async function forceGcAndSampleHeap(): Promise<number> {
  // Two passes with a tick between: the first frees, the second collects
  // anything promoted/finalized during the first.
  global.gc!();
  await nextTick();
  global.gc!();
  await nextTick();
  return process.memoryUsage().heapUsed;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('memory flatness over a 500-message session', () => {
  it('post-GC heap slope and absolute growth stay within budget', async () => {
    expect(
      typeof global.gc,
      'global.gc is undefined — run with NODE_OPTIONS=--expose-gc (use `npm run bench:mem`)',
    ).toBe('function');

    const handleRef: { current: MemHandle | null } = { current: null };
    const stdout = new SinkStdout();
    const stderr = new SinkStdout();
    const stdin = new SinkStdin();

    const instance = inkRender(h(MemHost, { handleRef }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: stdout as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stderr: stderr as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdin: stdin as any,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    // Wait for the imperative handle to be wired up.
    for (let i = 0; i < 50 && !handleRef.current; i++) await nextTick();
    const handle = handleRef.current!;
    expect(handle, 'MemHost never exposed its handle').toBeTruthy();

    const rand = mulberry32(0x1234abcd);
    const TOTAL = 500;
    const SAMPLE_EVERY = 50;
    const BURST_EVERY = 10;
    const BURST_TOKENS = 200;
    const TYPES: UIMessage['type'][] = ['user', 'assistant', 'tool'];

    const samples: Array<{ count: number; heap: number }> = [];
    samples.push({ count: 0, heap: await forceGcAndSampleHeap() });

    // Produce one message via a real streaming burst, then finalize into history.
    async function streamingBurstMessage(): Promise<void> {
      let acc = '';
      const flusher = createStreamFlusher((delta) => {
        acc += delta;
        handle.setStreaming(acc);
      });
      for (let t = 0; t < BURST_TOKENS; t++) {
        const tok = WORDS[Math.floor(rand() * WORDS.length)] + (rand() < 0.5 ? ' ' : '\n');
        flusher.push(tok);
        // Periodically let a coalesced frame paint (exercises the live zone).
        if (t % 40 === 39) {
          flusher.flush();
          await nextTick();
        }
      }
      flusher.flush();
      flusher.destroy();
      await nextTick();
      // Finalize: the streamed text becomes a Static history entry, live zone clears.
      handle.addMessage('assistant', acc);
      handle.setStreaming('');
      await nextTick();
    }

    for (let i = 1; i <= TOTAL; i++) {
      if (i % BURST_EVERY === 0) {
        await streamingBurstMessage();
      } else {
        const type = TYPES[i % TYPES.length];
        const target = 1024 + Math.floor(rand() * 4096); // 1-5KB
        handle.addMessage(type, makeBody(rand, target));
        await nextTick();
      }

      if (i % SAMPLE_EVERY === 0) {
        samples.push({ count: i, heap: await forceGcAndSampleHeap() });
      }
    }

    instance.unmount();

    // Slope over the FINAL 300 messages (samples with count >= 200).
    const finalWindow = samples.filter((s) => s.count >= TOTAL - 300);
    const slopeBytesPerMsg = linregSlope(
      finalWindow.map((s) => s.count),
      finalWindow.map((s) => s.heap),
    );
    const slopeKbPerMsg = slopeBytesPerMsg / 1024;

    const baseline = samples[0].heap;
    const peak = samples[samples.length - 1].heap;
    const absoluteGrowthBytes = peak - baseline;
    const absoluteGrowthMb = absoluteGrowthBytes / (1024 * 1024);

    const slopeBudget = BASE_BUDGETS.memorySlopeKbPerMsg;
    const absBudget = BASE_BUDGETS.memoryAbsoluteGrowthMb;
    const pass = slopeKbPerMsg <= slopeBudget && absoluteGrowthMb < absBudget;

    // eslint-disable-next-line no-console
    console.log(
      `\n=== Bench 3: Memory flatness (${TOTAL} msgs, ${samples.length} post-GC samples) ===\n` +
        samples
          .map((s) => `  @${String(s.count).padStart(3)} msgs: ${fmtMb(s.heap)} heapUsed`)
          .join('\n') +
        `\n  final-300 slope: ${fmtKb(slopeBytesPerMsg)}/msg  (budget <= ${slopeBudget}KB/msg)\n` +
        `  absolute growth: ${fmtMb(absoluteGrowthBytes)}  (budget < ${absBudget}MB)\n` +
        `  -> ${pass ? 'PASS' : 'FAIL'}\n`,
    );

    mkdirSync(join(__dirname, '.results'), { recursive: true });
    writeFileSync(
      join(__dirname, '.results', 'memory.json'),
      JSON.stringify(
        {
          bench: 'memory',
          messages: TOTAL,
          slopeKbPerMsg,
          slopeBudgetKbPerMsg: slopeBudget,
          absoluteGrowthMb,
          absoluteGrowthBudgetMb: absBudget,
          pass,
          samples,
        },
        null,
        2,
      ),
    );

    expect(slopeKbPerMsg).toBeLessThanOrEqual(slopeBudget);
    expect(absoluteGrowthMb).toBeLessThan(absBudget);
  }, 120_000);
});
