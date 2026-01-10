/**
 * Calliope CLI - Parallel Tool Execution
 *
 * Execute independent tools concurrently for better performance.
 */

import type { ToolCall } from './types.js';

// ============================================================================
// Types
// ============================================================================

export interface ToolDependency {
  name: string;
  dependsOn: string[];  // Tool names this tool depends on
  outputs: string[];    // What this tool produces
}

export interface ToolResult {
  toolCall: ToolCall;
  result: string;
  duration: number;
  error?: string;
}

export interface ParallelExecutionPlan {
  stages: ToolCall[][];  // Each stage can run in parallel
  dependencies: Map<string, string[]>;
}

// ============================================================================
// Tool Dependencies
// ============================================================================

// Known tool dependencies
const TOOL_DEPENDENCIES: Record<string, ToolDependency> = {
  read_file: {
    name: 'read_file',
    dependsOn: [],
    outputs: ['file_content'],
  },
  write_file: {
    name: 'write_file',
    dependsOn: ['file_content'],  // Often depends on reading first
    outputs: ['file_modified'],
  },
  shell: {
    name: 'shell',
    dependsOn: [],  // Can depend on file changes
    outputs: ['shell_output'],
  },
  list_files: {
    name: 'list_files',
    dependsOn: [],
    outputs: ['file_list'],
  },
  think: {
    name: 'think',
    dependsOn: [],
    outputs: ['thought'],
  },
  execute_code: {
    name: 'execute_code',
    dependsOn: [],
    outputs: ['code_output'],
  },
  web_search: {
    name: 'web_search',
    dependsOn: [],
    outputs: ['search_results'],
  },
  git: {
    name: 'git',
    dependsOn: ['file_modified'],  // Git commands often follow file changes
    outputs: ['git_output'],
  },
};

// ============================================================================
// Dependency Analysis
// ============================================================================

/**
 * Analyze tool calls for dependencies
 */
export function analyzeDependencies(toolCalls: ToolCall[]): ParallelExecutionPlan {
  const dependencies = new Map<string, string[]>();
  const stages: ToolCall[][] = [];

  // Build dependency graph
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    const deps: string[] = [];

    // Check if this tool depends on outputs from previous tools
    for (let j = 0; j < i; j++) {
      const prevCall = toolCalls[j];

      if (hasDependency(call, prevCall)) {
        deps.push(prevCall.id);
      }
    }

    dependencies.set(call.id, deps);
  }

  // Group into stages based on dependencies
  const executed = new Set<string>();
  const remaining = new Set(toolCalls.map(c => c.id));

  while (remaining.size > 0) {
    const stage: ToolCall[] = [];

    for (const call of toolCalls) {
      if (!remaining.has(call.id)) continue;

      const deps = dependencies.get(call.id) || [];
      const allDepsExecuted = deps.every(d => executed.has(d));

      if (allDepsExecuted) {
        stage.push(call);
      }
    }

    if (stage.length === 0) {
      // Circular dependency or stuck - add remaining sequentially
      for (const call of toolCalls) {
        if (remaining.has(call.id)) {
          stages.push([call]);
          remaining.delete(call.id);
          executed.add(call.id);
        }
      }
      break;
    }

    stages.push(stage);
    for (const call of stage) {
      remaining.delete(call.id);
      executed.add(call.id);
    }
  }

  return { stages, dependencies };
}

/**
 * Check if one tool call depends on another
 */
function hasDependency(current: ToolCall, previous: ToolCall): boolean {
  const currentDef = TOOL_DEPENDENCIES[current.name];
  const prevDef = TOOL_DEPENDENCIES[previous.name];

  if (!currentDef || !prevDef) {
    // Unknown tools - assume sequential dependency
    return true;
  }

  // Check output/input matching
  for (const output of prevDef.outputs) {
    if (currentDef.dependsOn.includes(output)) {
      return true;
    }
  }

  // Check file path dependencies
  const currentArgs = current.arguments as Record<string, unknown>;
  const prevArgs = previous.arguments as Record<string, unknown>;

  // If both operate on the same file, they depend on each other
  if (currentArgs.path && prevArgs.path && currentArgs.path === prevArgs.path) {
    return true;
  }

  // Write after read dependency
  if (current.name === 'write_file' && previous.name === 'read_file') {
    if (currentArgs.path === prevArgs.path) {
      return true;
    }
  }

  // Shell commands that might depend on file changes
  if (current.name === 'shell' && previous.name === 'write_file') {
    return true;  // Conservative: assume shell might need the file
  }

  return false;
}

