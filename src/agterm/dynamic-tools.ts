/**
 * Dynamic Tool System
 *
 * Allows agents to create, register, and use tools at runtime.
 * Tools can be shell commands with template placeholders or code
 * executed via node/python/bash. Persistent tools are saved to
 * `.calliope/tools/` as JSON files and reloaded on startup.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { Tool, ToolCall, ToolResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DynamicTool {
  name: string;
  description: string;
  parameters: Tool['parameters'];
  /** Shell command template with {{param}} placeholders */
  command?: string;
  /** JavaScript/TypeScript code to execute */
  code?: string;
  /** Language for code execution */
  language?: 'node' | 'python' | 'bash';
  /** Who created this tool */
  createdBy: string;
  /** When created */
  createdAt: Date;
  /** Persist across sessions */
  persistent?: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const RESERVED_NAMES = new Set([
  'create_tool', 'list_dynamic_tools', 'remove_tool',
  'execute_command', 'read_file', 'write_file', 'think',
  'create_plan', 'list_files', 'search_files', 'search_code',
]);

const DANGEROUS_PATTERNS = [
  /\.\.\//,           // path traversal
  /\.\.\\/,           // windows path traversal
  /;\s*rm\s+-rf/i,    // rm -rf injection
  /;\s*sudo\b/i,      // sudo injection
  /;\s*dd\b/i,        // dd injection
  /;\s*mkfs\b/i,      // mkfs injection
  /\$\(.*\)/,         // command substitution
  /`[^`]*`/,          // backtick substitution
];

function validateName(name: string): void {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
    throw new Error(
      `Invalid tool name "${name}". Must be lowercase letters, digits, underscores, 2-64 chars, start with a letter.`
    );
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Tool name "${name}" is reserved and cannot be used.`);
  }
}

function sanitizeArg(value: unknown): string {
  const str = String(value);
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(str)) {
      throw new Error(`Argument value rejected by security check: ${str}`);
    }
  }
  return str;
}

function substituteParams(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in args)) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return sanitizeArg(args[key]);
  });
}

// ---------------------------------------------------------------------------
// Serialisation helpers (Date round-tripping)
// ---------------------------------------------------------------------------

interface DynamicToolJSON extends Omit<DynamicTool, 'createdAt'> {
  createdAt: string;
}

function toolToJSON(tool: DynamicTool): DynamicToolJSON {
  return { ...tool, createdAt: tool.createdAt.toISOString() };
}

