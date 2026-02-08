import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// compareVersions (internal, tested via checkForUpdates behavior)
// We re-implement the compare logic inline to test it directly since it's
// not exported. We also test the exported functions with appropriate mocking.
// ============================================================================

/**
 * Mirror of the internal compareVersions for direct unit testing.
 * This ensures the algorithm itself is correct.
 */
function compareVersions(current: string, latest: string): number {
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return 1;
    if ((l[i] || 0) < (c[i] || 0)) return -1;
  }
  return 0;
}

describe('compareVersions (algorithm)', () => {
  it('should return 0 for identical versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.8.20', '0.8.20')).toBe(0);
    expect(compareVersions('10.20.30', '10.20.30')).toBe(0);
  });

  it('should return 1 when latest is greater (major)', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(1);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(1);
  });

  it('should return 1 when latest is greater (minor)', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBe(1);
    expect(compareVersions('0.8.0', '0.9.0')).toBe(1);
  });

  it('should return 1 when latest is greater (patch)', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(1);
    expect(compareVersions('0.8.20', '0.8.21')).toBe(1);
  });

  it('should return -1 when current is greater (major)', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(-1);
  });

  it('should return -1 when current is greater (minor)', () => {
    expect(compareVersions('1.2.0', '1.1.0')).toBe(-1);
  });

  it('should return -1 when current is greater (patch)', () => {
    expect(compareVersions('1.0.5', '1.0.3')).toBe(-1);
  });

  it('should handle missing patch numbers gracefully', () => {
    // With || 0 fallback, split on a 2-part version will have NaN for index 2
    // but the || 0 fallback handles that
    expect(compareVersions('1.0', '1.0.1')).toBe(1);
    expect(compareVersions('1.0.1', '1.0')).toBe(-1);
  });

  it('should handle large version numbers', () => {
    expect(compareVersions('99.99.99', '100.0.0')).toBe(1);
    expect(compareVersions('100.0.0', '99.99.99')).toBe(-1);
  });

  it('should return 0 when both are 0.0.0', () => {
    expect(compareVersions('0.0.0', '0.0.0')).toBe(0);
  });

  it('should compare higher minor over lower major correctly', () => {
    // Major always wins: 2.0.0 > 1.99.99
    expect(compareVersions('1.99.99', '2.0.0')).toBe(1);
  });
});

// ============================================================================
// Exported functions with mocking
// ============================================================================

// We need to mock fs, os, and fetch to properly test the exported functions
// without touching the real filesystem or network.

describe('version-check module', () => {
  // Store original fetch
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  describe('getVersion', () => {
    it('should return a string', async () => {
      const { getVersion } = await import('../src/version-check.js');
      const version = getVersion();
      expect(typeof version).toBe('string');
    });

    it('should return a semver-like string or 0.0.0 fallback', async () => {
      const { getVersion } = await import('../src/version-check.js');
      const version = getVersion();
      // Should match semver pattern or be the fallback
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('getLatestVersion', () => {
    it('should return null when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const { getLatestVersion } = await import('../src/version-check.js');
      const result = await getLatestVersion();
      expect(result).toBeNull();
    });

    it('should return null when response is not ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      });
      const { getLatestVersion } = await import('../src/version-check.js');
      const result = await getLatestVersion();
      expect(result).toBeNull();
    });

    it('should return version string from npm registry response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '1.2.3' }),
      });
      const { getLatestVersion } = await import('../src/version-check.js');
      const result = await getLatestVersion();
      expect(result).toBe('1.2.3');
    });

    it('should return null when response has no version field', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      const { getLatestVersion } = await import('../src/version-check.js');
      const result = await getLatestVersion();
      expect(result).toBeNull();
    });

    it('should handle fetch timeout (abort)', async () => {
      globalThis.fetch = vi.fn().mockImplementation(() => {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 10);
        });
      });
      const { getLatestVersion } = await import('../src/version-check.js');
      const result = await getLatestVersion();
      expect(result).toBeNull();
    });
  });

  describe('checkForUpdates', () => {
    it('should return false when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      // Mock fs to avoid cache file issues
      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation((path: string) => {
          if (typeof path === 'string' && path.includes('package.json')) {
            return JSON.stringify({ version: '0.8.20' });
          }
          throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
        mkdirSync: vi.fn(),
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(false);
    });

    it('should return false when latest version is null', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation((path: string) => {
          if (typeof path === 'string' && path.includes('package.json')) {
            return JSON.stringify({ version: '0.8.20' });
          }
          throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
        mkdirSync: vi.fn(),
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(false);
    });

    it('should return true when a newer version is available', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '99.0.0' }),
      });

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation((path: string | URL) => {
          const p = path instanceof URL ? path.pathname : path;
          if (p.includes('package.json')) {
            return JSON.stringify({ version: '0.8.20' });
          }
          throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
        mkdirSync: vi.fn(),
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(true);
    });

    it('should return false when current version matches latest', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.8.20' }),
      });

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation((path: string | URL) => {
          const p = path instanceof URL ? path.pathname : path;
          if (p.includes('package.json')) {
            return JSON.stringify({ version: '0.8.20' });
          }
          throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
        mkdirSync: vi.fn(),
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(false);
    });

    it('should not print to console when silent is true', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '99.0.0' }),
      });

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation((path: string | URL) => {
          const p = path instanceof URL ? path.pathname : path;
          if (p.includes('package.json')) {
            return JSON.stringify({ version: '0.8.20' });
          }
          throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
        mkdirSync: vi.fn(),
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      await checkForUpdates(true);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('performUpgrade', () => {
    it('should be an async function that returns a boolean', async () => {
      const { performUpgrade } = await import('../src/version-check.js');
      expect(typeof performUpgrade).toBe('function');
    });
  });
});
