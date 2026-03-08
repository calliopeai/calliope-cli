/**
 * AGTerm Tools
 *
 * Tool definitions for spawn_agent, check_agent, and list_agents.
 */

import type { Tool, ToolCall, ToolResult } from '../types.js';
import { orchestrator } from './orchestrator.js';
import { swarmManager } from './swarm.js';
import { getAvailableAgents, detectAgents } from './agent-detection.js';
import type { SubAgentType, TaskPriority, TaskExecutor } from './types.js';
import { getAvailableExecutors } from './sdk-backend.js';
import { getAgent, getTeam, listAgentDefs, listTeamDefs, mapEngineToAgentType } from './agent-config-loader.js';
import type { DecompositionStrategy, AggregationStrategy } from './swarm-types.js';
import { councilManager } from './council.js';
import type { CouncilMode } from './council-types.js';
import { COUNCIL_TEMPLATES } from './council-types.js';
import { getDynamicToolDefs, isDynamicTool, executeDynamicTool, DYNAMIC_TOOL_NAMES, executeMetaTool, dynamicToolRegistry } from './dynamic-tools.js';

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
- calliope: Calliope CLI (self) - Full-featured agent with all tools, runs in god mode
- claude: Claude Code CLI - Best for complex coding, file operations, analysis
- gemini: Gemini CLI - Good for research, explanation, creative tasks
- codex: Codex CLI - Specialized for code generation and completion

Options:
- background: true = returns immediately with taskId, false = waits for completion
- priority: critical > high > normal > low (affects queue ordering)
- provider: Override the provider (e.g., ollama, anthropic, openai, google) — calliope agent only
- model: Override the model (e.g., devstral, llama3.3, gpt-4o) — calliope agent only
- executor: Backend to use: cli (default, spawns process), claude-sdk (in-process Claude Agent SDK), openai-sdk (in-process OpenAI Agents JS), google-adk (in-process Google ADK)

SDK executors run in-process (faster, no CLI spawn overhead) and support all providers.
Install optional: npm install @anthropic-ai/claude-agent-sdk @openai/agents @google/adk

Use check_agent with the taskId to monitor background tasks.`;
}

/**
 * Get agterm tool definitions
 * Returns tools dynamically based on available agents
 */
export function getAgtermTools(): Tool[] {
  // Dynamic tools: meta-tools (create/list/remove) + user-created tools
  const dynamicMeta = getDynamicToolDefs();
  const dynamicUserTools = dynamicToolRegistry.getToolDefinitions();

  return [
    ...dynamicMeta,
    ...dynamicUserTools,
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
            description: 'Which agent CLI to use: calliope (self), claude, gemini, or codex',
            enum: ['calliope', 'claude', 'gemini', 'codex'],
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
          provider: {
            type: 'string',
            description: 'Override provider for calliope subagents (e.g., ollama, anthropic, openai, google)',
          },
          model: {
            type: 'string',
            description: 'Override model for calliope subagents (e.g., devstral, llama3.3, gpt-4o)',
          },
          executor: {
            type: 'string',
            description: 'Execution backend: cli (default), claude-sdk (Claude Agent SDK), openai-sdk (OpenAI Agents JS), google-adk (Google ADK)',
            enum: ['cli', 'claude-sdk', 'openai-sdk', 'google-adk'],
          },
          agentDef: {
            type: 'string',
            description: 'Name of a defined agent from .calliope/agents/ (overrides provider/model/executor with agent definition values)',
          },
          timeout: {
            type: 'number',
            description: 'Task timeout in milliseconds (overrides global default)',
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
    {
      name: 'start_swarm',
      description: `Start a swarm to decompose a complex task into parallel subtasks.
An overseer agent breaks the task down, then worker agents execute subtasks concurrently.
Results are aggregated into a single response.

Strategies:
- parallel: Independent subtasks, all run at once
- sequential: Ordered steps, each depends on previous
- map-reduce: Map phase (parallel) then merge results
- pipeline: Stages that transform output sequentially

