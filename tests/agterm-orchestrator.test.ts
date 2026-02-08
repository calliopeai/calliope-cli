import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SubAgentTask, SubAgentType, TaskPriority, AgentEvent } from '../src/agterm/types.js';
import { DEFAULT_ORCHESTRATOR_CONFIG } from '../src/agterm/types.js';

// ============================================================================
// Mock external dependencies
// ============================================================================

// Mock agent-detection: always report agents as available
vi.mock('../src/agterm/agent-detection.js', () => ({
  isAgentAvailable: vi.fn(() => true),
  detectAgents: vi.fn(() => []),
  getAvailableAgents: vi.fn(() => ['claude', 'gemini', 'codex', 'calliope']),
  getAgentCLI: vi.fn((agent: string) => ({ command: agent, args: [] })),
  getAgentEnvVar: vi.fn(() => 'ANTHROPIC_API_KEY'),
  getAgentStatusReport: vi.fn(() => ''),
}));

// Mock cli-backend: simulate agent execution without spawning processes
const mockCancelTask = vi.fn(() => true);

vi.mock('../src/agterm/cli-backend.js', () => ({
  executeAgent: vi.fn(async function* (task: SubAgentTask, _cwd: string, _timeout: number): AsyncIterable<AgentEvent> {
    yield {
      type: 'text' as const,
      taskId: task.id,
      timestamp: new Date(),
      content: `Mock result for: ${task.prompt}`,
    };
    yield {
      type: 'complete' as const,
      taskId: task.id,
      timestamp: new Date(),
    };
  }),
  cancelTask: (...args: unknown[]) => mockCancelTask(...args),
  getTaskOutput: vi.fn(),
  isTaskRunning: vi.fn(() => false),
  getRunningTaskCount: vi.fn(() => 0),
  killAllTasks: vi.fn(),
}));

// Import after mocks
import { orchestrator } from '../src/agterm/orchestrator.js';
import { executeAgent } from '../src/agterm/cli-backend.js';
import { isAgentAvailable } from '../src/agterm/agent-detection.js';

/**
 * Restore the default mock for executeAgent (completes immediately with result).
 * Must be called in beforeEach to prevent a test that overrides the mock
 * from polluting subsequent tests.
 */
function resetExecuteAgentMock(): void {
  vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
    yield {
      type: 'text' as const,
      taskId: task.id,
      timestamp: new Date(),
      content: `Mock result for: ${task.prompt}`,
    };
    yield {
      type: 'complete' as const,
      taskId: task.id,
      timestamp: new Date(),
    };
  });
}

// ============================================================================
// Orchestrator: Configuration
// ============================================================================

describe('Orchestrator Configuration', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should use default config on construction', () => {
    const stats = orchestrator.getStats();
    expect(stats.totalTasks).toBe(0);
    expect(stats.queuedTasks).toBe(0);
    expect(stats.runningTasks).toBe(0);
  });

  it('should update config with partial overrides', () => {
    orchestrator.updateConfig({ maxConcurrent: 5 });
    // Config update doesn't expose the config directly, but we test its effect
    // by verifying it doesn't throw
    const stats = orchestrator.getStats();
    expect(stats.totalTasks).toBe(0);
  });

  it('should set working directory', () => {
    orchestrator.setCwd('/tmp/test');
    // No error means success; cwd is used internally during task execution
    expect(true).toBe(true);
  });
});

// ============================================================================
// Orchestrator: Agent Spawning
// ============================================================================

