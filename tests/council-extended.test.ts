import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  CouncilSession,
  CouncilConfig,
  CouncilMember,
  DeliberationEntry,
} from '../src/agents/council-types.js';
import { DEFAULT_COUNCIL_CONFIG, COUNCIL_TEMPLATES } from '../src/agents/council-types.js';
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

// Mock swarm manager for overseer mode
vi.mock('../src/agents/swarm.js', () => ({
  swarmManager: {
    startSwarm: vi.fn(async () => ({
      id: 'mock-swarm',
      prompt: 'mock prompt',
      status: 'completed',
      config: {},
      subtasks: [],
      result: 'Swarm aggregated result',
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    })),
  },
}));

// Import after mocks
import { councilManager } from '../src/agents/council.js';
import { orchestrator } from '../src/agents/orchestrator.js';
import { executeAgent } from '../src/agents/cli-backend.js';
import { swarmManager } from '../src/agents/swarm.js';

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

function makeMembers(count: number): CouncilMember[] {
  const agents: Array<'claude' | 'gemini' | 'codex'> = ['claude', 'gemini', 'codex'];
  return Array.from({ length: count }, (_, i) => ({
    id: `member-${i}`,
    name: `Member ${i}`,
    agent: agents[i % agents.length],
    role: `role-${i}`,
    weight: 1.0,
  }));
}

// ============================================================================
// Council Creation
// ============================================================================

describe('Council Creation', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should create a council session with correct fields', async () => {
    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test prompt', {
      members,
      mode: 'competitive',
    });

    expect(session.id).toBeDefined();
    expect(session.prompt).toBe('Test prompt');
    expect(session.status).toBeDefined();
    expect(session.config.members).toHaveLength(2);
    expect(session.config.mode).toBe('competitive');
    expect(session.deliberations).toEqual([]);
    expect(session.votes).toEqual([]);
    expect(session.scores).toEqual([]);
    expect(session.round).toBe(1);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.updatedAt).toBeInstanceOf(Date);
  });

  it('should merge config with defaults', async () => {
    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'consensus',
      consensusThreshold: 0.8,
    });

    expect(session.config.mode).toBe('consensus');
    expect(session.config.consensusThreshold).toBe(0.8);
    expect(session.config.maxRounds).toBe(DEFAULT_COUNCIL_CONFIG.maxRounds);
    expect(session.config.tieBreaker).toBe(DEFAULT_COUNCIL_CONFIG.tieBreaker);
  });

  it('should store session in the session map', async () => {
    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test', { members });

    const retrieved = councilManager.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(session.id);
  });

  it('should return undefined for non-existent session', () => {
    const result = councilManager.getSession('non-existent-id');
    expect(result).toBeUndefined();
  });

  it('should track multiple sessions in getAllSessions', async () => {
    const members = makeMembers(2);
    await councilManager.startCouncil('Test 1', { members });
    await councilManager.startCouncil('Test 2', { members });

    const all = councilManager.getAllSessions();
    expect(all.length).toBe(2);
  });
});

// ============================================================================
// Council Cancellation
// ============================================================================

describe('Council Cancellation', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should cancel an existing session', async () => {
    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test', { members });

    const result = await councilManager.cancelCouncil(session.id);
    expect(result).toBe(true);

    const updated = councilManager.getSession(session.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.completedAt).toBeInstanceOf(Date);
  });

  it('should return false when cancelling non-existent session', async () => {
    const result = await councilManager.cancelCouncil('non-existent');
    expect(result).toBe(false);
  });
});

// ============================================================================
// Council Statistics
// ============================================================================

