import { describe, it, expect, beforeEach } from 'vitest';
import type {
  SwarmSession,
  SwarmSubtask,
  SwarmConfig,
  DecompositionStrategy,
  AggregationStrategy,
} from '../src/agents/swarm-types.js';
import { DEFAULT_SWARM_CONFIG } from '../src/agents/swarm-types.js';
import {
  buildDecompositionPrompt,
  parseDecompositionResponse,
  resolveDependencies,
  getReadySubtasks,
  allSubtasksDone,
  hasFailedSubtasks,
} from '../src/agents/decomposer.js';
import { aggregateResults, buildAggregationPrompt } from '../src/agents/aggregator.js';

// ============================================================================
// Swarm Types
// ============================================================================

describe('Swarm Types', () => {
  describe('DEFAULT_SWARM_CONFIG', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_SWARM_CONFIG.maxWorkers).toBe(3);
      expect(DEFAULT_SWARM_CONFIG.decomposition).toBe('parallel');
      expect(DEFAULT_SWARM_CONFIG.aggregation).toBe('concatenate');
      expect(DEFAULT_SWARM_CONFIG.maxRetries).toBe(2);
      expect(DEFAULT_SWARM_CONFIG.subtaskTimeout).toBe(5 * 60 * 1000);
      expect(DEFAULT_SWARM_CONFIG.workerAgent).toBe('claude');
      expect(DEFAULT_SWARM_CONFIG.overseerAgent).toBe('claude');
    });
  });

  describe('SwarmSession structure', () => {
    it('should have all required fields', () => {
      const session: SwarmSession = {
        id: 'test-session',
        prompt: 'Build a web app',
        status: 'decomposing',
        config: DEFAULT_SWARM_CONFIG,
        subtasks: [],
        activeTaskIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(session.id).toBeDefined();
      expect(session.prompt).toBeDefined();
      expect(session.status).toBe('decomposing');
      expect(session.config).toEqual(DEFAULT_SWARM_CONFIG);
      expect(session.subtasks).toEqual([]);
    });

    it('should support all status values', () => {
      const statuses: SwarmSession['status'][] = [
        'decomposing', 'executing', 'recovering', 'aggregating', 'completed', 'failed', 'cancelled',
      ];
      for (const status of statuses) {
        expect(status).toBeTruthy();
      }
    });
  });
});

// ============================================================================
// Decomposer
// ============================================================================

