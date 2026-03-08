/**
 * Calliope Agents — Decomposer
 *
 * Decomposes a high-level task into subtasks using the overseer agent.
 * Supports parallel, sequential, map-reduce, and pipeline strategies.
 */

import { randomUUID } from 'crypto';
import type { SubAgentType, TaskPriority } from './types.js';
import type { DecompositionStrategy, SwarmSubtask } from './swarm-types.js';

/**
 * Parsed subtask from decomposition
 */
interface ParsedSubtask {
  prompt: string;
  dependsOn?: number[];   // Indices of dependent subtasks (0-based)
  priority?: TaskPriority;
  agent?: SubAgentType;
}

/**
 * Build the decomposition prompt for the overseer
 */
export function buildDecompositionPrompt(
  task: string,
  strategy: DecompositionStrategy,
  workerAgent: SubAgentType
): string {
  const strategyInstructions: Record<DecompositionStrategy, string> = {
    parallel: `Break this task into independent subtasks that can run in parallel.
Each subtask should be self-contained and not depend on results from other subtasks.
Return 2-8 subtasks.`,

    sequential: `Break this task into ordered steps that must run one after another.
Each step may depend on the result of the previous step.
Return 2-8 steps.`,

    'map-reduce': `Break this task into a map phase and a reduce phase.
Map: Create 2-6 independent subtasks that process different parts of the problem.
Reduce: The results will be automatically merged.`,

    pipeline: `Break this task into pipeline stages where each stage transforms the output.
Stage 1 produces raw output, Stage 2 refines it, Stage 3 polishes it, etc.
Return 2-5 stages.`,
  };

  return `You are a task decomposition agent. Your job is to break down a complex task into smaller subtasks.

Strategy: ${strategy}
${strategyInstructions[strategy]}

Worker agent: ${workerAgent}

IMPORTANT: Respond ONLY with a JSON array of subtasks. No explanation, no markdown, just JSON.

Each subtask object should have:
- "prompt": string - The full task description for the worker
- "dependsOn": number[] - Indices of subtasks this depends on (0-based, empty for parallel)
- "priority": string - "low", "normal", "high", or "critical" (default: "normal")

Example response:
[
  {"prompt": "Search for all TODO comments in the codebase", "dependsOn": [], "priority": "normal"},
  {"prompt": "Categorize the TODOs by severity", "dependsOn": [0], "priority": "normal"}
]

Task to decompose:
${task}`;
}

/**
 * Parse the decomposition response from the overseer
 */
export function parseDecompositionResponse(
  response: string,
  workerAgent: SubAgentType,
  maxRetries: number
): SwarmSubtask[] {
  // Try to extract JSON from the response
  let parsed: ParsedSubtask[];

  // Try direct JSON parse first
  try {
    parsed = JSON.parse(response.trim());
  } catch {
    // Try to find JSON array in the response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('Failed to parse decomposition response: no JSON array found');
    }
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error('Failed to parse decomposition response: invalid JSON');
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Decomposition returned empty or invalid subtask list');
  }

  // Cap at reasonable limit
  if (parsed.length > 20) {
    parsed = parsed.slice(0, 20);
  }

  return parsed.map((item, index) => ({
    id: randomUUID(),
    index,
    prompt: String(item.prompt || `Subtask ${index + 1}`),
    agent: item.agent || workerAgent,
    priority: item.priority || 'normal',
    status: 'pending' as const,
    dependsOn: (item.dependsOn || []).map(dep => {
      // Convert numeric indices to subtask IDs - we'll resolve later
      return String(dep);
    }),
    attempts: 0,
    maxAttempts: maxRetries + 1,
    createdAt: new Date(),
  }));
}

/**
 * Resolve numeric dependency indices to actual subtask IDs
 */
export function resolveDependencies(subtasks: SwarmSubtask[]): SwarmSubtask[] {
  return subtasks.map(subtask => ({
    ...subtask,
    dependsOn: subtask.dependsOn
      .map(depIndex => {
        const idx = parseInt(depIndex, 10);
        if (isNaN(idx) || idx < 0 || idx >= subtasks.length || idx === subtask.index) {
          return null;
        }
        return subtasks[idx].id;
      })
      .filter((id): id is string => id !== null),
  }));
}

/**
 * Get subtasks that are ready to execute (dependencies met)
 */
export function getReadySubtasks(subtasks: SwarmSubtask[]): SwarmSubtask[] {
  const completedIds = new Set(
    subtasks
      .filter(s => s.status === 'completed')
      .map(s => s.id)
  );

  return subtasks.filter(subtask => {
    if (subtask.status !== 'pending') return false;
    return subtask.dependsOn.every(depId => completedIds.has(depId));
  });
}

/**
 * Check if all subtasks are done (completed or permanently failed)
 */
export function allSubtasksDone(subtasks: SwarmSubtask[]): boolean {
  return subtasks.every(s =>
    s.status === 'completed' ||
    (s.status === 'failed' && s.attempts >= s.maxAttempts)
  );
}

/**
 * Check if any subtask permanently failed
 */
export function hasFailedSubtasks(subtasks: SwarmSubtask[]): boolean {
  return subtasks.some(s =>
    s.status === 'failed' && s.attempts >= s.maxAttempts
  );
}
