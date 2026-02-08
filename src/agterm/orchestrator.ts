/**
 * AGTerm Orchestrator
 *
 * Task queue management with depth limiting and priority ordering.
 */

import { randomUUID } from 'crypto';
import type {
  SubAgentTask,
  SubAgentType,
  TaskPriority,
  OrchestratorConfig,
} from './types.js';
import { DEFAULT_ORCHESTRATOR_CONFIG } from './types.js';
import { executeAgent, cancelTask as cancelBackendTask } from './cli-backend.js';
import { isAgentAvailable } from './agent-detection.js';

/**
 * Priority values for queue ordering
 */
const PRIORITY_ORDER: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * Agent Orchestrator
 *
 * Manages task queue, depth limiting, and sub-agent execution.
 */
class AgentOrchestrator {
  private config: OrchestratorConfig;
  private tasks = new Map<string, SubAgentTask>();
  private taskQueue: string[] = [];
  private runningTasks = new Set<string>();
  private currentCwd: string = process.cwd();

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Set the working directory for task execution
   */
  setCwd(cwd: string): void {
    this.currentCwd = cwd;
  }

  /**
   * Spawn a sub-agent task
   */
  async spawnAgent(
    prompt: string,
    agent: SubAgentType,
    options: {
      parentId?: string;
      priority?: TaskPriority;
      background?: boolean;
      cwd?: string;
    } = {}
  ): Promise<SubAgentTask> {
    // Validate agent availability
    if (!isAgentAvailable(agent)) {
      throw new Error(
        `Agent '${agent}' is not available. Check CLI installation and API key.`
      );
    }

    // Check queue limits
    if (this.taskQueue.length >= this.config.maxQueueSize) {
      throw new Error(`Task queue is full (max ${this.config.maxQueueSize})`);
    }

    // Calculate depth and check limits
    let depth = 0;
    if (options.parentId) {
      const parent = this.tasks.get(options.parentId);
      if (parent) {
        depth = parent.depth + 1;

        // Check nesting allowed
        if (!this.config.allowNestedSubAgents && parent.depth > 0) {
          throw new Error('Nested sub-agents are disabled');
        }

        // Check depth limit
        if (depth > this.config.maxDepth) {
          throw new Error(
            `Maximum sub-agent depth (${this.config.maxDepth}) exceeded`
          );
        }

        // Check children per task limit
        if (parent.childIds.length >= this.config.maxChildrenPerTask) {
          throw new Error(
            `Maximum children per task (${this.config.maxChildrenPerTask}) exceeded`
          );
        }
      }
    }

    // Check total sub-agents limit
    const totalSubAgents = Array.from(this.tasks.values())
      .filter(t => t.parentId && !['completed', 'failed', 'cancelled'].includes(t.status))
      .length;

    if (options.parentId && totalSubAgents >= this.config.maxTotalSubAgents) {
      throw new Error(
        `Maximum total sub-agents (${this.config.maxTotalSubAgents}) exceeded`
      );
    }

    // Create task
    const task: SubAgentTask = {
      id: randomUUID(),
      prompt,
      agent,
      status: 'pending',
      priority: options.priority || 'normal',
      parentId: options.parentId,
      depth,
      childIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.tasks.set(task.id, task);

    // Link to parent
    if (options.parentId) {
      const parent = this.tasks.get(options.parentId);
      if (parent) {
        parent.childIds.push(task.id);
      }
    }

    const cwd = options.cwd || this.currentCwd;

    // Execute based on background flag
    if (options.background) {
      // Queue for background execution
      this.insertIntoQueue(task.id, task.priority);
      task.status = 'queued';
      task.updatedAt = new Date();
      this.processQueue(cwd);
    } else {
      // Execute immediately and wait
      await this.runTask(task, cwd);
    }

    return task;
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): SubAgentTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): SubAgentTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by status
   */
  getTasksByStatus(status: SubAgentTask['status']): SubAgentTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  /**
   * Get task tree (task and all descendants)
   */
  getTaskTree(taskId: string): SubAgentTask[] {
    const task = this.tasks.get(taskId);
    if (!task) return [];

    const tree: SubAgentTask[] = [task];
    for (const childId of task.childIds) {
      tree.push(...this.getTaskTree(childId));
    }
    return tree;
  }

