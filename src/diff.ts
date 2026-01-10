/**
 * Calliope CLI - Diff Preview System
 *
 * Shows diffs before applying file changes, with approve/reject workflow.
 */

import * as fs from 'fs';

// ============================================================================
// Types
// ============================================================================

export interface DiffLine {
  type: 'context' | 'add' | 'remove' | 'header';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface FileDiff {
  path: string;
  oldContent: string;
  newContent: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

export interface PendingChange {
  id: string;
  type: 'write' | 'edit' | 'delete';
  path: string;
  oldContent: string;
  newContent: string;
  diff: FileDiff;
  approved: boolean | null;  // null = pending, true = approved, false = rejected
}

// ============================================================================
// Diff Generation
// ============================================================================

/**
 * Simple line-by-line diff algorithm
 */
export function generateDiff(oldContent: string, newContent: string, path: string): FileDiff {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diffLines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  // Add header
  diffLines.push({ type: 'header', content: `--- a/${path}` });
  diffLines.push({ type: 'header', content: `+++ b/${path}` });

  // Simple LCS-based diff
  const lcs = longestCommonSubsequence(oldLines, newLines);
  let oldIdx = 0;
  let newIdx = 0;
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const [oldLcsIdx, newLcsIdx] of lcs) {
    // Add deletions (lines in old but not in LCS)
    while (oldIdx < oldLcsIdx) {
      diffLines.push({
        type: 'remove',
        content: oldLines[oldIdx],
        oldLineNum: oldLineNum++,
      });
      deletions++;
      oldIdx++;
    }

    // Add additions (lines in new but not in LCS)
    while (newIdx < newLcsIdx) {
      diffLines.push({
        type: 'add',
        content: newLines[newIdx],
        newLineNum: newLineNum++,
      });
      additions++;
      newIdx++;
    }

    // Add context (matching line)
    diffLines.push({
      type: 'context',
      content: oldLines[oldIdx],
      oldLineNum: oldLineNum++,
      newLineNum: newLineNum++,
    });
    oldIdx++;
    newIdx++;
  }

  // Remaining deletions
  while (oldIdx < oldLines.length) {
    diffLines.push({
      type: 'remove',
      content: oldLines[oldIdx],
      oldLineNum: oldLineNum++,
    });
    deletions++;
    oldIdx++;
  }

  // Remaining additions
  while (newIdx < newLines.length) {
    diffLines.push({
      type: 'add',
      content: newLines[newIdx],
      newLineNum: newLineNum++,
    });
    additions++;
    newIdx++;
  }

  return {
    path,
    oldContent,
    newContent,
    lines: diffLines,
    additions,
    deletions,
  };
}

/**
 * LCS algorithm for diff
 */
function longestCommonSubsequence(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS indices
  const result: Array<[number, number]> = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

// ============================================================================
// Diff Formatting
// ============================================================================

// ANSI colors
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

/**
 * Format diff for terminal display
 */
export function formatDiff(diff: FileDiff, contextLines = 3): string {
  const lines: string[] = [];

  // Header
  lines.push(`${COLORS.cyan}${diff.lines[0].content}${COLORS.reset}`);
  lines.push(`${COLORS.cyan}${diff.lines[1].content}${COLORS.reset}`);
  lines.push('');

  // Group consecutive changes with context
  const chunks = groupDiffChunks(diff.lines.slice(2), contextLines);

  for (const chunk of chunks) {
    // Chunk header
    const startOld = chunk.find(l => l.oldLineNum)?.oldLineNum || 1;
    const startNew = chunk.find(l => l.newLineNum)?.newLineNum || 1;
    lines.push(`${COLORS.cyan}@@ -${startOld} +${startNew} @@${COLORS.reset}`);

    for (const line of chunk) {
      switch (line.type) {
        case 'add':
          lines.push(`${COLORS.green}+${line.content}${COLORS.reset}`);
          break;
        case 'remove':
          lines.push(`${COLORS.red}-${line.content}${COLORS.reset}`);
          break;
        case 'context':
          lines.push(`${COLORS.dim} ${line.content}${COLORS.reset}`);
          break;
      }
    }
    lines.push('');
  }

  // Summary
  lines.push(`${COLORS.green}+${diff.additions}${COLORS.reset} ${COLORS.red}-${diff.deletions}${COLORS.reset}`);

  return lines.join('\n');
}

/**
 * Format diff as compact summary
 */
export function formatDiffSummary(diff: FileDiff): string {
  return `${diff.path}: ${COLORS.green}+${diff.additions}${COLORS.reset} ${COLORS.red}-${diff.deletions}${COLORS.reset}`;
}

/**
 * Group diff lines into chunks with context
 */
function groupDiffChunks(lines: DiffLine[], contextLines: number): DiffLine[][] {
  const chunks: DiffLine[][] = [];
  let currentChunk: DiffLine[] = [];
  let contextCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.type === 'context') {
      contextCount++;

      // Check if there are changes within contextLines ahead
      let hasChangesAhead = false;
      for (let j = i + 1; j < Math.min(i + contextLines + 1, lines.length); j++) {
        if (lines[j].type !== 'context') {
          hasChangesAhead = true;
          break;
        }
      }

      if (currentChunk.length > 0 || hasChangesAhead) {
        if (contextCount <= contextLines * 2) {
          currentChunk.push(line);
        } else if (hasChangesAhead) {
          // Start new chunk if changes ahead
          if (currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
          }
          currentChunk.push(line);
          contextCount = 1;
        }
      }
    } else {
      // Add or remove line
      currentChunk.push(line);
      contextCount = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// ============================================================================
// Pending Changes Management
// ============================================================================

let pendingChanges: PendingChange[] = [];

/**
 * Queue a file change for approval
 */
export function queueChange(
  type: PendingChange['type'],
  path: string,
  newContent: string
): PendingChange {
  const oldContent = fs.existsSync(path) ? fs.readFileSync(path, 'utf-8') : '';
  const diff = generateDiff(oldContent, newContent, path);

  const change: PendingChange = {
    id: `change_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    path,
    oldContent,
    newContent,
    diff,
    approved: null,
  };

  pendingChanges.push(change);
  return change;
}

/**
 * Get all pending changes
 */
export function getPendingChanges(): PendingChange[] {
  return pendingChanges.filter(c => c.approved === null);
}

/**
 * Approve a change and apply it
 */
export function approveChange(id: string): boolean {
  const change = pendingChanges.find(c => c.id === id);
  if (!change) return false;

  change.approved = true;

  // Apply the change
  if (change.type === 'delete') {
    if (fs.existsSync(change.path)) {
      fs.unlinkSync(change.path);
    }
  } else {
    fs.writeFileSync(change.path, change.newContent);
  }

  return true;
}

/**
 * Reject a change
 */
export function rejectChange(id: string): boolean {
  const change = pendingChanges.find(c => c.id === id);
  if (!change) return false;

  change.approved = false;
  return true;
}

/**
 * Approve all pending changes
 */
export function approveAllChanges(): number {
  let count = 0;
  for (const change of pendingChanges) {
    if (change.approved === null) {
      approveChange(change.id);
      count++;
    }
  }
  return count;
}

/**
 * Reject all pending changes
 */
export function rejectAllChanges(): number {
  let count = 0;
  for (const change of pendingChanges) {
    if (change.approved === null) {
      rejectChange(change.id);
      count++;
    }
  }
  return count;
}

/**
 * Clear change history
 */
export function clearChanges(): void {
  pendingChanges = [];
}

/**
 * Get change by ID
 */
export function getChange(id: string): PendingChange | undefined {
  return pendingChanges.find(c => c.id === id);
}