function toolFromJSON(json: DynamicToolJSON): DynamicTool {
  return { ...json, createdAt: new Date(json.createdAt) };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 30_000; // 30 seconds

export class DynamicToolRegistry {
  private static instance: DynamicToolRegistry | null = null;
  private tools = new Map<string, DynamicTool>();

  private constructor() {}

  static getInstance(): DynamicToolRegistry {
    if (!DynamicToolRegistry.instance) {
      DynamicToolRegistry.instance = new DynamicToolRegistry();
    }
    return DynamicToolRegistry.instance;
  }

  // -- CRUD ----------------------------------------------------------------

  register(tool: DynamicTool): void {
    validateName(tool.name);
    if (this.tools.has(tool.name)) {
      throw new Error(`Dynamic tool "${tool.name}" is already registered. Remove it first.`);
    }
    this.tools.set(tool.name, { ...tool });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): DynamicTool | undefined {
    return this.tools.get(name);
  }

  getAll(): DynamicTool[] {
    return Array.from(this.tools.values());
  }

  isDynamic(name: string): boolean {
    return this.tools.has(name);
  }

  reset(): void {
    this.tools.clear();
  }

  // -- LLM integration -----------------------------------------------------

  /** Return Tool[] definitions suitable for sending to the LLM. */
  getToolDefinitions(): Tool[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: `[dynamic] ${t.description}`,
      parameters: t.parameters,
    }));
  }

  // -- Execution -----------------------------------------------------------

  async execute(toolCall: ToolCall, cwd: string): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        result: `Error: dynamic tool "${toolCall.name}" not found.`,
        isError: true,
      };
    }

    try {
      const output = this.run(tool, toolCall.arguments, cwd);
      return {
        toolCallId: toolCall.id,
        result: output.slice(0, 50_000), // cap output size
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        toolCallId: toolCall.id,
        result: `Error executing dynamic tool "${toolCall.name}": ${msg}`,
        isError: true,
      };
    }
  }

  private run(tool: DynamicTool, args: Record<string, unknown>, cwd: string): string {
    const resolvedCwd = resolve(cwd);

    if (tool.command) {
      const cmd = substituteParams(tool.command, args);
      return execSync(cmd, {
        cwd: resolvedCwd,
        timeout: DEFAULT_TIMEOUT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    }

    if (tool.code) {
      const lang = tool.language ?? 'bash';
      const code = substituteParams(tool.code, args);
      let cmd: string;

      switch (lang) {
        case 'node':
          // Wrap in an IIFE so multi-statement code works and last expression is printed
          cmd = `node -e ${shellEscape(code)}`;
          break;
        case 'python':
          cmd = `python3 -c ${shellEscape(code)}`;
          break;
        case 'bash':
          cmd = `bash -c ${shellEscape(code)}`;
          break;
        default:
          throw new Error(`Unsupported language: ${lang}`);
      }

      return execSync(cmd, {
        cwd: resolvedCwd,
        timeout: DEFAULT_TIMEOUT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    }

    throw new Error('Dynamic tool has neither "command" nor "code" defined.');
  }

  // -- Persistence ---------------------------------------------------------

  private toolsDir(cwd: string): string {
    return join(resolve(cwd), '.calliope', 'tools');
  }

  save(cwd: string): void {
    const dir = this.toolsDir(cwd);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write each persistent tool as its own JSON file
    for (const tool of this.tools.values()) {
      if (!tool.persistent) continue;
      const filePath = join(dir, `${tool.name}.json`);
      writeFileSync(filePath, JSON.stringify(toolToJSON(tool), null, 2), 'utf-8');
    }

    // Remove JSON files for tools that no longer exist
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const name = file.replace(/\.json$/, '');
        if (!this.tools.has(name)) {
          unlinkSync(join(dir, file));
        }
      }
    }
  }

  load(cwd: string): void {
    const dir = this.toolsDir(cwd);
    if (!existsSync(dir)) return;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const json: DynamicToolJSON = JSON.parse(raw);
        const tool = toolFromJSON(json);
        // Skip if already registered (runtime takes precedence)
        if (!this.tools.has(tool.name)) {
          this.tools.set(tool.name, tool);
        }
      } catch {
        // Silently skip malformed files
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shell escape helper
// ---------------------------------------------------------------------------

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// Singleton & convenience exports
// ---------------------------------------------------------------------------

export const dynamicToolRegistry = DynamicToolRegistry.getInstance();

export function isDynamicTool(name: string): boolean {
  return dynamicToolRegistry.isDynamic(name);
}

export function executeDynamicTool(toolCall: ToolCall, cwd: string): Promise<ToolResult> {
  return dynamicToolRegistry.execute(toolCall, cwd);
}

// ---------------------------------------------------------------------------
// Meta-tool definitions (create_tool, list_dynamic_tools, remove_tool)
// ---------------------------------------------------------------------------

export const DYNAMIC_TOOL_NAMES = [
  'create_tool',
  'list_dynamic_tools',
  'remove_tool',
] as const;

export function getDynamicToolDefs(): Tool[] {
  return [
    {
      name: 'create_tool',
      description:
        'Create a new dynamic tool that can be used in future turns. ' +
        'Provide either a shell command template (with {{param}} placeholders) or code to execute.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Tool name (lowercase, underscores, 2-64 chars, starts with letter). E.g. "count_lines".',
          },
          description: {
            type: 'string',
            description: 'What the tool does — shown to the LLM.',
          },
          parameters: {
            type: 'string',
            description:
              'JSON string describing parameters object: { "type": "object", "properties": { ... }, "required": [...] }',
          },
          command: {
            type: 'string',
            description:
              'Shell command template. Use {{param}} for parameter substitution. E.g. "wc -l {{file}}".',
          },
          code: {
            type: 'string',
            description: 'Code to execute (used if command is not provided).',
          },
          language: {
            type: 'string',
            description: 'Language for code execution.',
            enum: ['node', 'python', 'bash'],
          },
          persistent: {
            type: 'string',
            description: 'Set to "true" to persist this tool across sessions.',
          },
        },
        required: ['name', 'description', 'parameters'],
      },
    },
    {
      name: 'list_dynamic_tools',
      description: 'List all dynamically created tools.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'remove_tool',
      description: 'Remove a dynamically created tool by name.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the dynamic tool to remove.',
          },
        },
        required: ['name'],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Meta-tool executor
// ---------------------------------------------------------------------------

export async function executeMetaTool(
  toolCall: ToolCall,
  cwd: string,
  agentId: string = 'user',
): Promise<ToolResult> {
  const { name, arguments: args } = toolCall;

  switch (name) {
    case 'create_tool': {
      try {
        const toolName = String(args.name ?? '');
        const description = String(args.description ?? '');
        let params: Tool['parameters'];

        try {
          params = JSON.parse(String(args.parameters ?? '{}'));
        } catch {
          return {
            toolCallId: toolCall.id,
            result: 'Error: "parameters" must be a valid JSON string.',
            isError: true,
          };
        }

        const newTool: DynamicTool = {
          name: toolName,
          description,
          parameters: params,
          command: args.command ? String(args.command) : undefined,
          code: args.code ? String(args.code) : undefined,
          language: (args.language as DynamicTool['language']) ?? undefined,
          createdBy: agentId,
          createdAt: new Date(),
          persistent: String(args.persistent) === 'true',
        };

        if (!newTool.command && !newTool.code) {
          return {
            toolCallId: toolCall.id,
            result: 'Error: provide either "command" or "code" for the tool implementation.',
            isError: true,
          };
        }

        dynamicToolRegistry.register(newTool);

        if (newTool.persistent) {
          dynamicToolRegistry.save(cwd);
        }

        return {
          toolCallId: toolCall.id,
          result: `Dynamic tool "${toolName}" created successfully.${newTool.persistent ? ' (persistent)' : ''}`,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { toolCallId: toolCall.id, result: `Error: ${msg}`, isError: true };
      }
    }

    case 'list_dynamic_tools': {
      const tools = dynamicToolRegistry.getAll();
      if (tools.length === 0) {
        return { toolCallId: toolCall.id, result: 'No dynamic tools registered.' };
      }
      const lines = tools.map(
        (t) =>
          `- ${t.name}: ${t.description} (by ${t.createdBy}, ${t.persistent ? 'persistent' : 'session-only'})`
      );
      return { toolCallId: toolCall.id, result: lines.join('\n') };
    }

    case 'remove_tool': {
      const toolName = String(args.name ?? '');
      const removed = dynamicToolRegistry.unregister(toolName);
      if (removed) {
        dynamicToolRegistry.save(cwd);
        return { toolCallId: toolCall.id, result: `Dynamic tool "${toolName}" removed.` };
      }
      return {
        toolCallId: toolCall.id,
        result: `Dynamic tool "${toolName}" not found.`,
        isError: true,
      };
    }

    default:
      return {
        toolCallId: toolCall.id,
        result: `Unknown meta-tool: ${name}`,
        isError: true,
      };
  }
}
