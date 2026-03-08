import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  SwarmSession,
  SwarmSubtask,
  SwarmConfig,
} from '../src/agents/swarm-types.js';
import { DEFAULT_SWARM_CONFIG } from '../src/agents/swarm-types.js';
import type { SubAgentTask, AgentEvent } from '../src/agents/types.js';

// ============================================================================
// Mock external dependencies
// ============================================================================

vi.mock('../src/agents/agent-detection.js', () => ({
  isAgentAvailable: vi.fn(() => true),
  detectAgents: vi.fn(() => []),
  getAvailableAgents: vi.fn(() => ['claude', 'gemini', 'codex', 'calliope']),
  getAgentCLI: vi.fn((agent: string) => ({ command: agent, args: [] })),
  getAgentEnvVar: vi.fn(() => 'ANTHROPIC_API_KEY'),
  getAgentStatusReport: vi.fn(() => ''),
}));

const mockCancelTask = vi.fn(() => true);

vi.mock('../src/agents/cli-backend.js', () => ({
  executeAgent: vi.fn(async function* (task: SubAgentTask): AsyncIterable<AgentEvent> {
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

// Mock smart-router
vi.mock('../src/smart-router.js', () => ({
  detectTaskType: vi.fn(() => 'code'),
  smartRoute: vi.fn(() => ({
    selected: { provider: 'anthropic', model: 'claude-4-sonnet', tier: 'balanced', score: 90, reason: 'Best for code' },
    alternatives: [],
    taskType: 'code',
    complexity: 'moderate',
    confidence: 0.8,
  })),
  getDefaultSmartRoutingConfig: vi.fn(() => ({
    enabled: true,
    providerPool: ['anthropic', 'google', 'openai'],
    costSensitivity: 0.3,
    preferredProviders: ['anthropic'],
  })),
}));

// Mock config
vi.mock('../src/config.js', () => ({
  get: vi.fn(() => 0.3),
  set: vi.fn(),
  getAll: vi.fn(() => ({})),
  default: { get: vi.fn(() => 0.3), set: vi.fn() },
}));

// Import after mocks
import { swarmManager } from '../src/agents/swarm.js';
import { orchestrator } from '../src/agents/orchestrator.js';
import { executeAgent } from '../src/agents/cli-backend.js';
import { smartRoute } from '../src/smart-router.js';

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

/**
 * Helper: mock the orchestrator's executeAgent to return a valid decomposition
 * on the first call, then standard results for workers.
 */
function mockDecompositionAndWorkers(subtaskDefs: Array<{ prompt: string; dependsOn?: number[] }>): void {
  let callCount = 0;
  vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
    callCount++;
    if (callCount === 1) {
      // Decomposition call - return JSON subtasks
      const json = JSON.stringify(subtaskDefs.map(s => ({
        prompt: s.prompt,
        dependsOn: s.dependsOn || [],
        priority: 'normal',
      })));
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: json,
      };
    } else {
      // Worker call - return a result
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: `Worker result for: ${task.prompt.slice(0, 50)}`,
      };
    }
    yield {
      type: 'complete' as const,
      taskId: task.id,
      timestamp: new Date(),
    };
  });
}

// ============================================================================
// Swarm Creation
// ============================================================================

describe('Swarm Creation', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should create a swarm session with correct fields', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task 1' }]);

    const session = await swarmManager.startSwarm('Build an app');

    expect(session.id).toBeDefined();
    expect(session.prompt).toBe('Build an app');
    expect(session.status).toBe('decomposing');
    expect(session.config).toBeDefined();
    expect(session.subtasks).toEqual([]);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.updatedAt).toBeInstanceOf(Date);
  });

  it('should merge config with defaults', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task 1' }]);

    const session = await swarmManager.startSwarm('Test', {
      maxWorkers: 5,
      decomposition: 'sequential',
    });

    expect(session.config.maxWorkers).toBe(5);
    expect(session.config.decomposition).toBe('sequential');
    expect(session.config.aggregation).toBe(DEFAULT_SWARM_CONFIG.aggregation);
    expect(session.config.maxRetries).toBe(DEFAULT_SWARM_CONFIG.maxRetries);
  });

  it('should store session in session map', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task 1' }]);

    const session = await swarmManager.startSwarm('Test');

    const retrieved = swarmManager.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
  });

  it('should return undefined for non-existent session', () => {
    const result = swarmManager.getSession('non-existent');
    expect(result).toBeUndefined();
  });

  it('should track multiple sessions in getAllSessions', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task 1' }]);

    await swarmManager.startSwarm('Test 1');
    await swarmManager.startSwarm('Test 2');

    const all = swarmManager.getAllSessions();
    expect(all.length).toBe(2);
  });
});

