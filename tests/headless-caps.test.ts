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
import { createHash } from 'node:crypto';
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

import { runHeadless, parseHeadlessCaps, parseHeadlessEffort, BUDGET_EXIT_CODE, CAP_EXIT_CODE, type HeadlessQuestionReceipt } from '../src/headless.js';
import { summarizeDir } from '../src/cost.js';
import type { ToolCall } from '../src/types.js';

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
  vi.useRealTimers();
  stdout.mockRestore();
  stderr.mockRestore();
});

afterAll(() => fs.rmSync(runsDir, { recursive: true, force: true }));

describe('headless completion verification', () => {
  it('keeps hosted tools, admission and repair in the original session and allowance', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const ready = vi.fn(async () => {}), execute = vi.fn(async (call: ToolCall) => ({ toolCallId: call.id, result: 'host workspace updated' }));
    mockChat.mockResolvedValueOnce({ content: 'proposal', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } })
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'repair', name: 'write_file', arguments: { path: 'fixed.txt', content: 'fixed' } }], usage: { inputTokens: 1, outputTokens: 1 } })
      .mockResolvedValueOnce({ content: 'fixed proposal', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
    const check = vi.fn().mockResolvedValueOnce({ accepted: false, feedback: 'Repair the workspace.' })
      .mockResolvedValueOnce({ accepted: true, evidenceSha256: 'a'.repeat(64) });
    expect(await runHeadless({ prompt: 'Original task', provider: 'anthropic', maxCost: 1, maxTime: 30,
      control: new RuntimeControl(), onControlReady: ready, completionCheck: check,
      toolRuntime: { version: 1, tools: [{ name: 'write_file', description: 'Write host workspace', parameters: { type: 'object', properties: {} } }], execute } })).toBe(0);
    expect(ready).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).not.toHaveBeenCalled(); expect(mockChat).toHaveBeenCalledTimes(3);
    expect(check.mock.calls[0][0].sessionId).toBe(check.mock.calls[1][0].sessionId);
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'completed',
      verification: { checks: 2 }, limits: { maxCost: 1, maxTime: 30 } } });
  });
  it('reports accepted host evidence only after repairing the original goal in one session', async () => {
    mockChat.mockResolvedValue({ content: 'A proposed result.', finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 50 } });
    const check = vi.fn().mockResolvedValueOnce({ accepted: false, feedback: 'The original acceptance test still fails.' })
      .mockResolvedValueOnce({ accepted: true, evidenceSha256: 'a'.repeat(64) });
    const code = await runHeadless({ prompt: 'Original task', provider: 'anthropic', maxCost: 1, completionCheck: check });
    expect(code).toBe(0);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[1][1].some((message: { content: string }) => message.content.includes('acceptance test still fails'))).toBe(true);
    const sessions = events().filter(event => event.type === 'status' && event.data.message?.startsWith('Session: '));
    expect(sessions).toHaveLength(1);
    expect(check.mock.calls[0][0].sessionId).toBe(check.mock.calls[1][0].sessionId);
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'completed', inputTokens: 200, outputTokens: 100,
      verification: { checks: 2, evidenceSha256: 'a'.repeat(64) }, limits: { maxCost: 1 } } });
  });

  it('keeps the original time cap when host verification stalls', async () => {
    mockChat.mockResolvedValue({ content: 'A proposed result.', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
    const code = await runHeadless({ prompt: 'Original task', provider: 'anthropic', maxTime: .1,
      completionCheck: async (_proposal, signal) => untilAborted(signal) });
    expect(code).toBe(CAP_EXIT_CODE);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { stoppedBy: 'time' } });
    expect(events().at(-1)?.data).not.toHaveProperty('verification');
  });

  it('refuses changed saved conversation proof before reporting acceptance', async () => {
    const { readSessionConversation, saveSessionConversation } = await import('../src/storage.js');
    mockChat.mockResolvedValue({ content: 'A proposed result.', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
    const code = await runHeadless({ prompt: 'Original task', provider: 'anthropic', completionCheck: async proposal => {
      const saved = readSessionConversation(proposal.sessionId);
      saveSessionConversation(proposal.sessionId, [...saved.messages, { role: 'user', content: 'Concurrent writer' }],
        { expectedRevision: saved.revision, status: 'active' });
      return { accepted: true, evidenceSha256: 'a'.repeat(64) };
    } });
    expect(code).toBe(1);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(events().some(event => event.type === 'done' && event.data.verification)).toBe(false);
  });

  it.each([0, 9, NaN, 1.5])('refuses invalid verification limit %s before inference', async maxCompletionChecks => {
    const check = vi.fn();
    expect(await runHeadless({ prompt: 'Original task', provider: 'anthropic', completionCheck: check, maxCompletionChecks })).toBe(2);
    expect(check).not.toHaveBeenCalled();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('does not silently ignore a check allowance without a host verifier', async () => {
    expect(await runHeadless({ prompt: 'Original task', provider: 'anthropic', maxCompletionChecks: 1 })).toBe(2);
    expect(mockChat).not.toHaveBeenCalled();
  });
});

describe('headless host question answers', () => {
  const question = () => ({ ...toolCallWithUsage('audience'), toolCalls: [{ id: 'audience', name: 'ask_question', arguments: { question: 'Which audience?' } }] });
  const answered = () => ({ content: 'Report for operators.', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } });

  it('continues one saved conversation with the answer and cumulative usage', async () => {
    mockChat.mockResolvedValueOnce(question()).mockResolvedValueOnce(answered());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    const answerQuestion = vi.fn(async (_call: ToolCall, _signal?: AbortSignal) => 'Operators');
    expect(await runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', maxCost: 1, answerQuestion })).toBe(0);
    expect(answerQuestion).toHaveBeenCalledOnce();
    expect(answerQuestion.mock.calls[0][0]).toMatchObject({ id: 'audience', name: 'ask_question' });
    expect(mockChat.mock.calls[1][1]).toContainEqual({ role: 'tool', toolCallId: 'audience', content: 'Operators' });
    const sessions = events().filter(event => event.type === 'status' && event.data.message?.startsWith('Session: '));
    expect(sessions).toHaveLength(1);
    const { readSessionConversation } = await import('../src/storage.js');
    const saved = readSessionConversation(sessions[0].data.sessionId);
    expect(saved.messages.filter(message => message.toolCallId === 'audience')).toEqual([{ role: 'tool', toolCallId: 'audience', content: 'Operators' }]);
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'completed', inputTokens: 900, outputTokens: 250, limits: { maxCost: 1 } } });
    expect(events().at(-1).data.costUsd).toBeCloseTo(0.115, 10);
  });

  it('keeps the existing waiting outcome when the host supplies no answer callback', async () => {
    mockChat.mockResolvedValue(question());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    const committed = vi.fn(async () => {});
    expect(await runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', onQuestionCommitted: committed })).toBe(4);
    expect(committed).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledOnce();
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'waiting_for_user' } });
  });

  it.each(['', 'x'.repeat(8193)])('rejects an invalid host answer before further inference', async answer => {
    mockChat.mockResolvedValue(question());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    const committed = vi.fn(async () => {});
    expect(await runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', answerQuestion: async () => answer, onQuestionCommitted: committed })).toBe(1);
    expect(committed).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledOnce();
    expect(events().at(-1)).toMatchObject({ type: 'error', data: { message: expect.stringContaining('8192') } });
  });

  it('reports a refused host answer without continuing inference', async () => {
    mockChat.mockResolvedValue(question());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    expect(await runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', answerQuestion: async () => { throw new Error('Stale question revision'); } })).toBe(1);
    expect(mockChat).toHaveBeenCalledOnce();
    expect(events().at(-1)).toMatchObject({ type: 'error', data: { message: 'Stale question revision' } });
  });

  it('cancels a pending host answer and discards a late answer', async () => {
    mockChat.mockResolvedValue(question());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    let begin!: () => void, answer!: (text: string) => void;
    const began = new Promise<void>(resolve => { begin = resolve; });
    const held = new Promise<string>(resolve => { answer = resolve; });
    const controller = new AbortController();
    const running = runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', signal: controller.signal,
      answerQuestion: async (_call, signal) => { expect(signal).toBe(controller.signal); begin(); return held; } });
    await began;
    controller.abort();
    expect(await running).toBe(130);
    answer('Too late');
    await Promise.resolve();
    expect(mockChat).toHaveBeenCalledOnce();
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'cancelled' } });
    expect(events().some(event => event.type === 'tool_result' && event.data.result === 'Too late')).toBe(false);
  });

  it('includes an unresolved host answer in the original wall-clock cap', async () => {
    mockChat.mockResolvedValue(question());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    let begin!: () => void;
    const began = new Promise<void>(resolve => { begin = resolve; });
    const answerQuestion = vi.fn(async (_call: ToolCall, signal?: AbortSignal) => { begin(); return untilAborted(signal); });
    const running = runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', maxTime: 0.1,
      signal: controller.signal, answerQuestion });
    try {
      expect(await Promise.race([began.then(() => 'question'), running.then(() => 'finished')])).toBe('question');
      await vi.advanceTimersByTimeAsync(100);
      expect(await running).toBe(CAP_EXIT_CODE);
      expect(answerQuestion).toHaveBeenCalledOnce();
      expect(mockChat).toHaveBeenCalledOnce();
      expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'budget', stoppedBy: 'time', limits: { maxTime: 0.1 } } });
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });

  it('waits for acknowledgement of the exact saved answer before the next provider call', async () => {
    mockChat.mockResolvedValueOnce(question()).mockResolvedValueOnce(answered());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    const { readSessionConversation, getSessionDirById } = await import('../src/storage.js');
    let begin!: (receipt: HeadlessQuestionReceipt) => void, release!: () => void;
    const began = new Promise<HeadlessQuestionReceipt>(resolve => { begin = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const running = runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', maxCost: 1,
      answerQuestion: async () => 'Operators', onQuestionCommitted: async receipt => {
        const saved = readSessionConversation(receipt.sessionId);
        const raw = JSON.parse(fs.readFileSync(path.join(getSessionDirById(receipt.sessionId)!, 'messages.json'), 'utf8'));
        expect(receipt).toMatchObject({ toolCallId: 'audience', revision: saved.revision, checksum: raw.checksum,
          answerSha256: createHash('sha256').update('Operators').digest('hex') });
        expect(saved.messages.at(-1)).toEqual({ role: 'tool', toolCallId: 'audience', content: 'Operators' });
        begin(receipt); await held;
      } });
    const first = await Promise.race([began.then(receipt => ({ receipt })), running.then(code => ({ code }))]);
    try {
      expect(first).toHaveProperty('receipt');
      expect(mockChat).toHaveBeenCalledOnce();
    } finally { release(); }
    expect(await running).toBe(0);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(events().at(-1).data.costUsd).toBeCloseTo(0.115, 10);
  });

  it('retains the saved answer but stops inference when the host refuses its receipt', async () => {
    mockChat.mockResolvedValueOnce(question()).mockResolvedValueOnce(answered());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    const committed = vi.fn(async () => { throw new Error('Host did not acknowledge delivery'); });
    expect(await runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json',
      answerQuestion: async () => 'Operators', onQuestionCommitted: committed })).toBe(1);
    expect(committed).toHaveBeenCalledOnce();
    expect(mockChat).toHaveBeenCalledOnce();
    const { readSessionConversation } = await import('../src/storage.js');
    const session = events().find(event => event.data.message?.startsWith('Session: ')).data.sessionId;
    expect(readSessionConversation(session).messages).toContainEqual({ role: 'tool', toolCallId: 'audience', content: 'Operators' });
    expect(summarizeDir(runsDir).find(summary => summary.session === session)?.cost).toBeCloseTo(0.1, 10);
  });

  it('never acknowledges an answer whose original conversation revision changed', async () => {
    mockChat.mockResolvedValue(question());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    const { readSessionConversation, saveSessionConversation } = await import('../src/storage.js');
    const committed = vi.fn(async () => {});
    expect(await runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json',
      answerQuestion: async () => {
        const session = events().find(event => event.data.message?.startsWith('Session: ')).data.sessionId;
        const saved = readSessionConversation(session);
        saveSessionConversation(session, saved.messages, { expectedRevision: saved.revision, status: 'active' });
        return 'Operators';
      }, onQuestionCommitted: committed })).toBe(1);
    expect(committed).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledOnce();
  });

  it('cancels an unresolved receipt and never admits a provider call after a late acknowledgement', async () => {
    mockChat.mockResolvedValueOnce(question()).mockResolvedValueOnce(answered());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    let begin!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { begin = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const running = runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', signal: controller.signal,
      answerQuestion: async () => 'Operators', onQuestionCommitted: async (_receipt, signal) => {
        expect(signal).toBe(controller.signal); begin(); await held;
      } });
    const first = await Promise.race([began.then(() => 'receipt'), running.then(() => 'finished')]);
    try { expect(first).toBe('receipt'); controller.abort(); expect(await running).toBe(130); }
    finally { controller.abort(); release(); }
    await Promise.resolve();
    expect(mockChat).toHaveBeenCalledOnce();
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'cancelled', inputTokens: 800, outputTokens: 200 } });
  });

  it('refuses continuation when the conversation changes during host acknowledgement', async () => {
    mockChat.mockResolvedValueOnce(question()).mockResolvedValueOnce(answered());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    const { readSessionConversation, saveSessionConversation } = await import('../src/storage.js');
    const committed = vi.fn(async (receipt: HeadlessQuestionReceipt) => {
      const saved = readSessionConversation(receipt.sessionId);
      saveSessionConversation(receipt.sessionId, saved.messages, { expectedRevision: saved.revision, status: 'active' });
    });
    expect(await runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json',
      answerQuestion: async () => 'Operators', onQuestionCommitted: committed })).toBe(1);
    expect(committed).toHaveBeenCalledOnce();
    expect(mockChat).toHaveBeenCalledOnce();
    expect(events().at(-1)).toMatchObject({ type: 'error', data: { message: expect.stringMatching(/Conversation changed|another terminal saved/) } });
  });

  it('keeps the original deadline and cumulative usage while receipt acknowledgement is pending', async () => {
    mockChat.mockResolvedValueOnce(question()).mockResolvedValueOnce(answered());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    let beginAnswer!: () => void, answer!: () => void, beginCommit!: () => void, acknowledge!: () => void;
    const answering = new Promise<void>(resolve => { beginAnswer = resolve; });
    const heldAnswer = new Promise<void>(resolve => { answer = resolve; });
    const committing = new Promise<void>(resolve => { beginCommit = resolve; });
    const heldCommit = new Promise<void>(resolve => { acknowledge = resolve; });
    const committed = vi.fn(async () => { beginCommit(); await heldCommit; });
    const running = runHeadless({ prompt: 'Write a report', provider: 'anthropic', outputMode: 'json', maxTime: 1,
      signal: controller.signal, answerQuestion: async () => { beginAnswer(); await heldAnswer; return 'Operators'; },
      onQuestionCommitted: committed });
    try {
      expect(await Promise.race([answering.then(() => 'answer'), running.then(() => 'finished')])).toBe('answer');
      await vi.advanceTimersByTimeAsync(600); answer();
      expect(await Promise.race([committing.then(() => 'receipt'), running.then(() => 'finished')])).toBe('receipt');
      await vi.advanceTimersByTimeAsync(399);
      expect(events().some(event => event.type === 'done')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toBe(CAP_EXIT_CODE);
      expect(committed).toHaveBeenCalledOnce();
      expect(mockChat).toHaveBeenCalledOnce();
      expect(events().at(-1)).toMatchObject({ type: 'done', data: { reason: 'budget', stoppedBy: 'time', elapsedMs: 1000, inputTokens: 800, outputTokens: 200 } });
    } finally { controller.abort(); answer(); acknowledge(); await running; vi.useRealTimers(); }
  });

  it('refuses a shared-runtime delivery hook without a checkpoint writer before inference', async () => {
    const { runTurn } = await import('../src/runtime/index.js');
    const committed = vi.fn(async () => {});
    await expect(runTurn({ sessionId: 'receipt-without-writer', cwd: process.cwd(), provider: 'anthropic',
      prompt: 'Write a report', messages: { current: [] }, onQuestionCommitted: committed }))
      .rejects.toThrow('requires a conversation checkpoint writer');
    expect(mockChat).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  });

  it('never retries past a refused saved-answer receipt through the shared runtime error handler', async () => {
    const { runTurn } = await import('../src/runtime/index.js');
    mockChat.mockResolvedValueOnce(question()).mockResolvedValueOnce(answered());
    mockExecuteTool.mockResolvedValue({ result: 'Question displayed', isError: false });
    const onError = vi.fn(() => 'retry' as const);
    const committed = vi.fn(async () => { throw new Error('Host refused delivery'); });
    const checkpoint = vi.fn();
    await expect(runTurn({ sessionId: 'receipt-refused-no-retry', cwd: process.cwd(), provider: 'anthropic',
      prompt: 'Write a report', messages: { current: [] }, onCheckpoint: checkpoint,
      answerQuestion: async () => 'Operators', onQuestionCommitted: committed, onError }))
      .rejects.toThrow('Host refused delivery');
    expect(committed).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledOnce();
    expect(mockExecuteTool).toHaveBeenCalledOnce();
    expect(checkpoint.mock.calls.some(([history]) => history.some((message: { role: string; content: string }) =>
      message.role === 'tool' && message.content === 'Operators'))).toBe(true);
  });
});

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