describe('Decomposer', () => {
  describe('buildDecompositionPrompt', () => {
    it('should include the task', () => {
      const prompt = buildDecompositionPrompt('Build a web app', 'parallel', 'claude');
      expect(prompt).toContain('Build a web app');
    });

    it('should include strategy instructions', () => {
      const strategies: DecompositionStrategy[] = ['parallel', 'sequential', 'map-reduce', 'pipeline'];
      for (const strategy of strategies) {
        const prompt = buildDecompositionPrompt('test task', strategy, 'claude');
        expect(prompt).toContain(strategy === 'map-reduce' ? 'map phase' : strategy);
      }
    });

    it('should include the worker agent type', () => {
      const prompt = buildDecompositionPrompt('test task', 'parallel', 'gemini');
      expect(prompt).toContain('gemini');
    });

    it('should request JSON response', () => {
      const prompt = buildDecompositionPrompt('test task', 'parallel', 'claude');
      expect(prompt).toContain('JSON');
    });
  });

  describe('parseDecompositionResponse', () => {
    it('should parse valid JSON array', () => {
      const response = JSON.stringify([
        { prompt: 'Task 1', dependsOn: [], priority: 'normal' },
        { prompt: 'Task 2', dependsOn: [0], priority: 'high' },
      ]);

      const subtasks = parseDecompositionResponse(response, 'claude', 2);
      expect(subtasks.length).toBe(2);
      expect(subtasks[0].prompt).toBe('Task 1');
      expect(subtasks[1].prompt).toBe('Task 2');
      expect(subtasks[1].priority).toBe('high');
    });

    it('should extract JSON from markdown response', () => {
      const response = `Here are the subtasks:

\`\`\`json
[
  {"prompt": "Search codebase", "dependsOn": []},
  {"prompt": "Analyze results", "dependsOn": [0]}
]
\`\`\`

Hope this helps!`;

      const subtasks = parseDecompositionResponse(response, 'claude', 2);
      expect(subtasks.length).toBe(2);
      expect(subtasks[0].prompt).toBe('Search codebase');
    });

    it('should assign default values', () => {
      const response = JSON.stringify([
        { prompt: 'Task 1' },
      ]);

      const subtasks = parseDecompositionResponse(response, 'gemini', 1);
      expect(subtasks[0].agent).toBe('gemini');
      expect(subtasks[0].priority).toBe('normal');
      expect(subtasks[0].maxAttempts).toBe(2); // maxRetries(1) + 1
      expect(subtasks[0].attempts).toBe(0);
      expect(subtasks[0].status).toBe('pending');
    });

    it('should cap at 20 subtasks', () => {
      const tasks = Array.from({ length: 25 }, (_, i) => ({ prompt: `Task ${i}` }));
      const response = JSON.stringify(tasks);

      const subtasks = parseDecompositionResponse(response, 'claude', 2);
      expect(subtasks.length).toBe(20);
    });

    it('should throw on empty response', () => {
      expect(() => parseDecompositionResponse('[]', 'claude', 2)).toThrow('empty or invalid');
    });

    it('should throw on non-JSON response', () => {
      expect(() => parseDecompositionResponse('I cannot do this', 'claude', 2)).toThrow('no JSON array');
    });
  });

  describe('resolveDependencies', () => {
    it('should convert numeric indices to subtask IDs', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: [], attempts: 0, maxAttempts: 3, createdAt: new Date() },
        { id: 'b', index: 1, prompt: 'T2', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['0'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const resolved = resolveDependencies(subtasks);
      expect(resolved[0].dependsOn).toEqual([]);
      expect(resolved[1].dependsOn).toEqual(['a']);
    });

    it('should filter out self-references', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['0'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const resolved = resolveDependencies(subtasks);
      expect(resolved[0].dependsOn).toEqual([]);
    });

    it('should filter out invalid indices', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['5', '-1', 'abc'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const resolved = resolveDependencies(subtasks);
      expect(resolved[0].dependsOn).toEqual([]);
    });
  });

  describe('getReadySubtasks', () => {
    it('should return subtasks with no dependencies', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: [], attempts: 0, maxAttempts: 3, createdAt: new Date() },
        { id: 'b', index: 1, prompt: 'T2', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['a'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const ready = getReadySubtasks(subtasks);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('a');
    });

    it('should return subtasks whose dependencies are completed', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'completed', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(), result: 'done' },
        { id: 'b', index: 1, prompt: 'T2', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['a'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const ready = getReadySubtasks(subtasks);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('b');
    });

    it('should not return running or completed subtasks', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'running', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date() },
        { id: 'b', index: 1, prompt: 'T2', agent: 'claude', priority: 'normal', status: 'completed', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(), result: 'done' },
      ];

      const ready = getReadySubtasks(subtasks);
      expect(ready.length).toBe(0);
    });
  });

  describe('allSubtasksDone', () => {
    it('should return true when all completed', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'completed', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(), result: 'done' },
      ];
      expect(allSubtasksDone(subtasks)).toBe(true);
    });

    it('should return true when permanently failed', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'failed', dependsOn: [], attempts: 3, maxAttempts: 3, createdAt: new Date(), error: 'nope' },
      ];
      expect(allSubtasksDone(subtasks)).toBe(true);
    });

    it('should return false when still running', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'running', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date() },
      ];
      expect(allSubtasksDone(subtasks)).toBe(false);
    });

    it('should return false when retryable failures remain', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'failed', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(), error: 'retry' },
      ];
      expect(allSubtasksDone(subtasks)).toBe(false);
    });
  });

  describe('hasFailedSubtasks', () => {
    it('should detect permanent failures', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'failed', dependsOn: [], attempts: 3, maxAttempts: 3, createdAt: new Date(), error: 'nope' },
      ];
      expect(hasFailedSubtasks(subtasks)).toBe(true);
    });

    it('should not flag retryable failures', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'failed', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(), error: 'temp' },
      ];
      expect(hasFailedSubtasks(subtasks)).toBe(false);
    });
  });
});

// ============================================================================
// Aggregator
// ============================================================================

