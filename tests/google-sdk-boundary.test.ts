import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  getApiKey: vi.fn(),
  getBaseUrl: vi.fn(),
}));

import * as config from '../src/config.js';
import { chatGoogle } from '../src/providers/google.js';

describe('maintained Google SDK admission', () => {
  const fetch = vi.fn(() => { throw new Error('Refused input must not reach the SDK transport'); });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(config.getApiKey).mockReturnValue('local-fixture-only');
    vi.stubGlobal('fetch', fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('refuses missing credentials before issuing an SDK request', async () => {
    vi.mocked(config.getApiKey).mockReturnValue(undefined);
    await expect(chatGoogle([{ role: 'user', content: 'Original task' }], [], 'fixture-model',
      undefined, undefined, { bounded: true, maxOutputTokens: 1 }))
      .rejects.toThrow('Google API key not configured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an empty conversation before issuing an SDK request', async () => {
    await expect(chatGoogle([], [], 'fixture-model', undefined, undefined,
      { bounded: true, maxOutputTokens: 1 })).rejects.toThrow('No messages provided');
    expect(fetch).not.toHaveBeenCalled();
  });
});
