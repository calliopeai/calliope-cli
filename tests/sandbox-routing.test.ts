/**
 * Tests for src/sandbox/index.ts — mode-routing helpers.
 *
 * The two backends (Docker / native) and the config are mocked so we can drive
 * the full mode x availability matrix and assert which backend each helper
 * selects, including the 'auto' fallbacks (Docker unavailable -> native ->
 * unsandboxed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  mode: undefined as string | undefined,
  docker: false,
  native: false,
}));

vi.mock('../src/config.js', () => ({
  default: { get: (key: string) => (key === 'sandboxMode' ? state.mode : undefined) },
}));
vi.mock('../src/sandbox/docker.js', () => ({ isDockerAvailable: () => state.docker }));
vi.mock('../src/sandbox/native.js', () => ({ isNativeSandboxAvailable: () => state.native }));

import { getSandboxMode, selectCodeSandbox, shouldUseNativeSandbox } from '../src/sandbox/index.js';

beforeEach(() => {
  state.mode = undefined;
  state.docker = false;
  state.native = false;
});

describe('getSandboxMode', () => {
  it('defaults to auto when unset', () => {
    expect(getSandboxMode()).toBe('auto');
  });

  it('returns the configured mode', () => {
    state.mode = 'docker';
    expect(getSandboxMode()).toBe('docker');
  });
});

describe('selectCodeSandbox', () => {
  it('honours explicit docker / native / off modes regardless of availability', () => {
    state.mode = 'docker';
    expect(selectCodeSandbox()).toBe('docker');
    state.mode = 'native';
    expect(selectCodeSandbox()).toBe('native');
    state.mode = 'off';
    expect(selectCodeSandbox()).toBe('unsandboxed');
  });

  it('auto prefers Docker when available', () => {
    state.mode = 'auto';
    state.docker = true;
    state.native = true;
    expect(selectCodeSandbox()).toBe('docker');
  });

  it('auto falls back to the native sandbox when Docker is unavailable', () => {
    state.mode = 'auto';
    state.docker = false;
    state.native = true;
    expect(selectCodeSandbox()).toBe('native');
  });

  it('auto falls back to unsandboxed when no backend is available', () => {
    state.mode = 'auto';
    state.docker = false;
    state.native = false;
    expect(selectCodeSandbox()).toBe('unsandboxed');
  });
});

describe('shouldUseNativeSandbox', () => {
  it('skips for off and docker modes', () => {
    state.mode = 'off';
    expect(shouldUseNativeSandbox()).toBe('skip');
    state.mode = 'docker';
    expect(shouldUseNativeSandbox()).toBe('skip');
  });

  it('requires the native sandbox for native mode', () => {
    state.mode = 'native';
    expect(shouldUseNativeSandbox()).toBe('require');
  });

  it('auto uses the native sandbox when available, else skips', () => {
    state.mode = 'auto';
    state.native = true;
    expect(shouldUseNativeSandbox()).toBe('use');
    state.native = false;
    expect(shouldUseNativeSandbox()).toBe('skip');
  });
});
