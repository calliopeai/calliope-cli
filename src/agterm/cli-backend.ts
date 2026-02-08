/**
 * AGTerm CLI Backend
 *
 * Process spawning and execution for sub-agents.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { SubAgentType, AgentEvent, SubAgentTask } from './types.js';
import { getAgentCLI } from './agent-detection.js';

/**
 * Running task state
 */
interface RunningTask {
  process: ChildProcess;
  task: SubAgentTask;
  output: string;
}

/**
 * Map of currently running tasks
 */
const runningTasks = new Map<string, RunningTask>();

/**
 * Max output size per sub-agent (100K chars) to prevent context blowout
 */
const MAX_AGENT_OUTPUT = 100_000;

/**
 * Get environment variables for an agent
 * Passes through existing env with terminal settings
 */
function getAgentEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
}

/**
 * Execute an agent task
 * Returns an async generator that yields events as they occur
 */
export async function* executeAgent(
  task: SubAgentTask,
  cwd: string,
  timeout: number = 15 * 60 * 1000 // 15 minutes default
): AsyncIterable<AgentEvent> {
  const { command, args } = getAgentCLI(task.agent);
  const env = getAgentEnv();

  // Emit start event
  yield {
    type: 'start',
    taskId: task.id,
    timestamp: new Date(),
  };

  // Build final args - calliope and claude take prompt as argument, others via stdin
  const finalArgs = (task.agent === 'claude' || task.agent === 'calliope')
    ? [...args, task.prompt]
    : args;

  const proc = spawn(command, finalArgs, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Track the running task
  runningTasks.set(task.id, {
    process: proc,
    task,
    output: '',
  });

  // For agents that don't accept prompt as argument, write to stdin
  if (task.agent !== 'claude' && task.agent !== 'calliope' && proc.stdin) {
    proc.stdin.write(task.prompt + '\n');
    proc.stdin.end();
  }

  // Set up event queue for async iteration
  const events: AgentEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let isComplete = false;

  // Set up timeout
  const timeoutHandle = setTimeout(() => {
    if (!isComplete) {
      proc.kill('SIGTERM');
      events.push({
        type: 'error',
        taskId: task.id,
        timestamp: new Date(),
        code: 'TIMEOUT',
        message: `Task timed out after ${timeout}ms`,
      });
      isComplete = true;
      runningTasks.delete(task.id);
      resolveNext?.();
    }
  }, timeout);

  // Handle stdout
  proc.stdout?.on('data', (data) => {
    const content = data.toString();
    const running = runningTasks.get(task.id);
    if (running) {
      if (running.output.length < MAX_AGENT_OUTPUT) {
        running.output += content;
        if (running.output.length > MAX_AGENT_OUTPUT) {
          running.output = running.output.slice(0, MAX_AGENT_OUTPUT) +
            '\n\n[Sub-agent output truncated at 100K chars]';
        }
      }
    }

    events.push({
      type: 'text',
      taskId: task.id,
      timestamp: new Date(),
      content,
    });
    resolveNext?.();
  });

  // Handle stderr
  proc.stderr?.on('data', (data) => {
    const content = data.toString();
    const running = runningTasks.get(task.id);
    if (running && running.output.length < MAX_AGENT_OUTPUT) {
      running.output += content;
    }

    events.push({
      type: 'text',
      taskId: task.id,
      timestamp: new Date(),
      content,
    });
    resolveNext?.();
  });

  // Handle process exit
  proc.on('close', (code) => {
    clearTimeout(timeoutHandle);

    if (code === 0) {
      events.push({
        type: 'complete',
        taskId: task.id,
        timestamp: new Date(),
      });
    } else {
      events.push({
        type: 'error',
        taskId: task.id,
        timestamp: new Date(),
        code: 'EXIT_ERROR',
        message: `Process exited with code ${code}`,
      });
    }

    isComplete = true;
    runningTasks.delete(task.id);
    resolveNext?.();
  });

  // Handle spawn errors
  proc.on('error', (error) => {
    clearTimeout(timeoutHandle);

    events.push({
      type: 'error',
      taskId: task.id,
      timestamp: new Date(),
      code: 'SPAWN_ERROR',
      message: error.message,
    });

    isComplete = true;
    runningTasks.delete(task.id);
    resolveNext?.();
  });

  // Yield events as they arrive
  while (!isComplete || events.length > 0) {
    if (events.length > 0) {
      yield events.shift()!;
    } else if (!isComplete) {
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  }
}

/**
 * Cancel a running task
 */
export function cancelTask(taskId: string): boolean {
  const running = runningTasks.get(taskId);
  if (running) {
    running.process.kill('SIGTERM');
    runningTasks.delete(taskId);
    return true;
  }
  return false;
}

/**
 * Get output of a running or recently completed task
 */
export function getTaskOutput(taskId: string): string | undefined {
  return runningTasks.get(taskId)?.output;
}

/**
 * Check if a task is currently running
 */
export function isTaskRunning(taskId: string): boolean {
  return runningTasks.has(taskId);
}

/**
 * Get count of currently running tasks
 */
export function getRunningTaskCount(): number {
  return runningTasks.size;
}

/**
 * Kill all running tasks (cleanup)
 */
export function killAllTasks(): void {
  for (const [taskId, running] of runningTasks) {
    running.process.kill('SIGTERM');
    runningTasks.delete(taskId);
  }
}