// ============================================================================
// Parallel Execution
// ============================================================================

/**
 * Execute tools in parallel stages
 */
export async function executeParallel(
  toolCalls: ToolCall[],
  executor: (call: ToolCall) => Promise<string>,
  onProgress?: (completed: number, total: number, current: ToolCall) => void
): Promise<ToolResult[]> {
  const plan = analyzeDependencies(toolCalls);
  const results: ToolResult[] = [];
  let completed = 0;
  const total = toolCalls.length;

  for (const stage of plan.stages) {
    // Execute all tools in this stage concurrently
    const stagePromises = stage.map(async (call) => {
      const startTime = Date.now();

      try {
        onProgress?.(completed, total, call);
        const result = await executor(call);
        completed++;

        return {
          toolCall: call,
          result,
          duration: Date.now() - startTime,
        };
      } catch (error) {
        completed++;
        return {
          toolCall: call,
          result: '',
          duration: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const stageResults = await Promise.all(stagePromises);
    results.push(...stageResults);
  }

  return results;
}

/**
 * Execute with concurrency limit
 */
export async function executeWithLimit(
  toolCalls: ToolCall[],
  executor: (call: ToolCall) => Promise<string>,
  concurrencyLimit: number = 5,
  onProgress?: (completed: number, total: number) => void
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  let completed = 0;
  const total = toolCalls.length;

  // Simple concurrent execution with limit
  const executing: Promise<void>[] = [];
  const queue = [...toolCalls];

  const runNext = async (): Promise<void> => {
    if (queue.length === 0) return;

    const call = queue.shift()!;
    const startTime = Date.now();

    try {
      const result = await executor(call);
      results.push({
        toolCall: call,
        result,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      results.push({
        toolCall: call,
        result: '',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    completed++;
    onProgress?.(completed, total);

    // Start next if queue not empty
    if (queue.length > 0) {
      await runNext();
    }
  };

  // Start initial batch
  for (let i = 0; i < Math.min(concurrencyLimit, queue.length); i++) {
    executing.push(runNext());
  }

  await Promise.all(executing);

  // Sort results to match original order
  results.sort((a, b) => {
    const aIdx = toolCalls.findIndex(c => c.id === a.toolCall.id);
    const bIdx = toolCalls.findIndex(c => c.id === b.toolCall.id);
    return aIdx - bIdx;
  });

  return results;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if tool calls can be parallelized
 */
export function canParallelize(toolCalls: ToolCall[]): boolean {
  if (toolCalls.length <= 1) return false;

  const plan = analyzeDependencies(toolCalls);

  // If any stage has more than one tool, we can parallelize
  return plan.stages.some(stage => stage.length > 1);
}

/**
 * Get parallelization stats
 */
export function getParallelizationStats(toolCalls: ToolCall[]): {
  totalTools: number;
  stages: number;
  maxParallel: number;
  speedupFactor: number;
} {
  const plan = analyzeDependencies(toolCalls);
  const maxParallel = Math.max(...plan.stages.map(s => s.length));

  return {
    totalTools: toolCalls.length,
    stages: plan.stages.length,
    maxParallel,
    speedupFactor: toolCalls.length / plan.stages.length,
  };
}

/**
 * Format execution plan for display
 */
export function formatPlan(plan: ParallelExecutionPlan): string {
  const lines: string[] = ['Execution Plan:', ''];

  plan.stages.forEach((stage, i) => {
    const parallel = stage.length > 1 ? ' (parallel)' : '';
    lines.push(`Stage ${i + 1}${parallel}:`);

    for (const call of stage) {
      const args = call.arguments as Record<string, unknown>;
      const preview = Object.entries(args)
        .slice(0, 2)
        .map(([k, v]) => `${k}=${String(v).slice(0, 20)}`)
        .join(', ');
      lines.push(`  - ${call.name}(${preview})`);
    }
  });

  return lines.join('\n');
}