Aggregation:
- concatenate: Ordered concatenation with headers
- merge-dedupe: Combine and remove duplicates
- summarize: Key points from each subtask
- structured: Organized report format`,
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The complex task to decompose and execute',
          },
          strategy: {
            type: 'string',
            description: 'Decomposition strategy (default: parallel)',
            enum: ['parallel', 'sequential', 'map-reduce', 'pipeline'],
          },
          aggregation: {
            type: 'string',
            description: 'How to merge results (default: concatenate)',
            enum: ['concatenate', 'merge-dedupe', 'summarize', 'structured'],
          },
          maxWorkers: {
            type: 'number',
            description: 'Maximum concurrent workers (default: 3)',
          },
          workerAgent: {
            type: 'string',
            description: 'Agent type for workers (default: claude)',
            enum: ['calliope', 'claude', 'gemini', 'codex'],
          },
          useSmartRouting: {
            type: 'string',
            description: 'Use smart routing to select best agent per subtask (default: false)',
            enum: ['true', 'false'],
          },
          team: {
            type: 'string',
            description: 'Name of a team definition from .calliope/agents/teams/ (auto-configures strategy, workers, and coordination)',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'check_swarm',
      description: 'Check the status of a swarm session. Shows subtask progress and results.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The swarm session ID',
          },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'cancel_swarm',
      description: 'Cancel a running swarm session and all its subtasks.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The swarm session ID to cancel',
          },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'start_council',
      description: `Start an agent council where multiple agents deliberate on a shared goal.

Modes:
- competitive: All respond independently, cross-score, highest wins
- collaborative: Sequential building (A → B improves A → C improves B)
- consensus: Deliberate → vote → supermajority or repeat
- overseer: Lead decomposes via swarm, reviews results, final call

