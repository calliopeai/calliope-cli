/**
 * Tests for edit_file, glob, and grep tools (issues #112, #113, #114).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { executeTool } from '../src/tools.js';
import { resetScope } from '../src/scope.js';
import type { ToolCall } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTool(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Date.now()}-${Math.random()}`, name, arguments: args };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-edit-glob-grep-'));
  resetScope(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// edit_file tool (#112)
// ===========================================================================

describe('edit_file tool', () => {
  it('happy path: replaces a single occurrence', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(filePath, 'hello world\ngoodbye world');

    const result = await executeTool(
      makeTool('edit_file', { path: filePath, old_string: 'hello world', new_string: 'hi world' }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('replaced 1 occurrence');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hi world\ngoodbye world');
  });

  it('error: old_string not found in file', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'some content here');

    const result = await executeTool(
      makeTool('edit_file', { path: filePath, old_string: 'missing string', new_string: 'replacement' }),
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('error: old_string appears multiple times (ambiguous)', async () => {
    const filePath = path.join(tmpDir, 'multi.txt');
    fs.writeFileSync(filePath, 'foo bar\nfoo baz\nfoo qux');

    const result = await executeTool(
      makeTool('edit_file', { path: filePath, old_string: 'foo', new_string: 'bar' }),
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.result).toMatch(/3 occurrences/);
    expect(result.result).toContain('replace_all: true');
  });

  it('replace_all: replaces all occurrences', async () => {
    const filePath = path.join(tmpDir, 'multi.txt');
    fs.writeFileSync(filePath, 'foo bar\nfoo baz\nfoo qux');

    const result = await executeTool(
      makeTool('edit_file', { path: filePath, old_string: 'foo', new_string: 'XXX', replace_all: true }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('replaced 3 occurrence');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('XXX bar\nXXX baz\nXXX qux');
  });

  it('replace_all: errors when old_string not found even with replace_all=true', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'some content');

    const result = await executeTool(
      makeTool('edit_file', { path: filePath, old_string: 'NOT_PRESENT', new_string: 'x', replace_all: true }),
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('path outside scope: blocked', async () => {
    const result = await executeTool(
      makeTool('edit_file', { path: '/etc/passwd', old_string: 'root', new_string: 'admin' }),
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Error');
  });

  it('error: file does not exist', async () => {
    const result = await executeTool(
      makeTool('edit_file', {
        path: path.join(tmpDir, 'nonexistent.txt'),
        old_string: 'x',
        new_string: 'y',
      }),
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('not found');
  });

  it('error: path must be a string', async () => {
    const result = await executeTool(
      makeTool('edit_file', { path: 123, old_string: 'a', new_string: 'b' }),
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.result).toContain('path must be a string');
  });

  it('error: old_string must be a string', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'content');
    const result = await executeTool(
      makeTool('edit_file', { path: filePath, old_string: 42, new_string: 'b' }),
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.result).toContain('old_string must be a string');
  });

  it('error: new_string must be a string', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'content');
    const result = await executeTool(
      makeTool('edit_file', { path: filePath, old_string: 'content', new_string: null }),
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.result).toContain('new_string must be a string');
  });
});

// ===========================================================================
// glob tool (#113)
// ===========================================================================

describe('glob tool', () => {
  beforeEach(() => {
    // Set up a small directory tree
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'c.js'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'd.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'e.json'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'nested', 'f.ts'), '');
  });

  it('simple pattern: *.ts matches .ts files in root', async () => {
    const result = await executeTool(
      makeTool('glob', { pattern: '*.ts', cwd: tmpDir }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('a.ts');
    expect(result.result).toContain('b.ts');
    expect(result.result).not.toContain('c.js');
    // Root-level only
    expect(result.result).not.toContain('d.ts');
  });

  it('recursive pattern: **/*.ts matches nested .ts files', async () => {
    const result = await executeTool(
      makeTool('glob', { pattern: '**/*.ts', cwd: tmpDir }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('a.ts');
    expect(result.result).toContain('b.ts');
    // Nested files
    const lines = result.result.split('\n');
    const hasNested = lines.some(l => l.includes('d.ts') || l.includes('f.ts'));
    expect(hasNested).toBe(true);
    expect(result.result).not.toContain('c.js');
  });

  it('no matches: returns descriptive message', async () => {
    const result = await executeTool(
      makeTool('glob', { pattern: '*.xyz', cwd: tmpDir }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('No files matched');
  });

  it('invalid/nonexistent cwd path: handled gracefully', async () => {
    const result = await executeTool(
      makeTool('glob', { pattern: '*.ts', cwd: path.join(tmpDir, 'does-not-exist') }),
      tmpDir,
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Error');
  });

  it('error: pattern must be a string', async () => {
    const result = await executeTool(
      makeTool('glob', { pattern: 42 }),
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.result).toContain('pattern must be a string');
  });

  it('results are sorted', async () => {
    const result = await executeTool(
      makeTool('glob', { pattern: '*.ts', cwd: tmpDir }),
      tmpDir,
    );
    const lines = result.result.split('\n').filter(Boolean);
    const sorted = [...lines].sort();
    expect(lines).toEqual(sorted);
  });

  it('? wildcard matches single character', async () => {
    const result = await executeTool(
      makeTool('glob', { pattern: '?.ts', cwd: tmpDir }),
      tmpDir,
    );
    // a.ts and b.ts should match (single char before .ts)
    expect(result.result).toContain('a.ts');
    expect(result.result).toContain('b.ts');
  });

  it('{a,b} brace expansion matches multiple extensions', async () => {
    const result = await executeTool(
      makeTool('glob', { pattern: 'src/*.{ts,json}', cwd: tmpDir }),
      tmpDir,
    );
    const lines = result.result.split('\n').filter(Boolean);
    const hasTs = lines.some(l => l.endsWith('d.ts'));
    const hasJson = lines.some(l => l.endsWith('e.json'));
    expect(hasTs).toBe(true);
    expect(hasJson).toBe(true);
  });
});

// ===========================================================================
// grep tool (#114)
// ===========================================================================

describe('grep tool', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'file1.ts'), [
      'export function hello() {',
      '  return "Hello, World!";',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'file2.ts'), [
      'import { hello } from "./file1.js";',
      'const GREETING = "hello world";',
      'console.log(GREETING);',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils.ts'), [
      'export const PI = 3.14;',
      'export function add(a: number, b: number) { return a + b; }',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'This is a text file\nWith some notes');
  });

  it('basic match: finds the line with matching text', async () => {
    const result = await executeTool(
      makeTool('grep', { pattern: 'hello', path: tmpDir }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('hello');
    // Should include file path and line number format
    expect(result.result).toMatch(/:\d+:/);
  });

  it('case insensitive: matches regardless of case', async () => {
    const result = await executeTool(
      makeTool('grep', { pattern: 'HELLO', path: tmpDir, case_insensitive: true }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    // Should find "hello" (lowercase) due to case insensitive flag
    expect(result.result.toLowerCase()).toContain('hello');
  });

  it('case sensitive by default: does not match wrong case', async () => {
    const result = await executeTool(
      makeTool('grep', { pattern: 'HELLO', path: tmpDir }),
      tmpDir,
    );

    // Only uppercase HELLO should match; files contain lowercase "hello"
    expect(result.isError).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it('no matches: returns "No matches found"', async () => {
    const result = await executeTool(
      makeTool('grep', { pattern: 'ZZZNOMATCH_UNIQUE_STRING', path: tmpDir }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toBe('No matches found');
  });

  it('regex pattern: uses regex matching', async () => {
    const result = await executeTool(
      makeTool('grep', { pattern: 'export (function|const)', path: tmpDir }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('export');
    expect(result.result).toMatch(/:\d+:/);
  });

  it('invalid regex falls back to literal string match', async () => {
    // "[invalid" is not a valid regex — should fallback to literal match and not crash
    const result = await executeTool(
      makeTool('grep', { pattern: '[invalid', path: tmpDir }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it('glob filter: restricts files searched', async () => {
    // Search for "export" only in .txt files — should find nothing
    const resultTxt = await executeTool(
      makeTool('grep', { pattern: 'export', path: tmpDir, glob: '*.txt' }),
      tmpDir,
    );
    expect(resultTxt.result).toBe('No matches found');

    // Search for "export" only in .ts files — should find matches
    const resultTs = await executeTool(
      makeTool('grep', { pattern: 'export', path: tmpDir, glob: '*.ts' }),
      tmpDir,
    );
    expect(resultTs.result).toContain('export');
  });

  it('searching a single file directly', async () => {
    const filePath = path.join(tmpDir, 'file1.ts');
    const result = await executeTool(
      makeTool('grep', { pattern: 'Hello', path: filePath }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('Hello');
  });

  it('error: pattern must be a string', async () => {
    const result = await executeTool(
      makeTool('grep', { pattern: 42 }),
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.result).toContain('pattern must be a string');
  });

  it('path outside scope: blocked', async () => {
    const result = await executeTool(
      makeTool('grep', { pattern: 'root', path: '/etc' }),
      tmpDir,
    );
    expect(result.isError).toBe(true);
    expect(result.result).toContain('Error');
  });

  it('output includes file:line: content format', async () => {
    const result = await executeTool(
      makeTool('grep', { pattern: 'function', path: tmpDir, glob: '*.ts' }),
      tmpDir,
    );

    expect(result.result).toContain('function');
    // Every result line should be in "file:N: content" format
    const lines = result.result.split('\n').filter(Boolean);
    for (const line of lines) {
      expect(line).toMatch(/^.+:\d+: .+/);
    }
  });
});
