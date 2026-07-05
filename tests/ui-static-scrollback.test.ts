/**
 * Static scrollback + frame-bounded streaming tests (#185).
 *
 * Proves the two performance mechanisms added in #185:
 *
 *  1. STATIC SCROLLBACK — completed messages render through Ink's <Static>, so
 *     each is emitted once and never re-traversed when a new message appends or
 *     the streaming block below updates. A clearCount bump remounts <Static> so
 *     clearing/reset resets its write-once emitted-count.
 *
 *  2. FRAME-BOUNDED STREAMING — createStreamFlusher coalesces provider tokens so
 *     the UI setter fires at ~30fps (immediate first flush, batched rest, final
 *     flush drains the tail) instead of once per token.
 *
 * Note on <Static> + ink-testing-library: Ink runs in debug mode there, which
 * ACCUMULATES all static output and re-emits it as a prefix on every frame (it
 * mirrors a real terminal's un-eraseable scrollback). So "static not re-emitted"
 * cannot be shown by counting a message across frames — every frame after it was
 * printed contains it. The write-once property is instead proven via the render
 * probe: Static invokes the item render fn exactly once per message, regardless
 * of how many times the parent region re-renders.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

// ---------------------------------------------------------------------------
// Mocks — config feeds hud/api + collapse defaults; storage backs addMessage.
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

// ---------------------------------------------------------------------------
// Imports AFTER mocks.
// ---------------------------------------------------------------------------

import { TranscriptRegion } from '../src/ui/regions/transcript-region.js';
import type { TranscriptRegionProps } from '../src/ui/regions/transcript-region.js';
import { useTranscriptState } from '../src/ui/state/use-transcript-state.js';
import type { TranscriptStateHook } from '../src/ui/state/use-transcript-state.js';
import { createStreamFlusher } from '../src/streaming.js';
import {
  enableRenderProbe, getRenderCount, getMountCount,
} from '../src/ui/regions/render-probe.js';
import type { UIMessage, CollapseSettings } from '../src/ui/types.js';
import type { Mode } from '../src/types.js';

const h = React.createElement;
const tick = () => new Promise(resolve => setTimeout(resolve, 25));

const COLLAPSE: CollapseSettings = { collapseTools: false, collapseThinking: false, toolDisplayLimit: 0 };
const sys = (id: string, content: string): UIMessage => ({ id, type: 'system', content });

/** Build TranscriptRegion props with stable defaults so only the fields under
 *  test change identity between rerenders. */
function tp(over: Partial<TranscriptRegionProps>): TranscriptRegionProps {
  return {
    messages: [],
    collapseSettings: COLLAPSE,
    clearCount: 0,
    isProcessing: false,
    thinkingState: null,
    streamingResponse: '',
    activityState: null,
    debugEnabled: false,
    mode: 'work' as Mode,
    queuedCount: 0,
    ...over,
  };
}

// ===========================================================================
// 1. Static scrollback rendering
// ===========================================================================

describe('StaticScrollback rendering (#185)', () => {
  beforeEach(() => { enableRenderProbe(true); });
  afterEach(() => { enableRenderProbe(false); });

  it('emits each completed message once and never re-emits on streaming updates or appends', async () => {
    const msgs = [sys('a', 'ALPHA1'), sys('b', 'BRAVO2'), sys('c', 'CHARLIE3')];
    const { rerender, lastFrame, unmount } = render(h(TranscriptRegion, tp({ messages: msgs })));
    await tick();

    // Static rendered each of the three items exactly once.
    expect(getRenderCount('transcript-item')).toBe(3);
    expect(lastFrame()).toContain('ALPHA1');
    expect(lastFrame()).toContain('CHARLIE3');

    // Streaming updates: change only streamingResponse, keep the same messages
    // reference. Five re-renders of the transcript region.
    for (const s of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
      rerender(h(TranscriptRegion, tp({ messages: msgs, streamingResponse: s })));
      await tick();
    }

    // No completed item was re-emitted despite the streaming churn.
    expect(getRenderCount('transcript-item')).toBe(3);
    // The live zone shows the streaming text; history is untouched.
    expect(lastFrame()).toContain('Hello');
    // Each completed message still appears exactly once in the current frame.
    expect((lastFrame()!.match(/ALPHA1/g) || []).length).toBe(1);

    // Appending a fourth message emits ONLY the new item.
    const grown = [...msgs, sys('d', 'DELTA4')];
    rerender(h(TranscriptRegion, tp({ messages: grown, streamingResponse: 'Hello' })));
    await tick();
    expect(getRenderCount('transcript-item')).toBe(4);
    expect(lastFrame()).toContain('DELTA4');

    unmount();
  });

  it('remounts Static on a clearCount bump so post-clear messages render', async () => {
    const { rerender, lastFrame, unmount } = render(
      h(TranscriptRegion, tp({ messages: [sys('a', 'KEEP1')], clearCount: 0 })),
    );
    await tick();
    expect(getMountCount('transcript-static')).toBe(1);
    expect(lastFrame()).toContain('KEEP1');

    // Clear: empty list + clearCount bump (exactly what the transcript state does).
    rerender(h(TranscriptRegion, tp({ messages: [], clearCount: 1 })));
    await tick();
    // The clearCount key change remounted Static (fresh write-once emitted-count).
    expect(getMountCount('transcript-static')).toBe(2);

    // A message appended after the clear still renders — Static is not stuck.
    rerender(h(TranscriptRegion, tp({ messages: [sys('b', 'FRESH2')], clearCount: 1 })));
    await tick();
    expect(lastFrame()).toContain('FRESH2');
    // Same clearCount => no additional remount from the append.
    expect(getMountCount('transcript-static')).toBe(2);

    unmount();
  });
});