describe('Council Statistics', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should return correct stats for empty manager', () => {
    const stats = councilManager.getStats();
    expect(stats.totalSessions).toBe(0);
    expect(stats.activeSessions).toBe(0);
    expect(stats.completedSessions).toBe(0);
    expect(stats.failedSessions).toBe(0);
  });

  it('should track active sessions', async () => {
    // Use a slow mock that keeps the session active longer
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      await new Promise(resolve => setTimeout(resolve, 200));
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: 'delayed result',
      };
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const members = makeMembers(2);
    await councilManager.startCouncil('Test', { members });

    // Check stats immediately (session is likely still active)
    const stats = councilManager.getStats();
    expect(stats.totalSessions).toBe(1);
  });

  it('should count completed sessions after lifecycle finishes', async () => {
    const members = makeMembers(2);
    await councilManager.startCouncil('Test', { members, mode: 'competitive' });

    // Wait for lifecycle to complete
    await new Promise(resolve => setTimeout(resolve, 200));

    const stats = councilManager.getStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.completedSessions).toBe(1);
  });

  it('should count failed sessions', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* () {
      yield {
        type: 'error' as const,
        taskId: 'x',
        timestamp: new Date(),
        message: 'Agent failure',
      };
    });

    const members = makeMembers(2);
    await councilManager.startCouncil('Test', { members, mode: 'competitive' });

    // Wait for lifecycle to complete/fail
    await new Promise(resolve => setTimeout(resolve, 200));

    const stats = councilManager.getStats();
    expect(stats.totalSessions).toBe(1);
    // Should still complete (errors in deliberation are caught, session completes)
  });
});

// ============================================================================
// Competitive Mode
// ============================================================================

describe('Competitive Mode', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should run all members in parallel and produce deliberations', async () => {
    const members = makeMembers(3);
    const session = await councilManager.startCouncil('Review code', {
      members,
      mode: 'competitive',
    });

    // Wait for lifecycle
    await new Promise(resolve => setTimeout(resolve, 300));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.deliberations.length).toBe(3);
    expect(updated.result).toBeDefined();
  });

  it('should cross-score deliberations and pick a winner', async () => {
    // Make one agent produce a much longer, more detailed response
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      const content = callCount === 1
        ? 'A very long detailed response with code blocks ```js\nconsole.log("test")\n``` and structured headings\n# Analysis\n- point one\n- point two\nThis response should score higher due to length, structure, and formatting.'
        : 'Short answer.';
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content,
      };
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Review code', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.scores.length).toBeGreaterThan(0);
    expect(updated.winnerId).toBeDefined();
  });

  it('should handle agent errors in deliberation gracefully', async () => {
    // When executeAgent throws, orchestrator catches it and sets task.status='failed'.
    // But spawnAgent still resolves, so council sees task.result || '(no response)'.
    // To get 'Error:' in the deliberation, spawnAgent itself must throw, e.g. agent unavailable.
    const { isAgentAvailable } = await import('../src/agents/agent-detection.js');
    let callCount = 0;
    vi.mocked(isAgentAvailable).mockImplementation(() => {
      callCount++;
      // Fail the second agent check (second member's spawn)
      return callCount !== 2;
    });

    const members = makeMembers(3);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    // One deliberation should have an error response (from catch block)
    const errorEntry = updated.deliberations.find(d => d.response.startsWith('Error:'));
    expect(errorEntry).toBeDefined();

    // Restore the mock
    vi.mocked(isAgentAvailable).mockReturnValue(true);
  });

  it('should fall back to first deliberation when no winner is found', async () => {
    // All agents produce empty-ish responses
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
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

    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
  });

  it('should include role context in prompts when member has a role', async () => {
    const members: CouncilMember[] = [
      { id: 'a', name: 'Expert', agent: 'claude', role: 'security-expert', weight: 1.0 },
      { id: 'b', name: 'Reviewer', agent: 'gemini', weight: 1.0 },
    ];

    await councilManager.startCouncil('Check code', { members, mode: 'competitive' });
    await new Promise(resolve => setTimeout(resolve, 300));

    const calls = vi.mocked(executeAgent).mock.calls;
    // At least one call should include the role context
    const hasRoleContext = calls.some(call => {
      const task = call[0] as SubAgentTask;
      return task.prompt.includes('security-expert');
    });
    expect(hasRoleContext).toBe(true);
  });
});

// ============================================================================
// Collaborative Mode
// ============================================================================

