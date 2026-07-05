/**
 * Render-isolation tests for the decomposed TerminalChat tree (#184).
 *
 * Mounts the real decomposed component tree (with heavy I/O modules mocked) and
 * proves the two properties the decomposition set out to guarantee:
 *
 *  1. A keystroke re-renders ONLY the input region — the transcript and status
 *     regions do not re-render while typing.
 *  2. resetSession() clears session state IN PLACE — the component tree is never
 *     unmounted/remounted (the old resetKey full-remount pattern is gone).
 *
 * Regions are instrumented via the render probe (regions/render-probe.ts), which
 * counts renders/mounts only while enabled and is a no-op in production.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

// ---------------------------------------------------------------------------
// Mock heavy / IO-bound modules before importing the tree under test
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => {
  const get = vi.fn((key: string) => {
    switch (key) {
      case 'defaultProvider': return 'anthropic';
      case 'defaultModel': return 'claude-3-5-sonnet';
      case 'maxIterations': return 10;
      case 'circuitBreakersEnabled': return false; // skip breaker construction
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
  // Some modules import the default export (config.get); others use named
  // imports — provide both.
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

// ---------------------------------------------------------------------------
// Import the tree + probe AFTER mocks are registered
// ---------------------------------------------------------------------------

import { TerminalChat } from '../src/ui/index.js';
import type { ChatHandle } from '../src/ui/index.js';
import {
  enableRenderProbe, getRenderCount, getMountCount,
} from '../src/ui/regions/render-probe.js';

const h = React.createElement;
const tick = () => new Promise(resolve => setTimeout(resolve, 25));

describe('TerminalChat render isolation (#184)', () => {
  beforeEach(() => {
    enableRenderProbe(true);
  });
  afterEach(() => {
    enableRenderProbe(false);
  });

  it('a keystroke re-renders only the input region, not transcript or status', async () => {
    const ref: { current: ChatHandle | null } = { current: null };
    const { stdin, unmount, lastFrame } = render(h(TerminalChat, { controllerRef: ref }));

    // Let the initial render + mount effects settle.
    await tick();
    expect(lastFrame()).toContain('calliope>'); // input prompt is on screen

    const transcriptBefore = getRenderCount('transcript');
    const statusBefore = getRenderCount('status');
    const inputBefore = getRenderCount('input');

    // Type five characters.
    for (const ch of 'hello') {
      stdin.write(ch);
      await tick();
    }

    const transcriptAfter = getRenderCount('transcript');
    const statusAfter = getRenderCount('status');
    const inputAfter = getRenderCount('input');

    // The typed characters are echoed by the input region.
    expect(lastFrame()).toContain('hello');

    // Transcript and status regions did NOT re-render while typing.
    expect(transcriptAfter).toBe(transcriptBefore);
    expect(statusAfter).toBe(statusBefore);

    // The input region re-rendered on each keystroke.
    expect(inputAfter).toBeGreaterThan(inputBefore);

    unmount();
  });

  it('resetSession() resets state in place without remounting the tree', async () => {
    const ref: { current: ChatHandle | null } = { current: null };
    const { stdin, unmount } = render(h(TerminalChat, { controllerRef: ref }));

    await tick();

    // Mounted exactly once.
    expect(getMountCount('terminal-chat')).toBe(1);
    expect(ref.current).not.toBeNull();

    // Put the input region into a non-initial state (type some text).
    for (const ch of 'draft message') {
      stdin.write(ch);
      await tick();
    }

    const transcriptBefore = getRenderCount('transcript');
    const statusBefore = getRenderCount('status');

    // Reset the session.
    ref.current!.resetSession();
    await tick();

    // The tree was never unmounted/remounted — still exactly one mount.
    expect(getMountCount('terminal-chat')).toBe(1);

    // Resetting state re-rendered the affected regions in place.
    expect(getRenderCount('transcript')).toBeGreaterThan(transcriptBefore);
    expect(getRenderCount('status')).toBeGreaterThan(statusBefore);

    unmount();
  });

  it('typing does not re-render the modal host either (modal stays closed)', async () => {
    const ref: { current: ChatHandle | null } = { current: null };
    const { stdin, unmount } = render(h(TerminalChat, { controllerRef: ref }));

    await tick();
    const modalBefore = getRenderCount('modal');

    for (const ch of 'abc') {
      stdin.write(ch);
      await tick();
    }

    expect(getRenderCount('modal')).toBe(modalBefore);
    unmount();
  });
});
