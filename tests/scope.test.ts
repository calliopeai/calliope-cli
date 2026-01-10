import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import {
  scopeManager,
  addToScope,
  removeFromScope,
  isInScope,
  validatePath,
  getScopeSummary,
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
  });

  describe('getScopeSummary', () => {
    it('should return formatted summary', () => {
      const summary = getScopeSummary();
      expect(summary).toContain('Current Scope');
      expect(summary).toContain(process.cwd());
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
  });
});