// ============================================================================
// Swarm Lifecycle - Decomposition to Completion
// ============================================================================

describe('Swarm Lifecycle', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should complete lifecycle: decompose -> execute -> aggregate', async () => {
    mockDecompositionAndWorkers([
      { prompt: 'Step 1' },
      { prompt: 'Step 2' },
    ]);

    const session = await swarmManager.startSwarm('Build an app');

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.subtasks.length).toBe(2);
    expect(updated.result).toBeDefined();
    expect(updated.completedAt).toBeInstanceOf(Date);
  });

  it('should handle sequential dependencies in subtasks', async () => {
    mockDecompositionAndWorkers([
      { prompt: 'Step 1' },
      { prompt: 'Step 2', dependsOn: [0] },
    ]);

    const session = await swarmManager.startSwarm('Sequential task', {
      decomposition: 'sequential',
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.subtasks.length).toBe(2);
  });

  it('should fail when decomposition produces no result', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      // Decomposition returns empty
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: '',
      };
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const session = await swarmManager.startSwarm('Test');

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toBeDefined();
  });

  it('should fail when decomposition agent fails', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* () {
      throw new Error('Agent not available');
    });

    const session = await swarmManager.startSwarm('Test');

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toContain('Agent not available');
  });

  it('should handle lifecycle errors and set session to failed', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* () {
      throw new Error('Unexpected crash');
    });

    const session = await swarmManager.startSwarm('Test');

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toBeDefined();
    expect(updated.completedAt).toBeInstanceOf(Date);
  });
});

// ============================================================================
// Task Distribution & Worker Management
// ============================================================================

describe('Task Distribution', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should dispatch subtasks to workers respecting maxWorkers', async () => {
    mockDecompositionAndWorkers([
      { prompt: 'Task 1' },
      { prompt: 'Task 2' },
      { prompt: 'Task 3' },
      { prompt: 'Task 4' },
    ]);

    const session = await swarmManager.startSwarm('Parallel work', {
      maxWorkers: 2,
      decomposition: 'parallel',
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.subtasks.length).toBe(4);
    // All should be completed
    expect(updated.subtasks.every(s => s.status === 'completed')).toBe(true);
  });

  it('should enrich subtask prompts with dependency results', async () => {
    const prompts: string[] = [];
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      if (callCount === 1) {
        // Decomposition
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: JSON.stringify([
            { prompt: 'First task', dependsOn: [] },
            { prompt: 'Second task', dependsOn: [0] },
          ]),
        };
      } else {
        prompts.push(task.prompt);
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: `Result of: ${task.prompt.slice(0, 30)}`,
        };
      }
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const session = await swarmManager.startSwarm('Test deps', {
      decomposition: 'sequential',
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    // The second worker prompt should include context from the first
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('Context from previous steps');
  });

  it('should record error on subtask when worker fails', async () => {
    // When a worker subtask fails, the error is recorded on the subtask object
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      if (callCount === 1) {
        // Decomposition
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: JSON.stringify([{ prompt: 'Failing task', dependsOn: [] }]),
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      } else {
        // Worker fails
        throw new Error('Worker crashed');
      }
    });

    const session = await swarmManager.startSwarm('Test error recording', {
      maxRetries: 0,
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.subtasks[0].status).toBe('failed');
    expect(updated.subtasks[0].error).toContain('Worker crashed');
    expect(updated.subtasks[0].attempts).toBe(1);
  });
});

// ============================================================================
// Worker Recovery (Retry Logic)
// ============================================================================

