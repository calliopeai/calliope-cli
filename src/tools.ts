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
import { getAgtermTools, isAgtermTool, executeAgtermTool } from './agterm/index.js';
import { validatePath as scopeValidatePath, isInScope, getScopeSummary } from './scope.js';
import { getPluginTools, isPluginTool, executePluginTool } from './plugins.js';
import config from './config.js';

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
 * Includes agterm tools when agtermEnabled is true
 */
export function getTools(agtermEnabled: boolean = false): Tool[] {
  const pluginTools = getPluginTools();
  if (agtermEnabled) {
    return [...TOOLS, ...getAgtermTools(), ...pluginTools];
  }
  return [...TOOLS, ...pluginTools];
}

/**
 * Validate path is within allowed directory (prevent path traversal)
 */
function validatePath(filePath: string, cwd: string): string {
  // Primary validation via scope manager
  const validated = scopeValidatePath(filePath, cwd);

  // Secondary validation: ensure path doesn't escape allowed directories
  const resolved = path.resolve(cwd, validated);
  const normalizedCwd = path.resolve(cwd);

  // Check for path traversal attempts
  if (validated.includes('..')) {
    // Ensure the resolved path is still within cwd or an allowed scope
    if (!resolved.startsWith(normalizedCwd) && !resolved.startsWith('/tmp')) {
      throw new Error(`Path traversal detected: ${filePath} resolves outside allowed scope`);
    }
  }

  // Check for null bytes (path injection attack)
  if (validated.includes('\0')) {
    throw new Error(`Invalid path: contains null bytes`);
  }

  return validated;
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

  // Handle agterm tools
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
        result = await executeShell(args.command, cwd, timeout);
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

      case 'mermaid': {
        const diagramType = typeof args.type === 'string' ? args.type : 'flowchart';
        if (typeof args.content !== 'string') {
          return { toolCallId: id, result: 'Error: content must be a string', isError: true };
        }
        const title = typeof args.title === 'string' ? args.title : undefined;
        result = generateMermaidDiagram(diagramType, args.content, title);
        break;
      }

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

  fs.writeFileSync(absPath, content);

  // Generate diff output
  if (isNewFile) {
    const allLines = content.split('\n');
    const lines = allLines.slice(0, 10);
    const lineNumWidth = Math.max(4, allLines.length.toString().length);
    const padNum = (n: number) => String(n).padStart(lineNumWidth, ' ');
    const preview = lines.map((l, i) => `${padNum(i + 1)} +  ${l}`).join('\n');
    const more = allLines.length > 10 ? '\n  ... (new file truncated)' : '';
    return `DIFF:NEW_FILE:${absPath}\n⎿  Added ${allLines.length} lines\n${preview}${more}`;
  } else {
    const diff = generateDiff(oldContent, content);
    if (diff.trim()) {
      return `DIFF:${absPath}\n${diff}`;
    } else {
      return `File unchanged: ${absPath}`;
    }
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
 * Execute code in a sandboxed environment
 */
async function executeCode(
  language: 'python' | 'node' | 'bash',
  code: string,
  cwd: string,
  timeout: number
): Promise<string> {
  // Map language names to sandbox language types
  const sandboxLang = language === 'node' ? 'node' : language;

  // Try sandboxed execution first (using Docker if available)
  const result = await sandbox.execute(sandboxLang as sandbox.Language, code, {
    timeout,
    mountWorkdir: true,
    readOnly: false,
  });

  const sandboxIndicator = result.sandboxed ? '🔒 [sandboxed]' : '⚠️ [unsandboxed]';
  const statusIndicator = result.success ? '✓' : '✗';

  let output = `${sandboxIndicator} ${statusIndicator} [${language}]\n`;

  if (result.stdout) {
    output += `Output:\n${result.stdout}\n`;
  }

  if (result.stderr) {
    output += `Errors:\n${result.stderr}\n`;
  }

  if (!result.success && !result.stdout && !result.stderr) {
    output += `Exit code: ${result.exitCode}\n`;
  }

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

  // Sanitize args to prevent command injection
  const safeArgs = args.replace(/[;&|`$]/g, '');

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
