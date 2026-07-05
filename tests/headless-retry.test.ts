/**
 * Tests for headless retry budget (--max-retries / maxRetries option).
 *
 * We mock the heavy dependencies so no real network or filesystem calls
 * are made, then drive runHeadless() directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that touches the module graph
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 10;
    if (key === 'audit') return { enabled: false }; // no run-log disk writes in tests
    return undefined;
  }),
  getConfig: vi.fn(() => ({})),
  getApiKey: vi.fn(),
  getBaseUrl: vi.fn(),
  getConfiguredProviders: vi.fn(() => []),
}));

const mockChat = vi.fn();
const mockExecuteTool = vi.fn();

vi.mock('../src/providers/index.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  selectProvider: (p: string) => p || 'anthropic',
}));

vi.mock('../src/tools.js', () => ({
  TOOLS: [],
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
  getTools: vi.fn(() => []),
}));

vi.mock('../src/types.js', () => ({
  getSystemPrompt: vi.fn(() => 'You are a helpful assistant.'),
  DEFAULT_MODELS: { anthropic: 'claude-3-5-sonnet-20241022' },
  calculateCost: vi.fn(() => 0),
}));

vi.mock('../src/memory.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
}));


// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------

import { runHeadless } from '../src/headless.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A chat response that contains a single tool call */
function toolCallResponse(name = 'test_tool', id = 'tc_1') {
  return {
    content: '',
    toolCalls: [{ id, name, arguments: {} }],
  };
}

/** A chat response with a plain text answer (no tool calls) */
function textResponse(content = 'done') {
  return { content, toolCalls: [] };
}

/** Suppress stderr noise during tests and reset mocks between runs */
let stderrWrite: typeof process.stderr.write;
beforeEach(() => {
  mockChat.mockReset();
  mockExecuteTool.mockReset();
  stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = vi.fn() as unknown as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = stderrWrite;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('headless retry budget', () => {
  it('succeeds on first try — no retries attempted', async () => {
    // chat: first call returns a tool call, second returns final text
    mockChat
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(textResponse('all good'));

    // Tool succeeds on first execution
    mockExecuteTool.mockResolvedValueOnce({ result: 'ok', isError: false });

    const code = await runHeadless({
      prompt: 'hello',
      outputMode: 'text',
      maxRetries: 3,
    });

    expect(code).toBe(0);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    // stderr should not have any retry messages
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    expect(stderrCalls.some((s: string) => s.includes('[retry'))).toBe(false);
  });

  it('fails once, succeeds on second attempt — returns success', async () => {
    mockChat
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(textResponse('recovered'));

    // First execution fails, second succeeds
    mockExecuteTool
      .mockResolvedValueOnce({ result: 'network error', isError: true })
      .mockResolvedValueOnce({ result: 'success output', isError: false });

    const code = await runHeadless({
      prompt: 'hello',
      outputMode: 'text',
      maxRetries: 3,
    });

    expect(code).toBe(0);
    expect(mockExecuteTool).toHaveBeenCalledTimes(2);
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    expect(stderrCalls.some((s: string) => s.includes('[retry 1/3]'))).toBe(true);
  });

  it('fails maxRetries times — exhausts budget and returns error result to LLM', async () => {
    // chat: tool call, then final text (LLM handles the error gracefully)
    mockChat
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(textResponse('gave up'));

    // All executions fail with a transient (retryable) error
    mockExecuteTool.mockResolvedValue({ result: 'network timeout', isError: true });

    const code = await runHeadless({
      prompt: 'hello',
      outputMode: 'text',
      maxRetries: 2,
    });

    // The runner should still complete (exit 0); the error is forwarded to the LLM
    expect(code).toBe(0);
    // 1 initial attempt + 2 retries = 3 total calls
    expect(mockExecuteTool).toHaveBeenCalledTimes(3);
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    expect(stderrCalls.some((s: string) => s.includes('[retry 1/2]'))).toBe(true);
    expect(stderrCalls.some((s: string) => s.includes('[retry 2/2]'))).toBe(true);
  });

  it('maxRetries=0 — no retries, immediate failure forwarded to LLM', async () => {
    mockChat
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(textResponse('ok'));

    mockExecuteTool.mockResolvedValueOnce({ result: 'fail', isError: true });

    const code = await runHeadless({
      prompt: 'hello',
      outputMode: 'text',
      maxRetries: 0,
    });

    expect(code).toBe(0);
    // Only 1 execution — no retries
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    expect(stderrCalls.some((s: string) => s.includes('[retry'))).toBe(false);
  });
});