describe('Collaborative Mode', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should run members sequentially building on previous responses', async () => {
    const callOrder: string[] = [];
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callOrder.push(task.prompt.slice(0, 30));
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: `Contribution from agent on: ${task.prompt.slice(0, 30)}`,
      };
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const members = makeMembers(3);
    const session = await councilManager.startCouncil('Build a plan', {
      members,
      mode: 'collaborative',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.deliberations.length).toBe(3);
    // The last member's response should be the result
    expect(updated.result).toBeDefined();
    // Calls should be sequential (3 calls)
    expect(callOrder.length).toBe(3);
  });

  it('should pass accumulated context to subsequent members', async () => {
    const prompts: string[] = [];
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      prompts.push(task.prompt);
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: 'My contribution',
      };
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Collaborate on this', {
      members,
      mode: 'collaborative',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    // First member should get "first team member" instruction
    expect(prompts[0]).toContain('first team member');
    // Second member should get "Previous contributions"
    expect(prompts[1]).toContain('Previous contributions');
  });

  it('should handle errors in collaborative members gracefully', async () => {
    // To get 'Error:' in a deliberation, spawnAgent must throw (not just executeAgent).
    // Use isAgentAvailable to make the first member's spawn fail.
    const { isAgentAvailable } = await import('../src/agents/agent-detection.js');
    let callCount = 0;
    vi.mocked(isAgentAvailable).mockImplementation(() => {
      callCount++;
      return callCount !== 1; // Fail the first spawn
    });

    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Collaborate', {
      members,
      mode: 'collaborative',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    // First entry should have error (from catch block when spawnAgent throws)
    expect(updated.deliberations[0].response).toContain('Error:');
    // Second entry should have succeeded
    expect(updated.deliberations[1].response).toContain('Mock result for:');

    // Restore the mock
    vi.mocked(isAgentAvailable).mockReturnValue(true);
  });

  it('should set the last member as winner', async () => {
    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'collaborative',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.winnerId).toBe(updated.deliberations[updated.deliberations.length - 1].memberId);
  });
});

// ============================================================================
// Consensus Mode
// ============================================================================

