/**
 * Tests for src/checkpoint.ts
 *
 * Covers: createCheckpoint, restoreCheckpoint, listCheckpoints,
 * clearCheckpoints, getCheckpointDir, and edge cases.
 * Uses real temp dirs with os.homedir() mocked to isolate checkpoint storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to mock os.homedir() BEFORE importing checkpoint so that
// getCheckpointDir() uses our temp directory.
let fakeHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

// Import after mock is set up
import {
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  clearCheckpoints,
  getCheckpointDir,
} from '../src/checkpoint.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-checkpoint-test-'));
  fakeHome = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// getCheckpointDir
// ===========================================================================

describe('getCheckpointDir', () => {
  it('should return a path under fake home', () => {
    const dir = getCheckpointDir();
    expect(dir.startsWith(fakeHome)).toBe(true);
    expect(dir).toContain('.calliope-cli');
    expect(dir).toContain('checkpoints');
  });

  it('should create the directory if it does not exist', () => {
    const dir = getCheckpointDir();
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// ===========================================================================
// createCheckpoint
// ===========================================================================

describe('createCheckpoint', () => {
  it('should save provided content and return a filename', () => {
    const filePath = path.join(tmpDir, 'file.txt');
    const filename = createCheckpoint(filePath, 'original content');

    expect(filename).toBeDefined();
    expect(typeof filename).toBe('string');
    expect(filename!.startsWith('checkpoint-')).toBe(true);
    expect(filename!.endsWith('.json')).toBe(true);

    // Verify the checkpoint file was written
    const cpPath = path.join(getCheckpointDir(), filename!);
    expect(fs.existsSync(cpPath)).toBe(true);

    const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    expect(cp.content).toBe('original content');
    expect(cp.filePath).toBe(path.resolve(filePath));
    expect(cp.timestamp).toBeDefined();
  });

  it('should read content from disk when not provided', () => {
    const filePath = path.join(tmpDir, 'ondisk.txt');
    fs.writeFileSync(filePath, 'disk content');

    const filename = createCheckpoint(filePath);
    expect(filename).toBeDefined();

    const cpPath = path.join(getCheckpointDir(), filename!);
    const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    expect(cp.content).toBe('disk content');
  });

  it('should return undefined when file does not exist and no content given', () => {
    const result = createCheckpoint(path.join(tmpDir, 'ghost.txt'));
    expect(result).toBeUndefined();
  });

  it('should store optional sessionId', () => {
    const filePath = path.join(tmpDir, 'session.txt');
    const filename = createCheckpoint(filePath, 'data', 'session-123');

    const cpPath = path.join(getCheckpointDir(), filename!);
    const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    expect(cp.sessionId).toBe('session-123');
  });

  it('should not include sessionId when not provided', () => {
    const filePath = path.join(tmpDir, 'nosession.txt');
    const filename = createCheckpoint(filePath, 'data');

    const cpPath = path.join(getCheckpointDir(), filename!);
    const cp = JSON.parse(fs.readFileSync(cpPath, 'utf-8'));
    expect(cp.sessionId).toBeUndefined();
  });
});

// ===========================================================================
// restoreCheckpoint
// ===========================================================================

describe('restoreCheckpoint', () => {
  it('should restore the most recent checkpoint', async () => {
    const filePath = path.join(tmpDir, 'restore-me.txt');

    // Create two checkpoints with slight delay
    createCheckpoint(filePath, 'version 1');
    // Ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    createCheckpoint(filePath, 'version 2');

    // Write something else to the file
    fs.writeFileSync(filePath, 'current content');

    // Restore index 0 = most recent = version 2
    const restored = restoreCheckpoint(filePath, 0);
    expect(restored).toBe('version 2');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('version 2');
  });

  it('should restore an older checkpoint by index', async () => {
    const filePath = path.join(tmpDir, 'restore-old.txt');

    createCheckpoint(filePath, 'v1');
    await new Promise(r => setTimeout(r, 10));
    createCheckpoint(filePath, 'v2');

    const restored = restoreCheckpoint(filePath, 1);
    expect(restored).toBe('v1');
  });

  it('should return undefined when no checkpoints exist', () => {
    const result = restoreCheckpoint(path.join(tmpDir, 'nocheckpoint.txt'));
    expect(result).toBeUndefined();
  });

  it('should return undefined for out-of-range index', () => {
    const filePath = path.join(tmpDir, 'oor.txt');
    createCheckpoint(filePath, 'data');

    expect(restoreCheckpoint(filePath, 5)).toBeUndefined();
    expect(restoreCheckpoint(filePath, -1)).toBeUndefined();
  });

  it('should create parent directories if needed', () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'file.txt');
    createCheckpoint(filePath, 'deep content');

    const restored = restoreCheckpoint(filePath);
    expect(restored).toBe('deep content');
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ===========================================================================
// listCheckpoints
// ===========================================================================

describe('listCheckpoints', () => {
  it('should return empty list when no checkpoints exist', () => {
    expect(listCheckpoints()).toEqual([]);
  });

  it('should list all checkpoints', async () => {
    const f1 = path.join(tmpDir, 'a.txt');
    const f2 = path.join(tmpDir, 'b.txt');

    createCheckpoint(f1, 'a');
    await new Promise(r => setTimeout(r, 10));
    createCheckpoint(f2, 'b');

    const all = listCheckpoints();
    expect(all.length).toBe(2);
  });

  it('should filter by file path', async () => {
    const f1 = path.join(tmpDir, 'x.txt');
    const f2 = path.join(tmpDir, 'y.txt');

    createCheckpoint(f1, 'x');
    await new Promise(r => setTimeout(r, 10));
    createCheckpoint(f2, 'y');

    const filtered = listCheckpoints(f1);
    expect(filtered.length).toBe(1);
    expect(filtered[0].filePath).toBe(path.resolve(f1));
  });

  it('should sort newest first', async () => {
    const filePath = path.join(tmpDir, 'sorted.txt');

    createCheckpoint(filePath, 'older');
    await new Promise(r => setTimeout(r, 15));
    createCheckpoint(filePath, 'newer');

    const list = listCheckpoints(filePath);
    expect(list.length).toBe(2);
    // First entry should have a later timestamp
    expect(list[0].timestamp >= list[1].timestamp).toBe(true);
  });

  it('should include size in summaries', () => {
    const filePath = path.join(tmpDir, 'sized.txt');
    createCheckpoint(filePath, 'hello world');

    const list = listCheckpoints(filePath);
    expect(list[0].size).toBe('hello world'.length);
  });
});

// ===========================================================================
// clearCheckpoints
// ===========================================================================

describe('clearCheckpoints', () => {
  it('should remove all checkpoints when no days specified', () => {
    createCheckpoint(path.join(tmpDir, 'a.txt'), 'a');
    createCheckpoint(path.join(tmpDir, 'b.txt'), 'b');

    const removed = clearCheckpoints();
    expect(removed).toBe(2);
    expect(listCheckpoints().length).toBe(0);
  });

  it('should return 0 when no checkpoints exist', () => {
    expect(clearCheckpoints()).toBe(0);
  });

  it('should keep recent checkpoints when olderThanDays is specified', () => {
    // Create a checkpoint (just now, so within any reasonable days threshold)
    createCheckpoint(path.join(tmpDir, 'recent.txt'), 'recent');

    const removed = clearCheckpoints(1); // Older than 1 day
    expect(removed).toBe(0);
    expect(listCheckpoints().length).toBe(1);
  });
});
