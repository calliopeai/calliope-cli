/**
 * Tests for src/checkpoint.ts (unified git-based checkpoints, #181)
 *
 * Uses vi.mock('child_process') to avoid real git calls. Covers:
 *  - shouldCheckpoint / createCheckpoint / revertToLastCheckpoint
 *  - getCheckpointStats / setEnabled
 *  - listCheckpoints / restoreFromCheckpoint / clearCheckpoints (ref-based)
 *  - clean no-ops outside a git work tree
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Mock child_process at the module level (ESM-safe approach)
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

// ---------------------------------------------------------------------------
// Module reset helper — the module carries module-level state.
// We import after mocking so it picks up our mock.
// ---------------------------------------------------------------------------

let shouldCheckpoint: typeof import('../src/checkpoint.js').shouldCheckpoint;
let createCheckpoint: typeof import('../src/checkpoint.js').createCheckpoint;
let revertToLastCheckpoint: typeof import('../src/checkpoint.js').revertToLastCheckpoint;
let getCheckpointStats: typeof import('../src/checkpoint.js').getCheckpointStats;
let setEnabled: typeof import('../src/checkpoint.js').setEnabled;
let listCheckpoints: typeof import('../src/checkpoint.js').listCheckpoints;
let restoreFromCheckpoint: typeof import('../src/checkpoint.js').restoreFromCheckpoint;
let clearCheckpoints: typeof import('../src/checkpoint.js').clearCheckpoints;

beforeEach(async () => {
  vi.resetModules();
  mockExecFileSync.mockReset();
  const mod = await import('../src/checkpoint.js');
  shouldCheckpoint = mod.shouldCheckpoint;
  createCheckpoint = mod.createCheckpoint;
  revertToLastCheckpoint = mod.revertToLastCheckpoint;
  getCheckpointStats = mod.getCheckpointStats;
  setEnabled = mod.setEnabled;
  listCheckpoints = mod.listCheckpoints;
  restoreFromCheckpoint = mod.restoreFromCheckpoint;
  clearCheckpoints = mod.clearCheckpoints;
});

// ---------------------------------------------------------------------------
// shouldCheckpoint
// ---------------------------------------------------------------------------

describe('shouldCheckpoint', () => {
  it('should return false when disabled', () => {
    mockExecFileSync.mockReturnValue('true\n');
    setEnabled(false);
    expect(shouldCheckpoint('write_file', { path: '/tmp/test.txt' })).toBe(false);
  });

  it('should return false when not in a git repo', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(shouldCheckpoint('write_file', { path: '/tmp/test.txt' })).toBe(false);
  });

  it('should return true for write_file in a git repo', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('write_file', { path: '/tmp/test.txt' })).toBe(true);
  });

  it('should return true for shell command with rm', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'rm somefile.txt' })).toBe(true);
  });

  it('should return true for shell command with mv', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'mv file.txt file2.txt' })).toBe(true);
  });

  it('should return true for shell command with cp -f', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'cp -f source.txt dest.txt' })).toBe(true);
  });

  it('should return true for shell command with git reset', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'git reset --hard HEAD' })).toBe(true);
  });

  it('should return true for shell command with git clean', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'git clean -fd' })).toBe(true);
  });

  it('should return true for shell command with sed -i', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'sed -i s/foo/bar/g file.txt' })).toBe(true);
  });

  it('should return true for shell command with output redirection', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'echo hello > file.txt' })).toBe(true);
  });

  it('should return true for shell command with dd', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'dd if=/dev/zero of=file' })).toBe(true);
  });

  it('should return true for shell command with truncate', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'truncate -s 0 file.txt' })).toBe(true);
  });

  it('should return false for safe shell command', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', { command: 'echo hello' })).toBe(false);
  });

  it('should return false for unknown tool', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('read_file', { path: '/tmp/test.txt' })).toBe(false);
  });

  it('should handle missing command arg gracefully', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('shell', {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createCheckpoint
// ---------------------------------------------------------------------------

/** Full-success mock producing the given short hash. */
function mockSuccessfulCheckpoint(hash: string, capture?: string[][]) {
  mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
    if (args[0] === 'status') return 'M file.txt\n';
    if (args[0] === 'add') return '';
    if (args[0] === 'diff') return 'some staged diff\n';
    if (args[0] === 'commit') return '';
    if (args[0] === 'rev-parse' && args[1] === '--short') return `${hash}\n`;
    if (args[0] === 'update-ref') { capture?.push(args); return ''; }
    if (args[0] === 'reset') return '';
    return '';
  });
}

