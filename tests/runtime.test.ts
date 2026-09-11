/** Shared engine contracts: real permission/scope gates and tool dispatch with a
 * deterministic provider. These are behavioral tests, not wire conformance. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, LLMResponse, ToolCall } from '../src/types.js';
import type { TurnOptions } from '../src/runtime/turn.js';

const { chatMock, executeMock } = vi.hoisted(() => ({ chatMock: vi.fn(), executeMock: vi.fn() }));
vi.mock('../src/providers/index.js', () => ({ chat: chatMock }));
vi.mock('../src/tools.js', async importActual => ({ ...await importActual<typeof import('../src/tools.js')>(), executeTool: executeMock }));
vi.mock('../src/local-model.js', async importActual => ({ ...await importActual<typeof import('../src/local-model.js')>(), getLocalModelProfile: vi.fn(async () => ({ supportsJsonSchemaFormat: true })) }));
import { runTurn, completePendingTools, shouldRetryTool } from '../src/runtime/index.js';
import { scopeManager, withScope, validatePath } from '../src/scope.js';
import * as budget from '../src/budget.js';
import * as compressor from '../src/auto-compressor.js';
import * as config from '../src/config.js';
import { RunLog } from '../src/runlog.js';
import { CancellationError } from '../src/cancellation.js';
import { clearModelCache } from '../src/model-detection.js';

let root: string;
const text = (content = 'done', tokens = 3): LLMResponse => ({ content, finishReason: 'stop', usage: { inputTokens: tokens, outputTokens: 1 } });
const tool = (name = 'read_file', id = 'read', args: Record<string, unknown> = { path: 'ok.txt' }): ToolCall => ({ id, name, arguments: args });
const response = (...calls: ToolCall[]): LLMResponse => ({ ...text('working'), finishReason: 'tool_use', toolCalls: calls });
function options(extra: Partial<TurnOptions> = {}): TurnOptions {
  return { sessionId: 'test-runtime', cwd: root, provider: 'openai', model: 'test-model', prompt: 'work',
    messages: { current: [{ role: 'user', content: 'work' }] }, confirmation: 'none', maxIterations: 3,
    runlog: RunLog.open('test-runtime', { enabled: false }), ...extra };
}
beforeEach(async () => {
  vi.restoreAllMocks();
  clearModelCache();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
  chatMock.mockReset(); executeMock.mockReset();
  root = mkdtempSync(join(tmpdir(), 'calliope-runtime-'));
  writeFileSync(join(root, 'ok.txt'), 'hello');
  config.set('budget', {}); config.set('sandbox', 'none'); config.set('policy', {});
  scopeManager.reset(root);
  compressor.configureAutoCompressor({ enabled: true, triggerThreshold: 80, preserveRecent: 10, useLlm: true });
  compressor.resetAutoCompressorState();
  const actual = await vi.importActual<typeof import('../src/tools.js')>('../src/tools.js');
  executeMock.mockImplementation(actual.executeTool);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

describe('shared turn runtime', () => {
  it.each(['terminal', 'headless', 'acp', 'library'] as const)('%s uses the same execution, accounting and transcript contract', async client => {
    chatMock.mockResolvedValueOnce(response(tool())).mockResolvedValueOnce(text());
    const usage = vi.fn(); const opts = options({ client, onUsage: usage });
    const result = await runTurn(opts);
    expect(result).toMatchObject({ reason: 'completed', iterations: 2, totals: { inputTokens: 6, outputTokens: 2, toolCalls: 1 } });
    expect(opts.messages.current.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(opts.messages.current[2].content).toContain('hello');
    expect(usage).toHaveBeenCalledTimes(2);
  });
  it('fails closed on out-of-scope writes for a headless caller', async () => {
    chatMock.mockResolvedValueOnce(response(tool('write_file', 'write', { path: '../escape.txt', content: 'bad' }))).mockResolvedValueOnce(text());
    const result = vi.fn(); await runTurn(options({ client: 'headless', onToolResult: result }));
    expect(executeMock).not.toHaveBeenCalled();
    expect(result.mock.calls[0][1]).toMatchObject({ isError: true, result: expect.stringContaining('[scope]') });
  });
  it('keeps simultaneous turns and explicit grants isolated', async () => {
    const a = join(root, 'a'); const b = join(root, 'b'); mkdirSync(a); mkdirSync(b);
    writeFileSync(join(a, 'ok.txt'), 'A'); writeFileSync(join(b, 'ok.txt'), 'B');
    let release!: () => void;
    const bothReady = new Promise<void>(resolve => { release = resolve; }); let entered = 0;
    chatMock.mockImplementation(async (_provider, messages: Message[]) => {
      if (messages.some(m => m.role === 'tool')) return text();
      entered++; if (entered === 2) release(); await bothReady;
      return response(tool('read_file', 'own'), tool('read_file', 'other', { path: messages[0].content === 'a' ? join(b, 'ok.txt') : join(a, 'ok.txt') }));
    });
    const oa = options({ cwd: a, messages: { current: [{ role: 'user', content: 'a' }] } });
    const ob = options({ cwd: b, messages: { current: [{ role: 'user', content: 'b' }] } });
    await Promise.all([runTurn(oa), runTurn(ob)]);
    for (const [opts, own] of [[oa, 'A'], [ob, 'B']] as const) {
      expect(opts.messages.current.find(m => m.toolCallId === 'own')?.content).toContain(own);
      expect(opts.messages.current.find(m => m.toolCallId === 'other')?.content).toContain('[scope]');
    }
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
  it('inherits TUI grants only for their original project and restores the outer scope', async () => {
    const extra = join(root, 'extra'); mkdirSync(extra);
    const other = join(root, 'other'); mkdirSync(other);
    scopeManager.reset(extra); scopeManager.addDirectory(other);
    await withScope(extra, async () => { await Promise.resolve(); expect(validatePath(join(other, 'new.txt'), extra)).toBeTruthy(); }, true);
    withScope(other, () => expect(() => validatePath(join(extra, 'new.txt'), other)).toThrow(), true);
    expect(scopeManager.getAllowedDirs()).toContain(other);
  });
  it('never executes plan-mode mutations even with an approving client', async () => {
    chatMock.mockResolvedValueOnce(response(tool('write_file', 'write', { path: 'ok.txt', content: 'bad' }))).mockResolvedValueOnce(text());
    const approve = vi.fn(async () => 'allow' as const);
    const opts = options({ mode: 'plan', confirmation: 'mutating', approve }); await runTurn(opts);
    expect(approve).not.toHaveBeenCalled(); expect(executeMock).not.toHaveBeenCalled();
    expect(readFileSync(join(root, 'ok.txt'), 'utf8')).toBe('hello');
  });
  it.each(['ask_question', 'create_plan'])('pauses at %s and pairs pending calls without running them', async name => {
    executeMock.mockResolvedValue({ result: 'displayed' });
    chatMock.mockResolvedValue(response(tool(name, 'pause', {}), tool('write_file', 'write', { path: 'ok.txt', content: 'bad' })));
    const opts = options({ parallel: true }); const result = await runTurn(opts);
    expect(result.reason).toBe('waiting_for_user'); expect(executeMock).toHaveBeenCalledTimes(1);
    expect(opts.messages.current.filter(m => m.toolCallId === 'pause')).toHaveLength(1);
    expect(opts.messages.current.find(m => m.toolCallId === 'write')?.content).toContain('Do not assume completion');
  });
  it('halts before tool execution when the primary response exhausts the token cap', async () => {
    config.set('budget', { maxTokensPerRun: 3 });
    chatMock.mockResolvedValue(response(tool()));
    const opts = options(); expect((await runTurn(opts)).reason).toBe('budget');
    expect(executeMock).not.toHaveBeenCalled(); expect(chatMock).toHaveBeenCalledTimes(1);
    expect(opts.messages.current.find(m => m.toolCallId === 'read')).toBeDefined();
  });
  it('accounts local repair usage and stops before dispatch on the repair budget', async () => {
    config.set('budget', { maxTokensPerRun: 7 });
    chatMock.mockResolvedValueOnce(response(tool('read_file', 'bad', {}))).mockResolvedValueOnce(response(tool('read_file', 'fixed')));
    const usage = vi.fn(); const result = await runTurn(options({ provider: 'ollama', onUsage: usage }));
    expect(result.reason).toBe('budget'); expect(result.totals.inputTokens).toBe(6);
    expect(usage).toHaveBeenCalledTimes(2); expect(executeMock).not.toHaveBeenCalled();
    const repairMessages = chatMock.mock.calls[1][1] as Message[];
    expect(repairMessages.at(-2)).toMatchObject({ role: 'tool', toolCallId: 'bad' });
    expect(chatMock.mock.calls[1][4]).toBeUndefined();
  });
  it('compression uses the supplied request and propagates budget halts', async () => {
    const messages: Message[] = [{ role: 'user', content: 'context' }];
    const request = vi.fn(async () => text('A sufficiently detailed conversation summary.'));
    expect(await compressor.llmSummarize(messages, 'openai', 'summary-model', undefined, request)).toContain('detailed');
    expect(chatMock).not.toHaveBeenCalled();
    const error = new Error('budget'); error.name = 'RuntimeBudgetExceeded';
    await expect(compressor.llmSummarize(messages, 'openai', 'summary-model', undefined, async () => { throw error; })).rejects.toBe(error);
  });
  it('uses compressed history for the next request and reports it to the adapter', async () => {
    const compact: Message[] = [{ role: 'system', content: 'summary' }, { role: 'user', content: 'work' }];
    vi.spyOn(compressor, 'autoCompress').mockResolvedValueOnce({ compressed: true, method: 'heuristic', messages: compact, originalTokens: 1000, compressedTokens: 10, summarizedCount: 8 });
    chatMock.mockResolvedValue(text()); const onCompression = vi.fn();
    await runTurn(options({ onCompression }));
    expect(chatMock.mock.calls[0][1][0]).toEqual(compact[0]);
    expect(onCompression).toHaveBeenCalledOnce();
  });
  it('streams tool output through the client adapter', async () => {
    chatMock.mockResolvedValueOnce(response(tool('shell', 'shell', { command: 'echo hello' }))).mockResolvedValueOnce(text());
    executeMock.mockImplementation(async (_call, _cwd, _timeout, output) => { output('hello\\n'); return { result: 'hello' }; });
    const output = vi.fn(); await runTurn(options({ onToolOutput: output }));
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: 'shell' }), 'hello\\n');
  });
  it('accounts compression requests against the same cap before the primary request', async () => {
    config.set('budget', { maxTokensPerRun: 3 });
    vi.spyOn(compressor, 'autoCompress').mockImplementationOnce(async (messages, _limit, _provider, _model, _signal, request) => {
      await request!(messages, 'summary-model');
      throw new Error('must not continue');
    });
    chatMock.mockResolvedValue(text());
    const result = await runTurn(options());
    expect(result).toMatchObject({ reason: 'budget', totals: { inputTokens: 3, outputTokens: 1 } });
    expect(chatMock).toHaveBeenCalledTimes(1); expect(chatMock.mock.calls[0][3]).toBe('summary-model');
  });
  it('stops before any request when the project is already over budget', async () => {
    config.set('budget', { maxCostPerProject: 1 }); budget.recordProjectSpend(root, 2);
    expect((await runTurn(options())).reason).toBe('budget'); expect(chatMock).not.toHaveBeenCalled();
  });
  it('returns incomplete for iteration and output limits', async () => {
    chatMock.mockResolvedValue(response(tool())); expect((await runTurn(options({ maxIterations: 1 }))).reason).toBe('iteration_limit');
    chatMock.mockResolvedValue({ ...text(), finishReason: 'length' }); expect((await runTurn(options())).reason).toBe('length');
  });
  it('supports bounded continuation, and explicit presentation stop', async () => {
    chatMock.mockResolvedValueOnce({ ...text('part 1'), finishReason: 'length' }).mockResolvedValueOnce(text('part 2'));
    const opts = options({ continueOnLength: true }); expect((await runTurn(opts)).reason).toBe('completed');
    expect(opts.messages.current.some(m => m.content === 'Please continue where you left off.')).toBe(true);
    chatMock.mockResolvedValue(response(tool())); expect((await runTurn(options({ onResponse: () => 'stop' }))).reason).toBe('stopped');
  });
  it('reports provider error finishes as failures', async () => {
    chatMock.mockResolvedValue({ ...text(), finishReason: 'error' });
    await expect(runTurn(options())).rejects.toThrow('unsuccessful completion');
  });
  it('cancels pending client approval without tool execution', async () => {
    chatMock.mockResolvedValue(response(tool('write_file', 'write', { path: 'ok.txt', content: 'bad' })));
    const opts = options({ confirmation: 'mutating', approve: async () => 'cancelled' });
    expect((await runTurn(opts)).reason).toBe('cancelled'); expect(executeMock).not.toHaveBeenCalled();
    expect(opts.messages.current.find(m => m.toolCallId === 'write')?.content).toContain('cancelled');
  });
  it('waits for all parallel tool cleanup after cancellation', async () => {
    const controller = new AbortController(); let finished = 0;
    chatMock.mockResolvedValue(response(tool('read_file', 'one'), tool('read_file', 'two', { path: 'second.txt' })));
    executeMock.mockImplementation(async (call: ToolCall) => {
      await new Promise(resolve => setTimeout(resolve, call.id === 'one' ? 5 : 25));
      if (call.id === 'one') controller.abort();
      finished++; throw new CancellationError();
    });
    const opts = options({ signal: controller.signal, parallel: true });
    expect((await runTurn(opts)).reason).toBe('cancelled'); expect(finished).toBe(2);
    expect(opts.messages.current.filter(m => m.role === 'tool')).toHaveLength(2); expect(chatMock).toHaveBeenCalledTimes(1);
  });
  it('converts thrown tool errors to paired results', async () => {
    chatMock.mockResolvedValueOnce(response(tool())).mockResolvedValueOnce(text()); executeMock.mockRejectedValue(new Error('read failed'));
    const opts = options(); expect((await runTurn(opts)).reason).toBe('completed');
    expect(opts.messages.current.find(m => m.role === 'tool')?.content).toContain('read failed');
  });
  it('retries transient reads, but never unknown or mutating operations', async () => {
    vi.useFakeTimers(); chatMock.mockResolvedValueOnce(response(tool())).mockResolvedValueOnce(text());
    executeMock.mockResolvedValueOnce({ isError: true, result: 'network timeout' }).mockResolvedValueOnce({ result: 'ok' });
    const retry = vi.fn(); const pending = runTurn(options({ maxRetries: 2, onToolRetry: retry }));
    await vi.runAllTimersAsync(); expect((await pending).reason).toBe('completed'); expect(retry).toHaveBeenCalledTimes(1);
    expect(shouldRetryTool('plugin_mutation', 'network timeout')).toBe(false);
    expect(shouldRetryTool('shell', 'network timeout')).toBe(false);
    expect(shouldRetryTool('read_file', 'not found')).toBe(false);
  });
  it('lets the presentation request a bounded provider retry or stop', async () => {
    vi.useFakeTimers(); chatMock.mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce(text());
    const pending = runTurn(options({ onError: () => 'retry' })); await vi.runAllTimersAsync();
    expect((await pending).reason).toBe('completed'); expect(chatMock).toHaveBeenCalledTimes(2);
    chatMock.mockRejectedValue(new Error('broken')); expect((await runTurn(options({ onError: () => 'stop' }))).reason).toBe('stopped');
  });
  it('surfaces a repeated provider warning once per turn', async () => {
    chatMock.mockResolvedValueOnce({ ...response(tool()), warnings: ['substituted model'] }).mockResolvedValueOnce({ ...text(), warnings: ['substituted model'] });
    const warning = vi.fn(), route = vi.fn(); await runTurn(options({ onWarning: warning, onRoute: route })); expect(warning).toHaveBeenCalledExactlyOnceWith('substituted model');
    expect(route).toHaveBeenCalled();
  });
  it('pairs interrupted calls before subsequent conversation messages', () => {
    const messages: Message[] = [{ role: 'assistant', content: '', toolCalls: [tool()] }, { role: 'user', content: 'next' }];
    completePendingTools(messages, 'cancelled'); completePendingTools(messages, 'cancelled');
    expect(messages.map(m => m.role)).toEqual(['assistant', 'tool', 'user']);
  });
});