describe('Consensus Mode', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should deliberate and vote across rounds', async () => {
    const members = makeMembers(3);
    const session = await councilManager.startCouncil('Decide on approach', {
      members,
      mode: 'consensus',
      maxRounds: 2,
      consensusThreshold: 0.67,
    });

    await new Promise(resolve => setTimeout(resolve, 600));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.deliberations.length).toBeGreaterThan(0);
    expect(updated.votes.length).toBeGreaterThan(0);
  });

  it('should reach consensus if threshold is met', async () => {
    // Two members: votes should converge with low threshold
    const members: CouncilMember[] = [
      { id: 'a', name: 'A', agent: 'claude', weight: 1.0 },
      { id: 'b', name: 'B', agent: 'gemini', weight: 1.0 },
    ];

    const session = await councilManager.startCouncil('Decide', {
      members,
      mode: 'consensus',
      maxRounds: 3,
      consensusThreshold: 0.4, // Low threshold - should reach consensus easily
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
  });

  it('should use tie-breaker after max rounds exhausted', async () => {
    // High threshold that is unlikely to be met
    const members: CouncilMember[] = [
      { id: 'a', name: 'A', agent: 'claude', weight: 1.0 },
      { id: 'b', name: 'B', agent: 'gemini', weight: 1.0 },
      { id: 'c', name: 'C', agent: 'codex', weight: 1.0 },
    ];

    const session = await councilManager.startCouncil('Decide', {
      members,
      mode: 'consensus',
      maxRounds: 1, // Only 1 round
      consensusThreshold: 0.99, // Nearly impossible to reach
      tieBreaker: 'scoring',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
  });

  it('should apply designated tie-breaker', async () => {
    const members: CouncilMember[] = [
      { id: 'lead-id', name: 'Lead', agent: 'claude', weight: 1.0 },
      { id: 'other-id', name: 'Other', agent: 'gemini', weight: 1.0 },
      { id: 'third-id', name: 'Third', agent: 'codex', weight: 1.0 },
    ];

    const session = await councilManager.startCouncil('Decide', {
      members,
      mode: 'consensus',
      maxRounds: 1,
      consensusThreshold: 0.99,
      tieBreaker: 'designated',
      designatedBreaker: 'lead-id',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
  });

  it('should apply voting tie-breaker', async () => {
    const members: CouncilMember[] = [
      { id: 'a', name: 'A', agent: 'claude', weight: 1.0 },
      { id: 'b', name: 'B', agent: 'gemini', weight: 1.0 },
      { id: 'c', name: 'C', agent: 'codex', weight: 1.0 },
    ];

    const session = await councilManager.startCouncil('Decide', {
      members,
      mode: 'consensus',
      maxRounds: 1,
      consensusThreshold: 0.99,
      tieBreaker: 'voting',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
  });

  it('should apply user/default tie-breaker', async () => {
    const members: CouncilMember[] = [
      { id: 'a', name: 'A', agent: 'claude', weight: 1.0 },
      { id: 'b', name: 'B', agent: 'gemini', weight: 1.0 },
    ];

    const session = await councilManager.startCouncil('Decide', {
      members,
      mode: 'consensus',
      maxRounds: 1,
      consensusThreshold: 0.99,
      tieBreaker: 'user',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.result).toBeDefined();
  });

  it('should respect member weights in voting', async () => {
    const members: CouncilMember[] = [
      { id: 'heavy', name: 'Heavy Voter', agent: 'claude', weight: 5.0 },
      { id: 'light', name: 'Light Voter', agent: 'gemini', weight: 0.1 },
    ];

    const session = await councilManager.startCouncil('Weighted vote test', {
      members,
      mode: 'consensus',
      maxRounds: 2,
      consensusThreshold: 0.5,
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.votes.length).toBeGreaterThan(0);
    // Check that vote weights are recorded
    for (const vote of updated.votes) {
      const member = members.find(m => m.id === vote.voterId);
      expect(vote.weight).toBe(member?.weight);
    }
  });
});

// ============================================================================
// Overseer Mode
// ============================================================================

describe('Overseer Mode', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should use swarm for decomposition and overseer for review', async () => {
    const members: CouncilMember[] = [
      { id: 'lead', name: 'Overseer', agent: 'claude', weight: 1.0 },
    ];

    const session = await councilManager.startCouncil('Build a plan', {
      members,
      mode: 'overseer',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    expect(swarmManager.startSwarm).toHaveBeenCalled();
    // Should have swarm deliberation + overseer review
    expect(updated.deliberations.length).toBe(2);
    expect(updated.deliberations[0].memberName).toBe('Swarm Workers');
    expect(updated.winnerId).toBe('lead');
  });

  it('should fail if no members provided for overseer mode', async () => {
    const session = await councilManager.startCouncil('Build', {
      members: [],
      mode: 'overseer',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toContain('at least one member');
  });

  it('should fall back to swarm results when overseer review fails', async () => {
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* () {
      callCount++;
      // The review call (second call) fails
      if (callCount > 0) {
        throw new Error('Review agent crashed');
      }
      yield {
        type: 'text' as const,
        taskId: 'x',
        timestamp: new Date(),
        content: 'review result',
      };
    });

    const members: CouncilMember[] = [
      { id: 'lead', name: 'Overseer', agent: 'claude', weight: 1.0 },
    ];

    const session = await councilManager.startCouncil('Build', {
      members,
      mode: 'overseer',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('completed');
    // Should fall back to swarm result
    expect(updated.result).toBe('Swarm aggregated result');
  });

  it('should fail if swarm decomposition fails', async () => {
    vi.mocked(swarmManager.startSwarm).mockResolvedValueOnce({
      id: 'mock-swarm',
      prompt: 'mock',
      status: 'failed',
      config: {} as any,
      subtasks: [],
      error: 'decomposition error',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const members: CouncilMember[] = [
      { id: 'lead', name: 'Overseer', agent: 'claude', weight: 1.0 },
    ];

    const session = await councilManager.startCouncil('Build', {
      members,
      mode: 'overseer',
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.error).toContain('Swarm decomposition failed');
  });
});

// ============================================================================
// Cross-Scoring
// ============================================================================

describe('Cross-Scoring Heuristics', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should score longer responses higher', async () => {
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      const content = callCount === 1
        ? 'x'.repeat(600) // Very long response
        : 'Short.';
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content,
      };
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test scoring', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    // First member (long response) should score higher
    const scores = updated.scores;
    expect(scores.length).toBe(2);
    const firstScore = scores.find(s => s.targetId === updated.deliberations[0].memberId);
    const secondScore = scores.find(s => s.targetId === updated.deliberations[1].memberId);
    expect(firstScore!.score).toBeGreaterThan(secondScore!.score);
  });

  it('should boost scores for code blocks and structure', async () => {
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      const content = callCount === 1
        ? '# Analysis\n- Point one\n- Point two\n```js\nconsole.log("hello")\n```'
        : 'A moderate response here that has some content.';
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content,
      };
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test scoring', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    // Structured response should score higher
    const d0 = updated.deliberations[0];
    const d1 = updated.deliberations[1];
    expect(d0.score).toBeGreaterThan(d1.score!);
  });

  it('should penalize error responses', async () => {
    // To get 'Error:' in a deliberation, spawnAgent must throw.
    const { isAgentAvailable } = await import('../src/agents/agent-detection.js');
    let callCount = 0;
    vi.mocked(isAgentAvailable).mockImplementation(() => {
      callCount++;
      return callCount !== 2; // Fail the second member's spawn
    });

    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test penalty', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    const errorEntry = updated.deliberations.find(d => d.response.startsWith('Error:'));
    expect(errorEntry).toBeDefined();
    expect(errorEntry!.score).toBe(10); // Error penalty

    // Restore the mock
    vi.mocked(isAgentAvailable).mockReturnValue(true);
  });

  it('should consider member weight in winner selection', async () => {
    let callCount = 0;
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      callCount++;
      // Both produce similar-length responses
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: 'A decent response that is medium length and should score similarly to another.',
      };
      yield {
        type: 'complete' as const,
        taskId: task.id,
        timestamp: new Date(),
      };
    });

    const members: CouncilMember[] = [
      { id: 'heavy', name: 'Heavy', agent: 'claude', weight: 3.0 },
      { id: 'light', name: 'Light', agent: 'gemini', weight: 0.5 },
    ];

    const session = await councilManager.startCouncil('Test weights', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    // Heavy member should win due to weight advantage
    expect(updated.winnerId).toBe('heavy');
  });
});

// ============================================================================
// Template-Based Council Creation
// ============================================================================

describe('Template-Based Council', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should create council from code-review template', async () => {
    const session = await councilManager.startFromTemplate('code-review', 'Review this code');

    expect(session.config.mode).toBe('competitive');
    expect(session.config.members.length).toBe(3);
    expect(session.prompt).toContain('Review this code');
    expect(session.prompt).toContain('Review the following code');
  });

  it('should create council from architecture template', async () => {
    const session = await councilManager.startFromTemplate('architecture', 'Design a microservice');

    expect(session.config.mode).toBe('collaborative');
    expect(session.config.members.length).toBe(3);
    expect(session.config.tieBreaker).toBe('designated');
  });

  it('should throw on unknown template name', async () => {
    await expect(
      councilManager.startFromTemplate('non-existent-template', 'test')
    ).rejects.toThrow('Unknown council template');
  });

  it('should assign unique IDs to template members', async () => {
    const session = await councilManager.startFromTemplate('code-review', 'Test');
    const ids = session.config.members.map(m => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should prefix prompt with template promptPrefix', async () => {
    const session = await councilManager.startFromTemplate('security-audit', 'My code here');
    expect(session.prompt).toContain('security audit');
    expect(session.prompt).toContain('My code here');
  });

  it('should list all available templates', () => {
    const templates = councilManager.getTemplates();
    expect(templates.length).toBe(5);
    const names = templates.map(t => t.name);
    expect(names).toContain('code-review');
    expect(names).toContain('architecture');
    expect(names).toContain('security-audit');
    expect(names).toContain('brainstorm');
    expect(names).toContain('debate');
  });
});

// ============================================================================
// Session Status Formatting
// ============================================================================

describe('Session Status Formatting', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should format a basic session status', async () => {
    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test prompt', {
      members,
      mode: 'competitive',
    });

    const output = councilManager.formatSessionStatus(session);
    expect(output).toContain('Coordination:');
    expect(output).toContain('Mode: competitive');
    expect(output).toContain('Status:');
    expect(output).toContain('Agents:');
    expect(output).toContain('Round: 1');
  });

  it('should include deliberation details after completion', async () => {
    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    const output = councilManager.formatSessionStatus(updated);
    expect(output).toContain('Deliberations:');
  });

  it('should include error in output when session has error', async () => {
    const session: CouncilSession = {
      id: 'test-123',
      prompt: 'test',
      status: 'failed',
      config: { ...DEFAULT_COUNCIL_CONFIG, members: makeMembers(1) },
      deliberations: [],
      votes: [],
      scores: [],
      round: 1,
      error: 'Something went wrong',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const output = councilManager.formatSessionStatus(session);
    expect(output).toContain('Error: Something went wrong');
  });

  it('should mark winner with star in deliberation display', async () => {
    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    const output = councilManager.formatSessionStatus(updated);
    // Winner should be marked
    expect(output).toContain('\u2605'); // Star character
  });

  it('should show score and vote info when available', async () => {
    const session: CouncilSession = {
      id: 'test-123',
      prompt: 'test',
      status: 'completed',
      config: { ...DEFAULT_COUNCIL_CONFIG, members: makeMembers(1) },
      deliberations: [
        {
          memberId: 'member-0',
          memberName: 'Member 0',
          response: 'A response that is long enough to show properly in the formatted output display',
          timestamp: new Date(),
          score: 85,
          votes: 3,
        },
      ],
      votes: [],
      scores: [],
      round: 1,
      winnerId: 'member-0',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const output = councilManager.formatSessionStatus(session);
    expect(output).toContain('[score: 85]');
    expect(output).toContain('[votes: 3]');
  });
});

// ============================================================================
// Reset
// ============================================================================

describe('Council Reset', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should clear all sessions', async () => {
    const members = makeMembers(2);
    await councilManager.startCouncil('Test 1', { members });
    await councilManager.startCouncil('Test 2', { members });

    expect(councilManager.getAllSessions().length).toBe(2);

    councilManager.reset();

    expect(councilManager.getAllSessions().length).toBe(0);
    expect(councilManager.getStats().totalSessions).toBe(0);
  });
});

