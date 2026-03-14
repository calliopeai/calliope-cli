/**
 * Tests for git output parsing in src/git-status.ts
 *
 * Uses vi.mock('child_process') to test all branch-parsing code paths
 * without needing a real git repository.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ===========================================================================
// Mock child_process to test git output parsing branches
// ===========================================================================

const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (cmd: string, opts: unknown) => mockExecSync(cmd, opts),
}));

let resetMod: typeof import('../src/git-status.js');

describe('git-status output parsing (mocked execSync)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockExecSync.mockReset();
    resetMod = await import('../src/git-status.js');
  });

  it('should parse branch with "..." format', () => {
    mockExecSync.mockReturnValue('## main...origin/main\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBe('main');
  });

  it('should parse branch with [ahead/behind] but no "..."', () => {
    mockExecSync.mockReturnValue('## main [ahead 2]\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBe('main');
    expect(status.ahead).toBe(2);
  });

  it('should parse branch with no "..." and no brackets (just branch name)', () => {
    mockExecSync.mockReturnValue('## feature-branch\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBe('feature-branch');
  });

  it('should parse ahead and behind counts', () => {
    mockExecSync.mockReturnValue('## main...origin/main [ahead 3, behind 2]\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBe('main');
    expect(status.ahead).toBe(3);
    expect(status.behind).toBe(2);
  });

  it('should parse only ahead count', () => {
    mockExecSync.mockReturnValue('## main...origin/main [ahead 5]\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.ahead).toBe(5);
    expect(status.behind).toBe(0);
  });

  it('should parse only behind count', () => {
    mockExecSync.mockReturnValue('## main...origin/main [behind 1]\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(1);
  });

  it('should detect dirty working tree', () => {
    mockExecSync.mockReturnValue('## main...origin/main\n M src/file.ts\n?? newfile.ts\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.dirty).toBe(true);
  });

  it('should detect clean working tree', () => {
    mockExecSync.mockReturnValue('## main...origin/main\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.dirty).toBe(false);
  });

  it('should handle detached HEAD (HEAD (no branch))', () => {
    mockExecSync.mockReturnValue('## HEAD (no branch)\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBeNull();
  });

  it('should handle "No commits yet on" branch (with branch name appended)', () => {
    mockExecSync.mockReturnValue('## No commits yet on main\n');
    const status = resetMod.getGitStatus('/fake');
    // "No commits yet on main" — has "..." index = -1, bracket = -1, so branchName = full string
    // It does NOT match exactly "No commits yet on" so branch stays as string
    expect(typeof status.branch).toBe('string');
  });

  it('should handle exactly "No commits yet on" (triggers null)', () => {
    // If the branch line is exactly "No commits yet on" with no trailing text
    // the dotIndex is -1, bracketIndex is -1, so result.branch = "No commits yet on"
    // which equals the null-trigger value
    mockExecSync.mockReturnValue('## No commits yet on\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBeNull();
  });

  it('should handle non-## first line (output without branch header)', () => {
    mockExecSync.mockReturnValue(' M modified.ts\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBeNull();
  });

  it('should handle execSync throwing (not in git repo)', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBeNull();
    expect(status.dirty).toBe(false);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it('should use cache when called twice with same cwd', () => {
    mockExecSync.mockReturnValue('## main\n');
    const first = resetMod.getGitStatus('/same');
    const second = resetMod.getGitStatus('/same');
    expect(second).toBe(first);  // Same reference = cached
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it('should not cache when cwd is different', () => {
    mockExecSync.mockReturnValue('## main\n');
    resetMod.getGitStatus('/path-a');
    mockExecSync.mockReturnValue('## feature\n');
    const second = resetMod.getGitStatus('/path-b');
    expect(second.branch).toBe('feature');
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it('should return branch name with slashes (feature/my-thing)', () => {
    mockExecSync.mockReturnValue('## feature/my-thing...origin/feature/my-thing\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.branch).toBe('feature/my-thing');
  });

  it('should return null ahead/behind when no bracket info', () => {
    mockExecSync.mockReturnValue('## main...origin/main\n');
    const status = resetMod.getGitStatus('/fake');
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it('should handle empty output string', () => {
    mockExecSync.mockReturnValue('');
    const status = resetMod.getGitStatus('/fake');
    // empty string split gives [''] which doesn't start with '## '
    expect(status.branch).toBeNull();
    expect(status.dirty).toBe(false);
  });
});