// ===========================================================================
// 2. clearCount wiring in the transcript state
// ===========================================================================

describe('useTranscriptState clearCount (#185)', () => {
  function Harness({ apiRef }: { apiRef: { current: TranscriptStateHook | null } }) {
    const state = useTranscriptState();
    apiRef.current = state;
    return h(React.Fragment, null);
  }

  it('bumps clearCount when the list shrinks (clear/reset/undo), never on append', async () => {
    const apiRef: { current: TranscriptStateHook | null } = { current: null };
    const { unmount } = render(h(Harness, { apiRef }));
    await tick();
    expect(apiRef.current!.clearCount).toBe(0);

    // Two appends — the list only grows, so clearCount stays put.
    apiRef.current!.addMessage('user', 'one');
    await tick();
    apiRef.current!.addMessage('assistant', 'two');
    await tick();
    expect(apiRef.current!.messages.length).toBe(2);
    expect(apiRef.current!.clearCount).toBe(0);

    // reset() empties the list — a shrink — which bumps clearCount once.
    apiRef.current!.reset();
    await tick();
    expect(apiRef.current!.messages.length).toBe(0);
    expect(apiRef.current!.clearCount).toBe(1);

    // Undo-style shrink: grow, then restore a shorter prefix, bumps again.
    apiRef.current!.addMessage('user', 'a');
    await tick();
    apiRef.current!.addMessage('user', 'b');
    await tick();
    expect(apiRef.current!.clearCount).toBe(1); // appends did not bump
    apiRef.current!.setMessages(prev => prev.slice(0, 1));
    await tick();
    expect(apiRef.current!.messages.length).toBe(1);
    expect(apiRef.current!.clearCount).toBe(2);

    unmount();
  });
});

// ===========================================================================
// 3. Frame-bounded streaming flusher
// ===========================================================================

describe('createStreamFlusher (#185)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('flushes the first token immediately then batches the rest to <=30fps', () => {
    const onFlush = vi.fn();
    const flusher = createStreamFlusher(onFlush, 33);

    // First token flushes synchronously (leading edge, perceived latency).
    flusher.push('t0 ');
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenLastCalledWith('t0 ');

    // 99 more tokens within the same frame window — all coalesced, no new flush.
    for (let i = 1; i < 100; i++) flusher.push(`t${i} `);
    expect(onFlush).toHaveBeenCalledTimes(1);

    // Completion drains the batched tail.
    flusher.flush();
    expect(onFlush).toHaveBeenCalledTimes(2);

    // Far fewer than 100 calls, yet every token was delivered exactly once.
    expect(onFlush.mock.calls.length).toBeLessThanOrEqual(4);
    const delivered = onFlush.mock.calls.map(c => c[0]).join('');
    const expected = Array.from({ length: 100 }, (_, i) => `t${i} `).join('');
    expect(delivered).toBe(expected);
  });

  it('fires a trailing flush after the interval elapses', () => {
    const onFlush = vi.fn();
    const flusher = createStreamFlusher(onFlush, 33);

    flusher.push('lead');       // leading flush
    expect(onFlush).toHaveBeenCalledTimes(1);
    flusher.push('tail');       // buffered; trailing flush scheduled
    expect(onFlush).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(33); // trailing flush fires
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith('tail');

    // Nothing pending — advancing further does not flush again.
    vi.advanceTimersByTime(1000);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it('destroy() drops buffered tokens and cancels the pending timer', () => {
    const onFlush = vi.fn();
    const flusher = createStreamFlusher(onFlush, 33);

    flusher.push('lead');   // leading flush
    flusher.push('dropped'); // buffered + timer scheduled
    expect(onFlush).toHaveBeenCalledTimes(1);

    flusher.destroy();
    vi.advanceTimersByTime(1000);
    // The scheduled flush never fires and the tail is dropped.
    expect(onFlush).toHaveBeenCalledTimes(1);

    // A post-destroy flush is a no-op (buffer already cleared).
    flusher.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('flush() with an empty buffer does not call the sink', () => {
    const onFlush = vi.fn();
    const flusher = createStreamFlusher(onFlush, 33);
    flusher.flush();
    expect(onFlush).not.toHaveBeenCalled();
  });
});
