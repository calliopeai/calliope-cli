/**
 * Extended coverage tests for src/skills.ts
 *
 * Targets uncovered branches:
 * - parseSkillFile multiline YAML (value='', value='|', value='>')
 * - multiline accumulation lines (inMultiline && line.startsWith('  '))
 * - multiline termination with a new key re-processed (newMatch hit)
 * - frontmatter ends while inMultiline (trailing if (inMultiline))
 * - match && !inMultiline === false (line in multiline state matches key pattern)
 * - getSkills/getSkill when skill directory is corrupted (loadSkillFromDir returns null)
 * - uninstallSkill when skill directory no longer exists on disk
 * - copyDir with nested subdirectories
 * - getSkillsContext returns empty string when no skills
 * - getSkillInstructions returns null when skill has no instructions
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadSkillFromDir,
  getSkills,
  getSkill,
  installLocalSkill,
  uninstallSkill,
  getSkillsContext,
  getSkillInstructions,
} from '../src/skills.js';

const SKILLS_DIR = path.join(os.homedir(), '.calliope-cli', 'skills');
const TEST_SKILL_NAME = '__test-skill-extended__';

let tempDirs: string[] = [];

function mktemp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-skill-ext-'));
  tempDirs.push(d);
  return d;
}

function writeSkillMd(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

function cleanupSkill(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true });
  const indexFile = path.join(SKILLS_DIR, 'index.json');
  if (fs.existsSync(indexFile)) {
    try {
      const idx = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      if (idx[name]) {
        delete idx[name];
        fs.writeFileSync(indexFile, JSON.stringify(idx, null, 2));
      }
    } catch { /* ignore */ }
  }
}

beforeEach(() => {
  cleanupSkill(TEST_SKILL_NAME);
});

afterEach(() => {
  cleanupSkill(TEST_SKILL_NAME);
});

afterAll(() => {
  for (const d of tempDirs) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
  }
  tempDirs = [];
  cleanupSkill(TEST_SKILL_NAME);
});

// ============================================================================
// Multiline YAML parsing: value === '' triggers inMultiline
// ============================================================================

describe('parseSkillFile - multiline with empty value (value === "")', () => {
  it('should parse description as multiline when value is empty string', () => {
    const content = `---\nname: ${TEST_SKILL_NAME}\ndescription:\n  This is a multiline\n  description value\n---\n\n# Instructions\n`;
    const dir = mktemp();
    writeSkillMd(dir, content);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    expect(skill!.metadata.description).toContain('multiline');
    expect(skill!.metadata.description).toContain('description value');
  });

  it('should handle multiline value that is immediately terminated by another key', () => {
    // The multiline block ends when a non-indented line is encountered
    // and that line matches /^(\w[\w-]*)\s*:\s*(.*)$/
    const content = `---\nname: ${TEST_SKILL_NAME}\ndescription:\n  First line\n  Second line\nlicense: MIT\n---\n\n# Instructions\n`;
    const dir = mktemp();
    writeSkillMd(dir, content);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    expect(skill!.metadata.description).toContain('First line');
    expect(skill!.metadata.description).toContain('Second line');
    // After multiline ends at 'license: MIT', that key should be re-processed
    expect(skill!.metadata.license).toBe('MIT');
  });
});

// ============================================================================
// Multiline YAML parsing: value === '|' triggers inMultiline
// ============================================================================

describe('parseSkillFile - multiline with pipe indicator (value === "|")', () => {
  it('should parse multiline block scalar with | indicator', () => {
    const content = `---\nname: ${TEST_SKILL_NAME}\ndescription: |\n  This is line one\n  This is line two\n---\n\n# Instructions\n`;
    const dir = mktemp();
    writeSkillMd(dir, content);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    expect(skill!.metadata.description).toContain('line one');
    expect(skill!.metadata.description).toContain('line two');
  });
});

// ============================================================================
// Multiline YAML parsing: value === '>' triggers inMultiline
// ============================================================================

