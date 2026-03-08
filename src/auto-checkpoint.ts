/**
 * Auto-Checkpoint
 *
 * Automatically creates git commits before destructive tool calls
 * so the agent's changes can be easily reverted.
 *
 * Inspired by autoresearch's git-as-ledger pattern where every
 * experiment is a commit, making the full history auditable.
 */

import { execFileSync } from 'child_process';

// ============================================================================
// Configuration
// ============================================================================

/** Tools that modify files and should trigger a checkpoint */
const DESTRUCTIVE_TOOLS = new Set([
  'write_file',
  'shell',      // only for certain commands
]);

/** Shell commands that are destructive (write, delete, move) */
const DESTRUCTIVE_SHELL_PATTERNS = [
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b.*\s-[^-]*f/,  // cp -f (force overwrite)
  /\bgit\s+(reset|checkout\s+--)\b/,
  /\bgit\s+clean\b/,
  /\bsed\s+-i\b/,
  />\s*\S/,              // output redirection
  /\bdd\b/,
  /\btruncate\b/,
];

// ============================================================================
// State
// ============================================================================

let enabled = true;
let lastCheckpointHash: string | null = null;
let checkpointCount = 0;

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a tool call should trigger an auto-checkpoint.
 */
export function shouldCheckpoint(tool: string, args: Record<string, unknown>): boolean {
  if (!enabled) return false;
  if (!isGitRepo()) return false;

  if (tool === 'write_file') return true;

  if (tool === 'shell') {
    const command = String(args.command || '');
    return DESTRUCTIVE_SHELL_PATTERNS.some(p => p.test(command));
  }

  return false;
}

/**
 * Create an auto-checkpoint commit with current staged + unstaged changes.
 * Returns the commit hash if successful, null if nothing to commit.
 */
export function createCheckpoint(tool: string, args: Record<string, unknown>): string | null {
  if (!isGitRepo()) return null;

  try {
    // Check if there are any changes to commit
    const status = git('status', '--porcelain');
    if (!status.trim()) return null; // Nothing to checkpoint

    // Stage all tracked changes (don't add untracked files)
    git('add', '-u');

    // Check if there's anything staged
    const staged = git('diff', '--cached', '--stat');
    if (!staged.trim()) return null;

    // Create checkpoint commit
    const argSummary = tool === 'write_file'
      ? String(args.path || '')
      : tool === 'shell'
        ? String(args.command || '').substring(0, 50)
        : tool;

    const message = `[auto-checkpoint] before ${tool}: ${argSummary}`;
    git('commit', '-m', message, '--no-gpg-sign');

    // Get the commit hash
    const hash = git('rev-parse', '--short', 'HEAD').trim();
    lastCheckpointHash = hash;
    checkpointCount++;
    return hash;
  } catch {
    // Checkpoint failed silently — don't block the agent
    return null;
  }
}

/**
 * Revert to the last checkpoint.
 */
export function revertToLastCheckpoint(): boolean {
  if (!lastCheckpointHash || !isGitRepo()) return false;

  try {
    git('reset', '--hard', lastCheckpointHash);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get checkpoint stats.
 */
export function getCheckpointStats(): { enabled: boolean; count: number; lastHash: string | null } {
  return { enabled, count: checkpointCount, lastHash: lastCheckpointHash };
}

/**
 * Enable or disable auto-checkpointing.
 */
export function setEnabled(value: boolean): void {
  enabled = value;
}

// ============================================================================
// Helpers
// ============================================================================

let _isGitRepo: boolean | null = null;

function isGitRepo(): boolean {
  if (_isGitRepo !== null) return _isGitRepo;
  try {
    git('rev-parse', '--is-inside-work-tree');
    _isGitRepo = true;
  } catch {
    _isGitRepo = false;
  }
  return _isGitRepo;
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