describe('createCheckpoint', () => {
  it('should return null when not in a git repo', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(createCheckpoint('write_file', { path: 'test.txt' })).toBeNull();
  });

  it('should return null when git status is empty (nothing to checkpoint)', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse') return 'true\n';
      if (args[0] === 'status') return ''; // empty = nothing to commit
      return '';
    });
    expect(createCheckpoint('write_file', { path: 'test.txt' })).toBeNull();
  });

  it('should return null when nothing is staged after git add', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse') return 'true\n';
      if (args[0] === 'status') return 'M modified.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return ''; // nothing staged
      return '';
    });
    expect(createCheckpoint('write_file', { path: 'test.txt' })).toBeNull();
  });

  it('should create checkpoint for write_file and return hash', () => {
    mockSuccessfulCheckpoint('abc1234');
    expect(createCheckpoint('write_file', { path: 'src/main.ts' })).toBe('abc1234');
  });

  it('should create checkpoint for shell command and return hash', () => {
    mockSuccessfulCheckpoint('def5678');
    expect(createCheckpoint('shell', { command: 'rm -rf /tmp/test' })).toBe('def5678');
  });

  it('should create checkpoint for unknown tool using tool name as summary', () => {
    mockSuccessfulCheckpoint('bbb9999');
    expect(createCheckpoint('some_other_tool', {})).toBe('bbb9999');
  });

  it('should return null when git commit throws', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some diff\n';
      if (args[0] === 'commit') throw new Error('commit failed');
      return '';
    });
    expect(createCheckpoint('write_file', { path: 'test.txt' })).toBeNull();
  });

  it('should increment checkpoint count on success', () => {
    mockSuccessfulCheckpoint('aaa1111');
    createCheckpoint('write_file', { path: 'test.txt' });
    const stats = getCheckpointStats();
    expect(stats.count).toBe(1);
    expect(stats.lastHash).toBe('aaa1111');
  });

  it('records a checkpoint ref pointing at the commit', () => {
    const updateRefCalls: string[][] = [];
    mockSuccessfulCheckpoint('abc1234', updateRefCalls);
    expect(createCheckpoint('write_file', { path: 'a.txt' })).toBe('abc1234');
    expect(updateRefCalls.length).toBe(1);
    expect(updateRefCalls[0][0]).toBe('update-ref');
    expect(updateRefCalls[0][1]).toMatch(/^refs\/calliope\/checkpoints\//);
    expect(updateRefCalls[0][2]).toBe('abc1234');
  });

  it('still returns the hash when ref tracking fails (best-effort)', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'staged\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234\n';
      if (args[0] === 'update-ref') throw new Error('ref failed');
      return '';
    });
    expect(createCheckpoint('write_file', { path: 'a.txt' })).toBe('abc1234');
  });
});

// ---------------------------------------------------------------------------
// revertToLastCheckpoint
// ---------------------------------------------------------------------------

