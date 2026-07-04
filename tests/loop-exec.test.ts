/**
 * Regression tests for the loop-exec cluster.
 *
 * #155 — executeParallel must propagate a tool's `isError` flag (a tool that
 *        returns { isError: true } without throwing) so failures are recorded
 *        as failures, mirroring the sequential branch.
 * #157 — the headless retry loop must only retry classified-transient errors,
 *        never re-run mutating tools, and back off between attempts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// #155 — executeParallel isError propagation
// ---------------------------------------------------------------------------

import { executeParallel } from '../src/parallel-tools.js';
import type { ToolCall } from '../src/types.js';

function call(name: string, args: Record<string, unknown> = {}, id?: string): ToolCall {
  return { id: id || `${name}-${Math.random().toString(36).slice(2)}`, name, arguments: args };
}

describe('#155 executeParallel propagates tool-level isError', () => {
  it('records a thrown-free { isError: true } result as a failure (not success)', async () => {
    // Two independent reads run in the same parallel stage; one returns a
    // tool-level error without throwing.
    const toolCalls = [
      call('read_file', { path: 'a.ts' }, 'a'),
      call('read_file', { path: 'b.ts' }, 'b'),
    ];

    const results = await executeParallel(toolCalls, async (c) => {
      if (c.id === 'b') return { result: 'Error: validation failed', isError: true };
      return { result: 'ok contents', isError: false };
    });

    const a = results.find(r => r.toolCall.id === 'a')!;
    const b = results.find(r => r.toolCall.id === 'b')!;

    // Success path: not an error, no thrown error.
    expect(a.isError).toBe(false);
    expect(a.error).toBeUndefined();

    // Failure path: tool-level isError is preserved and distinct from a thrown error.
    expect(b.isError).toBe(true);
    expect(b.error).toBeUndefined();
    expect(b.result).toContain('validation failed');
  });

  it('still supports executors that return a plain string (backward compatible)', async () => {
    const results = await executeParallel([call('read_file', { path: 'x' }, 'x')], async () => 'plain');
    expect(results[0].result).toBe('plain');
    expect(results[0].isError).toBeUndefined();
    expect(results[0].error).toBeUndefined();
  });

  it('reports deterministic progress via results.length across a parallel stage', async () => {
    const toolCalls = [
      call('read_file', { path: '1' }, '1'),
      call('read_file', { path: '2' }, '2'),
      call('read_file', { path: '3' }, '3'),
    ];
    const seen: number[] = [];
    await executeParallel(
      toolCalls,
      async () => ({ result: 'ok' }),
      (completed) => { seen.push(completed); },
    );
    // onProgress fires once per tool; completed is derived from committed results,
    // so it never exceeds total and is non-decreasing.
    expect(seen.length).toBe(3);
    for (const v of seen) expect(v).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// #157 — headless retry gating (transient-only, no mutating-tool retry, backoff)
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 10;
    return undefined;
  }),
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

vi.mock('../src/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/types.js')>();
  return {
    ...actual,
    getSystemPrompt: vi.fn(() => 'You are a helpful assistant.'),
    DEFAULT_MODELS: { anthropic: 'claude-3-5-sonnet-20241022' },
  };
});

vi.mock('../src/memory.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
}));


import { runHeadless } from '../src/headless.js';

function toolCallResponse(name: string, id = 'tc_1') {
  return { content: '', toolCalls: [{ id, name, arguments: {} }] };
}
function textResponse(content = 'done') {
  return { content, toolCalls: [] };
}

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

describe('#157 headless retry gating', () => {
  it('retries a read-only tool on a transient error (happy retry path)', async () => {
    mockChat
      .mockResolvedValueOnce(toolCallResponse('read_file'))
      .mockResolvedValueOnce(textResponse('recovered'));
    mockExecuteTool
      .mockResolvedValueOnce({ result: 'connection timed out', isError: true })
      .mockResolvedValueOnce({ result: 'contents', isError: false });

    const code = await runHeadless({ prompt: 'go', outputMode: 'text', maxRetries: 3 });

    expect(code).toBe(0);
    expect(mockExecuteTool).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a deterministic (non-transient) error', async () => {
    mockChat
      .mockResolvedValueOnce(toolCallResponse('read_file'))
      .mockResolvedValueOnce(textResponse('ok'));
    // Validation-style error: deterministic, must not be retried.
    mockExecuteTool.mockResolvedValueOnce({ result: 'Error: content must be a string', isError: true });

    const code = await runHeadless({ prompt: 'go', outputMode: 'text', maxRetries: 3 });

    expect(code).toBe(0);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    expect(stderrCalls.some((s: string) => s.includes('[retry'))).toBe(false);
  });

  it('does NOT re-run a mutating tool even on a transient error', async () => {
    mockChat
      .mockResolvedValueOnce(toolCallResponse('shell'))
      .mockResolvedValueOnce(textResponse('ok'));
    // Even though the error text looks transient, shell mutates state and is
    // never blindly re-executed.
    mockExecuteTool.mockResolvedValueOnce({ result: 'network timeout', isError: true });

    const code = await runHeadless({ prompt: 'go', outputMode: 'text', maxRetries: 3 });

    expect(code).toBe(0);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    const stderrCalls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]));
    expect(stderrCalls.some((s: string) => s.includes('[retry'))).toBe(false);
  });
});