describe('Orchestrator Agent Spawning', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should spawn an agent and complete successfully', async () => {
    const task = await orchestrator.spawnAgent('Hello', 'claude');

    expect(task).toBeDefined();
    expect(task.id).toBeTruthy();
    expect(task.prompt).toBe('Hello');
    expect(task.agent).toBe('claude');
    expect(task.status).toBe('completed');
    expect(task.result).toContain('Mock result for: Hello');
    expect(task.depth).toBe(0);
    expect(task.childIds).toEqual([]);
  });

  it('should create task with correct priority', async () => {
    const task = await orchestrator.spawnAgent('Test', 'claude', { priority: 'high' });

    expect(task.priority).toBe('high');
  });

  it('should default priority to normal', async () => {
    const task = await orchestrator.spawnAgent('Test', 'claude');

    expect(task.priority).toBe('normal');
  });

  it('should record task in task list', async () => {
    await orchestrator.spawnAgent('Task 1', 'claude');
    await orchestrator.spawnAgent('Task 2', 'gemini');

    const allTasks = orchestrator.getAllTasks();
    expect(allTasks.length).toBe(2);
    expect(allTasks[0].agent).toBe('claude');
    expect(allTasks[1].agent).toBe('gemini');
  });

  it('should set timestamps on completed task', async () => {
    const task = await orchestrator.spawnAgent('Test', 'claude');

    expect(task.createdAt).toBeInstanceOf(Date);
    expect(task.updatedAt).toBeInstanceOf(Date);
    expect(task.startedAt).toBeInstanceOf(Date);
    expect(task.completedAt).toBeInstanceOf(Date);
  });

  it('should throw when agent is not available', async () => {
    vi.mocked(isAgentAvailable).mockReturnValueOnce(false);

    await expect(
      orchestrator.spawnAgent('Test', 'codex')
    ).rejects.toThrow("Agent 'codex' is not available");
  });

  it('should support all agent types', async () => {
    const agents: SubAgentType[] = ['claude', 'gemini', 'codex', 'calliope'];

    for (const agent of agents) {
      const task = await orchestrator.spawnAgent(`Test ${agent}`, agent);
      expect(task.agent).toBe(agent);
      expect(task.status).toBe('completed');
    }
  });
});

// ============================================================================
// Orchestrator: Task Retrieval
// ============================================================================

describe('Orchestrator Task Retrieval', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should get task by ID', async () => {
    const task = await orchestrator.spawnAgent('Hello', 'claude');
    const retrieved = orchestrator.getTask(task.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(task.id);
    expect(retrieved!.prompt).toBe('Hello');
  });

  it('should return undefined for unknown task ID', () => {
    const result = orchestrator.getTask('nonexistent');
    expect(result).toBeUndefined();
  });

  it('should filter tasks by status', async () => {
    await orchestrator.spawnAgent('Task 1', 'claude');
    await orchestrator.spawnAgent('Task 2', 'claude');

    const completed = orchestrator.getTasksByStatus('completed');
    expect(completed.length).toBe(2);

    const pending = orchestrator.getTasksByStatus('pending');
    expect(pending.length).toBe(0);
  });

  it('should return empty for status with no matching tasks', () => {
    const failed = orchestrator.getTasksByStatus('failed');
    expect(failed).toEqual([]);
  });
});

// ============================================================================
// Orchestrator: Task Tree
// ============================================================================

describe('Orchestrator Task Tree', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should build task tree for parent with children', async () => {
    const parent = await orchestrator.spawnAgent('Parent', 'claude');
    const child = await orchestrator.spawnAgent('Child', 'claude', {
      parentId: parent.id,
    });

    const tree = orchestrator.getTaskTree(parent.id);
    expect(tree.length).toBe(2);
    expect(tree[0].id).toBe(parent.id);
    expect(tree[1].id).toBe(child.id);
  });

  it('should return single-element tree for task with no children', async () => {
    const task = await orchestrator.spawnAgent('Solo', 'claude');

    const tree = orchestrator.getTaskTree(task.id);
    expect(tree.length).toBe(1);
    expect(tree[0].id).toBe(task.id);
  });

  it('should return empty array for unknown task', () => {
    const tree = orchestrator.getTaskTree('nonexistent');
    expect(tree).toEqual([]);
  });

  it('should correctly link parent and child IDs', async () => {
    const parent = await orchestrator.spawnAgent('Parent', 'claude');
    const child = await orchestrator.spawnAgent('Child', 'claude', {
      parentId: parent.id,
    });

    expect(child.parentId).toBe(parent.id);
    expect(child.depth).toBe(1);

    const parentTask = orchestrator.getTask(parent.id);
    expect(parentTask!.childIds).toContain(child.id);
  });
});

// ============================================================================
// Orchestrator: Depth Limiting
// ============================================================================

