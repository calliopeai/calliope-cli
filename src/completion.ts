/**
 * Calliope CLI - Tab Completion
 *
 * Provides completions for commands, file paths, and tool arguments.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface Completion {
  value: string;
  display: string;
  description?: string;
  type: 'command' | 'file' | 'directory' | 'option' | 'argument';
}

export interface CompletionContext {
  input: string;
  cursorPosition: number;
  currentWord: string;
  previousWord: string;
  isCommand: boolean;
}

// ============================================================================
// Commands
// ============================================================================

const COMMANDS: Array<{ name: string; description: string; subcommands?: string[] }> = [
  { name: '/help', description: 'Show help' },
  { name: '/clear', description: 'Clear screen' },
  { name: '/copy', description: 'Copy last response' },
  { name: '/export', description: 'Export conversation', subcommands: ['markdown', 'json'] },
  { name: '/edit', description: 'Edit last message' },
  { name: '/undo', description: 'Undo last exchange' },
  { name: '/confirm', description: 'Toggle confirmation', subcommands: ['on', 'off'] },
  { name: '/profile', description: 'Manage profiles', subcommands: ['list', 'save', 'delete'] },
  { name: '/mcp', description: 'MCP servers', subcommands: ['list', 'add', 'remove', 'refresh', 'tools'] },
  { name: '/skills', description: 'Agent skills', subcommands: ['list', 'add', 'remove', 'info'] },
  { name: '/memory', description: 'Project memory', subcommands: ['init', 'show', 'add', 'remove', 'global'] },
  { name: '/project', description: 'Project config', subcommands: ['init', 'show', 'run'] },
  { name: '/find', description: 'Fuzzy file search' },
  { name: '/branch', description: 'Conversation branches', subcommands: ['list', 'new', 'switch', 'delete'] },
  { name: '/theme', description: 'Color themes', subcommands: ['list', 'default', 'light', 'monokai', 'nord', 'minimal'] },
  { name: '/hooks', description: 'Tool hooks', subcommands: ['list', 'add', 'init'] },
  { name: '/search', description: 'Search conversation' },
  { name: '/status', description: 'Show status' },
  { name: '/config', description: 'Show config' },
  { name: '/upgrade', description: 'Check for updates' },
  { name: '/session', description: 'Session management', subcommands: ['list', 'new'] },
  { name: '/mode', description: 'Change mode', subcommands: ['plan', 'hybrid', 'work'] },
  { name: '/exit', description: 'Exit' },
];

// ============================================================================
// Context Parsing
// ============================================================================

/**
 * Parse input to get completion context
 */
export function parseContext(input: string, cursorPosition: number): CompletionContext {
  const beforeCursor = input.slice(0, cursorPosition);
  const words = beforeCursor.split(/\s+/);
  const currentWord = words[words.length - 1] || '';
  const previousWord = words.length > 1 ? words[words.length - 2] : '';
  const isCommand = beforeCursor.trimStart().startsWith('/');

  return {
    input,
    cursorPosition,
    currentWord,
    previousWord,
    isCommand,
  };
}

// ============================================================================
// Completion Providers
// ============================================================================

/**
 * Get command completions
 */
export function getCommandCompletions(prefix: string): Completion[] {
  const lower = prefix.toLowerCase();
  return COMMANDS
    .filter(cmd => cmd.name.toLowerCase().startsWith(lower))
    .map(cmd => ({
      value: cmd.name,
      display: cmd.name,
      description: cmd.description,
      type: 'command' as const,
    }));
}

/**
 * Get subcommand completions
 */
export function getSubcommandCompletions(command: string, prefix: string): Completion[] {
  const cmd = COMMANDS.find(c => c.name === command);
  if (!cmd?.subcommands) return [];

  const lower = prefix.toLowerCase();
  return cmd.subcommands
    .filter(sub => sub.toLowerCase().startsWith(lower))
    .map(sub => ({
      value: sub,
      display: sub,
      type: 'option' as const,
    }));
}

/**
 * Get file path completions
 */