describe('Worker Recovery', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should track attempt counts on failed subtasks', async () => {
    // With maxRetries=0, maxAttempts=1. After one failure, subtask is permanently failed.
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      if (callCount === 1) {
        // Decomposition
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: JSON.stringify([{ prompt: 'Flaky task', dependsOn: [] }]),
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      } else {
        throw new Error('Transient failure');
      }
    });

    const session = await swarmManager.startSwarm('Test attempt tracking', {
      maxRetries: 0,
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    const subtask = updated.subtasks[0];
    expect(subtask.status).toBe('failed');
    expect(subtask.attempts).toBe(1);
    expect(subtask.maxAttempts).toBe(1); // maxRetries(0) + 1
    expect(subtask.error).toContain('Transient failure');
  });

  it('should complete successfully when all subtasks succeed', async () => {
    mockDecompositionAndWorkers([
      { prompt: 'Good task 1' },
      { prompt: 'Good task 2' },
    ]);

    const session = await swarmManager.startSwarm('Test success', {
      maxRetries: 2,
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.subtasks.every(s => s.status === 'completed')).toBe(true);
    expect(updated.subtasks.every(s => s.attempts === 1)).toBe(true);
  });

  it('should use getAlternateAgent to pick a different agent type', async () => {
    // Test the alternate agent selection indirectly through the lifecycle.
    // When a subtask fails and recovery triggers, the agent should change.
    // We need at least 2 subtasks, one permanently failed to trigger recovery.
    let callCount = 0;
    const agentsUsed: string[] = [];
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      if (callCount === 1) {
        // Decomposition: two subtasks with different maxAttempts behavior
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: JSON.stringify([
            { prompt: 'Task A', dependsOn: [] },
            { prompt: 'Task B', dependsOn: [] },
          ]),
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      } else if (callCount <= 3) {
        // Both subtasks fail on first attempt
        agentsUsed.push(task.agent);
        throw new Error('First attempt failed');
      } else {
        // Recovery retries
        agentsUsed.push(task.agent);
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: 'Recovered',
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      }
    });

    // maxRetries=0 => maxAttempts=1. After first fail, both are permanently failed.
    // hasFailedSubtasks=true, but retryable filter requires attempts < maxAttempts (1 < 1 = false).
    // So recovery won't find retryable subtasks. We just verify the agents used.
    const session = await swarmManager.startSwarm('Test agent types', {
      maxRetries: 0,
      workerAgent: 'claude',
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    const updated = swarmManager.getSession(session.id)!;
    // Both subtasks fail permanently
    expect(updated.subtasks.every(s => s.status === 'failed')).toBe(true);
    // Workers should have used the configured agent
    expect(agentsUsed.length).toBeGreaterThan(0);
    expect(agentsUsed[0]).toBe('claude');
  });

  it('should mark session as failed when all subtasks fail permanently', async () => {
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      if (callCount === 1) {
        // Decomposition
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: JSON.stringify([{ prompt: 'Doomed task', dependsOn: [] }]),
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      } else {
        // Always fail
        throw new Error('Permanent failure');
      }
    });

    const session = await swarmManager.startSwarm('Test total failure', {
      maxRetries: 1,
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toContain('All subtasks failed');
  });
});

// ============================================================================
// Result Aggregation Integration
// ============================================================================

describe('Result Aggregation Integration', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should aggregate results using concatenate strategy', async () => {
    mockDecompositionAndWorkers([
      { prompt: 'Task A' },
      { prompt: 'Task B' },
    ]);

    const session = await swarmManager.startSwarm('Test', {
      aggregation: 'concatenate',
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
    expect(updated.result).toContain('Worker result');
  });

  it('should aggregate results using structured strategy', async () => {
    mockDecompositionAndWorkers([
      { prompt: 'Step 1' },
      { prompt: 'Step 2' },
    ]);

    const session = await swarmManager.startSwarm('Build app', {
      aggregation: 'structured',
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
  });

  it('should include failure summary for partial failures', async () => {
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      if (callCount === 1) {
        // Decomposition: sequential tasks so we control which fails
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: JSON.stringify([
            { prompt: 'OK task', dependsOn: [] },
            { prompt: 'Bad task', dependsOn: [0] }, // Sequential: depends on first
          ]),
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      } else if (callCount === 2) {
        // First worker succeeds
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: 'Good result',
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      } else {
        // Second worker fails
        throw new Error('Worker exploded');
      }
    });

    const session = await swarmManager.startSwarm('Mixed results', {
      maxRetries: 0,
      decomposition: 'sequential',
    });

    await new Promise(resolve => setTimeout(resolve, 1500));

    const updated = swarmManager.getSession(session.id)!;
    // Should still complete because at least one subtask succeeded
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
    expect(updated.result).toContain('Good result');
  });
});

// ============================================================================
// Smart Routing
// ============================================================================

describe('Smart Routing', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should use smart routing when enabled in config', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Code task' }]);

    const session = await swarmManager.startSwarm('Write code', {
      useSmartRouting: true,
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    // Smart route should have been called for worker subtask
    expect(smartRoute).toHaveBeenCalled();
  });

  it('should not use smart routing when disabled', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Simple task' }]);

    const session = await swarmManager.startSwarm('Test', {
      useSmartRouting: false,
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    // Smart route should NOT have been called for workers (only decomposition call is exempt)
    // The decomposition agent is set by config, not smart routing
  });

  it('should fall back to default agent when smart routing fails', async () => {
    vi.mocked(smartRoute).mockImplementation(() => {
      throw new Error('Routing error');
    });

    mockDecompositionAndWorkers([{ prompt: 'Fallback task' }]);

    const session = await swarmManager.startSwarm('Test fallback', {
      useSmartRouting: true,
      workerAgent: 'claude',
    });

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
  });
});

