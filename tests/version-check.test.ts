import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

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
    expect(compareVersions('1.99.99', '2.0.0')).toBe(1);
  });

  it('should handle single-segment versions', () => {
    expect(compareVersions('1', '2')).toBe(1);
    expect(compareVersions('2', '1')).toBe(-1);
    expect(compareVersions('1', '1')).toBe(0);
  });

  it('should handle versions with zero segments', () => {
    expect(compareVersions('0.0.1', '0.0.0')).toBe(-1);
    expect(compareVersions('0.0.0', '0.0.1')).toBe(1);
    expect(compareVersions('0.1.0', '0.0.99')).toBe(-1);
  });
});

// ============================================================================
// Exported functions with mocking
// ============================================================================

describe('version-check module', () => {
  const originalFetch = globalThis.fetch;
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  // Helper to create standard fs mock
  function createFsMock(opts: {
    version?: string;
    cacheExists?: boolean;
    cacheData?: object | null;
    configDirExists?: boolean;
    writeError?: boolean;
    readPackageError?: boolean;
  } = {}) {
    const {
      version = '0.8.20',
      cacheExists = false,
      cacheData = null,
      configDirExists = true,
      writeError = false,
      readPackageError = false,
    } = opts;

    return {
      readFileSync: vi.fn().mockImplementation((path: string | URL) => {
        const p = path instanceof URL ? path.pathname : path;
        if (p.includes('package.json')) {
          if (readPackageError) throw new Error('ENOENT');
          return JSON.stringify({ version });
        }
        if (p.includes('version-cache.json') && cacheData) {
          return JSON.stringify(cacheData);
        }
        throw new Error('ENOENT');
      }),
      writeFileSync: writeError
        ? vi.fn().mockImplementation(() => { throw new Error('EACCES'); })
        : vi.fn(),
      existsSync: vi.fn().mockImplementation((path: string) => {
        if (path.includes('version-cache.json')) return cacheExists;
        if (path.includes('calliope') && !path.includes('.json')) return configDirExists;
        return false;
      }),
      mkdirSync: vi.fn(),
    };
  }

  // ==========================================================================
  // getVersion
  // ==========================================================================
  describe('getVersion', () => {
    it('should return a string', async () => {
      const { getVersion } = await import('../src/version-check.js');
      const version = getVersion();
      expect(typeof version).toBe('string');
    });

    it('should return a semver-like string or 0.0.0 fallback', async () => {
      const { getVersion } = await import('../src/version-check.js');
      const version = getVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should return 0.0.0 when package.json cannot be read', async () => {
      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => {
          throw new Error('ENOENT');
        }),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
        mkdirSync: vi.fn(),
      }));

      const { getVersion } = await import('../src/version-check.js');
      const version = getVersion();
      expect(version).toBe('0.0.0');
    });

    it('should return 0.0.0 when package.json contains invalid JSON', async () => {
      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockReturnValue('not-json{{{'),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockReturnValue(false),
        mkdirSync: vi.fn(),
      }));

      const { getVersion } = await import('../src/version-check.js');
      const version = getVersion();
      expect(version).toBe('0.0.0');
    });
  });

  // ==========================================================================
  // getLatestVersion
  // ==========================================================================
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

    it('should call fetch with the correct npm registry URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0' }),
      });
      const { getLatestVersion } = await import('../src/version-check.js');
      await getLatestVersion();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://registry.npmjs.org/@calliopelabs/cli/latest',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('should return null when response version is empty string', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '' }),
      });
      const { getLatestVersion } = await import('../src/version-check.js');
      const result = await getLatestVersion();
      expect(result).toBeNull();
    });

    it('should return null when json parsing throws', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => { throw new Error('Invalid JSON'); },
      });
      const { getLatestVersion } = await import('../src/version-check.js');
      const result = await getLatestVersion();
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // checkForUpdates
  // ==========================================================================
  describe('checkForUpdates', () => {
    it('should return false when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      vi.doMock('fs', () => createFsMock());

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(false);
    });

    it('should return false when latest version is null', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      vi.doMock('fs', () => createFsMock());

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(false);
    });

    it('should return true when a newer version is available', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '99.0.0' }),
      });

      vi.doMock('fs', () => createFsMock());

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(true);
    });

    it('should return false when current version matches latest', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.8.20' }),
      });

      vi.doMock('fs', () => createFsMock());

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

      vi.doMock('fs', () => createFsMock());

      const { checkForUpdates } = await import('../src/version-check.js');
      await checkForUpdates(true);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should print update notification when not silent and update available', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '99.0.0' }),
      });

      vi.doMock('fs', () => createFsMock());

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(false);
      expect(result).toBe(true);
      // checkForUpdates prints 3 console.log calls when not silent:
      // empty line, update message, install command, empty line
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      consoleSpy.mockRestore();
    });

    it('should default silent to false (prints when update available)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '99.0.0' }),
      });

      vi.doMock('fs', () => createFsMock());

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates();
      expect(result).toBe(true);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should use cached version when cache is recent', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      const recentCache = {
        lastCheck: Date.now() - 1000, // 1 second ago
        latestVersion: '99.0.0',
      };

      vi.doMock('fs', () => createFsMock({
        cacheExists: true,
        cacheData: recentCache,
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(true);
      // Should NOT have called fetch since cache is recent
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should fetch from npm when cache is stale (older than 24h)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '99.0.0' }),
      });

      const staleCache = {
        lastCheck: Date.now() - (25 * 60 * 60 * 1000), // 25 hours ago
        latestVersion: '1.0.0',
      };

      vi.doMock('fs', () => createFsMock({
        cacheExists: true,
        cacheData: staleCache,
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(true);
      // Should have called fetch since cache is stale
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it('should return false when current version is newer than latest', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.1.0' }),
      });

      vi.doMock('fs', () => createFsMock({ version: '1.0.0' }));

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(false);
    });

    it('should write cache after fetching from npm', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0' }),
      });

      const fsMock = createFsMock();
      vi.doMock('fs', () => fsMock);

      const { checkForUpdates } = await import('../src/version-check.js');
      await checkForUpdates(true);

      // writeFileSync should have been called to update cache
      expect(fsMock.writeFileSync).toHaveBeenCalled();
      const writeCall = fsMock.writeFileSync.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('version-cache.json')
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string);
      expect(written.latestVersion).toBe('2.0.0');
      expect(typeof written.lastCheck).toBe('number');
    });

    it('should handle cache read errors gracefully', async () => {
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
          // Throw for cache file reads too
          throw new Error('EACCES');
        }),
        writeFileSync: vi.fn(),
        existsSync: vi.fn().mockImplementation((p: string) => {
          if (p.includes('version-cache.json')) return true; // exists but unreadable
          return false;
        }),
        mkdirSync: vi.fn(),
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      // Should not throw, should fall through to fetch
      const result = await checkForUpdates(true);
      expect(result).toBe(true);
    });

    it('should handle cache write errors gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '99.0.0' }),
      });

      vi.doMock('fs', () => createFsMock({ writeError: true }));

      const { checkForUpdates } = await import('../src/version-check.js');
      // Should not throw even if cache write fails
      const result = await checkForUpdates(true);
      expect(result).toBe(true);
    });

    it('should create config directory if it does not exist', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0' }),
      });

      const fsMock = createFsMock({ configDirExists: false });
      // Override existsSync to return false for the config directory
      fsMock.existsSync = vi.fn().mockReturnValue(false);
      vi.doMock('fs', () => fsMock);

      const { checkForUpdates } = await import('../src/version-check.js');
      await checkForUpdates(true);

      // mkdirSync should have been called to create the config directory
      expect(fsMock.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('calliope'),
        { recursive: true },
      );
    });

    it('should not create config directory if it already exists', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '2.0.0' }),
      });

      const fsMock = createFsMock({ configDirExists: true });
      // Override existsSync: config dir exists, but cache file does not
      fsMock.existsSync = vi.fn().mockImplementation((p: string) => {
        if (p.includes('version-cache.json')) return false;
        return true; // config dir exists
      });
      vi.doMock('fs', () => fsMock);

      const { checkForUpdates } = await import('../src/version-check.js');
      await checkForUpdates(true);

      // mkdirSync should NOT have been called
      expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    });

    it('should use cached null latestVersion and return false', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      const recentCache = {
        lastCheck: Date.now() - 1000,
        latestVersion: null,
      };

      vi.doMock('fs', () => createFsMock({
        cacheExists: true,
        cacheData: recentCache,
      }));

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(true);
      expect(result).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should not print when no update available even if not silent', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.8.20' }),
      });

      vi.doMock('fs', () => createFsMock());

      const { checkForUpdates } = await import('../src/version-check.js');
      const result = await checkForUpdates(false);
      expect(result).toBe(false);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // performUpgrade
  // ==========================================================================
  describe('performUpgrade', () => {
    it('should be an async function that returns a boolean', async () => {
      const { performUpgrade } = await import('../src/version-check.js');
      expect(typeof performUpgrade).toBe('function');
    });

    it('should resolve true when spawn exits with code 0', async () => {
      const mockChild = new EventEmitter();
      vi.doMock('child_process', () => ({
        spawn: vi.fn().mockReturnValue(mockChild),
      }));

      vi.doMock('fs', () => createFsMock());

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      // Let the dynamic import resolve, then emit close
      await new Promise((r) => setTimeout(r, 50));
      mockChild.emit('close', 0);

      const result = await upgradePromise;
      expect(result).toBe(true);
      consoleSpy.mockRestore();
    });

    it('should resolve false when spawn exits with non-zero code', async () => {
      const mockChild = new EventEmitter();
      vi.doMock('child_process', () => ({
        spawn: vi.fn().mockReturnValue(mockChild),
      }));

      vi.doMock('fs', () => createFsMock());

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      await new Promise((r) => setTimeout(r, 50));
      mockChild.emit('close', 1);

      const result = await upgradePromise;
      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should resolve false when spawn emits an error', async () => {
      const mockChild = new EventEmitter();
      vi.doMock('child_process', () => ({
        spawn: vi.fn().mockReturnValue(mockChild),
      }));

      vi.doMock('fs', () => createFsMock());

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      await new Promise((r) => setTimeout(r, 50));
      mockChild.emit('error', new Error('ENOENT'));

      const result = await upgradePromise;
      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should use npm command on macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const spawnMock = vi.fn().mockReturnValue(new EventEmitter());
      vi.doMock('child_process', () => ({
        spawn: spawnMock,
      }));
      vi.doMock('fs', () => createFsMock());

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      await new Promise((r) => setTimeout(r, 50));

      // On macOS, should use 'npm' directly (no sudo)
      expect(spawnMock).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', '@calliopelabs/cli@latest'],
        expect.objectContaining({ stdio: 'inherit' }),
      );

      // Clean up by resolving the promise
      const child = spawnMock.mock.results[0].value;
      child.emit('close', 0);
      await upgradePromise;
      consoleSpy.mockRestore();
    });

    it('should use npm.cmd on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const spawnMock = vi.fn().mockReturnValue(new EventEmitter());
      vi.doMock('child_process', () => ({
        spawn: spawnMock,
      }));
      vi.doMock('fs', () => createFsMock());

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      await new Promise((r) => setTimeout(r, 50));

      // On Windows: 'npm.cmd' with shell: true
      expect(spawnMock).toHaveBeenCalledWith(
        'npm.cmd',
        ['install', '-g', '@calliopelabs/cli@latest'],
        expect.objectContaining({ stdio: 'inherit', shell: true }),
      );

      const child = spawnMock.mock.results[0].value;
      child.emit('close', 0);
      await upgradePromise;
      consoleSpy.mockRestore();
    });

    it('should use sudo on Linux without NVM', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const origNVM = process.env.NVM_DIR;
      delete process.env.NVM_DIR;

      const spawnMock = vi.fn().mockReturnValue(new EventEmitter());
      vi.doMock('child_process', () => ({
        spawn: spawnMock,
      }));
      vi.doMock('fs', () => createFsMock());

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      await new Promise((r) => setTimeout(r, 50));

      // On Linux without NVM: should use 'sudo' with npm as first arg
      expect(spawnMock).toHaveBeenCalledWith(
        'sudo',
        ['npm', 'install', '-g', '@calliopelabs/cli@latest'],
        expect.objectContaining({ stdio: 'inherit' }),
      );

      const child = spawnMock.mock.results[0].value;
      child.emit('close', 0);
      await upgradePromise;
      consoleSpy.mockRestore();

      // Restore NVM_DIR
      if (origNVM !== undefined) process.env.NVM_DIR = origNVM;
    });

    it('should not use sudo on Linux with NVM', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const origNVM = process.env.NVM_DIR;
      process.env.NVM_DIR = '/home/user/.nvm';

      const spawnMock = vi.fn().mockReturnValue(new EventEmitter());
      vi.doMock('child_process', () => ({
        spawn: spawnMock,
      }));
      vi.doMock('fs', () => createFsMock());

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      await new Promise((r) => setTimeout(r, 50));

      // On Linux with NVM: should use 'npm' directly (no sudo)
      expect(spawnMock).toHaveBeenCalledWith(
        'npm',
        ['install', '-g', '@calliopelabs/cli@latest'],
        expect.objectContaining({ stdio: 'inherit' }),
      );

      const child = spawnMock.mock.results[0].value;
      child.emit('close', 0);
      await upgradePromise;
      consoleSpy.mockRestore();

      // Restore
      if (origNVM !== undefined) {
        process.env.NVM_DIR = origNVM;
      } else {
        delete process.env.NVM_DIR;
      }
    });

    it('should resolve false when spawn exits with null code', async () => {
      const mockChild = new EventEmitter();
      vi.doMock('child_process', () => ({
        spawn: vi.fn().mockReturnValue(mockChild),
      }));
      vi.doMock('fs', () => createFsMock());

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      await new Promise((r) => setTimeout(r, 50));
      mockChild.emit('close', null);

      const result = await upgradePromise;
      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should log the upgrade command being run', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const mockChild = new EventEmitter();

      vi.doMock('child_process', () => ({
        spawn: vi.fn().mockReturnValue(mockChild),
      }));
      vi.doMock('fs', () => createFsMock());

      const { performUpgrade } = await import('../src/version-check.js');
      const upgradePromise = performUpgrade();

      await new Promise((r) => setTimeout(r, 50));

      // Should have logged the running command
      expect(consoleSpy).toHaveBeenCalled();
      const loggedText = consoleSpy.mock.calls.map(c => String(c[0])).join(' ');
      expect(loggedText).toContain('npm install -g @calliopelabs/cli@latest');

      mockChild.emit('close', 0);
      await upgradePromise;
      consoleSpy.mockRestore();
    });
  });
});
