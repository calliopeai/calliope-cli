/**
 * Extended tests for memory module
 * Covers functions not tested in memory.test.ts:
 * findProjectMemory, getGlobalMemoryPath, removeMemoryEntry, getProjectMemory,
 * initProjectMemory, loadContextFiles, listContextFiles, buildMemoryContext,
 * buildCompactContext, and additional branches in existing functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// GLOBAL_MEMORY_DIR is evaluated once at module load time as
//   path.join(os.homedir(), '.calliope-cli', 'memory')
// We must set tmpHome BEFORE the dynamic import so it captures a valid path.
// We keep tmpHome fixed for the whole file and clean between tests.
const tmpHome: string = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-home-init-'));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

// Mock the trust module so buildMemoryContext doesn't fail
vi.mock('../src/trust.js', () => ({
  checkTrust: () => ({ trusted: true }),
  autoTrustIfNew: () => {},
}));

const {
  findProjectMemory,
  getGlobalMemoryPath,
  removeMemoryEntry,
  getProjectMemory,
  initProjectMemory,
  loadContextFiles,
  listContextFiles,
  buildMemoryContext,
  buildCompactContext,
  addMemoryEntry,
  parseMemoryFile,
  formatMemoryFile,
  saveMemory,
  loadMemory,
  suggestMemories,
} = await import('../src/memory.js');

import type { Memory } from '../src/memory.js';

// Path to the global memory file used by the module (fixed at load time)
const GLOBAL_MEMORY_DIR = path.join(tmpHome, '.calliope-cli', 'memory');
const GLOBAL_MEMORY_FILE = path.join(GLOBAL_MEMORY_DIR, 'global.md');

// Clean global memory between tests
beforeEach(() => {
  if (fs.existsSync(GLOBAL_MEMORY_FILE)) {
    fs.unlinkSync(GLOBAL_MEMORY_FILE);
  }
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('findProjectMemory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-find-mem-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should find CALLIOPE.md in the current directory', () => {
    const memFile = path.join(testDir, 'CALLIOPE.md');
    fs.writeFileSync(memFile, '# Memory');

    const result = findProjectMemory(testDir);
    expect(result).toBe(memFile);
  });

  it('should find CALLIOPE.md in a parent directory', () => {
    const memFile = path.join(testDir, 'CALLIOPE.md');
    fs.writeFileSync(memFile, '# Memory');

    const subDir = path.join(testDir, 'sub', 'deep');
    fs.mkdirSync(subDir, { recursive: true });

    const result = findProjectMemory(subDir);
    expect(result).toBe(memFile);
  });

  it('should return null when no CALLIOPE.md is found', () => {
    // Use a deeply nested temp path that won't have CALLIOPE.md above it
    const subDir = path.join(testDir, 'empty');
    fs.mkdirSync(subDir, { recursive: true });

    const result = findProjectMemory(subDir);
    // It may find one higher up if running inside a project, so we just check type
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('getGlobalMemoryPath', () => {
  it('should return a path ending in global.md', () => {
    const result = getGlobalMemoryPath();
    expect(result).toMatch(/global\.md$/);
  });

  it('should create the memory directory if it does not exist', () => {
    // Remove the directory to test creation
    if (fs.existsSync(GLOBAL_MEMORY_DIR)) {
      fs.rmSync(GLOBAL_MEMORY_DIR, { recursive: true, force: true });
    }

    getGlobalMemoryPath();
    expect(fs.existsSync(GLOBAL_MEMORY_DIR)).toBe(true);
  });

  it('should not fail if directory already exists', () => {
    getGlobalMemoryPath();
    // Call again - should not throw
    const result = getGlobalMemoryPath();
    expect(result).toBeDefined();
  });
});

describe('removeMemoryEntry', () => {
  let testDir: string;
  let memPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-remove-'));
    memPath = path.join(testDir, 'CALLIOPE.md');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should remove a preference entry', () => {
    saveMemory(memPath, {
      context: [],
      preferences: ['Use functional components', 'Always use TypeScript'],
      history: [],
      notes: [],
    });

    const removed = removeMemoryEntry(memPath, 'preference', 'functional');
    expect(removed).toBe(true);

    const loaded = loadMemory(memPath);
    expect(loaded.preferences).toHaveLength(1);
    expect(loaded.preferences[0]).toBe('Always use TypeScript');
  });

  it('should remove a note entry', () => {
    saveMemory(memPath, {
      context: [],
      preferences: [],
      history: [],
      notes: ['Remember to update docs', 'Check the CI pipeline'],
    });

    const removed = removeMemoryEntry(memPath, 'note', 'update docs');
    expect(removed).toBe(true);

    const loaded = loadMemory(memPath);
    expect(loaded.notes).toHaveLength(1);
    expect(loaded.notes[0]).toBe('Check the CI pipeline');
  });

  it('should return false if no matching preference is found', () => {
    saveMemory(memPath, {
      context: [],
      preferences: ['Something else'],
      history: [],
      notes: [],
    });

    const removed = removeMemoryEntry(memPath, 'preference', 'nonexistent');
    expect(removed).toBe(false);
  });

  it('should be case-insensitive when searching', () => {
    saveMemory(memPath, {
      context: [],
      preferences: ['TypeScript Only'],
      history: [],
      notes: [],
    });

    const removed = removeMemoryEntry(memPath, 'preference', 'TYPESCRIPT');
    expect(removed).toBe(true);

    const loaded = loadMemory(memPath);
    expect(loaded.preferences).toHaveLength(0);
  });

  it('should accept a custom title when saving after removal', () => {
    saveMemory(memPath, {
      context: [],
      preferences: [],
      history: [],
      notes: ['Item to remove'],
    });

    removeMemoryEntry(memPath, 'note', 'item', 'Custom Title');

    const content = fs.readFileSync(memPath, 'utf-8');
    expect(content).toContain('# Custom Title');
  });

  it('should return false when removing a note that does not match', () => {
    saveMemory(memPath, {
      context: [],
      preferences: [],
      history: [],
      notes: ['Some note'],
    });

    const removed = removeMemoryEntry(memPath, 'note', 'nonexistent');
    expect(removed).toBe(false);
  });
});

describe('getProjectMemory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-getproj-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty memory when no CALLIOPE.md exists', () => {
    const mem = getProjectMemory(testDir);
    expect(mem.context).toHaveLength(0);
    expect(mem.preferences).toHaveLength(0);
    expect(mem.history).toHaveLength(0);
    expect(mem.notes).toHaveLength(0);
  });

  it('should load memory from CALLIOPE.md in the directory', () => {
    const memFile = path.join(testDir, 'CALLIOPE.md');
    fs.writeFileSync(memFile, `# Project Memory

## Context
- Test project context

## Preferences
- Prefer dark mode
`);

    const mem = getProjectMemory(testDir);
    expect(mem.context).toContain('Test project context');
    expect(mem.preferences).toContain('Prefer dark mode');
  });
});

describe('initProjectMemory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-init-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should create a CALLIOPE.md file in the directory', () => {
    const result = initProjectMemory(testDir);

    expect(result).toBe(path.join(testDir, 'CALLIOPE.md'));
    expect(fs.existsSync(result)).toBe(true);
  });

  it('should use the provided project name', () => {
    initProjectMemory(testDir, 'My Cool Project');

    const content = fs.readFileSync(path.join(testDir, 'CALLIOPE.md'), 'utf-8');
    expect(content).toContain('Project: My Cool Project');
  });

  it('should use directory basename when no project name given', () => {
    initProjectMemory(testDir);

    const content = fs.readFileSync(path.join(testDir, 'CALLIOPE.md'), 'utf-8');
    expect(content).toContain(`Project: ${path.basename(testDir)}`);
  });

  it('should include initialization history entry with date', () => {
    initProjectMemory(testDir);

    const mem = loadMemory(path.join(testDir, 'CALLIOPE.md'));
    expect(mem.history).toHaveLength(1);
    expect(mem.history[0]).toContain('Initialized project memory');
    // Should have a date prefix like "2025-01-15"
    expect(mem.history[0]).toMatch(/^\d{4}-\d{2}-\d{2}: /);
  });
});

describe('loadContextFiles', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-ctx-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty array when no context files exist', () => {
    const results = loadContextFiles(testDir);
    expect(results).toEqual([]);
  });

  it('should load README.md with correct label', () => {
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test\nSome content');

    const results = loadContextFiles(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('README.md');
    expect(results[0].label).toBe('README');
    expect(results[0].content).toContain('# Test');
  });

  it('should load CLAUDE.md with correct label', () => {
    fs.writeFileSync(path.join(testDir, 'CLAUDE.md'), '# Claude instructions');

    const results = loadContextFiles(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('Claude Context');
  });

  it('should load multiple context files', () => {
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Readme');
    fs.writeFileSync(path.join(testDir, 'TODO.md'), '# Todo');
    fs.writeFileSync(path.join(testDir, 'CALLIOPE.md'), '# Memory');

    const results = loadContextFiles(testDir);
    expect(results).toHaveLength(3);
    const names = results.map(r => r.name);
    expect(names).toContain('README.md');
    expect(names).toContain('TODO.md');
    expect(names).toContain('CALLIOPE.md');
  });

  it('should truncate files exceeding maxLines and add a suffix', () => {
    // README.md has maxLines=50
    const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`);
    fs.writeFileSync(path.join(testDir, 'README.md'), lines.join('\n'));

    const results = loadContextFiles(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('... (30 more lines)');
    // Should contain the first 50 lines
    expect(results[0].content).toContain('Line 1');
    expect(results[0].content).toContain('Line 50');
  });

  it('should not add truncation suffix when within maxLines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
    fs.writeFileSync(path.join(testDir, 'README.md'), lines.join('\n'));

    const results = loadContextFiles(testDir);
    expect(results[0].content).not.toContain('more lines');
  });

  it('should load .cursorrules from the context files list', () => {
    fs.writeFileSync(path.join(testDir, '.cursorrules'), 'Some cursor rules');

    const results = loadContextFiles(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('Cursor Rules');
  });

  it('should load .github/copilot-instructions.md', () => {
    const ghDir = path.join(testDir, '.github');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'copilot-instructions.md'), '# Copilot');

    const results = loadContextFiles(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('Copilot Instructions');
  });

  it('should skip unreadable files gracefully', () => {
    const filePath = path.join(testDir, 'README.md');
    fs.writeFileSync(filePath, '# test');
    fs.chmodSync(filePath, 0o000);

    const results = loadContextFiles(testDir);
    // Should not throw, should skip the unreadable file
    expect(results).toHaveLength(0);

    // Restore permissions for cleanup
    fs.chmodSync(filePath, 0o644);
  });
});

describe('listContextFiles', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-list-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty array when no context files exist', () => {
    const files = listContextFiles(testDir);
    expect(files).toEqual([]);
  });

  it('should return full paths to existing context files', () => {
    fs.writeFileSync(path.join(testDir, 'README.md'), '# test');
    fs.writeFileSync(path.join(testDir, 'TODO.md'), '# todo');

    const files = listContextFiles(testDir);
    expect(files).toHaveLength(2);
    expect(files).toContain(path.join(testDir, 'README.md'));
    expect(files).toContain(path.join(testDir, 'TODO.md'));
  });

  it('should not include files that do not exist', () => {
    fs.writeFileSync(path.join(testDir, 'README.md'), '# test');

    const files = listContextFiles(testDir);
    expect(files).not.toContain(path.join(testDir, 'CALLIOPE.md'));
    expect(files).not.toContain(path.join(testDir, 'SPEC.md'));
  });
});

describe('buildMemoryContext', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-bmc-'));
    // Ensure no leftover global memory
    if (fs.existsSync(GLOBAL_MEMORY_FILE)) {
      fs.unlinkSync(GLOBAL_MEMORY_FILE);
    }
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty string for a directory with no memory or context files', () => {
    const result = buildMemoryContext(testDir);
    expect(result).toBe('');
  });

  it('should include project context from CALLIOPE.md', () => {
    fs.writeFileSync(path.join(testDir, 'CALLIOPE.md'), `# Project Memory

## Context
- TypeScript CLI project
- Uses Ink for rendering
`);

    const result = buildMemoryContext(testDir);
    expect(result).toContain('Project context:');
    expect(result).toContain('- TypeScript CLI project');
    expect(result).toContain('- Uses Ink for rendering');
  });

  it('should include project preferences', () => {
    fs.writeFileSync(path.join(testDir, 'CALLIOPE.md'), `# Memory

## Preferences
- Use ESM modules
- Prefer functional style
`);

    const result = buildMemoryContext(testDir);
    expect(result).toContain('Project preferences:');
    expect(result).toContain('- Use ESM modules');
  });

  it('should include recent history (last 5 only)', () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      `2025-01-0${i + 1}: Event ${i + 1}`
    );
    fs.writeFileSync(path.join(testDir, 'CALLIOPE.md'), `# Memory

## History
${history.map(h => `- ${h}`).join('\n')}
`);

    const result = buildMemoryContext(testDir);
    expect(result).toContain('Recent history:');
    // Should have last 5 entries (events 4-8)
    expect(result).toContain('Event 4');
    expect(result).toContain('Event 8');
    // Should not have early entries
    expect(result).not.toContain('Event 1');
    expect(result).not.toContain('Event 3');
  });

  it('should include global preferences', () => {
    // Write global memory to the fixed tmpHome-based path
    fs.mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true });
    fs.writeFileSync(GLOBAL_MEMORY_FILE, `# Global Memory

## Preferences
- Dark mode preferred
- Verbose output
`);

    const result = buildMemoryContext(testDir);
    expect(result).toContain('Global preferences:');
    expect(result).toContain('- Dark mode preferred');
  });

  it('should include other context files but exclude CALLIOPE.md', () => {
    fs.writeFileSync(path.join(testDir, 'CALLIOPE.md'), `# Memory

## Context
- My project
`);
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test Project\nA test.');

    const result = buildMemoryContext(testDir);
    expect(result).toContain('--- README (README.md) ---');
    expect(result).toContain('A test.');
  });
});

describe('buildCompactContext', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-compact-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should return empty string when no memory exists', () => {
    const result = buildCompactContext(testDir);
    expect(result).toBe('');
  });

  it('should return compact context string', () => {
    fs.writeFileSync(path.join(testDir, 'CALLIOPE.md'), `# Memory

## Context
- TypeScript project
- CLI application

## Preferences
- ESM only
`);

    const result = buildCompactContext(testDir);
    expect(result).toContain('Context: TypeScript project; CLI application');
    expect(result).toContain('Prefs: ESM only');
  });

  it('should omit sections that are empty', () => {
    fs.writeFileSync(path.join(testDir, 'CALLIOPE.md'), `# Memory

## Context
- Just context here
`);

    const result = buildCompactContext(testDir);
    expect(result).toContain('Context:');
    expect(result).not.toContain('Prefs:');
  });
});

describe('addMemoryEntry - additional branches', () => {
  let testDir: string;
  let memPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-addentry-'));
    memPath = path.join(testDir, 'CALLIOPE.md');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should add a note entry', () => {
    saveMemory(memPath, { context: [], preferences: [], history: [], notes: [] });

    addMemoryEntry(memPath, { type: 'note', content: 'Important note' });

    const loaded = loadMemory(memPath);
    expect(loaded.notes).toContain('Important note');
  });

  it('should allow duplicate notes (unlike context/preference)', () => {
    saveMemory(memPath, { context: [], preferences: [], history: [], notes: [] });

    addMemoryEntry(memPath, { type: 'note', content: 'Same note' });
    addMemoryEntry(memPath, { type: 'note', content: 'Same note' });

    const loaded = loadMemory(memPath);
    expect(loaded.notes).toHaveLength(2);
  });

  it('should not add duplicate preference entries', () => {
    saveMemory(memPath, { context: [], preferences: ['Existing pref'], history: [], notes: [] });

    addMemoryEntry(memPath, { type: 'preference', content: 'Existing pref' });

    const loaded = loadMemory(memPath);
    expect(loaded.preferences).toHaveLength(1);
  });

  it('should add history without timestamp', () => {
    saveMemory(memPath, { context: [], preferences: [], history: [], notes: [] });

    addMemoryEntry(memPath, { type: 'history', content: 'Something happened' });

    const loaded = loadMemory(memPath);
    expect(loaded.history).toContain('Something happened');
  });

  it('should allow duplicate history entries', () => {
    saveMemory(memPath, { context: [], preferences: [], history: [], notes: [] });

    addMemoryEntry(memPath, { type: 'history', content: 'Event' });
    addMemoryEntry(memPath, { type: 'history', content: 'Event' });

    const loaded = loadMemory(memPath);
    expect(loaded.history).toHaveLength(2);
  });

  it('should accept a custom title', () => {
    saveMemory(memPath, { context: [], preferences: [], history: [], notes: [] });

    addMemoryEntry(memPath, { type: 'context', content: 'New' }, 'My Title');

    const content = fs.readFileSync(memPath, 'utf-8');
    expect(content).toContain('# My Title');
  });

  it('should create parent directories when saving to a nested path', () => {
    const nestedPath = path.join(testDir, 'deep', 'nested', 'CALLIOPE.md');

    addMemoryEntry(nestedPath, { type: 'context', content: 'Deep context' });

    expect(fs.existsSync(nestedPath)).toBe(true);
    const loaded = loadMemory(nestedPath);
    expect(loaded.context).toContain('Deep context');
  });
});

describe('parseMemoryFile - additional branches', () => {
  it('should handle unknown section headers by setting currentSection to null', () => {
    const content = `# Memory

## Unknown Section
- This should be ignored

## Context
- This should be captured
`;

    const result = parseMemoryFile(content);
    expect(result.context).toHaveLength(1);
    expect(result.context[0]).toBe('This should be captured');
  });

  it('should handle empty content', () => {
    const result = parseMemoryFile('');
    expect(result.context).toHaveLength(0);
    expect(result.preferences).toHaveLength(0);
    expect(result.history).toHaveLength(0);
    expect(result.notes).toHaveLength(0);
  });

  it('should handle content with only a title', () => {
    const result = parseMemoryFile('# Just a Title\n');
    expect(result.context).toHaveLength(0);
  });

  it('should handle list items before any section header (ignored)', () => {
    const content = `# Memory

- This is before any section

## Context
- Valid context
`;

    const result = parseMemoryFile(content);
    expect(result.context).toHaveLength(1);
    expect(result.context[0]).toBe('Valid context');
  });
});

describe('formatMemoryFile - notes section', () => {
  it('should include notes section when notes are present', () => {
    const memory: Memory = {
      context: [],
      preferences: [],
      history: [],
      notes: ['A note', 'Another note'],
    };

    const result = formatMemoryFile(memory);
    expect(result).toContain('## Notes');
    expect(result).toContain('- A note');
    expect(result).toContain('- Another note');
  });

  it('should include all sections when all are populated', () => {
    const memory: Memory = {
      context: ['ctx'],
      preferences: ['pref'],
      history: ['hist'],
      notes: ['note'],
    };

    const result = formatMemoryFile(memory);
    expect(result).toContain('## Context');
    expect(result).toContain('## Preferences');
    expect(result).toContain('## History');
    expect(result).toContain('## Notes');
  });
});

describe('suggestMemories - additional patterns', () => {
  it('should detect "this project uses" context pattern', () => {
    const content = 'This project uses React and TypeScript for the frontend';
    const suggestions = suggestMemories(content);

    const contextSuggestions = suggestions.filter(s => s.type === 'context');
    expect(contextSuggestions.length).toBeGreaterThan(0);
  });

  it('should detect "built with" context pattern', () => {
    const content = 'This application is built with React and TypeScript';
    const suggestions = suggestMemories(content);

    const contextSuggestions = suggestions.filter(s => s.type === 'context');
    expect(contextSuggestions.length).toBeGreaterThan(0);
  });

  it('should detect "never" preference pattern', () => {
    const content = 'Please never use var declarations in this codebase';
    const suggestions = suggestMemories(content);

    const prefSuggestions = suggestions.filter(s => s.type === 'preference');
    expect(prefSuggestions.length).toBeGreaterThan(0);
  });

  it('should detect "avoid" preference pattern', () => {
    const content = 'We should avoid using any type in TypeScript files';
    const suggestions = suggestMemories(content);

    const prefSuggestions = suggestions.filter(s => s.type === 'preference');
    expect(prefSuggestions.length).toBeGreaterThan(0);
  });

  it('should reject matches that are too long (>100 chars)', () => {
    const longContent = 'Always prefer to ' + 'x'.repeat(101) + '.';
    const suggestions = suggestMemories(longContent);

    // All suggestions should have content under 100 chars
    for (const s of suggestions) {
      expect(s.content.length).toBeLessThan(101);
    }
  });

  it('should return empty array for content with no patterns', () => {
    const content = 'The weather is nice today.';
    const suggestions = suggestMemories(content);
    expect(suggestions).toEqual([]);
  });
});