export function getFileCompletions(partialPath: string, cwd: string = process.cwd()): Completion[] {
  const completions: Completion[] = [];

  try {
    // Determine the directory to search and the prefix to match
    let searchDir: string;
    let prefix: string;

    if (partialPath.includes('/')) {
      const lastSlash = partialPath.lastIndexOf('/');
      const dirPart = partialPath.slice(0, lastSlash) || '/';
      prefix = partialPath.slice(lastSlash + 1);

      if (path.isAbsolute(dirPart)) {
        searchDir = dirPart;
      } else {
        searchDir = path.join(cwd, dirPart);
      }
    } else {
      searchDir = cwd;
      prefix = partialPath;
    }

    if (!fs.existsSync(searchDir)) return [];

    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    const lower = prefix.toLowerCase();

    for (const entry of entries) {
      // Skip hidden files unless prefix starts with .
      if (entry.name.startsWith('.') && !prefix.startsWith('.')) {
        continue;
      }

      if (entry.name.toLowerCase().startsWith(lower)) {
        const isDir = entry.isDirectory();
        const relativePath = partialPath.includes('/')
          ? partialPath.slice(0, partialPath.lastIndexOf('/') + 1) + entry.name
          : entry.name;

        completions.push({
          value: isDir ? relativePath + '/' : relativePath,
          display: entry.name + (isDir ? '/' : ''),
          type: isDir ? 'directory' : 'file',
        });
      }
    }
  } catch {
    // Ignore errors
  }

  return completions.slice(0, 50);  // Limit results
}

// ============================================================================
// Main Completion Function
// ============================================================================

/**
 * Get completions for current input
 */
export function getCompletions(input: string, cursorPosition: number, cwd?: string): Completion[] {
  const ctx = parseContext(input, cursorPosition);

  // Command completion
  if (ctx.currentWord.startsWith('/')) {
    return getCommandCompletions(ctx.currentWord);
  }

  // Subcommand completion
  if (ctx.previousWord.startsWith('/')) {
    const subcompletions = getSubcommandCompletions(ctx.previousWord, ctx.currentWord);
    if (subcompletions.length > 0) {
      return subcompletions;
    }
  }

  // File path completion (for @ references or paths)
  if (ctx.currentWord.startsWith('@') ||
      ctx.currentWord.startsWith('./') ||
      ctx.currentWord.startsWith('/') ||
      ctx.currentWord.startsWith('../')) {
    const pathPart = ctx.currentWord.startsWith('@')
      ? ctx.currentWord.slice(1)
      : ctx.currentWord;
    return getFileCompletions(pathPart, cwd).map(c => ({
      ...c,
      value: ctx.currentWord.startsWith('@') ? '@' + c.value : c.value,
      display: ctx.currentWord.startsWith('@') ? '@' + c.display : c.display,
    }));
  }

  return [];
}

/**
 * Apply completion to input
 */
export function applyCompletion(
  input: string,
  cursorPosition: number,
  completion: Completion
): { newInput: string; newCursorPosition: number } {
  const ctx = parseContext(input, cursorPosition);

  // Find where the current word starts
  const wordStart = cursorPosition - ctx.currentWord.length;

  // Build new input
  const before = input.slice(0, wordStart);
  const after = input.slice(cursorPosition);
  const newInput = before + completion.value + after;
  const newCursorPosition = wordStart + completion.value.length;

  return { newInput, newCursorPosition };
}

// ============================================================================
// Completion State (for cycling through completions)
// ============================================================================

export interface CompletionState {
  completions: Completion[];
  selectedIndex: number;
  originalInput: string;
  originalCursor: number;
}

/**
 * Create new completion state
 */
export function createCompletionState(
  input: string,
  cursorPosition: number,
  cwd?: string
): CompletionState | null {
  const completions = getCompletions(input, cursorPosition, cwd);
  if (completions.length === 0) return null;

  return {
    completions,
    selectedIndex: 0,
    originalInput: input,
    originalCursor: cursorPosition,
  };
}

/**
 * Cycle to next completion
 */
export function nextCompletion(state: CompletionState): CompletionState {
  return {
    ...state,
    selectedIndex: (state.selectedIndex + 1) % state.completions.length,
  };
}

/**
 * Cycle to previous completion
 */
export function prevCompletion(state: CompletionState): CompletionState {
  return {
    ...state,
    selectedIndex: (state.selectedIndex - 1 + state.completions.length) % state.completions.length,
  };
}

/**
 * Get current completion
 */
export function getCurrentCompletion(state: CompletionState): Completion {
  return state.completions[state.selectedIndex];
}

/**
 * Apply current completion
 */
export function applyCurrentCompletion(state: CompletionState): {
  newInput: string;
  newCursorPosition: number;
} {
  const completion = getCurrentCompletion(state);
  return applyCompletion(state.originalInput, state.originalCursor, completion);
}
