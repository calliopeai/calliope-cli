/**
 * UI Module - Command Completions & Smart Suggestions
 *
 * Slash command list, path completion, and context-aware command suggestions.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Mode } from '../types.js';

// ============================================================================
// Slash Commands (for tab completion)
// ============================================================================

export const SLASH_COMMANDS = [
  '/help', '/h',
  '/mode', '/m',
  '/provider', '/p',
  '/model',
  '/models',
  '/route',
  '/persona',
  '/todo',
  '/plans',
  '/session',
  '/sessions',
  '/history',
  '/context',
  '/summarize',
  '/clear', '/c',
  '/copy',
  '/export',
  '/edit',
  '/undo',
  '/redo',
  '/confirm',
  '/profile',
  '/mcp',
  '/skills',
  '/memory',
  '/project',
  '/find',
  '/branch',
  '/theme',
  '/hooks',
  '/search',
  '/status', '/s',
  '/config',
  '/set',
  '/layout',
  '/density',
  '/collapse',
  '/scope',
  '/add-dir',
  '/remove-dir',
  '/agents',
  '/upgrade',
  '/loop',
  '/cancel-loop',
  '/exit',
  '/keys',
  '/?',
  '/queue',
  '/flush',
  '/debug',
  '/unstick',
  '/work',
  '/plan',
  '/resume',
  '/skin',
  '/palette',
  '/companion',
  '/hud',
  '/pack',
  '/intensity',
  '/emoji',
  '/breaker', '/cb',
  '/smart',
  '/swarm',
  '/council',
  '/trust',
  '/untrust',
  '/checkpoint', '/cp',
  '/restore',
];

// Commands that take a path argument (for file tab completion)
export const PATH_COMMANDS = ['/add-dir', '/remove-dir', '/export', '/find', '/restore'];

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
  const { input, hasGitRepo, contextPercentage, currentMode, recentCommands } = ctx;

  if (!input.startsWith('/')) return [];

  const suggestions: string[] = [];
  const inputLower = input.toLowerCase();

  // All available commands for matching
  const allCommands = [
    '/help', '/clear', '/exit', '/quit',
    '/mode', '/work', '/plan',
    '/provider', '/model', '/models', '/config',
    '/scope', '/add-dir', '/remove-dir', '/find',
    '/summarize', '/context', '/cost', '/session',
    '/debug', '/keys', '/unstick', '/flush',
    '/branch', '/branches', '/switch',
    '/save', '/load', '/sessions',
    '/git', '/run', '/set', '/confirm',
  ];

  // Context-aware prioritization
  const prioritized: string[] = [];

  // High context? Suggest compaction commands first
  if (contextPercentage > 70) {
    prioritized.push('/summarize compact', '/clear', '/branch new');
  }

  // Mode-specific suggestions
  if (currentMode === 'plan') {
    prioritized.push('/mode hybrid', '/work');
  } else if (currentMode === 'work') {
    prioritized.push('/mode hybrid', '/plan');
  }

  // Git repo? Suggest git commands
  if (hasGitRepo) {
    prioritized.push('/git status', '/git diff', '/git add', '/git commit');
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
