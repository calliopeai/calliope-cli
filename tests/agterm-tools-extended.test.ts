/**
 * Extended tests for src/agents/tools.ts
 *
 * Covers executeAgtermTool dispatch for all 14 tools, error handling,
 * input validation, result formatting, and integration with mocked
 * orchestrator, swarmManager, and councilManager singletons.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolCall, ToolResult } from '../src/types.js';
import {
  getAgtermTools,
  AGTERM_TOOL_NAMES,
  isAgtermTool,
  executeAgtermTool,
} from '../src/agents/tools.js';
import { orchestrator } from '../src/agents/orchestrator.js';
import { swarmManager } from '../src/agents/swarm.js';
import { councilManager } from '../src/agents/council.js';
import { COUNCIL_TEMPLATES } from '../src/agents/council-types.js';
import type { SubAgentTask, SubAgentTaskStatus, TaskPriority } from '../src/agents/types.js';
import type { SwarmSession, SwarmConfig, SwarmStatus, DecompositionStrategy, AggregationStrategy } from '../src/agents/swarm-types.js';
import type { CouncilSession, CouncilConfig, CouncilStatus, CouncilMode, CouncilMember } from '../src/agents/council-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cwd = '/tmp/agterm-test';

function makeTool(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Date.now()}-${Math.random()}`, name, arguments: args };
}

function makeTask(overrides: Partial<SubAgentTask> = {}): SubAgentTask {
  return {
    id: 'task-123',
    prompt: 'test prompt',
    agent: 'claude',
    status: 'completed' as SubAgentTaskStatus,
    priority: 'normal' as TaskPriority,
    depth: 0,
    childIds: [],
    result: 'Task completed output',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:01Z'),
    ...overrides,
  };
}

function makeSwarmSession(overrides: Partial<SwarmSession> = {}): SwarmSession {
  return {
    id: 'swarm-abc',
    prompt: 'analyze this codebase',
    status: 'executing' as SwarmStatus,
    config: {
      maxWorkers: 3,
      decomposition: 'parallel' as DecompositionStrategy,
      aggregation: 'concatenate' as AggregationStrategy,
      maxRetries: 2,
      subtaskTimeout: 300000,
      workerAgent: 'claude',
      overseerAgent: 'claude',
      useSmartRouting: false,
    } as SwarmConfig,
    subtasks: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCouncilSession(overrides: Partial<CouncilSession> = {}): CouncilSession {
  return {
    id: 'council-xyz',
    prompt: 'review the architecture',
    status: 'deliberating' as CouncilStatus,
    config: {
      mode: 'competitive' as CouncilMode,
      members: [
        { id: 'm1', name: 'Agent A', agent: 'claude', weight: 1.0 },
        { id: 'm2', name: 'Agent B', agent: 'claude', weight: 1.0 },
      ] as CouncilMember[],
      tieBreaker: 'scoring',
      maxRounds: 3,
      consensusThreshold: 0.67,
    } as CouncilConfig,
    deliberations: [],
    votes: [],
    scores: [],
    round: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup - Mock external dependencies
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();

  // Mock orchestrator methods
  vi.spyOn(orchestrator, 'setCwd').mockImplementation(() => {});
  vi.spyOn(orchestrator, 'getTask').mockReturnValue(undefined);
  vi.spyOn(orchestrator, 'cancelTask').mockResolvedValue(undefined);
  vi.spyOn(orchestrator, 'getStats').mockReturnValue({
    totalTasks: 5,
    queuedTasks: 1,
    runningTasks: 2,
    completedTasks: 1,
    failedTasks: 1,
    cancelledTasks: 0,
    maxDepthUsed: 1,
  });
  vi.spyOn(orchestrator, 'spawnAgent').mockResolvedValue(makeTask());

  // Mock swarmManager methods
  vi.spyOn(swarmManager, 'getSession').mockReturnValue(undefined);
  vi.spyOn(swarmManager, 'cancelSwarm').mockResolvedValue(false);
  vi.spyOn(swarmManager, 'startSwarm').mockResolvedValue(makeSwarmSession());
  vi.spyOn(swarmManager, 'formatSessionStatus').mockReturnValue('Swarm status line');

  // Mock councilManager methods
  vi.spyOn(councilManager, 'getSession').mockReturnValue(undefined);
  vi.spyOn(councilManager, 'cancelCouncil').mockResolvedValue(false);
  vi.spyOn(councilManager, 'startCouncil').mockResolvedValue(makeCouncilSession());
  vi.spyOn(councilManager, 'startFromTemplate').mockResolvedValue(makeCouncilSession());
  vi.spyOn(councilManager, 'formatSessionStatus').mockReturnValue('Council status line');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Tool definitions
// ===========================================================================

describe('getAgtermTools - tool definitions', () => {
  it('should return exactly 14 tools', () => {
    const tools = getAgtermTools();
    expect(tools).toHaveLength(14);
  });

  it('should have correct names for all tools', () => {
    const tools = getAgtermTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual([
      'create_tool', 'list_dynamic_tools', 'remove_tool',
      'spawn_agent', 'check_agent', 'list_agents', 'cancel_agent',
      'start_swarm', 'check_swarm', 'cancel_swarm',
      'start_council', 'check_council', 'cancel_council',
      'run_command',
    ]);
  });

  it('spawn_agent should list available agents in description', () => {
    const tools = getAgtermTools();
    const tool = tools.find(t => t.name === 'spawn_agent')!;
    expect(tool.description).toContain('Available agents:');
    expect(tool.description).toContain('calliope');
    expect(tool.description).toContain('claude');
  });

  it('start_swarm should have strategy and aggregation params', () => {
    const tools = getAgtermTools();
    const tool = tools.find(t => t.name === 'start_swarm')!;
    expect(tool.parameters.properties.strategy).toBeDefined();
    expect(tool.parameters.properties.strategy.enum).toContain('parallel');
    expect(tool.parameters.properties.strategy.enum).toContain('sequential');
    expect(tool.parameters.properties.strategy.enum).toContain('map-reduce');
    expect(tool.parameters.properties.strategy.enum).toContain('pipeline');
    expect(tool.parameters.properties.aggregation.enum).toContain('concatenate');
    expect(tool.parameters.properties.aggregation.enum).toContain('merge-dedupe');
    expect(tool.parameters.properties.aggregation.enum).toContain('summarize');
    expect(tool.parameters.properties.aggregation.enum).toContain('structured');
  });

  it('start_council should have template param with template names', () => {
    const tools = getAgtermTools();
    const tool = tools.find(t => t.name === 'start_council')!;
    expect(tool.parameters.properties.template).toBeDefined();
    expect(tool.parameters.properties.template.enum).toContain('code-review');
    expect(tool.parameters.properties.template.enum).toContain('architecture');
    expect(tool.parameters.properties.template.enum).toContain('debate');
  });

  it('start_council description should list council templates', () => {
    const tools = getAgtermTools();
    const tool = tools.find(t => t.name === 'start_council')!;
    expect(tool.description).toContain('code-review');
    expect(tool.description).toContain('brainstorm');
  });
});

// ===========================================================================
// isAgtermTool
// ===========================================================================

describe('isAgtermTool - comprehensive', () => {
  it('should return true for all agterm tool names', () => {
    for (const name of AGTERM_TOOL_NAMES) {
      expect(isAgtermTool(name)).toBe(true);
    }
  });

  it('should return false for base tool names', () => {
    const baseTool = ['shell', 'read_file', 'write_file', 'think', 'web_search', 'git', 'mermaid', 'execute_code'];
    for (const name of baseTool) {
      expect(isAgtermTool(name)).toBe(false);
    }
  });

  it('should return false for empty string', () => {
    expect(isAgtermTool('')).toBe(false);
  });

  it('should return false for partial matches', () => {
    expect(isAgtermTool('spawn')).toBe(false);
    expect(isAgtermTool('agent')).toBe(false);
    expect(isAgtermTool('swarm')).toBe(false);
  });
});

// ===========================================================================
// AGTERM_TOOL_NAMES
// ===========================================================================

describe('AGTERM_TOOL_NAMES', () => {
  it('should contain 14 tool names', () => {
    expect(AGTERM_TOOL_NAMES).toHaveLength(14);
  });

  it('should include swarm tools', () => {
    expect(AGTERM_TOOL_NAMES).toContain('start_swarm');
    expect(AGTERM_TOOL_NAMES).toContain('check_swarm');
    expect(AGTERM_TOOL_NAMES).toContain('cancel_swarm');
  });

  it('should include council tools', () => {
    expect(AGTERM_TOOL_NAMES).toContain('start_council');
    expect(AGTERM_TOOL_NAMES).toContain('check_council');
    expect(AGTERM_TOOL_NAMES).toContain('cancel_council');
  });
});

// ===========================================================================
// executeAgtermTool - spawn_agent
// ===========================================================================

describe('executeAgtermTool - spawn_agent', () => {
  it('should set cwd on orchestrator', async () => {
    // Mock agent detection
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'getAvailableAgents').mockReturnValue(['claude']);
    vi.spyOn(agentDetection, 'detectAgents').mockReturnValue([]);

    await executeAgtermTool(makeTool('spawn_agent', { prompt: 'do something' }), cwd);
    expect(orchestrator.setCwd).toHaveBeenCalledWith(cwd);
  });

  it('should error when prompt is empty', async () => {
    const result = await executeAgtermTool(makeTool('spawn_agent', { prompt: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('prompt is required');
  });

  it('should error when prompt is missing', async () => {
    const result = await executeAgtermTool(makeTool('spawn_agent', {}), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('prompt is required');
  });

  it('should error when agent is not available', async () => {
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'getAvailableAgents').mockReturnValue([]);
    vi.spyOn(agentDetection, 'detectAgents').mockReturnValue([{
      type: 'claude',
      command: 'claude',
      args: ['--print'],
      envVar: 'ANTHROPIC_API_KEY',
      available: false,
      reason: 'ANTHROPIC_API_KEY not set',
    }]);

    const result = await executeAgtermTool(makeTool('spawn_agent', {
      prompt: 'do something',
      agent: 'claude',
    }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain("Agent 'claude' is not available");
    expect(result.result).toContain('ANTHROPIC_API_KEY not set');
  });

  it('should return background result with task ID', async () => {
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'getAvailableAgents').mockReturnValue(['claude']);

    const bgTask = makeTask({ id: 'bg-task-id', status: 'queued', priority: 'high' });
    vi.mocked(orchestrator.spawnAgent).mockResolvedValue(bgTask);

    const result = await executeAgtermTool(makeTool('spawn_agent', {
      prompt: 'background work',
      agent: 'claude',
      background: 'true',
      priority: 'high',
    }), cwd);

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Sub-agent (claude) spawned in background');
    expect(result.result).toContain('bg-task-id');
    expect(result.result).toContain('check_agent');
  });

  it('should return foreground completed result', async () => {
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'getAvailableAgents').mockReturnValue(['claude']);

    const completedTask = makeTask({ status: 'completed', result: 'Done analyzing' });
    vi.mocked(orchestrator.spawnAgent).mockResolvedValue(completedTask);

    const result = await executeAgtermTool(makeTool('spawn_agent', {
      prompt: 'analyze code',
      agent: 'claude',
    }), cwd);

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('[claude] Task completed successfully');
    expect(result.result).toContain('Done analyzing');
  });

  it('should return foreground failed result', async () => {
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'getAvailableAgents').mockReturnValue(['gemini']);

    const failedTask = makeTask({ agent: 'gemini', status: 'failed', error: 'API rate limited', result: undefined });
    vi.mocked(orchestrator.spawnAgent).mockResolvedValue(failedTask);

    const result = await executeAgtermTool(makeTool('spawn_agent', {
      prompt: 'do something',
      agent: 'gemini',
    }), cwd);

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('[gemini] Task failed');
    expect(result.result).toContain('API rate limited');
  });

  it('should default agent to calliope when not specified', async () => {
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'getAvailableAgents').mockReturnValue(['calliope']);

    await executeAgtermTool(makeTool('spawn_agent', { prompt: 'test' }), cwd);

    expect(orchestrator.spawnAgent).toHaveBeenCalledWith(
      'test', 'calliope', expect.objectContaining({ background: false, priority: 'normal' })
    );
  });

  it('should handle orchestrator.spawnAgent throwing an error', async () => {
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'getAvailableAgents').mockReturnValue(['claude']);

    vi.mocked(orchestrator.spawnAgent).mockRejectedValue(new Error('Queue is full'));

    const result = await executeAgtermTool(makeTool('spawn_agent', {
      prompt: 'overload',
      agent: 'claude',
    }), cwd);

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Error spawning agent');
    expect(result.result).toContain('Queue is full');
  });

  it('should parse boolean background from string "false"', async () => {
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'getAvailableAgents').mockReturnValue(['calliope']);

    await executeAgtermTool(makeTool('spawn_agent', {
      prompt: 'test',
      background: 'false',
    }), cwd);

    expect(orchestrator.spawnAgent).toHaveBeenCalledWith(
      'test', 'calliope', expect.objectContaining({ background: false })
    );
  });
});

// ===========================================================================
// executeAgtermTool - check_agent
// ===========================================================================

describe('executeAgtermTool - check_agent', () => {
  it('should error when taskId is empty', async () => {
    const result = await executeAgtermTool(makeTool('check_agent', { taskId: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('taskId is required');
  });

  it('should error when taskId is missing', async () => {
    const result = await executeAgtermTool(makeTool('check_agent', {}), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('taskId is required');
  });

  it('should return "not found" for unknown task', async () => {
    vi.mocked(orchestrator.getTask).mockReturnValue(undefined);

    const result = await executeAgtermTool(makeTool('check_agent', { taskId: 'unknown-id' }), cwd);
    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Task not found: unknown-id');
  });

  it('should return full task status for found task', async () => {
    const task = makeTask({
      id: 'found-task',
      agent: 'gemini',
      status: 'running',
      priority: 'high',
      depth: 1,
      startedAt: new Date('2025-01-01T00:00:00Z'),
      childIds: ['child-1', 'child-2'],
    });
    vi.mocked(orchestrator.getTask).mockReturnValue(task);

    const result = await executeAgtermTool(makeTool('check_agent', { taskId: 'found-task' }), cwd);
    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Task: found-task');
    expect(result.result).toContain('Agent: gemini');
    expect(result.result).toContain('Status: running');
    expect(result.result).toContain('Priority: high');
    expect(result.result).toContain('Depth: 1');
    expect(result.result).toContain('Started:');
    expect(result.result).toContain('Children: 2');
  });

  it('should include completedAt when present', async () => {
    const task = makeTask({
      id: 'done-task',
      status: 'completed',
      completedAt: new Date('2025-01-01T00:01:00Z'),
    });
    vi.mocked(orchestrator.getTask).mockReturnValue(task);

    const result = await executeAgtermTool(makeTool('check_agent', { taskId: 'done-task' }), cwd);
    expect(result.result).toContain('Completed:');
  });

  it('should include result when present', async () => {
    const task = makeTask({ result: 'The analysis is complete' });
    vi.mocked(orchestrator.getTask).mockReturnValue(task);

    const result = await executeAgtermTool(makeTool('check_agent', { taskId: 'x' }), cwd);
    expect(result.result).toContain('Result:');
    expect(result.result).toContain('The analysis is complete');
  });

  it('should include error when present', async () => {
    const task = makeTask({ status: 'failed', error: 'Connection refused', result: undefined });
    vi.mocked(orchestrator.getTask).mockReturnValue(task);

    const result = await executeAgtermTool(makeTool('check_agent', { taskId: 'x' }), cwd);
    expect(result.result).toContain('Error:');
    expect(result.result).toContain('Connection refused');
  });
});

// ===========================================================================
// executeAgtermTool - list_agents
// ===========================================================================

describe('executeAgtermTool - list_agents', () => {
  it('should return agent availability and orchestrator stats', async () => {
    const agentDetection = await import('../src/agents/agent-detection.js');
    vi.spyOn(agentDetection, 'detectAgents').mockReturnValue([
      { type: 'claude', command: 'claude', args: ['--print'], envVar: 'ANTHROPIC_API_KEY', available: true },
      { type: 'gemini', command: 'gemini', args: [], envVar: 'GOOGLE_API_KEY', available: false, reason: 'GOOGLE_API_KEY not set' },
    ]);

    const result = await executeAgtermTool(makeTool('list_agents', {}), cwd);
    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Available Agents:');
    expect(result.result).toContain('claude:');
    expect(result.result).toContain('Ready');
    expect(result.result).toContain('gemini:');
    expect(result.result).toContain('GOOGLE_API_KEY not set');
    expect(result.result).toContain('Orchestrator Stats:');
    expect(result.result).toContain('Running: 2');
    expect(result.result).toContain('Queued: 1');
    expect(result.result).toContain('Completed: 1');
    expect(result.result).toContain('Total: 5');
  });
});

// ===========================================================================
// executeAgtermTool - cancel_agent
// ===========================================================================

describe('executeAgtermTool - cancel_agent', () => {
  it('should error when taskId is empty', async () => {
    const result = await executeAgtermTool(makeTool('cancel_agent', { taskId: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('taskId is required');
  });

  it('should return "not found" for unknown task', async () => {
    vi.mocked(orchestrator.getTask).mockReturnValue(undefined);

    const result = await executeAgtermTool(makeTool('cancel_agent', { taskId: 'missing' }), cwd);
    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Task not found: missing');
  });

  it('should cancel and confirm when task exists', async () => {
    vi.mocked(orchestrator.getTask).mockReturnValue(makeTask({ id: 'cancel-me', status: 'running' }));

    const result = await executeAgtermTool(makeTool('cancel_agent', { taskId: 'cancel-me' }), cwd);
    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Task cancel-me cancelled');
    expect(orchestrator.cancelTask).toHaveBeenCalledWith('cancel-me');
  });
});

// ===========================================================================
// executeAgtermTool - start_swarm
// ===========================================================================

describe('executeAgtermTool - start_swarm', () => {
  it('should error when prompt is empty', async () => {
    const result = await executeAgtermTool(makeTool('start_swarm', { prompt: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('prompt is required');
  });

  it('should start a swarm with defaults', async () => {
    const session = makeSwarmSession({ id: 'swarm-001', status: 'decomposing' });
    vi.mocked(swarmManager.startSwarm).mockResolvedValue(session);

    const result = await executeAgtermTool(makeTool('start_swarm', {
      prompt: 'analyze the whole codebase',
    }), cwd);

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Swarm started');
    expect(result.result).toContain('swarm-001');
    expect(result.result).toContain('Strategy: parallel');
    expect(result.result).toContain('check_swarm');
    expect(swarmManager.startSwarm).toHaveBeenCalledWith(
      'analyze the whole codebase',
      expect.objectContaining({ decomposition: 'parallel', aggregation: 'concatenate', maxWorkers: 3, workerAgent: 'claude' }),
      cwd,
    );
  });

  it('should pass custom strategy and aggregation', async () => {
    vi.mocked(swarmManager.startSwarm).mockResolvedValue(makeSwarmSession());

    await executeAgtermTool(makeTool('start_swarm', {
      prompt: 'test',
      strategy: 'map-reduce',
      aggregation: 'structured',
      maxWorkers: 5,
      workerAgent: 'gemini',
    }), cwd);

    expect(swarmManager.startSwarm).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({
        decomposition: 'map-reduce',
        aggregation: 'structured',
        maxWorkers: 5,
        workerAgent: 'gemini',
      }),
      cwd,
    );
  });

  it('should enable smart routing when requested', async () => {
    vi.mocked(swarmManager.startSwarm).mockResolvedValue(makeSwarmSession());

    await executeAgtermTool(makeTool('start_swarm', {
      prompt: 'test',
      useSmartRouting: 'true',
    }), cwd);

    expect(swarmManager.startSwarm).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ useSmartRouting: true }),
      cwd,
    );
  });

  it('should return error when swarmManager throws', async () => {
    vi.mocked(swarmManager.startSwarm).mockRejectedValue(new Error('No agents available'));

    const result = await executeAgtermTool(makeTool('start_swarm', {
      prompt: 'failing task',
    }), cwd);

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Error starting swarm');
    expect(result.result).toContain('No agents available');
  });
});

// ===========================================================================
// executeAgtermTool - check_swarm
// ===========================================================================

describe('executeAgtermTool - check_swarm', () => {
  it('should error when sessionId is empty', async () => {
    const result = await executeAgtermTool(makeTool('check_swarm', { sessionId: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('sessionId is required');
  });

  it('should return "not found" for unknown session', async () => {
    vi.mocked(swarmManager.getSession).mockReturnValue(undefined);

    const result = await executeAgtermTool(makeTool('check_swarm', { sessionId: 'missing' }), cwd);
    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Swarm session not found: missing');
  });

  it('should return formatted status for active session', async () => {
    vi.mocked(swarmManager.getSession).mockReturnValue(makeSwarmSession({ status: 'executing' }));
    vi.mocked(swarmManager.formatSessionStatus).mockReturnValue('Swarm: abc\nStatus: executing\nSubtasks: 2/3 done');

    const result = await executeAgtermTool(makeTool('check_swarm', { sessionId: 'abc' }), cwd);
    expect(result.result).toContain('Swarm: abc');
    expect(result.result).toContain('Status: executing');
  });

  it('should include result for completed session', async () => {
    vi.mocked(swarmManager.getSession).mockReturnValue(makeSwarmSession({
      status: 'completed',
      result: 'All subtasks done. Summary here.',
    }));

    const result = await executeAgtermTool(makeTool('check_swarm', { sessionId: 'x' }), cwd);
    expect(result.result).toContain('Result:');
    expect(result.result).toContain('All subtasks done. Summary here.');
  });

  it('should include error for failed session', async () => {
    vi.mocked(swarmManager.getSession).mockReturnValue(makeSwarmSession({
      status: 'failed',
      error: 'Decomposition timeout',
    }));

    const result = await executeAgtermTool(makeTool('check_swarm', { sessionId: 'x' }), cwd);
    expect(result.result).toContain('Error: Decomposition timeout');
  });
});

// ===========================================================================
// executeAgtermTool - cancel_swarm
// ===========================================================================

describe('executeAgtermTool - cancel_swarm', () => {
  it('should error when sessionId is empty', async () => {
    const result = await executeAgtermTool(makeTool('cancel_swarm', { sessionId: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('sessionId is required');
  });

  it('should return "not found" when cancel returns false', async () => {
    vi.mocked(swarmManager.cancelSwarm).mockResolvedValue(false);

    const result = await executeAgtermTool(makeTool('cancel_swarm', { sessionId: 'ghost' }), cwd);
    expect(result.result).toContain('Swarm session not found: ghost');
  });

  it('should confirm cancellation when successful', async () => {
    vi.mocked(swarmManager.cancelSwarm).mockResolvedValue(true);

    const result = await executeAgtermTool(makeTool('cancel_swarm', { sessionId: 'swarm-1' }), cwd);
    expect(result.result).toContain('Swarm session swarm-1 cancelled');
  });
});

// ===========================================================================
// executeAgtermTool - start_council
// ===========================================================================

describe('executeAgtermTool - start_council', () => {
  it('should error when prompt is empty', async () => {
    const result = await executeAgtermTool(makeTool('start_council', { prompt: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('prompt is required');
  });

  it('should start council with template when provided', async () => {
    const session = makeCouncilSession({
      id: 'council-tmpl',
      config: {
        mode: 'competitive',
        members: [
          { id: 'm1', name: 'Reviewer A', agent: 'claude', weight: 1.0 },
          { id: 'm2', name: 'Reviewer B', agent: 'gemini', weight: 1.0 },
        ],
        tieBreaker: 'scoring',
        maxRounds: 3,
        consensusThreshold: 0.67,
      },
    });
    vi.mocked(councilManager.startFromTemplate).mockResolvedValue(session);

    const result = await executeAgtermTool(makeTool('start_council', {
      prompt: 'review this PR',
      template: 'code-review',
    }), cwd);

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Coordinated swarm started');
    expect(result.result).toContain('council-tmpl');
    expect(result.result).toContain('competitive');
    expect(result.result).toContain('Template: code-review');
    expect(councilManager.startFromTemplate).toHaveBeenCalledWith('code-review', 'review this PR', cwd);
  });

  it('should start council without template using default members', async () => {
    const session = makeCouncilSession({
      id: 'council-custom',
      config: {
        mode: 'collaborative',
        members: [
          { id: 'm1', name: 'Agent A', agent: 'claude', weight: 1.0 },
          { id: 'm2', name: 'Agent B', agent: 'claude', weight: 1.0 },
          { id: 'm3', name: 'Agent C', agent: 'claude', weight: 1.0 },
        ],
        tieBreaker: 'scoring',
        maxRounds: 3,
        consensusThreshold: 0.67,
      },
    });
    vi.mocked(councilManager.startCouncil).mockResolvedValue(session);

    const result = await executeAgtermTool(makeTool('start_council', {
      prompt: 'brainstorm ideas',
      mode: 'collaborative',
    }), cwd);

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Coordinated swarm started');
    expect(result.result).toContain('council-custom');
    expect(result.result).not.toContain('Template:');
    expect(councilManager.startCouncil).toHaveBeenCalledWith(
      'brainstorm ideas',
      expect.objectContaining({ mode: 'collaborative' }),
      cwd,
    );
  });

  it('should default mode to competitive when not specified', async () => {
    vi.mocked(councilManager.startCouncil).mockResolvedValue(makeCouncilSession());

    await executeAgtermTool(makeTool('start_council', { prompt: 'test' }), cwd);

    expect(councilManager.startCouncil).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({ mode: 'competitive' }),
      cwd,
    );
  });

  it('should handle error from councilManager', async () => {
    vi.mocked(councilManager.startCouncil).mockRejectedValue(new Error('No agents configured'));

    const result = await executeAgtermTool(makeTool('start_council', { prompt: 'test' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('Error starting coordination');
    expect(result.result).toContain('No agents configured');
  });
});

// ===========================================================================
// executeAgtermTool - check_council
// ===========================================================================

describe('executeAgtermTool - check_council', () => {
  it('should error when sessionId is empty', async () => {
    const result = await executeAgtermTool(makeTool('check_council', { sessionId: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('sessionId is required');
  });

  it('should return "not found" for unknown session', async () => {
    vi.mocked(councilManager.getSession).mockReturnValue(undefined);

    const result = await executeAgtermTool(makeTool('check_council', { sessionId: 'missing' }), cwd);
    expect(result.result).toContain('Council session not found: missing');
  });

  it('should return formatted status for active session', async () => {
    vi.mocked(councilManager.getSession).mockReturnValue(makeCouncilSession());
    vi.mocked(councilManager.formatSessionStatus).mockReturnValue('Council: xyz\nMode: competitive\nStatus: deliberating');

    const result = await executeAgtermTool(makeTool('check_council', { sessionId: 'xyz' }), cwd);
    expect(result.result).toContain('Council: xyz');
  });

  it('should include result for completed session', async () => {
    vi.mocked(councilManager.getSession).mockReturnValue(makeCouncilSession({
      status: 'completed',
      result: 'The council recommends approach B.',
    }));

    const result = await executeAgtermTool(makeTool('check_council', { sessionId: 'x' }), cwd);
    expect(result.result).toContain('Result:');
    expect(result.result).toContain('The council recommends approach B.');
  });

  it('should include error for failed session', async () => {
    vi.mocked(councilManager.getSession).mockReturnValue(makeCouncilSession({
      status: 'failed',
      error: 'All agents failed to respond',
    }));

    const result = await executeAgtermTool(makeTool('check_council', { sessionId: 'x' }), cwd);
    expect(result.result).toContain('Error: All agents failed to respond');
  });
});

// ===========================================================================
// executeAgtermTool - cancel_council
// ===========================================================================

describe('executeAgtermTool - cancel_council', () => {
  it('should error when sessionId is empty', async () => {
    const result = await executeAgtermTool(makeTool('cancel_council', { sessionId: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('sessionId is required');
  });

  it('should return "not found" when cancel returns false', async () => {
    vi.mocked(councilManager.cancelCouncil).mockResolvedValue(false);

    const result = await executeAgtermTool(makeTool('cancel_council', { sessionId: 'ghost' }), cwd);
    expect(result.result).toContain('Council session not found: ghost');
  });

  it('should confirm cancellation when successful', async () => {
    vi.mocked(councilManager.cancelCouncil).mockResolvedValue(true);

    const result = await executeAgtermTool(makeTool('cancel_council', { sessionId: 'council-1' }), cwd);
    expect(result.result).toContain('Council session council-1 cancelled');
  });
});

// ===========================================================================
// executeAgtermTool - unknown tool
// ===========================================================================

describe('executeAgtermTool - unknown tool', () => {
  it('should return error for unknown agterm tool', async () => {
    const result = await executeAgtermTool(makeTool('unknown_agterm_tool', {}), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('Unknown agent tool: unknown_agterm_tool');
  });
});

// ===========================================================================
// executeAgtermTool - top-level error handling
// ===========================================================================

describe('executeAgtermTool - top-level error handling', () => {
  it('should catch and return errors thrown within the try block', async () => {
    // Force orchestrator.getStats (used by list_agents inside try) to throw
    vi.mocked(orchestrator.getStats).mockImplementation(() => {
      throw new Error('Unexpected crash');
    });

    const result = await executeAgtermTool(makeTool('list_agents', {}), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('Error: Unexpected crash');
  });

  it('should handle non-Error thrown values', async () => {
    vi.mocked(orchestrator.getStats).mockImplementation(() => {
      throw 'string error thrown';
    });

    const result = await executeAgtermTool(makeTool('list_agents', {}), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('string error thrown');
  });
});

// ===========================================================================
// toolCallId propagation
// ===========================================================================

describe('toolCallId propagation', () => {
  it('should return the same toolCallId from the input ToolCall', async () => {
    const toolCall = { id: 'unique-call-id-999', name: 'list_agents', arguments: {} };
    const result = await executeAgtermTool(toolCall, cwd);
    expect(result.toolCallId).toBe('unique-call-id-999');
  });

  it('should propagate toolCallId even on error', async () => {
    const toolCall = { id: 'err-call-id', name: 'spawn_agent', arguments: {} };
    const result = await executeAgtermTool(toolCall, cwd);
    expect(result.toolCallId).toBe('err-call-id');
  });
});

// ===========================================================================
// executeAgtermTool - run_command
// ===========================================================================

import { setCommandDispatcher, getCommandDispatcher } from '../src/agents/tools.js';

describe('executeAgtermTool - run_command', () => {
  beforeEach(() => {
    // Ensure dispatcher is null at start of each test
    setCommandDispatcher(null as unknown as (command: string) => Promise<string>);
  });

  afterEach(() => {
    setCommandDispatcher(null as unknown as (command: string) => Promise<string>);
  });

  it('should error when command is empty', async () => {
    const result = await executeAgtermTool(makeTool('run_command', { command: '' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('command is required');
  });

  it('should error when command is missing', async () => {
    const result = await executeAgtermTool(makeTool('run_command', {}), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('command is required');
  });

  it('should error when command does not start with /', async () => {
    const result = await executeAgtermTool(makeTool('run_command', { command: 'swarm do stuff' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('command must start with /');
  });

  it('should error when command is blocked /exit', async () => {
    const result = await executeAgtermTool(makeTool('run_command', { command: '/exit' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('cannot be invoked by the agent');
  });

  it('should error when command is blocked /quit', async () => {
    const result = await executeAgtermTool(makeTool('run_command', { command: '/quit now' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('cannot be invoked by the agent');
  });

  it('should error when command is blocked /clear', async () => {
    const result = await executeAgtermTool(makeTool('run_command', { command: '/clear' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('cannot be invoked by the agent');
  });

  it('should error when command is blocked /unstick', async () => {
    const result = await executeAgtermTool(makeTool('run_command', { command: '/unstick' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('cannot be invoked by the agent');
  });

  it('should error when commandDispatcher is not set', async () => {
    // Dispatcher is null (set in beforeEach)
    const result = await executeAgtermTool(makeTool('run_command', { command: '/swarm test' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('command dispatcher not initialized');
  });

  it('should execute command when dispatcher is set', async () => {
    setCommandDispatcher(async (cmd: string) => `Executed: ${cmd}`);

    const result = await executeAgtermTool(makeTool('run_command', { command: '/swarm analyze codebase' }), cwd);
    expect(result.isError).toBeUndefined();
    expect(result.result).toBe('Executed: /swarm analyze codebase');
  });

  it('should return error when dispatcher throws', async () => {
    setCommandDispatcher(async () => { throw new Error('Command failed'); });

    const result = await executeAgtermTool(makeTool('run_command', { command: '/agents' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('Error executing command');
    expect(result.result).toContain('Command failed');
  });

  it('should trim whitespace from command', async () => {
    setCommandDispatcher(async (cmd: string) => `ran: ${cmd}`);

    const result = await executeAgtermTool(makeTool('run_command', { command: '  /swarm test  ' }), cwd);
    expect(result.isError).toBeUndefined();
    expect(result.result).toBe('ran: /swarm test');
  });

  it('should handle non-Error thrown from dispatcher', async () => {
    setCommandDispatcher(async () => { throw 'string error'; });

    const result = await executeAgtermTool(makeTool('run_command', { command: '/agents' }), cwd);
    expect(result.isError).toBe(true);
    expect(result.result).toContain('string error');
  });
});

// ===========================================================================
// setCommandDispatcher / getCommandDispatcher
// ===========================================================================

describe('setCommandDispatcher / getCommandDispatcher', () => {
  afterEach(() => {
    setCommandDispatcher(null as unknown as (command: string) => Promise<string>);
  });

  it('getCommandDispatcher should return null when not set', () => {
    setCommandDispatcher(null as unknown as (command: string) => Promise<string>);
    expect(getCommandDispatcher()).toBeNull();
  });

  it('getCommandDispatcher should return the set dispatcher', () => {
    const dispatcher = async (cmd: string) => `result: ${cmd}`;
    setCommandDispatcher(dispatcher);
    expect(getCommandDispatcher()).toBe(dispatcher);
  });

  it('dispatcher should be callable via getCommandDispatcher', async () => {
    setCommandDispatcher(async (cmd) => `output for ${cmd}`);
    const dispatcher = getCommandDispatcher();
    expect(dispatcher).not.toBeNull();
    const output = await dispatcher!('/agents');
    expect(output).toBe('output for /agents');
  });
});

// ===========================================================================
// executeAgtermTool - spawn_agent with agentDef
// ===========================================================================

describe('executeAgtermTool - spawn_agent with agentDef', () => {
  it('should return error when agentDef is not found', async () => {
    const configLoader = await import('../src/agents/agent-config-loader.js');
    vi.spyOn(configLoader, 'getAgent').mockReturnValue(null);
    vi.spyOn(configLoader, 'listAgentDefs').mockReturnValue([]);

    const result = await executeAgtermTool(makeTool('spawn_agent', {
      prompt: 'do stuff',
      agentDef: 'nonexistent-agent',
    }), cwd);

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Agent definition 'nonexistent-agent' not found");
  });

  it('should use agent def settings when agentDef is found and executor is not cli', async () => {
    const configLoader = await import('../src/agents/agent-config-loader.js');
    vi.spyOn(configLoader, 'getAgent').mockReturnValue({
      name: 'my-agent',
      engine: 'claude-sdk' as const,
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      instructions: 'You are a specialized agent',
      limits: { timeout: 60000 },
    } as Parameters<typeof configLoader.getAgent>[0] extends string ? never : never);
    vi.spyOn(configLoader, 'mapEngineToAgentType').mockReturnValue('calliope');

    vi.mocked(orchestrator.spawnAgent).mockResolvedValue(makeTask({ status: 'completed', result: 'done' }));

    const result = await executeAgtermTool(makeTool('spawn_agent', {
      prompt: 'do something specialized',
      agentDef: 'my-agent',
    }), cwd);

    expect(result.isError).toBeUndefined();
    expect(orchestrator.spawnAgent).toHaveBeenCalledWith(
      'do something specialized',
      expect.any(String),
      expect.objectContaining({
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        systemPrompt: 'You are a specialized agent',
        timeout: 60000,
      })
    );
  });
});

// ===========================================================================
// executeAgtermTool - start_council with team
// ===========================================================================

describe('executeAgtermTool - start_council with team', () => {
  it('should return error when team is not found', async () => {
    const configLoader = await import('../src/agents/agent-config-loader.js');
    vi.spyOn(configLoader, 'getTeam').mockReturnValue(null);
    vi.spyOn(configLoader, 'listTeamDefs').mockReturnValue([]);

    const result = await executeAgtermTool(makeTool('start_council', {
      prompt: 'review this',
      team: 'nonexistent-team',
    }), cwd);

    expect(result.isError).toBe(true);
    expect(result.result).toContain("Team 'nonexistent-team' not found");
  });

  it('should start council with team definition when team is found', async () => {
    const configLoader = await import('../src/agents/agent-config-loader.js');
    vi.spyOn(configLoader, 'getTeam').mockReturnValue({
      name: 'code-review-team',
      mode: 'competitive' as const,
      members: [
        { name: 'Reviewer A', agent: 'claude' as const, role: 'reviewer' as const, weight: 1.0 },
        { name: 'Reviewer B', agent: 'gemini' as const, role: 'reviewer' as const, weight: 1.0 },
      ],
      promptPrefix: 'Please review carefully:',
      council: {
        tieBreaker: 'scoring' as const,
        maxRounds: 3,
        consensusThreshold: 0.67,
      },
    } as ReturnType<typeof configLoader.getTeam>);

    vi.mocked(councilManager.startCouncil).mockResolvedValue(makeCouncilSession({
      id: 'team-council-1',
      status: 'deliberating',
    }));

    const result = await executeAgtermTool(makeTool('start_council', {
      prompt: 'review this PR',
      team: 'code-review-team',
    }), cwd);

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Coordinated swarm started');
    // Should prefix prompt with team promptPrefix
    expect(councilManager.startCouncil).toHaveBeenCalledWith(
      expect.stringContaining('Please review carefully:'),
      expect.objectContaining({ mode: 'competitive' }),
      cwd,
    );
  });

  it('should start council with team that has no promptPrefix', async () => {
    const configLoader = await import('../src/agents/agent-config-loader.js');
    vi.spyOn(configLoader, 'getTeam').mockReturnValue({
      name: 'simple-team',
      mode: 'collaborative' as const,
      members: [
        { name: 'Agent A', agent: 'claude' as const, role: 'worker' as const, weight: 1.0 },
      ],
      // No promptPrefix
    } as ReturnType<typeof configLoader.getTeam>);

    vi.mocked(councilManager.startCouncil).mockResolvedValue(makeCouncilSession({
      id: 'simple-council',
      status: 'deliberating',
    }));

    const result = await executeAgtermTool(makeTool('start_council', {
      prompt: 'just do it',
      team: 'simple-team',
    }), cwd);

    expect(result.isError).toBeUndefined();
    // Without prefix, prompt should be passed as-is
    expect(councilManager.startCouncil).toHaveBeenCalledWith(
      'just do it',
      expect.any(Object),
      cwd,
    );
  });
});
