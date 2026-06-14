import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We need to mock the registry path so tests don't touch the real ~/.calliope-cli/
let tmpDir: string;
let projectDir: string;

// Mock os.homedir() to point at our temp dir so getRegistryPath() uses it
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

// Import after mock setup
const {
  checkTrust,
  trustProject,
  untrustProject,
  removeFromRegistry,
  listTrustedProjects,
  validateProjectConfig,
  autoTrustIfNew,
} = await import('../src/trust.js');

describe('Trust Registry', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-trust-test-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-project-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ============================================================================
  // trustProject + checkTrust round-trip
  // ============================================================================

  describe('trustProject and checkTrust round-trip', () => {
    it('should mark a project as trusted and verify with checkTrust', () => {
      trustProject(projectDir, 'test trust');
      const result = checkTrust(projectDir);
      expect(result.trusted).toBe(true);
      expect(result.reason).toContain('trusted');
    });

    it('should return untrusted for unknown projects', () => {
      const result = checkTrust('/nonexistent/project');
      expect(result.trusted).toBe(false);
      expect(result.reason).toContain('not in trust registry');
    });

    it('should store the note when provided', () => {
      trustProject(projectDir, 'my note');
      const projects = listTrustedProjects();
      const entry = projects.find(p => p.path === path.resolve(projectDir));
      expect(entry?.entry.note).toBe('my note');
    });

    it('should hash CALLIOPE.md when it exists', () => {
      fs.writeFileSync(path.join(projectDir, 'CALLIOPE.md'), '# Test Project');
      trustProject(projectDir);
      const projects = listTrustedProjects();
      const entry = projects.find(p => p.path === path.resolve(projectDir));
      expect(entry?.entry.hash).toBeDefined();
      expect(entry?.entry.hash).toHaveLength(16);
    });
  });

  // ============================================================================
  // untrustProject
  // ============================================================================

  describe('untrustProject', () => {
    it('should mark a previously trusted project as untrusted', () => {
      trustProject(projectDir);
      expect(checkTrust(projectDir).trusted).toBe(true);

      untrustProject(projectDir);
      const result = checkTrust(projectDir);
      expect(result.trusted).toBe(false);
      expect(result.reason).toContain('untrusted');
    });

    it('should mark an unknown project as explicitly untrusted', () => {
      untrustProject(projectDir);
      const result = checkTrust(projectDir);
      expect(result.trusted).toBe(false);
      expect(result.reason).toContain('explicitly untrusted');
    });
  });

  // ============================================================================
  // removeFromRegistry
  // ============================================================================

  describe('removeFromRegistry', () => {
    it('should completely remove a project entry', () => {
      trustProject(projectDir);
      expect(listTrustedProjects()).toHaveLength(1);

      removeFromRegistry(projectDir);
      expect(listTrustedProjects()).toHaveLength(0);

      const result = checkTrust(projectDir);
      expect(result.trusted).toBe(false);
      expect(result.reason).toContain('not in trust registry');
    });
  });

  // ============================================================================
  // listTrustedProjects
  // ============================================================================

  describe('listTrustedProjects', () => {
    it('should return empty array for fresh registry', () => {
      expect(listTrustedProjects()).toEqual([]);
    });

    it('should list all trusted and untrusted entries', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-proj2-'));
      try {
        trustProject(projectDir);
        untrustProject(dir2);
        const projects = listTrustedProjects();
        expect(projects).toHaveLength(2);
        const paths = projects.map(p => p.path);
        expect(paths).toContain(path.resolve(projectDir));
        expect(paths).toContain(path.resolve(dir2));
      } finally {
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });
  });

  // ============================================================================
  // autoTrustIfNew
  // ============================================================================

  describe('autoTrustIfNew (#135 - no silent trust)', () => {
    afterEach(() => {
      delete process.env.CALLIOPE_AUTO_TRUST;
    });

    it('should NOT auto-trust an unknown project by default', () => {
      const result = autoTrustIfNew(projectDir);
      expect(result).toBe(false);
      // Deny-by-default: unknown directory stays untrusted.
      expect(checkTrust(projectDir).trusted).toBe(false);
    });

    it('should only auto-trust with an explicit opt-in flag', () => {
      const result = autoTrustIfNew(projectDir, { optIn: true });
      expect(result).toBe(true);
      expect(checkTrust(projectDir).trusted).toBe(true);
    });

    it('should auto-trust when CALLIOPE_AUTO_TRUST env is enabled', () => {
      process.env.CALLIOPE_AUTO_TRUST = '1';
      const result = autoTrustIfNew(projectDir);
      expect(result).toBe(true);
      expect(checkTrust(projectDir).trusted).toBe(true);
    });

    it('should not overwrite an existing registry entry even with opt-in', () => {
      untrustProject(projectDir);
      const result = autoTrustIfNew(projectDir, { optIn: true });
      expect(result).toBe(false);
      expect(checkTrust(projectDir).trusted).toBe(false);
    });

    it('should not overwrite an existing trusted entry with opt-in', () => {
      trustProject(projectDir, 'original');
      const result = autoTrustIfNew(projectDir, { optIn: true });
      expect(result).toBe(false);
      const entry = listTrustedProjects().find(p => p.path === path.resolve(projectDir));
      expect(entry?.entry.note).toBe('original');
    });
  });

  // ============================================================================
  // validateProjectConfig
  // ============================================================================

  describe('validateProjectConfig', () => {
    it('should return no violations for safe config', () => {
      const violations = validateProjectConfig({ model: 'claude-3', theme: 'dark' });
      expect(violations).toEqual([]);
    });

    it('should catch confirmMode override', () => {
      const violations = validateProjectConfig({ confirmMode: false });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('confirmMode');
      expect(violations[0]).toContain('security-locked');
    });

    it('should catch circuitBreakersEnabled override', () => {
      const violations = validateProjectConfig({ circuitBreakersEnabled: false });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('circuitBreakersEnabled');
    });

    it('should catch skipPermissions override', () => {
      const violations = validateProjectConfig({ skipPermissions: true });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('skipPermissions');
    });

    it('should report multiple violations at once', () => {
      const violations = validateProjectConfig({
        confirmMode: false,
        circuitBreakersEnabled: false,
        skipPermissions: true,
      });
      expect(violations).toHaveLength(3);
    });
  });

  // ============================================================================
  // CALLIOPE.md change detection
  // ============================================================================

  describe('CALLIOPE.md change detection', () => {
    it('should detect when CALLIOPE.md has changed since trust was granted', () => {
      fs.writeFileSync(path.join(projectDir, 'CALLIOPE.md'), 'original content');
      trustProject(projectDir);

      // Modify CALLIOPE.md after trusting
      fs.writeFileSync(path.join(projectDir, 'CALLIOPE.md'), 'modified content');

      const result = checkTrust(projectDir);
      expect(result.trusted).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.reason).toContain('changed');
    });

    it('should not flag changed when CALLIOPE.md is unchanged', () => {
      fs.writeFileSync(path.join(projectDir, 'CALLIOPE.md'), 'stable content');
      trustProject(projectDir);

      const result = checkTrust(projectDir);
      expect(result.trusted).toBe(true);
      expect(result.changed).toBeUndefined();
    });

    it('should not flag changed when there was no CALLIOPE.md at trust time', () => {
      trustProject(projectDir);
      // Create CALLIOPE.md after trust (no hash was stored)
      fs.writeFileSync(path.join(projectDir, 'CALLIOPE.md'), 'new content');

      const result = checkTrust(projectDir);
      expect(result.trusted).toBe(true);
      // No hash stored, so no change detection possible
      expect(result.changed).toBeUndefined();
    });
  });
});
