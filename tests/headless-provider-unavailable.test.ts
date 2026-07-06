/**
 * Headless must treat an explicitly-selected-but-unconfigured provider as a
 * hard, actionable failure — print the fix to stderr and exit 2 — rather than
 * silently switching providers (#217).
 *
 * The providers mock defines its own ProviderUnavailableError and exports it;
 * headless.ts imports the same class from the same (mocked) module, so its
 * `instanceof` check matches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 10;
    if (key === 'audit') return { enabled: false };
    return undefined;
  }),
  getConfig: vi.fn(() => ({})),
  getApiKey: vi.fn(),
  getBaseUrl: vi.fn(),
  getConfiguredProviders: vi.fn(() => []),
}));

const mockChat = vi.fn();

vi.mock('../src/providers/index.js', () => {
  class ProviderUnavailableError extends Error {
    provider: string;
    constructor(provider: string, message: string) {
      super(message);
      this.name = 'ProviderUnavailableError';
      this.provider = provider;
    }
  }
  return {
    chat: (...args: unknown[]) => mockChat(...args),
    selectProvider: (p: string) => {
      throw new ProviderUnavailableError(
        p,
        `${p} is selected but has no API key. Fix: calliope --setup, /config set providers.${p}.apiKey <key>, or export ${p.toUpperCase()}_API_KEY.`,
      );
    },
    ProviderUnavailableError,
  };
});

vi.mock('../src/tools.js', () => ({ TOOLS: [], executeTool: vi.fn(), getTools: vi.fn(() => []) }));
vi.mock('../src/types.js', () => ({
  getSystemPrompt: vi.fn(() => 'You are a helpful assistant.'),
  DEFAULT_MODELS: { openai: 'gpt-4o', anthropic: 'claude-3-5-sonnet-20241022' },
  calculateCost: vi.fn(() => 0),
}));
vi.mock('../src/memory.js', () => ({ buildMemoryContext: vi.fn(() => '') }));

import { runHeadless } from '../src/headless.js';

let stderrWrite: typeof process.stderr.write;
let stdoutWrite: typeof process.stdout.write;
const stderrChunks: string[] = [];
beforeEach(() => {
  mockChat.mockReset();
  stderrChunks.length = 0;
  stderrWrite = process.stderr.write.bind(process.stderr);
  stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stderr.write = vi.fn((c: unknown) => { stderrChunks.push(String(c)); return true; }) as unknown as typeof process.stderr.write;
  process.stdout.write = vi.fn(() => true) as unknown as typeof process.stdout.write;
});
afterEach(() => {
  process.stderr.write = stderrWrite;
  process.stdout.write = stdoutWrite;
});

describe('headless — provider unavailable (#217)', () => {
  it('exits 2 and prints the fix, without ever calling chat', async () => {
    const code = await runHeadless({ prompt: 'hello', provider: 'openai', outputMode: 'text', maxRetries: 0 });

    expect(code).toBe(2);
    // The error carried the actionable fix hint...
    const err = stderrChunks.join('');
    expect(err).toContain('openai is selected but has no API key');
    expect(err).toContain('calliope --setup');
    // ...and we never fell through to a provider call.
    expect(mockChat).not.toHaveBeenCalled();
  });
});