describe('headless reasoning effort', () => {
  it('keeps the default absent, trims environment input and lets either flag form override it', () => {
    expect(parseHeadlessEffort([], {})).toBeUndefined();
    expect(parseHeadlessEffort([], { CALLIOPE_REASONING_EFFORT: ' ' })).toBeUndefined();
    expect(parseHeadlessEffort([], { CALLIOPE_REASONING_EFFORT: ' medium ' })).toBe('medium');
    for (const args of [['--reasoning-effort', 'medium'], ['--reasoning-effort=medium']])
      expect(parseHeadlessEffort(args, { CALLIOPE_REASONING_EFFORT: 'invalid' })).toBe('medium');
  });
  it.each([['--reasoning-effort'], ['--reasoning-effort', '--json'], ['--reasoning-effort='], ['--reasoning-effort', 'invented'], ['--reasoning-effort', 'low', '--reasoning-effort=high']])('rejects malformed or ambiguous effort: %j', (...args) => {
    expect(() => parseHeadlessEffort(args as string[], {})).toThrow(/reasoning-effort/);
  });
  it('rejects an unsupported environment value rather than reverting to provider defaults', () => {
    expect(() => parseHeadlessEffort([], { CALLIOPE_REASONING_EFFORT: 'invented' })).toThrow(/CALLIOPE_REASONING_EFFORT/);
  });
  it('rejects malformed programmatic options before inference', async () => {
    expect(await runHeadless({ prompt: 'work', outputMode: 'json', reasoningEffort: 'invented' as any })).toBe(2);
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

describe('headless execution control', () => {
  it('settles a requested pause when preflight refuses the run before creating a session', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const control = new RuntimeControl(), pause = control.pause('invalid-preflight');
    expect(await runHeadless({ prompt: 'Original goal', control, outputMode: 'json',
      reasoningEffort: 'invalid' as never })).toBe(2);
    expect(control.state.phase).toBe('stopped');
    await expect(pause).rejects.toThrow('before runtime admission');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('refuses another headless invocation without stopping the controller owner', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const control = new RuntimeControl(), pause = control.pause('owner');
    mockChat.mockResolvedValue({ content: 'verified', usage: { inputTokens: 1, outputTokens: 1 } });
    const running = runHeadless({ prompt: 'Original goal', provider: 'anthropic', control, outputMode: 'json' });
    const receipt = await pause;
    expect(await runHeadless({ prompt: 'Another goal', control, outputMode: 'json' })).toBe(2);
    expect(control.state.phase).toBe('paused');
    await control.resume(receipt);
    expect(await running).toBe(0);
    expect(mockChat).toHaveBeenCalledOnce();
    expect(await runHeadless({ prompt: 'Reuse ended control', control, outputMode: 'json' })).toBe(2);
  });

  it('uses the existing session writer for pause, resume and steering receipts', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const { readSessionConversation } = await import('../src/storage.js');
    const control = new RuntimeControl(), pause = control.pause('headless');
    const committed = vi.fn(async (receipt: import('../src/runtime/control.js').ControlReceipt) => {
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(readSessionConversation(receipt.sessionId).revision).toBe(receipt.revision);
    });
    mockChat.mockResolvedValue({ content: 'done', usage: { inputTokens: 800, outputTokens: 200 } });
    const running = runHeadless({ prompt: 'Original goal', provider: 'anthropic', control,
      onControlCommitted: committed, outputMode: 'json' });
    const receipt = await pause;
    expect(mockChat).not.toHaveBeenCalled();
    const steering = control.steer({ requestId: 'note', sessionId: receipt.sessionId,
      revision: receipt.revision, text: '  Preserve María and 東京.\n' });
    await control.resume(receipt); await steering;
    expect(await running).toBe(0);
    expect(committed.mock.calls.map(([r]) => r.kind)).toEqual(['paused', 'resumed', 'steered']);
    expect(new Set(committed.mock.calls.map(([r]) => r.sessionId)).size).toBe(1);
    expect(events().filter(row => row.type === 'status' && row.data.control)).toHaveLength(3);
  });

  it('keeps the original wall-clock deadline active while paused', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const control = new RuntimeControl(), pause = control.pause('deadline');
    const running = runHeadless({ prompt: 'Original goal', provider: 'anthropic', control, maxTime: 1, outputMode: 'json' });
    await pause; await vi.advanceTimersByTimeAsync(1001);
    expect(await running).toBe(CAP_EXIT_CODE);
    expect(mockChat).not.toHaveBeenCalled();
    expect(eventOf('budget_exceeded')).toMatchObject({ kind: 'time' });
    expect(control.state.phase).toBe('stopped');
  });

  it('does not reset cumulative spend or iterations across pause and resume', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const control = new RuntimeControl();
    let began!: () => void, release!: () => void;
    const started = new Promise<void>(yes => { began = yes; });
    const held = new Promise<void>(yes => { release = yes; });
    mockChat.mockResolvedValueOnce(toolCallWithUsage('first')).mockResolvedValueOnce(toolCallWithUsage('second'));
    mockExecuteTool.mockImplementation(async () => { began(); await held; return { result: 'read evidence' }; });
    const running = runHeadless({ prompt: 'Original goal', provider: 'anthropic', control, maxCost: .15, outputMode: 'json' });
    await started; const pause = control.pause('cost'); release(); const receipt = await pause;
    expect(mockChat).toHaveBeenCalledOnce();
    await control.resume(receipt);
    expect(await running).toBe(CAP_EXIT_CODE);
    expect(mockChat).toHaveBeenCalledTimes(2); expect(mockExecuteTool).toHaveBeenCalledOnce();
    expect(eventOf('budget_exceeded')).toMatchObject({ kind: 'cost', data: { costUsd: .2 } });
  });

  it('refuses an external conversation revision changed during control acknowledgment', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const { readSessionConversation, saveSessionConversation } = await import('../src/storage.js');
    const control = new RuntimeControl(), pause = control.pause('stale-control');
    const running = runHeadless({ prompt: 'Original goal', provider: 'anthropic', control, outputMode: 'json',
      onControlCommitted: async receipt => {
        const saved = readSessionConversation(receipt.sessionId);
        saveSessionConversation(receipt.sessionId, saved.messages, { expectedRevision: saved.revision, status: 'active' });
      } });
    expect(await running).toBe(1); await expect(pause).rejects.toThrow('Turn ended');
    expect(mockChat).not.toHaveBeenCalled();
    expect(events().at(-1)).toMatchObject({ type: 'error', data: { message: expect.stringMatching(/Conversation changed|another terminal saved/) } });
  });

  it('refuses control acknowledgment without a controller before provider admission', async () => {
    expect(await runHeadless({ prompt: 'Original goal', provider: 'anthropic', outputMode: 'json',
      onControlCommitted: async () => {} })).toBe(2);
    expect(mockChat).not.toHaveBeenCalled();
  });
});

