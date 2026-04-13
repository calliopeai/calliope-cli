/**
 * Calliope CLI - Tools
 *
 * Tool definitions and execution for the agent.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolCall, ToolResult } from './types.js';
import * as sandbox from './sandbox.js';
import * as nativeSandbox from './sandbox-native.js';
import { getAgtermTools, isAgtermTool, executeAgtermTool } from './agents/index.js';
import { validatePath as scopeValidatePath, isInScope, getScopeSummary } from './scope.js';
import { getPluginTools, isPluginTool, executePluginTool } from './plugins.js';
import config from './config.js';
import { applySkin, applyPalette, listSkins, listPalettes } from './hud/api.js';
import { listCompanions } from './companions.js';
import { generateDiff as generateFileDiff } from './diff.js';
import { scuttlebotClient } from './scuttlebot/index.js';

/**
 * Available tools for the agent
 */
export const TOOLS: Tool[] = [
  {
    name: 'shell',
    description: 'Execute a shell command and return the output. Use for running programs, git commands, file operations, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to read',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates or overwrites)',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in a directory',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The directory path to list (default: current directory)',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list recursively (default: false)',
        },
      },
    },
  },
  {
    name: 'think',
    description: 'Use this tool to think through complex problems step by step. Write out your reasoning before taking action.',
    parameters: {
      type: 'object',
      properties: {
        thought: {
          type: 'string',
          description: 'Your reasoning and thought process',
        },
      },
      required: ['thought'],
    },
  },
  {
    name: 'ask_question',
    description: 'Ask the user a clarifying question. Use in plan mode to gather requirements before finalizing a plan. Can present multiple choice options or ask freeform questions.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of choices. If provided, displayed as numbered options. Omit for freeform questions.',
        },
        context: {
          type: 'string',
          description: 'Optional context explaining why this question matters for the plan',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'create_plan',
    description: 'Create a structured execution plan for a complex task. Use this when a task requires multiple steps. The plan will be shown to the user for approval before execution begins. Available in all modes including plan mode.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Brief title for the plan',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of steps to execute',
        },
        reasoning: {
          type: 'string',
          description: 'Brief explanation of the approach',
        },
      },
      required: ['title', 'steps'],
    },
  },
  {
    name: 'execute_code',
    description: 'Execute code in a sandboxed environment. Supports Python, Node.js, and shell scripts.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          description: 'The programming language: python, node, bash',
          enum: ['python', 'node', 'bash'],
        },
        code: {
          type: 'string',
          description: 'The code to execute',
        },
      },
      required: ['language', 'code'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for information. Returns a summary of top results.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        num_results: {
          type: 'number',
          description: 'Number of results to return (default: 5, max: 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'git',
    description: 'Execute git commands safely. Supports common git operations.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'Git operation: status, diff, log, branch, add, commit, push, pull, stash',
          enum: ['status', 'diff', 'log', 'branch', 'add', 'commit', 'push', 'pull', 'stash'],
        },
        args: {
          type: 'string',
          description: 'Additional arguments for the git command',
        },
      },
      required: ['operation'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing an exact string. Prefer this over write_file for modifications. Fails if old_string is not found or appears multiple times (use replace_all for intentional multi-replace).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to the file to edit',
        },
        old_string: {
          type: 'string',
          description: 'The exact string to find and replace',
        },
        new_string: {
          type: 'string',
          description: 'The string to replace old_string with',
        },
        replace_all: {
          type: 'boolean',
          description: 'If true, replace all occurrences. If false (default), fails when multiple matches exist.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. **/*.ts, src/**/*.json). Returns paths relative to cwd, sorted.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files against (e.g. **/*.ts, src/**/*.json)',
        },
        cwd: {
          type: 'string',
          description: 'Directory to search in (default: current working directory)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents for a pattern. Returns matching lines with file path and line number.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regex or literal string pattern to search for',
        },
        path: {
          type: 'string',
          description: 'Directory or file to search in (default: ".")',
        },
        glob: {
          type: 'string',
          description: 'Filter files by glob pattern (e.g. "*.ts")',
        },
        case_insensitive: {
          type: 'boolean',
          description: 'If true, perform case-insensitive matching',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'configure',
    description: `Read, set, or list Calliope configuration options. Use this when the user asks to change settings, switch themes, providers, models, companions, or any preference through natural conversation. Always use action "list" first if you need to show available options.

CONFIGURABLE SETTINGS:
- defaultProvider: AI provider (anthropic, google, openai, together, openrouter, groq, fireworks, mistral, ollama, ai21, huggingface, litellm, bedrock, auto)
- defaultModel: Model name string (provider-specific, e.g. "claude-sonnet-4-20250514", "gemini-2.0-flash", "gpt-4o")
- persona: Agent persona style (calliope, muse, minimal)
- maxIterations: Max agent loop iterations (0 = unlimited)
- maxIterationTime: Max seconds per iteration (0 = no limit, default: 600)
- fancyOutput: Enable rich formatting (true/false)
- autoSaveHistory: Auto-save session history (true/false)
- autoUpgrade: Check for updates on startup (true/false)
- collapseTools: Auto-collapse tool output (true/false)
- collapseThinking: Auto-collapse think blocks (true/false)
- toolDisplayLimit: Show last N tools expanded (0 = all)
- layout: UI layout (classic, response-top, response-bottom, split, zen, focus, dashboard, minimal)
- density: Display density (normal, compact)
- activeSkin: Terminal skin/theme name (use action "list" category "skins" to see options)
- activePalette: Color palette name (use action "list" category "palettes" to see options)
- activeCompanion: AI companion personality (use action "list" category "companions" to see options)
- companionIntensity: Companion personality level (professional, immersive)
- useEmojis: Show emojis in UI (true/false)
- diffStyle: Diff display format (inline, unified, side-by-side)
- borderStyle: UI border style (rounded, sharp, double, ascii, none)
- bannerStyle: Startup banner (full, compact, none)
- circuitBreakersEnabled: Safety circuit breakers (true/false)
- sandboxMode: Code execution sandbox (auto, native, docker, off)
- smartRoutingEnabled: Dynamic model routing (true/false)
- smartRoutingCostSensitivity: Cost vs quality (0-1, 0=best quality, 1=cheapest)
- recordSessions: Record session audit logs (true/false)
- recordingRetentionDays: Auto-delete old recordings after N days (0 = keep forever)`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: "get" reads a setting, "set" changes a setting, "list" shows available options for a category',
          enum: ['get', 'set', 'list'],
        },
        key: {
          type: 'string',
          description: 'Config key name (for get/set actions)',
        },
        value: {
          type: 'string',
          description: 'New value to set (for set action). Use "true"/"false" for booleans, numbers as strings.',
        },
        category: {
          type: 'string',
          description: 'Category to list options for (for list action): skins, palettes, companions, providers, layouts, all',
          enum: ['skins', 'palettes', 'companions', 'providers', 'layouts', 'all'],
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'mermaid',
    description: 'Generate a Mermaid diagram. The output can be rendered as a visual graph.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Diagram type: flowchart, sequence, class, state, er, gantt, pie',
          enum: ['flowchart', 'sequence', 'class', 'state', 'er', 'gantt', 'pie'],
        },
        content: {
          type: 'string',
          description: 'The Mermaid diagram content (without the diagram type declaration)',
        },
        title: {
          type: 'string',
          description: 'Optional title for the diagram',
        },
      },
      required: ['type', 'content'],
    },
  },
];

