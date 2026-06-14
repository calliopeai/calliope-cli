/**
 * Tests for src/auto-checkpoint.ts
 *
 * Uses vi.mock('child_process') to avoid real git calls.
 * Validates shouldCheckpoint, createCheckpoint, revertToLastCheckpoint,
 * getCheckpointStats, and setEnabled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock child_process at the module level (ESM-safe approach)
// ---------------------------------------------------------------------------

const mockExecFileSync = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

// ---------------------------------------------------------------------------
// Module reset helper — auto-checkpoint has module-level state
// We import after mocking so it picks up our mock.
// ---------------------------------------------------------------------------

let shouldCheckpoint: typeof import('../src/auto-checkpoint.js').shouldCheckpoint;
let createCheckpoint: typeof import('../src/auto-checkpoint.js').createCheckpoint;
let revertToLastCheckpoint: typeof import('../src/auto-checkpoint.js').revertToLastCheckpoint;
let getCheckpointStats: typeof import('../src/auto-checkpoint.js').getCheckpointStats;
let setEnabled: typeof import('../src/auto-checkpoint.js').setEnabled;

beforeEach(async () => {
  vi.resetModules();
  mockExecFileSync.mockReset();
  // Re-import to get fresh module state (resets module-level vars)
  const mod = await import('../src/auto-checkpoint.js');
  shouldCheckpoint = mod.shouldCheckpoint;
  createCheckpoint = mod.createCheckpoint;
  revertToLastCheckpoint = mod.revertToLastCheckpoint;
  getCheckpointStats = mod.getCheckpointStats;
  setEnabled = mod.setEnabled;
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

  it('should return true for shell command with git reset --hard', () => {
    mockExecFileSync.mockReturnValue('true\n');
    // regex: /\bgit\s+(reset|checkout\s+--)\b/ matches "git reset"
    expect(shouldCheckpoint('shell', { command: 'git reset --hard HEAD~1' })).toBe(true);
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
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'status') return 'M modified.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some staged diff\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234\n';
      return '';
    });
    const hash = createCheckpoint('write_file', { path: 'src/main.ts' });
    expect(hash).toBe('abc1234');
  });

  it('should create checkpoint for shell command and return hash', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some diff\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'def5678\n';
      return '';
    });
    const hash = createCheckpoint('shell', { command: 'rm -rf /tmp/test' });
    expect(hash).toBe('def5678');
  });

  it('should create checkpoint for unknown tool using tool name as summary', () => {
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some diff\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'bbb9999\n';
      return '';
    });
    const hash = createCheckpoint('some_other_tool', {});
    expect(hash).toBe('bbb9999');
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
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some diff\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'aaa1111\n';
      return '';
    });
    createCheckpoint('write_file', { path: 'test.txt' });
    const stats = getCheckpointStats();
    expect(stats.count).toBe(1);
    expect(stats.lastHash).toBe('aaa1111');
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

  it('should return false when not in a git repo and no checkpoint exists', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(revertToLastCheckpoint()).toBe(false);
  });

  it('should return true after successfully reverting', () => {
    // Set up mock to create a checkpoint first
    mockExecFileSync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo\n';
      if (args[0] === 'status') return 'M file.txt\n';
      if (args[0] === 'add') return '';
      if (args[0] === 'diff') return 'some diff\n';
      if (args[0] === 'commit') return '';
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc1234\n';
      if (args[0] === 'reset') return '';
      return '';
    });
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
      if (args[0] === 'reset') { resetCalls.push([opts.cwd, ...args]); return ''; }
      return '';
    });
    createCheckpoint('write_file', { path: 'test.txt' });
    expect(revertToLastCheckpoint()).toBe(true);
    // The hard reset must run in the captured root, pinned to the checkpoint repo.
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
      if (args[0] === 'reset') throw new Error('should not reset on mismatch');
      return '';
    });
    createCheckpoint('write_file', { path: 'test.txt' });
    // Simulate the cwd moving to a different repo before the revert.
    toplevel = '/repo-b\n';
    expect(revertToLastCheckpoint()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCheckpointStats
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
    const stats = getCheckpointStats();
    expect(stats.enabled).toBe(false);
  });

  it('should reflect enabled state after setEnabled(true)', () => {
    setEnabled(false);
    setEnabled(true);
    const stats = getCheckpointStats();
    expect(stats.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGitRepo re-evaluation (must not memoize across cwd changes)
// ---------------------------------------------------------------------------

describe('isGitRepo re-evaluation', () => {
  it('should re-evaluate git-repo status on each call (no stale memoization)', () => {
    // First call: not a git repo.
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('not a git repo'); });
    expect(shouldCheckpoint('write_file', { path: 'test.txt' })).toBe(false);

    // After a cwd change the dir IS a git repo: the prior "false" must not stick.
    mockExecFileSync.mockReturnValue('true\n');
    expect(shouldCheckpoint('write_file', { path: 'test.txt' })).toBe(true);

    // And the reverse: a dir that stops being a repo must flip back to false.
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(shouldCheckpoint('write_file', { path: 'test.txt' })).toBe(false);
  });
});