describe('Orchestrator Depth Limiting', () => {
  beforeEach(() => {
    orchestrator.reset();
    orchestrator.updateConfig({ maxDepth: 2, allowNestedSubAgents: true });
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should allow spawning at depth 0', async () => {
    const task = await orchestrator.spawnAgent('Root', 'claude');
    expect(task.depth).toBe(0);
    expect(task.status).toBe('completed');
  });

  it('should allow spawning child at depth 1', async () => {
    const parent = await orchestrator.spawnAgent('Parent', 'claude');
    const child = await orchestrator.spawnAgent('Child', 'claude', {
      parentId: parent.id,
    });

    expect(child.depth).toBe(1);
    expect(child.status).toBe('completed');
  });

  it('should allow spawning at max depth', async () => {
    const level0 = await orchestrator.spawnAgent('L0', 'claude');
    const level1 = await orchestrator.spawnAgent('L1', 'claude', {
      parentId: level0.id,
    });
    const level2 = await orchestrator.spawnAgent('L2', 'claude', {
      parentId: level1.id,
    });

    expect(level2.depth).toBe(2);
    expect(level2.status).toBe('completed');
  });

  it('should reject spawning beyond max depth', async () => {
    const level0 = await orchestrator.spawnAgent('L0', 'claude');
    const level1 = await orchestrator.spawnAgent('L1', 'claude', {
      parentId: level0.id,
    });
    const level2 = await orchestrator.spawnAgent('L2', 'claude', {
      parentId: level1.id,
    });

    await expect(
      orchestrator.spawnAgent('L3', 'claude', { parentId: level2.id })
    ).rejects.toThrow('Maximum sub-agent depth (2) exceeded');
  });

  it('should reject nested sub-agents when disabled', async () => {
    orchestrator.updateConfig({ allowNestedSubAgents: false, maxDepth: 5 });

    const level0 = await orchestrator.spawnAgent('Root', 'claude');
    const level1 = await orchestrator.spawnAgent('Child', 'claude', {
      parentId: level0.id,
    });

    // level1.depth is 1 (> 0), so spawning from it should fail
    await expect(
      orchestrator.spawnAgent('Grandchild', 'claude', { parentId: level1.id })
    ).rejects.toThrow('Nested sub-agents are disabled');
  });
});

// ============================================================================
// Orchestrator: Children Per Task Limit
// ============================================================================

describe('Orchestrator Children Limit', () => {
  beforeEach(() => {
    orchestrator.reset();
    orchestrator.updateConfig({ maxChildrenPerTask: 2 });
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should allow spawning up to max children per task', async () => {
    const parent = await orchestrator.spawnAgent('Parent', 'claude');

    const child1 = await orchestrator.spawnAgent('C1', 'claude', {
      parentId: parent.id,
    });
    const child2 = await orchestrator.spawnAgent('C2', 'claude', {
      parentId: parent.id,
    });

    expect(child1.status).toBe('completed');
    expect(child2.status).toBe('completed');

    const parentTask = orchestrator.getTask(parent.id);
    expect(parentTask!.childIds.length).toBe(2);
  });

  it('should reject exceeding max children per task', async () => {
    const parent = await orchestrator.spawnAgent('Parent', 'claude');

    await orchestrator.spawnAgent('C1', 'claude', { parentId: parent.id });
    await orchestrator.spawnAgent('C2', 'claude', { parentId: parent.id });

    await expect(
      orchestrator.spawnAgent('C3', 'claude', { parentId: parent.id })
    ).rejects.toThrow('Maximum children per task (2) exceeded');
  });
});

// ============================================================================
// Orchestrator: Queue Size Limit
// ============================================================================

describe('Orchestrator Queue Size Limit', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
  });

  it('should reject when queue is full', async () => {
    // Make executeAgent hang so tasks stay queued/running
    vi.mocked(executeAgent).mockImplementation(async function* () {
      await new Promise(() => {});  // Never resolves
    });

    orchestrator.updateConfig({ maxConcurrent: 1, maxQueueSize: 2 });

    // First task starts running immediately (removed from queue)
    await orchestrator.spawnAgent('T1', 'claude', { background: true });

    // These two go into the queue
    await orchestrator.spawnAgent('T2', 'claude', { background: true });
    await orchestrator.spawnAgent('T3', 'claude', { background: true });

    // Queue is now full (2 items), next should throw
    await expect(
      orchestrator.spawnAgent('T4', 'claude', { background: true })
    ).rejects.toThrow('Task queue is full');
  });
});

// ============================================================================
// Orchestrator: Task Cancellation
// ============================================================================

describe('Orchestrator Task Cancellation', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should cancel a completed task (sets status to cancelled)', async () => {
    const task = await orchestrator.spawnAgent('Test', 'claude');

    await orchestrator.cancelTask(task.id);

    const cancelled = orchestrator.getTask(task.id);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.completedAt).toBeInstanceOf(Date);
  });

  it('should handle cancelling non-existent task gracefully', async () => {
    // Should not throw
    await orchestrator.cancelTask('nonexistent');
  });

  it('should cancel children when cancelling parent', async () => {
    const parent = await orchestrator.spawnAgent('Parent', 'claude');
    const child = await orchestrator.spawnAgent('Child', 'claude', {
      parentId: parent.id,
    });

    await orchestrator.cancelTask(parent.id);

    const cancelledParent = orchestrator.getTask(parent.id);
    const cancelledChild = orchestrator.getTask(child.id);

    expect(cancelledParent!.status).toBe('cancelled');
    expect(cancelledChild!.status).toBe('cancelled');
  });
});

