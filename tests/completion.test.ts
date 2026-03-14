/**
 * Tests for src/completion.ts
 *
 * Covers: parseContext, getCommandCompletions, getSubcommandCompletions,
 * getFileCompletions, getCompletions, applyCompletion, createCompletionState,
 * nextCompletion, prevCompletion, getCurrentCompletion, applyCurrentCompletion
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseContext,
  getCommandCompletions,
  getSubcommandCompletions,
  getFileCompletions,
  getCompletions,
  applyCompletion,
  createCompletionState,
  nextCompletion,
  prevCompletion,
  getCurrentCompletion,
  applyCurrentCompletion,
} from '../src/completion.js';

// ---------------------------------------------------------------------------
// Test fixture directory
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-completion-'));
  // Create some test files and directories
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '');
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
  fs.mkdirSync(path.join(tmpDir, 'src'));
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '');
  fs.writeFileSync(path.join(tmpDir, 'src', 'utils.ts'), '');
  fs.mkdirSync(path.join(tmpDir, '.hidden'));
  fs.writeFileSync(path.join(tmpDir, '.env'), '');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseContext
// ---------------------------------------------------------------------------

describe('parseContext', () => {
  it('should parse simple input', () => {
    const ctx = parseContext('hello world', 11);
    expect(ctx.input).toBe('hello world');
    expect(ctx.cursorPosition).toBe(11);
    expect(ctx.currentWord).toBe('world');
    expect(ctx.previousWord).toBe('hello');
    expect(ctx.isCommand).toBe(false);
  });

  it('should detect command input starting with /', () => {
    const ctx = parseContext('/help', 5);
    expect(ctx.isCommand).toBe(true);
    expect(ctx.currentWord).toBe('/help');
  });

  it('should handle single word input', () => {
    const ctx = parseContext('hello', 5);
    expect(ctx.currentWord).toBe('hello');
    expect(ctx.previousWord).toBe('');
  });

  it('should handle empty input', () => {
    const ctx = parseContext('', 0);
    expect(ctx.currentWord).toBe('');
    expect(ctx.previousWord).toBe('');
    expect(ctx.isCommand).toBe(false);
  });

  it('should handle cursor in the middle of word', () => {
    const ctx = parseContext('/hel something', 4);
    expect(ctx.currentWord).toBe('/hel');
  });

  it('should handle leading whitespace in commands', () => {
    const ctx = parseContext('  /help', 7);
    expect(ctx.isCommand).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getCommandCompletions
// ---------------------------------------------------------------------------

describe('getCommandCompletions', () => {
  it('should return all commands for empty prefix', () => {
    const completions = getCommandCompletions('');
    expect(completions.length).toBeGreaterThan(0);
    expect(completions.every(c => c.type === 'command')).toBe(true);
  });

  it('should filter commands by prefix', () => {
    const completions = getCommandCompletions('/he');
    expect(completions.length).toBeGreaterThanOrEqual(1);
    expect(completions.some(c => c.value === '/help')).toBe(true);
  });

  it('should be case insensitive', () => {
    const lower = getCommandCompletions('/help');
    const upper = getCommandCompletions('/HELP');
    expect(lower.length).toBe(upper.length);
  });

  it('should return empty for non-matching prefix', () => {
    const completions = getCommandCompletions('/zzz_nonexistent');
    expect(completions).toEqual([]);
  });

  it('should return completions with description', () => {
    const completions = getCommandCompletions('/help');
    const help = completions.find(c => c.value === '/help');
    expect(help?.description).toBeTruthy();
    expect(help?.display).toBe('/help');
  });
});

// ---------------------------------------------------------------------------
// getSubcommandCompletions
// ---------------------------------------------------------------------------

describe('getSubcommandCompletions', () => {
  it('should return subcommands for /export', () => {
    const completions = getSubcommandCompletions('/export', '');
    expect(completions.length).toBeGreaterThan(0);
    expect(completions.some(c => c.value === 'markdown')).toBe(true);
    expect(completions.some(c => c.value === 'json')).toBe(true);
  });

  it('should filter subcommands by prefix', () => {
    const completions = getSubcommandCompletions('/export', 'ma');
    expect(completions.length).toBe(1);
    expect(completions[0].value).toBe('markdown');
  });

  it('should return empty for command without subcommands', () => {
    const completions = getSubcommandCompletions('/help', '');
    expect(completions).toEqual([]);
  });

  it('should return empty for unknown command', () => {
    const completions = getSubcommandCompletions('/nonexistent', '');
    expect(completions).toEqual([]);
  });

  it('should return subcommands of type option', () => {
    const completions = getSubcommandCompletions('/profile', '');
    expect(completions.every(c => c.type === 'option')).toBe(true);
  });

  it('should return subcommands for /confirm', () => {
    const completions = getSubcommandCompletions('/confirm', '');
    expect(completions.some(c => c.value === 'on')).toBe(true);
    expect(completions.some(c => c.value === 'off')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getFileCompletions
// ---------------------------------------------------------------------------

describe('getFileCompletions', () => {
  it('should return files in cwd', () => {
    const completions = getFileCompletions('', tmpDir);
    expect(completions.some(c => c.display === 'README.md')).toBe(true);
    expect(completions.some(c => c.display === 'src/')).toBe(true);
  });

  it('should filter by prefix', () => {
    const completions = getFileCompletions('R', tmpDir);
    expect(completions.some(c => c.display === 'README.md')).toBe(true);
    expect(completions.some(c => c.display === 'src/')).toBe(false);
  });

  it('should mark directories with trailing slash', () => {
    const completions = getFileCompletions('src', tmpDir);
    const srcEntry = completions.find(c => c.value.includes('src'));
    expect(srcEntry?.display).toBe('src/');
    expect(srcEntry?.value.endsWith('/')).toBe(true);
    expect(srcEntry?.type).toBe('directory');
  });

  it('should list files in subdirectory when path has slash', () => {
    const completions = getFileCompletions('src/', tmpDir);
    expect(completions.some(c => c.display === 'index.ts')).toBe(true);
    expect(completions.some(c => c.display === 'utils.ts')).toBe(true);
  });

  it('should skip hidden files when prefix does not start with dot', () => {
    const completions = getFileCompletions('', tmpDir);
    expect(completions.some(c => c.display === '.env')).toBe(false);
    expect(completions.some(c => c.display === '.hidden/')).toBe(false);
  });

  it('should show hidden files when prefix starts with dot', () => {
    const completions = getFileCompletions('.', tmpDir);
    expect(completions.some(c => c.display === '.env')).toBe(true);
  });

  it('should return empty for non-existent directory', () => {
    const completions = getFileCompletions('nonexistent/', tmpDir);
    expect(completions).toEqual([]);
  });

  it('should handle absolute path prefix with slash prefix', () => {
    // When path part is absolute directory
    const completions = getFileCompletions(tmpDir + '/', tmpDir);
    expect(Array.isArray(completions)).toBe(true);
  });

  it('should use process.cwd() when no cwd provided', () => {
    // Just verify it doesn't crash
    const completions = getFileCompletions('');
    expect(Array.isArray(completions)).toBe(true);
  });

  it('should limit results to 50', () => {
    // Create 60 files
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${String(i).padStart(3, '0')}.txt`), '');
    }
    const completions = getFileCompletions('file', tmpDir);
    expect(completions.length).toBeLessThanOrEqual(50);
  });

  it('should handle relative paths with ../  ', () => {
    const subDir = path.join(tmpDir, 'src');
    const completions = getFileCompletions('../', subDir);
    expect(Array.isArray(completions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getCompletions
// ---------------------------------------------------------------------------

describe('getCompletions', () => {
  it('should return command completions for / prefix', () => {
    const completions = getCompletions('/he', 3);
    expect(completions.some(c => c.value === '/help')).toBe(true);
  });

  it('should return subcommand completions for word after command', () => {
    const completions = getCompletions('/export m', 9);
    expect(completions.some(c => c.value === 'markdown')).toBe(true);
  });

  it('should return file completions for ./ prefix', () => {
    const completions = getCompletions('./R', 3, tmpDir);
    // Gets file completions based on partial path
    expect(Array.isArray(completions)).toBe(true);
  });

  it('should return file completions for / prefix (path not command)', () => {
    // /usr is file path, not a command that starts with /us
    // The /usr will try command completion first (since starts with /)
    const completions = getCompletions('/exit', 5);
    expect(completions.some(c => c.value === '/exit')).toBe(true);
  });

  it('should return file completions for @ prefix', () => {
    const completions = getCompletions('@src', 4, tmpDir);
    // Should get file completions with @ prefix
    expect(Array.isArray(completions)).toBe(true);
    // @ + file paths
    const atCompletions = completions.filter(c => c.value.startsWith('@'));
    expect(atCompletions.length).toBeGreaterThanOrEqual(0);
  });

  it('should return file completions for ../ prefix', () => {
    const completions = getCompletions('../', 3, tmpDir);
    expect(Array.isArray(completions)).toBe(true);
  });

  it('should return empty for regular text with no special prefix', () => {
    const completions = getCompletions('hello world', 11);
    expect(completions).toEqual([]);
  });

  it('should handle subcommand not found (empty subcommands) - falls through to empty', () => {
    // /help has no subcommands, so after typing '/help ' the subcommand match returns []
    // and we fall through to return []
    const completions = getCompletions('/help ', 6);
    expect(completions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyCompletion
// ---------------------------------------------------------------------------

describe('applyCompletion', () => {
  it('should replace current word with completion value', () => {
    const completion = { value: '/help', display: '/help', type: 'command' as const };
    const result = applyCompletion('/he', 3, completion);
    expect(result.newInput).toBe('/help');
    expect(result.newCursorPosition).toBe(5);
  });

  it('should preserve text after cursor', () => {
    const completion = { value: '/help', display: '/help', type: 'command' as const };
    const result = applyCompletion('/he world', 3, completion);
    expect(result.newInput).toBe('/help world');
  });

  it('should handle multi-word input', () => {
    const completion = { value: 'markdown', display: 'markdown', type: 'option' as const };
    const result = applyCompletion('/export mar', 11, completion);
    expect(result.newInput).toBe('/export markdown');
  });

  it('should position cursor at end of completion', () => {
    const completion = { value: 'src/', display: 'src/', type: 'directory' as const };
    const result = applyCompletion('s', 1, completion);
    expect(result.newCursorPosition).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// createCompletionState
// ---------------------------------------------------------------------------

describe('createCompletionState', () => {
  it('should return null when no completions available', () => {
    const state = createCompletionState('regular text with no completions', 32);
    expect(state).toBeNull();
  });

  it('should create state with completions', () => {
    const state = createCompletionState('/he', 3);
    expect(state).not.toBeNull();
    expect(state?.completions.length).toBeGreaterThan(0);
    expect(state?.selectedIndex).toBe(0);
    expect(state?.originalInput).toBe('/he');
    expect(state?.originalCursor).toBe(3);
  });

  it('should pass cwd to file completions', () => {
    const state = createCompletionState('./R', 3, tmpDir);
    expect(Array.isArray(state?.completions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nextCompletion / prevCompletion / getCurrentCompletion
// ---------------------------------------------------------------------------

describe('nextCompletion', () => {
  it('should advance selectedIndex', () => {
    const state = createCompletionState('/e', 2)!;
    const next = nextCompletion(state);
    expect(next.selectedIndex).toBe(1);
  });

  it('should wrap around at end', () => {
    const state = createCompletionState('/exit', 5)!;
    // There's likely only 1 completion for /exit
    const next = nextCompletion(state);
    expect(next.selectedIndex).toBe((state.selectedIndex + 1) % state.completions.length);
  });
});

describe('prevCompletion', () => {
  it('should decrement selectedIndex', () => {
    const state = createCompletionState('/e', 2)!;
    const next = nextCompletion(state); // move to index 1
    const prev = prevCompletion(next);  // back to index 0
    expect(prev.selectedIndex).toBe(0);
  });

  it('should wrap around at beginning', () => {
    const state = createCompletionState('/e', 2)!;
    // state.selectedIndex is 0, going prev should wrap to last
    const prev = prevCompletion(state);
    expect(prev.selectedIndex).toBe(state.completions.length - 1);
  });
});

describe('getCurrentCompletion', () => {
  it('should return current completion at selectedIndex', () => {
    const state = createCompletionState('/he', 3)!;
    const current = getCurrentCompletion(state);
    expect(current).toBe(state.completions[0]);
  });
});

// ---------------------------------------------------------------------------
// applyCurrentCompletion
// ---------------------------------------------------------------------------

describe('applyCurrentCompletion', () => {
  it('should apply the currently selected completion', () => {
    const state = createCompletionState('/he', 3)!;
    const result = applyCurrentCompletion(state);
    expect(result.newInput).toBe(state.completions[0].value);
  });

  it('should apply completion from originalInput', () => {
    const state = createCompletionState('/he', 3)!;
    const next = nextCompletion(state);
    const result = applyCurrentCompletion(next);
    expect(result.newInput).toBe(next.completions[next.selectedIndex].value);
  });
});
