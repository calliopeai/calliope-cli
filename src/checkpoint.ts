/**
 * Calliope CLI - Checkpoint / Restore (git-based, #181)
 *
 * A single, git-backed checkpoint mechanism. Before a destructive tool call the
 * agent creates a checkpoint commit of the working tree (createCheckpoint) and
 * records a lightweight ref under refs/calliope/checkpoints/ so the checkpoint
 * can later be listed, restored from, or cleared — all without rewriting
 * history:
 *  - listCheckpoints()        enumerates the checkpoint refs (newest first)
 *  - restoreFromCheckpoint()  restores a single file's content from a checkpoint
 *                             commit via `git show <ref>:<path>`
 *  - clearCheckpoints()       deletes the checkpoint refs (the commits remain
 *                             reachable from branch history; only the pointers
 *                             are dropped, so history is never rewritten)
 *  - revertToLastCheckpoint() hard-resets the repo to the last checkpoint commit
 *
 * Inspired by autoresearch's git-as-ledger pattern where every experiment is a
 * commit, making the full history auditable.
 *
 * Outside a git work tree every operation is a clean no-op: shouldCheckpoint
 * returns false, createCheckpoint returns null, listCheckpoints returns [],
 * restoreFromCheckpoint returns undefined, and clearCheckpoints returns 0.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Configuration
// ============================================================================

/** Namespace for the lightweight refs that mark each checkpoint commit. */
const CHECKPOINT_REF_PREFIX = 'refs/calliope/checkpoints';

/** Shell commands that are destructive (write, delete, move). */
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
// Types
// ============================================================================

export interface CheckpointSummary {
  /** Full ref name under refs/calliope/checkpoints/. */
  ref: string;
  /** Short commit hash of the checkpoint. */
  hash: string;
  /** Commit subject (e.g. "[checkpoint] before write_file: src/main.ts"). */
  subject: string;
  /** ISO-8601 commit timestamp. */
  timestamp: string;
}

// ============================================================================
// State
// ============================================================================

let enabled = true;
let lastCheckpointHash: string | null = null;
/** Repo root the lastCheckpointHash belongs to — revert must target this, not live cwd. */
let lastCheckpointRoot: string | null = null;
let checkpointCount = 0;

// ============================================================================
// Public API — automatic checkpointing (agent loop)
// ============================================================================

/**
 * Check if a tool call should trigger a checkpoint.
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
 * Create a checkpoint commit with the current staged + unstaged changes and
 * record a ref pointing at it. Returns the commit hash if successful, null if
 * nothing to commit.
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

    const message = `[checkpoint] before ${tool}: ${argSummary}`;
    git(root, 'commit', '-m', message, '--no-gpg-sign');

    // Get the commit hash
    const hash = git(root, 'rev-parse', '--short', 'HEAD').trim();
    lastCheckpointHash = hash;
    lastCheckpointRoot = root;
    checkpointCount++;

    // Record a lightweight ref so this checkpoint can be listed, restored, and
    // cleared without rewriting history. Best-effort: a ref failure must not
    // invalidate the (already committed) checkpoint.
    try {
      const refId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(checkpointCount).padStart(4, '0')}`;
      git(root, 'update-ref', `${CHECKPOINT_REF_PREFIX}/${refId}`, hash);
    } catch {
      // Ref tracking is best-effort; the checkpoint commit already exists.
    }

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
 * Enable or disable automatic checkpointing.
 */
export function setEnabled(value: boolean): void {
  enabled = value;
}

// ============================================================================
// Public API — list / restore / clear (user commands)
// ============================================================================

/**
 * List available checkpoints, newest-first. When filePath is provided, only
 * checkpoints whose commit tree contains that file are returned. Outside a git
 * work tree this returns an empty list.
 */
export function listCheckpoints(filePath?: string): CheckpointSummary[] {
  const root = gitRepoRoot();
  if (!root) return [];

  let out: string;
  try {
    out = git(
      root,
      'for-each-ref',
      '--sort=-refname',
      '--format=%(objectname:short)%09%(refname)%09%(committerdate:iso-strict)%09%(subject)',
      CHECKPOINT_REF_PREFIX,
    );
  } catch {
    return [];
  }

  const rel = filePath !== undefined ? path.relative(root, path.resolve(filePath)) : undefined;
  const summaries: CheckpointSummary[] = [];

  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const hash = parts[0];
    const ref = parts[1];
    const timestamp = parts[2];
    const subject = parts.slice(3).join('\t');
    if (!hash || !ref) continue;

    // When filtering by file, keep only checkpoints whose tree contains it.
    if (rel !== undefined) {
      try {
        git(root, 'cat-file', '-e', `${hash}:${rel}`);
      } catch {
        continue;
      }
    }

    summaries.push({ ref, hash, subject, timestamp: timestamp ?? '' });
  }

  return summaries;
}

/**
 * Restore a single file's content from a checkpoint. Index 0 = most recent
 * checkpoint containing the file, 1 = next, etc. The file's content is read
 * from the checkpoint commit (`git show <hash>:<path>`) and written back to
 * disk. Returns the restored content, or undefined if no matching checkpoint
 * exists (including outside a git work tree).
 */
export function restoreFromCheckpoint(filePath: string, index: number = 0): string | undefined {
  const root = gitRepoRoot();
  if (!root) return undefined;

  const checkpoints = listCheckpoints(filePath);
  if (index < 0 || index >= checkpoints.length) return undefined;

  const cp = checkpoints[index]!;
  const absPath = path.resolve(filePath);
  const rel = path.relative(root, absPath);

  let content: string;
  try {
    content = git(root, 'show', `${cp.hash}:${rel}`);
  } catch {
    return undefined;
  }

  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(absPath, content);

  return content;
}

/**
 * Delete checkpoint refs. When olderThanDays is provided, only refs whose
 * checkpoint commit is older than that many days are dropped; otherwise all
 * checkpoint refs are dropped. The underlying commits remain reachable from
 * branch history — only the checkpoint pointers are removed, so git history is
 * never rewritten. Returns the number of refs removed (0 outside a git repo).
 */
export function clearCheckpoints(olderThanDays?: number): number {
  const root = gitRepoRoot();
  if (!root) return 0;

  let out: string;
  try {
    out = git(root, 'for-each-ref', '--format=%(refname)%09%(committerdate:unix)', CHECKPOINT_REF_PREFIX);
  } catch {
    return 0;
  }

  const cutoff = olderThanDays !== undefined
    ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000
    : null;
  let removed = 0;

  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, unix] = line.split('\t');
    if (!ref) continue;

    if (cutoff !== null) {
      const ts = parseInt(unix ?? '', 10) * 1000;
      if (Number.isFinite(ts) && ts >= cutoff) continue; // keep recent
    }

    try {
      git(root, 'update-ref', '-d', ref);
      removed++;
    } catch {
      // Skip refs we can't delete.
    }
  }

  return removed;
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