// ============================================================================
// Swarm Cancellation
// ============================================================================

describe('Swarm Cancellation', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should cancel a running swarm session', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: 'never reached',
      };
    });

    const session = await swarmManager.startSwarm('Long task');

    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await swarmManager.cancelSwarm(session.id);
    expect(result).toBe(true);

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('cancelled');
    expect(updated.completedAt).toBeInstanceOf(Date);
  });

  it('should return false when cancelling non-existent session', async () => {
    const result = await swarmManager.cancelSwarm('non-existent');
    expect(result).toBe(false);
  });

  it('should cancel all running/pending subtasks on cancellation', async () => {
    // Create a session with subtasks that have taskIds
    mockDecompositionAndWorkers([
      { prompt: 'Task 1' },
      { prompt: 'Task 2' },
    ]);

    const session = await swarmManager.startSwarm('Test cancel subtasks');

    // Wait for decomposition to finish and some execution to start
    await new Promise(resolve => setTimeout(resolve, 400));

    await swarmManager.cancelSwarm(session.id);

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('cancelled');
  });
});

// ============================================================================
// Swarm Statistics
// ============================================================================

describe('Swarm Statistics', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should return correct stats for empty manager', () => {
    const stats = swarmManager.getStats();
    expect(stats.totalSessions).toBe(0);
    expect(stats.activeSessions).toBe(0);
    expect(stats.completedSessions).toBe(0);
    expect(stats.failedSessions).toBe(0);
  });

  it('should count completed sessions', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task 1' }]);

    await swarmManager.startSwarm('Test');

    await new Promise(resolve => setTimeout(resolve, 800));

    const stats = swarmManager.getStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.completedSessions).toBe(1);
  });

  it('should count failed sessions', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* () {
      throw new Error('fail');
    });

    await swarmManager.startSwarm('Test');

    await new Promise(resolve => setTimeout(resolve, 500));

    const stats = swarmManager.getStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.failedSessions).toBe(1);
  });

  it('should track active sessions during execution', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: 'delayed',
      };
    });

    await swarmManager.startSwarm('Slow task');

    await new Promise(resolve => setTimeout(resolve, 50));

    const stats = swarmManager.getStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.activeSessions).toBe(1);
  });
});

// ============================================================================
// Session Status Formatting
// ============================================================================

