/**
 * Calliope Agents — Swarm Types
 *
 * Type definitions for swarm mode: overseer-driven task decomposition,
 * parallel worker dispatch, and result aggregation.
 */

import type { SubAgentType, TaskPriority } from './types.js';

/**
 * Decomposition strategies for breaking tasks into subtasks
 */
export type DecompositionStrategy = 'parallel' | 'sequential' | 'map-reduce' | 'pipeline';

/**
 * Aggregation strategies for merging subtask results
 */
export type AggregationStrategy = 'concatenate' | 'merge-dedupe' | 'summarize' | 'structured';

/**
 * Swarm session status
 */
export type SwarmStatus =
  | 'decomposing'
  | 'executing'
  | 'recovering'
  | 'aggregating'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Subtask status within a swarm
 */
export type SwarmSubtaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying';

/**
 * A single subtask within a swarm
 */
export interface SwarmSubtask {
  id: string;
  index: number;
  prompt: string;
  agent: SubAgentType;
  priority: TaskPriority;
  status: SwarmSubtaskStatus;
  dependsOn: string[];       // IDs of subtasks that must complete first
  result?: string;
  error?: string;
  attempts: number;
  maxAttempts: number;
  taskId?: string;            // Links to SubAgentTask.id when dispatched
  createdAt: Date;
  completedAt?: Date;
}

/**
 * Swarm session configuration
 */
export interface SwarmConfig {
  /** Maximum concurrent workers (default: 3) */
  maxWorkers: number;
  /** Decomposition strategy */
  decomposition: DecompositionStrategy;
  /** Aggregation strategy */
  aggregation: AggregationStrategy;
  /** Max retries per subtask (default: 2) */
  maxRetries: number;
  /** Timeout per subtask in ms (default: 5 min) */
  subtaskTimeout: number;
  /** Agent type for workers (default: 'claude') */
  workerAgent: SubAgentType;
  /** Agent type for overseer (default: 'claude') */
  overseerAgent: SubAgentType;
  /** Use smart routing to select worker agent per subtask (default: false) */
  useSmartRouting: boolean;
}

/**
 * Default swarm configuration
 */
export const DEFAULT_SWARM_CONFIG: SwarmConfig = {
  maxWorkers: 3,
  decomposition: 'parallel',
  aggregation: 'concatenate',
  maxRetries: 2,
  subtaskTimeout: 5 * 60 * 1000,
  workerAgent: 'claude',
  overseerAgent: 'claude',
  useSmartRouting: false,
};

/**
 * A swarm session representing a full decompose→execute→aggregate cycle
 */
export interface SwarmSession {
  id: string;
  prompt: string;
  status: SwarmStatus;
  config: SwarmConfig;
  subtasks: SwarmSubtask[];
  result?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}