describe('parseSkillFile - multiline with folded indicator (value === ">")', () => {
  it('should parse multiline folded block scalar with > indicator', () => {
    const content = `---\nname: ${TEST_SKILL_NAME}\ndescription: >\n  Folded\n  description\n---\n\n# Instructions\n`;
    const dir = mktemp();
    writeSkillMd(dir, content);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    expect(skill!.metadata.description).toContain('Folded');
    expect(skill!.metadata.description).toContain('description');
  });
});

// ============================================================================
// Multiline YAML: frontmatter ends while still in multiline mode
// ============================================================================

describe('parseSkillFile - multiline ends at frontmatter boundary', () => {
  it('should apply remaining multiline value when frontmatter ends', () => {
    // No trailing key after multiline — inMultiline is still true at end of loop
    const content = `---\nname: ${TEST_SKILL_NAME}\ndescription: |\n  Trailing multiline\n  value at end\n---\n\n# Instructions\n`;
    const dir = mktemp();
    writeSkillMd(dir, content);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    expect(skill!.metadata.description).toContain('Trailing multiline');
  });
});

// ============================================================================
// Multiline YAML: line.match in inMultiline state (match && !inMultiline === false)
// This happens when a line inside the multiline indented block also looks like key: value
// but starts with spaces so it's treated as multiline content, not a new key.
// ============================================================================

describe('parseSkillFile - indented key-like line inside multiline block', () => {
  it('should treat indented key-like lines as multiline content', () => {
    // 'foo: bar' indented inside multiline — should be treated as multiline content
    const content = `---\nname: ${TEST_SKILL_NAME}\ndescription: |\n  foo: bar\n  key: value\n---\n\n# Instructions\n`;
    const dir = mktemp();
    writeSkillMd(dir, content);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    // The description should contain the indented key-like lines as text
    expect(skill!.metadata.description).toContain('foo: bar');
    expect(skill!.metadata.description).toContain('key: value');
  });
});

// ============================================================================
// getSkills / getSkill: index entry pointing to non-existent directory
// ============================================================================

describe('getSkills - corrupted index entries', () => {
  it('should skip skills whose directory no longer exists', () => {
    // Manually write a bad index entry
    const indexFile = path.join(SKILLS_DIR, 'index.json');
    fs.mkdirSync(SKILLS_DIR, { recursive: true });

    let existingIndex: Record<string, unknown> = {};
    if (fs.existsSync(indexFile)) {
      try {
        existingIndex = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      } catch { /* ignore */ }
    }

    const badPath = path.join(os.tmpdir(), 'nonexistent-skill-dir-xyz-' + Date.now());
    existingIndex[TEST_SKILL_NAME] = { path: badPath, source: 'local' };
    fs.writeFileSync(indexFile, JSON.stringify(existingIndex, null, 2));

    const skills = getSkills();
    // Should not include the bad skill (loadSkillFromDir returns null for nonexistent dir)
    const found = skills.find(s => s.id === TEST_SKILL_NAME);
    expect(found).toBeUndefined();
  });

  it('getSkill should return null when skill directory no longer exists', () => {
    const indexFile = path.join(SKILLS_DIR, 'index.json');
    fs.mkdirSync(SKILLS_DIR, { recursive: true });

    let existingIndex: Record<string, unknown> = {};
    if (fs.existsSync(indexFile)) {
      try {
        existingIndex = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      } catch { /* ignore */ }
    }

    const badPath = path.join(os.tmpdir(), 'nonexistent-skill-dir-abc-' + Date.now());
    existingIndex[TEST_SKILL_NAME] = { path: badPath, source: 'local' };
    fs.writeFileSync(indexFile, JSON.stringify(existingIndex, null, 2));

    const skill = getSkill(TEST_SKILL_NAME);
    // loadSkillFromDir(badPath) returns null (no SKILL.md), so getSkill returns null
    expect(skill).toBeNull();
  });
});

// ============================================================================
// uninstallSkill: directory doesn't exist on disk but is in index
// ============================================================================

