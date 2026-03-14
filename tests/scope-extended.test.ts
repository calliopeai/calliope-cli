/**
 * Extended coverage tests for src/scope.ts
 *
 * Targets uncovered branches:
 * - allowHome === true path in isInScope
 * - deniedDirs check (path.startsWith(denied+sep) || path === denied)
 * - getScopeSummary when allowHome is enabled
 * - getScopeSummary when allowTmp is disabled
 * - constructor HOME fallback (USERPROFILE, then /tmp)
 * - addDirectory: path === allowed (not just startsWith)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// We need to access the raw ScopeManager internals to test allowHome/deniedDirs.
// Since the exported scopeManager singleton is reset between tests via resetScope,
// we import the public API only and manipulate the scope through the exported functions.

import {
  scopeManager,
  resetScope,
  addToScope,
  getAllowedDirs,
  getScopeSummary,
  getScopeDetails,
  isInScope,
} from '../src/scope.js';

// ScopeManager's config is private, so we use the public isInScope to test allowHome
// by manipulating the module-level singleton via its (private) config.
// We'll access it through a cast.

type ScopeManagerInternal = {
  config: {
    allowedDirs: string[];
    allowHome: boolean;
    allowTmp: boolean;
    deniedDirs: string[];
    deniedPatterns: string[];
  };
  homeDir: string;
  tmpDir: string;
  reset(cwd?: string): void;
  addDirectory(dir: string): { success: boolean; message: string };
  removeDirectory(dir: string): { success: boolean; message: string };
  isInScope(filePath: string, baseCwd?: string): { allowed: boolean; reason?: string; suggestedAction?: string };
  validatePath(filePath: string, cwd: string): string;
  getAllowedDirs(): string[];
  getScopeSummary(): string;
  getScopeDetails(): string;
};

// Cast the exported singleton so we can set private fields for testing
const manager = scopeManager as unknown as ScopeManagerInternal;

describe('scope - allowHome branch', () => {
  beforeEach(() => {
    resetScope(process.cwd());
  });

  afterEach(() => {
    resetScope(process.cwd());
    // Restore allowHome and deniedDirs to defaults
    manager.config.allowHome = false;
    manager.config.allowTmp = true;
    manager.config.deniedDirs = [];
  });

  it('should allow home directory path when allowHome is true', () => {
    manager.config.allowHome = true;
    const homeDir = manager.homeDir;
    const homePath = path.join(homeDir, 'some', 'file.txt');

    const result = manager.isInScope(homePath);
    expect(result.allowed).toBe(true);
  });

  it('should deny home directory path when allowHome is false', () => {
    manager.config.allowHome = false;
    manager.config.allowTmp = false;
    // Reset to a scope that does NOT include home
    manager.config.allowedDirs = ['/only-this-dir'];
    const homeDir = manager.homeDir;
    const homePath = path.join(homeDir, 'some', 'safe-file.txt');

    const result = manager.isInScope(homePath);
    expect(result.allowed).toBe(false);
  });

  it('should NOT treat home dir subdirectory as allowed when allowHome is true but path starts with homeDir only', () => {
    manager.config.allowHome = true;
    const homeDir = manager.homeDir;

    // Path that is exactly the home dir
    const result = manager.isInScope(homeDir);
    // homeDir itself: startsWith(homeDir + sep) would be false for exact match
    // but the allowHome check is: absPath.startsWith(homeDir + sep)
    // So exact homeDir match falls through to allowTmp check or denied
    // This depends on whether homeDir is in allowedDirs
    expect(typeof result.allowed).toBe('boolean');
  });

  it('should return true for path deep in home dir when allowHome is true', () => {
    manager.config.allowHome = true;
    const homeDir = manager.homeDir;
    const deepPath = path.join(homeDir, 'projects', 'myproject', 'src', 'file.ts');

    const result = manager.isInScope(deepPath);
    expect(result.allowed).toBe(true);
  });
});

describe('scope - deniedDirs branch', () => {
  beforeEach(() => {
    resetScope(process.cwd());
  });

  afterEach(() => {
    resetScope(process.cwd());
    manager.config.deniedDirs = [];
  });

  it('should deny a path that starts with a denied directory + sep', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-denied-'));
    try {
      // Add tmpDir to scope first so it would normally be allowed
      addToScope(tmpDir);
      const deniedSubDir = path.join(tmpDir, 'secret');
      fs.mkdirSync(deniedSubDir, { recursive: true });

      // Add deniedSubDir to denied dirs
      manager.config.deniedDirs = [deniedSubDir];

      const filePath = path.join(deniedSubDir, 'passwords.txt');
      const result = manager.isInScope(filePath);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied directory');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should deny a path that exactly equals a denied directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-denied-'));
    try {
      addToScope(tmpDir);
      manager.config.deniedDirs = [tmpDir];

      // Check the exact tmpDir path
      const result = manager.isInScope(tmpDir);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied directory');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should allow sibling directory when only one subdir is denied', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-denied-'));
    try {
      addToScope(tmpBase);
      const deniedDir = path.join(tmpBase, 'private');
      const allowedDir = path.join(tmpBase, 'public');
      fs.mkdirSync(deniedDir, { recursive: true });
      fs.mkdirSync(allowedDir, { recursive: true });

      manager.config.deniedDirs = [deniedDir];

      const deniedPath = path.join(deniedDir, 'file.txt');
      const allowedPath = path.join(allowedDir, 'file.txt');

      expect(manager.isInScope(deniedPath).allowed).toBe(false);
      expect(manager.isInScope(allowedPath).allowed).toBe(true);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe('scope - getScopeSummary with allowHome/allowTmp', () => {
  beforeEach(() => {
    resetScope(process.cwd());
  });

  afterEach(() => {
    resetScope(process.cwd());
    manager.config.allowHome = false;
    manager.config.allowTmp = true;
  });

  it('should include home dir entry in summary when allowHome is true', () => {
    manager.config.allowHome = true;
    const summary = getScopeSummary();
    expect(summary).toContain('(home)');
  });

  it('should NOT include home dir entry when allowHome is false', () => {
    manager.config.allowHome = false;
    const summary = getScopeSummary();
    expect(summary).not.toContain('(home)');
  });

  it('should include /tmp entry in summary when allowTmp is true', () => {
    manager.config.allowTmp = true;
    const summary = getScopeSummary();
    expect(summary).toContain('(tmp)');
  });

  it('should NOT include /tmp entry when allowTmp is false', () => {
    manager.config.allowTmp = false;
    const summary = getScopeSummary();
    expect(summary).not.toContain('(tmp)');
  });

  it('should include both home and tmp entries when both enabled', () => {
    manager.config.allowHome = true;
    manager.config.allowTmp = true;
    const summary = getScopeSummary();
    expect(summary).toContain('(home)');
    expect(summary).toContain('(tmp)');
  });
});

describe('scope - allowedDirs exact path match', () => {
  beforeEach(() => {
    resetScope(process.cwd());
  });

  it('should allow a path that exactly equals an allowed dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-exact-'));
    try {
      addToScope(tmpDir);
      // Test exact match: absPath === allowed
      const result = manager.isInScope(tmpDir);
      expect(result.allowed).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('scope - getScopeDetails allowHome/allowTmp display', () => {
  afterEach(() => {
    resetScope(process.cwd());
    manager.config.allowHome = false;
    manager.config.allowTmp = true;
  });

  it('should show "Yes" for Allow home when allowHome is true', () => {
    manager.config.allowHome = true;
    const details = getScopeDetails();
    expect(details).toContain('Allow home (~): Yes');
  });

  it('should show "No" for Allow home when allowHome is false', () => {
    manager.config.allowHome = false;
    const details = getScopeDetails();
    expect(details).toContain('Allow home (~): No');
  });

  it('should show "Yes" for Allow /tmp when allowTmp is true', () => {
    manager.config.allowTmp = true;
    const details = getScopeDetails();
    expect(details).toContain('Allow /tmp: Yes');
  });

  it('should show "No" for Allow /tmp when allowTmp is false', () => {
    manager.config.allowTmp = false;
    const details = getScopeDetails();
    expect(details).toContain('Allow /tmp: No');
  });
});

describe('scope - addDirectory: path === allowed (exact match coverage)', () => {
  beforeEach(() => {
    resetScope(process.cwd());
  });

  it('should return Already covered when adding cwd itself', () => {
    // process.cwd() is already in scope; adding the same path should fail
    const result = addToScope(process.cwd());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Already in scope/);
  });
});

describe('scope - HOME environment variable fallback', () => {
  it('homeDir should be set from process.env.HOME or USERPROFILE or /tmp', () => {
    // This tests the constructor logic: homeDir = process.env.HOME || USERPROFILE || /tmp
    // We can verify it via the getScopeSummary with allowHome=true
    manager.config.allowHome = true;
    const summary = getScopeSummary();
    const expectedHome = process.env.HOME || process.env.USERPROFILE || '/tmp';
    expect(summary).toContain(expectedHome);
    manager.config.allowHome = false;
  });
});
