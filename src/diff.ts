/**
 * Calliope CLI - Diff Preview System
 *
 * Shows diffs before applying file changes, with approve/reject workflow.
 * Supports inline, unified, and side-by-side diff display styles.
 * Colors come from the active palette. Diff config comes from the active skin.
 */

import * as fs from 'fs';
import { colors as COLORS } from './styles.js';
import { getCurrentSkin, getCurrentPalette } from './hud/api.js';
import type { Skin } from './hud/types.js';

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

// Max file size for LCS diff (100KB) — larger files use simple line diff to avoid OOM
const MAX_LCS_SIZE = 100_000;

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

  // For large files, fall back to simple line-by-line comparison to avoid O(n*m) OOM
  if (oldContent.length > MAX_LCS_SIZE || newContent.length > MAX_LCS_SIZE) {
    return generateSimpleDiff(oldLines, newLines, path, diffLines);
  }

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
        content: oldLines[oldIdx]!,
        oldLineNum: oldLineNum++,
      });
      deletions++;
      oldIdx++;
    }

    // Add additions (lines in new but not in LCS)
    while (newIdx < newLcsIdx) {
      diffLines.push({
        type: 'add',
        content: newLines[newIdx]!,
        newLineNum: newLineNum++,
      });
      additions++;
      newIdx++;
    }

    // Add context (matching line)
    diffLines.push({
      type: 'context',
      content: oldLines[oldIdx]!,
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
      content: oldLines[oldIdx]!,
      oldLineNum: oldLineNum++,
    });
    deletions++;
    oldIdx++;
  }

  // Remaining additions
  while (newIdx < newLines.length) {
    diffLines.push({
      type: 'add',
      content: newLines[newIdx]!,
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
 * Simple line-by-line diff for large files (avoids O(n*m) LCS)
 */
function generateSimpleDiff(oldLines: string[], newLines: string[], path: string, diffLines: DiffLine[]): FileDiff {
  let additions = 0;
  let deletions = 0;
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      diffLines.push({ type: 'context', content: oldLine!, oldLineNum: i + 1, newLineNum: i + 1 });
    } else {
      if (oldLine !== undefined) {
        diffLines.push({ type: 'remove', content: oldLine, oldLineNum: i + 1 });
        deletions++;
      }
      if (newLine !== undefined) {
        diffLines.push({ type: 'add', content: newLine, newLineNum: i + 1 });
        additions++;
      }
    }
  }

  return { path, oldContent: oldLines.join('\n'), newContent: newLines.join('\n'), lines: diffLines, additions, deletions };
}

/**
 * LCS algorithm for diff
 */
function longestCommonSubsequence(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    const row = dp[i]!;
    const prevRow = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        row[j] = prevRow[j - 1]! + 1;
      } else {
        row[j] = Math.max(prevRow[j]!, row[j - 1]!);
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
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
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

/**
 * Format diff for terminal display
 */
export function formatDiff(diff: FileDiff, contextLines = 3): string {
  const lines: string[] = [];

  // Header
  lines.push(`${COLORS.cyan}${diff.lines[0]?.content ?? ''}${COLORS.reset}`);
  lines.push(`${COLORS.cyan}${diff.lines[1]?.content ?? ''}${COLORS.reset}`);
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
    const line = lines[i]!;

    if (line.type === 'context') {
      contextCount++;

      // Check if there are changes within contextLines ahead
      let hasChangesAhead = false;
      for (let j = i + 1; j < Math.min(i + contextLines + 1, lines.length); j++) {
        if (lines[j]!.type !== 'context') {
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

// ============================================================================
// Claude Code-style Inline Diff Formatting
// ============================================================================

export interface InlineDiffOptions {
  contextLines: number;  // Number of context lines to show (1-5)
  maxLineWidth: number;  // Max width for line content
  showLineNumbers: boolean;
}

const DEFAULT_INLINE_OPTIONS: InlineDiffOptions = {
  contextLines: 2,
  maxLineWidth: 80,
  showLineNumbers: true,
};

/**
 * Format a diff for inline display (Claude Code style)
 * Returns lines ready for display with line numbers
 */
export function formatInlineDiff(
  diff: FileDiff,
  options: Partial<InlineDiffOptions> = {}
): { header: string; summary: string; lines: Array<{ prefix: string; lineNum: string; content: string; type: 'context' | 'add' | 'remove' }> } {
  const opts = { ...DEFAULT_INLINE_OPTIONS, ...options };

  // Compute summary
  const summary = formatChangeSummary(diff.additions, diff.deletions);

  // Get the max line number width for padding
  const maxLineNum = Math.max(
    ...diff.lines.filter(l => l.newLineNum).map(l => l.newLineNum!),
    ...diff.lines.filter(l => l.oldLineNum).map(l => l.oldLineNum!),
    1
  );
  const lineNumWidth = Math.max(4, maxLineNum.toString().length);

  // Group changes with context
  const chunks = groupDiffChunks(
    diff.lines.filter(l => l.type !== 'header'),
    opts.contextLines
  );

  // Format lines
  const formattedLines: Array<{ prefix: string; lineNum: string; content: string; type: 'context' | 'add' | 'remove' }> = [];

  for (const chunk of chunks) {
    for (const line of chunk) {
      const lineNum = line.type === 'remove'
        ? (line.oldLineNum?.toString() || '').padStart(lineNumWidth)
        : (line.newLineNum?.toString() || '').padStart(lineNumWidth);

      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      const content = line.content.substring(0, opts.maxLineWidth);

      formattedLines.push({
        prefix,
        lineNum,
        content,
        type: line.type === 'header' ? 'context' : line.type,
      });
    }
  }

  return {
    header: diff.path,
    summary,
    lines: formattedLines,
  };
}

/**
 * Format change summary string
 */
export function formatChangeSummary(additions: number, deletions: number): string {
  if (additions === 0 && deletions === 0) {
    return 'No changes';
  }

  const parts: string[] = [];

  if (additions > 0 && deletions > 0) {
    return `Modified ${additions + deletions} lines`;
  } else if (additions > 0) {
    return `Added ${additions} line${additions !== 1 ? 's' : ''}`;
  } else {
    return `Removed ${deletions} line${deletions !== 1 ? 's' : ''}`;
  }
}

/**
 * Create diff from old and new content (convenience function)
 */
export function createDiff(oldContent: string, newContent: string, path: string): FileDiff {
  return generateDiff(oldContent, newContent, path);
}

// ============================================================================
// Skin-Aware Diff Formatting
// ============================================================================

/**
 * Get diff colors from the current palette
 */
function getDiffColors(): { add: string; remove: string; context: string; header: string; reset: string } {
  try {
    const palette = getCurrentPalette();
    return {
      add: palette.colors.diffAdd || COLORS.green,
      remove: palette.colors.diffRemove || COLORS.red,
      context: palette.colors.diffContext || COLORS.dim,
      header: palette.colors.info || COLORS.cyan,
      reset: COLORS.reset,
    };
  } catch {
    return { add: COLORS.green, remove: COLORS.red, context: COLORS.dim, header: COLORS.cyan, reset: COLORS.reset };
  }
}

/**
 * Get diff config from the current skin
 */
function getDiffConfig(): Skin['diff'] {
  try {
    return getCurrentSkin().diff;
  } catch {
    return {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    };
  }
}

// ============================================================================
// Unified Diff Formatter
// ============================================================================

/**
 * Format diff in unified style (standard @@ hunk markers, ---/+++ headers)
 */
export function formatUnifiedDiff(diff: FileDiff, options?: Partial<Skin['diff']>): string {
  const config = { ...getDiffConfig(), ...options };
  const dc = getDiffColors();
  const lines: string[] = [];

  // Header
  if (config.header === 'path' || config.header === 'hunk') {
    lines.push(`${dc.header}--- a/${diff.path}${dc.reset}`);
    lines.push(`${dc.header}+++ b/${diff.path}${dc.reset}`);
  } else if (config.header === 'action') {
    const action = diff.deletions === 0 ? 'Create' : diff.additions === 0 ? 'Delete' : 'Update';
    lines.push(`${dc.header}${action}(${diff.path})${dc.reset}`);
  }
  lines.push('');

  // Group into hunks
  const diffLines = diff.lines.filter(l => l.type !== 'header');
  const chunks = groupDiffChunks(diffLines, config.contextLines);

  for (const chunk of chunks) {
    // Hunk header
    const oldStart = chunk.find(l => l.oldLineNum)?.oldLineNum || 1;
    const newStart = chunk.find(l => l.newLineNum)?.newLineNum || 1;
    const oldCount = chunk.filter(l => l.type === 'remove' || l.type === 'context').length;
    const newCount = chunk.filter(l => l.type === 'add' || l.type === 'context').length;
    lines.push(`${dc.header}@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${dc.reset}`);

    for (const line of chunk) {
      const rawContent = line.content.substring(0, config.maxLineWidth);
      // Apply syntax highlighting to context lines for readability
      const content = line.type === 'context' ? highlightSyntax(rawContent, diff.path) : rawContent;
      const lineNum = config.showLineNumbers
        ? (line.type === 'remove'
          ? (line.oldLineNum?.toString() || '').padStart(4)
          : (line.newLineNum?.toString() || '').padStart(4)) + ' '
        : '';

      switch (line.type) {
        case 'add':
          lines.push(`${dc.add}${lineNum}+${content}${dc.reset}`);
          break;
        case 'remove':
          lines.push(`${dc.remove}${lineNum}-${content}${dc.reset}`);
          break;
        case 'context':
          lines.push(`${dc.context}${lineNum} ${dc.reset}${content}`);
          break;
      }
    }
    lines.push('');
  }

  // Summary
  lines.push(`${dc.add}+${diff.additions}${dc.reset} ${dc.remove}-${diff.deletions}${dc.reset}`);

  return lines.join('\n');
}

// ============================================================================
// Side-by-Side Diff Formatter
// ============================================================================

/**
 * Format diff in side-by-side two-column display
 */
export function formatSideBySideDiff(diff: FileDiff, termWidth?: number, options?: Partial<Skin['diff']>): string {
  const config = { ...getDiffConfig(), ...options };
  const dc = getDiffColors();
  const lines: string[] = [];

  const width = termWidth || (process.stdout.columns || 120);
  const colWidth = Math.floor((width - 3) / 2); // 3 for the separator " | "

  // Header
  if (config.header === 'path' || config.header === 'hunk') {
    lines.push(`${dc.header}--- a/${diff.path}${dc.reset}${''.padEnd(colWidth - diff.path.length - 6)}${dc.header}+++ b/${diff.path}${dc.reset}`);
  } else if (config.header === 'action') {
    const action = diff.deletions === 0 ? 'Create' : diff.additions === 0 ? 'Delete' : 'Update';
    lines.push(`${dc.header}${action}(${diff.path})${dc.reset}`);
  }
  lines.push(`${'─'.repeat(colWidth)} │ ${'─'.repeat(colWidth)}`);

  // Pair up removed/added lines for side-by-side
  const diffLines = diff.lines.filter(l => l.type !== 'header');
  const chunks = groupDiffChunks(diffLines, config.contextLines);

  for (const chunk of chunks) {
    // Build paired lines
    const pairs: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
    let i = 0;
    while (i < chunk.length) {
      const line = chunk[i]!;
      if (line.type === 'context') {
        pairs.push({ left: line, right: line });
        i++;
      } else if (line.type === 'remove') {
        // Collect consecutive removes, then pair with consecutive adds
        const removes: DiffLine[] = [];
        while (i < chunk.length && chunk[i]!.type === 'remove') {
          removes.push(chunk[i]!);
          i++;
        }
        const adds: DiffLine[] = [];
        while (i < chunk.length && chunk[i]!.type === 'add') {
          adds.push(chunk[i]!);
          i++;
        }
        const maxPairs = Math.max(removes.length, adds.length);
        for (let j = 0; j < maxPairs; j++) {
          pairs.push({
            left: j < removes.length ? removes[j]! : null,
            right: j < adds.length ? adds[j]! : null,
          });
        }
      } else if (line.type === 'add') {
        pairs.push({ left: null, right: line });
        i++;
      } else {
        i++;
      }
    }

    for (const pair of pairs) {
      const leftContent = pair.left ? pair.left.content.substring(0, colWidth - 6) : '';
      const rightContent = pair.right ? pair.right.content.substring(0, colWidth - 6) : '';
      const leftNum = pair.left
        ? (pair.left.oldLineNum?.toString() || '').padStart(4) + ' '
        : '     ';
      const rightNum = pair.right
        ? (pair.right.newLineNum?.toString() || '').padStart(4) + ' '
        : '     ';

      let leftFormatted: string;
      let rightFormatted: string;

      if (pair.left?.type === 'remove') {
        leftFormatted = `${dc.remove}${leftNum}${leftContent}${dc.reset}`;
      } else if (pair.left?.type === 'context') {
        leftFormatted = `${dc.context}${leftNum}${leftContent}${dc.reset}`;
      } else {
        leftFormatted = `${leftNum}${leftContent}`;
      }

      if (pair.right?.type === 'add') {
        rightFormatted = `${dc.add}${rightNum}${rightContent}${dc.reset}`;
      } else if (pair.right?.type === 'context') {
        rightFormatted = `${dc.context}${rightNum}${rightContent}${dc.reset}`;
      } else {
        rightFormatted = `${rightNum}${rightContent}`;
      }

      // Pad to column width (approximate — ANSI codes make exact alignment hard)
      const leftPadded = leftContent.padEnd(colWidth - 5);
      const rightPadded = rightContent;

      if (pair.left?.type === 'remove') {
        lines.push(`${dc.remove}${leftNum}${leftPadded}${dc.reset} ${COLORS.dim}│${COLORS.reset} ${pair.right ? (pair.right.type === 'add' ? dc.add : dc.context) : ''}${rightNum}${rightPadded}${dc.reset}`);
      } else if (pair.left?.type === 'context') {
        lines.push(`${dc.context}${leftNum}${leftPadded}${dc.reset} ${COLORS.dim}│${COLORS.reset} ${dc.context}${rightNum}${rightPadded}${dc.reset}`);
      } else {
        lines.push(`${leftNum}${leftPadded} ${COLORS.dim}│${COLORS.reset} ${pair.right?.type === 'add' ? dc.add : ''}${rightNum}${rightPadded}${dc.reset}`);
      }
    }
    lines.push('');
  }

  lines.push(`${dc.add}+${diff.additions}${dc.reset} ${dc.remove}-${diff.deletions}${dc.reset}`);

  return lines.join('\n');
}

// ============================================================================
// Word-Level Diff
// ============================================================================

/**
 * Compute word-level diff between two lines, returning highlighted segments
 */
export function wordDiff(oldLine: string, newLine: string): { old: string; new: string } {
  const dc = getDiffColors();
  const oldWords = oldLine.split(/(\s+)/);
  const newWords = newLine.split(/(\s+)/);

  // Simple LCS on words
  const m = oldWords.length;
  const n = newWords.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    const row = dp[i]!;
    const prevRow = dp[i - 1]!;
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        row[j] = prevRow[j - 1]! + 1;
      } else {
        row[j] = Math.max(prevRow[j]!, row[j - 1]!);
      }
    }
  }

  // Backtrack
  const lcs: Array<[number, number]> = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldWords[i - 1] === newWords[j - 1]) {
      lcs.unshift([i - 1, j - 1]);
      i--; j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  // Build highlighted old line
  let oldResult = '';
  let oi = 0;
  for (const [oldIdx] of lcs) {
    // Removed words before this match
    while (oi < oldIdx) {
      oldResult += `${dc.remove}${COLORS.bold}${oldWords[oi]}${dc.reset}${dc.remove}`;
      oi++;
    }
    oldResult += oldWords[oi];
    oi++;
  }
  while (oi < oldWords.length) {
    oldResult += `${dc.remove}${COLORS.bold}${oldWords[oi]}${dc.reset}${dc.remove}`;
    oi++;
  }

  // Build highlighted new line
  let newResult = '';
  let ni = 0;
  for (const [, newIdx] of lcs) {
    while (ni < newIdx) {
      newResult += `${dc.add}${COLORS.bold}${newWords[ni]}${dc.reset}${dc.add}`;
      ni++;
    }
    newResult += newWords[ni];
    ni++;
  }
  while (ni < newWords.length) {
    newResult += `${dc.add}${COLORS.bold}${newWords[ni]}${dc.reset}${dc.add}`;
    ni++;
  }

  return { old: oldResult, new: newResult };
}

// ============================================================================
// Syntax Highlighting (#30)
// ============================================================================

/** Language detection from file extension */
function detectLanguage(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
    cs: 'csharp', swift: 'swift', kt: 'kotlin', sh: 'shell', bash: 'shell', zsh: 'shell',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown',
    html: 'html', css: 'css', scss: 'css', sql: 'sql',
  };
  return ext ? langMap[ext] || null : null;
}

/** Syntax highlighting rules per language group */
const SYNTAX_RULES: Record<string, Array<{ pattern: RegExp; color: string }>> = {
  typescript: [
    { pattern: /(\/\/[^\n]*)/g, color: COLORS.dim },                                              // comments
    { pattern: /(\/\*[\s\S]*?\*\/)/g, color: COLORS.dim },                                        // block comments
    { pattern: /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, color: COLORS.green }, // strings
    { pattern: /\b(import|export|from|const|let|var|function|class|interface|type|enum|return|if|else|for|while|switch|case|break|continue|try|catch|throw|new|async|await|extends|implements)\b/g, color: COLORS.magenta }, // keywords
    { pattern: /\b(\d+\.?\d*)\b/g, color: COLORS.yellow },                                        // numbers
  ],
  python: [
    { pattern: /(#[^\n]*)/g, color: COLORS.dim },
    { pattern: /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|'''[\s\S]*?'''|"""[\s\S]*?""")/g, color: COLORS.green },
    { pattern: /\b(import|from|def|class|return|if|elif|else|for|while|try|except|raise|with|as|yield|lambda|pass|break|continue|and|or|not|in|is|None|True|False)\b/g, color: COLORS.magenta },
    { pattern: /\b(\d+\.?\d*)\b/g, color: COLORS.yellow },
  ],
  go: [
    { pattern: /(\/\/[^\n]*)/g, color: COLORS.dim },
    { pattern: /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)/g, color: COLORS.green },
    { pattern: /\b(package|import|func|type|struct|interface|return|if|else|for|range|switch|case|break|continue|go|defer|chan|select|map|var|const)\b/g, color: COLORS.magenta },
    { pattern: /\b(\d+\.?\d*)\b/g, color: COLORS.yellow },
  ],
  rust: [
    { pattern: /(\/\/[^\n]*)/g, color: COLORS.dim },
    { pattern: /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, color: COLORS.green },
    { pattern: /\b(fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|for|while|loop|return|self|Self|where|async|await|move|unsafe)\b/g, color: COLORS.magenta },
    { pattern: /\b(\d+\.?\d*)\b/g, color: COLORS.yellow },
  ],
  shell: [
    { pattern: /(#[^\n]*)/g, color: COLORS.dim },
    { pattern: /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, color: COLORS.green },
    { pattern: /\b(if|then|else|elif|fi|for|do|done|while|case|esac|function|return|export|local|readonly)\b/g, color: COLORS.magenta },
  ],
  json: [
    { pattern: /("(?:[^"\\]|\\.)*")\s*:/g, color: COLORS.cyan },    // keys
    { pattern: /:\s*("(?:[^"\\]|\\.)*")/g, color: COLORS.green },    // string values
    { pattern: /:\s*(\d+\.?\d*)/g, color: COLORS.yellow },           // number values
    { pattern: /:\s*(true|false|null)\b/g, color: COLORS.magenta },  // special values
  ],
  default: [
    { pattern: /(\/\/[^\n]*|#[^\n]*)/g, color: COLORS.dim },
    { pattern: /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, color: COLORS.green },
    { pattern: /\b(\d+\.?\d*)\b/g, color: COLORS.yellow },
  ],
};

// Aliases (base languages are defined in the object literal above, so present)
SYNTAX_RULES.javascript = SYNTAX_RULES.typescript!;
SYNTAX_RULES.c = SYNTAX_RULES.rust!;
SYNTAX_RULES.cpp = SYNTAX_RULES.rust!;
SYNTAX_RULES.java = SYNTAX_RULES.typescript!;
SYNTAX_RULES.csharp = SYNTAX_RULES.typescript!;
SYNTAX_RULES.swift = SYNTAX_RULES.rust!;
SYNTAX_RULES.kotlin = SYNTAX_RULES.typescript!;
SYNTAX_RULES.ruby = SYNTAX_RULES.python!;
SYNTAX_RULES.css = SYNTAX_RULES.default!;
SYNTAX_RULES.html = SYNTAX_RULES.default!;
SYNTAX_RULES.sql = SYNTAX_RULES.default!;
SYNTAX_RULES.yaml = SYNTAX_RULES.default!;
SYNTAX_RULES.toml = SYNTAX_RULES.default!;
SYNTAX_RULES.markdown = SYNTAX_RULES.default!;

/**
 * Apply syntax highlighting to a line of code
 */
export function highlightSyntax(line: string, filePath: string): string {
  const lang = detectLanguage(filePath);
  const rules = lang ? SYNTAX_RULES[lang] || SYNTAX_RULES.default! : SYNTAX_RULES.default!;

  // Match every rule against the ORIGINAL line (never against intermediate
  // colored output), capturing the position of group 1 — the token that should
  // actually be colored (rules like JSON keys consume trailing context outside
  // the capture). Collect {start,end,color} ranges, merge into non-overlapping
  // spans (earlier rule wins), then emit in a single left-to-right pass so a
  // regex can never run over an injected ANSI escape sequence.
  const ranges: { start: number; end: number; color: string; priority: number }[] = [];
  rules.forEach(({ pattern, color }, priority) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const token = match[1] ?? match[0];
      // Offset of the captured token within the full match.
      const tokenOffset = match[1] !== undefined ? match[0].indexOf(match[1]) : 0;
      const start = match.index + (tokenOffset >= 0 ? tokenOffset : 0);
      const end = start + token.length;
      if (end > start) ranges.push({ start, end, color, priority });
      if (match[0].length === 0) pattern.lastIndex++;
    }
  });

  ranges.sort((a, b) =>
    a.priority - b.priority ||
    a.start - b.start ||
    b.end - a.end,
  );
  const spans: { start: number; end: number; color: string }[] = [];
  for (const r of ranges) {
    if (spans.some(s => r.start < s.end && r.end > s.start)) continue;
    spans.push({ start: r.start, end: r.end, color: r.color });
  }
  spans.sort((a, b) => a.start - b.start);

  let result = '';
  let cursor = 0;
  for (const { start, end, color } of spans) {
    if (start > cursor) result += line.slice(cursor, start);
    result += color + line.slice(start, end) + COLORS.reset;
    cursor = end;
  }
  if (cursor < line.length) result += line.slice(cursor);

  return result;
}

// ============================================================================
// Skin-Driven Diff Dispatcher
// ============================================================================

export type DiffStyle = 'inline' | 'unified' | 'side-by-side';

/**
 * Format a diff using the style from the current skin (or override)
 */
export function formatSkinDiff(diff: FileDiff, styleOverride?: DiffStyle, termWidth?: number): string {
  const style = styleOverride || getDiffConfig().style;

  switch (style) {
    case 'unified':
      return formatUnifiedDiff(diff);
    case 'side-by-side':
      return formatSideBySideDiff(diff, termWidth);
    case 'inline':
    default:
      return formatDiff(diff, getDiffConfig().contextLines);
  }
}
