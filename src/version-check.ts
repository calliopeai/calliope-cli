/**
 * Version check utility
 *
 * Checks npm for newer versions and notifies the user.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { colors as c } from './styles.js';

const PACKAGE_NAME = '@calliopelabs/cli';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface VersionCache {
  lastCheck: number;
  latestVersion: string | null;
}

function getCachePath(): string {
  const configDir = join(homedir(), '.config', 'calliope');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  return join(configDir, 'version-cache.json');
}

function readCache(): VersionCache | null {
  try {
    const cachePath = getCachePath();
    if (existsSync(cachePath)) {
      return JSON.parse(readFileSync(cachePath, 'utf-8'));
    }
  } catch {
    // Ignore cache read errors
  }
  return null;
}

function writeCache(cache: VersionCache): void {
  try {
    writeFileSync(getCachePath(), JSON.stringify(cache));
  } catch {
    // Ignore cache write errors
  }
}

function getCurrentVersion(): string {
  // Compiled single-binary builds (issue #187) bake the version in at bundle
  // time via a Bun `define`, because the binary cannot read package.json from
  // its virtual filesystem ($bunfs) — the file is not on disk next to the
  // executable. For the normal `node dist/bin.js` build this identifier is
  // never defined, so `globalThis.__CALLIOPE_BINARY_VERSION__` is `undefined`
  // and we fall through to reading package.json exactly as before.
  const injected = (globalThis as { __CALLIOPE_BINARY_VERSION__?: string }).__CALLIOPE_BINARY_VERSION__;
  if (typeof injected === 'string' && injected.length > 0) {
    return injected;
  }
  try {
    // Try to read from package.json in dist directory
    const packagePath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { signal: controller.signal }
    );

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as { version?: string };
    return data.version || null;
  } catch {
    return null;
  }
}

function compareVersions(current: string, latest: string): number {
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return 1;
    if ((l[i] || 0) < (c[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Check for updates and print notification if available
 * Returns true if there's an update available
 */
export async function checkForUpdates(silent = false): Promise<boolean> {
  const currentVersion = getCurrentVersion();
  const cache = readCache();
  const now = Date.now();

  let latestVersion: string | null = null;

  // Use cached version if recent enough
  if (cache && (now - cache.lastCheck) < CHECK_INTERVAL_MS) {
    latestVersion = cache.latestVersion;
  } else {
    // Fetch from npm (don't block startup - run async)
    latestVersion = await fetchLatestVersion();
    writeCache({ lastCheck: now, latestVersion });
  }

  if (!latestVersion) return false;

  const hasUpdate = compareVersions(currentVersion, latestVersion) > 0;

  if (hasUpdate && !silent) {
    console.log();
    console.log(`${c.yellow}${c.bold}  Update available!${c.reset} ${c.dim}${currentVersion}${c.reset} → ${c.green}${latestVersion}${c.reset}`);
    console.log(`${c.dim}  Run ${c.cyan}npm install -g ${PACKAGE_NAME}${c.reset}${c.dim} to update${c.reset}`);
    console.log();
  }

  return hasUpdate;
}

/**
 * Get current version string
 */
export function getVersion(): string {
  return getCurrentVersion();
}

/**
 * Get latest version from npm (bypasses cache)
 */
export async function getLatestVersion(): Promise<string | null> {
  return fetchLatestVersion();
}

/**
 * Perform upgrade via npm
 * Returns true if upgrade was successful
 */
export async function performUpgrade(): Promise<boolean> {
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';

    // Determine if we need sudo (Linux with system node)
    const needsSudo = process.platform !== 'darwin' &&
                      process.platform !== 'win32' &&
                      !process.env.NVM_DIR;

    const args = ['install', '-g', '@calliopelabs/cli@latest'];
    const cmd = needsSudo ? 'sudo' : npmCmd;
    const finalArgs = needsSudo ? [npmCmd, ...args] : args;

    console.log(`${c.dim}Running: ${needsSudo ? 'sudo ' : ''}npm install -g @calliopelabs/cli@latest${c.reset}`);
    console.log();

    const child = spawn(cmd, finalArgs, {
      stdio: 'inherit',
      shell: isWindows,
    });

    child.on('close', (code) => {
      resolve(code === 0);
    });

    child.on('error', () => {
      resolve(false);
    });
  });
}
