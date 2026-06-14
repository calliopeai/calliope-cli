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
/** Repo root the lastCheckpointHash belongs to — revert must target this, not live cwd. */
let lastCheckpointRoot: string | null = null;
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
    // Capture the repo root once, at checkpoint time, and pin every git call for
    // this checkpoint to it. process.cwd() may change before the matching revert.
    const root = gitRepoRoot();
    if (!root) return null;

    // Check if there are any changes to commit
    const status = git(root, 'status', '--porcelain');
    if (!status.trim()) return null; // Nothing to checkpoint

    // Stage all tracked changes (don't add untracked files)
    git(root, 'add', '-u');

    // Check if there's anything staged
    const staged = git(root, 'diff', '--cached', '--stat');
    if (!staged.trim()) return null;

    // Create checkpoint commit
    const argSummary = tool === 'write_file'
      ? String(args.path || '')
      : tool === 'shell'
        ? String(args.command || '').substring(0, 50)
        : tool;

    const message = `[auto-checkpoint] before ${tool}: ${argSummary}`;
    git(root, 'commit', '-m', message, '--no-gpg-sign');

    // Get the commit hash
    const hash = git(root, 'rev-parse', '--short', 'HEAD').trim();
    lastCheckpointHash = hash;
    lastCheckpointRoot = root;
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
  if (!lastCheckpointHash || !lastCheckpointRoot) return false;

  // Reset only the repo the checkpoint was created in. If that root has since
  // moved or no longer resolves to the same repo, bail rather than risk a
  // destructive cross-repo `git reset --hard` against the live cwd.
  let currentRoot: string | null;
  try {
    currentRoot = gitRepoRoot(lastCheckpointRoot);
  } catch {
    return false;
  }
  if (currentRoot !== lastCheckpointRoot) return false;

  try {
    git(lastCheckpointRoot, 'reset', '--hard', lastCheckpointHash);
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

/**
 * Whether the given directory (default: live cwd) is inside a git work tree.
 * Not memoized: the answer depends on cwd, which changes over a session.
 */
function isGitRepo(cwd: string = process.cwd()): boolean {
  try {
    git(cwd, 'rev-parse', '--is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the absolute repo root for the given directory (default: live cwd).
 * Returns null if not inside a git work tree.
 */
function gitRepoRoot(cwd: string = process.cwd()): string | null {
  try {
    const root = git(cwd, 'rev-parse', '--show-toplevel').trim();
    return root || null;
  } catch {
    return null;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
