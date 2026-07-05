/**
 * Tests for /model and /models command loading state and error handling (#116).
 *
 * Verifies that:
 * - A loading message appears before the async fetch
 * - An error message is shown when getAvailableModels() throws
 * - An empty-result message is shown when 0 models are returned
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider, Mode } from '../src/types.js';
import type { CommandContext } from '../src/ui/commands.js';

// ---------------------------------------------------------------------------
// Mock heavy dependencies before importing the module under test
// ---------------------------------------------------------------------------

const mockGetAvailableModels = vi.fn();

vi.mock('../src/model-detection.js', () => ({
  getAvailableModels: (...args: unknown[]) => mockGetAvailableModels(...args),
  getModelContextLimit: vi.fn(() => 128000),
  getModelMaxOutput: vi.fn(() => 8192),
  clearModelCache: vi.fn(),
  preWarmModelCache: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn(),
  set: vi.fn(),
  getApiKey: vi.fn(),
  getBaseUrl: vi.fn(),
  getConfiguredProviders: vi.fn(() => []),
  isSetupComplete: vi.fn(() => true),
}));

vi.mock('../src/providers/index.js', () => ({
  chat: vi.fn(),
  selectProvider: (p: string) => p || 'anthropic',
  getAvailableProviders: vi.fn(() => ['anthropic', 'openai']),
}));

vi.mock('../src/types.js', () => ({
  getSystemPrompt: vi.fn(() => ''),
  DEFAULT_MODELS: { anthropic: 'claude-3-5-sonnet-20241022' },
  MODE_CONFIG: {
    plan: { icon: '📋', label: 'Plan', description: 'Plan mode' },
    hybrid: { icon: '🔄', label: 'Hybrid', description: 'Hybrid mode' },
    work: { icon: '🔧', label: 'Work', description: 'Work mode' },
  },
}));

// Mock all the other heavy imports commands.ts pulls in
vi.mock('../src/storage.js', () => ({ listSessions: vi.fn(() => []) }));
vi.mock('../src/mcp.js', () => ({ listServers: vi.fn(() => []) }));
vi.mock('../src/skills.js', () => ({
  listSkills: vi.fn(() => []),
  getSkillsContext: vi.fn(() => ''),
}));
vi.mock('../src/router.js', () => ({
  getModelRouterConfig: vi.fn(() => ({})),
  setModelRouterConfig: vi.fn(),
  isAutoRouteEnabled: vi.fn(() => false),
  smartRoute: vi.fn(),
  getDefaultSmartRoutingConfig: vi.fn(() => ({})),
  detectTaskType: vi.fn(() => 'general'),
}));
vi.mock('../src/summarization.js', () => ({ summarize: vi.fn() }));
vi.mock('../src/scope.js', () => ({
  addToScope: vi.fn(),
  removeFromScope: vi.fn(),
  getScopeSummary: vi.fn(() => ''),
  getScopeDetails: vi.fn(() => ''),
  resetScope: vi.fn(),
}));
vi.mock('../src/circuit-breaker.js', () => ({
  CircuitBreaker: vi.fn(),
}));
vi.mock('../src/hud/api.js', () => ({
  getCurrentSkin: vi.fn(() => 'clean'),
  getCurrentPalette: vi.fn(() => 'default'),
  applyPalette: vi.fn(),
}));
vi.mock('../src/terminal-image.js', () => ({
  getTerminalImageInfo: vi.fn(() => ({})),
  getImageModeLabel: vi.fn(() => ''),
  renderSkinBanner: vi.fn(),
  renderAsciiArt: vi.fn(),
  colorFg: vi.fn((c: string) => c),
  renderTransition: vi.fn(),
}));
vi.mock('../src/version-check.js', () => ({
  getVersion: vi.fn(() => '0.8.20'),
  getLatestVersion: vi.fn(),
  performUpgrade: vi.fn(),
}));
vi.mock('../src/ui/context.js', () => ({
  resetContextWarnings: vi.fn(),
}));
vi.mock('react', () => ({
  default: {},
  createRef: vi.fn(() => ({ current: null })),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { handleCommand } from '../src/ui/commands.js';
import * as config from '../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(provider: LLMProvider = 'anthropic'): CommandContext & { messages: Array<{ type: string; content: string }> } {
  const messages: Array<{ type: string; content: string }> = [];

  // Build a minimal CommandContext
  const ctx = {
    actualProvider: provider,
    actualModel: 'claude-3-5-sonnet-20241022',
    provider,
    model: undefined,
    mode: 'hybrid' as Mode,
    confirmMode: false,
    autoRoute: false,
    layout: 'classic',
    density: 'normal',
    collapseSettings: { tools: false, all: false },
    messages: [] as any[],
    stats: {} as any,
    loopActive: false,
    isProcessing: false,
    thinkingState: null,
    streamingResponse: '',
    queuedMessages: [],
    bookmarks: [],
    templates: [],
    debugEnabled: false,
    modalMode: '',
    smartRouteActive: false,
    ledger: undefined,

    setProvider: vi.fn(),
    setModel: vi.fn(),
    setMode: vi.fn(),
    setConfirmMode: vi.fn(),
    setAutoRoute: vi.fn(),
    setLayout: vi.fn(),
    setDensity: vi.fn(),
    setCollapseSettings: vi.fn(),
    setMessages: vi.fn(),
    setStats: vi.fn(),
    setModalMode: vi.fn(),
    setPendingComplexPrompt: vi.fn(),
    setAvailableModels: vi.fn(),
    setAvailableSessions: vi.fn(),
    setLatestVersion: vi.fn(),
    setLoopActive: vi.fn(),
    setLoopPrompt: vi.fn(),
    setLoopMaxIterations: vi.fn(),
    setLoopCompletionPromise: vi.fn(),
    setLoopIteration: vi.fn(),
    setIsProcessing: vi.fn(),
    setThinkingState: vi.fn(),
    setStreamingResponse: vi.fn(),
    setQueuedMessages: vi.fn(),
    setInput: vi.fn(),
    setBookmarks: vi.fn(),
    setTemplates: vi.fn(),
    setContextTokens: vi.fn(),
    setDebugEnabled: vi.fn(),
    setSmartRouteActive: vi.fn(),
    setBreakerHealth: vi.fn(),

    llmMessages: { current: [] } as any,
    undoStack: { current: [] } as any,
    redoStack: { current: [] } as any,
    loopCancelledRef: { current: false } as any,
    sessionRef: { current: null } as any,

    addMessage: (type: string, content: string) => { messages.push({ type, content }); },
    estimateContextTokens: vi.fn(() => 0),
    saveUndoState: vi.fn(),
    runAgent: vi.fn(),
    runLoop: vi.fn(),
    exit: vi.fn(),
  } as unknown as CommandContext & { messages: Array<{ type: string; content: string }> };

  (ctx as any)._collectedMessages = messages;
  return ctx;
}

function getMessages(ctx: ReturnType<typeof makeCtx>) {
  return (ctx as any)._collectedMessages as Array<{ type: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetAvailableModels.mockReset();
});

describe('/model command — loading state and error handling', () => {
  it('shows a loading message before the fetch', async () => {
    const ctx = makeCtx('openai');
    mockGetAvailableModels.mockResolvedValueOnce([{ id: 'gpt-4o', name: 'GPT-4o' }]);

    await handleCommand('/model', ctx);

    const msgs = getMessages(ctx);
    expect(msgs[0].type).toBe('system');
    expect(msgs[0].content).toMatch(/Fetching models for openai/);
  });

  it('shows provider-specific error message when fetch throws', async () => {
    const ctx = makeCtx('anthropic');
    mockGetAvailableModels.mockRejectedValueOnce(new Error('Unauthorized'));

    await handleCommand('/model', ctx);

    const msgs = getMessages(ctx);
    expect(msgs[0].type).toBe('system');
    expect(msgs[0].content).toMatch(/Fetching models for anthropic/);

    const errMsg = msgs.find(m => m.type === 'error');
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toMatch(/anthropic/);
    expect(errMsg!.content).toMatch(/Unauthorized/);
    expect(errMsg!.content).toMatch(/Check your API key/);
  });

  it('shows provider-specific empty result message when 0 models returned', async () => {
    const ctx = makeCtx('groq');
    mockGetAvailableModels.mockResolvedValueOnce([]);

    await handleCommand('/model', ctx);

    const msgs = getMessages(ctx);
    const errMsg = msgs.find(m => m.type === 'error');
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toMatch(/groq/);
    expect(errMsg!.content).toMatch(/API key may be invalid/);
  });
});

describe('/model list command — loading state and error handling', () => {
  it('shows a loading message before the fetch', async () => {
    const ctx = makeCtx('google');
    mockGetAvailableModels.mockResolvedValueOnce([{ id: 'gemini-pro', name: 'Gemini Pro' }]);

    await handleCommand('/model list', ctx);

    const msgs = getMessages(ctx);
    expect(msgs[0].type).toBe('system');
    expect(msgs[0].content).toMatch(/Fetching models for google/);
  });

  it('shows provider-specific error message when fetch throws', async () => {
    const ctx = makeCtx('openai');
    mockGetAvailableModels.mockRejectedValueOnce(new Error('Network timeout'));

    await handleCommand('/model list', ctx);

    const msgs = getMessages(ctx);
    const errMsg = msgs.find(m => m.type === 'error');
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toMatch(/openai/);
    expect(errMsg!.content).toMatch(/Network timeout/);
    expect(errMsg!.content).toMatch(/Check your API key/);
  });

  it('shows provider-specific empty result message when 0 models returned', async () => {
    const ctx = makeCtx('mistral');
    mockGetAvailableModels.mockResolvedValueOnce([]);

    await handleCommand('/model list', ctx);

    const msgs = getMessages(ctx);
    const errMsg = msgs.find(m => m.type === 'error');
    expect(errMsg).toBeDefined();
    expect(errMsg!.content).toMatch(/mistral/);
    expect(errMsg!.content).toMatch(/API key may be invalid/);
  });
});

describe('/loop command', () => {
  it('defaults to unlimited iterations when no max is provided', async () => {
    const ctx = makeCtx('openai');

    await handleCommand('/loop "keep going"', ctx);

    const msgs = getMessages(ctx);
    expect(ctx.setLoopMaxIterations).toHaveBeenCalledWith(Infinity);
    expect(ctx.runLoop).toHaveBeenCalledWith('keep going', Infinity, undefined);
    expect(msgs.at(-1)?.content).toMatch(/Max iterations: unlimited/i);
    expect(msgs.at(-1)?.content).toMatch(/Use \/loop stop/i);
  });

  it('treats --max-iterations 0 as unlimited', async () => {
    const ctx = makeCtx('openai');

    await handleCommand('/loop "keep going" --max-iterations 0', ctx);

    const msgs = getMessages(ctx);
    expect(ctx.setLoopMaxIterations).toHaveBeenCalledWith(Infinity);
    expect(ctx.runLoop).toHaveBeenCalledWith('keep going', Infinity, undefined);
    expect(msgs.at(-1)?.content).toMatch(/Max iterations: unlimited/i);
  });

  it('does not start a second loop while one is already active', async () => {
    const ctx = makeCtx('openai');
    ctx.loopActive = true;

    await handleCommand('/loop "keep going"', ctx);

    const msgs = getMessages(ctx);
    expect(ctx.runLoop).not.toHaveBeenCalled();
    expect(msgs.at(-1)?.content).toMatch(/Loop already running/i);
  });

  it('supports /loop stop as a loop cancellation', async () => {
    const ctx = makeCtx('openai');
    ctx.loopActive = true;

    await handleCommand('/loop stop', ctx);

    const msgs = getMessages(ctx);
    expect(ctx.loopCancelledRef.current).toBe(true);
    expect(ctx.setLoopActive).toHaveBeenCalledWith(false);
    expect(msgs.at(-1)?.content).toMatch(/Loop cancelled/i);
  });
});

describe('/config set — nested routing keys', () => {
  afterEach(() => {
    (config.get as any).mockReset();
    (config.set as any).mockReset();
  });

  it('enables smart routing via routing.enabled (defaults cost when unset)', async () => {
    const ctx = makeCtx('openai');
    (config.get as any).mockReturnValue(undefined);  // no stored routing yet

    await handleCommand('/config set routing.enabled true', ctx);

    expect(config.set).toHaveBeenCalledWith('routing', { enabled: true, costSensitivity: 0.3 });
    expect(getMessages(ctx).at(-1)?.content).toMatch(/routing\.enabled set to true/);
  });

  it('sets routing.costSensitivity while preserving enabled', async () => {
    const ctx = makeCtx('openai');
    (config.get as any).mockReturnValue({ enabled: true, costSensitivity: 0.3 });

    await handleCommand('/config set routing.costSensitivity 0.7', ctx);

    expect(config.set).toHaveBeenCalledWith('routing', { enabled: true, costSensitivity: 0.7 });
  });

  it('rejects an out-of-range routing.costSensitivity', async () => {
    const ctx = makeCtx('openai');
    (config.get as any).mockReturnValue(undefined);

    await handleCommand('/config set routing.costSensitivity 5', ctx);

    expect(config.set).not.toHaveBeenCalled();
    expect(getMessages(ctx).at(-1)?.content).toMatch(/between 0 and 1/);
  });
});
