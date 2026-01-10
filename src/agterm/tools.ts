/**
 * AGTerm Tools
 *
 * Tool definitions for spawn_agent, check_agent, and list_agents.
 */

import type { Tool, ToolCall, ToolResult } from '../types.js';
import { orchestrator } from './orchestrator.js';
import { getAvailableAgents, detectAgents } from './agent-detection.js';
import type { SubAgentType, TaskPriority } from './types.js';

/**
 * Build dynamic tool description with available agents
 */
function buildSpawnAgentDescription(): string {
  const available = getAvailableAgents();
  const agentList = available.length > 0
    ? available.join(', ')
    : 'none detected (check CLI installation and API keys)';

  return `Spawn a sub-agent CLI to handle a task autonomously.

Available agents: ${agentList}

Agent descriptions:
- claude: Claude Code CLI - Best for complex coding, file operations, analysis
- gemini: Gemini CLI - Good for research, explanation, creative tasks
- codex: Codex CLI - Specialized for code generation and completion

Options:
- background: true = returns immediately with taskId, false = waits for completion
- priority: critical > high > normal > low (affects queue ordering)

Use check_agent with the taskId to monitor background tasks.`;
}

/**
 * Get agterm tool definitions
 * Returns tools dynamically based on available agents
 */
export function getAgtermTools(): Tool[] {
  return [
    {
      name: 'spawn_agent',
      description: buildSpawnAgentDescription(),
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The task description for the sub-agent',
          },
          agent: {
            type: 'string',
            description: 'Which agent CLI to use: claude, gemini, or codex',
            enum: ['claude', 'gemini', 'codex'],
          },
          background: {
            type: 'string', // Using string to be compatible with boolean parsing
            description: 'Run in background (returns task ID immediately) or wait for completion. Default: false',
            enum: ['true', 'false'],
          },
          priority: {
            type: 'string',
            description: 'Task priority for queue ordering. Default: normal',
            enum: ['low', 'normal', 'high', 'critical'],
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'check_agent',
      description: 'Check the status and result of a spawned sub-agent task. Use the taskId returned from spawn_agent.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID returned from spawn_agent',
          },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'list_agents',
      description: 'List available sub-agent CLIs and their status. Also shows orchestrator statistics.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'cancel_agent',
      description: 'Cancel a running or queued sub-agent task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID to cancel',
          },
        },
        required: ['taskId'],
      },
    },
  ];
}

/**
 * AGTerm tool names for quick lookup
 */
export const AGTERM_TOOL_NAMES = ['spawn_agent', 'check_agent', 'list_agents', 'cancel_agent'];

/**
 * Check if a tool name is an agterm tool
 */
export function isAgtermTool(name: string): boolean {
  return AGTERM_TOOL_NAMES.includes(name);
}

/**
 * Execute an agterm tool
 */
export async function executeAgtermTool(
  toolCall: ToolCall,
  cwd: string
): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  // Set the working directory for the orchestrator
  orchestrator.setCwd(cwd);

  try {
    let result: string;

    switch (name) {
      case 'spawn_agent': {
        const prompt = String(args.prompt || '');
        const agent = (args.agent as SubAgentType) || 'claude';
        const background = args.background === 'true' || args.background === true;
        const priority = (args.priority as TaskPriority) || 'normal';

        if (!prompt) {
          return {
            toolCallId: id,
            result: 'Error: prompt is required',
            isError: true,
          };
        }

        // Check agent availability
        const availableAgents = getAvailableAgents();
        if (!availableAgents.includes(agent)) {
          const agentInfo = detectAgents().find(a => a.type === agent);
          const reason = agentInfo?.reason || 'not installed or configured';
          return {
            toolCallId: id,
            result: `Error: Agent '${agent}' is not available (${reason}).\nAvailable agents: ${availableAgents.join(', ') || 'none'}`,
            isError: true,
          };
        }

        try {
          const task = await orchestrator.spawnAgent(prompt, agent, {
            background,
            priority,
            cwd,
          });

          if (background) {
            result = `Sub-agent (${agent}) spawned in background.
Task ID: ${task.id}
Status: ${task.status}
Priority: ${task.priority}

Use check_agent("${task.id}") to monitor progress.`;
          } else {
            if (task.status === 'completed') {
              result = `[${agent}] Task completed successfully.

${task.result || '(no output)'}`;
            } else {
              result = `[${agent}] Task ${task.status}.

${task.error || task.result || '(no output)'}`;
            }
          }
        } catch (err) {
          return {
            toolCallId: id,
            result: `Error spawning agent: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        break;
      }

      case 'check_agent': {
        const taskId = String(args.taskId || '');

        if (!taskId) {
          return {
            toolCallId: id,
            result: 'Error: taskId is required',
            isError: true,
          };
        }

        const task = orchestrator.getTask(taskId);

        if (!task) {
          result = `Task not found: ${taskId}`;
        } else {
          const lines = [
            `Task: ${task.id}`,
            `Agent: ${task.agent}`,
            `Status: ${task.status}`,
            `Priority: ${task.priority}`,
            `Depth: ${task.depth}`,
          ];

          if (task.startedAt) {
            lines.push(`Started: ${task.startedAt.toISOString()}`);
          }
          if (task.completedAt) {
            lines.push(`Completed: ${task.completedAt.toISOString()}`);
          }
          if (task.childIds.length > 0) {
            lines.push(`Children: ${task.childIds.length}`);
          }

          lines.push('');

          if (task.result) {
            lines.push('Result:');
            lines.push(task.result);
          }
          if (task.error) {
            lines.push('Error:');
            lines.push(task.error);
          }

          result = lines.join('\n');
        }
        break;
      }

      case 'list_agents': {
        const agents = detectAgents();
        const agentLines = agents.map(a => {
          const status = a.available ? '✓ Ready' : `✗ ${a.reason}`;
          return `  ${a.type}: ${status}`;
        });

        const stats = orchestrator.getStats();
        const statsLines = [
          `  Running: ${stats.runningTasks}`,
          `  Queued: ${stats.queuedTasks}`,
          `  Completed: ${stats.completedTasks}`,
          `  Failed: ${stats.failedTasks}`,
          `  Total: ${stats.totalTasks}`,
          `  Max Depth Used: ${stats.maxDepthUsed}`,
        ];

        result = `Available Agents:\n${agentLines.join('\n')}\n\nOrchestrator Stats:\n${statsLines.join('\n')}`;
        break;
      }

      case 'cancel_agent': {
        const taskId = String(args.taskId || '');

        if (!taskId) {
          return {
            toolCallId: id,
            result: 'Error: taskId is required',
            isError: true,
          };
        }

        const task = orchestrator.getTask(taskId);
        if (!task) {
          result = `Task not found: ${taskId}`;
        } else {
          await orchestrator.cancelTask(taskId);
          result = `Task ${taskId} cancelled.`;
        }
        break;
      }

      default:
        return {
          toolCallId: id,
          result: `Unknown agterm tool: ${name}`,
          isError: true,
        };
    }

    return { toolCallId: id, result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { toolCallId: id, result: `Error: ${msg}`, isError: true };
  }
}
