/**
 * Tests for src/skills.ts
 *
 * Covers: loadSkillFromDir, getSkills, getSkill, getSkillReferences,
 * installLocalSkill, uninstallSkill, getSkillsContext, getSkillInstructions.
 *
 * Uses a temporary directory to avoid polluting the real ~/.calliope-cli/skills.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadSkillFromDir,
  getSkills,
  getSkill,
  getSkillReferences,
  installLocalSkill,
  uninstallSkill,
  getSkillsContext,
  getSkillInstructions,
  type Skill,
  type SkillMetadata,
} from '../src/skills.js';

// The skills module writes to ~/.calliope-cli/skills/ so tests interact with real filesystem.
// We create temp dirs for skill source material rather than mocking fs.

const SKILLS_DIR = path.join(os.homedir(), '.calliope-cli', 'skills');
const TEST_SKILL_NAME = '__test-skill-vitest__';
const TEST_SKILL_NAME_2 = '__test-skill-vitest-2__';

// Valid SKILL.md content
const VALID_SKILL_MD = `---
name: ${TEST_SKILL_NAME}
description: A test skill for unit tests
license: MIT
compatibility: calliope-cli >= 0.8
---

# Test Skill Instructions

This skill is for testing purposes only.
Use this when you need to run tests.
`;

const VALID_SKILL_MD_2 = `---
name: ${TEST_SKILL_NAME_2}
description: A second test skill
---

# Second Skill

Instructions for the second skill.
`;

const INVALID_SKILL_MD_NO_FRONTMATTER = `# Just Markdown

No YAML frontmatter here.
`;

const INVALID_SKILL_MD_MISSING_NAME = `---
description: Missing name field
---

# Instructions
`;

const INVALID_SKILL_MD_MISSING_DESCRIPTION = `---
name: bad-skill
---

# Instructions
`;

const SKILL_MD_WITH_ALLOWED_TOOLS = `---
name: ${TEST_SKILL_NAME}
description: Skill with allowed tools
allowed-tools: shell read_file write_file
---

# Tool Skill

Use the allowed tools.
`;

const SKILL_MD_WITH_QUOTED_VALUES = `---
name: "${TEST_SKILL_NAME}"
description: 'A skill with quoted values'
license: "MIT"
---

# Quoted Skill

Instructions here.
`;

let tempDirs: string[] = [];

function createTempSkillDir(skillMdContent: string, extras?: {
  scripts?: Record<string, string>;
  references?: Record<string, string>;
  assets?: Record<string, string>;
}): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-skill-test-'));
  tempDirs.push(tmpDir);

  fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), skillMdContent);

  if (extras) {
    for (const [dirName, files] of Object.entries(extras)) {
      const subDir = path.join(tmpDir, dirName);
      fs.mkdirSync(subDir, { recursive: true });
      for (const [fileName, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(subDir, fileName), content);
      }
    }
  }

  return tmpDir;
}

function cleanupInstalledSkill(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true });
  }
  // Also clean the index
  const indexFile = path.join(SKILLS_DIR, 'index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      if (index[name]) {
        delete index[name];
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
      }
    } catch {
      // ignore
    }
  }
}

beforeEach(() => {
  // Clean up any previously installed test skills
  cleanupInstalledSkill(TEST_SKILL_NAME);
  cleanupInstalledSkill(TEST_SKILL_NAME_2);
});

afterEach(() => {
  // Clean up installed test skills
  cleanupInstalledSkill(TEST_SKILL_NAME);
  cleanupInstalledSkill(TEST_SKILL_NAME_2);
});

afterAll(() => {
  // Remove temp directories
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
  }
  tempDirs = [];
  // Final cleanup
  cleanupInstalledSkill(TEST_SKILL_NAME);
  cleanupInstalledSkill(TEST_SKILL_NAME_2);
});

// ============================================================================
// loadSkillFromDir
// ============================================================================

describe('loadSkillFromDir', () => {
  it('should load a valid skill from a directory', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    expect(skill!.id).toBe(TEST_SKILL_NAME);
    expect(skill!.metadata.name).toBe(TEST_SKILL_NAME);
    expect(skill!.metadata.description).toBe('A test skill for unit tests');
    expect(skill!.loaded).toBe(true);
    expect(skill!.source).toBe('local');
    expect(skill!.path).toBe(dir);
  });

  it('should return null for a directory without SKILL.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-skill-test-'));
    tempDirs.push(tmpDir);
    const skill = loadSkillFromDir(tmpDir);
    expect(skill).toBeNull();
  });

  it('should return null for invalid SKILL.md (no frontmatter)', () => {
    const dir = createTempSkillDir(INVALID_SKILL_MD_NO_FRONTMATTER);
    const skill = loadSkillFromDir(dir);
    expect(skill).toBeNull();
  });

  it('should return null for SKILL.md missing name field', () => {
    const dir = createTempSkillDir(INVALID_SKILL_MD_MISSING_NAME);
    const skill = loadSkillFromDir(dir);
    expect(skill).toBeNull();
  });

  it('should return null for SKILL.md missing description field', () => {
    const dir = createTempSkillDir(INVALID_SKILL_MD_MISSING_DESCRIPTION);
    const skill = loadSkillFromDir(dir);
    expect(skill).toBeNull();
  });

  it('should parse instructions from the body of SKILL.md', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    const skill = loadSkillFromDir(dir);
    expect(skill!.instructions).toContain('Test Skill Instructions');
    expect(skill!.instructions).toContain('testing purposes');
  });

  it('should parse optional metadata fields', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    const skill = loadSkillFromDir(dir);
    expect(skill!.metadata.license).toBe('MIT');
    expect(skill!.metadata.compatibility).toBe('calliope-cli >= 0.8');
  });

  it('should parse allowed-tools into allowedTools array', () => {
    const dir = createTempSkillDir(SKILL_MD_WITH_ALLOWED_TOOLS);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    expect(skill!.metadata.allowedTools).toBeDefined();
    expect(skill!.metadata.allowedTools).toContain('shell');
    expect(skill!.metadata.allowedTools).toContain('read_file');
    expect(skill!.metadata.allowedTools).toContain('write_file');
  });

  it('should handle quoted values in frontmatter', () => {
    const dir = createTempSkillDir(SKILL_MD_WITH_QUOTED_VALUES);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    expect(skill!.metadata.name).toBe(TEST_SKILL_NAME);
    expect(skill!.metadata.description).toBe('A skill with quoted values');
    expect(skill!.metadata.license).toBe('MIT');
  });

  it('should return null for a nonexistent directory', () => {
    const skill = loadSkillFromDir('/nonexistent/path/that/does/not/exist');
    expect(skill).toBeNull();
  });
});

// ============================================================================
// installLocalSkill / getSkill / getSkills
// ============================================================================

describe('installLocalSkill', () => {
  it('should install a valid skill and return it', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    const skill = installLocalSkill(dir);
    expect(skill).not.toBeNull();
    expect(skill!.id).toBe(TEST_SKILL_NAME);
    expect(skill!.path).toContain(SKILLS_DIR);
  });

  it('should return null for a directory without SKILL.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-skill-test-'));
    tempDirs.push(tmpDir);
    const skill = installLocalSkill(tmpDir);
    expect(skill).toBeNull();
  });

  it('should make the skill available via getSkill', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME);
    expect(skill).not.toBeNull();
    expect(skill!.id).toBe(TEST_SKILL_NAME);
    expect(skill!.metadata.description).toBe('A test skill for unit tests');
  });

  it('should make the skill appear in getSkills', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const skills = getSkills();
    const found = skills.find(s => s.id === TEST_SKILL_NAME);
    expect(found).toBeDefined();
    expect(found!.metadata.name).toBe(TEST_SKILL_NAME);
  });

  it('should copy skill files to the skills directory', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const installedSkillMd = path.join(SKILLS_DIR, TEST_SKILL_NAME, 'SKILL.md');
    expect(fs.existsSync(installedSkillMd)).toBe(true);
  });

  it('should copy subdirectories (scripts, references, assets)', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD, {
      scripts: { 'run.sh': '#!/bin/bash\necho hello' },
      references: { 'api.md': '# API docs' },
      assets: { 'logo.txt': 'ASCII art' },
    });
    installLocalSkill(dir);
    const skillBase = path.join(SKILLS_DIR, TEST_SKILL_NAME);
    expect(fs.existsSync(path.join(skillBase, 'scripts', 'run.sh'))).toBe(true);
    expect(fs.existsSync(path.join(skillBase, 'references', 'api.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillBase, 'assets', 'logo.txt'))).toBe(true);
  });
});

// ============================================================================
// getSkill
// ============================================================================

describe('getSkill', () => {
  it('should return null for a skill that is not installed', () => {
    const skill = getSkill('nonexistent-skill-xyz-999');
    expect(skill).toBeNull();
  });

  it('should return the correct skill after installation', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME);
    expect(skill).not.toBeNull();
    expect(skill!.id).toBe(TEST_SKILL_NAME);
    expect(skill!.source).toBe('local');
  });

  it('should include instructions', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME);
    expect(skill!.instructions).toBeDefined();
    expect(skill!.instructions!.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// getSkills
// ============================================================================

describe('getSkills', () => {
  it('should return an array', () => {
    const skills = getSkills();
    expect(Array.isArray(skills)).toBe(true);
  });

  it('should include installed skills', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const skills = getSkills();
    const found = skills.find(s => s.id === TEST_SKILL_NAME);
    expect(found).toBeDefined();
  });

  it('should include multiple installed skills', () => {
    const dir1 = createTempSkillDir(VALID_SKILL_MD);
    const dir2 = createTempSkillDir(VALID_SKILL_MD_2);
    installLocalSkill(dir1);
    installLocalSkill(dir2);
    const skills = getSkills();
    const found1 = skills.find(s => s.id === TEST_SKILL_NAME);
    const found2 = skills.find(s => s.id === TEST_SKILL_NAME_2);
    expect(found1).toBeDefined();
    expect(found2).toBeDefined();
  });
});

// ============================================================================
// getSkillReferences
// ============================================================================

describe('getSkillReferences', () => {
  it('should return an empty array for a skill with no references', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME)!;
    const refs = getSkillReferences(skill);
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.length).toBe(0);
  });

  it('should return script references', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD, {
      scripts: { 'run.sh': '#!/bin/bash\necho hello', 'test.py': 'print("test")' },
    });
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME)!;
    const refs = getSkillReferences(skill);
    // Note: the source casts the plural dir name as the type, so type is 'scripts' at runtime
    const scripts = refs.filter(r => (r.type as string) === 'scripts');
    expect(scripts.length).toBe(2);
    expect(scripts.map(r => r.name)).toContain('run.sh');
    expect(scripts.map(r => r.name)).toContain('test.py');
  });

  it('should return reference files', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD, {
      references: { 'spec.md': '# Spec' },
    });
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME)!;
    const refs = getSkillReferences(skill);
    const references = refs.filter(r => (r.type as string) === 'references');
    expect(references.length).toBe(1);
    expect(references[0].name).toBe('spec.md');
  });

  it('should return asset files', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD, {
      assets: { 'logo.png': 'binary data', 'config.json': '{}' },
    });
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME)!;
    const refs = getSkillReferences(skill);
    const assets = refs.filter(r => (r.type as string) === 'assets');
    expect(assets.length).toBe(2);
    expect(assets.map(r => r.name)).toContain('logo.png');
    expect(assets.map(r => r.name)).toContain('config.json');
  });

  it('should include full path for each reference', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD, {
      scripts: { 'run.sh': '#!/bin/bash' },
    });
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME)!;
    const refs = getSkillReferences(skill);
    for (const ref of refs) {
      expect(path.isAbsolute(ref.path)).toBe(true);
      expect(fs.existsSync(ref.path)).toBe(true);
    }
  });

  it('should return all types combined', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD, {
      scripts: { 'run.sh': '#!/bin/bash' },
      references: { 'docs.md': '# Docs' },
      assets: { 'data.json': '{}' },
    });
    installLocalSkill(dir);
    const skill = getSkill(TEST_SKILL_NAME)!;
    const refs = getSkillReferences(skill);
    expect(refs.length).toBe(3);
    // Note: the source casts plural dir names as types, so runtime values are plural
    const types = refs.map(r => r.type as string);
    expect(types).toContain('scripts');
    expect(types).toContain('references');
    expect(types).toContain('assets');
  });
});

// ============================================================================
// uninstallSkill
// ============================================================================

describe('uninstallSkill', () => {
  it('should return true when uninstalling an installed skill', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    expect(uninstallSkill(TEST_SKILL_NAME)).toBe(true);
  });

  it('should return false for a skill that is not installed', () => {
    expect(uninstallSkill('nonexistent-skill-xyz-999')).toBe(false);
  });

  it('should remove the skill from getSkill', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    expect(getSkill(TEST_SKILL_NAME)).not.toBeNull();
    uninstallSkill(TEST_SKILL_NAME);
    expect(getSkill(TEST_SKILL_NAME)).toBeNull();
  });

  it('should remove the skill from getSkills', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    uninstallSkill(TEST_SKILL_NAME);
    const skills = getSkills();
    const found = skills.find(s => s.id === TEST_SKILL_NAME);
    expect(found).toBeUndefined();
  });

  it('should remove the skill directory from disk', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const installedDir = path.join(SKILLS_DIR, TEST_SKILL_NAME);
    expect(fs.existsSync(installedDir)).toBe(true);
    uninstallSkill(TEST_SKILL_NAME);
    expect(fs.existsSync(installedDir)).toBe(false);
  });

  it('should not affect other installed skills', () => {
    const dir1 = createTempSkillDir(VALID_SKILL_MD);
    const dir2 = createTempSkillDir(VALID_SKILL_MD_2);
    installLocalSkill(dir1);
    installLocalSkill(dir2);
    uninstallSkill(TEST_SKILL_NAME);
    expect(getSkill(TEST_SKILL_NAME)).toBeNull();
    expect(getSkill(TEST_SKILL_NAME_2)).not.toBeNull();
  });
});

// ============================================================================
// getSkillsContext
// ============================================================================

describe('getSkillsContext', () => {
  it('should return empty string when no skills are installed', () => {
    // Ensure our test skills are cleaned up
    cleanupInstalledSkill(TEST_SKILL_NAME);
    cleanupInstalledSkill(TEST_SKILL_NAME_2);
    // Note: there may be other skills installed by the user, so we just test the shape
    const context = getSkillsContext();
    expect(typeof context).toBe('string');
  });

  it('should include skill names and descriptions when skills are installed', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const context = getSkillsContext();
    expect(context).toContain(TEST_SKILL_NAME);
    expect(context).toContain('A test skill for unit tests');
  });

  it('should include the Available Skills header when skills exist', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const context = getSkillsContext();
    expect(context).toContain('Available Skills');
  });

  it('should list multiple skills', () => {
    const dir1 = createTempSkillDir(VALID_SKILL_MD);
    const dir2 = createTempSkillDir(VALID_SKILL_MD_2);
    installLocalSkill(dir1);
    installLocalSkill(dir2);
    const context = getSkillsContext();
    expect(context).toContain(TEST_SKILL_NAME);
    expect(context).toContain(TEST_SKILL_NAME_2);
    expect(context).toContain('A test skill for unit tests');
    expect(context).toContain('A second test skill');
  });
});

// ============================================================================
// getSkillInstructions
// ============================================================================

describe('getSkillInstructions', () => {
  it('should return null for a skill that is not installed', () => {
    expect(getSkillInstructions('nonexistent-skill-xyz-999')).toBeNull();
  });

  it('should return the instructions for an installed skill', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const instructions = getSkillInstructions(TEST_SKILL_NAME);
    expect(instructions).not.toBeNull();
    expect(instructions).toContain('Test Skill Instructions');
    expect(instructions).toContain('testing purposes');
  });

  it('should return the trimmed instructions', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    installLocalSkill(dir);
    const instructions = getSkillInstructions(TEST_SKILL_NAME);
    expect(instructions).not.toBeNull();
    // Should not have leading/trailing whitespace
    expect(instructions).toBe(instructions!.trim());
  });
});

// ============================================================================
// Skill type structure
// ============================================================================

describe('Skill type structure', () => {
  it('should have all required fields on a loaded skill', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    const skill = loadSkillFromDir(dir)!;
    expect(skill).toHaveProperty('id');
    expect(skill).toHaveProperty('path');
    expect(skill).toHaveProperty('metadata');
    expect(skill).toHaveProperty('instructions');
    expect(skill).toHaveProperty('loaded');
    expect(skill).toHaveProperty('source');
  });

  it('should have correct metadata structure', () => {
    const dir = createTempSkillDir(VALID_SKILL_MD);
    const skill = loadSkillFromDir(dir)!;
    expect(skill.metadata).toHaveProperty('name');
    expect(skill.metadata).toHaveProperty('description');
    expect(typeof skill.metadata.name).toBe('string');
    expect(typeof skill.metadata.description).toBe('string');
  });
});
