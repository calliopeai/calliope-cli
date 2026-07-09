/**
 * Git Status Detection
 *
 * Provides cached git branch and status info for status bar display.
 * Results are cached for 5 seconds to avoid spamming git on every render.
 */

import { execSync } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface GitStatusInfo {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

// ============================================================================
// Cache
// ============================================================================

const CACHE_TTL_MS = 5000;

let cachedStatus: GitStatusInfo | null = null;
let cacheTimestamp = 0;
let cachedCwd: string | undefined;

function isCacheValid(cwd?: string): boolean {
  return (
    cachedStatus !== null &&
    cachedCwd === cwd &&
    Date.now() - cacheTimestamp < CACHE_TTL_MS
  );
}

function updateCache(status: GitStatusInfo, cwd?: string): void {
  cachedStatus = status;
  cachedCwd = cwd;
  cacheTimestamp = Date.now();
}

// ============================================================================
// Git Commands
// ============================================================================

/**
 * Get the current git branch name.
 * Returns null if not in a git repo or git is unavailable.
 */
export function getGitBranch(cwd?: string): string | null {
  return getGitStatus(cwd).branch;
}

/**
 * Get full git status: branch, dirty state, ahead/behind counts.
 * Results are cached for 5 seconds.
 */
export function getGitStatus(cwd?: string): GitStatusInfo {
  if (isCacheValid(cwd)) {
    return cachedStatus!;
  }

  const result: GitStatusInfo = {
    branch: null,
    dirty: false,
    ahead: 0,
    behind: 0,
  };

  try {
    const output = execSync('git status --porcelain --branch', {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines = output.trim().split('\n');

    // First line is branch info: ## branch...origin/branch [ahead N, behind N]
    if (lines.length > 0 && lines[0]!.startsWith('## ')) {
      const branchLine = lines[0]!.slice(3);

      // Parse branch name (before "..." or end of string)
      const dotIndex = branchLine.indexOf('...');
      const bracketIndex = branchLine.indexOf(' [');
      if (dotIndex !== -1) {
        result.branch = branchLine.slice(0, dotIndex);
      } else if (bracketIndex !== -1) {
        result.branch = branchLine.slice(0, bracketIndex);
      } else {
        result.branch = branchLine.trim();
      }

      // Handle detached HEAD
      if (result.branch.startsWith('HEAD (no branch)') || result.branch === 'No commits yet on') {
        result.branch = null;
      }

      // Parse ahead/behind
      const abMatch = branchLine.match(/\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/);
      if (abMatch) {
        result.ahead = abMatch[1] ? parseInt(abMatch[1], 10) : 0;
        result.behind = abMatch[2] ? parseInt(abMatch[2], 10) : 0;
      }
    }

    // Any non-header lines mean dirty working tree
    result.dirty = lines.length > 1 && lines.slice(1).some(l => l.trim().length > 0);
  } catch {
    // Not in a git repo, git not installed, or timeout — return defaults
  }

  updateCache(result, cwd);
  return result;
}
