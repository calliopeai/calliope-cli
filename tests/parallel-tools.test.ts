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
});
