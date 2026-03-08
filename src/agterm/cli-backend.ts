/**
 * AGTerm CLI Backend
 *
 * Process spawning and execution for sub-agents.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { SubAgentType, AgentEvent, SubAgentTask } from './types.js';
import { AGENT_CLI_MAP } from './types.js';
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
 * Safe environment variable allowlist for sub-agents.
 * Only pass essential system vars + the specific API key the agent needs.
 * This prevents credential leakage across provider boundaries.
 */
const SAFE_ENV_VARS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'NODE_ENV', 'NO_COLOR', 'FORCE_COLOR',
];

/**
 * Provider-to-env-var mapping for calliope subagent provider routing
 */
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  together: 'TOGETHER_API_KEY',
  groq: 'GROQ_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  ollama: 'OLLAMA_BASE_URL',
  ai21: 'AI21_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
  litellm: 'LITELLM_BASE_URL',
  bedrock: 'BEDROCK_API_KEY',
};

/**
 * Get environment variables for an agent.
 * Only passes safe system vars + the specific API key for this agent type.
 * Prevents credential leakage (e.g., Anthropic key leaking to Gemini sub-agent).
 *
 * For calliope subagents, also passes CALLIOPE_PROVIDER and CALLIOPE_MODEL
 * to control which provider/model the subagent uses.
 */
function getAgentEnv(task: SubAgentTask): Record<string, string> {
  const env: Record<string, string> = {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };

  // Copy safe system vars
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

  // Only pass the API key this specific agent needs
  const agentConfig = AGENT_CLI_MAP[task.agent];
  if (agentConfig && process.env[agentConfig.envVar]) {
    env[agentConfig.envVar] = process.env[agentConfig.envVar]!;
  }

  // For calliope subagents, pass provider/model selection and the required API key
  if (task.agent === 'calliope') {
    if (task.provider) {
      env['CALLIOPE_PROVIDER'] = task.provider;
      // Also pass the API key for the selected provider
      const providerEnvVar = PROVIDER_ENV_VARS[task.provider];
      if (providerEnvVar && process.env[providerEnvVar]) {
        env[providerEnvVar] = process.env[providerEnvVar]!;
      }
      // For ollama, also pass base URL
      if (task.provider === 'ollama' && process.env['OLLAMA_BASE_URL']) {
        env['OLLAMA_BASE_URL'] = process.env['OLLAMA_BASE_URL']!;
      }
    }
    if (task.model) {
      env['CALLIOPE_MODEL'] = task.model;
    }
  }

  return env;
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
  const env = getAgentEnv(task);

  // Emit start event
  yield {
    type: 'start',
    taskId: task.id,
    timestamp: new Date(),
  };

  // Prepend system prompt to task prompt for CLI backends (they lack separate system prompt channel)
  const effectivePrompt = task.systemPrompt
    ? `[Agent Instructions]\n${task.systemPrompt}\n---\n${task.prompt}`
    : task.prompt;

  // Build final args - calliope and claude take prompt as argument, others via stdin
  const finalArgs = (task.agent === 'claude' || task.agent === 'calliope')
    ? [...args, effectivePrompt]
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
    proc.stdin.write(effectivePrompt + '\n');
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