/**
 * Get all available tools
 * Includes agent tools when agentEnabled is true
 */
export function getTools(agentEnabled: boolean = false): Tool[] {
  const pluginTools = getPluginTools();
  if (agentEnabled) {
    return [...TOOLS, ...getAgtermTools(), ...pluginTools];
  }
  return [...TOOLS, ...pluginTools];
}

/**
 * Validate path is within allowed directory (prevent path traversal)
 */
function validatePath(filePath: string, cwd: string): string {
  // Check raw input for null bytes before any resolution (path injection attack)
  if (filePath.includes('\0')) {
    throw new Error(`Invalid path: contains null bytes`);
  }

  // Check raw input for path traversal attempts before resolution
  if (filePath.includes('..')) {
    const resolved = path.resolve(cwd, filePath);
    const normalizedCwd = path.resolve(cwd);
    if (!resolved.startsWith(normalizedCwd + path.sep) && resolved !== normalizedCwd && !resolved.startsWith('/tmp/') && resolved !== '/tmp') {
      throw new Error(`Path traversal detected: ${filePath} resolves outside allowed scope`);
    }
  }

  // Primary validation via scope manager
  const validated = scopeValidatePath(filePath, cwd);

  return validated;
}

/**
 * Execute a tool call
 */
export async function executeTool(
  toolCall: ToolCall,
  cwd: string,
  timeout = 60000,
  onOutput?: (chunk: string) => void
): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  // Mirror tool call to scuttlebot
  if (scuttlebotClient.isEnabled()) {
    await scuttlebotClient.mirrorToolCall(name, args).catch(() => {
      // Silently fail - don't interrupt tool execution
    });
  }

  // Handle agent tools
  if (isAgtermTool(name)) {
    return executeAgtermTool(toolCall, cwd);
  }

  // Handle plugin tools
  if (isPluginTool(name)) {
    return executePluginTool(toolCall, cwd);
  }

  try {
    let result: string;

    switch (name) {
      case 'shell': {
        if (typeof args.command !== 'string') {
          return { toolCallId: id, result: 'Error: command must be a string', isError: true };
        }
        result = await executeShell(args.command, cwd, timeout, onOutput);
        break;
      }

      case 'read_file': {
        if (typeof args.path !== 'string') {
          return { toolCallId: id, result: 'Error: path must be a string', isError: true };
        }
        result = await readFile(args.path, cwd);
        break;
      }

      case 'write_file': {
        if (typeof args.path !== 'string') {
          return { toolCallId: id, result: 'Error: path must be a string', isError: true };
        }
        if (typeof args.content !== 'string') {
          return { toolCallId: id, result: 'Error: content must be a string', isError: true };
        }
        result = await writeFile(args.path, args.content, cwd);
        break;
      }

      case 'list_files': {
        const listPath = args.path !== undefined && typeof args.path !== 'string' ? undefined : args.path as string | undefined;
        const recursive = typeof args.recursive === 'boolean' ? args.recursive : false;
        result = await listFiles(listPath, recursive, cwd);
        break;
      }

      case 'think': {
        if (typeof args.thought !== 'string') {
          return { toolCallId: id, result: 'Error: thought must be a string', isError: true };
        }
        result = 'Thought recorded.';
        break;
      }

      case 'ask_question': {
        if (typeof args.question !== 'string') {
          return { toolCallId: id, result: 'Error: question must be a string', isError: true };
        }
        // The actual question display is handled by the UI layer (agent.ts)
        // This just returns a placeholder that gets replaced with the user's answer
        const options = Array.isArray(args.options) ? args.options as string[] : undefined;
        const contextNote = typeof args.context === 'string' ? args.context : undefined;
        let questionDisplay = args.question;
        if (contextNote) questionDisplay += `\n  Context: ${contextNote}`;
        if (options) questionDisplay += '\n' + options.map((o: string, i: number) => `  ${i + 1}. ${o}`).join('\n');
        result = `QUESTION:${questionDisplay}`;
        break;
      }

      case 'create_plan': {
        if (typeof args.title !== 'string') {
          return { toolCallId: id, result: 'Error: title must be a string', isError: true };
        }
        if (!Array.isArray(args.steps) || args.steps.length === 0) {
          return { toolCallId: id, result: 'Error: steps must be a non-empty array of strings', isError: true };
        }
        const planTitle = args.title;
        const planSteps = args.steps as string[];
        const planReasoning = typeof args.reasoning === 'string' ? args.reasoning : undefined;
        let planDisplay = `PLAN:${planTitle}\n`;
        if (planReasoning) planDisplay += `Approach: ${planReasoning}\n`;
        planDisplay += '\n' + planSteps.map((s: string, i: number) => `  ${i + 1}. [ ] ${s}`).join('\n');
        result = planDisplay;
        break;
      }

      case 'execute_code': {
        if (typeof args.language !== 'string' || !['python', 'node', 'bash'].includes(args.language)) {
          return { toolCallId: id, result: 'Error: language must be python, node, or bash', isError: true };
        }
        if (typeof args.code !== 'string') {
          return { toolCallId: id, result: 'Error: code must be a string', isError: true };
        }
        result = await executeCode(args.language as 'python' | 'node' | 'bash', args.code, cwd, timeout);
        break;
      }

      case 'web_search': {
        if (typeof args.query !== 'string' || args.query.trim().length === 0) {
          return { toolCallId: id, result: 'Error: query must be a non-empty string', isError: true };
        }
        const numResults = typeof args.num_results === 'number'
          ? Math.min(10, Math.max(1, args.num_results))
          : 5;
        result = await webSearch(args.query, numResults);
        break;
      }

      case 'git': {
        if (typeof args.operation !== 'string') {
          return { toolCallId: id, result: 'Error: operation must be a string', isError: true };
        }
        const gitArgs = typeof args.args === 'string' ? args.args : '';
        result = await executeGit(args.operation, gitArgs, cwd);
        break;
      }

      case 'configure': {
        const action = args.action as string;
        if (!action || !['get', 'set', 'list'].includes(action)) {
          return { toolCallId: id, result: 'Error: action must be "get", "set", or "list"', isError: true };
        }

        if (action === 'list') {
          const category = (args.category as string) || 'all';
          const sections: string[] = [];

          if (category === 'skins' || category === 'all') {
            const skins = listSkins();
            const current = config.get('activeSkin');
            sections.push('SKINS (activeSkin):\n' + skins.map(s =>
              `  ${s.name === current ? '→ ' : '  '}${s.name} - ${s.description}`
            ).join('\n'));
          }
          if (category === 'palettes' || category === 'all') {
            const palettes = listPalettes();
            const current = config.get('activePalette');
            sections.push('PALETTES (activePalette):\n' + palettes.map(p =>
              `  ${p.name === current ? '→ ' : '  '}${p.name} - ${p.description}`
            ).join('\n'));
          }
          if (category === 'companions' || category === 'all') {
            const companions = listCompanions();
            const current = config.get('activeCompanion');
            sections.push('COMPANIONS (activeCompanion):\n' + companions.map(c =>
              `  ${c.name === current ? '→ ' : '  '}${c.name} - ${c.description}`
            ).join('\n'));
          }
          if (category === 'providers' || category === 'all') {
            const providers = ['anthropic', 'google', 'openai', 'together', 'openrouter', 'groq', 'fireworks', 'mistral', 'ollama', 'ai21', 'huggingface', 'litellm', 'bedrock', 'auto'];
            const current = config.get('defaultProvider');
            sections.push('PROVIDERS (defaultProvider):\n' + providers.map(p =>
              `  ${p === current ? '→ ' : '  '}${p}`
            ).join('\n'));
          }
          if (category === 'layouts' || category === 'all') {
            const layouts = ['classic', 'response-top', 'response-bottom', 'split', 'zen', 'focus', 'dashboard', 'minimal'];
            const current = config.get('layout');
            sections.push('LAYOUTS (layout):\n' + layouts.map(l =>
              `  ${l === current ? '→ ' : '  '}${l}`
            ).join('\n'));
          }

          if (category === 'all') {
            // Also show current key settings
            const currentSettings = [
              `density: ${config.get('density')}`,
              `companionIntensity: ${config.get('companionIntensity')}`,
              `useEmojis: ${config.get('useEmojis')}`,
              `diffStyle: ${config.get('diffStyle')}`,
              `borderStyle: ${config.get('borderStyle')}`,
              `bannerStyle: ${config.get('bannerStyle')}`,
              `sandboxMode: ${config.get('sandboxMode')}`,
              `smartRoutingEnabled: ${config.get('smartRoutingEnabled')}`,
              `defaultModel: ${config.get('defaultModel') || '(auto)'}`,
            ];
            sections.push('CURRENT SETTINGS:\n' + currentSettings.map(s => `  ${s}`).join('\n'));
          }

          result = sections.join('\n\n');
          break;
        }

        if (action === 'get') {
          const key = args.key as string;
          if (!key) {
            return { toolCallId: id, result: 'Error: key is required for get action', isError: true };
          }
          const val = config.get(key as keyof import('./config.js').CalliopeConfig);
          result = `${key} = ${JSON.stringify(val)}`;
          break;
        }

        // action === 'set'
        const key = args.key as string;
        const rawValue = args.value as string;
        if (!key) {
          return { toolCallId: id, result: 'Error: key is required for set action', isError: true };
        }
        if (rawValue === undefined || rawValue === null) {
          return { toolCallId: id, result: 'Error: value is required for set action', isError: true };
        }

        // Only allow setting safe keys through conversation (allowlist)
        const SAFE_CONFIG_KEYS = new Set([
          'defaultProvider', 'defaultModel', 'persona', 'maxIterations', 'maxIterationTime',
          'fancyOutput', 'autoSaveHistory', 'autoUpgrade',
          'collapseTools', 'collapseThinking', 'toolDisplayLimit',
          'layout', 'density',
          'activeSkin', 'activePalette', 'activeCompanion', 'activeThemePack',
          'companionIntensity', 'useEmojis', 'diffStyle', 'borderStyle', 'bannerStyle',
          'circuitBreakersEnabled', 'sandboxMode',
          'smartRoutingEnabled', 'smartRoutingCostSensitivity',
          'recordSessions', 'recordingRetentionDays', 'sessionLogLimit',
          'awsRegion', 'awsProfile',
        ]);
        if (!SAFE_CONFIG_KEYS.has(key)) {
          return { toolCallId: id, result: `Error: "${key}" cannot be set through conversation. Use /keys command, environment variables, or edit the config file directly.`, isError: true };
        }

        // Parse the value to the correct type
        let parsedValue: unknown = rawValue;
        if (rawValue === 'true') parsedValue = true;
        else if (rawValue === 'false') parsedValue = false;
        else if (/^\d+(\.\d+)?$/.test(rawValue)) parsedValue = Number(rawValue);

        try {
          // Special handling for HUD settings that need apply functions
          if (key === 'activeSkin') {
            const success = applySkin(rawValue);
            if (!success) {
              return { toolCallId: id, result: `Error: skin "${rawValue}" not found. Use action "list" category "skins" to see available skins.`, isError: true };
            }
            result = `Skin changed to "${rawValue}"`;
            break;
          }
          if (key === 'activePalette') {
            const success = applyPalette(rawValue);
            if (!success) {
              return { toolCallId: id, result: `Error: palette "${rawValue}" not found. Use action "list" category "palettes" to see available palettes.`, isError: true };
            }
            result = `Palette changed to "${rawValue}"`;
            break;
          }
          if (key === 'activeCompanion') {
            if (!listCompanions().some(c => c.name === rawValue)) {
              return { toolCallId: id, result: `Error: companion "${rawValue}" not found. Use action "list" category "companions" to see available companions.`, isError: true };
            }
            config.set('activeCompanion', rawValue);
            result = `Companion changed to "${rawValue}"`;
            break;
          }

          // Generic config set
          config.set(key as keyof import('./config.js').CalliopeConfig, parsedValue as never);
          result = `Set ${key} = ${JSON.stringify(parsedValue)}`;
        } catch (err) {
          return { toolCallId: id, result: `Error setting ${key}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
        break;
      }

      case 'mermaid': {
        const diagramType = typeof args.type === 'string' ? args.type : 'flowchart';
        if (typeof args.content !== 'string') {
          return { toolCallId: id, result: 'Error: content must be a string', isError: true };
        }
        const title = typeof args.title === 'string' ? args.title : undefined;
        result = generateMermaidDiagram(diagramType, args.content, title);
        break;
      }

      case 'edit_file': {
        if (typeof args.path !== 'string') {
          return { toolCallId: id, result: 'Error: path must be a string', isError: true };
        }
        if (typeof args.old_string !== 'string') {
          return { toolCallId: id, result: 'Error: old_string must be a string', isError: true };
        }
        if (typeof args.new_string !== 'string') {
          return { toolCallId: id, result: 'Error: new_string must be a string', isError: true };
        }
        const replaceAll = args.replace_all === true;
        result = await editFile(args.path, args.old_string, args.new_string, replaceAll, cwd);
        break;
      }

      case 'glob': {
        if (typeof args.pattern !== 'string') {
          return { toolCallId: id, result: 'Error: pattern must be a string', isError: true };
        }
        const globCwd = typeof args.cwd === 'string' ? args.cwd : cwd;
        result = await globFiles(args.pattern, globCwd);
        break;
      }

      case 'grep': {
        if (typeof args.pattern !== 'string') {
          return { toolCallId: id, result: 'Error: pattern must be a string', isError: true };
        }
        const grepPath = typeof args.path === 'string' ? args.path : '.';
        const grepGlob = typeof args.glob === 'string' ? args.glob : undefined;
        const caseInsensitive = args.case_insensitive === true;
        result = await grepFiles(args.pattern, grepPath, cwd, grepGlob, caseInsensitive);
        break;
      }

      default:
        return { toolCallId: id, result: `Unknown tool: ${name}`, isError: true };
    }

    // Generate human-friendly display summary for large results (#25)
    const lines = result.split('\n');
    let displayResult: string | undefined;
    if (lines.length > 10) {
      const preview = lines.slice(0, 5).join('\n');
      displayResult = `${preview}\n... (${lines.length - 5} more lines)`;
    }

    return { toolCallId: id, result, displayResult };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { toolCallId: id, result: `Error: ${msg}`, isError: true };
  }
}

/**
 * Commands that are blocked outright (not just flagged as risky).
 * These are destructive system-level commands that should never be run by an agent.
 *
 * Patterns are tested against the normalized command (see normalizeCommand())
 * to defeat common bypass techniques like quoting, env prefixes, and subshells.
 */
const BLOCKED_COMMANDS = [
  /^sudo\s/,
  /^su\s/,
  /^rm\s+-rf\s+\//,      // rm -rf /
  /^rm\s+-fr\s+\//,
  /^rm\s+-rf\s+~/,       // rm -rf ~
  /^rm\s+-fr\s+~/,
  /^dd\s+.*of=\/dev\//,  // dd to block devices
  /^mkfs/,
  /^fdisk/,
  /^parted/,
  /^format/,
  />\s*\/dev\//,          // redirect to devices
  /^chmod\s+-R\s+777/,
  /^curl.*\|\s*(sh|bash)/, // pipe to shell
  /^wget.*\|\s*(sh|bash)/,
  /\|\s*sh(\s|;|$)/,      // pipe to sh (anywhere, not just end)
  /\|\s*bash(\s|;|$)/,    // pipe to bash (anywhere, not just end)
  /\|\s*zsh(\s|;|$)/,     // pipe to zsh
  /bash\s+<\(/,           // process substitution: bash <(...)
  /sh\s+<\(/,             // process substitution: sh <(...)
  /zsh\s+<\(/,            // process substitution: zsh <(...)
];

/**
 * Normalize a shell command to defeat common blocklist bypass techniques (#60).
 *
 * Handles:
 * - Leading env-var assignments: \`VAR=1 sudo ...\` -> \`sudo ...\`
 * - Subshell wrapping: \`(sudo rm ...)\` -> \`sudo rm ...\`
 * - Quote insertion: \`'su'do\` or \`"su"do\` -> \`sudo\`
 * - Backslash escaping: \`su\do\` -> \`sudo\`
 *
 * The result is used only for blocklist matching; the original command is still
 * passed to the shell for execution.
 */
function normalizeCommand(command: string): string {
  let cmd = command.trim();

  // Strip leading subshell / group wrappers: ( ... ), { ... }
  while (
    (cmd.startsWith('(') && cmd.endsWith(')')) ||
    (cmd.startsWith('{') && cmd.endsWith('}'))
  ) {
    cmd = cmd.slice(1, -1).trim();
  }

  // Strip leading env-var assignments: FOO=bar BAZ="qux" command ...
  cmd = cmd.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');

  // Remove inserted quotes that break up words: 'su'do -> sudo, "su"do -> sudo
  cmd = cmd.replace(/['"]/g, '');

  // Remove backslash escapes: su\do -> sudo
  cmd = cmd.replace(/\\(.)/g, '$1');

  return cmd.trim();
}

/**
 * Check a command (and all sub-commands separated by ; or &&/||) against
 * the blocklist. Returns the matching pattern source string, or null if allowed.
 */
function matchesBlocklist(command: string): string | null {
  // Split on command separators to check each sub-command
  const subCommands = command.split(/\s*(?:;|&&|\|\|)\s*/);

  for (const sub of subCommands) {
    const normalized = normalizeCommand(sub);
    for (const pattern of BLOCKED_COMMANDS) {
      if (pattern.test(normalized)) {
        return pattern.source;
      }
    }
  }

  // Also test the full normalized command (for patterns that span separators, like pipes)
  const fullNormalized = normalizeCommand(command);
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(fullNormalized)) {
      return pattern.source;
    }
  }

  return null;
}

/**
 * Extract file paths from a shell command for scope validation (#63).
 *
 * Looks for common file-access commands (cat, cp, mv, head, tail, etc.) and
 * extracts the path arguments. Only absolute paths and paths starting with ~/
 * are extracted, since relative paths are within the cwd which is already in scope.
 *
 * Returns an array of extracted paths (may be empty).
 */
function extractFilePathsFromCommand(command: string): string[] {
  const paths: string[] = [];

  // Commands that read or write files, followed by path arguments
  const fileCommands = [
    'cat', 'head', 'tail', 'less', 'more', 'cp', 'mv', 'rm',
    'tee', 'touch', 'chmod', 'chown', 'ln', 'readlink',
    'source', '\\.',
  ];

  const cmdPattern = new RegExp(
    '(?:^|[;&|]\\s*)(?:' + fileCommands.join('|') + ')\\s+' +
    '(?:-[^\\s]*\\s+)*' +
    '((?:\\/|~\\/)[^\\s;|&>]+)',
    'g'
  );

  let match;
  while ((match = cmdPattern.exec(command)) !== null) {
    let p = match[1];
    if (p.startsWith('~/')) {
      p = path.join(process.env.HOME || '/tmp', p.slice(2));
    }
    p = p.replace(/['"]+$/, '');
    paths.push(p);
  }

  // Also catch redirection targets: > /path, >> /path
  const redirectPattern = />{1,2}\s*((?:\/|~\/)[^\s;|&]+)/g;
  while ((match = redirectPattern.exec(command)) !== null) {
    let p = match[1];
    if (p.startsWith('~/')) {
      p = path.join(process.env.HOME || '/tmp', p.slice(2));
    }
    p = p.replace(/['"]+$/, '');
    paths.push(p);
  }

  return paths;
}

/**
 * Validate that a shell command does not access files outside scope (#63).
 * Returns an error message if a path violation is found, or null if ok.
 */
function validateShellPaths(command: string, cwd: string): string | null {
  const extractedPaths = extractFilePathsFromCommand(command);
  for (const p of extractedPaths) {
    const allowed = isInScope(p, cwd);
    if (!allowed) {
      return 'Shell command blocked: "' + p + '" is outside allowed scope. Use /add-dir to expand scope.';
    }
  }
  return null;
}

/**
 * Determine whether to use native sandboxing for shell commands based on config.
 *
 * sandboxMode values:
 *  - 'auto':   use native sandbox when available, otherwise run unsandboxed
 *  - 'native': require native sandbox (fail if unavailable)
 *  - 'docker': defer to Docker sandbox (handled elsewhere)
 *  - 'off':    no sandboxing
 */
function shouldUseNativeSandbox(): 'use' | 'skip' | 'require' {
  const mode = config.get('sandboxMode') || 'auto';
  if (mode === 'off' || mode === 'docker') return 'skip';
  if (mode === 'native') return 'require';
  // 'auto': use if available
  return nativeSandbox.isNativeSandboxAvailable() ? 'use' : 'skip';
}

/**
 * Execute a shell command
 */
async function executeShell(command: string, cwd: string, timeout: number, onOutput?: (chunk: string) => void): Promise<string> {
  // Check against blocked command patterns using normalized matching (#60)
  const blocked = matchesBlocklist(command);
  if (blocked) {
    return `Error: Command blocked for safety. Pattern "${blocked}" is not allowed.`;
  }

  // Check file paths in shell commands against scope (#63)
  const scopeError = validateShellPaths(command, cwd);
  if (scopeError) {
    return `Error: ${scopeError}`;
  }

  // Check if native sandbox should be used
  const sandboxDecision = shouldUseNativeSandbox();

  if (sandboxDecision === 'require' && !nativeSandbox.isNativeSandboxAvailable()) {
    return 'Error: Native sandbox required (sandboxMode=native) but not available on this platform.';
  }

  if (sandboxDecision === 'use' || sandboxDecision === 'require') {
    const result = await nativeSandbox.executeInNativeSandbox(command, cwd, {
      timeout,
      networkEnabled: true,
    });

    // Shell tool output is transparent — same format as unsandboxed execution
    let output = result.stdout + (result.stderr ? `\nstderr: ${result.stderr}` : '');

    if (result.exitCode !== 0) {
      return `Exit code ${result.exitCode}\n${output}`;
    }
    return output || '(no output)';
  }

  // Fallback: unsandboxed execution
  const MAX_OUTPUT_SIZE = 50000; // 50K chars max output

  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (onOutput) onOutput(chunk);
      if (!truncated) {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE);
          truncated = true;
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (onOutput) onOutput(chunk);
      if (!truncated) {
        stderr += chunk;
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
          truncated = true;
        }
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Command timed out'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      let output = stdout + (stderr ? `\nstderr: ${stderr}` : '');

      if (truncated) {
        output += '\n\n[Output truncated at 50K chars. Use head/tail/grep to filter.]';
      }

      if (code !== 0) {
        resolve(`Exit code ${code}\n${output}`);
      } else {
        resolve(output || '(no output)');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Read a file
 */
async function readFile(filePath: string, cwd: string): Promise<string> {
  const absPath = validatePath(filePath, cwd);

  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    throw new Error(`Path is a directory: ${absPath}`);
  }

  // Check file size (limit to 1MB)
  if (stats.size > 1024 * 1024) {
    throw new Error(`File too large (${Math.round(stats.size / 1024)}KB). Max 1MB.`);
  }

  const content = fs.readFileSync(absPath, 'utf-8');

  // Inline file preview header (#119)
  const PREVIEW_CAP = 20;
  const allLines = content.split('\n');
  const totalLines = allLines.length;
  const previewLines = allLines.slice(0, PREVIEW_CAP);
  const header = `[file: ${filePath} \u2014 ${totalLines} line${totalLines !== 1 ? 's' : ''}]\n${'─'.repeat(40)}`;
  const previewBody = previewLines.join('\n');
  const footer = totalLines > PREVIEW_CAP ? `\n... (${totalLines - PREVIEW_CAP} more lines)` : '';

  return `${header}\n${previewBody}${footer}\n\n${content}`;
}

/**
 * Generate a simple line-diff between old and new content
 */
function generateDiff(oldContent: string, newContent: string, maxLines = 20): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const diff: string[] = [];
  const maxIdx = Math.max(oldLines.length, newLines.length);

  // Track statistics
  let additions = 0;
  let deletions = 0;
  let changesShown = 0;
  let contextLines = 0;
  // Use density setting: compact = 1 context line, normal = 3
  const density = config.get('density') || 'normal';
  const contextWindow = density === 'compact' ? 1 : 3;

  // Compute line number width
  const lineNumWidth = Math.max(4, maxIdx.toString().length);
  const padNum = (n: number | string) => String(n).padStart(lineNumWidth, ' ');

  for (let i = 0; i < maxIdx; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    const lineNum = i + 1;

    if (oldLine === newLine) {
      // Same line - show as context if near a change
      if (contextLines > 0) {
        diff.push(`${padNum(lineNum)}    ${newLine || ''}`);
        contextLines--;
      }
    } else {
      // Change detected
      changesShown++;
      if (changesShown > maxLines) {
        diff.push('  ... (more changes truncated)');
        break;
      }

      // Add separator for new change region
      if (contextLines === 0 && diff.length > 0) {
        diff.push('');
      }

      if (oldLine !== undefined && i < oldLines.length) {
        diff.push(`${padNum(lineNum)} -  ${oldLine}`);
        deletions++;
      }
      if (newLine !== undefined && i < newLines.length) {
        diff.push(`${padNum(lineNum)} +  ${newLine}`);
        additions++;
      }

      contextLines = contextWindow;
    }
  }

  // Add summary header
  const summary = additions > 0 && deletions > 0
    ? `Modified ${additions + deletions} lines`
    : additions > 0
      ? `Added ${additions} line${additions !== 1 ? 's' : ''}`
      : `Removed ${deletions} line${deletions !== 1 ? 's' : ''}`;

  return `⎿  ${summary}\n${diff.join('\n')}`;
}

/**
 * Write a file
 */
async function writeFile(filePath: string, content: string, cwd: string): Promise<string> {
  const absPath = validatePath(filePath, cwd);

  // Create directory if needed
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Read existing content for diff
  let oldContent = '';
  let isNewFile = true;
  if (fs.existsSync(absPath)) {
    try {
      const stats = fs.statSync(absPath);
      if (!stats.isDirectory() && stats.size < 100 * 1024) {
        oldContent = fs.readFileSync(absPath, 'utf-8');
        isNewFile = false;
      }
    } catch {
      // Ignore errors reading old content
    }
  }

  // Auto-checkpoint before overwriting existing files (#20)
  if (!isNewFile && oldContent) {
    try {
      const { createCheckpoint } = require('./checkpoint.js');
      createCheckpoint(absPath, oldContent);
    } catch {
      // Checkpoint module not available or failed - continue with write
    }
  }

  fs.writeFileSync(absPath, content);

  // Generate diff output (#119)
  const DIFF_CAP = 50;
  const header = `[wrote: ${filePath}]\n${'─'.repeat(Math.min(filePath.length + 9, 60))}`;
  if (isNewFile) {
    const allLines = content.split('\n');
    const previewLines = allLines.slice(0, DIFF_CAP);
    const diffLines = previewLines.map(l => `+${l}`);
    const more = allLines.length > DIFF_CAP ? `\n... (${allLines.length - DIFF_CAP} more lines)` : '';
    return `${header}\n[new file: ${filePath}]\n--- /dev/null\n+++ b/${filePath}\n${diffLines.join('\n')}${more}`;
  } else {
    const fileDiff = generateFileDiff(oldContent, content, filePath);
    const diffParts: string[] = [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
    ];
    const diffLines = fileDiff.lines.filter(l => l.type !== 'header');
    let lineCount = 0;
    let truncated = false;
    for (const line of diffLines) {
      if (line.type === 'context') continue; // skip context for compact output
      if (lineCount >= DIFF_CAP) { truncated = true; break; }
      const prefix = line.type === 'add' ? '+' : '-';
      diffParts.push(`${prefix}${line.content}`);
      lineCount++;
    }
    if (truncated) diffParts.push(`... (diff truncated at ${DIFF_CAP} lines)`);
    if (lineCount === 0) {
      return `File unchanged: ${filePath}`;
    }
    return `${header}\n${diffParts.join('\n')}`;
  }
}

/**
 * List files in a directory
 */
async function listFiles(dirPath: string | undefined, recursive: boolean | undefined, cwd: string): Promise<string> {
  const absPath = dirPath ? validatePath(dirPath, cwd) : cwd;

  if (!fs.existsSync(absPath)) {
    throw new Error(`Directory not found: ${absPath}`);
  }

  const stats = fs.statSync(absPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${absPath}`);
  }

  if (recursive) {
    return listFilesRecursive(absPath, '', 0);
  }

  const entries = fs.readdirSync(absPath, { withFileTypes: true });
  const lines: string[] = [];

  for (const entry of entries.slice(0, 100)) {
    const prefix = entry.isDirectory() ? '📁 ' : '📄 ';
    lines.push(`${prefix}${entry.name}`);
  }

  if (entries.length > 100) {
    lines.push(`... and ${entries.length - 100} more`);
  }

  return lines.join('\n') || '(empty directory)';
}

/**
 * List files recursively
 */
function listFilesRecursive(dir: string, prefix: string, depth: number): string {
  if (depth > 5) return `${prefix}(max depth reached)`;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const lines: string[] = [];

  for (const entry of entries.slice(0, 50)) {
    if (entry.name.startsWith('.')) continue; // Skip hidden files

    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      lines.push(`${prefix}📁 ${entry.name}/`);
      lines.push(listFilesRecursive(entryPath, prefix + '  ', depth + 1));
    } else {
      lines.push(`${prefix}📄 ${entry.name}`);
    }
  }

  if (entries.length > 50) {
    lines.push(`${prefix}... and ${entries.length - 50} more`);
  }

  return lines.join('\n');
}

/**
 * Execute code in a sandboxed environment.
 *
 * Sandbox selection order based on sandboxMode config:
 *  - 'docker': Docker only (existing behaviour)
 *  - 'native': native OS sandbox only
 *  - 'auto':   Docker first, then native sandbox, then unsandboxed
 *  - 'off':    no sandboxing
 */
async function executeCode(
  language: 'python' | 'node' | 'bash',
  code: string,
  cwd: string,
  timeout: number
): Promise<string> {
  const mode = config.get('sandboxMode') || 'auto';
  const sandboxLang = language === 'node' ? 'node' : language;

  // Determine execution strategy
  const useDocker = mode === 'docker' || (mode === 'auto' && sandbox.isDockerAvailable());
  const useNative = mode === 'native' || (mode === 'auto' && !sandbox.isDockerAvailable() && nativeSandbox.isNativeSandboxAvailable());

  if (useDocker) {
    // Docker sandbox path (existing behaviour)
    const result = await sandbox.execute(sandboxLang as sandbox.Language, code, {
      timeout,
      mountWorkdir: true,
      readOnly: true,
    }, cwd);

    const sandboxIndicator = result.sandboxed ? '[sandboxed:docker]' : '[unsandboxed]';
    const statusIndicator = result.success ? 'ok' : 'err';
    let output = `${sandboxIndicator} ${statusIndicator} [${language}]\n`;
    if (result.stdout) output += `Output:\n${result.stdout}\n`;
    if (result.stderr) output += `Errors:\n${result.stderr}\n`;
    if (!result.success && !result.stdout && !result.stderr) output += `Exit code: ${result.exitCode}\n`;
    output += `Duration: ${result.duration}ms`;
    return output;
  }

  if (useNative) {
    // Native OS sandbox path — write code to temp file and execute
    const fs = await import('fs');
    const os = await import('os');
    const pathMod = await import('path');
    const tempDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'calliope-native-'));
    const ext = language === 'python' ? 'py' : language === 'node' ? 'js' : 'sh';
    const codePath = pathMod.join(tempDir, `code.${ext}`);
    fs.writeFileSync(codePath, code);

    const cmd = language === 'python' ? `python3 "${codePath}"`
      : language === 'node' ? `node "${codePath}"`
      : `bash "${codePath}"`;

    const startTime = Date.now();
    const result = await nativeSandbox.executeInNativeSandbox(cmd, cwd, {
      timeout,
      readOnlyPaths: [tempDir],
    });

    // Cleanup temp
    try { fs.rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }

    const duration = Date.now() - startTime;
    const sandboxIndicator = result.sandboxed ? `[sandboxed:${result.backend}]` : '[unsandboxed]';
    const statusIndicator = result.exitCode === 0 ? 'ok' : 'err';
    let output = `${sandboxIndicator} ${statusIndicator} [${language}]\n`;
    if (result.stdout) output += `Output:\n${result.stdout}\n`;
    if (result.stderr) output += `Errors:\n${result.stderr}\n`;
    if (result.exitCode !== 0 && !result.stdout && !result.stderr) output += `Exit code: ${result.exitCode}\n`;
    output += `Duration: ${duration}ms`;
    return output;
  }

  // Unsandboxed fallback (mode === 'off' or nothing available)
  const result = await sandbox.executeUnsafe(sandboxLang as sandbox.Language, code, timeout);

  const statusIndicator = result.success ? 'ok' : 'err';
  let output = `[unsandboxed] ${statusIndicator} [${language}]\n`;
  if (result.stdout) output += `Output:\n${result.stdout}\n`;
  if (result.stderr) output += `Errors:\n${result.stderr}\n`;
  if (!result.success && !result.stdout && !result.stderr) output += `Exit code: ${result.exitCode}\n`;
  output += `Duration: ${result.duration}ms`;
  return output;
}