describe('Aggregator', () => {
  const makeSubtask = (overrides: Partial<SwarmSubtask> = {}): SwarmSubtask => ({
    id: 'test',
    index: 0,
    prompt: 'Test task',
    agent: 'claude',
    priority: 'normal',
    status: 'completed',
    dependsOn: [],
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date(),
    result: 'Test result',
    ...overrides,
  });

  describe('aggregateResults', () => {
    it('should concatenate results', () => {
      const subtasks = [
        makeSubtask({ index: 0, prompt: 'Task 1', result: 'Result 1' }),
        makeSubtask({ index: 1, prompt: 'Task 2', result: 'Result 2' }),
      ];

      const result = aggregateResults(subtasks, 'concatenate', 'Original');
      expect(result).toContain('Result 1');
      expect(result).toContain('Result 2');
      expect(result).toContain('Subtask 1');
      expect(result).toContain('Subtask 2');
    });

    it('should merge-dedupe results', () => {
      const subtasks = [
        makeSubtask({ index: 0, result: 'Line A\nLine B\nLine C' }),
        makeSubtask({ index: 1, result: 'Line B\nLine D\nLine A' }),
      ];

      const result = aggregateResults(subtasks, 'merge-dedupe', 'Original');
      expect(result).toContain('Line A');
      expect(result).toContain('Line B');
      expect(result).toContain('Line C');
      expect(result).toContain('Line D');
      // Duplicates should be removed
      const lines = result.split('\n').filter(l => l.trim().length > 0);
      const uniqueContent = new Set(lines.map(l => l.trim().toLowerCase()));
      expect(uniqueContent.size).toBe(lines.length);
    });

    it('should create summarized results', () => {
      const subtasks = [
        makeSubtask({ index: 0, prompt: 'Search files', result: 'Found 10 files matching pattern' }),
        makeSubtask({ index: 1, prompt: 'Analyze code', result: 'Code quality is good overall' }),
      ];

      const result = aggregateResults(subtasks, 'summarize', 'Review the codebase');
      expect(result).toContain('Summary');
      expect(result).toContain('Found 10 files');
      expect(result).toContain('Code quality');
    });

    it('should create structured results', () => {
      const subtasks = [
        makeSubtask({ index: 0, prompt: 'Step 1', result: 'Done step 1' }),
        makeSubtask({ index: 1, prompt: 'Step 2', result: 'Done step 2' }),
      ];

      const result = aggregateResults(subtasks, 'structured', 'Build app');
      expect(result).toContain('Build app');
      expect(result).toContain('Tasks completed:**');
      expect(result).toContain('Done step 1');
      expect(result).toContain('Done step 2');
    });

    it('should handle all-failed subtasks', () => {
      const subtasks = [
        makeSubtask({ status: 'failed', result: undefined, error: 'timeout' }),
      ];

      const result = aggregateResults(subtasks, 'concatenate', 'Original');
      expect(result).toContain('All subtasks failed');
      expect(result).toContain('timeout');
    });

    it('should append failure summary for partial failures', () => {
      const subtasks = [
        makeSubtask({ index: 0, prompt: 'OK task', result: 'Success' }),
        makeSubtask({ index: 1, prompt: 'Bad task', status: 'failed', result: undefined, error: 'crashed' }),
      ];

      const result = aggregateResults(subtasks, 'concatenate', 'Original');
      expect(result).toContain('Success');
      expect(result).toContain('1 subtask(s) failed');
      expect(result).toContain('crashed');
    });
  });

  describe('buildAggregationPrompt', () => {
    it('should include the original prompt', () => {
      const prompt = buildAggregationPrompt('Build an app', [
        { prompt: 'Step 1', result: 'Done 1' },
      ]);
      expect(prompt).toContain('Build an app');
    });

    it('should include all subtask results', () => {
      const prompt = buildAggregationPrompt('Test', [
        { prompt: 'Step 1', result: 'Result 1' },
        { prompt: 'Step 2', result: 'Result 2' },
      ]);
      expect(prompt).toContain('Step 1');
      expect(prompt).toContain('Result 1');
      expect(prompt).toContain('Step 2');
      expect(prompt).toContain('Result 2');
    });
  });
});

// ============================================================================
// Integration Types
// ============================================================================

