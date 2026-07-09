import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../src/ui/agent.js';
import type { Message as LLMMessage, LLMProvider, Mode } from '../src/types.js';

const chatMock = vi.fn();
const saveMessageHistoryMock = vi.fn();

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 1;
    if (key === 'audit') return { enabled: false }; // no run-log disk writes in tests
    return undefined;
  }),
  getConfig: vi.fn(() => ({})),
}));

vi.mock('../src/providers/index.js', () => ({
  chat: (...args: unknown[]) => chatMock(...args),
  getAvailableProviders: vi.fn(() => ['openai', 'google']),
}));

vi.mock('../src/providers/types.js', () => ({
  estimateContextUsage: vi.fn(() => ({
    estimated: 100,
    limit: 100000,
    percent: 1,
    needsSummarization: false,
  })),
  needsSummarization: vi.fn(() => false),
}));

vi.mock('../src/tools.js', () => ({
  executeTool: vi.fn(),
  getTools: vi.fn(() => []),
}));

vi.mock('../src/types.js', () => ({
  DEFAULT_MODELS: { openai: 'gpt-4o' },
  RISK_CONFIG: {},
  calculateCost: vi.fn(() => 0),
}));

vi.mock('../src/model-detection.js', () => ({
  getModelContextLimit: vi.fn(() => 100000),
  getModelMaxOutput: vi.fn(() => 8192),
}));

vi.mock('../src/risk.js', () => ({
  assessToolRisk: vi.fn(() => ({ level: 'low', reason: '', canAutoApprove: true })),
  requiresConfirmation: vi.fn(() => false),
}));

vi.mock('../src/errors.js', () => ({
  formatError: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
  classifyError: vi.fn(() => ({ category: 'other' })),
}));

vi.mock('../src/storage.js', () => ({
  saveMessageHistory: (...args: unknown[]) => saveMessageHistoryMock(...args),
  recordCost: vi.fn(),
}));

vi.mock('../src/hooks.js', () => ({
  checkHooksAllow: vi.fn(async () => ({ allowed: true })),
  executeHooks: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/router.js', () => ({
  routeRequest: vi.fn(),
  smartRoute: vi.fn(),
  getDefaultSmartRoutingConfig: vi.fn(() => ({ enabled: false })),
}));

vi.mock('../src/summarization.js', () => ({
  validateMessageHistory: vi.fn((messages: unknown[]) => messages),
  summarizeConversation: vi.fn((messages: unknown[]) => ({
    messages,
    summarizedCount: 0,
    originalTokens: 0,
    reducedTokens: 0,
    summary: '',
  })),
  estimateTotalTokens: vi.fn(() => 100),
  summarizeMessages: vi.fn(() => ''),
}));

vi.mock('../src/parallel-tools.js', () => ({
  executeParallel: vi.fn(),
  getParallelizationStats: vi.fn(() => ({
    totalCalls: 0,
    parallelCalls: 0,
    sequentialCalls: 0,
    stages: 0,
  })),
}));


vi.mock('../src/ui/context.js', () => ({
  checkAndWarnContextLimit: vi.fn(),
}));

vi.mock('../src/circuit-breaker.js', () => ({
  CircuitBreaker: vi.fn(),
}));

vi.mock('../src/iteration-ledger.js', () => ({
  IterationLedger: vi.fn(),
}));

vi.mock('../src/checkpoint.js', () => ({
  shouldCheckpoint: vi.fn(() => false),
  createCheckpoint: vi.fn(),
}));


vi.mock('../src/prevent-sleep.js', () => ({
  startPreventSleep: vi.fn(),
  stopPreventSleep: vi.fn(),
}));

const { runAgentImpl } = await import('../src/ui/agent.js');

function makeCtx(): AgentContext & { collectedMessages: Array<{ type: string; content: string }> } {
  const collectedMessages: Array<{ type: string; content: string }> = [];
  const llmMessages: LLMMessage[] = [];

  const ctx = {
    provider: 'openai' as LLMProvider,
    model: 'gpt-4o',
    mode: 'hybrid' as Mode,
    confirmMode: false,
    autoRoute: false,
    actualProvider: 'openai',
    actualModel: 'gpt-4o',
    stats: {
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    },

    setStats: vi.fn((value: unknown) => {
      if (typeof value === 'function') {
        ctx.stats = value(ctx.stats);
      } else {
        ctx.stats = value as AgentContext['stats'];
      }
    }),
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

    addMessage: (type: 'user' | 'assistant' | 'tool' | 'system' | 'error', content: string) => {
      collectedMessages.push({ type, content });
    },
    estimateContextTokens: vi.fn(() => 0),
    validateAndRepairMessages: vi.fn(() => true),

    debugLog: vi.fn(),
    collectedMessages,
  } as unknown as AgentContext & { collectedMessages: Array<{ type: string; content: string }> };

  return ctx;
}


describe('plan mode evidence (#224)', () => {
  beforeEach(() => {
    chatMock.mockReset();
    saveMessageHistoryMock.mockReset();
  });

  it('injects the plan-mode instruction into outgoing messages (plan only)', async () => {
    chatMock.mockResolvedValue({ content: 'Here is my plan.', toolCalls: [] });

    const planCtx = makeCtx();
    (planCtx as { mode: string }).mode = 'plan';
    await runAgentImpl(planCtx, 'plan something');
    const planMessages = chatMock.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(planMessages.some(m => m.role === 'system' && m.content.includes('PLAN mode'))).toBe(true);
    // The transient instruction must not persist into history
    expect(planCtx.llmMessages.current.some(m => typeof m.content === 'string' && m.content.includes('PLAN mode'))).toBe(false);

    chatMock.mockClear();
    chatMock.mockResolvedValue({ content: 'Done.', toolCalls: [] });
    const hybridCtx = makeCtx();
    await runAgentImpl(hybridCtx, 'do something');
    const hybridMessages = chatMock.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(hybridMessages.some(m => m.role === 'system' && m.content.includes('PLAN mode'))).toBe(false);
  });

  it('marks a zero-tool-call plan as unverified', async () => {
    chatMock.mockResolvedValue({ content: 'A confident plan with no receipts.', toolCalls: [] });
    const ctx = makeCtx();
    (ctx as { mode: string }).mode = 'plan';
    await runAgentImpl(ctx, 'plan the refactor');
    const marker = ctx.collectedMessages.find(m => m.type === 'system' && m.content.includes('Unverified plan'));
    expect(marker).toBeDefined();
  });

  it('does not mark a plan that read files', async () => {
    const { executeTool } = await import('../src/tools.js');
    (executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({ toolCallId: 't1', result: 'file contents', isError: false });
    chatMock
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'src/bin.ts' } }], finishReason: 'tool_use' })
      .mockResolvedValueOnce({ content: 'Plan citing bin.ts:45.', toolCalls: [] });
    const ctx = makeCtx();
    (ctx as { mode: string }).mode = 'plan';
    await runAgentImpl(ctx, 'plan the refactor');
    const marker = ctx.collectedMessages.find(m => m.type === 'system' && m.content.includes('Unverified plan'));
    expect(marker).toBeUndefined();
  });

  it('never marks outside plan mode', async () => {
    chatMock.mockResolvedValue({ content: 'Just an answer.', toolCalls: [] });
    const ctx = makeCtx();
    await runAgentImpl(ctx, 'hi');
    expect(ctx.collectedMessages.some(m => m.content.includes('Unverified plan'))).toBe(false);
  });
});