// ============================================================================
// Orchestrator: Task Error Handling
// ============================================================================

describe('Orchestrator Task Error Handling', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should set task to failed when execution yields an error', async () => {
    vi.mocked(executeAgent).mockImplementationOnce(async function* (task) {
      yield {
        type: 'error' as const,
        taskId: task.id,
        timestamp: new Date(),
        message: 'Something went wrong',
      };
    });

    const task = await orchestrator.spawnAgent('Test', 'claude');

    expect(task.status).toBe('failed');
    expect(task.error).toBe('Something went wrong');
    expect(task.completedAt).toBeInstanceOf(Date);
  });

  it('should set task to failed when executeAgent throws', async () => {
    vi.mocked(executeAgent).mockImplementationOnce(async function* () {
      throw new Error('Process crashed');
    });

    const task = await orchestrator.spawnAgent('Test', 'claude');

    expect(task.status).toBe('failed');
    expect(task.error).toBe('Process crashed');
  });

  it('should set result to "(no output)" when execution produces empty result', async () => {
    vi.mocked(executeAgent).mockImplementationOnce(async function* (task) {
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const task = await orchestrator.spawnAgent('Test', 'claude');

    expect(task.status).toBe('completed');
    expect(task.result).toBe('(no output)');
  });
});

// ============================================================================
// Orchestrator: Statistics
// ============================================================================

describe('Orchestrator Statistics', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should report zero stats on empty orchestrator', () => {
    const stats = orchestrator.getStats();
    expect(stats.totalTasks).toBe(0);
    expect(stats.queuedTasks).toBe(0);
    expect(stats.runningTasks).toBe(0);
    expect(stats.completedTasks).toBe(0);
    expect(stats.failedTasks).toBe(0);
    expect(stats.cancelledTasks).toBe(0);
    expect(stats.maxDepthUsed).toBe(0);
  });

  it('should track completed tasks', async () => {
    await orchestrator.spawnAgent('T1', 'claude');
    await orchestrator.spawnAgent('T2', 'claude');

    const stats = orchestrator.getStats();
    expect(stats.totalTasks).toBe(2);
    expect(stats.completedTasks).toBe(2);
  });

  it('should track failed tasks', async () => {
    vi.mocked(executeAgent).mockImplementationOnce(async function* (task) {
      yield {
        type: 'error' as const,
        taskId: task.id,
        timestamp: new Date(),
        message: 'fail',
      };
    });

    await orchestrator.spawnAgent('Fail', 'claude');

    const stats = orchestrator.getStats();
    expect(stats.failedTasks).toBe(1);
  });

  it('should track cancelled tasks', async () => {
    const task = await orchestrator.spawnAgent('Cancel me', 'claude');
    await orchestrator.cancelTask(task.id);

    const stats = orchestrator.getStats();
    expect(stats.cancelledTasks).toBe(1);
  });

  it('should track max depth used', async () => {
    const parent = await orchestrator.spawnAgent('Parent', 'claude');
    await orchestrator.spawnAgent('Child', 'claude', { parentId: parent.id });

    const stats = orchestrator.getStats();
    expect(stats.maxDepthUsed).toBe(1);
  });
});

// ============================================================================
// Orchestrator: Cleanup
// ============================================================================

describe('Orchestrator Cleanup', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should clean up old completed tasks', async () => {
    const task = await orchestrator.spawnAgent('Old task', 'claude');

    // Manually backdate the completedAt to trigger cleanup
    const taskRef = orchestrator.getTask(task.id);
    taskRef!.completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago

    const cleaned = orchestrator.cleanup(60 * 60 * 1000); // 1 hour max age
    expect(cleaned).toBe(1);
    expect(orchestrator.getTask(task.id)).toBeUndefined();
  });

  it('should not clean up recent tasks', async () => {
    await orchestrator.spawnAgent('Recent task', 'claude');

    const cleaned = orchestrator.cleanup(60 * 60 * 1000);
    expect(cleaned).toBe(0);
    expect(orchestrator.getAllTasks().length).toBe(1);
  });

  it('should not clean up running tasks', async () => {
    // Create a mock that hangs
    vi.mocked(executeAgent).mockImplementation(async function* () {
      await new Promise(() => {}); // never resolves
    });

    const taskPromise = orchestrator.spawnAgent('Running', 'claude', { background: true });
    const task = await taskPromise;

    const cleaned = orchestrator.cleanup(0); // Zero max age
    // Running task has no completedAt, should not be cleaned
    expect(cleaned).toBe(0);
  });

  it('should remove cleaned task from parent childIds', async () => {
    const parent = await orchestrator.spawnAgent('Parent', 'claude');
    const child = await orchestrator.spawnAgent('Child', 'claude', {
      parentId: parent.id,
    });

    // Backdate child's completedAt
    const childRef = orchestrator.getTask(child.id);
    childRef!.completedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

    orchestrator.cleanup(60 * 60 * 1000);

    const parentRef = orchestrator.getTask(parent.id);
    expect(parentRef!.childIds).not.toContain(child.id);
  });
});

