import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track whether the scuttlebot module ever gets loaded
let scuttlebotLoaded = false;
vi.mock('../src/scuttlebot/index.js', () => {
  scuttlebotLoaded = true;
  return { scuttlebotClient: { initialize: vi.fn(async () => true), isEnabled: () => true } };
});

vi.mock('../src/config.js', () => ({
  default: {
    get: vi.fn((key: string) => (key === 'fleet' ? { enabled: false } : undefined)),
    set: vi.fn(),
  },
}));

import { fleetConfigured, fleetActive, fleetInit, fleetMirrorToolCall, fleetMirrorAssistant, fleetPostMessage, fleetStatus, fleetPostOffline } from '../src/fleet.js';

describe('fleet mode disabled (default)', () => {
  beforeEach(() => {
    scuttlebotLoaded = false;
  });

  it('reports not configured and not active', () => {
    expect(fleetConfigured()).toBe(false);
    expect(fleetActive()).toBe(false);
  });

  it('fleetInit resolves false without loading the scuttlebot module', async () => {
    await expect(fleetInit('session', '/tmp')).resolves.toBe(false);
    expect(scuttlebotLoaded).toBe(false);
  });

  it('mirror and post helpers are no-ops that never load the module', async () => {
    await fleetMirrorToolCall('shell', { command: 'ls' });
    fleetMirrorAssistant('hello');
    fleetPostMessage('hello');
    await fleetPostOffline();
    expect(fleetStatus()).toBeNull();
    expect(scuttlebotLoaded).toBe(false);
  });
});
