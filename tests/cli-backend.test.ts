import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { SubAgentTask, AgentEvent } from '../src/agents/types.js';

// ============================================================================
// Mock child_process — track spawn calls via shared state
// ============================================================================

const spawnCalls: Array<{ command: string; args: string[]; options: any }> = [];
let spawnReturnValue: any = null;

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => {
    spawnCalls.push({ command: args[0], args: args[1], options: args[2] });
    return spawnReturnValue;
  },
  execFileSync: vi.fn(),
}));

// Mock agent-detection
vi.mock('../src/agents/agent-detection.js', () => ({
  getAgentCLI: vi.fn((agent: string) => {
    const map: Record<string, { command: string; args: string[] }> = {
      claude: { command: 'claude', args: ['--print'] },
      calliope: { command: 'calliope', args: ['--headless', '--god-mode'] },
      gemini: { command: 'gemini', args: [] },
      codex: { command: 'codex', args: [] },
    };
    return map[agent] || { command: agent, args: [] };
  }),
  detectAgents: vi.fn(() => []),
  isAgentAvailable: vi.fn(() => true),
  getAvailableAgents: vi.fn(() => ['claude', 'gemini', 'codex', 'calliope']),
  getAgentEnvVar: vi.fn(() => 'ANTHROPIC_API_KEY'),
  getAgentStatusReport: vi.fn(() => ''),
}));

// Import after mocks
import {
  executeAgent,
  cancelTask,
  getTaskOutput,
  isTaskRunning,
  getRunningTaskCount,
  killAllTasks,
} from '../src/agents/cli-backend.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();
  (proc as any).stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  (proc as any).kill = vi.fn();
  (proc as any).pid = 12345;
  return proc;
}

function makeTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    prompt: 'Write hello world',
    agent: 'claude',
    executor: 'cli',
    status: 'pending',
    priority: 'normal',
    depth: 0,
    childIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Advance the generator past the start event AND into the while-loop
 * (which sets up the spawn, listeners, etc.)
 * Returns the start event.
 *
 * The key insight: the generator yields 'start' BEFORE calling spawn.
 * After the first iter.next() returns start, the generator is paused at yield.
 * Calling iter.next() a second time resumes it, calls spawn, sets up listeners,
 * and enters the while-await loop. We need to start that second next() call
 * without blocking on it (since it awaits internally), then interact with the mock process.
 *
 * This helper starts the second next() and gives the event loop a tick
 * so the generator can reach the await point.
 */
async function startAndSetup(
  iter: AsyncIterator<AgentEvent>,
): Promise<AgentEvent> {
  // First call: get the start event
  const { value: startEvent } = await iter.next();
  // We need to kick the generator forward past spawn() and into the while-await.
  // We do this by scheduling the second next() call but not awaiting it yet.
  // Instead, we'll let tests interact with the mock process and then await.
  return startEvent;
}

/**
 * Read the next event from the generator. The generator should already
 * be in its while-loop awaiting. We emit something (data/close/error)
 * first, then the next() resolves.
 *
 * Usage:
 *   const event = await nextEvent(iter, () => proc.stdout.emit('data', ...))
 */
async function nextEvent(
  iter: AsyncIterator<AgentEvent>,
  emitFn: () => void,
): Promise<AgentEvent> {
  // Start the next() call — it will enter the while-loop and await
  const promise = iter.next();
  // Give the event loop a tick so the generator reaches the await
  await new Promise(r => setTimeout(r, 0));
  // Now emit the event
  emitFn();
  const { value } = await promise;
  return value;
}

/**
 * Kick the generator into its while-loop. Returns a function to get events.
 */
async function setupGenerator(
  task: SubAgentTask,
  cwd: string,
  timeout?: number,
): Promise<{
  startEvent: AgentEvent;
  iter: AsyncIterator<AgentEvent>;
  proc: ReturnType<typeof createMockProcess>;
}> {
  const proc = createMockProcess();
  spawnReturnValue = proc;

  const gen = executeAgent(task, cwd, timeout);
  const iter = gen[Symbol.asyncIterator]();

  // Get start event
  const { value: startEvent } = await iter.next();

  return { startEvent, iter, proc };
}

// ============================================================================
// Tests
// ============================================================================

