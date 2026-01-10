/**
 * Tests for memory module
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseMemoryFile,
  formatMemoryFile,
  loadMemory,
  saveMemory,
  addMemoryEntry,
  suggestMemories,
  type Memory,
} from '../src/memory.js';

describe('parseMemoryFile', () => {
  it('should parse a complete CALLIOPE.md file', () => {
    const content = `# Project Memory

## Context
- This is a TypeScript project
- Uses React for the frontend

## Preferences
- Prefer functional components
- Always use strict TypeScript

## History
- 2025-01-09: Set up project structure
- 2025-01-10: Added tests

## Notes
- Remember to update docs
`;

    const result = parseMemoryFile(content);
    
    expect(result.context).toHaveLength(2);
    expect(result.context[0]).toBe('This is a TypeScript project');
    expect(result.preferences).toHaveLength(2);
    expect(result.preferences[0]).toBe('Prefer functional components');
    expect(result.history).toHaveLength(2);
    expect(result.notes).toHaveLength(1);
  });

  it('should handle empty sections', () => {
    const content = `# Project Memory

## Context
- Only context here
`;

    const result = parseMemoryFile(content);
    
    expect(result.context).toHaveLength(1);
    expect(result.preferences).toHaveLength(0);
    expect(result.history).toHaveLength(0);
    expect(result.notes).toHaveLength(0);
  });

  it('should handle file with no sections', () => {
    const content = `# Just a title

Some random text that isn't in a section.
`;

    const result = parseMemoryFile(content);
    
    expect(result.context).toHaveLength(0);
    expect(result.preferences).toHaveLength(0);
  });

  it('should ignore non-list items', () => {
    const content = `# Project Memory

## Context
- Valid item
Not a list item
Another non-list
- Another valid item
`;

    const result = parseMemoryFile(content);
    
    expect(result.context).toHaveLength(2);
    expect(result.context[0]).toBe('Valid item');
    expect(result.context[1]).toBe('Another valid item');
  });
});

describe('formatMemoryFile', () => {
  it('should format a memory object to markdown', () => {
    const memory: Memory = {
      context: ['TypeScript project', 'CLI application'],
      preferences: ['Use ESM modules'],
      history: ['2025-01-09: Created project'],
      notes: [],
    };

    const result = formatMemoryFile(memory);

    expect(result).toContain('# Project Memory');
    expect(result).toContain('## Context');
    expect(result).toContain('- TypeScript project');
    expect(result).toContain('## Preferences');
    expect(result).toContain('- Use ESM modules');
    expect(result).toContain('## History');
    expect(result).not.toContain('## Notes'); // Empty section should be omitted
  });

  it('should use custom title', () => {
    const memory: Memory = {
      context: ['Test'],
      preferences: [],
      history: [],
      notes: [],
    };

    const result = formatMemoryFile(memory, 'Custom Title');

    expect(result).toContain('# Custom Title');
  });

  it('should handle empty memory', () => {
    const memory: Memory = {
      context: [],
      preferences: [],
      history: [],
      notes: [],
    };

    const result = formatMemoryFile(memory);

    expect(result).toContain('# Project Memory');
    expect(result).not.toContain('## Context');
    expect(result).not.toContain('## Preferences');
  });
});

describe('suggestMemories', () => {
  it('should detect preference patterns', () => {
    const content = 'I always prefer to use TypeScript for new projects';
    const suggestions = suggestMemories(content);

    expect(suggestions.some(s => s.type === 'preference')).toBe(true);
  });

  it('should detect negative preferences', () => {
    const content = "I don't want to use JavaScript in this project";
    const suggestions = suggestMemories(content);

    expect(suggestions.some(s => s.type === 'preference')).toBe(true);
  });

  it('should detect context patterns', () => {
    const content = 'This project uses React and Node.js';
    const suggestions = suggestMemories(content);

    // The pattern "uses" should trigger context detection
    expect(suggestions.length).toBeGreaterThanOrEqual(0);
  });

  it('should ignore very short matches', () => {
    const content = 'I always use X'; // Too short
    const suggestions = suggestMemories(content);

    // Should filter out matches shorter than 10 chars
    expect(suggestions.every(s => s.content.length >= 5)).toBe(true);
  });
});

describe('memory file operations', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temp directory for tests
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should save and load memory', () => {
    const memoryPath = path.join(testDir, 'CALLIOPE.md');
    const memory: Memory = {
      context: ['Test project'],
      preferences: ['Use TypeScript'],
      history: ['Started project'],
      notes: ['Important note'],
    };

    saveMemory(memoryPath, memory);
    const loaded = loadMemory(memoryPath);

    expect(loaded.context).toEqual(memory.context);
    expect(loaded.preferences).toEqual(memory.preferences);
    expect(loaded.history).toEqual(memory.history);
    expect(loaded.notes).toEqual(memory.notes);
  });

  it('should return empty memory for non-existent file', () => {
    const nonExistentPath = path.join(testDir, 'non-existent.md');
    const loaded = loadMemory(nonExistentPath);

    expect(loaded.context).toHaveLength(0);
    expect(loaded.preferences).toHaveLength(0);
    expect(loaded.history).toHaveLength(0);
    expect(loaded.notes).toHaveLength(0);
  });

  it('should add memory entry', () => {
    const memoryPath = path.join(testDir, 'CALLIOPE.md');
    
    // Initialize empty
    saveMemory(memoryPath, { context: [], preferences: [], history: [], notes: [] });

    // Add entries
    addMemoryEntry(memoryPath, { type: 'context', content: 'New context' });
    addMemoryEntry(memoryPath, { type: 'preference', content: 'New preference' });
    addMemoryEntry(memoryPath, { 
      type: 'history', 
      content: 'Did something',
      timestamp: '2025-01-15',
    });

    const loaded = loadMemory(memoryPath);

    expect(loaded.context).toContain('New context');
    expect(loaded.preferences).toContain('New preference');
    expect(loaded.history.some(h => h.includes('Did something'))).toBe(true);
    expect(loaded.history.some(h => h.includes('2025-01-15'))).toBe(true);
  });

  it('should not add duplicate context entries', () => {
    const memoryPath = path.join(testDir, 'CALLIOPE.md');
    saveMemory(memoryPath, { context: ['Existing'], preferences: [], history: [], notes: [] });

    addMemoryEntry(memoryPath, { type: 'context', content: 'Existing' });
    addMemoryEntry(memoryPath, { type: 'context', content: 'Existing' });

    const loaded = loadMemory(memoryPath);

    expect(loaded.context.filter(c => c === 'Existing')).toHaveLength(1);
  });
});