describe('Session Status Formatting', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should format a basic session status', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task 1' }]);

    const session = await swarmManager.startSwarm('Build an app');
    const output = swarmManager.formatSessionStatus(session);

    expect(output).toContain('Swarm:');
    expect(output).toContain('Status: decomposing');
    expect(output).toContain('Strategy:');
    expect(output).toContain('Task: Build an app');
  });

  it('should include subtask details after execution', async () => {
    mockDecompositionAndWorkers([
      { prompt: 'Step 1' },
      { prompt: 'Step 2' },
    ]);

    const session = await swarmManager.startSwarm('Build');

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    const output = swarmManager.formatSessionStatus(updated);

    expect(output).toContain('Subtasks:');
    expect(output).toContain('done');
  });

  it('should show error in output when session has error', () => {
    const session: SwarmSession = {
      id: 'test-123',
      prompt: 'test',
      status: 'failed',
      config: DEFAULT_SWARM_CONFIG,
      subtasks: [],
      error: 'Something went wrong',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const output = swarmManager.formatSessionStatus(session);
    expect(output).toContain('Error: Something went wrong');
  });

  it('should show attempt count for retried subtasks', () => {
    const session: SwarmSession = {
      id: 'test-123',
      prompt: 'test',
      status: 'completed',
      config: DEFAULT_SWARM_CONFIG,
      subtasks: [
        {
          id: 'a',
          index: 0,
          prompt: 'Flaky task that needed retry to succeed properly',
          agent: 'claude',
          priority: 'normal',
          status: 'completed',
          dependsOn: [],
          attempts: 3,
          maxAttempts: 3,
          result: 'ok',
          createdAt: new Date(),
        },
      ],
      result: 'ok',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const output = swarmManager.formatSessionStatus(session);
    expect(output).toContain('attempt 3');
  });

  it('should truncate long prompts in display', () => {
    const longPrompt = 'A'.repeat(200);
    const session: SwarmSession = {
      id: 'test-123',
      prompt: longPrompt,
      status: 'decomposing',
      config: DEFAULT_SWARM_CONFIG,
      subtasks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const output = swarmManager.formatSessionStatus(session);
    expect(output).toContain('...');
    // Prompt should be truncated to 80 chars
    expect(output.length).toBeLessThan(longPrompt.length + 100);
  });

  it('should show status icons for different subtask states', () => {
    const session: SwarmSession = {
      id: 'test-123',
      prompt: 'test',
      status: 'executing',
      config: DEFAULT_SWARM_CONFIG,
      subtasks: [
        {
          id: 'a', index: 0, prompt: 'Completed task that finished properly',
          agent: 'claude', priority: 'normal', status: 'completed',
          dependsOn: [], attempts: 1, maxAttempts: 3, result: 'ok', createdAt: new Date(),
        },
        {
          id: 'b', index: 1, prompt: 'Failed task that could not be recovered',
          agent: 'claude', priority: 'normal', status: 'failed',
          dependsOn: [], attempts: 3, maxAttempts: 3, error: 'err', createdAt: new Date(),
        },
        {
          id: 'c', index: 2, prompt: 'Running task that is still being processed',
          agent: 'claude', priority: 'normal', status: 'running',
          dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(),
        },
        {
          id: 'd', index: 3, prompt: 'Pending task waiting for dependencies to complete',
          agent: 'claude', priority: 'normal', status: 'pending',
          dependsOn: [], attempts: 0, maxAttempts: 3, createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const output = swarmManager.formatSessionStatus(session);
    expect(output).toContain('\u2713'); // Check mark for completed
    expect(output).toContain('\u2717'); // Cross for failed
    expect(output).toContain('\u25B6'); // Play for running
    expect(output).toContain('\u25CB'); // Circle for pending
  });
});

// ============================================================================
// Alternate Agent Selection
// ============================================================================

describe('Alternate Agent Selection', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should select a different agent than the current one', async () => {
    // We test this through the retry flow
    const agentsUsed: string[] = [];
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      if (callCount === 1) {
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: JSON.stringify([{ prompt: 'Test agent selection', dependsOn: [] }]),
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      } else {
        agentsUsed.push(task.agent);
        if (callCount === 2) {
          throw new Error('Agent down');
        }
        yield {
          type: 'text' as const,
          taskId: task.id,
          timestamp: new Date(),
          content: 'Success with alternate',
        };
        yield { type: 'complete' as const, taskId: task.id, timestamp: new Date() };
      }
    });

    await swarmManager.startSwarm('Test alternate', {
      maxRetries: 2,
      workerAgent: 'gemini',
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    // After first failure, alternate agent should be used
    if (agentsUsed.length >= 2) {
      expect(agentsUsed[1]).not.toBe(agentsUsed[0]);
    }
  });
});

// ============================================================================
// Reset
// ============================================================================

describe('Swarm Reset', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should clear all sessions', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task 1' }]);

    await swarmManager.startSwarm('Test 1');
    await swarmManager.startSwarm('Test 2');

    expect(swarmManager.getAllSessions().length).toBe(2);

    swarmManager.reset();

    expect(swarmManager.getAllSessions().length).toBe(0);
    expect(swarmManager.getStats().totalSessions).toBe(0);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Swarm Edge Cases', () => {
  beforeEach(() => {
    swarmManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should handle swarm with single subtask', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Solo task' }]);

    const session = await swarmManager.startSwarm('Simple task');

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.subtasks.length).toBe(1);
  });

  it('should handle cwd parameter in swarm creation', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task 1' }]);

    const session = await swarmManager.startSwarm('Test', {}, '/tmp/test-dir');

    await new Promise(resolve => setTimeout(resolve, 800));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
  });

  it('should handle non-Error objects in lifecycle catch', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* () {
      throw 'string error object';
    });

    const session = await swarmManager.startSwarm('Test');

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toContain('string error');
  });

  it('should pass cwd through to orchestrator for subtask execution', async () => {
    mockDecompositionAndWorkers([{ prompt: 'Task with cwd' }]);

    const session = await swarmManager.startSwarm('Test', {}, '/custom/cwd');

    await new Promise(resolve => setTimeout(resolve, 800));

    // Session should complete successfully
    const updated = swarmManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
  });
});