describe('cli-backend', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    spawnCalls.length = 0;
    process.env = { ...savedEnv };
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  });

  afterEach(() => {
    killAllTasks();
    process.env = savedEnv;
  });

  // --------------------------------------------------------------------------
  // executeAgent — start event
  // --------------------------------------------------------------------------

  describe('executeAgent - start event', () => {
    it('should emit a start event first', async () => {
      const task = makeTask();
      const { startEvent, iter, proc } = await setupGenerator(task, '/tmp');

      expect(startEvent).toMatchObject({
        type: 'start',
        taskId: task.id,
      });
      expect(startEvent.timestamp).toBeInstanceOf(Date);

      // Clean up
      const ev = await nextEvent(iter, () => proc.emit('close', 0));
      expect(ev.type).toBe('complete');
    });
  });

  // --------------------------------------------------------------------------
  // executeAgent — process spawning
  // --------------------------------------------------------------------------

  describe('executeAgent - process spawning', () => {
    it('should spawn claude with prompt as argument', async () => {
      const task = makeTask({ agent: 'claude', prompt: 'test prompt' });
      const { iter, proc } = await setupGenerator(task, '/work');

      // spawn is called during the second next() setup
      // But we need to trigger the second next() to get spawn called
      const ev = await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].command).toBe('claude');
      expect(spawnCalls[0].args).toEqual(['--print', 'test prompt']);
      expect(spawnCalls[0].options.cwd).toBe('/work');
      expect(spawnCalls[0].options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    });

    it('should spawn calliope with prompt as argument', async () => {
      const task = makeTask({ agent: 'calliope', prompt: 'do stuff' });
      const { iter, proc } = await setupGenerator(task, '/work');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].command).toBe('calliope');
      expect(spawnCalls[0].args).toEqual(['--headless', '--god-mode', 'do stuff']);
    });

    it('should write prompt to stdin for gemini', async () => {
      const task = makeTask({ agent: 'gemini', prompt: 'hello gemini' });
      const { iter, proc } = await setupGenerator(task, '/work');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].command).toBe('gemini');
      expect(spawnCalls[0].args).toEqual([]);
      expect(proc.stdin!.write).toHaveBeenCalledWith('hello gemini\n');
      expect(proc.stdin!.end).toHaveBeenCalled();
    });

    it('should write prompt to stdin for codex', async () => {
      const task = makeTask({ agent: 'codex', prompt: 'hello codex' });
      const { iter, proc } = await setupGenerator(task, '/work');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(proc.stdin!.write).toHaveBeenCalledWith('hello codex\n');
      expect(proc.stdin!.end).toHaveBeenCalled();
    });

    it('should NOT write to stdin for claude', async () => {
      const task = makeTask({ agent: 'claude', prompt: 'test' });
      const { iter, proc } = await setupGenerator(task, '/work');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(proc.stdin!.write).not.toHaveBeenCalled();
      expect(proc.stdin!.end).not.toHaveBeenCalled();
    });

    it('should NOT write to stdin for calliope', async () => {
      const task = makeTask({ agent: 'calliope', prompt: 'test' });
      const { iter, proc } = await setupGenerator(task, '/work');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(proc.stdin!.write).not.toHaveBeenCalled();
      expect(proc.stdin!.end).not.toHaveBeenCalled();
    });

    it('should prepend system prompt when provided', async () => {
      const task = makeTask({
        agent: 'claude',
        prompt: 'do task',
        systemPrompt: 'You are helpful.',
      });
      const { iter, proc } = await setupGenerator(task, '/work');

      await nextEvent(iter, () => proc.emit('close', 0));

      const expectedPrompt = '[Agent Instructions]\nYou are helpful.\n---\ndo task';
      expect(spawnCalls[0].args).toEqual(['--print', expectedPrompt]);
    });

    it('should write system prompt via stdin for gemini', async () => {
      const task = makeTask({
        agent: 'gemini',
        prompt: 'do task',
        systemPrompt: 'Be concise.',
      });
      const { iter, proc } = await setupGenerator(task, '/work');

      await nextEvent(iter, () => proc.emit('close', 0));

      const expectedPrompt = '[Agent Instructions]\nBe concise.\n---\ndo task';
      expect(proc.stdin!.write).toHaveBeenCalledWith(expectedPrompt + '\n');
    });

    it('should not prepend system prompt when not provided', async () => {
      const task = makeTask({ agent: 'claude', prompt: 'just a prompt' });
      const { iter, proc } = await setupGenerator(task, '/work');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].args).toEqual(['--print', 'just a prompt']);
    });
  });

  // --------------------------------------------------------------------------
  // executeAgent — stdout/stderr
  // --------------------------------------------------------------------------

  describe('executeAgent - stdout/stderr capture', () => {
    it('should emit text events for stdout data', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const ev1 = await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('Hello ')));
      expect(ev1).toMatchObject({
        type: 'text',
        taskId: task.id,
        content: 'Hello ',
      });

      const ev2 = await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('World')));
      expect(ev2).toMatchObject({ type: 'text', content: 'World' });

      await nextEvent(iter, () => proc.emit('close', 0));
    });

    it('should emit text events for stderr data', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const ev = await nextEvent(iter, () =>
        proc.stderr!.emit('data', Buffer.from('warning: something')));
      expect(ev).toMatchObject({
        type: 'text',
        taskId: task.id,
        content: 'warning: something',
      });

      await nextEvent(iter, () => proc.emit('close', 0));
    });

    it('should accumulate output in running task state', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('part1')));
      await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('part2')));

      expect(getTaskOutput(task.id)).toBe('part1part2');

      await nextEvent(iter, () => proc.emit('close', 0));
    });

    it('should truncate output exceeding 100K chars', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const bigChunk = 'x'.repeat(100_001);
      await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from(bigChunk)));

      const output = getTaskOutput(task.id);
      expect(output).toBeDefined();
      expect(output!.length).toBeLessThanOrEqual(100_000 + 100);
      expect(output).toContain('[Sub-agent output truncated at 100K chars]');

      await nextEvent(iter, () => proc.emit('close', 0));
    });

    it('should not accumulate further output after truncation', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const bigChunk = 'x'.repeat(100_001);
      await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from(bigChunk)));

      const outputAfterFirst = getTaskOutput(task.id);

      await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('more data')));

      expect(getTaskOutput(task.id)).toBe(outputAfterFirst);

      await nextEvent(iter, () => proc.emit('close', 0));
    });

    it('should accumulate stderr in output', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      await nextEvent(iter, () =>
        proc.stderr!.emit('data', Buffer.from('err-info')));

      expect(getTaskOutput(task.id)).toBe('err-info');

      await nextEvent(iter, () => proc.emit('close', 0));
    });

    it('should interleave stdout and stderr', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const e1 = await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('out1')));
      expect(e1.content).toBe('out1');

      const e2 = await nextEvent(iter, () =>
        proc.stderr!.emit('data', Buffer.from('err1')));
      expect(e2.content).toBe('err1');

      const e3 = await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('out2')));
      expect(e3.content).toBe('out2');

      expect(getTaskOutput(task.id)).toBe('out1err1out2');

      await nextEvent(iter, () => proc.emit('close', 0));
    });

    it('should handle multiple stdout chunks', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      for (let i = 0; i < 5; i++) {
        await nextEvent(iter, () =>
          proc.stdout!.emit('data', Buffer.from(`chunk${i}`)));
      }

      expect(getTaskOutput(task.id)).toBe('chunk0chunk1chunk2chunk3chunk4');

      await nextEvent(iter, () => proc.emit('close', 0));
    });
  });

  // --------------------------------------------------------------------------
  // executeAgent — exit code handling
  // --------------------------------------------------------------------------

  describe('executeAgent - exit code handling', () => {
    it('should emit complete event on exit code 0', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const ev = await nextEvent(iter, () => proc.emit('close', 0));
      expect(ev).toMatchObject({
        type: 'complete',
        taskId: task.id,
      });
    });

    it('should emit error event on exit code 1', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const ev = await nextEvent(iter, () => proc.emit('close', 1));
      expect(ev).toMatchObject({
        type: 'error',
        taskId: task.id,
        code: 'EXIT_ERROR',
        message: 'Process exited with code 1',
      });
    });

    it('should emit error with exit code 127', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const ev = await nextEvent(iter, () => proc.emit('close', 127));
      expect(ev).toMatchObject({
        type: 'error',
        code: 'EXIT_ERROR',
        message: 'Process exited with code 127',
      });
    });

    it('should clean up running task on exit', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      // Kick into while loop so spawn + runningTasks.set happens
      const nextPromise = iter.next();
      await new Promise(r => setTimeout(r, 0));

      // Task is running before close
      expect(isTaskRunning(task.id)).toBe(true);

      proc.emit('close', 0);
      await nextPromise;

      expect(isTaskRunning(task.id)).toBe(false);
    });

    it('should handle null exit code (killed by signal)', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const ev = await nextEvent(iter, () => proc.emit('close', null));
      expect(ev.type).toBe('error');
      expect(ev.code).toBe('EXIT_ERROR');
      expect(ev.message).toBe('Process exited with code null');
    });

    it('should yield start, text, then complete in order', async () => {
      const task = makeTask();
      const { startEvent, iter, proc } = await setupGenerator(task, '/tmp');

      expect(startEvent.type).toBe('start');

      const text = await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('result')));
      expect(text.type).toBe('text');
      expect(text.content).toBe('result');

      const complete = await nextEvent(iter, () => proc.emit('close', 0));
      expect(complete.type).toBe('complete');

      const { done } = await iter.next();
      expect(done).toBe(true);
    });

    it('should yield start, text, then error for non-zero exit', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('partial')));

      const errEv = await nextEvent(iter, () => proc.emit('close', 2));
      expect(errEv.type).toBe('error');
      expect(errEv.code).toBe('EXIT_ERROR');
    });
  });

  // --------------------------------------------------------------------------
  // executeAgent — spawn errors
  // --------------------------------------------------------------------------

  describe('executeAgent - spawn errors', () => {
    it('should emit SPAWN_ERROR when process fails', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const ev = await nextEvent(iter, () =>
        proc.emit('error', new Error('spawn ENOENT')));
      expect(ev).toMatchObject({
        type: 'error',
        taskId: task.id,
        code: 'SPAWN_ERROR',
        message: 'spawn ENOENT',
      });
    });

    it('should clean up running task on spawn error', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      // Kick into while loop so spawn + runningTasks.set happens
      const nextPromise = iter.next();
      await new Promise(r => setTimeout(r, 0));

      expect(isTaskRunning(task.id)).toBe(true);

      proc.emit('error', new Error('EACCES'));
      const { value: ev } = await nextPromise;

      expect(isTaskRunning(task.id)).toBe(false);
    });

    it('should include error message from spawn failure', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      const ev = await nextEvent(iter, () =>
        proc.emit('error', new Error('Permission denied')));
      expect(ev.message).toBe('Permission denied');
    });
  });

  // --------------------------------------------------------------------------
  // executeAgent — timeout
  // --------------------------------------------------------------------------

  describe('executeAgent - timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should kill process and emit TIMEOUT error', async () => {
      const proc = createMockProcess();
      spawnReturnValue = proc;

      const task = makeTask();
      const gen = executeAgent(task, '/tmp', 5000);
      const iter = gen[Symbol.asyncIterator]();

      // Get start event
      const { value: startEvent } = await iter.next();
      expect(startEvent.type).toBe('start');

      // Start the second next() to enter the while-loop
      const nextPromise = iter.next();
      // Let the generator reach the await point
      await vi.advanceTimersByTimeAsync(0);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(5001);

      const { value: ev } = await nextPromise;
      expect(ev).toMatchObject({
        type: 'error',
        taskId: task.id,
        code: 'TIMEOUT',
        message: 'Task timed out after 5000ms',
      });

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should not timeout if process completes in time', async () => {
      const proc = createMockProcess();
      spawnReturnValue = proc;

      const task = makeTask();
      const gen = executeAgent(task, '/tmp', 10000);
      const iter = gen[Symbol.asyncIterator]();

      await iter.next(); // start

      // Start second next, let it reach await
      const nextPromise = iter.next();
      await vi.advanceTimersByTimeAsync(0);

      // Close the process before timeout
      proc.emit('close', 0);
      const { value: ev } = await nextPromise;
      expect(ev.type).toBe('complete');

      // Advance past timeout — should not cause issues
      await vi.advanceTimersByTimeAsync(11000);

      const result = await iter.next();
      expect(result.done).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // executeAgent — environment variables
  // --------------------------------------------------------------------------

  describe('executeAgent - environment variables', () => {
    it('should include safe system vars', async () => {
      process.env.PATH = '/usr/local/bin';
      process.env.HOME = '/home/user';
      process.env.LANG = 'en_US.UTF-8';

      const task = makeTask({ agent: 'claude' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      // Trigger spawn by advancing
      await nextEvent(iter, () => proc.emit('close', 0));

      const env = spawnCalls[0].options.env;
      expect(env.PATH).toBe('/usr/local/bin');
      expect(env.HOME).toBe('/home/user');
      expect(env.LANG).toBe('en_US.UTF-8');
      expect(env.TERM).toBe('xterm-256color');
      expect(env.COLORTERM).toBe('truecolor');
    });

    it('should include agent-specific API key for claude', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-key123';

      const task = makeTask({ agent: 'claude' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].options.env.ANTHROPIC_API_KEY).toBe('sk-ant-key123');
    });

    it('should NOT leak other provider API keys', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
      process.env.OPENAI_API_KEY = 'sk-openai-key';
      process.env.GOOGLE_API_KEY = 'goog-key';

      const task = makeTask({ agent: 'claude' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      const env = spawnCalls[0].options.env;
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-key');
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
    });

    it('should set CALLIOPE_PROVIDER and provider key for calliope', async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-test';

      const task = makeTask({ agent: 'calliope', provider: 'openai' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      const env = spawnCalls[0].options.env;
      expect(env.CALLIOPE_PROVIDER).toBe('openai');
      expect(env.OPENAI_API_KEY).toBe('sk-openai-test');
    });

    it('should set CALLIOPE_MODEL for calliope agent', async () => {
      const task = makeTask({ agent: 'calliope', model: 'gpt-4o' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].options.env.CALLIOPE_MODEL).toBe('gpt-4o');
    });

    it('should pass OLLAMA_BASE_URL for calliope with ollama', async () => {
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

      const task = makeTask({ agent: 'calliope', provider: 'ollama' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      const env = spawnCalls[0].options.env;
      expect(env.OLLAMA_BASE_URL).toBe('http://localhost:11434');
      expect(env.CALLIOPE_PROVIDER).toBe('ollama');
    });

    it('should not set CALLIOPE vars for non-calliope agents', async () => {
      const task = makeTask({ agent: 'claude', provider: 'openai', model: 'gpt-4' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      const env = spawnCalls[0].options.env;
      expect(env.CALLIOPE_PROVIDER).toBeUndefined();
      expect(env.CALLIOPE_MODEL).toBeUndefined();
    });

    it('should handle calliope without provider or model', async () => {
      const task = makeTask({ agent: 'calliope' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      const env = spawnCalls[0].options.env;
      expect(env.CALLIOPE_PROVIDER).toBeUndefined();
      expect(env.CALLIOPE_MODEL).toBeUndefined();
    });

    it('should handle missing env vars gracefully', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.PATH;

      const task = makeTask({ agent: 'claude' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      const env = spawnCalls[0].options.env;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.PATH).toBeUndefined();
      expect(env.TERM).toBe('xterm-256color');
    });

    it('should include GOOGLE_API_KEY for gemini', async () => {
      process.env.GOOGLE_API_KEY = 'goog-test-key';

      const task = makeTask({ agent: 'gemini' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].options.env.GOOGLE_API_KEY).toBe('goog-test-key');
    });

    it('should include OPENAI_API_KEY for codex', async () => {
      process.env.OPENAI_API_KEY = 'sk-openai-test';

      const task = makeTask({ agent: 'codex' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].options.env.OPENAI_API_KEY).toBe('sk-openai-test');
    });

    it('should include google key for calliope with google provider', async () => {
      process.env.GOOGLE_API_KEY = 'goog-for-calliope';

      const task = makeTask({ agent: 'calliope', provider: 'google' });
      const { iter, proc } = await setupGenerator(task, '/tmp');
      await nextEvent(iter, () => proc.emit('close', 0));

      const env = spawnCalls[0].options.env;
      expect(env.CALLIOPE_PROVIDER).toBe('google');
      expect(env.GOOGLE_API_KEY).toBe('goog-for-calliope');
    });
  });

  // --------------------------------------------------------------------------
  // cancelTask
  // --------------------------------------------------------------------------

  describe('cancelTask', () => {
    it('should kill a running task and return true', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      // Need to kick iter into the while loop
      const nextPromise = iter.next();
      await new Promise(r => setTimeout(r, 0));

      expect(isTaskRunning(task.id)).toBe(true);

      const result = cancelTask(task.id);
      expect(result).toBe(true);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(isTaskRunning(task.id)).toBe(false);

      // Unblock the iterator so it can finish
      proc.emit('close', 0);
      await nextPromise;
    });

    it('should return false for non-existent task', () => {
      expect(cancelTask('nonexistent-id')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getTaskOutput
  // --------------------------------------------------------------------------

  describe('getTaskOutput', () => {
    it('should return undefined for non-existent task', () => {
      expect(getTaskOutput('no-such-task')).toBeUndefined();
    });

    it('should return accumulated output', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      await nextEvent(iter, () =>
        proc.stdout!.emit('data', Buffer.from('hello')));

      expect(getTaskOutput(task.id)).toBe('hello');

      await nextEvent(iter, () => proc.emit('close', 0));
    });

    it('should return undefined after task completes', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(getTaskOutput(task.id)).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // isTaskRunning
  // --------------------------------------------------------------------------

  describe('isTaskRunning', () => {
    it('should return false for unknown task', () => {
      expect(isTaskRunning('unknown')).toBe(false);
    });

    it('should return true while active, false after close', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      // Kick into while loop
      const nextPromise = iter.next();
      await new Promise(r => setTimeout(r, 0));

      expect(isTaskRunning(task.id)).toBe(true);

      proc.emit('close', 0);
      await nextPromise;

      expect(isTaskRunning(task.id)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getRunningTaskCount
  // --------------------------------------------------------------------------

  describe('getRunningTaskCount', () => {
    it('should return 0 when no tasks running', () => {
      expect(getRunningTaskCount()).toBe(0);
    });

    it('should track multiple running tasks', async () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();

      const task1 = makeTask({ id: 'count-1' });
      const task2 = makeTask({ id: 'count-2' });

      // Setup task 1
      spawnReturnValue = proc1;
      const gen1 = executeAgent(task1, '/tmp');
      const iter1 = gen1[Symbol.asyncIterator]();
      await iter1.next(); // start
      // Kick into while loop
      const p1 = iter1.next();
      await new Promise(r => setTimeout(r, 0));

      // Setup task 2
      spawnReturnValue = proc2;
      const gen2 = executeAgent(task2, '/tmp');
      const iter2 = gen2[Symbol.asyncIterator]();
      await iter2.next(); // start
      const p2 = iter2.next();
      await new Promise(r => setTimeout(r, 0));

      expect(getRunningTaskCount()).toBe(2);

      proc1.emit('close', 0);
      await p1;
      expect(getRunningTaskCount()).toBe(1);

      proc2.emit('close', 0);
      await p2;
      expect(getRunningTaskCount()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // killAllTasks
  // --------------------------------------------------------------------------

  describe('killAllTasks', () => {
    it('should kill all running tasks', async () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();

      const task1 = makeTask({ id: 'kill-1' });
      const task2 = makeTask({ id: 'kill-2' });

      // Setup task 1
      spawnReturnValue = proc1;
      const gen1 = executeAgent(task1, '/tmp');
      const iter1 = gen1[Symbol.asyncIterator]();
      await iter1.next(); // start
      const p1 = iter1.next();
      await new Promise(r => setTimeout(r, 0));

      // Setup task 2
      spawnReturnValue = proc2;
      const gen2 = executeAgent(task2, '/tmp');
      const iter2 = gen2[Symbol.asyncIterator]();
      await iter2.next(); // start
      const p2 = iter2.next();
      await new Promise(r => setTimeout(r, 0));

      expect(getRunningTaskCount()).toBe(2);

      killAllTasks();

      expect(getRunningTaskCount()).toBe(0);
      expect(proc1.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc2.kill).toHaveBeenCalledWith('SIGTERM');

      // Unblock iterators
      proc1.emit('close', 0);
      proc2.emit('close', 0);
      await p1;
      await p2;
    });

    it('should be safe with no running tasks', () => {
      expect(() => killAllTasks()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty prompt', async () => {
      const task = makeTask({ agent: 'claude', prompt: '' });
      const { iter, proc } = await setupGenerator(task, '/tmp');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].args).toEqual(['--print', '']);
    });

    it('should use provided cwd for spawn', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/my/project/dir');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].options.cwd).toBe('/my/project/dir');
    });

    it('should set stdio to pipe for all streams', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      await nextEvent(iter, () => proc.emit('close', 0));

      expect(spawnCalls[0].options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    });

    it('should track task as running after spawn', async () => {
      const task = makeTask();
      const { iter, proc } = await setupGenerator(task, '/tmp');

      // Kick into while loop to trigger spawn + runningTasks.set
      const nextPromise = iter.next();
      await new Promise(r => setTimeout(r, 0));

      expect(isTaskRunning(task.id)).toBe(true);
      expect(getRunningTaskCount()).toBeGreaterThan(0);

      proc.emit('close', 0);
      await nextPromise;
    });
  });
});