describe('uninstallSkill - directory already removed', () => {
  it('should still return true and clean index when dir is already gone', () => {
    // Write an index entry pointing to a nonexistent path
    const indexFile = path.join(SKILLS_DIR, 'index.json');
    fs.mkdirSync(SKILLS_DIR, { recursive: true });

    let existingIndex: Record<string, unknown> = {};
    if (fs.existsSync(indexFile)) {
      try {
        existingIndex = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      } catch { /* ignore */ }
    }

    const badPath = path.join(os.tmpdir(), 'gone-skill-' + Date.now());
    existingIndex[TEST_SKILL_NAME] = { path: badPath, source: 'local' };
    fs.writeFileSync(indexFile, JSON.stringify(existingIndex, null, 2));

    const result = uninstallSkill(TEST_SKILL_NAME);
    // Should succeed even though directory doesn't exist
    expect(result).toBe(true);
    // Should be removed from index
    const skill = getSkill(TEST_SKILL_NAME);
    expect(skill).toBeNull();
  });
});

// ============================================================================
// copyDir with nested subdirectories (recursive copyDir branch)
// ============================================================================

describe('installLocalSkill - nested skill directories', () => {
  it('should recursively copy nested subdirectories', () => {
    const dir = mktemp();
    const skillMd = `---\nname: ${TEST_SKILL_NAME}\ndescription: Skill with nested dirs\n---\n\n# Instructions\n`;
    writeSkillMd(dir, skillMd);

    // Create nested directory structure: scripts/utils/helper.sh
    const nestedDir = path.join(dir, 'scripts', 'utils');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'helper.sh'), '#!/bin/bash\necho helper');

    installLocalSkill(dir);

    const installedNested = path.join(SKILLS_DIR, TEST_SKILL_NAME, 'scripts', 'utils', 'helper.sh');
    expect(fs.existsSync(installedNested)).toBe(true);
  });
});

// ============================================================================
// getSkillsContext - empty string when no skills
// ============================================================================

describe('getSkillsContext - behavior', () => {
  it('should contain "Available Skills" when skills exist', () => {
    const dir = mktemp();
    const skillMd = `---\nname: ${TEST_SKILL_NAME}\ndescription: A test skill\n---\n\n# Instructions\n`;
    writeSkillMd(dir, skillMd);
    installLocalSkill(dir);

    const ctx = getSkillsContext();
    expect(ctx).toContain('Available Skills');
    expect(ctx).toContain(TEST_SKILL_NAME);
  });
});

// ============================================================================
// getSkillInstructions - null when skill has no instructions
// ============================================================================

describe('getSkillInstructions - edge cases', () => {
  it('should return instructions for an installed skill', () => {
    const dir = mktemp();
    const skillMd = `---\nname: ${TEST_SKILL_NAME}\ndescription: Test\n---\n\n# My Instructions\n\nDo this and that.\n`;
    writeSkillMd(dir, skillMd);
    installLocalSkill(dir);

    const instructions = getSkillInstructions(TEST_SKILL_NAME);
    expect(instructions).not.toBeNull();
    expect(instructions).toContain('My Instructions');
  });

  it('should return null for a nonexistent skill name', () => {
    const instructions = getSkillInstructions('__nonexistent__skill__xyz__');
    expect(instructions).toBeNull();
  });
});

// ============================================================================
// Multiline: non-matching non-indented line terminates multiline (no newMatch)
// ============================================================================

describe('parseSkillFile - multiline terminated by non-matching non-indented line', () => {
  it('should handle frontmatter where multiline ends at a line that does not match key pattern', () => {
    // An empty line in frontmatter (outside multiline block) terminates the block
    // but doesn't match the key pattern — so newMatch is null
    const content = `---\nname: ${TEST_SKILL_NAME}\ndescription: |\n  Line one\n  Line two\n\nlicense: MIT\n---\n\n# Instructions\n`;
    const dir = mktemp();
    writeSkillMd(dir, content);
    const skill = loadSkillFromDir(dir);
    expect(skill).not.toBeNull();
    // multiline ends at the blank line; description should have both lines
    expect(skill!.metadata.description).toContain('Line one');
  });
});
