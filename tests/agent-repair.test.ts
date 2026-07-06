/**
 * Local-backend tool-call repair loop (#188 features 2 & 3), exercised through
 * runAgentImpl. Verifies: a malformed tool call from a LOCAL backend triggers one
 * corrective round-trip; a successfully-corrected call executes; a still-malformed
 * repair surfaces the error without a second repair. Fully mocked (no network).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../src/ui/agent.js';
import type { Message as LLMMessage, LLMProvider, Mode, Tool } from '../src/types.js';

const chatMock = vi.fn();
const executeToolMock = vi.fn();

const READ_FILE_TOOL: Tool = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] },
};

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 3;
    if (key === 'audit') return { enabled: false }; // no run-log disk writes in tests
    return undefined;
  }),
  getConfig: vi.fn(() => ({})),
  getBaseUrl: vi.fn(() => 'http://localhost:11434'),
}));

vi.mock('../src/providers/index.js', () => ({
  chat: (...args: unknown[]) => chatMock(...args),
  getAvailableProviders: vi.fn(() => ['ollama']),
}));

vi.mock('../src/providers/types.js', () => ({
  estimateContextUsage: vi.fn(() => ({ estimated: 100, limit: 100000, percent: 1, needsSummarization: false })),
  needsSummarization: vi.fn(() => false),
}));

vi.mock('../src/tools.js', () => ({
  executeTool: (...args: unknown[]) => executeToolMock(...args),
  getTools: vi.fn(() => [READ_FILE_TOOL]),
}));

// Keep the real local-model helpers (detection/repair are pure); only stub the
// network capability probe so the format decision is deterministic.
vi.mock('../src/local-model.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/local-model.js')>();
  return {
    ...actual,
    getLocalModelProfile: vi.fn(async () => ({
      provider: 'ollama' as LLMProvider,
      model: 'gemma4:31b',
      contextLength: 262144,
      supportsNativeToolCalls: true,
      supportsJsonSchemaFormat: true,
    })),
  };
});

vi.mock('../src/types.js', () => ({
  DEFAULT_MODELS: { ollama: 'gemma4:31b' },
  RISK_CONFIG: {
    none: { bar: '', color: 'dim', label: 'None' },
    low: { bar: '#', color: 'green', label: 'Low' },
    medium: { bar: '##', color: 'yellow', label: 'Medium' },
    high: { bar: '###', color: 'red', label: 'High' },
    critical: { bar: '####', color: 'red', label: 'CRITICAL' },
  },
  calculateCost: vi.fn(() => 0),
}));

vi.mock('../src/model-detection.js', () => ({
  getModelContextLimit: vi.fn(() => 262144),
  getModelMaxOutput: vi.fn(() => 8192),
}));

vi.mock('../src/risk.js', () => ({
  assessToolRisk: vi.fn(() => ({ level: 'low', reason: '', canAutoApprove: true })),
  requiresConfirmation: vi.fn(() => false),
}));

vi.mock('../src/errors.js', () => ({
  formatError: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  classifyError: vi.fn(() => ({ category: 'other' })),
}));

vi.mock('../src/storage.js', () => ({ saveMessageHistory: vi.fn(), recordCost: vi.fn() }));
vi.mock('../src/hooks.js', () => ({ checkHooksAllow: vi.fn(async () => ({ allowed: true })), executeHooks: vi.fn(() => Promise.resolve()) }));
vi.mock('../src/router.js', () => ({ routeRequest: vi.fn(), smartRoute: vi.fn(), getDefaultSmartRoutingConfig: vi.fn(() => ({ enabled: false })) }));
vi.mock('../src/summarization.js', () => ({
  validateMessageHistory: vi.fn((m: unknown[]) => m),
  summarizeConversation: vi.fn((m: unknown[]) => ({ messages: m, summarizedCount: 0, originalTokens: 0, reducedTokens: 0, summary: '' })),
  estimateTotalTokens: vi.fn(() => 100),
  summarizeMessages: vi.fn(() => ''),
}));
vi.mock('../src/auto-compressor.js', () => ({ autoCompress: vi.fn(async (messages: unknown[]) => ({ compressed: false, messages })) }));
vi.mock('../src/parallel-tools.js', () => ({
  executeParallel: vi.fn(),
  getParallelizationStats: vi.fn(() => ({ totalCalls: 1, maxParallel: 1, stages: 1 })),
}));
vi.mock('../src/ui/context.js', () => ({ checkAndWarnContextLimit: vi.fn() }));
vi.mock('../src/circuit-breaker.js', () => ({ CircuitBreaker: vi.fn() }));
vi.mock('../src/iteration-ledger.js', () => ({ IterationLedger: vi.fn() }));
vi.mock('../src/checkpoint.js', () => ({ shouldCheckpoint: vi.fn(() => false), createCheckpoint: vi.fn() }));
vi.mock('../src/prevent-sleep.js', () => ({ startPreventSleep: vi.fn(), stopPreventSleep: vi.fn() }));

const { runAgentImpl } = await import('../src/ui/agent.js');

function makeLedger() {
  return {
    getActiveRun: vi.fn(() => undefined),
    startRun: vi.fn(() => 'run-1'),
    getNextIterationNumber: vi.fn(() => 1),
    startIteration: vi.fn(),
    getFailedApproachesMessage: vi.fn(() => ''),
    recordTokens: vi.fn(),
    recordAction: vi.fn(),
    endIteration: vi.fn(),
    finishRun: vi.fn(),
  };
}

function makeCtx() {
  const collectedMessages: Array<{ type: string; content: string }> = [];
  const llmMessages: LLMMessage[] = [];
  const ledger = makeLedger();

  const ctx = {
    provider: 'ollama' as LLMProvider,
    model: 'gemma4:31b',
    mode: 'work' as Mode,
    confirmMode: false,
    autoRoute: false,
    actualProvider: 'ollama',
    actualModel: 'gemma4:31b',
    stats: { messageCount: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
    ledger,

    setStats: vi.fn((v: unknown) => { ctx.stats = typeof v === 'function' ? (v as (p: unknown) => unknown)(ctx.stats) : v; }),
    setStreamingResponse: vi.fn(),
    setThinkingState: vi.fn(),
    setActivityState: vi.fn(),
    setContextTokens: vi.fn(),
    setIsProcessing: vi.fn(),
    setQueuedMessages: vi.fn(),
    setEditingQueueIndex: vi.fn(),
    setLoopIteration: vi.fn(),
    setLoopActive: vi.fn(),

    llmMessages: { current: llmMessages },
    queuedMessagesRef: { current: [] as string[] },
    loopCancelledRef: { current: false },
    sessionRef: { current: null },

    addMessage: (type: string, content: string) => { collectedMessages.push({ type, content }); },
    estimateContextTokens: vi.fn(() => 0),
    validateAndRepairMessages: vi.fn(() => true),
    debugLog: vi.fn(),
    collectedMessages,
    ledgerSpy: ledger,
  } as unknown as AgentContext & { collectedMessages: Array<{ type: string; content: string }>; ledgerSpy: ReturnType<typeof makeLedger> };

  return ctx;
}

const sys = (content: string) => (m: { type: string; content: string }) => m.type === 'system' && m.content.includes(content);

beforeEach(() => {
  chatMock.mockReset();
  executeToolMock.mockReset();
  executeToolMock.mockImplementation(async (toolCall: { id: string; arguments: Record<string, unknown> }) => {
    if (typeof toolCall.arguments.path !== 'string') {
      return { toolCallId: toolCall.id, result: 'Error: path must be a string', isError: true };
    }
    return { toolCallId: toolCall.id, result: 'file contents', isError: false };
  });
});

describe('local-backend tool-call repair loop', () => {
  it('repairs a malformed call via one corrective round-trip, then the fixed call executes', async () => {
    chatMock
      // main turn: malformed read_file (missing required path)
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }], finishReason: 'tool_use' })
      // repair round-trip: corrected native tool call
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.ts' } }], finishReason: 'tool_use' })
      // next turn: final answer
      .mockResolvedValueOnce({ content: 'done', toolCalls: [], finishReason: 'stop' });

    const ctx = makeCtx();
    await runAgentImpl(ctx, 'read a.ts');

    // The corrected call reached execution, with the original id preserved.
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    const executed = executeToolMock.mock.calls[0][0];
    expect(executed).toMatchObject({ id: 't1', name: 'read_file', arguments: { path: 'a.ts' } });

    // A corrective round-trip was sent, carrying the reason.
    expect(chatMock).toHaveBeenCalledTimes(3);
    const repairMessages = chatMock.mock.calls[1][1] as LLMMessage[];
    const corrective = repairMessages[repairMessages.length - 1];
    expect(corrective.role).toBe('user');
    expect(String(corrective.content)).toContain('malformed');
    expect(String(corrective.content)).toContain('missing required parameter "path"');

    // User-visible + ledger signals.
    expect(ctx.collectedMessages.some(sys('Malformed tool call'))).toBe(true);
    expect(ctx.collectedMessages.some(sys('Repaired tool call'))).toBe(true);
    expect(ctx.ledgerSpy.recordAction).toHaveBeenCalledWith('repair', expect.anything(), 'ok', undefined);
  });

  it('constrains the repair reply with the Ollama format param', async () => {
    chatMock
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }], finishReason: 'tool_use' })
      .mockResolvedValueOnce({ content: '{"name":"read_file","arguments":{"path":"b.ts"}}', toolCalls: undefined, finishReason: 'stop' })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [], finishReason: 'stop' });

    const ctx = makeCtx();
    await runAgentImpl(ctx, 'read b.ts');

    // The repair round-trip (2nd chat call) passed a format schema in options.
    const repairOptions = chatMock.mock.calls[1][6];
    expect(repairOptions).toBeDefined();
    expect(repairOptions.format).toMatchObject({ type: 'object', required: ['name', 'arguments'] });

    // The grammar-constrained JSON envelope was parsed and executed.
    expect(executeToolMock.mock.calls[0][0]).toMatchObject({ name: 'read_file', arguments: { path: 'b.ts' } });
  });

  it('surfaces the error when the repair is still malformed — no second repair', async () => {
    chatMock
      // main turn: malformed
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: {} }], finishReason: 'tool_use' })
      // repair round-trip: STILL missing path
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'r1', name: 'read_file', arguments: {} }], finishReason: 'tool_use' })
      // next turn: final answer
      .mockResolvedValueOnce({ content: 'giving up', toolCalls: [], finishReason: 'stop' });

    const ctx = makeCtx();
    await runAgentImpl(ctx, 'read c.ts');

    // Exactly one repair round-trip (3 chat calls total: main, repair, final).
    expect(chatMock).toHaveBeenCalledTimes(3);
    // The still-malformed call reached execution and errored (surfaced naturally).
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(executeToolMock.mock.calls[0][0]).toMatchObject({ name: 'read_file', arguments: {} });
    expect(ctx.collectedMessages.some(sys('did not resolve'))).toBe(true);
    expect(ctx.ledgerSpy.recordAction).toHaveBeenCalledWith('repair', expect.anything(), 'error', expect.anything());
  });

  it('does not repair well-formed local tool calls (no extra round-trip)', async () => {
    chatMock
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'a.ts' } }], finishReason: 'tool_use' })
      .mockResolvedValueOnce({ content: 'done', toolCalls: [], finishReason: 'stop' });

    const ctx = makeCtx();
    await runAgentImpl(ctx, 'read a.ts');

    // No repair round-trip: 2 chat calls (main + final), tool executed once.
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(executeToolMock).toHaveBeenCalledTimes(1);
    expect(ctx.collectedMessages.some(sys('Malformed tool call'))).toBe(false);
  });

  it('surfaces a provider warning (e.g. Ollama model substitution) to the transcript once (#217)', async () => {
    // A warning string unique to this test so the per-session dedup Set (module
    // scope) can't have been primed by another case.
    const warning = 'ollama: model "unique-probe:99b" not found — using "llama3.2" (ollama pull unique-probe:99b to use it)';
    chatMock.mockResolvedValueOnce({ content: 'done', toolCalls: [], finishReason: 'stop', warnings: [warning] });

    const ctx = makeCtx();
    await runAgentImpl(ctx, 'hello');

    const surfaced = ctx.collectedMessages.filter(m => m.type === 'system' && m.content === warning);
    expect(surfaced).toHaveLength(1);
  });
});
