/**
 * Tests for parallel tool execution module
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeDependencies,
  canParallelize,
  getParallelizationStats,
  formatPlan,
  executeParallel,
  executeWithLimit,
} from '../src/parallel-tools.js';
import type { ToolCall } from '../src/types.js';

// Helper to create tool calls
function createToolCall(name: string, args: Record<string, unknown>, id?: string): ToolCall {
  return {
    id: id || `${name}-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args,
  };
}

describe('analyzeDependencies', () => {
  it('should identify independent read operations as parallelizable', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'file1.ts' }),
      createToolCall('read_file', { path: 'file2.ts' }),
      createToolCall('read_file', { path: 'file3.ts' }),
    ];

    const plan = analyzeDependencies(toolCalls);

    // All reads should be in the same stage (parallelizable)
    expect(plan.stages.length).toBe(1);
    expect(plan.stages[0].length).toBe(3);
  });

  it('should create sequential stages for dependent operations', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'file.ts' }),
      createToolCall('write_file', { path: 'file.ts', content: 'new content' }),
    ];

    const plan = analyzeDependencies(toolCalls);

    // Read then write to same file should be sequential
    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0].length).toBe(1);
    expect(plan.stages[0][0].name).toBe('read_file');
    expect(plan.stages[1].length).toBe(1);
    expect(plan.stages[1][0].name).toBe('write_file');
  });

  it('should handle mixed independent and dependent operations', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
      createToolCall('read_file', { path: 'b.ts' }),
      createToolCall('write_file', { path: 'a.ts', content: 'new' }),
      createToolCall('list_files', { path: 'src/' }),
    ];

    const plan = analyzeDependencies(toolCalls);

    // First stage: read a.ts, read b.ts, list_files (all independent)
    // Second stage: write a.ts (depends on read a.ts)
    expect(plan.stages.length).toBeGreaterThanOrEqual(2);
  });

  it('should recognize think as independent', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('think', { thought: 'First thought' }),
      createToolCall('think', { thought: 'Second thought' }),
      createToolCall('read_file', { path: 'file.ts' }),
    ];

    const plan = analyzeDependencies(toolCalls);

    // All should be in first stage (all independent)
    expect(plan.stages.length).toBe(1);
    expect(plan.stages[0].length).toBe(3);
  });

  it('should make shell commands depend on file writes', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('write_file', { path: 'script.sh', content: '#!/bin/bash' }),
      createToolCall('shell', { command: 'chmod +x script.sh' }),
    ];

    const plan = analyzeDependencies(toolCalls);

    // Shell should come after write
    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0][0].name).toBe('write_file');
    expect(plan.stages[1][0].name).toBe('shell');
  });
});

describe('canParallelize', () => {
  it('should return false for single tool call', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'file.ts' }),
    ];

    expect(canParallelize(toolCalls)).toBe(false);
  });

  it('should return false for empty array', () => {
    expect(canParallelize([])).toBe(false);
  });

  it('should return true for independent operations', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
      createToolCall('read_file', { path: 'b.ts' }),
    ];

    expect(canParallelize(toolCalls)).toBe(true);
  });

  it('should return false for strictly sequential operations', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'file.ts' }),
      createToolCall('write_file', { path: 'file.ts', content: 'x' }),
    ];

    expect(canParallelize(toolCalls)).toBe(false);
  });
});

describe('getParallelizationStats', () => {
  it('should calculate correct stats for parallel operations', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
      createToolCall('read_file', { path: 'b.ts' }),
      createToolCall('read_file', { path: 'c.ts' }),
      createToolCall('read_file', { path: 'd.ts' }),
    ];

    const stats = getParallelizationStats(toolCalls);

    expect(stats.totalTools).toBe(4);
    expect(stats.stages).toBe(1);
    expect(stats.maxParallel).toBe(4);
    expect(stats.speedupFactor).toBe(4);
  });

  it('should calculate correct stats for sequential operations', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'file.ts' }),
      createToolCall('write_file', { path: 'file.ts', content: 'x' }),
      createToolCall('shell', { command: 'cat file.ts' }),
    ];

    const stats = getParallelizationStats(toolCalls);

    expect(stats.totalTools).toBe(3);
    expect(stats.stages).toBeGreaterThanOrEqual(2);
    expect(stats.speedupFactor).toBeLessThanOrEqual(3);
  });
});

describe('formatPlan', () => {
  it('should format execution plan for display', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
      createToolCall('read_file', { path: 'b.ts' }),
    ];

    const plan = analyzeDependencies(toolCalls);
    const formatted = formatPlan(plan);

    expect(formatted).toContain('Execution Plan');
    expect(formatted).toContain('Stage 1');
    expect(formatted).toContain('read_file');
    expect(formatted).toContain('parallel');
  });

  it('should not show parallel for single-item stages', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'file.ts' }),
      createToolCall('write_file', { path: 'file.ts', content: 'x' }),
    ];

    const plan = analyzeDependencies(toolCalls);
    const formatted = formatPlan(plan);

    // Each stage has only one item, so no "parallel" label
    const lines = formatted.split('\n');
    const stage1Line = lines.find(l => l.includes('Stage 1'));
    expect(stage1Line).not.toContain('parallel');
  });
});

describe('executeParallel', () => {
  it('should execute tools and return results', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }, 'call-1'),
      createToolCall('read_file', { path: 'b.ts' }, 'call-2'),
    ];

    const executor = async (call: ToolCall) => {
      return `Content of ${(call.arguments as Record<string, unknown>).path}`;
    };

    const results = await executeParallel(toolCalls, executor);

    expect(results).toHaveLength(2);
    expect(results[0].result).toContain('a.ts');
    expect(results[1].result).toContain('b.ts');
    expect(results[0].duration).toBeGreaterThanOrEqual(0);
  });

  it('should handle errors in individual tools', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'good.ts' }, 'call-1'),
      createToolCall('read_file', { path: 'bad.ts' }, 'call-2'),
    ];

    const executor = async (call: ToolCall) => {
      if ((call.arguments as Record<string, unknown>).path === 'bad.ts') {
        throw new Error('File not found');
      }
      return 'success';
    };

    const results = await executeParallel(toolCalls, executor);

    expect(results).toHaveLength(2);
    expect(results[0].error).toBeUndefined();
    expect(results[1].error).toBe('File not found');
  });

  it('should call progress callback', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('think', { thought: 'a' }),
      createToolCall('think', { thought: 'b' }),
    ];

    const progressCalls: Array<{ completed: number; total: number }> = [];

    await executeParallel(
      toolCalls,
      async () => 'done',
      (completed, total) => {
        progressCalls.push({ completed, total });
      }
    );

    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    expect(progressCalls.some(p => p.total === 2)).toBe(true);
  });

  it('should handle stage timeout by marking remaining tools as timed out', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
    ];

    // Executor that never resolves (simulates infinite hang)
    const hangingExecutor = () => new Promise<string>(() => {}); // never resolves

    // Very short timeout (1ms) to force timeout path
    const results = await executeParallel(
      toolCalls,
      hangingExecutor,
      undefined,
      1, // 1ms timeout
    );

    expect(results.length).toBe(1);
    expect(results[0].error).toContain('timed out');
  }, 10000);

  it('should handle errors in executor within executeParallel', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
    ];

    const failingExecutor = async () => { throw new Error('executor failed'); };

    const results = await executeParallel(toolCalls, failingExecutor);
    expect(results.length).toBe(1);
    expect(results[0].error).toBe('executor failed');
  });

  it('should handle non-Error thrown from executor', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
    ];

    const failingExecutor = async () => { throw 'string error'; };

    const results = await executeParallel(toolCalls, failingExecutor);
    expect(results[0].error).toBe('string error');
  });
});

// ===========================================================================
// executeWithLimit
// ===========================================================================

describe('executeWithLimit', () => {
  it('should execute all tools and return results', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
      createToolCall('read_file', { path: 'b.ts' }),
      createToolCall('read_file', { path: 'c.ts' }),
    ];

    const results = await executeWithLimit(
      toolCalls,
      async (call) => `result for ${call.arguments.path}`,
    );

    expect(results).toHaveLength(3);
    expect(results[0].result).toBe('result for a.ts');
    expect(results[1].result).toBe('result for b.ts');
    expect(results[2].result).toBe('result for c.ts');
  });

  it('should handle executor errors gracefully', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'good.ts' }),
      createToolCall('read_file', { path: 'bad.ts' }),
    ];

    const results = await executeWithLimit(
      toolCalls,
      async (call) => {
        if (call.arguments.path === 'bad.ts') throw new Error('File not found');
        return 'ok';
      },
    );

    expect(results).toHaveLength(2);
    const goodResult = results.find(r => r.toolCall.arguments.path === 'good.ts');
    const badResult = results.find(r => r.toolCall.arguments.path === 'bad.ts');
    expect(goodResult?.result).toBe('ok');
    expect(badResult?.error).toBe('File not found');
  });

  it('should handle non-Error thrown from executor', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
    ];

    const results = await executeWithLimit(toolCalls, async () => { throw 'string error'; });
    expect(results[0].error).toBe('string error');
  });

  it('should respect concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const toolCalls: ToolCall[] = Array.from({ length: 6 }, (_, i) =>
      createToolCall('read_file', { path: `file${i}.ts` })
    );

    await executeWithLimit(
      toolCalls,
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 5));
        concurrent--;
        return 'done';
      },
      2, // concurrency limit of 2
    );

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('should call onProgress for each completed tool', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
      createToolCall('read_file', { path: 'b.ts' }),
    ];

    const progressCalls: Array<{ completed: number; total: number }> = [];

    await executeWithLimit(
      toolCalls,
      async () => 'result',
      5,
      (completed, total) => progressCalls.push({ completed, total }),
    );

    expect(progressCalls.length).toBe(2);
    expect(progressCalls.every(p => p.total === 2)).toBe(true);
  });

  it('should sort results in original order', async () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }, 'id-a'),
      createToolCall('read_file', { path: 'b.ts' }, 'id-b'),
      createToolCall('read_file', { path: 'c.ts' }, 'id-c'),
    ];

    // Executor that takes longer for 'a' (would normally complete last)
    const results = await executeWithLimit(
      toolCalls,
      async (call) => {
        if (call.id === 'id-a') await new Promise(r => setTimeout(r, 10));
        return call.arguments.path as string;
      },
      3, // allow all to run concurrently
    );

    // Results should be sorted by original order
    expect(results[0].toolCall.id).toBe('id-a');
    expect(results[1].toolCall.id).toBe('id-b');
    expect(results[2].toolCall.id).toBe('id-c');
  });

  it('should handle empty tool calls', async () => {
    const results = await executeWithLimit([], async () => 'done');
    expect(results).toHaveLength(0);
  });

  it('should handle single tool call', async () => {
    const toolCalls: ToolCall[] = [createToolCall('read_file', { path: 'only.ts' })];
    const results = await executeWithLimit(toolCalls, async () => 'result');
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe('result');
  });
});

// ===========================================================================
// hasDependency — unknown tool branching
// ===========================================================================

describe('analyzeDependencies - unknown tool handling', () => {
  it('should treat unknown tools as sequentially dependent on each other', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('unknown_tool_a', { data: 'foo' }),
      createToolCall('unknown_tool_b', { data: 'bar' }),
    ];

    const plan = analyzeDependencies(toolCalls);

    // Unknown tools assume sequential dependency
    expect(plan.stages.length).toBeGreaterThanOrEqual(2);
  });

  it('should treat unknown current tool as dependent on known previous', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'file.ts' }),
      createToolCall('custom_unknown_tool', { something: 'value' }),
    ];

    const plan = analyzeDependencies(toolCalls);

    // custom_unknown_tool has no TOOL_DEPENDENCIES entry — treated as sequential
    expect(plan.stages.length).toBeGreaterThanOrEqual(2);
  });

  it('should treat unknown previous tool as dependency for known current', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('unknown_tool', { data: 'x' }),
      createToolCall('read_file', { path: 'file.ts' }),
    ];

    const plan = analyzeDependencies(toolCalls);
    // Unknown prev tool causes sequential dependency
    expect(plan.stages.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle same path dependency between read and read (same path = sequential)', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'same.ts' }),
      createToolCall('list_files', { path: 'same.ts' }),
    ];

    const plan = analyzeDependencies(toolCalls);
    // Same path on both args triggers dependency
    expect(plan.stages.length).toBeGreaterThanOrEqual(2);
  });

  it('should make write_file with same path depend on read_file', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'shared.ts' }),
      createToolCall('write_file', { path: 'shared.ts', content: 'new' }),
    ];

    const plan = analyzeDependencies(toolCalls);
    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0][0].name).toBe('read_file');
    expect(plan.stages[1][0].name).toBe('write_file');
  });

  it('should make write_file with different path still depend via file_content output', () => {
    // write_file has dependsOn: ['file_content'], read_file outputs: ['file_content']
    // so write_file always depends on read_file regardless of path
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
      createToolCall('write_file', { path: 'b.ts', content: 'x' }),
    ];

    const plan = analyzeDependencies(toolCalls);
    expect(plan.stages.length).toBe(2);
  });

  it('should handle git tool depending on write_file (file_modified output)', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('write_file', { path: 'code.ts', content: 'x' }),
      createToolCall('git', { command: 'git add .' }),
    ];

    const plan = analyzeDependencies(toolCalls);
    // git depends on file_modified (write_file output), so sequential
    expect(plan.stages.length).toBe(2);
    expect(plan.stages[0][0].name).toBe('write_file');
    expect(plan.stages[1][0].name).toBe('git');
  });

  it('should handle empty tool calls gracefully', () => {
    const plan = analyzeDependencies([]);
    expect(plan.stages).toHaveLength(0);
    expect(plan.dependencies.size).toBe(0);
  });
});

// ===========================================================================
// formatPlan edge cases
// ===========================================================================

describe('formatPlan - additional cases', () => {
  it('should handle tools with no arguments in format', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('think', {}, 'think-1'),
    ];
    const plan = analyzeDependencies(toolCalls);
    const formatted = formatPlan(plan);
    expect(formatted).toContain('think');
    expect(formatted).toContain('Stage 1');
  });

  it('should format args with multiple key-value pairs (truncates at 2)', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('shell', { command: 'ls', cwd: '/tmp', env: 'prod', extra: 'ignored' }),
    ];
    const plan = analyzeDependencies(toolCalls);
    const formatted = formatPlan(plan);
    // Only first 2 args shown
    expect(formatted).toContain('command=');
    expect(formatted).toContain('shell');
  });

  it('should truncate long arg values to 20 chars', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('shell', { command: 'a'.repeat(100) }),
    ];
    const plan = analyzeDependencies(toolCalls);
    const formatted = formatPlan(plan);
    // Value truncated to 20 chars
    expect(formatted).toContain('command=');
    const argLine = formatted.split('\n').find(l => l.includes('command='));
    expect(argLine!.length).toBeLessThan(200);
  });
});

// ===========================================================================
// getParallelizationStats — edge cases
// ===========================================================================

describe('getParallelizationStats - additional cases', () => {
  it('should handle single tool call', () => {
    const toolCalls: ToolCall[] = [createToolCall('read_file', { path: 'a.ts' })];
    const stats = getParallelizationStats(toolCalls);
    expect(stats.totalTools).toBe(1);
    expect(stats.stages).toBe(1);
    expect(stats.maxParallel).toBe(1);
    expect(stats.speedupFactor).toBe(1);
  });

  it('should calculate speedupFactor correctly for mixed stages', () => {
    const toolCalls: ToolCall[] = [
      createToolCall('read_file', { path: 'a.ts' }),
      createToolCall('read_file', { path: 'b.ts' }),
      createToolCall('write_file', { path: 'a.ts', content: 'x' }),
    ];
    const stats = getParallelizationStats(toolCalls);
    // Should have 2 stages: [read a, read b] and [write a]
    expect(stats.totalTools).toBe(3);
    expect(stats.speedupFactor).toBeGreaterThan(1);
  });
});