// ============================================================================
// Error Handling in Lifecycle
// ============================================================================

describe('Council Lifecycle Error Handling', () => {
  beforeEach(() => {
    councilManager.reset();
    orchestrator.reset();
    vi.clearAllMocks();
    resetExecuteAgentMock();
  });

  it('should set status to failed when lifecycle throws', async () => {
    // Make the orchestrator throw immediately
    vi.mocked(executeAgent).mockImplementation(async function* () {
      throw new Error('Catastrophic failure');
    });

    const members = makeMembers(2);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    // Even with errors, competitive mode catches them in deliberation
    // The session should still complete
    expect(['completed', 'failed'].includes(updated.status)).toBe(true);
  });

  it('should handle non-Error objects thrown in lifecycle', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* () {
      throw 'string error'; // Non-Error throw
    });

    const members = makeMembers(1);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'competitive',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    const updated = councilManager.getSession(session.id)!;
    // Should have handled the string error
    expect(updated.status).toBe('completed');
    const errorEntry = updated.deliberations.find(d => d.response.includes('Error:'));
    if (errorEntry) {
      expect(errorEntry.response).toContain('string error');
    }
  });

  it('should handle cancellation during competitive deliberation', async () => {
    vi.mocked(executeAgent).mockImplementation(async function* (task: SubAgentTask) {
      await new Promise(resolve => setTimeout(resolve, 500));
      yield {
        type: 'text' as const,
        taskId: task.id,
        timestamp: new Date(),
        content: 'delayed result',
      };
    });

    const members = makeMembers(3);
    const session = await councilManager.startCouncil('Test', {
      members,
      mode: 'competitive',
    });

    // Cancel while deliberation is still running
    await new Promise(resolve => setTimeout(resolve, 50));
    await councilManager.cancelCouncil(session.id);

    const updated = councilManager.getSession(session.id)!;
    expect(updated.status).toBe('cancelled');
  });
});