Templates: ${Object.keys(COUNCIL_TEMPLATES).join(', ')}
Use a template name to auto-configure members and mode.`,
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The topic for the council to deliberate on',
          },
          template: {
            type: 'string',
            description: 'Use a pre-built template (code-review, architecture, security-audit, brainstorm, debate)',
            enum: Object.keys(COUNCIL_TEMPLATES),
          },
          mode: {
            type: 'string',
            description: 'Coordination mode (if not using template)',
            enum: ['competitive', 'collaborative', 'consensus', 'overseer'],
          },
          team: {
            type: 'string',
            description: 'Name of a team definition from .calliope/agents/teams/ (auto-configures members, mode, and settings)',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'check_council',
      description: 'Check the status of a council session. Shows deliberation progress and results.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The council session ID',
          },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'cancel_council',
      description: 'Cancel a running council session.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The council session ID to cancel',
          },
        },
        required: ['sessionId'],
      },
    },
  ];
}

/**
 * AGTerm tool names for quick lookup
 */
export const AGTERM_TOOL_NAMES = ['spawn_agent', 'check_agent', 'list_agents', 'cancel_agent', 'start_swarm', 'check_swarm', 'cancel_swarm', 'start_council', 'check_council', 'cancel_council', ...DYNAMIC_TOOL_NAMES];

/**
 * Check if a tool name is an agterm tool
 */
export function isAgtermTool(name: string): boolean {
  return AGTERM_TOOL_NAMES.includes(name) || isDynamicTool(name);
}

/**
 * Execute an agterm tool
 */
export async function executeAgtermTool(
  toolCall: ToolCall,
  cwd: string
): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  // Handle dynamic tool meta-tools (create/list/remove)
  if ((DYNAMIC_TOOL_NAMES as readonly string[]).includes(name)) {
    return executeMetaTool(toolCall, cwd);
  }

  // Handle user-created dynamic tools
  if (isDynamicTool(name)) {
    return executeDynamicTool(toolCall, cwd);
  }

  // Set the working directory for the orchestrator
  orchestrator.setCwd(cwd);

  try {
    let result: string;

    switch (name) {
      case 'spawn_agent': {
        const prompt = String(args.prompt || '');
        let agent = (args.agent as SubAgentType) || 'calliope';
        const background = args.background === 'true' || args.background === true;
        const priority = (args.priority as TaskPriority) || 'normal';
        let model = args.model ? String(args.model) : undefined;
        let provider = args.provider ? String(args.provider) : undefined;
        let executor = (args.executor as TaskExecutor) || 'cli';
        let systemPrompt: string | undefined;
        let taskTimeout: number | undefined = args.timeout ? Number(args.timeout) : undefined;

        if (!prompt) {
          return {
            toolCallId: id,
            result: 'Error: prompt is required',
            isError: true,
          };
        }

        // Resolve agent definition if provided
        if (args.agentDef) {
          const def = getAgent(String(args.agentDef), cwd);
          if (!def) {
            return {
              toolCallId: id,
              result: `Error: Agent definition '${args.agentDef}' not found.\nAvailable: ${listAgentDefs(cwd).map(a => a.name).join(', ')}`,
              isError: true,
            };
          }
          // Agent def values are defaults — explicit params override
          systemPrompt = def.instructions;
          executor = (args.executor as TaskExecutor) || def.engine || executor;
          model = model || def.model;
          provider = provider || def.provider;
          agent = (args.agent as SubAgentType) || mapEngineToAgentType(def.engine, def.provider);
          if (!taskTimeout && def.limits?.timeout) taskTimeout = def.limits.timeout;
        }

        // For SDK executors, agent availability check is different (runs in-process)
        if (executor === 'cli') {
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
        }

        try {
          const task = await orchestrator.spawnAgent(prompt, agent, {
            background,
            priority,
            cwd,
            model,
            provider,
            executor,
            systemPrompt,
            timeout: taskTimeout,
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

        const executors = await getAvailableExecutors();
        const executorLines = executors.map(e => `  ${e}: ✓ Ready`);

        result = `Available Agents:\n${agentLines.join('\n')}\n\nExecutor Backends:\n${executorLines.join('\n')}\n\nOrchestrator Stats:\n${statsLines.join('\n')}`;
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

      case 'start_swarm': {
        const prompt = String(args.prompt || '');
        if (!prompt) {
          return {
            toolCallId: id,
            result: 'Error: prompt is required',
            isError: true,
          };
        }

        const strategy = (args.strategy as DecompositionStrategy) || 'parallel';
        const aggregation = (args.aggregation as AggregationStrategy) || 'concatenate';
        const maxWorkers = typeof args.maxWorkers === 'number' ? args.maxWorkers : 3;
        const workerAgent = (args.workerAgent as SubAgentType) || 'claude';
        const useSmartRouting = args.useSmartRouting === 'true' || args.useSmartRouting === true;

        try {
          const session = await swarmManager.startSwarm(
            prompt,
            { decomposition: strategy, aggregation, maxWorkers, workerAgent, useSmartRouting },
            cwd
          );

          result = `Swarm started.
Session ID: ${session.id}
Strategy: ${strategy} → ${aggregation}
Workers: ${maxWorkers}x ${workerAgent}
Status: ${session.status}