describe('Swarm Integration', () => {
  it('should have all decomposition strategies', () => {
    const strategies: DecompositionStrategy[] = ['parallel', 'sequential', 'map-reduce', 'pipeline'];
    expect(strategies.length).toBe(4);
  });

  it('should have all aggregation strategies', () => {
    const strategies: AggregationStrategy[] = ['concatenate', 'merge-dedupe', 'summarize', 'structured'];
    expect(strategies.length).toBe(4);
  });

  it('should produce decomposition prompts for all strategies', () => {
    const strategies: DecompositionStrategy[] = ['parallel', 'sequential', 'map-reduce', 'pipeline'];
    for (const strategy of strategies) {
      const prompt = buildDecompositionPrompt('Test task', strategy, 'claude');
      expect(prompt.length).toBeGreaterThan(100);
    }
  });

  it('should produce aggregated results for all strategies', () => {
    const subtasks: SwarmSubtask[] = [
      {
        id: 'a', index: 0, prompt: 'Task A', agent: 'claude', priority: 'normal',
        status: 'completed', dependsOn: [], attempts: 1, maxAttempts: 3,
        createdAt: new Date(), result: 'Result A',
      },
      {
        id: 'b', index: 1, prompt: 'Task B', agent: 'claude', priority: 'normal',
        status: 'completed', dependsOn: [], attempts: 1, maxAttempts: 3,
        createdAt: new Date(), result: 'Result B',
      },
    ];

    const strategies: AggregationStrategy[] = ['concatenate', 'merge-dedupe', 'summarize', 'structured'];
    for (const strategy of strategies) {
      const result = aggregateResults(subtasks, strategy, 'Test prompt');
      expect(result).toContain('Result A');
      expect(result).toContain('Result B');
    }
  });
});

// ============================================================================
// Robustness
// ============================================================================

