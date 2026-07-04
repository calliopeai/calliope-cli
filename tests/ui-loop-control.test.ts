import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../src/ui/agent.js';
import type { Message as LLMMessage, LLMProvider, Mode } from '../src/types.js';

const chatMock = vi.fn();
const saveMessageHistoryMock = vi.fn();

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 1;
    return undefined;
  }),
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

vi.mock('../src/model-router.js', () => ({
  routeRequest: vi.fn(),
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

vi.mock('../src/companions.js', () => ({
  setMood: vi.fn(),
}));

vi.mock('../src/ui/context.js', () => ({
  checkAndWarnContextLimit: vi.fn(),
}));

vi.mock('../src/circuit-breaker.js', () => ({
  CircuitBreaker: vi.fn(),
}));

vi.mock('../src/smart-router.js', () => ({
  smartRoute: vi.fn(),
  getDefaultSmartRoutingConfig: vi.fn(() => ({ enabled: false })),
}));

vi.mock('../src/iteration-ledger.js', () => ({
  IterationLedger: vi.fn(),
}));

vi.mock('../src/auto-checkpoint.js', () => ({
  shouldCheckpoint: vi.fn(() => false),
  createCheckpoint: vi.fn(),
}));


vi.mock('../src/prevent-sleep.js', () => ({
  startPreventSleep: vi.fn(),
  stopPreventSleep: vi.fn(),
}));

const { runLoopImpl } = await import('../src/ui/agent.js');

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

describe('ui loop control', () => {
  beforeEach(() => {
    chatMock.mockReset();
    saveMessageHistoryMock.mockReset();
    chatMock.mockResolvedValue({
      content: 'Still working',
      toolCalls: [],
    });
  });

  it('adds one user prompt per loop iteration', async () => {
    const ctx = makeCtx();

    await runLoopImpl(ctx, 'Investigate the issue', 1);

    const userMessages = ctx.llmMessages.current.filter(msg => msg.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toEqual({ role: 'user', content: 'Investigate the issue' });
    expect(saveMessageHistoryMock).toHaveBeenCalledOnce();
  });

  it('reports when the completion promise was not reached', async () => {
    const ctx = makeCtx();

    await runLoopImpl(ctx, 'Finish the task', 1, 'DONE');

    expect(
      ctx.collectedMessages.some(message =>
        message.type === 'system' &&
        /without matching completion promise "DONE"/.test(message.content),
      ),
    ).toBe(true);
  });
});
