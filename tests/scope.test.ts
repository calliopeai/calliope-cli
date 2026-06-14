import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  scopeManager,
  addToScope,
  removeFromScope,
  isInScope,
  validatePath,
  getScopeSummary,
  getScopeDetails,
  resetScope,
  getAllowedDirs,
} from '../src/scope.js';

describe('Scope Manager', () => {
  beforeEach(() => {
    // Reset to cwd before each test
    resetScope(process.cwd());
  });

  describe('addToScope', () => {
    it('should add valid directories', () => {
      const result = addToScope('/tmp');
      expect(result.success).toBe(true);
      expect(getAllowedDirs()).toContain('/tmp');
    });

    it('should reject non-existent directories', () => {
      const result = addToScope('/nonexistent/path/xyz123');
      expect(result.success).toBe(false);
      expect(result.message).toContain('does not exist');
    });

    it('should reject duplicate directories', () => {
      addToScope('/tmp');
      const result = addToScope('/tmp');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Already in scope');
    });

    it('should reject a file path (not a directory)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-test-'));
      const tmpFile = path.join(tmpDir, 'testfile.txt');
      fs.writeFileSync(tmpFile, 'content');
      try {
        const result = addToScope(tmpFile);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Not a directory');
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it('should reject directory already covered by parent', () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-parent-'));
      const childDir = path.join(tmpBase, 'child');
      fs.mkdirSync(childDir, { recursive: true });
      try {
        const result1 = addToScope(tmpBase);
        expect(result1.success).toBe(true);
        // Adding child should fail since parent covers it
        const result2 = addToScope(childDir);
        expect(result2.success).toBe(false);
        expect(result2.message).toContain('Already covered by');
      } finally {
        fs.rmSync(tmpBase, { recursive: true });
      }
    });
  });

  describe('removeFromScope', () => {
    it('should remove directories', () => {
      addToScope('/tmp');
      const result = removeFromScope('/tmp');
      expect(result.success).toBe(true);
      expect(getAllowedDirs()).not.toContain('/tmp');
    });

    it('should not allow removing last directory', () => {
      resetScope('/tmp');
      const result = removeFromScope('/tmp');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Cannot remove last');
    });

    it('should reject non-scoped directories', () => {
      const result = removeFromScope('/some/random/path');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Not in scope');
    });
  });

  describe('isInScope', () => {
    it('should allow paths in cwd', () => {
      const cwd = process.cwd();
      expect(isInScope(path.join(cwd, 'src', 'test.ts'), cwd)).toBe(true);
    });

    it('should allow paths in added directories', () => {
      addToScope('/tmp');
      expect(isInScope('/tmp/test.txt')).toBe(true);
    });

    it('should deny paths outside scope', () => {
      resetScope('/tmp');
      expect(isInScope('/etc/passwd')).toBe(false);
    });

    it('should handle relative paths', () => {
      const cwd = process.cwd();
      expect(isInScope('./src/test.ts', cwd)).toBe(true);
    });

    it('should NOT allow paths in /tmp by default (allowTmp=false, #139)', () => {
      resetScope('/only-this-dir');
      const result = scopeManager.isInScope('/tmp/test.txt');
      expect(result.allowed).toBe(false);
    });

    it('should include suggestedAction when path is outside scope', () => {
      resetScope('/tmp/project-xyz');
      const result = scopeManager.isInScope('/etc/hosts', '/tmp/project-xyz');
      expect(result.allowed).toBe(false);
      expect(result.suggestedAction).toBeDefined();
      expect(result.suggestedAction).toContain('add-dir');
    });

    it('should match path exactly equal to allowed dir', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(cwd, cwd);
      expect(result.allowed).toBe(true);
    });

    it('should handle path resolution without baseCwd arg', () => {
      const result = scopeManager.isInScope('./some-relative-path');
      expect(typeof result.allowed).toBe('boolean');
    });
  });

  describe('validatePath', () => {
    it('should return absolute path for valid paths', () => {
      const cwd = process.cwd();
      const result = validatePath('src/test.ts', cwd);
      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toContain('src');
    });

    it('should throw for paths outside scope', () => {
      resetScope('/tmp');
      expect(() => validatePath('/etc/passwd', '/tmp')).toThrow('Access denied');
    });

    it('should throw with suggestedAction appended for out-of-scope paths', () => {
      resetScope('/tmp/isolated-scope');
      try {
        validatePath('/etc/hosts', '/tmp/isolated-scope');
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as Error;
        expect(err.message).toContain('Access denied');
        expect(err.message).toContain('add-dir');
      }
    });

    it('should throw for denied patterns without suggestedAction', () => {
      const cwd = process.cwd();
      try {
        validatePath(path.join(cwd, '.env'), cwd);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as Error;
        expect(err.message).toContain('Access denied');
      }
    });
  });

  describe('denied patterns', () => {
    it('should deny .env files', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, '.env'), cwd);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied pattern');
    });

    it('should deny private keys', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, 'server.key'), cwd);
      expect(result.allowed).toBe(false);
    });

    it('should deny .env.local files', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, '.env.local'), cwd);
      expect(result.allowed).toBe(false);
    });

    it('should match wildcard pattern .env.*', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, '.env.test'), cwd);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('denied pattern');
    });

    it('should match exact pattern credentials', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, 'credentials'), cwd);
      expect(result.allowed).toBe(false);
    });

    it('should match wildcard pattern credentials.*', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, 'credentials.json'), cwd);
      expect(result.allowed).toBe(false);
    });

    it('should match wildcard pattern *.secret', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, 'myapp.secret'), cwd);
      expect(result.allowed).toBe(false);
    });

    it('should match wildcard pattern secrets.*', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, 'secrets.yaml'), cwd);
      expect(result.allowed).toBe(false);
    });

    it('should allow files that do not match any denied pattern', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, 'readme.md'), cwd);
      expect(result.allowed).toBe(true);
    });
  });

  describe('getScopeSummary', () => {
    it('should return formatted summary', () => {
      const summary = getScopeSummary();
      expect(summary).toContain('Current Scope');
      expect(summary).toContain(process.cwd());
    });

    it('should show (cwd) annotation for current working directory', () => {
      const summary = getScopeSummary();
      expect(summary).toContain('(cwd)');
    });

    it('should show denied patterns count', () => {
      const summary = getScopeSummary();
      expect(summary).toContain('Denied patterns:');
      expect(summary).toContain('blocked');
    });
  });

  describe('getScopeDetails', () => {
    it('should return detailed scope configuration', () => {
      const details = getScopeDetails();
      expect(details).toContain('Scope Configuration');
      expect(details).toContain('Allowed Directories');
      expect(details).toContain('Settings');
      expect(details).toContain('Denied Patterns');
    });

    it('should show allow home and tmp settings', () => {
      const details = getScopeDetails();
      expect(details).toContain('Allow home');
      expect(details).toContain('Allow /tmp');
    });

    it('should show more when denied patterns exceed 10', () => {
      // Default has more than 10 denied patterns
      const details = getScopeDetails();
      expect(details).toContain('and');
      expect(details).toContain('more');
    });
  });

  describe('resetScope', () => {
    it('should reset to cwd only', () => {
      addToScope('/tmp');
      resetScope(process.cwd());
      const dirs = getAllowedDirs();
      expect(dirs.length).toBe(1);
      expect(dirs[0]).toBe(path.resolve(process.cwd()));
    });

    it('should fully reset state including custom settings (#39)', () => {
      addToScope('/tmp');
      const dirsBefore = getAllowedDirs();
      expect(dirsBefore.length).toBe(2);

      resetScope('/tmp');
      const dirsAfter = getAllowedDirs();
      expect(dirsAfter.length).toBe(1);
      expect(dirsAfter[0]).toBe('/tmp');
    });

    it('should reset using process.cwd() when no arg given', () => {
      addToScope('/tmp');
      resetScope();
      const dirs = getAllowedDirs();
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toBe(path.resolve(process.cwd()));
    });
  });

  describe('security: path traversal', () => {
    it('should deny path traversal via ..', () => {
      resetScope('/tmp/project');
      const result = scopeManager.isInScope('/tmp/project/../../etc/passwd', '/tmp/project');
      expect(result.allowed).toBe(false);
    });

    it('should deny absolute paths outside scope', () => {
      resetScope('/tmp/project');
      expect(isInScope('/etc/shadow', '/tmp/project')).toBe(false);
    });

    it('should deny sensitive system files', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, 'id_rsa'), cwd);
      expect(result.allowed).toBe(false);
    });

    it('should deny .pem files', () => {
      const cwd = process.cwd();
      const result = scopeManager.isInScope(path.join(cwd, 'cert.pem'), cwd);
      expect(result.allowed).toBe(false);
    });
  });
});

// ============================================================================
// ToolResult type (#25)
// ============================================================================

describe('ToolResult type', () => {
  it('should support displayResult field', async () => {
    const { ToolResult } = await import('../src/types.js') as { ToolResult: never };
    // Type-level test: ensure displayResult is accepted
    const result: import('../src/types.js').ToolResult = {
      toolCallId: 'test',
      result: 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11',
      displayResult: 'line1\nline2\nline3\nline4\nline5\n... (6 more lines)',
    };
    expect(result.displayResult).toContain('more lines');
    expect(result.result.split('\n').length).toBe(11);
    expect(result.displayResult!.split('\n').length).toBeLessThan(result.result.split('\n').length);
  });
});
