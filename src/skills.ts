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

export interface Skill {
  id: string;
  path: string;
  metadata: SkillMetadata;
  instructions?: string;
  loaded: boolean;
  source: 'local' | 'registry' | 'github';
  sourceUrl?: string;
}

export interface SkillReference {
  type: 'script' | 'reference' | 'asset';
  name: string;
  path: string;
  content?: string;
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
function loadSkillsIndex(): Record<string, { path: string; source: string; sourceUrl?: string }> {
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
function saveSkillsIndex(index: Record<string, { path: string; source: string; sourceUrl?: string }>): void {
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
    const skill = loadSkillFromDir(info.path);
    if (skill) {
      skill.source = info.source as 'local' | 'registry' | 'github';
      skill.sourceUrl = info.sourceUrl;
      skills.push(skill);
    }
  }

  return skills;
}

/**
 * Get skill by name
 */
export function getSkill(name: string): Skill | null {
  const index = loadSkillsIndex();
  const info = index[name];
  if (!info) return null;

  const skill = loadSkillFromDir(info.path);
  if (skill) {
    skill.source = info.source as 'local' | 'registry' | 'github';
    skill.sourceUrl = info.sourceUrl;
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

  ensureSkillsDir();
  const destDir = path.join(SKILLS_DIR, skill.id);

  // Copy skill directory
  copyDir(dir, destDir);

  // Update index
  const index = loadSkillsIndex();
  index[skill.id] = { path: destDir, source: 'local' };
  saveSkillsIndex(index);

  skill.path = destDir;
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

  ensureSkillsDir();
  const destDir = path.join(SKILLS_DIR, parsed.metadata.name);

  // Create skill directory
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Write SKILL.md
  fs.writeFileSync(path.join(destDir, 'SKILL.md'), content);

  // Update index
  const index = loadSkillsIndex();
  index[parsed.metadata.name] = { path: destDir, source: 'github', sourceUrl: url };
  saveSkillsIndex(index);

  return {
    id: parsed.metadata.name,
    path: destDir,
    metadata: parsed.metadata,
    instructions: parsed.instructions,
    loaded: true,
    source: 'github',
    sourceUrl: url,
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
      ensureSkillsDir();
      const destDir = path.join(SKILLS_DIR, skillName);

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      fs.writeFileSync(path.join(destDir, 'SKILL.md'), info.content);

      const parsed = parseSkillFile(info.content);
      if (!parsed) {
        throw new Error('Invalid skill content');
      }

      const index = loadSkillsIndex();
      index[skillName] = { path: destDir, source: 'registry', sourceUrl: registryUrl };
      saveSkillsIndex(index);

      return {
        id: skillName,
        path: destDir,
        metadata: parsed.metadata,
        instructions: parsed.instructions,
        loaded: true,
        source: 'registry',
        sourceUrl: registryUrl,
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
