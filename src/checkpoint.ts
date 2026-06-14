/**
 * Calliope CLI - Checkpoint/Restore Module (#20)
 *
 * Saves file content before overwrites so users can restore previous versions.
 * Checkpoints are stored as individual JSON files in ~/.calliope-cli/checkpoints/
 * organized by session date.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export interface Checkpoint {
  filePath: string;
  content: string;
  timestamp: string;
  sessionId?: string;
}

export interface CheckpointSummary {
  file: string;
  filePath: string;
  timestamp: string;
  sessionId?: string;
  size: number;
}

// ============================================================================
// Directory Management
// ============================================================================

/**
 * Returns the checkpoint directory path (~/.calliope-cli/checkpoints/).
 */
export function getCheckpointDir(): string {
  const dir = path.join(os.homedir(), '.calliope-cli', 'checkpoints');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

let checkpointCounter = 0;

/** Auto-cleanup: remove checkpoints older than this many days */
const AUTO_CLEANUP_DAYS = 7;

/** Minimum interval between auto-cleanup runs (1 hour in ms) */
const AUTO_CLEANUP_INTERVAL = 60 * 60 * 1000;

/** Timestamp of last auto-cleanup run */
let lastAutoCleanup = 0;

/**
 * Generate a unique checkpoint filename from a timestamp.
 */
function makeFilename(timestamp: string): string {
  // Replace colons and dots for filesystem safety + add counter to avoid same-millisecond collisions
  const counter = String(checkpointCounter++).padStart(4, '0');
  return `checkpoint-${timestamp.replace(/[:\.]/g, '-')}-${counter}.json`;
}

// ============================================================================
// Core API
// ============================================================================

/**
 * Create a checkpoint for a file before it gets overwritten.
 * If content is provided, uses that; otherwise reads current content from disk.
 * Returns the checkpoint filename on success, or undefined if the file doesn't exist
 * and no content was provided.
 */
export function createCheckpoint(filePath: string, content?: string, sessionId?: string): string | undefined {
  // Auto-cleanup old checkpoints periodically (at most once per hour)
  const now = Date.now();
  if (now - lastAutoCleanup > AUTO_CLEANUP_INTERVAL) {
    lastAutoCleanup = now;
    try {
      clearCheckpoints(AUTO_CLEANUP_DAYS);
    } catch {
      // Don't let cleanup errors block checkpoint creation
    }
  }

  const absPath = path.resolve(filePath);

  // Determine content to save
  let fileContent: string;
  if (content !== undefined) {
    fileContent = content;
  } else {
    try {
      if (!fs.existsSync(absPath)) {
        return undefined;
      }
      fileContent = fs.readFileSync(absPath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  const timestamp = new Date().toISOString();
  const checkpoint: Checkpoint = {
    filePath: absPath,
    content: fileContent,
    timestamp,
    ...(sessionId ? { sessionId } : {}),
  };

  const dir = getCheckpointDir();
  const filename = makeFilename(timestamp);
  const fullPath = path.join(dir, filename);

  // Atomic write so a crash mid-write can't leave a truncated checkpoint.
  const tmp = `${fullPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
    fs.renameSync(tmp, fullPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
  return filename;
}

/**
 * Restore a file from its most recent checkpoint (or a specific index).
 * Index 0 = most recent, 1 = second most recent, etc.
 * Returns the restored content, or undefined if no checkpoint found.
 */
export function restoreCheckpoint(filePath: string, index: number = 0): string | undefined {
  const absPath = path.resolve(filePath);
  const checkpoints = getCheckpointsForFile(absPath);

  if (index < 0 || index >= checkpoints.length) {
    return undefined;
  }

  const checkpoint = checkpoints[index];
  // Write the content back to the original file
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(absPath, checkpoint.content);

  return checkpoint.content;
}

/**
 * List available checkpoints, optionally filtered by file path.
 * Returns summaries sorted newest-first.
 */
export function listCheckpoints(filePath?: string): CheckpointSummary[] {
  const dir = getCheckpointDir();

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'));
  } catch {
    return [];
  }

  const summaries: CheckpointSummary[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const cp: Checkpoint = JSON.parse(raw);

      // Filter by file path if specified
      if (filePath) {
        const absFilter = path.resolve(filePath);
        if (cp.filePath !== absFilter) continue;
      }

      summaries.push({
        file,
        filePath: cp.filePath,
        timestamp: cp.timestamp,
        sessionId: cp.sessionId,
        size: cp.content.length,
      });
    } catch {
      // Skip corrupted checkpoint files
    }
  }

  // Sort newest first
  summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return summaries;
}

/**
 * Clean up old checkpoints. If olderThanDays is provided, removes checkpoints
 * older than that many days. If omitted, removes all checkpoints.
 * Returns the number of checkpoints removed.
 */
export function clearCheckpoints(olderThanDays?: number): number {
  const dir = getCheckpointDir();

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'));
  } catch {
    return 0;
  }

  const cutoff = olderThanDays !== undefined
    ? new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    : null;

  let removed = 0;

  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      if (cutoff) {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const cp: Checkpoint = JSON.parse(raw);
        const cpDate = new Date(cp.timestamp);
        if (cpDate >= cutoff) continue;
      }
      fs.unlinkSync(fullPath);
      removed++;
    } catch {
      // Skip files that can't be read/deleted
    }
  }

  return removed;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Get all checkpoints for a specific file path, sorted newest-first.
 */
function getCheckpointsForFile(absPath: string): Checkpoint[] {
  const dir = getCheckpointDir();

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'));
  } catch {
    return [];
  }

  const checkpoints: Checkpoint[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const cp: Checkpoint = JSON.parse(raw);
      if (cp.filePath === absPath) {
        checkpoints.push(cp);
      }
    } catch {
      // Skip corrupted files
    }
  }

  // Sort newest first
  checkpoints.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return checkpoints;
}