/**
 * Search the web using DuckDuckGo
 */
async function webSearch(query: string, numResults: number): Promise<string> {
  try {
    // Use DuckDuckGo HTML search (no API key needed)
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    const https = await import('https');

    return new Promise((resolve) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Calliope/1.0)',
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // Parse results from HTML
          const results: string[] = [];
          const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)/g;
          const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([^<]*)/g;

          let match;
          let snippetMatch;
          let i = 0;

          while ((match = linkRegex.exec(data)) !== null && i < numResults) {
            const href = match[1];
            const title = match[2].replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

            // Get corresponding snippet
            snippetMatch = snippetRegex.exec(data);
            const snippet = snippetMatch
              ? snippetMatch[1].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").substring(0, 150)
              : '';

            results.push(`${i + 1}. ${title}\n   ${snippet}\n   ${href}\n`);
            i++;
          }

          if (results.length === 0) {
            resolve(`No results found for: ${query}`);
          } else {
            resolve(`Web search results for "${query}":\n\n${results.join('\n')}`);
          }
        });
      });

      req.on('error', (err) => {
        resolve(`Search error: ${err.message}`);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve('Search timed out');
      });
    });
  } catch (err) {
    return `Search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Execute git commands safely
 */
async function executeGit(operation: string, args: string, cwd: string): Promise<string> {
  const allowedOps = ['status', 'diff', 'log', 'branch', 'add', 'commit', 'push', 'pull', 'stash'];

  if (!allowedOps.includes(operation)) {
    return `Error: Unknown git operation: ${operation}. Allowed: ${allowedOps.join(', ')}`;
  }

  // Sanitize args to prevent command injection via shell metacharacters
  const safeArgs = args.replace(/[;&|`$(){}!#\n\r]/g, '');

  let command: string;
  switch (operation) {
    case 'status':
      command = 'git status --short';
      break;
    case 'diff':
      command = `git diff ${safeArgs}`.trim();
      break;
    case 'log':
      command = `git log --oneline -20 ${safeArgs}`.trim();
      break;
    case 'branch':
      command = `git branch ${safeArgs}`.trim();
      break;
    case 'add':
      command = `git add ${safeArgs || '.'}`.trim();
      break;
    case 'commit':
      if (!safeArgs.includes('-m')) {
        return 'Error: commit requires -m "message"';
      }
      command = `git commit ${safeArgs}`.trim();
      break;
    case 'push':
      command = `git push ${safeArgs}`.trim();
      break;
    case 'pull':
      command = `git pull ${safeArgs}`.trim();
      break;
    case 'stash':
      command = `git stash ${safeArgs}`.trim();
      break;
    default:
      return `Unknown operation: ${operation}`;
  }

  return executeShell(command, cwd, 30000);
}

