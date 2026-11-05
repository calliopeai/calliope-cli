/**
 * Headless hard caps: --max-cost / --max-time (and CALLIOPE_MAX_COST / CALLIOPE_MAX_TIME).
 *
 * A fake provider reports token usage; cost is priced by a deterministic
 * calculateCost mock so the cost path is exact. The run log is written to a temp
 * dir so the reported spend can be checked against `calliope cost` accounting.
 */
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-caps-runs-'));
const configured: { budget?: Record<string, number> } = {};

vi.mock('../src/config.js', async original => ({
  ...await original<typeof import('../src/config.js')>(),
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 10;
    if (key === 'audit') return { enabled: true, dir: runsDir };
    if (key === 'budget') return configured.budget;
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
  checkToolBoundary: vi.fn(() => undefined),
  TOOLS: [],
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
  getTools: vi.fn(() => []),
}));

/** $0.0001 per token, input or output: 1,000 tokens = $0.10. */
vi.mock('../src/types.js', () => ({
  getSystemPrompt: vi.fn(() => 'You are a helpful assistant.'),
  DEFAULT_MODELS: { anthropic: 'claude-3-5-sonnet-20241022' },
  calculateCost: vi.fn((_model: string, input: number, output: number) => (input + output) * 0.0001),
}));

vi.mock('../src/memory.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
}));

vi.mock('../src/routing/index.js', async importActual => ({
  ...await importActual<typeof import('../src/routing/index.js')>(),
  selectRoute: (await import('./helpers/route-fixture.js')).fixtureRoute,
}));

import { runHeadless, parseHeadlessCaps, BUDGET_EXIT_CODE, CAP_EXIT_CODE } from '../src/headless.js';
import { summarizeDir } from '../src/cost.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake provider turn: one tool call plus 1,000 tokens of reported usage ($0.10). */
function toolCallWithUsage(id: string) {
  return { content: '', toolCalls: [{ id, name: 'read_file', arguments: {} }], usage: { inputTokens: 800, outputTokens: 200 } };
}