describe('Swarm Robustness', () => {
  describe('SwarmConfig', () => {
    it('should support useSmartRouting option', () => {
      const config: SwarmConfig = {
        ...DEFAULT_SWARM_CONFIG,
        useSmartRouting: true,
      };
      expect(config.useSmartRouting).toBe(true);
    });

    it('should default useSmartRouting to false', () => {
      expect(DEFAULT_SWARM_CONFIG.useSmartRouting).toBe(false);
    });
  });

  describe('dependency chains', () => {
    it('should handle multi-level dependency chains', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'completed', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(), result: 'done' },
        { id: 'b', index: 1, prompt: 'T2', agent: 'claude', priority: 'normal', status: 'completed', dependsOn: ['a'], attempts: 1, maxAttempts: 3, createdAt: new Date(), result: 'done' },
        { id: 'c', index: 2, prompt: 'T3', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['b'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const ready = getReadySubtasks(subtasks);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('c');
    });

    it('should handle multiple dependencies on same subtask', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'completed', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(), result: 'done' },
        { id: 'b', index: 1, prompt: 'T2', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['a'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
        { id: 'c', index: 2, prompt: 'T3', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['a'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const ready = getReadySubtasks(subtasks);
      expect(ready.length).toBe(2);
    });

    it('should block on unmet dependencies', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'running', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date() },
        { id: 'b', index: 1, prompt: 'T2', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['a'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const ready = getReadySubtasks(subtasks);
      expect(ready.length).toBe(0);
    });
  });

  describe('error handling in decomposition', () => {
    it('should handle JSON with extra whitespace', () => {
      const response = `  \n\n  [{"prompt": "Task 1", "dependsOn": []}]  \n\n  `;
      const subtasks = parseDecompositionResponse(response, 'claude', 2);
      expect(subtasks.length).toBe(1);
    });

    it('should handle malformed prompts gracefully', () => {
      const response = JSON.stringify([
        { prompt: '', dependsOn: [] },
        { dependsOn: [] },
      ]);
      const subtasks = parseDecompositionResponse(response, 'claude', 2);
      expect(subtasks.length).toBe(2);
      expect(subtasks[1].prompt).toContain('Subtask 2');
    });

    it('should handle circular dependencies gracefully', () => {
      const subtasks: SwarmSubtask[] = [
        { id: 'a', index: 0, prompt: 'T1', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['1'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
        { id: 'b', index: 1, prompt: 'T2', agent: 'claude', priority: 'normal', status: 'pending', dependsOn: ['0'], attempts: 0, maxAttempts: 3, createdAt: new Date() },
      ];

      const resolved = resolveDependencies(subtasks);
      // Both depend on each other - getReadySubtasks should return empty
      const ready = getReadySubtasks(resolved);
      expect(ready.length).toBe(0);
    });
  });

  describe('aggregation edge cases', () => {
    it('should handle single subtask without headers', () => {
      const subtasks = [
        { id: 'a', index: 0, prompt: 'Only task', agent: 'claude' as const, priority: 'normal' as const,
          status: 'completed' as const, dependsOn: [], attempts: 1, maxAttempts: 3,
          createdAt: new Date(), result: 'Single result' },
      ];

      const result = aggregateResults(subtasks, 'concatenate', 'Original');
      expect(result).toContain('Single result');
      expect(result).not.toContain('Subtask 1'); // Single task, no header
    });

    it('should handle empty results in subtasks', () => {
      const subtasks = [
        { id: 'a', index: 0, prompt: 'Task 1', agent: 'claude' as const, priority: 'normal' as const,
          status: 'completed' as const, dependsOn: [], attempts: 1, maxAttempts: 3,
          createdAt: new Date(), result: '' },
      ];

      const result = aggregateResults(subtasks, 'concatenate', 'Original');
      // Empty result subtask should still not crash
      expect(result).toBeDefined();
    });
  });
});

// ============================================================================
// Aggregator edge cases — uncovered branches
// ============================================================================

describe('aggregateResults - edge cases', () => {
  const makeCompletedSubtask = (index: number, result: string, id?: string): SwarmSubtask => ({
    id: id || `subtask-${index}`,
    index,
    prompt: `Task ${index + 1}`,
    agent: 'claude',
    priority: 'normal',
    status: 'completed',
    dependsOn: [],
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date(),
    result,
  });

  it('should not include header for single-subtask concatenation', () => {
    // aggregateConcatenate: header only shown when subtasks.length > 1
    const subtasks = [makeCompletedSubtask(0, 'Only result')];
    const result = aggregateResults(subtasks, 'concatenate', 'Test');
    expect(result).toBe('Only result');
    expect(result).not.toContain('Subtask 1');
    expect(result).not.toContain('##');
  });

  it('should use default (concatenate) for unknown strategy', () => {
    const subtasks = [
      makeCompletedSubtask(0, 'Result A'),
      makeCompletedSubtask(1, 'Result B'),
    ];
    // Cast to bypass type checking
    const result = aggregateResults(subtasks, 'unknown_strategy' as AggregationStrategy, 'Test');
    expect(result).toContain('Result A');
    expect(result).toContain('Result B');
  });

  it('should skip subtasks with null/undefined result in merge-dedupe', () => {
    const subtasks: SwarmSubtask[] = [
      makeCompletedSubtask(0, 'Line A'),
      { ...makeCompletedSubtask(1, ''), result: undefined },  // no result
    ];
    const result = aggregateResults(subtasks, 'merge-dedupe', 'Test');
    expect(result).toContain('Line A');
    // Should not crash
  });

  it('should skip subtasks with no result in summarize', () => {
    const subtasks: SwarmSubtask[] = [
      makeCompletedSubtask(0, 'Real result'),
      { ...makeCompletedSubtask(1, ''), result: undefined },
    ];
    const result = aggregateResults(subtasks, 'summarize', 'Review');
    expect(result).toContain('Real result');
  });

  it('should skip subtasks with no result in structured', () => {
    const subtasks: SwarmSubtask[] = [
      makeCompletedSubtask(0, 'Structured content'),
      { ...makeCompletedSubtask(1, ''), result: undefined },
    ];
    const result = aggregateResults(subtasks, 'structured', 'Build');
    expect(result).toContain('Structured content');
  });

  it('should handle all-failed with unknown error', () => {
    const subtasks: SwarmSubtask[] = [
      {
        id: 'fail-1', index: 0, prompt: 'Task', agent: 'claude', priority: 'normal',
        status: 'failed', dependsOn: [], attempts: 1, maxAttempts: 3, createdAt: new Date(),
        result: undefined, error: undefined,  // no error message
      },
    ];
    const result = aggregateResults(subtasks, 'concatenate', 'Test');
    expect(result).toContain('All subtasks failed');
    expect(result).toContain('unknown error');
  });

  it('should include failed subtask with no error in failure summary', () => {
    const subtasks: SwarmSubtask[] = [
      makeCompletedSubtask(0, 'Good result'),
      {
        id: 'fail-1', index: 1, prompt: 'Bad task that is quite long for testing purposes',
        agent: 'claude', priority: 'normal', status: 'failed', dependsOn: [],
        attempts: 1, maxAttempts: 3, createdAt: new Date(),
        result: undefined, error: undefined,  // no error
      },
    ];
    const result = aggregateResults(subtasks, 'concatenate', 'Test');
    expect(result).toContain('subtask(s) failed');
    expect(result).toContain('unknown');
  });

  it('should sort completed subtasks by index in aggregation', () => {
    // subtasks passed out of order
    const subtasks = [
      makeCompletedSubtask(2, 'Result C', 'c'),
      makeCompletedSubtask(0, 'Result A', 'a'),
      makeCompletedSubtask(1, 'Result B', 'b'),
    ];
    const result = aggregateResults(subtasks, 'concatenate', 'Test');
    const aIdx = result.indexOf('Result A');
    const bIdx = result.indexOf('Result B');
    const cIdx = result.indexOf('Result C');
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });
});