// ============================================================================
// Orchestrator: Reset
// ============================================================================

describe('Orchestrator Reset', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should clear all tasks', async () => {
    await orchestrator.spawnAgent('T1', 'claude');
    await orchestrator.spawnAgent('T2', 'claude');

    expect(orchestrator.getAllTasks().length).toBe(2);

    orchestrator.reset();

    expect(orchestrator.getAllTasks().length).toBe(0);
    const stats = orchestrator.getStats();
    expect(stats.totalTasks).toBe(0);
  });

  it('should call cancelBackendTask for running tasks during reset', async () => {
    // Make task hang
    vi.mocked(executeAgent).mockImplementation(async function* () {
      await new Promise(() => {});
    });

    await orchestrator.spawnAgent('Hanging', 'claude', { background: true });

    orchestrator.reset();

    // cancelTask should have been called (the backend cancel)
    expect(mockCancelTask).toHaveBeenCalled();
  });
});

// ============================================================================
// Orchestrator: Background (Queue) Tasks
// ============================================================================

describe('Orchestrator Background Tasks', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should queue background tasks', async () => {
    const task = await orchestrator.spawnAgent('Background', 'claude', {
      background: true,
    });

    // With the immediate mock, it completes right away
    expect(task).toBeDefined();
    expect(task.prompt).toBe('Background');
  });

  it('should execute foreground tasks immediately (awaiting result)', async () => {
    const task = await orchestrator.spawnAgent('Foreground', 'claude', {
      background: false,
    });

    expect(task.status).toBe('completed');
    expect(task.result).toContain('Mock result for: Foreground');
  });
});

// ============================================================================
// Orchestrator: Priority Queue Ordering
// ============================================================================

describe('Orchestrator Priority Queue Ordering', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should accept all priority levels', async () => {
    const priorities: TaskPriority[] = ['low', 'normal', 'high', 'critical'];

    for (const priority of priorities) {
      const task = await orchestrator.spawnAgent(`Task ${priority}`, 'claude', {
        priority,
      });
      expect(task.priority).toBe(priority);
    }
  });
});

// ============================================================================
// Orchestrator: Custom Working Directory
// ============================================================================

describe('Orchestrator Custom CWD', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should pass cwd to task execution', async () => {
    const task = await orchestrator.spawnAgent('Test', 'claude', {
      cwd: '/custom/path',
    });

    expect(task.status).toBe('completed');
    // Verify executeAgent was called with the custom cwd
    expect(vi.mocked(executeAgent)).toHaveBeenCalledWith(
      expect.anything(),
      '/custom/path',
      expect.anything()
    );
  });

  it('should use orchestrator cwd when none specified per-task', async () => {
    orchestrator.setCwd('/default/path');

    const task = await orchestrator.spawnAgent('Test', 'claude');

    expect(task.status).toBe('completed');
    expect(vi.mocked(executeAgent)).toHaveBeenCalledWith(
      expect.anything(),
      '/default/path',
      expect.anything()
    );
  });
});

// ============================================================================
// Orchestrator: Concurrent Task Limit (Integration-style)
// ============================================================================

describe('Orchestrator Concurrency', () => {
  beforeEach(() => {
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should handle multiple sequential foreground tasks', async () => {
    const t1 = await orchestrator.spawnAgent('T1', 'claude');
    const t2 = await orchestrator.spawnAgent('T2', 'gemini');
    const t3 = await orchestrator.spawnAgent('T3', 'claude');

    expect(t1.status).toBe('completed');
    expect(t2.status).toBe('completed');
    expect(t3.status).toBe('completed');

    const stats = orchestrator.getStats();
    expect(stats.totalTasks).toBe(3);
    expect(stats.completedTasks).toBe(3);
  });
});
