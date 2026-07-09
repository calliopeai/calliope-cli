/**
 * Calliope CLI - AgentSkills.io Integration
 *
 * Implements AgentSkills standard for extending agent capabilities.
 * See: https://agentskills.io/specification
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as crypto from 'crypto';
import { auditIntegrityViolation } from './runlog.js';

// Skills storage directory
const SKILLS_DIR = path.join(os.homedir(), '.calliope-cli', 'skills');

// ============================================================================
// Types
// ============================================================================

export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  [key: string]: string | string[] | Record<string, string> | undefined;
}

/**
 * Trust state of an installed skill relative to the sha256 pinned at install (#137).
 *  - `pinned`     — on-disk SKILL.md matches the recorded hash.
 *  - `changed`    — hash recorded but the file no longer matches (tampered/edited).
 *  - `unverified` — no hash recorded (legacy entry installed before pinning).
 */
export type SkillTrust = 'pinned' | 'changed' | 'unverified';

export interface Skill {
  id: string;
  path: string;
  metadata: SkillMetadata;
  instructions?: string;
  loaded: boolean;
  source: 'local' | 'registry' | 'github';
  sourceUrl?: string;
  /** Short sha256 fingerprint pinned at install time, e.g. `sha256:1a2b3c4d5e6f` (#137). */
  fingerprint?: string;
  /** Trust state relative to the pinned hash (#137). */
  trust?: SkillTrust;
}

/** A skill's install-registry entry (~/.calliope-cli/skills/index.json). */
interface SkillIndexEntry {
  path: string;
  source: string;
  sourceUrl?: string;
  /** Full sha256 of SKILL.md recorded at install for trust-on-first-use (#137). */
  hash?: string;
}

/** Trust state + pinned fingerprint for an installed skill, for listing surfaces (#137). */
export interface SkillListing {
  name: string;
  description: string;
  source: 'local' | 'registry' | 'github';
  sourceUrl?: string;
  trust: SkillTrust;
  fingerprint?: string;
}

export interface SkillReference {
  type: 'script' | 'reference' | 'asset';
  name: string;
  path: string;
  content?: string;
}

/**
 * Confirmation request shown to the user before a network skill is installed (#137).
 */
export interface SkillInstallConfirmation {
  name: string;
  source: 'registry' | 'github';
  sourceUrl: string;
  description: string;
  /**
   * `first-install` for a name not yet in the registry; `content-changed` when
   * re-installing over an existing pin whose hash differs — an explicit update
   * that must be re-confirmed rather than silently re-pinned (#137).
   */
  reason: 'first-install' | 'content-changed';
  /** Short fingerprint of the incoming content (#137). */
  fingerprint: string;
  /** Previous pinned fingerprint, present only when reason is `content-changed` (#137). */
  previousFingerprint?: string;
}

// ============================================================================
// Security: name validation, path containment, trust gate (#136, #137)
// ============================================================================

/**
 * Reject skill names that could escape SKILLS_DIR via path traversal (#136).
 * Mirrors the plugin loader guard in plugins.ts.
 */
