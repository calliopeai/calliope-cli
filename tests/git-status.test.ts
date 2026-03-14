/**
 * Tests for src/git-status.ts
 *
 * Covers: getGitBranch, getGitStatus, caching behavior.
 * Uses live git for real-repo tests, temp dirs for non-git scenarios.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getGitBranch, getGitStatus, type GitStatusInfo } from '../src/git-status.js';

describe('git-status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========================================================================
  // getGitBranch
  // ========================================================================

  describe('getGitBranch', () => {
    // CI uses detached HEAD, so branch is null
    it.skipIf(!!process.env.CI)('returns current branch name in a real git repo', () => {
      // Invalidate cache by calling with a unique temp dir first
      const td = mkdtempSync(join(tmpdir(), 'git-invalidate-'));
      getGitStatus(td);
      rmSync(td, { recursive: true, force: true });

      const branch = getGitBranch(process.cwd());
      expect(branch).toBeTruthy();
      expect(typeof branch).toBe('string');
      expect(branch).toBe('main');
    });

    it('returns null for a non-git directory', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'git-status-test-'));
      try {
        const branch = getGitBranch(tempDir);
        expect(branch).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // ========================================================================
  // getGitStatus
  // ========================================================================

  describe('getGitStatus', () => {
    // CI uses detached HEAD, so branch is null not string
    it.skipIf(!!process.env.CI)('returns branch, dirty, ahead, behind for a real git repo', () => {
      // Invalidate cache by switching cwd
      const td = mkdtempSync(join(tmpdir(), 'git-invalidate-'));
      getGitStatus(td);
      rmSync(td, { recursive: true, force: true });

      const status = getGitStatus(process.cwd());

      expect(status).toHaveProperty('branch');
      expect(status).toHaveProperty('dirty');
      expect(status).toHaveProperty('ahead');
      expect(status).toHaveProperty('behind');

      expect(typeof status.branch).toBe('string');
      expect(typeof status.dirty).toBe('boolean');
      expect(typeof status.ahead).toBe('number');
      expect(typeof status.behind).toBe('number');

      expect(status.ahead).toBeGreaterThanOrEqual(0);
      expect(status.behind).toBeGreaterThanOrEqual(0);
    });

    it('returns defaults for a non-git directory', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'git-status-test-'));
      try {
        const status = getGitStatus(tempDir);
        expect(status.branch).toBeNull();
        expect(status.dirty).toBe(false);
        expect(status.ahead).toBe(0);
        expect(status.behind).toBe(0);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it.skipIf(!!process.env.CI)('returns the correct branch name', () => {
      // Invalidate cache
      const td = mkdtempSync(join(tmpdir(), 'git-invalidate-'));
      getGitStatus(td);
      rmSync(td, { recursive: true, force: true });

      const status = getGitStatus(process.cwd());
      expect(status.branch).toBe('main');
    });
  });

  // ========================================================================
  // Caching
  // ========================================================================

  describe('caching', () => {
    it('repeated calls within 5s use cached result (same object reference)', () => {
      // Invalidate any previous cache by switching cwd
      const td = mkdtempSync(join(tmpdir(), 'git-invalidate-'));
      getGitStatus(td);
      rmSync(td, { recursive: true, force: true });

      const first = getGitStatus(process.cwd());
      const second = getGitStatus(process.cwd());

      // Same reference means cache was used
      expect(second).toBe(first);
    });

    it('cache is invalidated after 5 seconds', () => {
      // Invalidate any previous cache
      const td = mkdtempSync(join(tmpdir(), 'git-invalidate-'));
      getGitStatus(td);
      rmSync(td, { recursive: true, force: true });

      // Use fake timers to control Date.now()
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const first = getGitStatus(process.cwd());

      // Advance time past the 5s TTL
      vi.advanceTimersByTime(5001);

      const second = getGitStatus(process.cwd());

      vi.useRealTimers();

      // After TTL, a new object should be created
      expect(second).not.toBe(first);
      // But values should still be equivalent
      expect(second.branch).toBe(first.branch);
    });

    it('cache is invalidated when cwd changes', () => {
      // Invalidate any previous cache
      const td = mkdtempSync(join(tmpdir(), 'git-invalidate-'));
      getGitStatus(td);
      rmSync(td, { recursive: true, force: true });

      const first = getGitStatus(process.cwd());

      const tempDir = mkdtempSync(join(tmpdir(), 'git-status-test-'));
      try {
        const second = getGitStatus(tempDir);

        // Different cwd should produce a fresh result
        expect(second).not.toBe(first);
        // Non-git dir should have null branch
        expect(second.branch).toBeNull();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('returns cached result when called within TTL with same cwd', () => {
      // Invalidate any previous cache
      const td = mkdtempSync(join(tmpdir(), 'git-invalidate-'));
      getGitStatus(td);
      rmSync(td, { recursive: true, force: true });

      vi.useFakeTimers({ shouldAdvanceTime: true });

      const first = getGitStatus(process.cwd());

      // Advance only 2 seconds -- still within TTL
      vi.advanceTimersByTime(2000);

      const second = getGitStatus(process.cwd());

      vi.useRealTimers();

      expect(second).toBe(first);
    });
  });

  // ========================================================================
  // GitStatusInfo type
  // ========================================================================

  describe('GitStatusInfo interface', () => {
    it('matches the expected shape', () => {
      // Invalidate cache
      const td = mkdtempSync(join(tmpdir(), 'git-invalidate-'));
      getGitStatus(td);
      rmSync(td, { recursive: true, force: true });

      const status: GitStatusInfo = getGitStatus(process.cwd());
      expect(status).toBeDefined();
      expect(status.branch === null || typeof status.branch === 'string').toBe(true);
      expect(typeof status.dirty).toBe('boolean');
      expect(typeof status.ahead).toBe('number');
      expect(typeof status.behind).toBe('number');
    });
  });
});
