/**
 * Enabled-path tests for src/fleet.ts.
 *
 * The default (disabled) path lives in fleet.test.ts. Here the config mock
 * reports fleet.enabled=true and the scuttlebot module is mocked so we can
 * assert the lazy single load, the enable/disable persistence, and that every
 * fleet* helper delegates to the underlying client only while active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  store: { fleet: { enabled: true } } as Record<string, any>,
  setCalls: [] as Array<[string, any]>,
}));

const sb = vi.hoisted(() => {
  const client = {
    initialize: vi.fn(async () => true),
    isEnabled: vi.fn(() => true),
    getStatus: vi.fn(() => ({ enabled: true, connected: true, nick: 'n', config: undefined })),
    startPolling: vi.fn(),
    postOnline: vi.fn(async () => {}),
    postOffline: vi.fn(async () => {}),
    postMessage: vi.fn(async () => {}),
    mirrorToolCall: vi.fn(async () => {}),
    mirrorAssistant: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  return { client, state: { loadCount: 0 } };
});

vi.mock('../src/config.js', () => ({
  default: {
    get: (key: string) => cfg.store[key],
    set: (key: string, val: any) => {
      cfg.setCalls.push([key, val]);
      cfg.store[key] = val;
    },
  },
}));

vi.mock('../src/scuttlebot/index.js', () => {
  sb.state.loadCount++;
  return { scuttlebotClient: sb.client };
});

import {
  fleetConfigured,
  fleetActive,
  fleetInit,
  fleetEnable,
  fleetDisable,
  fleetStatus,
  fleetStartPolling,
  fleetPostOnline,
  fleetPostOffline,
  fleetPostMessage,
  fleetMirrorToolCall,
  fleetMirrorAssistant,
} from '../src/fleet.js';

beforeEach(() => {
  cfg.store = { fleet: { enabled: true } };
  cfg.setCalls = [];
  vi.clearAllMocks();
  sb.client.initialize.mockResolvedValue(true);
  sb.client.isEnabled.mockReturnValue(true);
});

afterEach(async () => {
  // Reset fleet.ts module-level `client` so tests do not bleed into each other.
  await fleetDisable();
});

describe('configuration state', () => {
  it('reports configured when fleet.enabled is true', () => {
    expect(fleetConfigured()).toBe(true);
  });

  it('is inactive until a client is loaded', () => {
    expect(fleetActive()).toBe(false);
  });
});

describe('fleetInit', () => {
  it('lazily loads the scuttlebot module and initializes the client', async () => {
    const ok = await fleetInit('sess-1', '/repo');
    expect(ok).toBe(true);
    expect(sb.state.loadCount).toBe(1);
    expect(sb.client.initialize).toHaveBeenCalledWith('sess-1', '/repo');
    expect(fleetActive()).toBe(true);
  });

  it('reuses the already-loaded client on subsequent calls (single load)', async () => {
    await fleetInit('sess-1', '/repo');
    await fleetInit('sess-2', '/repo');
    expect(sb.state.loadCount).toBe(1); // module imported once
    expect(sb.client.initialize).toHaveBeenCalledTimes(2);
  });

  it('returns false and never initializes when not configured', async () => {
    cfg.store.fleet = { enabled: false };
    const ok = await fleetInit('sess', '/repo');
    expect(ok).toBe(false);
    expect(sb.client.initialize).not.toHaveBeenCalled();
  });
});

describe('fleetEnable', () => {
  it('persists enabled=true and connects', async () => {
    cfg.store.fleet = { enabled: false };
    const ok = await fleetEnable('sess', '/repo');

    expect(ok).toBe(true);
    expect(cfg.setCalls).toContainEqual(['fleet', { enabled: true }]);
    expect(cfg.store.fleet.enabled).toBe(true);
    expect(sb.client.initialize).toHaveBeenCalledWith('sess', '/repo');
  });

  it('propagates a failed connection result', async () => {
    sb.client.initialize.mockResolvedValueOnce(false);
    const ok = await fleetEnable('sess', '/repo');
    expect(ok).toBe(false);
  });

  it('merges into existing fleet config rather than replacing it', async () => {
    cfg.store.fleet = { enabled: false, channel: 'ops' };
    await fleetEnable('sess', '/repo');
    expect(cfg.store.fleet).toEqual({ enabled: true, channel: 'ops' });
  });
});

describe('active pass-throughs', () => {
  beforeEach(async () => {
    await fleetInit('sess', '/repo');
  });

  it('fleetStatus returns the client status', () => {
    expect(fleetStatus()).toEqual({ enabled: true, connected: true, nick: 'n', config: undefined });
  });

  it('fleetStartPolling forwards the handler', () => {
    const handler = vi.fn();
    fleetStartPolling(handler);
    expect(sb.client.startPolling).toHaveBeenCalledWith(handler);
  });

  it('fleetPostOnline delegates to the client', () => {
    fleetPostOnline();
    expect(sb.client.postOnline).toHaveBeenCalled();
  });

  it('fleetPostMessage forwards the text', () => {
    fleetPostMessage('hello fleet');
    expect(sb.client.postMessage).toHaveBeenCalledWith('hello fleet');
  });

  it('fleetMirrorToolCall forwards name and args', async () => {
    await fleetMirrorToolCall('shell', { command: 'ls' });
    expect(sb.client.mirrorToolCall).toHaveBeenCalledWith('shell', { command: 'ls' });
  });

  it('fleetMirrorAssistant forwards the content', () => {
    fleetMirrorAssistant('thinking...');
    expect(sb.client.mirrorAssistant).toHaveBeenCalledWith('thinking...');
  });

  it('fleetPostOffline posts offline and disconnects', async () => {
    await fleetPostOffline();
    expect(sb.client.postOffline).toHaveBeenCalled();
    expect(sb.client.disconnect).toHaveBeenCalled();
  });
});

describe('fleetDisable', () => {
  it('tears down the client and persists enabled=false', async () => {
    await fleetInit('sess', '/repo');
    expect(fleetActive()).toBe(true);

    await fleetDisable();

    expect(sb.client.postOffline).toHaveBeenCalled();
    expect(sb.client.disconnect).toHaveBeenCalled();
    expect(cfg.store.fleet.enabled).toBe(false);
    expect(fleetActive()).toBe(false);
    expect(fleetStatus()).toBeNull();
  });

  it('still persists enabled=false when no client was ever loaded', async () => {
    await fleetDisable();
    expect(cfg.store.fleet.enabled).toBe(false);
    expect(sb.client.disconnect).not.toHaveBeenCalled();
  });
});

describe('inactive helpers are no-ops', () => {
  it('never touch the client when inactive', () => {
    // isEnabled returns false -> fleetActive() is false even if a client exists.
    sb.client.isEnabled.mockReturnValue(false);

    expect(fleetStatus()).toBeNull();
    fleetStartPolling(vi.fn());
    fleetPostOnline();
    fleetPostMessage('x');
    fleetMirrorAssistant('y');

    expect(sb.client.startPolling).not.toHaveBeenCalled();
    expect(sb.client.postOnline).not.toHaveBeenCalled();
    expect(sb.client.postMessage).not.toHaveBeenCalled();
    expect(sb.client.mirrorAssistant).not.toHaveBeenCalled();
  });
});