/**
 * Generate a Mermaid diagram
 */
function generateMermaidDiagram(type: string, content: string, title?: string): string {
  const header = title ? `---\ntitle: ${title}\n---\n` : '';

  // Map type to Mermaid syntax
  const typeMap: Record<string, string> = {
    'flowchart': 'flowchart TD',
    'sequence': 'sequenceDiagram',
    'class': 'classDiagram',
    'state': 'stateDiagram-v2',
    'er': 'erDiagram',
    'gantt': 'gantt',
    'pie': 'pie',
  };

  const diagramType = typeMap[type] || 'flowchart TD';

  const diagram = `\`\`\`mermaid
${header}${diagramType}
${content}
\`\`\``;

  return `MERMAID_DIAGRAM:\n${diagram}\n\nTo view this diagram, paste the mermaid code into https://mermaid.live or a markdown viewer that supports Mermaid.`;
}

/**
 * Edit a file by replacing an exact string (in-place edit).
 * Supports single-occurrence enforcement or replace_all mode.
 */
async function editFile(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  cwd: string,
): Promise<string> {
  const absPath = validatePath(filePath, cwd);

  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    throw new Error(`Path is a directory: ${absPath}`);
  }

  const content = fs.readFileSync(absPath, 'utf-8');

  // Helper to build a compact edit diff from old_string/new_string (#119)
  const buildEditDiff = (oldStr: string, newStr: string, fPath: string, count: number): string => {
    const DIFF_CAP = 50;
    const label = count === 1 ? '1 occurrence' : `${count} occurrences`;
    const header = `[edited: ${fPath} — replaced ${label}]\n${'─'.repeat(Math.min(fPath.length + 10, 60))}`;
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    const diffParts: string[] = [
      `--- a/${fPath}`,
      `+++ b/${fPath}`,
    ];
    let lineCount = 0;
    let truncated = false;
    for (const line of oldLines) {
      if (lineCount >= DIFF_CAP) { truncated = true; break; }
      diffParts.push(`-${line}`);
      lineCount++;
    }
    if (!truncated) {
      for (const line of newLines) {
        if (lineCount >= DIFF_CAP) { truncated = true; break; }
        diffParts.push(`+${line}`);
        lineCount++;
      }
    }
    if (truncated) diffParts.push(`... (diff truncated at ${DIFF_CAP} lines)`);
    return `${header}\n${diffParts.join('\n')}`;
  };

  if (replaceAll) {
    const updated = content.replaceAll(oldString, newString);
    const count = (content.split(oldString).length - 1);
    if (count === 0) {
      throw new Error(`old_string not found in file: ${absPath}`);
    }
    fs.writeFileSync(absPath, updated);
    return buildEditDiff(oldString, newString, filePath, count);
  }

  // Count occurrences
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`old_string not found in file: ${absPath}`);
  }
  if (occurrences > 1) {
    throw new Error(
      `old_string matches ${occurrences} occurrences — use replace_all: true or make it more specific`,
    );
  }

  const updated = content.replace(oldString, newString);
  fs.writeFileSync(absPath, updated);
  return buildEditDiff(oldString, newString, filePath, 1);
}