/** Settles only when the request's abort signal fires, like a stalled provider/tool. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
const events = () => stdout.mock.calls.map(call => JSON.parse(String(call[0])));
const eventOf = (type: string) => events().find(event => event.type === type);

beforeEach(() => {
  mockChat.mockReset();
  mockExecuteTool.mockReset();
  delete configured.budget;
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdout.mockRestore();
  stderr.mockRestore();
});

afterAll(() => fs.rmSync(runsDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseHeadlessCaps', () => {
  it('returns no caps when neither flag nor env var is set', () => {
    expect(parseHeadlessCaps(['--headless', 'do work'], {})).toEqual({});
  });

  it('parses --max-cost and --max-time values', () => {
    expect(parseHeadlessCaps(['--headless', '--max-cost', '2.5', '--max-time', '90', 'go'], {})).toEqual({ maxCost: 2.5, maxTime: 90 });
  });

  it('falls back to CALLIOPE_MAX_COST / CALLIOPE_MAX_TIME', () => {
    expect(parseHeadlessCaps([], { CALLIOPE_MAX_COST: '0.75', CALLIOPE_MAX_TIME: '30' })).toEqual({ maxCost: 0.75, maxTime: 30 });
  });

  it('lets a flag win over its env var, independently per cap', () => {
    expect(parseHeadlessCaps(['--max-cost', '1'], { CALLIOPE_MAX_COST: '9', CALLIOPE_MAX_TIME: '60' })).toEqual({ maxCost: 1, maxTime: 60 });
  });

  it('treats an empty env var as unset', () => {
    expect(parseHeadlessCaps([], { CALLIOPE_MAX_COST: '', CALLIOPE_MAX_TIME: '  ' })).toEqual({});
  });

  it.each([
    [['--max-cost', 'abc'], {}, /--max-cost must be a positive number/],
    [['--max-cost', '0'], {}, /--max-cost must be a positive number/],
    [['--max-time', '-5'], {}, /--max-time must be a positive number/],
    [['--max-time'], {}, /--max-time must be a positive number \(got no value\)/],
    [['--max-cost', '--json'], {}, /--max-cost must be a positive number/],
    [[], { CALLIOPE_MAX_TIME: 'soon' }, /CALLIOPE_MAX_TIME must be a positive number/],
    [[], { CALLIOPE_MAX_COST: 'Infinity' }, /CALLIOPE_MAX_COST must be a positive number/],
  ])('rejects invalid caps instead of silently running uncapped: %j %j', (args, env, error) => {
    expect(() => parseHeadlessCaps(args, env)).toThrow(error);
  });
});

// ---------------------------------------------------------------------------
// Stop paths
// ---------------------------------------------------------------------------

describe('headless --max-cost', () => {
  it('stops once recorded spend reaches the cap, emits budget_exceeded and exits 6', async () => {
    let call = 0;
    mockChat.mockImplementation(async () => toolCallWithUsage(`tc_${++call}`));
    mockExecuteTool.mockResolvedValue({ result: 'ok', isError: false });

    const code = await runHeadless({ prompt: 'loop forever', provider: 'anthropic', outputMode: 'json', maxCost: 0.25 });

    expect(code).toBe(CAP_EXIT_CODE);
    expect(code).not.toBe(0);
    // $0.10 per response: the third pushes spend to $0.30 >= $0.25 and no further request is made.
    expect(mockChat).toHaveBeenCalledTimes(3);
    expect(mockExecuteTool).toHaveBeenCalledTimes(2);

    const exceeded = eventOf('budget_exceeded');
    expect(exceeded).toMatchObject({ type: 'budget_exceeded', kind: 'cost', data: { cap: 0.25 } });
    expect(exceeded.data.spent).toBeCloseTo(0.3, 10);

    const done = events().at(-1);
    expect(done).toMatchObject({ type: 'done', data: { reason: 'budget', stoppedBy: 'cost', inputTokens: 2400, outputTokens: 600, limits: { maxCost: 0.25 } } });
    expect(done.data.costUsd).toBeCloseTo(0.3, 10);
    expect(typeof done.data.elapsedMs).toBe('number');

    // Same accounting `calliope cost --json` reports for this session.
    const sessionId = events().find(event => event.data?.sessionId)!.data.sessionId as string;
    const recorded = summarizeDir(runsDir).find(summary => summary.session === sessionId);
    expect(recorded?.cost).toBeCloseTo(done.data.costUsd, 10);
  });

  it('does not stop a run that stays under the cap; the summary still carries spend and time', async () => {
    mockChat.mockResolvedValueOnce({ content: 'done', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } });

    const code = await runHeadless({ prompt: 'small job', provider: 'anthropic', outputMode: 'json', maxCost: 1, maxTime: 60 });

    expect(code).toBe(0);
    expect(eventOf('budget_exceeded')).toBeUndefined();
    const done = events().at(-1);
    expect(done).toMatchObject({ type: 'done', data: { reason: 'completed', stoppedBy: null, inputTokens: 100, outputTokens: 50, limits: { maxCost: 1, maxTime: 60 } } });
    expect(done.data.costUsd).toBeCloseTo(0.015, 10);
  });

  it('keeps a tighter configured budget.maxCostPerRun authoritative and attributes the stop to it', async () => {
    configured.budget = { maxCostPerRun: 0.15 };
    let call = 0;
    mockChat.mockImplementation(async () => toolCallWithUsage(`tc_${++call}`));
    mockExecuteTool.mockResolvedValue({ result: 'ok', isError: false });

    const code = await runHeadless({ prompt: 'loop', provider: 'anthropic', outputMode: 'json', maxCost: 5 });

    expect(code).toBe(BUDGET_EXIT_CODE);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(eventOf('budget_exceeded')).toBeUndefined();
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'budget', stoppedBy: null } });
  });

  it('keeps exit 3 when the configured budget cap is crossed during a length recovery', async () => {
    configured.budget = { maxCostPerRun: 0.15 };
    mockChat.mockImplementation(async () => ({ content: 'cut', toolCalls: [], finishReason: 'length', usage: { inputTokens: 800, outputTokens: 200 } }));

    expect(await runHeadless({ prompt: 'long', provider: 'anthropic', outputMode: 'json' })).toBe(BUDGET_EXIT_CODE);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(events().some(e => e.type === 'error')).toBe(false);
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'budget' } });
  });

  it('tightens a looser configured budget.maxCostPerRun', async () => {
    configured.budget = { maxCostPerRun: 5 };
    let call = 0;
    mockChat.mockImplementation(async () => toolCallWithUsage(`tc_${++call}`));
    mockExecuteTool.mockResolvedValue({ result: 'ok', isError: false });

    expect(await runHeadless({ prompt: 'loop', provider: 'anthropic', outputMode: 'json', maxCost: 0.1 })).toBe(CAP_EXIT_CODE);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(eventOf('budget_exceeded')).toMatchObject({ kind: 'cost', data: { cap: 0.1 } });
  });
});

describe('headless --max-time', () => {
  it('stops a stalled provider call at the wall-clock limit, emits budget_exceeded and exits 6', async () => {
    mockChat.mockImplementation((...args: unknown[]) => untilAborted((args[6] as { signal?: AbortSignal }).signal));

    const started = Date.now();
    const code = await runHeadless({ prompt: 'hang', provider: 'anthropic', outputMode: 'json', maxTime: 0.05 });

    expect(code).toBe(CAP_EXIT_CODE);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(eventOf('budget_exceeded')).toMatchObject({ type: 'budget_exceeded', kind: 'time', data: { cap: 0.05 } });
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'budget', stoppedBy: 'time', costUsd: 0, limits: { maxTime: 0.05 } } });
  });

  it('keeps exit 6 when the time cap fires during a length recovery', async () => {
    mockChat.mockResolvedValueOnce({ content: 'cut', toolCalls: [], finishReason: 'length', usage: { inputTokens: 1, outputTokens: 1 } })
      .mockImplementation((...args: unknown[]) => untilAborted((args[6] as { signal?: AbortSignal }).signal));

    expect(await runHeadless({ prompt: 'long', provider: 'anthropic', outputMode: 'json', maxTime: 0.05 })).toBe(CAP_EXIT_CODE);
    expect(events().some(e => e.type === 'error')).toBe(false);
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'budget', stoppedBy: 'time' } });
  });

  it('reports spend already recorded when the time cap stops a running tool', async () => {
    mockChat.mockResolvedValueOnce(toolCallWithUsage('tc_1'));
    mockExecuteTool.mockImplementation((_call, _cwd, _timeout, _output, options: { signal?: AbortSignal }) => untilAborted(options.signal));

    const code = await runHeadless({ prompt: 'slow tool', provider: 'anthropic', outputMode: 'json', maxTime: 0.05, maxCost: 10 });

    expect(code).toBe(CAP_EXIT_CODE);
    expect(mockChat).toHaveBeenCalledTimes(1);
    const exceeded = eventOf('budget_exceeded');
    expect(exceeded).toMatchObject({ kind: 'time' });
    expect(exceeded.data.costUsd).toBeCloseTo(0.1, 10);
    const done = events().at(-1);
    expect(done).toMatchObject({ type: 'done', data: { stoppedBy: 'time', inputTokens: 800, outputTokens: 200 } });
    expect(done.data.costUsd).toBeCloseTo(0.1, 10);
    expect(done.data.elapsedMs).toBeGreaterThanOrEqual(45);
  });

  it('applies while waiting for a stdin prompt', async () => {
    const input = new PassThrough();
    const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as typeof process.stdin);
    try {
      expect(await runHeadless({ outputMode: 'json', maxTime: 0.05 })).toBe(CAP_EXIT_CODE);
      expect(mockChat).not.toHaveBeenCalled();
      expect(eventOf('budget_exceeded')).toMatchObject({ kind: 'time' });
      expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'budget', stoppedBy: 'time' } });
    } finally {
      stdin.mockRestore();
      input.destroy();
    }
  });

  it('still reports caller cancellation as cancelled (130), not a cap stop', async () => {
    const controller = new AbortController();
    mockChat.mockImplementation((...args: unknown[]) => {
      const pending = untilAborted((args[6] as { signal?: AbortSignal }).signal);
      controller.abort();
      return pending;
    });

    expect(await runHeadless({ prompt: 'work', provider: 'anthropic', outputMode: 'json', maxTime: 60, signal: controller.signal })).toBe(130);
    expect(eventOf('budget_exceeded')).toBeUndefined();
  });

  it('writes the cap message to stderr in text mode', async () => {
    mockChat.mockImplementation((...args: unknown[]) => untilAborted((args[6] as { signal?: AbortSignal }).signal));

    expect(await runHeadless({ prompt: 'hang', provider: 'anthropic', outputMode: 'text', maxTime: 0.05 })).toBe(CAP_EXIT_CODE);
    const lines = stderr.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.startsWith('BUDGET: Time cap reached'))).toBe(true);
  });
});
