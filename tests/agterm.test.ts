import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SubAgentTask, SubAgentType, TaskPriority } from '../src/agterm/types.js';
import { DEFAULT_ORCHESTRATOR_CONFIG, AGENT_CLI_MAP } from '../src/agterm/types.js';
import { getAgtermTools, AGTERM_TOOL_NAMES, isAgtermTool } from '../src/agterm/tools.js';

describe('AGTerm Types', () => {
  describe('DEFAULT_ORCHESTRATOR_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrent).toBe(3);
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxQueueSize).toBe(100);
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxDepth).toBe(3);
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxChildrenPerTask).toBe(5);
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxTotalSubAgents).toBe(20);
      expect(DEFAULT_ORCHESTRATOR_CONFIG.taskTimeout).toBe(15 * 60 * 1000);
      expect(DEFAULT_ORCHESTRATOR_CONFIG.allowNestedSubAgents).toBe(true);
    });
  });

  describe('AGENT_CLI_MAP', () => {
    it('should have all supported agents', () => {
      expect(AGENT_CLI_MAP.claude).toBeDefined();
      expect(AGENT_CLI_MAP.gemini).toBeDefined();
      expect(AGENT_CLI_MAP.codex).toBeDefined();
    });

    it('should have correct commands', () => {
      expect(AGENT_CLI_MAP.claude.command).toBe('claude');
      expect(AGENT_CLI_MAP.gemini.command).toBe('gemini');
      expect(AGENT_CLI_MAP.codex.command).toBe('codex');
    });

    it('should have correct env vars', () => {
      expect(AGENT_CLI_MAP.claude.envVar).toBe('ANTHROPIC_API_KEY');
      expect(AGENT_CLI_MAP.gemini.envVar).toBe('GOOGLE_API_KEY');
      expect(AGENT_CLI_MAP.codex.envVar).toBe('OPENAI_API_KEY');
    });
  });
});

describe('AGTerm Tools', () => {
  describe('AGTERM_TOOL_NAMES', () => {
    it('should include all agterm tools', () => {
      expect(AGTERM_TOOL_NAMES).toContain('spawn_agent');
      expect(AGTERM_TOOL_NAMES).toContain('check_agent');
      expect(AGTERM_TOOL_NAMES).toContain('list_agents');
      expect(AGTERM_TOOL_NAMES).toContain('cancel_agent');
    });
  });

  describe('isAgtermTool', () => {
    it('should return true for agterm tools', () => {
      expect(isAgtermTool('spawn_agent')).toBe(true);
      expect(isAgtermTool('check_agent')).toBe(true);
      expect(isAgtermTool('list_agents')).toBe(true);
      expect(isAgtermTool('cancel_agent')).toBe(true);
    });

    it('should return false for non-agterm tools', () => {
      expect(isAgtermTool('shell')).toBe(false);
      expect(isAgtermTool('read_file')).toBe(false);
      expect(isAgtermTool('think')).toBe(false);
    });
  });

  describe('getAgtermTools', () => {
    it('should return 4 tools', () => {
      const tools = getAgtermTools();
      expect(tools.length).toBe(4);
    });

    it('should have spawn_agent tool with correct parameters', () => {
      const tools = getAgtermTools();
      const spawnTool = tools.find(t => t.name === 'spawn_agent');
      
      expect(spawnTool).toBeDefined();
      expect(spawnTool!.parameters.required).toContain('prompt');
      expect(spawnTool!.parameters.properties.prompt).toBeDefined();
      expect(spawnTool!.parameters.properties.agent).toBeDefined();
      expect(spawnTool!.parameters.properties.background).toBeDefined();
      expect(spawnTool!.parameters.properties.priority).toBeDefined();
    });

    it('should have check_agent tool with taskId parameter', () => {
      const tools = getAgtermTools();
      const checkTool = tools.find(t => t.name === 'check_agent');
      
      expect(checkTool).toBeDefined();
      expect(checkTool!.parameters.required).toContain('taskId');
    });

    it('should have list_agents tool with no required parameters', () => {
      const tools = getAgtermTools();
      const listTool = tools.find(t => t.name === 'list_agents');
      
      expect(listTool).toBeDefined();
      expect(listTool!.parameters.required).toBeUndefined();
    });

    it('should have cancel_agent tool with taskId parameter', () => {
      const tools = getAgtermTools();
      const cancelTool = tools.find(t => t.name === 'cancel_agent');
      
      expect(cancelTool).toBeDefined();
      expect(cancelTool!.parameters.required).toContain('taskId');
    });
  });
});

describe('Priority ordering', () => {
  const priorities: TaskPriority[] = ['low', 'normal', 'high', 'critical'];
  
  it('should have correct priority order', () => {
    // The order should be: critical > high > normal > low
    const PRIORITY_ORDER: Record<TaskPriority, number> = {
      critical: 4,
      high: 3,
      normal: 2,
      low: 1,
    };
    
    expect(PRIORITY_ORDER.critical).toBeGreaterThan(PRIORITY_ORDER.high);
    expect(PRIORITY_ORDER.high).toBeGreaterThan(PRIORITY_ORDER.normal);
    expect(PRIORITY_ORDER.normal).toBeGreaterThan(PRIORITY_ORDER.low);
  });
});

describe('SubAgentTask structure', () => {
  it('should have all required fields', () => {
    const task: SubAgentTask = {
      id: 'test-id',
      prompt: 'test prompt',
      agent: 'claude',
      status: 'pending',
      priority: 'normal',
      depth: 0,
      childIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(task.id).toBeDefined();
    expect(task.prompt).toBeDefined();
    expect(task.agent).toBeDefined();
    expect(task.status).toBeDefined();
    expect(task.priority).toBeDefined();
    expect(task.depth).toBeDefined();
    expect(task.childIds).toBeDefined();
    expect(task.createdAt).toBeDefined();
    expect(task.updatedAt).toBeDefined();
  });

  it('should allow optional fields', () => {
    const task: SubAgentTask = {
      id: 'test-id',
      prompt: 'test prompt',
      agent: 'gemini',
      status: 'completed',
      priority: 'high',
      parentId: 'parent-id',
      depth: 1,
      childIds: ['child-1', 'child-2'],
      result: 'Success!',
      error: undefined,
      pid: 12345,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    };

    expect(task.parentId).toBe('parent-id');
    expect(task.result).toBe('Success!');
    expect(task.pid).toBe(12345);
    expect(task.startedAt).toBeDefined();
    expect(task.completedAt).toBeDefined();
  });
});
