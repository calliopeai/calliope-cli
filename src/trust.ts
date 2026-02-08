/**
 * Calliope CLI - Project Trust Registry (#23)
 *
 * Manages trust levels for project directories.
 * Untrusted projects skip project-level context files (CALLIOPE.md, .calliope, etc.)
 * to prevent prompt injection from malicious project configs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ============================================================================
// Types
// ============================================================================

export interface TrustEntry {
  trusted: boolean;
  hash?: string;           // SHA-256 of CALLIOPE.md at time of trust decision
  addedAt: string;         // ISO timestamp
  note?: string;           // Optional user note
}

export type TrustRegistry = Record<string, TrustEntry>;

// Settings that project configs should NEVER be able to override
const SECURITY_LOCKED_SETTINGS = [
  'confirmMode',
  'circuitBreakersEnabled',
  'skipPermissions',
];

// ============================================================================
// Registry Storage
// ============================================================================

function getRegistryPath(): string {
  const configDir = path.join(os.homedir(), '.calliope-cli');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'trusted-projects.json');
}

function loadRegistry(): TrustRegistry {
  const registryPath = getRegistryPath();
  try {
    if (fs.existsSync(registryPath)) {
      return JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    }
  } catch {
    // Corrupted registry - start fresh
  }
  return {};
}

function saveRegistry(registry: TrustRegistry): void {
  const registryPath = getRegistryPath();
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

// ============================================================================
// Hash Helpers
// ============================================================================

function hashFile(filePath: string): string | undefined {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
  } catch { /* ignore */ }
  return undefined;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a project directory is trusted.
 * Returns { trusted, reason } where reason explains the decision.
 */
export function checkTrust(projectDir: string): { trusted: boolean; reason: string; changed?: boolean } {
  const absDir = path.resolve(projectDir);
  const registry = loadRegistry();
  const entry = registry[absDir];

  if (!entry) {
    return { trusted: false, reason: 'Project not in trust registry. Use /trust to add.' };
  }

  if (!entry.trusted) {
    return { trusted: false, reason: 'Project explicitly untrusted.' };
  }

  // Check if CALLIOPE.md has changed since trust was granted
  const calliopeMd = path.join(absDir, 'CALLIOPE.md');
  if (entry.hash) {
    const currentHash = hashFile(calliopeMd);
    if (currentHash && currentHash !== entry.hash) {
      return { trusted: true, reason: 'Trusted (CALLIOPE.md has changed since trust was granted)', changed: true };
    }
  }

  return { trusted: true, reason: 'Project is trusted.' };
}

/**
 * Trust a project directory.
 */
export function trustProject(projectDir: string, note?: string): void {
  const absDir = path.resolve(projectDir);
  const registry = loadRegistry();
  const calliopeMd = path.join(absDir, 'CALLIOPE.md');

  registry[absDir] = {
    trusted: true,
    hash: hashFile(calliopeMd),
    addedAt: new Date().toISOString(),
    note,
  };

  saveRegistry(registry);
}

/**
 * Untrust a project directory.
 */
export function untrustProject(projectDir: string): void {
  const absDir = path.resolve(projectDir);
  const registry = loadRegistry();

  registry[absDir] = {
    trusted: false,
    addedAt: new Date().toISOString(),
  };

  saveRegistry(registry);
}

/**
 * Remove a project from the trust registry entirely.
 */
export function removeFromRegistry(projectDir: string): void {
  const absDir = path.resolve(projectDir);
  const registry = loadRegistry();
  delete registry[absDir];
  saveRegistry(registry);
}

/**
 * List all trusted/untrusted projects.
 */
export function listTrustedProjects(): Array<{ path: string; entry: TrustEntry }> {
  const registry = loadRegistry();
  return Object.entries(registry).map(([p, entry]) => ({ path: p, entry }));
}

/**
 * Validate that project-level config doesn't override security-locked settings.
 * Returns list of violations.
 */
export function validateProjectConfig(projectConfig: Record<string, unknown>): string[] {
  const violations: string[] = [];
  for (const key of SECURITY_LOCKED_SETTINGS) {
    if (key in projectConfig) {
      violations.push(`Project config cannot override "${key}" (security-locked setting)`);
    }
  }
  return violations;
}

/**
 * Auto-trust the current working directory (for first-run convenience).
 * Only trusts if no registry entry exists yet.
 */
export function autoTrustIfNew(projectDir: string): boolean {
  const absDir = path.resolve(projectDir);
  const registry = loadRegistry();
  if (!(absDir in registry)) {
    // Auto-trust current directory on first run
    trustProject(projectDir);
    return true;
  }
  return false;
}