export function assertSafeSkillName(name: string): void {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

/**
 * Resolve a skill destination directory and confirm it stays inside SKILLS_DIR.
 * Defense-in-depth on top of assertSafeSkillName (#136).
 */
function resolveSkillDir(name: string): string {
  assertSafeSkillName(name);
  const destDir = path.join(SKILLS_DIR, name);
  const root = path.resolve(SKILLS_DIR);
  const resolved = path.resolve(destDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return destDir;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Short, human-comparable fingerprint of a full sha256 hex digest (#137). */
function fingerprint(hash: string): string {
  return `sha256:${hash.slice(0, 12)}`;
}

/** sha256 of a skill directory's SKILL.md, or undefined if unreadable (#137). */
function hashSkillFile(skillDir: string): string | undefined {
  try {
    return hashContent(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Shared reason string for a load-time integrity refusal (#137). */
const MISMATCH_REASON =
  'SKILL.md content changed since install — refusing to load (re-install to re-trust)';

// Optional confirmation handler for network installs (#137). When unset,
// installs proceed (backward-compatible). Wire an interactive prompt to gate.
let installConfirmHandler: ((info: SkillInstallConfirmation) => boolean | Promise<boolean>) | null = null;

/**
 * Register a confirmation handler invoked before installing a network skill (#137).
 * Returning false aborts the install. Pass null to clear.
 */
export function setSkillInstallConfirmHandler(
  handler: ((info: SkillInstallConfirmation) => boolean | Promise<boolean>) | null
): void {
  installConfirmHandler = handler;
}

async function confirmInstall(info: SkillInstallConfirmation): Promise<void> {
  if (!installConfirmHandler) return;
  const ok = await installConfirmHandler(info);
  if (!ok) {
    throw new Error(`Skill install declined: ${info.name}`);
  }
}

// ============================================================================
// Storage
// ============================================================================

function ensureSkillsDir(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

function getSkillsIndexFile(): string {
  return path.join(SKILLS_DIR, 'index.json');
}

/**
 * Load skills index
 */
function loadSkillsIndex(): Record<string, SkillIndexEntry> {
  const file = getSkillsIndexFile();
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save skills index
 */
function saveSkillsIndex(index: Record<string, SkillIndexEntry>): void {
  ensureSkillsDir();
  fs.writeFileSync(getSkillsIndexFile(), JSON.stringify(index, null, 2));
}

// ============================================================================
// SKILL.md Parsing
// ============================================================================

/**
 * Parse SKILL.md file
 */
function parseSkillFile(content: string): { metadata: SkillMetadata; instructions: string } | null {
  // Check for YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return null;
  }

  const [, frontmatter, instructions] = frontmatterMatch;

  // Simple YAML parsing (for the basic fields we need)
  const metadata: SkillMetadata = {
    name: '',
    description: '',
  };

  const lines = frontmatter.split('\n');
  let currentKey = '';
  let inMultiline = false;
  let multilineValue = '';

  for (const line of lines) {
    // Simple key: value parsing
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (match && !inMultiline) {
      const [, key, value] = match;
      currentKey = key;

      if (value.startsWith('"') && value.endsWith('"')) {
        metadata[key] = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        metadata[key] = value.slice(1, -1);
      } else if (value === '' || value === '|' || value === '>') {
        inMultiline = true;
        multilineValue = '';
      } else {
        metadata[key] = value;
      }
    } else if (inMultiline && line.startsWith('  ')) {
      multilineValue += (multilineValue ? '\n' : '') + line.trim();
    } else if (inMultiline && !line.startsWith('  ')) {
      metadata[currentKey] = multilineValue;
      inMultiline = false;
      // Re-process this line
      const newMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
      if (newMatch) {
        const [, key, value] = newMatch;
        currentKey = key;
        metadata[key] = value;
      }
    }
  }

  if (inMultiline) {
    metadata[currentKey] = multilineValue;
  }

  // Handle allowed-tools as array
  if (typeof metadata['allowed-tools'] === 'string') {
    metadata.allowedTools = (metadata['allowed-tools'] as string).split(/\s+/);
  }

  if (!metadata.name || !metadata.description) {
    return null;
  }

  return { metadata, instructions: instructions.trim() };
}

// ============================================================================
// Skill Loading
// ============================================================================

/**
 * Load a skill from a directory
 */
export function loadSkillFromDir(dir: string): Skill | null {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    return null;
  }

  const content = fs.readFileSync(skillFile, 'utf-8');
  const parsed = parseSkillFile(content);
  if (!parsed) {
    return null;
  }

  return {
    id: parsed.metadata.name,
    path: dir,
    metadata: parsed.metadata,
    instructions: parsed.instructions,
    loaded: true,
    source: 'local',
  };
}

/**
 * Get all loaded skills
 */
export function getSkills(): Skill[] {
  ensureSkillsDir();
  const index = loadSkillsIndex();
  const skills: Skill[] = [];

  for (const [name, info] of Object.entries(index)) {
    // Drop skills whose SKILL.md no longer matches the hash recorded at install
    // time — do not silently elevate tampered content into the system prompt (#137).
    if (info.hash && !verifySkillHash(info.path, info.hash)) {
      console.warn(`Skill ${name}: SKILL.md hash mismatch — skipping (re-install to trust again)`);
      auditIntegrityViolation(`skill:${name}`, MISMATCH_REASON);
      continue;
    }
    const skill = loadSkillFromDir(info.path);
    if (skill) {
      skill.source = info.source as 'local' | 'registry' | 'github';
      skill.sourceUrl = info.sourceUrl;
      skill.fingerprint = info.hash ? fingerprint(info.hash) : undefined;
      skill.trust = info.hash ? 'pinned' : 'unverified';
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * List every installed skill with its trust state and pinned fingerprint (#137).
 *
 * Unlike getSkills (which returns only load-safe skills for the system prompt),
 * this deliberately includes `changed` entries so the /skills surface can warn
 * the user that content drifted. It does not read instructions or emit audit
 * events — it is a pure inventory read.
 */
export function listSkills(): SkillListing[] {
  ensureSkillsDir();
  const index = loadSkillsIndex();
  const out: SkillListing[] = [];

  for (const [name, info] of Object.entries(index)) {
    let trust: SkillTrust;
    if (!info.hash) {
      trust = 'unverified';
    } else {
      trust = verifySkillHash(info.path, info.hash) ? 'pinned' : 'changed';
    }
    const skill = loadSkillFromDir(info.path);
    out.push({
      name,
      description: skill?.metadata.description ?? '',
      source: info.source as 'local' | 'registry' | 'github',
      sourceUrl: info.sourceUrl,
      trust,
      fingerprint: info.hash ? fingerprint(info.hash) : undefined,
    });
  }

  return out;
}

/**
 * Re-verify a stored skill's SKILL.md against its recorded hash (TOFU — #137).
 */
function verifySkillHash(skillDir: string, expected: string): boolean {
  try {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    return hashContent(content) === expected;
  } catch {
    return false;
  }
}

/**
 * Get skill by name
 */
export function getSkill(name: string): Skill | null {
  const index = loadSkillsIndex();
  const info = index[name];
  if (!info) return null;

  // Refuse to surface tampered instructions on activation (#137).
  if (info.hash && !verifySkillHash(info.path, info.hash)) {
    console.warn(`Skill ${name}: SKILL.md hash mismatch — refusing to load (re-install to trust again)`);
    auditIntegrityViolation(`skill:${name}`, MISMATCH_REASON);
    return null;
  }

  const skill = loadSkillFromDir(info.path);
  if (skill) {
    skill.source = info.source as 'local' | 'registry' | 'github';
    skill.sourceUrl = info.sourceUrl;
    skill.fingerprint = info.hash ? fingerprint(info.hash) : undefined;
    skill.trust = info.hash ? 'pinned' : 'unverified';
  }
  return skill;
}

/**
 * Get skill references (scripts, references, assets)
 */
export function getSkillReferences(skill: Skill): SkillReference[] {
  const refs: SkillReference[] = [];

  const dirs = ['scripts', 'references', 'assets'];
  for (const dir of dirs) {
    const fullPath = path.join(skill.path, dir);
    if (fs.existsSync(fullPath)) {
      const files = fs.readdirSync(fullPath);
      for (const file of files) {
        refs.push({
          type: dir as 'script' | 'reference' | 'asset',
          name: file,
          path: path.join(fullPath, file),
        });
      }
    }
  }

  return refs;
}

// ============================================================================
// Skill Installation
// ============================================================================

/**
 * Install skill from a local directory
 */
export function installLocalSkill(dir: string): Skill | null {
  const skill = loadSkillFromDir(dir);
  if (!skill) {
    return null;
  }

  // Reject path-traversal names (the name comes from SKILL.md content — #136).
  const destDir = resolveSkillDir(skill.id);

  ensureSkillsDir();

  // Copy skill directory
  copyDir(dir, destDir);

  // Pin the copied SKILL.md so later on-disk tampering is caught on load (#137).
  const hash = hashSkillFile(destDir);

  // Update index
  const index = loadSkillsIndex();
  index[skill.id] = { path: destDir, source: 'local', hash };
  saveSkillsIndex(index);

  skill.path = destDir;
  skill.fingerprint = hash ? fingerprint(hash) : undefined;
  skill.trust = hash ? 'pinned' : 'unverified';
  return skill;
}

/**
 * Install skill from GitHub URL
 */
export async function installFromGithub(url: string): Promise<Skill | null> {
  // Parse GitHub URL: https://github.com/user/repo/tree/branch/path
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)\/(.+))?/);
  if (!match) {
    throw new Error('Invalid GitHub URL');
  }

  const [, owner, repo, branch = 'main', skillPath = ''] = match;

  // Fetch SKILL.md from raw content
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${skillPath}/SKILL.md`.replace(/\/+/g, '/').replace(':/', '://');

  const content = await fetchUrl(rawUrl);
  const parsed = parseSkillFile(content);
  if (!parsed) {
    throw new Error('Invalid SKILL.md');
  }

  // Reject path-traversal names from remote, attacker-controlled content (#136).
  const destDir = resolveSkillDir(parsed.metadata.name);

  // Pin the incoming content. If a differently-hashed pin already exists this is
  // an explicit update, confirmed with the old→new fingerprint diff below — the
  // registry entry is never re-pinned silently (#137).
  const newHash = hashContent(content);
  const index = loadSkillsIndex();
  const existing = index[parsed.metadata.name];
  const changed = !!(existing?.hash && existing.hash !== newHash);

  // Require explicit confirmation before trusting network content (#137).
  await confirmInstall({
    name: parsed.metadata.name,
    source: 'github',
    sourceUrl: url,
    description: parsed.metadata.description,
    reason: changed ? 'content-changed' : 'first-install',
    fingerprint: fingerprint(newHash),
    previousFingerprint: existing?.hash ? fingerprint(existing.hash) : undefined,
  });

  ensureSkillsDir();

  // Create skill directory
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Write SKILL.md
  fs.writeFileSync(path.join(destDir, 'SKILL.md'), content);

  // Update index (record content hash for trust-on-first-use re-verification — #137)
  index[parsed.metadata.name] = { path: destDir, source: 'github', sourceUrl: url, hash: newHash };
  saveSkillsIndex(index);

  return {
    id: parsed.metadata.name,
    path: destDir,
    metadata: parsed.metadata,
    instructions: parsed.instructions,
    loaded: true,
    source: 'github',
    sourceUrl: url,
    fingerprint: fingerprint(newHash),
    trust: 'pinned',
  };
}

/**
 * Install from agentskills.io registry
 */
export async function installFromRegistry(skillName: string): Promise<Skill | null> {
  // Fetch from agentskills.io
  const registryUrl = `https://agentskills.io/api/skills/${skillName}`;

  try {
    const data = await fetchUrl(registryUrl);
    const info = JSON.parse(data);

    if (info.github) {
      return installFromGithub(info.github);
    } else if (info.content) {
      // Reject path-traversal names before any filesystem use (#136).
      const destDir = resolveSkillDir(skillName);

      const parsed = parseSkillFile(info.content);
      if (!parsed) {
        throw new Error('Invalid skill content');
      }

      // Pin the incoming content; a differently-hashed existing pin is an
      // explicit, re-confirmed update rather than a silent re-pin (#137).
      const newHash = hashContent(info.content);
      const index = loadSkillsIndex();
      const existing = index[skillName];
      const changed = !!(existing?.hash && existing.hash !== newHash);

      // Require explicit confirmation before trusting network content (#137).
      await confirmInstall({
        name: skillName,
        source: 'registry',
        sourceUrl: registryUrl,
        description: parsed.metadata.description,
        reason: changed ? 'content-changed' : 'first-install',
        fingerprint: fingerprint(newHash),
        previousFingerprint: existing?.hash ? fingerprint(existing.hash) : undefined,
      });

      ensureSkillsDir();

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      fs.writeFileSync(path.join(destDir, 'SKILL.md'), info.content);

      index[skillName] = { path: destDir, source: 'registry', sourceUrl: registryUrl, hash: newHash };
      saveSkillsIndex(index);

      return {
        id: skillName,
        path: destDir,
        metadata: parsed.metadata,
        instructions: parsed.instructions,
        loaded: true,
        source: 'registry',
        sourceUrl: registryUrl,
        fingerprint: fingerprint(newHash),
        trust: 'pinned',
      };
    }

    throw new Error('Skill not found in registry');
  } catch (e) {
    if (e instanceof Error && e.message.includes('404')) {
      throw new Error(`Skill "${skillName}" not found in registry`);
    }
    throw e;
  }
}

/**
 * Uninstall a skill
 */
export function uninstallSkill(name: string): boolean {
  const index = loadSkillsIndex();
  const info = index[name];
  if (!info) return false;

  // Remove directory
  if (fs.existsSync(info.path)) {
    fs.rmSync(info.path, { recursive: true });
  }

  // Update index
  delete index[name];
  saveSkillsIndex(index);

  return true;
}

// ============================================================================
// Skill Context
// ============================================================================

/**
 * Get skill context for the LLM system prompt
 */
export function getSkillsContext(): string {
  const skills = getSkills();
  if (skills.length === 0) return '';

  let context = '\n\n## Available Skills\n\n';
  context += 'You have access to the following skills:\n\n';

  for (const skill of skills) {
    context += `### ${skill.metadata.name}\n`;
    context += `${skill.metadata.description}\n\n`;
  }

  context += '\nTo use a skill, follow its instructions when relevant to the user\'s request.\n';

  return context;
}

/**
 * Get full skill instructions when activated
 */
export function getSkillInstructions(name: string): string | null {
  const skill = getSkill(name);
  if (!skill || !skill.instructions) return null;
  return skill.instructions;
}

// ============================================================================
// Utilities
// ============================================================================

function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Calliope-CLI/1.0' },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode === 404) {
        reject(new Error('404 Not Found'));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