describe('revertToLastCheckpoint', () => {
  it('should return false when no checkpoint has been created', () => {
    mockExecFileSync.mockReturnValue('true\n');
    expect(revertToLastCheckpoint()).toBe(false);
  });

  it('should return true after successfully reverting', () => {
    mockSuccessfulCheckpoint('abc1234');
    createCheckpoint('write_file', { path: 'test.txt' });
    expect(revertToLastCheckpoint()).toBe(true);
  });

  it('should return false when git reset throws', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some diff\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234\n';
      if (args[0] === 'reset') throw new Error('reset failed');
      return '';
    });
    createCheckpoint('write_file', { path: 'test.txt' });
    expect(revertToLastCheckpoint()).toBe(false);
  });

  it('should reset against the captured repo root, not live cwd', () => {
    const resetCalls: string[][] = [];
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[], opts: { cwd: string }) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo-a\n';
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some diff\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234\n';
      if (args[0] === 'update-ref') return '';
      if (args[0] === 'reset') { resetCalls.push([opts.cwd, ...args]); return ''; }
      return '';
    });
    createCheckpoint('write_file', { path: 'test.txt' });
    expect(revertToLastCheckpoint()).toBe(true);
    expect(resetCalls).toEqual([['/repo-a', 'reset', '--hard', 'abc1234']]);
  });

  it('should be a no-op when the stored repo root no longer matches', () => {
    let toplevel = '/repo-a\n';
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return toplevel;
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some diff\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234\n';
      if (args[0] === 'update-ref') return '';
      if (args[0] === 'reset') throw new Error('should not reset on mismatch');
      return '';
    });
    createCheckpoint('write_file', { path: 'test.txt' });
    toplevel = '/repo-b\n'; // cwd moved to a different repo before the revert
    expect(revertToLastCheckpoint()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCheckpointStats / setEnabled
// ---------------------------------------------------------------------------

describe('getCheckpointStats', () => {
  it('should return initial stats', () => {
    const stats = getCheckpointStats();
    expect(stats.enabled).toBe(true);
    expect(stats.count).toBe(0);
    expect(stats.lastHash).toBeNull();
  });

  it('should reflect disabled state after setEnabled(false)', () => {
    setEnabled(false);
    expect(getCheckpointStats().enabled).toBe(false);
  });

  it('should reflect enabled state after setEnabled(true)', () => {
    setEnabled(false);
    setEnabled(true);
    expect(getCheckpointStats().enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGitRepo re-evaluation (must not memoize across cwd changes)
// ---------------------------------------------------------------------------

describe('isGitRepo re-evaluation', () => {
  it('should re-evaluate git-repo status on each call (no stale memoization)', () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });
    expect(shouldCheckpoint('write_file', { path: 'test.txt' })).toBe(false);

    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('write_file', { path: 'test.txt' })).toBe(true);

    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(shouldCheckpoint('write_file', { path: 'test.txt' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listCheckpoints
// ---------------------------------------------------------------------------

const REF_A = 'refs/calliope/checkpoints/2026-07-04T17-00-02-000Z-0002';
const REF_B = 'refs/calliope/checkpoints/2026-07-04T17-00-01-000Z-0001';
// for-each-ref --sort=-refname emits newest (REF_A) first.
const FOR_EACH_REF_OUT =
  `hashaaa\t${REF_A}\t2026-07-04T17:00:02-07:00\t[checkpoint] before write_file: a.txt\n` +
  `hashbbb\t${REF_B}\t2026-07-04T17:00:01-07:00\t[checkpoint] before write_file: b.txt\n`;

describe('listCheckpoints', () => {
  it('returns empty list outside a git work tree', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') throw new Error('not a repo');
      return '';
    });
    expect(listCheckpoints()).toEqual([]);
  });

  it('lists all checkpoints newest-first with parsed fields', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'for-each-ref') return FOR_EACH_REF_OUT;
      return '';
    });
    const all = listCheckpoints();
    expect(all.length).toBe(2);
    expect(all[0]).toEqual({
      ref: REF_A,
      hash: 'hashaaa',
      timestamp: '2026-07-04T17:00:02-07:00',
      subject: '[checkpoint] before write_file: a.txt',
    });
    expect(all[1].hash).toBe('hashbbb');
  });

  it('filters to checkpoints whose tree contains the file', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'for-each-ref') return FOR_EACH_REF_OUT;
      if (args[0] === 'cat-file') {
        // Only the newest checkpoint (hashaaa) contains the file.
        if (args[2] === 'hashaaa:wanted.txt') return '';
        throw new Error('not in tree');
      }
      return '';
    });
    const filtered = listCheckpoints('/repo/wanted.txt');
    expect(filtered.length).toBe(1);
    expect(filtered[0].hash).toBe('hashaaa');
  });

  it('returns empty when for-each-ref produces no output', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'for-each-ref') return '';
      return '';
    });
    expect(listCheckpoints()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// restoreFromCheckpoint
// ---------------------------------------------------------------------------

describe('restoreFromCheckpoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-cp-restore-'));
  });

  it('restores a file from the most recent checkpoint and writes it to disk', () => {
    const target = path.join(tmpDir, 'file.txt');
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${tmpDir}\n`;
      if (args[0] === 'for-each-ref') {
        return `hashaaa\t${REF_A}\t2026-07-04T17:00:02-07:00\t[checkpoint] before write_file: file.txt\n`;
      }
      if (args[0] === 'cat-file') return ''; // file present in tree
      if (args[0] === 'show') return 'restored content';
      return '';
    });

    const restored = restoreFromCheckpoint(target, 0);
    expect(restored).toBe('restored content');
    expect(fs.readFileSync(target, 'utf-8')).toBe('restored content');
  });

  it('returns undefined for an out-of-range index', () => {
    const target = path.join(tmpDir, 'file.txt');
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${tmpDir}\n`;
      if (args[0] === 'for-each-ref') {
        return `hashaaa\t${REF_A}\t2026-07-04T17:00:02-07:00\t[checkpoint] before write_file: file.txt\n`;
      }
      if (args[0] === 'cat-file') return '';
      return '';
    });
    expect(restoreFromCheckpoint(target, 5)).toBeUndefined();
    expect(restoreFromCheckpoint(target, -1)).toBeUndefined();
  });

  it('returns undefined outside a git work tree', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') throw new Error('not a repo');
      return '';
    });
    expect(restoreFromCheckpoint(path.join(tmpDir, 'file.txt'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clearCheckpoints
// ---------------------------------------------------------------------------

describe('clearCheckpoints', () => {
  it('returns 0 outside a git work tree', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') throw new Error('not a repo');
      return '';
    });
    expect(clearCheckpoints()).toBe(0);
  });

  it('deletes all checkpoint refs when no age is given', () => {
    const deleted: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'for-each-ref') return `${REF_A}\t1751600002\n${REF_B}\t1751600001\n`;
      if (args[0] === 'update-ref' && args[1] === '-d') { deleted.push(args[2]); return ''; }
      return '';
    });
    expect(clearCheckpoints()).toBe(2);
    expect(deleted).toEqual([REF_A, REF_B]);
  });

  it('keeps recent checkpoints when olderThanDays is specified', () => {
    const nowUnix = Math.floor(Date.now() / 1000);
    const oldUnix = nowUnix - 10 * 24 * 60 * 60; // 10 days ago
    const deleted: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'for-each-ref') return `${REF_A}\t${nowUnix}\n${REF_B}\t${oldUnix}\n`;
      if (args[0] === 'update-ref' && args[1] === '-d') { deleted.push(args[2]); return ''; }
      return '';
    });
    // Only the 10-day-old checkpoint is older than 1 day.
    expect(clearCheckpoints(1)).toBe(1);
    expect(deleted).toEqual([REF_B]);
  });

  it('returns 0 when there are no checkpoint refs', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'for-each-ref') return '';
      return '';
    });
    expect(clearCheckpoints()).toBe(0);
  });
});