/**
 * Convert a glob pattern to a RegExp.
 * Supports: *, **, ?, {a,b} syntax.
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any path segment including slashes
        regexStr += '.*';
        i += 2;
        // Consume optional trailing slash
        if (pattern[i] === '/') i++;
      } else {
        // * matches anything except /
        regexStr += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '{') {
      // {a,b,c} → (a|b|c)
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        regexStr += '\\{';
        i++;
      } else {
        const options = pattern.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$[\]\\(){}|]/g, '\\$&'));
        regexStr += `(?:${options.join('|')})`;
        i = end + 1;
      }
    } else if ('.+^$[]\\(){}|'.includes(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  return new RegExp(`^${regexStr}$`);
}

/**
 * Recursively walk a directory and collect all file paths relative to the base.
 */
function walkDir(dir: string, base: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath);
    if (entry.isDirectory()) {
      walkDir(fullPath, base, results);
    } else {
      results.push(relPath);
    }
  }
}

/**
 * Find files matching a glob pattern.
 */
async function globFiles(pattern: string, searchCwd: string): Promise<string> {
  const absCwd = path.isAbsolute(searchCwd)
    ? path.resolve(searchCwd)
    : path.resolve(searchCwd);

  let exists = false;
  try {
    exists = fs.existsSync(absCwd) && fs.statSync(absCwd).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    throw new Error(`Directory not found: ${absCwd}`);
  }

  const regex = globToRegex(pattern);

  const allFiles: string[] = [];
  walkDir(absCwd, absCwd, allFiles);

  // Normalize to forward slashes for matching (glob convention)
  const matched = allFiles
    .filter(f => regex.test(f.replace(/\\/g, '/')))
    .sort();

  if (matched.length === 0) {
    return `No files matched pattern: ${pattern}`;
  }

  return matched.join('\n');
}

