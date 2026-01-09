/**
 * Calliope CLI - Tools
 *
 * Tool definitions and execution for the agent.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolCall, ToolResult } from './types.js';

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
];

/**
 * Validate path is within allowed directory (prevent path traversal)
 */
function validatePath(filePath: string, cwd: string): string {
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const normalizedPath = path.resolve(absPath);
  const normalizedCwd = path.resolve(cwd);

  // Allow access to cwd and subdirectories, or absolute paths within home
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const normalizedHome = path.resolve(homeDir);

  if (!normalizedPath.startsWith(normalizedCwd) && !normalizedPath.startsWith(normalizedHome)) {
    throw new Error(`Access denied: ${filePath} is outside allowed directories`);
  }

  return normalizedPath;
}

/**
 * Execute a tool call
 */
export async function executeTool(
  toolCall: ToolCall,
  cwd: string,
  timeout = 60000
): Promise<ToolResult> {
  const { id, name, arguments: args } = toolCall;

  try {
    let result: string;

    switch (name) {
      case 'shell':
        result = await executeShell(args.command as string, cwd, timeout);
        break;

      case 'read_file':
        result = await readFile(args.path as string, cwd);
        break;

      case 'write_file':
        result = await writeFile(args.path as string, args.content as string, cwd);
        break;

      case 'list_files':
        result = await listFiles(args.path as string | undefined, args.recursive as boolean | undefined, cwd);
        break;

      case 'think':
        // Think tool just returns acknowledgment
        result = 'Thought recorded.';
        break;

      default:
        return { toolCallId: id, result: `Unknown tool: ${name}`, isError: true };
    }

    return { toolCallId: id, result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { toolCallId: id, result: `Error: ${msg}`, isError: true };
  }
}

/**
 * Execute a shell command
 */
async function executeShell(command: string, cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Command timed out'));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const output = stdout + (stderr ? `\nstderr: ${stderr}` : '');

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

  return fs.readFileSync(absPath, 'utf-8');
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

  fs.writeFileSync(absPath, content);
  return `File written: ${absPath} (${content.length} bytes)`;
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
