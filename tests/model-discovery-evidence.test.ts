import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as config from '../src/config.js';
import { clearModelCache, getAvailableModels } from '../src/model-detection.js';

beforeEach(() => {
  clearModelCache();
  vi.spyOn(config, 'getApiKey').mockReturnValue('offline-discovery-key');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    error: { type: 'invalid_request_error', message: 'Invalid test credential' },
  }), { status: 400, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } })));
});
afterEach(() => { clearModelCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['anthropic', 'google'] as const)('%s strict discovery never reports an emergency fallback as live evidence', async provider => {
  // Non-strict offline behavior remains available, including its cache.
  expect((await getAvailableModels(provider, { quiet: true })).length).toBeGreaterThan(0);
  await expect(getAvailableModels(provider, { quiet: true, throwOnError: true })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(2);
});
