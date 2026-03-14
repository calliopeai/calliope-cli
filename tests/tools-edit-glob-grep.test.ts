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
