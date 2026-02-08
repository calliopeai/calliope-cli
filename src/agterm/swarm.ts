/**
 * AGTerm Swarm Manager
 *
 * Orchestrates swarm mode: overseer decomposes tasks, dispatches to parallel
 * workers via the orchestrator, and aggregates results.
 */

import { randomUUID } from 'crypto';
import type {
  SwarmSession,
  SwarmSubtask,
  SwarmConfig,
  SwarmStatus,
} from './swarm-types.js';
import { DEFAULT_SWARM_CONFIG } from './swarm-types.js';
import {
  buildDecompositionPrompt,
  parseDecompositionResponse,
  resolveDependencies,
  getReadySubtasks,
  allSubtasksDone,
  hasFailedSubtasks,
} from './decomposer.js';
import { aggregateResults } from './aggregator.js';
import { orchestrator } from './orchestrator.js';

/**
 * Swarm Manager - Singleton
 *
 * Manages swarm sessions and coordinates decomposition, execution, and aggregation.
 */
class SwarmManager {
  private sessions = new Map<string, SwarmSession>();

  /**
   * Start a new swarm session
   */
  async startSwarm(
    prompt: string,
    config: Partial<SwarmConfig> = {},
    cwd?: string
  ): Promise<SwarmSession> {
    const mergedConfig: SwarmConfig = { ...DEFAULT_SWARM_CONFIG, ...config };

    const session: SwarmSession = {
      id: randomUUID(),
      prompt,
      status: 'decomposing',
      config: mergedConfig,
      subtasks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.sessions.set(session.id, session);

    // Start the swarm lifecycle (fire and forget for background execution)
    this.runSwarmLifecycle(session, cwd).catch(err => {
      session.status = 'failed';
      session.error = err instanceof Error ? err.message : String(err);
      session.updatedAt = new Date();
    });

    return session;
  }

  /**
   * Get a swarm session by ID
   */
  getSession(sessionId: string): SwarmSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all swarm sessions
   */
  getAllSessions(): SwarmSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Cancel a swarm session
   */
  async cancelSwarm(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Cancel all running subtasks
    for (const subtask of session.subtasks) {
      if (subtask.taskId && (subtask.status === 'running' || subtask.status === 'pending')) {
        try {
          await orchestrator.cancelTask(subtask.taskId);
        } catch {
          // Best effort cancellation
        }
        subtask.status = 'failed';
        subtask.error = 'Cancelled';
      }
    }

    session.status = 'cancelled';
    session.updatedAt = new Date();
    session.completedAt = new Date();
    return true;
  }

  /**
   * Get swarm statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    completedSessions: number;
    failedSessions: number;
  } {
    const all = Array.from(this.sessions.values());
    return {
      totalSessions: all.length,
      activeSessions: all.filter(s => ['decomposing', 'executing', 'recovering', 'aggregating'].includes(s.status)).length,
      completedSessions: all.filter(s => s.status === 'completed').length,
      failedSessions: all.filter(s => s.status === 'failed').length,
    };
  }

  /**
   * Run the full swarm lifecycle: decompose → execute → recover → aggregate
   */
  private async runSwarmLifecycle(session: SwarmSession, cwd?: string): Promise<void> {
    try {
      // Phase 1: Decompose
      session.status = 'decomposing';
      session.updatedAt = new Date();

      const decompositionPrompt = buildDecompositionPrompt(
        session.prompt,
        session.config.decomposition,
        session.config.workerAgent
      );

      // Use overseer agent to decompose
      const decompositionTask = await orchestrator.spawnAgent(
        decompositionPrompt,
        session.config.overseerAgent,
        { background: false, priority: 'high', cwd }
      );

      if (decompositionTask.status !== 'completed' || !decompositionTask.result) {
        throw new Error(`Decomposition failed: ${decompositionTask.error || 'no result'}`);
      }

      // Parse subtasks from response
      let subtasks = parseDecompositionResponse(
        decompositionTask.result,
        session.config.workerAgent,
        session.config.maxRetries
      );

      // Resolve dependency indices to IDs
      subtasks = resolveDependencies(subtasks);
      session.subtasks = subtasks;
      session.updatedAt = new Date();

      // Phase 2: Execute
      session.status = 'executing';
      session.updatedAt = new Date();

      await this.executeSubtasks(session, cwd);

      // Phase 3: Recovery (retry failed subtasks)
      if (hasFailedSubtasks(session.subtasks)) {
        session.status = 'recovering';
        session.updatedAt = new Date();

        // Retry failed subtasks that haven't exceeded max attempts
        const retryable = session.subtasks.filter(
          s => s.status === 'failed' && s.attempts < s.maxAttempts
        );

        for (const subtask of retryable) {
          subtask.status = 'pending';
          subtask.error = undefined;
        }

        if (retryable.length > 0) {
          await this.executeSubtasks(session, cwd);
        }
      }

      // Phase 4: Aggregate
      session.status = 'aggregating';
      session.updatedAt = new Date();

      session.result = aggregateResults(
        session.subtasks,
        session.config.aggregation,
        session.prompt
      );

      // Final status
      const hasAnyCompleted = session.subtasks.some(s => s.status === 'completed');
      session.status = hasAnyCompleted ? 'completed' : 'failed';
      if (!hasAnyCompleted) {
        session.error = 'All subtasks failed';
      }
      session.completedAt = new Date();
      session.updatedAt = new Date();

    } catch (error) {
      session.status = 'failed';
      session.error = error instanceof Error ? error.message : String(error);
      session.completedAt = new Date();
      session.updatedAt = new Date();
    }
  }

  /**
   * Execute pending subtasks respecting dependencies and concurrency
   */
  private async executeSubtasks(session: SwarmSession, cwd?: string): Promise<void> {
    const maxConcurrent = session.config.maxWorkers;

    // Loop until all subtasks are done
    while (!allSubtasksDone(session.subtasks)) {
      // Check if session was cancelled
      if (session.status === 'cancelled') return;

      const ready = getReadySubtasks(session.subtasks);
      const running = session.subtasks.filter(s => s.status === 'running');

      // If nothing ready and nothing running, we're stuck (dependency deadlock or all failed)
      if (ready.length === 0 && running.length === 0) {
        break;
      }

      // Dispatch up to maxConcurrent - running.length
      const slotsAvailable = maxConcurrent - running.length;
      const toDispatch = ready.slice(0, slotsAvailable);

      const promises: Promise<void>[] = [];

      for (const subtask of toDispatch) {
        subtask.status = 'running';
        subtask.attempts++;
        session.updatedAt = new Date();

        const promise = this.executeSubtask(subtask, session, cwd);
        promises.push(promise);
      }

      // Wait for at least one to complete before checking again
      if (promises.length > 0) {
        await Promise.race(promises);
      } else if (running.length > 0) {
        // Wait a bit for running tasks to complete
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Execute a single subtask via the orchestrator
   */
  private async executeSubtask(
    subtask: SwarmSubtask,
    session: SwarmSession,
    cwd?: string
  ): Promise<void> {
    try {
      // Add context from dependencies to the prompt
      let enrichedPrompt = subtask.prompt;
      if (subtask.dependsOn.length > 0) {
        const depResults = session.subtasks
          .filter(s => subtask.dependsOn.includes(s.id) && s.status === 'completed' && s.result)
          .map(s => `Previous result (${s.prompt.slice(0, 60)}): ${s.result}`);

        if (depResults.length > 0) {
          enrichedPrompt = `${subtask.prompt}\n\nContext from previous steps:\n${depResults.join('\n\n')}`;
        }
      }

      // If retrying, add error context
      if (subtask.attempts > 1 && subtask.error) {
        enrichedPrompt += `\n\nNote: Previous attempt failed with: ${subtask.error}\nPlease try a different approach.`;
      }

      const task = await orchestrator.spawnAgent(
        enrichedPrompt,
        subtask.agent,
        { background: false, priority: subtask.priority, cwd }
      );

      subtask.taskId = task.id;

      if (task.status === 'completed') {
        subtask.status = 'completed';
        subtask.result = task.result;
        subtask.completedAt = new Date();
      } else {
        subtask.status = 'failed';
        subtask.error = task.error || `Task ended with status: ${task.status}`;
      }
    } catch (error) {
      subtask.status = 'failed';
      subtask.error = error instanceof Error ? error.message : String(error);
    }

    session.updatedAt = new Date();
  }

  /**
   * Format swarm session status for display
   */
  formatSessionStatus(session: SwarmSession): string {
    const lines: string[] = [
      `Swarm: ${session.id.slice(0, 8)}`,
      `Status: ${session.status}`,
      `Strategy: ${session.config.decomposition} → ${session.config.aggregation}`,
      `Task: ${session.prompt.slice(0, 80)}${session.prompt.length > 80 ? '...' : ''}`,
    ];

    if (session.subtasks.length > 0) {
      const completed = session.subtasks.filter(s => s.status === 'completed').length;
      const failed = session.subtasks.filter(s => s.status === 'failed').length;
      const running = session.subtasks.filter(s => s.status === 'running').length;
      const pending = session.subtasks.filter(s => s.status === 'pending').length;

      lines.push(`Subtasks: ${completed}/${session.subtasks.length} done, ${running} running, ${pending} pending, ${failed} failed`);

      for (const subtask of session.subtasks) {
        const icon = subtask.status === 'completed' ? '\u2713'
          : subtask.status === 'failed' ? '\u2717'
          : subtask.status === 'running' ? '\u25B6'
          : '\u25CB';
        const suffix = subtask.attempts > 1 ? ` (attempt ${subtask.attempts})` : '';
        lines.push(`  ${icon} [${subtask.index + 1}] ${subtask.prompt.slice(0, 60)}${suffix}`);
      }
    }

    if (session.error) {
      lines.push(`Error: ${session.error}`);
    }

    return lines.join('\n');
  }

  /**
   * Reset all sessions
   */
  reset(): void {
    this.sessions.clear();
  }
}

/**
 * Singleton swarm manager instance
 */
export const swarmManager = new SwarmManager();