  /**
   * Cancel a task and its children
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // Cancel children first
    for (const childId of task.childIds) {
      await this.cancelTask(childId);
    }

    // Remove from queue
    const queueIndex = this.taskQueue.indexOf(taskId);
    if (queueIndex !== -1) {
      this.taskQueue.splice(queueIndex, 1);
    }

    // Cancel if running
    if (this.runningTasks.has(taskId)) {
      cancelBackendTask(taskId);
      this.runningTasks.delete(taskId);
    }

    task.status = 'cancelled';
    task.completedAt = new Date();
    task.updatedAt = new Date();
  }

  /**
   * Get orchestrator statistics
   */
  getStats(): {
    totalTasks: number;
    queuedTasks: number;
    runningTasks: number;
    completedTasks: number;
    failedTasks: number;
    cancelledTasks: number;
    maxDepthUsed: number;
  } {
    const allTasks = Array.from(this.tasks.values());
    return {
      totalTasks: this.tasks.size,
      queuedTasks: this.taskQueue.length,
      runningTasks: this.runningTasks.size,
      completedTasks: allTasks.filter(t => t.status === 'completed').length,
      failedTasks: allTasks.filter(t => t.status === 'failed').length,
      cancelledTasks: allTasks.filter(t => t.status === 'cancelled').length,
      maxDepthUsed: Math.max(0, ...allTasks.map(t => t.depth)),
    };
  }

  /**
   * Cleanup old completed tasks
   */
  cleanup(maxAgeMs: number = 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    // Collect IDs to delete first, then delete in a separate pass
    const toDelete: string[] = [];
    for (const [taskId, task] of this.tasks) {
      if (
        ['completed', 'failed', 'cancelled'].includes(task.status) &&
        task.completedAt &&
        now - task.completedAt.getTime() > maxAgeMs
      ) {
        toDelete.push(taskId);
      }
    }

    for (const taskId of toDelete) {
      const task = this.tasks.get(taskId);
      if (task) {
        // Remove from parent's childIds
        if (task.parentId) {
          const parent = this.tasks.get(task.parentId);
          if (parent) {
            const idx = parent.childIds.indexOf(taskId);
            if (idx !== -1) parent.childIds.splice(idx, 1);
          }
        }
        this.tasks.delete(taskId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Reset orchestrator state
   */
  reset(): void {
    // Cancel all running tasks
    for (const taskId of this.runningTasks) {
      cancelBackendTask(taskId);
    }
    this.tasks.clear();
    this.taskQueue.length = 0;
    this.runningTasks.clear();
  }

  /**
   * Insert task into queue based on priority
   */
  private insertIntoQueue(taskId: string, priority: TaskPriority): void {
    const taskPriorityValue = PRIORITY_ORDER[priority];

    // Find insertion point to maintain priority order
    let insertIndex = this.taskQueue.length;
    for (let i = 0; i < this.taskQueue.length; i++) {
      const queuedTask = this.tasks.get(this.taskQueue[i]);
      if (queuedTask && PRIORITY_ORDER[queuedTask.priority] < taskPriorityValue) {
        insertIndex = i;
        break;
      }
    }

    this.taskQueue.splice(insertIndex, 0, taskId);
  }

  /**
   * Process the task queue
   */
  private async processQueue(cwd: string): Promise<void> {
    while (
      this.taskQueue.length > 0 &&
      this.runningTasks.size < this.config.maxConcurrent
    ) {
      const taskId = this.taskQueue.shift();
      if (!taskId) break;

      const task = this.tasks.get(taskId);
      if (!task || !['pending', 'queued'].includes(task.status)) continue;

      this.runningTasks.add(taskId);
      // Fire and forget - don't await, let it run in background
      this.runTask(task, cwd).catch(() => {
        // Error already handled in runTask
      });
    }
  }

  /**
   * Run a single task
   */
  private async runTask(task: SubAgentTask, cwd: string): Promise<void> {
    task.status = 'running';
    task.startedAt = new Date();
    task.updatedAt = new Date();

    try {
      let result = '';

      for await (const event of executeAgent(task, cwd, this.config.taskTimeout)) {
        if (event.type === 'text' && event.content) {
          result += event.content;
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Unknown error');
        }
      }

      task.status = 'completed';
      task.result = result.trim() || '(no output)';
      task.completedAt = new Date();
      task.updatedAt = new Date();

    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      task.completedAt = new Date();
      task.updatedAt = new Date();
    } finally {
      this.runningTasks.delete(task.id);
      // Continue processing queue
      this.processQueue(cwd);
    }
  }
}

/**
 * Singleton orchestrator instance
 */
export const orchestrator = new AgentOrchestrator();
