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

const { runAgentImpl, _resetModeTracking } = await import('../src/ui/agent.js');

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



const APPROVAL_SNIPPET = 'switched from plan mode to work mode';

describe('plan-to-work approval injection (#231)', () => {
  beforeEach(() => {
    chatMock.mockReset();
    saveMessageHistoryMock.mockReset();
    _resetModeTracking();
    chatMock.mockResolvedValue({ content: 'ok', toolCalls: [] });
  });

  it('injects the execution directive on the first work turn after a plan turn', async () => {
    const planCtx = makeCtx();
    (planCtx as { mode: string }).mode = 'plan';
    await runAgentImpl(planCtx, 'plan the work');

    chatMock.mockClear();
    chatMock.mockResolvedValue({ content: 'executing', toolCalls: [] });
    const workCtx = makeCtx();
    (workCtx as { mode: string }).mode = 'work';
    await runAgentImpl(workCtx, 'go');
    const msgs = chatMock.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(msgs.some(m => m.role === 'system' && m.content.includes(APPROVAL_SNIPPET))).toBe(true);
    // transient — not persisted into history
    expect(workCtx.llmMessages.current.some(m => typeof m.content === 'string' && m.content.includes(APPROVAL_SNIPPET))).toBe(false);
  });

  it('does not inject on subsequent work turns', async () => {
    const planCtx = makeCtx();
    (planCtx as { mode: string }).mode = 'plan';
    await runAgentImpl(planCtx, 'plan');

    const w1 = makeCtx();
    (w1 as { mode: string }).mode = 'work';
    await runAgentImpl(w1, 'go');

    chatMock.mockClear();
    chatMock.mockResolvedValue({ content: 'more', toolCalls: [] });
    const w2 = makeCtx();
    (w2 as { mode: string }).mode = 'work';
    await runAgentImpl(w2, 'continue');
    const msgs = chatMock.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(msgs.some(m => m.role === 'system' && m.content.includes(APPROVAL_SNIPPET))).toBe(false);
  });

  it('does not inject without a preceding plan turn', async () => {
    const ctx = makeCtx();
    await runAgentImpl(ctx, 'just do something');
    const msgs = chatMock.mock.calls[0][1] as Array<{ role: string; content: string }>;
    expect(msgs.some(m => m.role === 'system' && m.content.includes(APPROVAL_SNIPPET))).toBe(false);
  });
});