describe('headless initial control admission', () => {
  it('acknowledges one immutable saved checkpoint before requests and retains it through repair', async () => {
    const { RuntimeControl, CONTROL_CHECKPOINT_PROTOCOL_VERSION } = await import('../src/runtime/index.js');
    const { readSessionConversation } = await import('../src/storage.js');
    expect(CONTROL_CHECKPOINT_PROTOCOL_VERSION).toBe(1);
    const controller = new AbortController();
    const ready = vi.fn(async (proof: import('../src/runtime/control.js').ControlReadyCheckpoint, signal?: AbortSignal) => {
      expect(Object.isFrozen(proof)).toBe(true); expect(signal).toBe(controller.signal);
      expect(mockChat).not.toHaveBeenCalled();
      const saved = readSessionConversation(proof.sessionId);
      expect(saved).toMatchObject({ revision: proof.revision, checksum: proof.checksum });
    });
    mockChat.mockResolvedValue({ content: 'Proposed result', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
    const check = vi.fn().mockResolvedValueOnce({ accepted: false, feedback: 'Repair the existing criterion.' })
      .mockResolvedValueOnce({ accepted: true, evidenceSha256: 'a'.repeat(64) });
    expect(await runHeadless({ prompt: 'Original goal', provider: 'anthropic', control: new RuntimeControl(),
      signal: controller.signal, onControlReady: ready, completionCheck: check })).toBe(0);
    expect(ready).toHaveBeenCalledOnce(); expect(mockChat).toHaveBeenCalledTimes(2);
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { verification: { sessionId: ready.mock.calls[0][0].sessionId, checks: 2 } } });
  });

  it('holds rejected initial ownership without a model call or raw host exception', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const control = new RuntimeControl();
    const ready = vi.fn(async () => { throw new Error('private initial authority diagnostic'); });
    expect(await runHeadless({ prompt: 'Original goal', provider: 'anthropic', control, onControlReady: ready })).toBe(1);
    expect(mockChat).not.toHaveBeenCalled(); expect(ready).toHaveBeenCalledOnce();
    expect(JSON.stringify(events()) + JSON.stringify(stderr.mock.calls)).not.toContain('private initial authority diagnostic');
    expect(eventOf('error').data.message).toBe('Initial control checkpoint was not acknowledged.');
    expect(control.state.phase).toBe('stopped');
  });

  it('refuses a saved revision changed during initial acknowledgment before inference', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const { readSessionConversation, saveSessionConversation } = await import('../src/storage.js');
    expect(await runHeadless({ prompt: 'Original goal', provider: 'anthropic', control: new RuntimeControl(),
      onControlReady: async proof => {
        const saved = readSessionConversation(proof.sessionId);
        saveSessionConversation(proof.sessionId, saved.messages, { expectedRevision: saved.revision, status: 'active' });
      } })).toBe(1);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('keeps the original deadline when the initial host acknowledgment never settles', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let began!: () => void; const started = new Promise<void>(yes => { began = yes; });
    const running = runHeadless({ prompt: 'Original goal', provider: 'anthropic', control: new RuntimeControl(), maxTime: 1,
      onControlReady: async () => { began(); await new Promise<void>(() => {}); } });
    await started; await vi.advanceTimersByTimeAsync(1001);
    expect(await running).toBe(CAP_EXIT_CODE); expect(mockChat).not.toHaveBeenCalled();
    expect(events().at(-1)).toMatchObject({ type: 'done', data: { stoppedBy: 'time' } });
  });

  it('honors caller cancellation while awaiting initial ownership', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    const controller = new AbortController();
    let began!: () => void; const started = new Promise<void>(yes => { began = yes; });
    const running = runHeadless({ prompt: 'Original goal', provider: 'anthropic', control: new RuntimeControl(), signal: controller.signal,
      onControlReady: async () => { began(); await new Promise<void>(() => {}); } });
    await started; controller.abort();
    expect(await running).toBe(130); expect(mockChat).not.toHaveBeenCalled();
  });

  it('refuses a missing controller, malformed hook and explicit non-void acknowledgment', async () => {
    const { RuntimeControl } = await import('../src/runtime/index.js');
    expect(await runHeadless({ prompt: 'Original goal', onControlReady: async () => {} })).toBe(2);
    expect(await runHeadless({ prompt: 'Original goal', control: new RuntimeControl(), onControlReady: false as never })).toBe(2);
    expect(await runHeadless({ prompt: 'Original goal', provider: 'anthropic', control: new RuntimeControl(),
      onControlReady: async () => false as never })).toBe(1);
    expect(mockChat).not.toHaveBeenCalled();
  });
});
