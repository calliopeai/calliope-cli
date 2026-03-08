import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SubAgentTask, AgentEvent } from '../src/agents/types.js';

// ============================================================================
// Mock setup — must be before imports
// ============================================================================

const mockQuery = vi.fn();
const mockOpenaiAgent = vi.fn();
const mockOpenaiRun = vi.fn();
const mockGoogleAgent = vi.fn();
const mockGoogleRunner = vi.fn();

// Mock the three SDKs
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

vi.mock('@openai/agents', () => ({
  Agent: mockOpenaiAgent,
  run: mockOpenaiRun,
}));

vi.mock('@google/adk', () => ({
  Agent: mockGoogleAgent,
  Runner: mockGoogleRunner,
}));

// Mock config module
vi.mock('../src/config.js', () => ({
  get: vi.fn(),
  getApiKey: vi.fn(),
  getBaseUrl: vi.fn(),
}));

// ============================================================================
// Helper to collect async iterable events
// ============================================================================

async function collectEvents(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ============================================================================
// Helper to create a task
// ============================================================================

function makeTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    id: 'test-task-1234abcd',
    prompt: 'Write a hello world function',
    agent: 'claude',
    executor: 'claude-sdk',
    status: 'pending',
    priority: 'normal',
    depth: 0,
    childIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SDK Backend', () => {
  let sdkBackend: typeof import('../src/agents/sdk-backend.js');
  let configMock: typeof import('../src/config.js');

  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Set up default constructor behavior for OpenAI Agent
    mockOpenaiAgent.mockImplementation(function (this: Record<string, unknown>, cfg: Record<string, unknown>) {
      Object.assign(this, cfg);
    });

    // Set up default constructor behavior for Google Agent
    mockGoogleAgent.mockImplementation(function (this: Record<string, unknown>, cfg: Record<string, unknown>) {
      Object.assign(this, cfg);
    });

    // Set up default constructor behavior for Google Runner
    mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>, cfg: Record<string, unknown>) {
      Object.assign(this, cfg);
    });

    // Re-import after reset so cached availability flags are cleared
    sdkBackend = await import('../src/agents/sdk-backend.js');
    configMock = await import('../src/config.js');
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  // ============================================================================
  // SDK Availability Detection
  // ============================================================================

  describe('isClaudeSdkAvailable', () => {
    it('should return true when SDK is importable', async () => {
      const result = await sdkBackend.isClaudeSdkAvailable();
      expect(result).toBe(true);
    });

    it('should cache the result on subsequent calls', async () => {
      const first = await sdkBackend.isClaudeSdkAvailable();
      const second = await sdkBackend.isClaudeSdkAvailable();
      expect(first).toBe(second);
    });
  });

  describe('isOpenaiSdkAvailable', () => {
    it('should return true when SDK is importable', async () => {
      const result = await sdkBackend.isOpenaiSdkAvailable();
      expect(result).toBe(true);
    });

    it('should cache the result on subsequent calls', async () => {
      const first = await sdkBackend.isOpenaiSdkAvailable();
      const second = await sdkBackend.isOpenaiSdkAvailable();
      expect(first).toBe(second);
    });
  });

  describe('isGoogleAdkAvailable', () => {
    it('should return true when SDK is importable', async () => {
      const result = await sdkBackend.isGoogleAdkAvailable();
      expect(result).toBe(true);
    });

    it('should cache the result on subsequent calls', async () => {
      const first = await sdkBackend.isGoogleAdkAvailable();
      const second = await sdkBackend.isGoogleAdkAvailable();
      expect(first).toBe(second);
    });
  });

  // ============================================================================
  // getAvailableExecutors
  // ============================================================================

  describe('getAvailableExecutors', () => {
    it('should always include cli', async () => {
      const executors = await sdkBackend.getAvailableExecutors();
      expect(executors).toContain('cli');
    });

    it('should include all available SDKs when mocked as available', async () => {
      const executors = await sdkBackend.getAvailableExecutors();
      expect(executors).toContain('cli');
      expect(executors).toContain('claude-sdk');
      expect(executors).toContain('openai-sdk');
      expect(executors).toContain('google-adk');
    });
  });

  // ============================================================================
  // executeClaudeSdk
  // ============================================================================

  describe('executeClaudeSdk', () => {
    it('should emit start event first', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[0].taskId).toBe('test-task-1234abcd');
      expect(events[0].message).toContain('Claude SDK executor');
    });

    it('should emit text + complete on successful query', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue(
        (async function* () {
          yield { type: 'text', content: 'Hello ' };
          yield { type: 'assistant', text: 'World' };
          yield { type: 'result', result: '!' };
        })()
      );

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('Hello World!');
      expect(events[2].type).toBe('complete');
    });

    it('should error when no API key available', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue(undefined);
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('error');
      expect(events[1].code).toBe('SDK_ERROR');
      expect(events[1].message).toContain('No API key');
    });

    it('should use default model when not specified', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk', model: undefined });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'claude-sonnet-4-20250514',
          }),
        })
      );
    });

    it('should use specified model', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk', model: 'claude-opus-4-20250514' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            model: 'claude-opus-4-20250514',
          }),
        })
      );
    });

    it('should include systemPrompt in query options when provided', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({
        executor: 'claude-sdk',
        systemPrompt: 'You are a code reviewer',
      });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            systemPrompt: 'You are a code reviewer',
          }),
        })
      );
    });

    it('should set ANTHROPIC_API_KEY env var for anthropic provider', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      let capturedEnv: string | undefined;
      mockQuery.mockImplementation(() => {
        capturedEnv = process.env.ANTHROPIC_API_KEY;
        return (async function* () {})();
      });

      const task = makeTask({ executor: 'claude-sdk', provider: 'anthropic' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(capturedEnv).toBe('sk-test-key');
    });

    it('should set ANTHROPIC_BEDROCK_BASE_URL for bedrock provider', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('bedrock-key');
      vi.mocked(configMock.get).mockReturnValue('bedrock' as never);
      vi.mocked(configMock.getBaseUrl).mockReturnValue('https://bedrock.us-east-1.amazonaws.com');

      let capturedEnv: string | undefined;
      mockQuery.mockImplementation(() => {
        capturedEnv = process.env.ANTHROPIC_BEDROCK_BASE_URL;
        return (async function* () {})();
      });

      const task = makeTask({ executor: 'claude-sdk', provider: 'bedrock' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(capturedEnv).toBe('https://bedrock.us-east-1.amazonaws.com');
    });

    it('should restore env vars after execution', async () => {
      const prevKey = process.env.ANTHROPIC_API_KEY;
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-temp-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk', provider: 'anthropic' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(process.env.ANTHROPIC_API_KEY).toBe(prevKey);
    });

    it('should restore env vars even on error', async () => {
      process.env.ANTHROPIC_API_KEY = 'original-key';
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-temp-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockImplementation(() => {
        throw new Error('SDK crash');
      });

      const task = makeTask({ executor: 'claude-sdk', provider: 'anthropic' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(process.env.ANTHROPIC_API_KEY).toBe('original-key');
    });

    it('should emit error event on SDK exception', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockImplementation(() => {
        throw new Error('Connection refused');
      });

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('error');
      expect(events[1].code).toBe('SDK_ERROR');
      expect(events[1].message).toContain('Connection refused');
    });

    it('should not emit text event when output is empty', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('complete');
    });

    it('should handle message type with content field', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue(
        (async function* () {
          yield { type: 'result', content: 'Final result' };
        })()
      );

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('Final result');
    });

    it('should skip unknown message types', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test-key');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue(
        (async function* () {
          yield { type: 'tool_use', name: 'bash' };
          yield { type: 'text', content: 'output' };
        })()
      );

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[1].content).toBe('output');
    });

    it('should use auto provider same as anthropic', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-auto-key');
      vi.mocked(configMock.get).mockReturnValue('auto' as never);

      let capturedEnv: string | undefined;
      mockQuery.mockImplementation(() => {
        capturedEnv = process.env.ANTHROPIC_API_KEY;
        return (async function* () {})();
      });

      const task = makeTask({ executor: 'claude-sdk', provider: 'auto' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(capturedEnv).toBe('sk-auto-key');
    });

    it('should include model name in start message', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk', model: 'claude-opus-4-20250514' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[0].message).toContain('claude-opus-4-20250514');
    });
  });

  // ============================================================================
  // executeOpenaiSdk
  // ============================================================================

  describe('executeOpenaiSdk', () => {
    it('should emit start event first', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValue({ finalOutput: 'result' });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[0].message).toContain('OpenAI Agents executor');
    });

    it('should emit text + complete on successful run with finalOutput', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      // Streaming attempt fails, falls back to non-streaming with finalOutput
      mockOpenaiRun
        .mockRejectedValueOnce(new Error('Streaming not supported'))
        .mockResolvedValueOnce({ finalOutput: 'The final answer' });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('The final answer');
      expect(events[2].type).toBe('complete');
    });

    it('should handle streaming via toTextStream', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({
        toTextStream: () =>
          (async function* () {
            yield 'chunk1';
            yield 'chunk2';
          })(),
      });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('chunk1chunk2');
    });

    it('should handle result with output field', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ output: 'output-content' });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('output-content');
    });

    it('should error when no API key for non-ollama provider', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue(undefined);
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      const task = makeTask({ executor: 'openai-sdk', provider: 'openai' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('error');
      expect(events[1].code).toBe('SDK_ERROR');
      expect(events[1].message).toContain('No API key');
    });

    it('should allow no API key for ollama provider', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue(undefined);
      vi.mocked(configMock.get).mockReturnValue('ollama' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'local result' });

      const task = makeTask({ executor: 'openai-sdk', provider: 'ollama' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      // Should not error
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(0);
      expect(events[1].type).toBe('text');
    });

    it('should use gpt-4o as default model', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'ok' });

      const task = makeTask({ executor: 'openai-sdk', model: undefined });
      await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(mockOpenaiAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o' })
      );
    });

    it('should use specified model', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'ok' });

      const task = makeTask({ executor: 'openai-sdk', model: 'gpt-4-turbo' });
      await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(mockOpenaiAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4-turbo' })
      );
    });

    it('should configure modelSettings for non-default providers', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-groq-key');
      vi.mocked(configMock.get).mockReturnValue('groq' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'fast' });

      const task = makeTask({ executor: 'openai-sdk', provider: 'groq' });
      await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(mockOpenaiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          modelSettings: expect.objectContaining({
            apiKey: 'sk-groq-key',
          }),
        })
      );
    });

    it('should include systemPrompt as instructions', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'ok' });

      const task = makeTask({
        executor: 'openai-sdk',
        systemPrompt: 'Custom instructions here',
      });
      await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(mockOpenaiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: 'Custom instructions here',
        })
      );
    });

    it('should emit error event on SDK exception', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiAgent.mockImplementation(() => {
        throw new Error('Agent construction failed');
      });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('error');
      expect(events[1].message).toContain('Agent construction failed');
    });

    it('should not emit text event when output is empty', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: '' });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('complete');
    });

    it('should handle non-Error exceptions', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai-key');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiAgent.mockImplementation(() => {
        throw 'string error';
      });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events[1].type).toBe('error');
      expect(events[1].message).toContain('string error');
    });
  });

  // ============================================================================
  // executeGoogleAdk
  // ============================================================================

  describe('executeGoogleAdk', () => {
    it('should emit start event first', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ output: 'result' });
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[0].message).toContain('Google ADK executor');
    });

    it('should emit text + complete on successful run', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ output: 'Google result' });
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('Google result');
      expect(events[2].type).toBe('complete');
    });

    it('should error when no API key available', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue(undefined);
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('error');
      expect(events[1].code).toBe('SDK_ERROR');
      expect(events[1].message).toContain('No API key');
    });

    it('should set GOOGLE_API_KEY env var', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key-123');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      let capturedEnv: string | undefined;
      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockImplementation(async () => {
          capturedEnv = process.env.GOOGLE_API_KEY;
          return { output: 'ok' };
        });
      });

      const task = makeTask({ executor: 'google-adk' });
      await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(capturedEnv).toBe('google-key-123');
    });

    it('should restore GOOGLE_API_KEY after execution', async () => {
      process.env.GOOGLE_API_KEY = 'original-google-key';
      vi.mocked(configMock.getApiKey).mockReturnValue('temp-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ output: 'ok' });
      });

      const task = makeTask({ executor: 'google-adk' });
      await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(process.env.GOOGLE_API_KEY).toBe('original-google-key');
    });

    it('should restore env vars even on error', async () => {
      process.env.GOOGLE_API_KEY = 'original-google-key';
      vi.mocked(configMock.getApiKey).mockReturnValue('temp-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleAgent.mockImplementation(() => {
        throw new Error('ADK crash');
      });

      const task = makeTask({ executor: 'google-adk' });
      await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(process.env.GOOGLE_API_KEY).toBe('original-google-key');
    });

    it('should use gemini-2.0-flash as default model', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ output: 'ok' });
      });

      const task = makeTask({ executor: 'google-adk', model: undefined });
      await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(mockGoogleAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-2.0-flash' })
      );
    });

    it('should use specified model', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ output: 'ok' });
      });

      const task = makeTask({ executor: 'google-adk', model: 'gemini-1.5-pro' });
      await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(mockGoogleAgent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-1.5-pro' })
      );
    });

    it('should fallback to agent.generate when runner.run is not a function', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleAgent.mockImplementation(function (this: Record<string, unknown>) {
        this.generate = vi.fn().mockResolvedValue({ text: 'generated text' });
      });
      mockGoogleRunner.mockImplementation(function () {
        // no run method
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('generated text');
    });

    it('should error when neither runner.run nor agent.generate are available', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleAgent.mockImplementation(function () {
        // no generate method
      });
      mockGoogleRunner.mockImplementation(function () {
        // no run method
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events[1].type).toBe('error');
      expect(events[1].message).toContain('could not find run() or generate()');
    });

    it('should not emit text event when output is empty', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ output: '' });
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('complete');
    });

    it('should emit error event on SDK exception', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleAgent.mockImplementation(() => {
        throw new Error('ADK init failed');
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('error');
      expect(events[1].message).toContain('ADK init failed');
    });
  });

  // ============================================================================
  // executeSdkAgent (dispatcher)
  // ============================================================================

  describe('executeSdkAgent', () => {
    it('should dispatch to Claude SDK executor', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue(
        (async function* () {
          yield { type: 'text', content: 'claude output' };
        })()
      );

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeSdkAgent(task, '/tmp'));

      expect(events[0].type).toBe('start');
      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('claude output');
      expect(events[2].type).toBe('complete');
    });

    it('should dispatch to OpenAI SDK executor', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'openai output' });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeSdkAgent(task, '/tmp'));

      const textEvent = events.find((e) => e.type === 'text');
      expect(textEvent?.content).toBe('openai output');
    });

    it('should dispatch to Google ADK executor', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ output: 'adk output' });
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeSdkAgent(task, '/tmp'));

      const textEvent = events.find((e) => e.type === 'text');
      expect(textEvent?.content).toBe('adk output');
    });

    it('should emit INVALID_EXECUTOR error for unknown executor', async () => {
      const task = makeTask({ executor: 'unknown-executor' as SubAgentTask['executor'] });
      const events = await collectEvents(sdkBackend.executeSdkAgent(task, '/tmp'));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(events[0].code).toBe('INVALID_EXECUTOR');
      expect(events[0].message).toContain('Unknown executor: unknown-executor');
    });

    it('should have correct taskId on all events', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue(
        (async function* () {
          yield { type: 'text', content: 'x' };
        })()
      );

      const task = makeTask({ executor: 'claude-sdk', id: 'my-unique-id' });
      const events = await collectEvents(sdkBackend.executeSdkAgent(task, '/tmp'));

      for (const event of events) {
        expect(event.taskId).toBe('my-unique-id');
      }
    });

    it('should have timestamp on all events', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeSdkAgent(task, '/tmp'));

      for (const event of events) {
        expect(event.timestamp).toBeInstanceOf(Date);
      }
    });
  });

  // ============================================================================
  // Edge cases and integration
  // ============================================================================

  describe('edge cases', () => {
    it('should handle non-Error thrown in Claude SDK', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockImplementation(() => {
        throw 42;
      });

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[1].type).toBe('error');
      expect(events[1].message).toContain('42');
    });

    it('should concatenate multiple text/assistant/result messages', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue(
        (async function* () {
          yield { type: 'text', content: 'A' };
          yield { type: 'assistant', content: 'B' };
          yield { type: 'result', text: 'C' };
          yield { type: 'text', text: 'D' };
        })()
      );

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[1].content).toBe('ABCD');
    });

    it('should handle messages with empty content gracefully', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue(
        (async function* () {
          yield { type: 'text', content: '' };
          yield { type: 'text', content: 'real content' };
        })()
      );

      const task = makeTask({ executor: 'claude-sdk' });
      const events = await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('real content');
    });

    it('should handle OpenAI fallback from streaming to non-streaming with output field', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      // First call (streaming) fails, second call returns output field
      mockOpenaiRun
        .mockRejectedValueOnce(new Error('stream fail'))
        .mockResolvedValueOnce({ output: 'fallback output' });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('fallback output');
    });

    it('should use default instructions when systemPrompt not provided for OpenAI', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'ok' });

      const task = makeTask({ executor: 'openai-sdk', systemPrompt: undefined });
      await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(mockOpenaiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: expect.stringContaining('sub-agent'),
        })
      );
    });

    it('should use task ID prefix in agent name for OpenAI', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'ok' });

      const task = makeTask({ executor: 'openai-sdk', id: 'abcdefgh-1234' });
      await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      expect(mockOpenaiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'calliope-subagent-abcdefgh',
        })
      );
    });

    it('should use task ID prefix in agent name for Google ADK', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ output: 'ok' });
      });

      const task = makeTask({ executor: 'google-adk', id: 'abcdefgh-5678' });
      await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(mockGoogleAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'calliope-subagent-abcdefgh',
        })
      );
    });

    it('should pass appName to Runner for Google ADK', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      const runnerRunMock = vi.fn().mockResolvedValue({ output: 'ok' });
      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>, cfg: Record<string, unknown>) {
        Object.assign(this, cfg);
        this.run = runnerRunMock;
      });

      const task = makeTask({ executor: 'google-adk' });
      await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(mockGoogleRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          appName: 'calliope-subagent',
        })
      );
    });

    it('should handle result with text field from Google ADK runner', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ text: 'text-result' });
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('text-result');
    });

    it('should handle result with content field from Google ADK runner', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('google-key');
      vi.mocked(configMock.get).mockReturnValue('google' as never);

      mockGoogleRunner.mockImplementation(function (this: Record<string, unknown>) {
        this.run = vi.fn().mockResolvedValue({ content: 'content-result' });
      });

      const task = makeTask({ executor: 'google-adk' });
      const events = await collectEvents(sdkBackend.executeGoogleAdk(task, '/tmp'));

      expect(events[1].type).toBe('text');
      expect(events[1].content).toBe('content-result');
    });

    it('should handle result with finalOutput from OpenAI run (non-streaming path)', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      // First streaming call returns result without toTextStream or finalOutput
      mockOpenaiRun.mockResolvedValueOnce({ someOtherField: 'value' });

      const task = makeTask({ executor: 'openai-sdk' });
      const events = await collectEvents(sdkBackend.executeOpenaiSdk(task, '/tmp'));

      // Should still complete (with empty output)
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
    });

    it('should pass cwd to query options for Claude SDK', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/my/project'));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            cwd: '/my/project',
          }),
        })
      );
    });

    it('should pass prompt to query for Claude SDK', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk', prompt: 'Build a REST API' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Build a REST API',
        })
      );
    });

    it('should set bypassPermissions in Claude SDK query', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-test');
      vi.mocked(configMock.get).mockReturnValue('anthropic' as never);

      mockQuery.mockReturnValue((async function* () {})());

      const task = makeTask({ executor: 'claude-sdk' });
      await collectEvents(sdkBackend.executeClaudeSdk(task, '/tmp'));

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            permissionMode: 'bypassPermissions',
            maxTurns: 50,
          }),
        })
      );
    });

    it('should include cwd in default instructions for OpenAI', async () => {
      vi.mocked(configMock.getApiKey).mockReturnValue('sk-openai');
      vi.mocked(configMock.get).mockReturnValue('openai' as never);

      mockOpenaiRun.mockResolvedValueOnce({ finalOutput: 'ok' });

      const task = makeTask({ executor: 'openai-sdk', systemPrompt: undefined });
      await collectEvents(sdkBackend.executeOpenaiSdk(task, '/my/work'));

      expect(mockOpenaiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: expect.stringContaining('/my/work'),
        })
      );
    });
  });
});