/**
 * Search file contents using a regex pattern (or literal string fallback).
 */
async function grepFiles(
  pattern: string,
  searchPath: string,
  cwd: string,
  globPattern: string | undefined,
  caseInsensitive: boolean,
): Promise<string> {
  // Resolve search path relative to cwd
  const absSearchPath = path.isAbsolute(searchPath)
    ? path.resolve(searchPath)
    : path.resolve(cwd, searchPath);

  // Validate access
  try {
    validatePath(absSearchPath, cwd);
  } catch {
    throw new Error(`Access denied: ${searchPath} is outside allowed scope`);
  }

  if (!fs.existsSync(absSearchPath)) {
    throw new Error(`Path not found: ${absSearchPath}`);
  }

  // Build the regex, fallback to literal if invalid
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch {
    // Treat as literal string
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, caseInsensitive ? 'i' : '');
  }

  // Collect files to search
  let filesToSearch: string[];
  const stat = fs.statSync(absSearchPath);
  if (stat.isFile()) {
    filesToSearch = [absSearchPath];
  } else {
    const all: string[] = [];
    walkDir(absSearchPath, absSearchPath, all);
    filesToSearch = all.map(f => path.join(absSearchPath, f));
  }

  // Apply glob filter if provided
  if (globPattern) {
    const globRegex = globToRegex(globPattern);
    filesToSearch = filesToSearch.filter(f => {
      const basename = path.basename(f);
      return globRegex.test(basename) || globRegex.test(f.replace(/\\/g, '/'));
    });
  }

  const results: string[] = [];
  const MAX_RESULTS = 200;

  for (const filePath of filesToSearch) {
    if (results.length >= MAX_RESULTS) break;

    let content: string;
    try {
      const fileStat = fs.statSync(filePath);
      if (fileStat.size > 5 * 1024 * 1024) continue; // skip files > 5MB
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const relPath = path.relative(cwd, filePath);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (results.length >= MAX_RESULTS) break;
      if (regex.test(lines[lineIdx])) {
        results.push(`${relPath}:${lineIdx + 1}: ${lines[lineIdx]}`);
      }
    }
  }

  if (results.length === 0) {
    return 'No matches found';
  }

  let output = results.join('\n');
  if (results.length >= MAX_RESULTS) {
    output += `\n(results truncated at ${MAX_RESULTS} matches)`;
  }
  return output;
}
