/**
 * UI Module - Command Completions & Smart Suggestions
 *
 * Slash command list, path completion, and context-aware command suggestions.
 */

import config from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import type { Mode } from '../types.js';

// ============================================================================
// Slash Commands (for tab completion)
// ============================================================================

const BASE_SLASH_COMMANDS = [
  '/help',
  '/status',
  '/clear',
  '/exit',
  '/model', '/model list',
  '/provider',
  '/mode', '/mode plan', '/mode work',
  '/undo',
  '/export',
  '/resume',
  '/compact',
  '/scope', '/scope add', '/scope remove',
  '/memory',
  '/mcp',
  '/skills',
  '/config', '/config set',
  '/setup',
  '/trust', '/trust remove',
  '/cost',
  '/loop', '/loop stop',
  '/restore',
  '/debug',
];

/** Slash commands offered in completions. /fleet appears only when fleet mode is enabled. */
export const SLASH_COMMANDS: string[] = config.get('fleet')?.enabled === true
  ? [...BASE_SLASH_COMMANDS, '/fleet']
  : BASE_SLASH_COMMANDS;

// Commands that take a path argument (for file tab completion)
export const PATH_COMMANDS = ['/export', '/restore'];

// ============================================================================
// Path Completion
// ============================================================================

/**
 * Get file/directory completions for a partial path
 */
export function getPathCompletions(partial: string, cwd: string): string[] {
  try {
    // Handle empty or relative paths
    let searchDir: string;
    let prefix: string;

    if (!partial || partial === '') {
      searchDir = cwd;
      prefix = '';
    } else if (partial.startsWith('/')) {
      // Absolute path
      const lastSlash = partial.lastIndexOf('/');
      searchDir = partial.substring(0, lastSlash) || '/';
      prefix = partial.substring(lastSlash + 1);
    } else if (partial.startsWith('~')) {
      // Home directory
      const home = process.env.HOME || '/tmp';
      const expanded = partial.replace('~', home);
      const lastSlash = expanded.lastIndexOf('/');
      searchDir = expanded.substring(0, lastSlash) || home;
      prefix = expanded.substring(lastSlash + 1);
    } else {
      // Relative path
      const lastSlash = partial.lastIndexOf('/');
      if (lastSlash === -1) {
        searchDir = cwd;
        prefix = partial;
      } else {
        searchDir = path.join(cwd, partial.substring(0, lastSlash));
        prefix = partial.substring(lastSlash + 1);
      }
    }

    if (!fs.existsSync(searchDir)) return [];

    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    const matches: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue; // Skip hidden unless typing hidden
      if (prefix && !entry.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;

      const fullPath = path.join(searchDir, entry.name);
      const displayPath = partial.startsWith('/')
        ? fullPath
        : partial.startsWith('~')
          ? fullPath.replace(process.env.HOME || '', '~')
          : path.relative(cwd, fullPath) || entry.name;

      matches.push(entry.isDirectory() ? displayPath + '/' : displayPath);
    }

    return matches.sort().slice(0, 10); // Limit to 10 suggestions
  } catch {
    return [];
  }
}

// ============================================================================
// Smart Command Suggestions
// ============================================================================

export interface CommandSuggestionContext {
  input: string;
  hasGitRepo: boolean;
  contextPercentage: number;
  currentMode: Mode;
  recentCommands: string[];
  isProcessing: boolean;
}

export function getSmartCommandSuggestions(ctx: CommandSuggestionContext): string[] {
  const { input, contextPercentage, currentMode, recentCommands } = ctx;

  if (!input.startsWith('/')) return [];

  const suggestions: string[] = [];
  const inputLower = input.toLowerCase();

  // All available commands for matching (survivors only)
  const allCommands = [
    '/help', '/status', '/clear', '/exit',
    '/model', '/provider', '/mode',
    '/undo', '/export', '/resume', '/compact',
    '/scope', '/memory', '/trust', '/restore',
    '/mcp', '/skills',
    '/config', '/setup', '/cost', '/loop', '/debug',
  ];

  // Context-aware prioritization
  const prioritized: string[] = [];

  // High context? Suggest compaction commands first
  if (contextPercentage > 70) {
    prioritized.push('/compact', '/clear');
  }

  // Mode-specific suggestions
  if (currentMode === 'plan') {
    prioritized.push('/mode hybrid', '/mode work');
  } else if (currentMode === 'work') {
    prioritized.push('/mode hybrid', '/mode plan');
  }

  // Add recent commands (deduplicated)
  for (const cmd of recentCommands.slice(-5)) {
    if (cmd.startsWith('/') && !prioritized.includes(cmd)) {
      prioritized.push(cmd);
    }
  }

  // Filter by what user is typing
  const matchingPrioritized = prioritized.filter(cmd =>
    cmd.toLowerCase().startsWith(inputLower)
  );
  const matchingAll = allCommands.filter(cmd =>
    cmd.toLowerCase().startsWith(inputLower) && !matchingPrioritized.includes(cmd)
  );

  suggestions.push(...matchingPrioritized, ...matchingAll);

  return suggestions.slice(0, 6);
}