Use check_swarm("${session.id}") to monitor progress.`;
        } catch (err) {
          return {
            toolCallId: id,
            result: `Error starting swarm: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        break;
      }

      case 'check_swarm': {
        const sessionId = String(args.sessionId || '');
        if (!sessionId) {
          return {
            toolCallId: id,
            result: 'Error: sessionId is required',
            isError: true,
          };
        }

        const session = swarmManager.getSession(sessionId);
        if (!session) {
          result = `Swarm session not found: ${sessionId}`;
        } else {
          result = swarmManager.formatSessionStatus(session);
          if (session.status === 'completed' && session.result) {
            result += `\n\nResult:\n${session.result}`;
          }
          if (session.status === 'failed' && session.error) {
            result += `\n\nError: ${session.error}`;
          }
        }
        break;
      }

      case 'cancel_swarm': {
        const sessionId = String(args.sessionId || '');
        if (!sessionId) {
          return {
            toolCallId: id,
            result: 'Error: sessionId is required',
            isError: true,
          };
        }

        const cancelled = await swarmManager.cancelSwarm(sessionId);
        result = cancelled
          ? `Swarm session ${sessionId} cancelled.`
          : `Swarm session not found: ${sessionId}`;
        break;
      }

      case 'start_council': {
        const prompt = String(args.prompt || '');
        if (!prompt) {
          return {
            toolCallId: id,
            result: 'Error: prompt is required',
            isError: true,
          };
        }

        const template = args.template as string | undefined;
        const teamName = args.team as string | undefined;

        try {
          let session;
          if (teamName) {
            // Resolve team definition
            const resolvedTeam = getTeam(teamName, cwd);
            if (!resolvedTeam) {
              return {
                toolCallId: id,
                result: `Error: Team '${teamName}' not found.\nAvailable: ${listTeamDefs(cwd).map(t => t.name).join(', ')}`,
                isError: true,
              };
            }
            const { randomUUID: uuid } = await import('crypto');
            const members = resolvedTeam.members.map(m => ({
              id: uuid(),
              name: m.name,
              agent: m.agent,
              role: m.role,
              weight: m.weight,
            }));
            const councilConfig = {
              mode: resolvedTeam.mode,
              members,
              ...(resolvedTeam.council?.tieBreaker && { tieBreaker: resolvedTeam.council.tieBreaker }),
              ...(resolvedTeam.council?.maxRounds && { maxRounds: resolvedTeam.council.maxRounds }),
              ...(resolvedTeam.council?.consensusThreshold && { consensusThreshold: resolvedTeam.council.consensusThreshold }),
            };
            const effectivePrompt = resolvedTeam.promptPrefix
              ? `${resolvedTeam.promptPrefix}\n\n${prompt}`
              : prompt;
            session = await councilManager.startCouncil(effectivePrompt, councilConfig, cwd);
          } else if (template && COUNCIL_TEMPLATES[template]) {
            session = await councilManager.startFromTemplate(template, prompt, cwd);
          } else {
            const mode = (args.mode as CouncilMode) || 'competitive';
            // Create default members based on mode
            const { randomUUID: uuid } = await import('crypto');
            const members = [
              { id: uuid(), name: 'Agent A', agent: 'claude' as SubAgentType, weight: 1.0 },
              { id: uuid(), name: 'Agent B', agent: 'claude' as SubAgentType, weight: 1.0 },
              { id: uuid(), name: 'Agent C', agent: 'claude' as SubAgentType, weight: 1.0 },
            ];
            session = await councilManager.startCouncil(prompt, { mode, members }, cwd);
          }

          result = `Council started.
Session ID: ${session.id}
Mode: ${session.config.mode}
Members: ${session.config.members.map(m => m.name).join(', ')}${template ? `\nTemplate: ${template}` : ''}
Status: ${session.status}

Use check_council("${session.id}") to monitor progress.`;
        } catch (err) {
          return {
            toolCallId: id,
            result: `Error starting council: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        break;
      }

      case 'check_council': {
        const sessionId = String(args.sessionId || '');
        if (!sessionId) {
          return {
            toolCallId: id,
            result: 'Error: sessionId is required',
            isError: true,
          };
        }

        const session = councilManager.getSession(sessionId);
        if (!session) {
          result = `Council session not found: ${sessionId}`;
        } else {
          result = councilManager.formatSessionStatus(session);
          if (session.status === 'completed' && session.result) {
            result += `\n\nResult:\n${session.result}`;
          }
          if (session.status === 'failed' && session.error) {
            result += `\n\nError: ${session.error}`;
          }
        }
        break;
      }

      case 'cancel_council': {
        const sessionId = String(args.sessionId || '');
        if (!sessionId) {
          return {
            toolCallId: id,
            result: 'Error: sessionId is required',
            isError: true,
          };
        }

        const cancelledCouncil = await councilManager.cancelCouncil(sessionId);
        result = cancelledCouncil
          ? `Council session ${sessionId} cancelled.`
          : `Council session not found: ${sessionId}`;
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
