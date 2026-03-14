/**
 * Tests for inline file preview and diffs (#119)
 *
 * Covers:
 * - read_file: preview header with line count, 20-line cap, "N more lines" footer
 * - write_file: [new file] header for new files, unified diff for existing files
 * - write_file: diff cap at 50 lines
 * - edit_file: diff of changed section using old_string/new_string
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-preview-test-'));
  resetScope(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// read_file preview
// ===========================================================================

describe('read_file preview header (#119)', () => {
  it('shows all lines with no "more lines" footer for a file <= 20 lines', async () => {
    const filePath = path.join(tmpDir, 'small.txt');
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = await executeTool(makeTool('read_file', { path: filePath }), tmpDir);

    expect(result.isError).toBeUndefined();
    // Header present
    expect(result.result).toMatch(/\[file:.*10 lines\]/);
    // Separator bar present
    expect(result.result).toContain('─');
    // All lines visible in the preview
    for (const line of lines) {
      expect(result.result).toContain(line);
    }
    // No "more lines" footer
    expect(result.result).not.toContain('more lines');
  });

  it('shows exactly 20 lines with no footer for a file with exactly 20 lines', async () => {
    const filePath = path.join(tmpDir, 'exact20.txt');
    const lines = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = await executeTool(makeTool('read_file', { path: filePath }), tmpDir);

    expect(result.isError).toBeUndefined();
    expect(result.result).toMatch(/\[file:.*20 lines\]/);
    expect(result.result).not.toContain('more lines');
    expect(result.result).toContain('row 20');
  });

  it('shows 20 preview lines + "N more lines" footer for a file > 20 lines', async () => {
    const filePath = path.join(tmpDir, 'large.txt');
    const lines = Array.from({ length: 35 }, (_, i) => `entry ${i + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = await executeTool(makeTool('read_file', { path: filePath }), tmpDir);

    expect(result.isError).toBeUndefined();
    // Header shows total line count
    expect(result.result).toMatch(/\[file:.*35 lines\]/);
    // Preview is capped at first 20 lines
    expect(result.result).toContain('entry 1');
    expect(result.result).toContain('entry 20');
    // "more lines" footer appears
    expect(result.result).toContain('15 more lines');
    // Full content also present after double newline
    expect(result.result).toContain('entry 35');
  });

  it('still returns the full file content after the preview section', async () => {
    const filePath = path.join(tmpDir, 'full.ts');
    const content = 'const x = 1;\nconst y = 2;\nconst z = 3;';
    fs.writeFileSync(filePath, content);

    const result = await executeTool(makeTool('read_file', { path: filePath }), tmpDir);

    expect(result.isError).toBeUndefined();
    // The full raw content is embedded in the result
    expect(result.result).toContain(content);
  });
});

// ===========================================================================
// write_file preview
// ===========================================================================

describe('write_file preview header (#119)', () => {
  it('shows [new file] header and no unified diff for a brand new file', async () => {
    const filePath = path.join(tmpDir, 'brand-new.ts');

    const result = await executeTool(
      makeTool('write_file', { path: filePath, content: 'export const x = 1;\n' }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('[wrote:');
    expect(result.result).toContain('[new file:');
    // Should have a diff-style +line
    expect(result.result).toContain('+export const x = 1;');
    // Should NOT have --- a/ (unified diff header only for existing files)
    expect(result.result).not.toContain('--- a/');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('shows [wrote] header and unified diff with -/+ lines for an existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.ts');
    fs.writeFileSync(filePath, 'const a = 1;\nconst b = 2;\n');

    const result = await executeTool(
      makeTool('write_file', { path: filePath, content: 'const a = 1;\nconst b = 99;\n' }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('[wrote:');
    // Unified diff headers present
    expect(result.result).toContain('--- a/');
    expect(result.result).toContain('+++ b/');
    // Changed line visible with - and +
    expect(result.result).toContain('-const b = 2;');
    expect(result.result).toContain('+const b = 99;');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('const a = 1;\nconst b = 99;\n');
  });

  it('returns "File unchanged" when new content is identical to old', async () => {
    const filePath = path.join(tmpDir, 'same.txt');
    const content = 'no changes here\nline 2\nline 3';
    fs.writeFileSync(filePath, content);

    const result = await executeTool(
      makeTool('write_file', { path: filePath, content }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('unchanged');
  });

  it('caps new-file diff output at 50 lines and adds truncation notice', async () => {
    const filePath = path.join(tmpDir, 'huge-new.txt');
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');

    const result = await executeTool(
      makeTool('write_file', { path: filePath, content }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('[new file:');
    // Truncation notice present (format: "... (N more lines)")
    expect(result.result).toContain('more lines');
    // Lines beyond 50 should not appear in the diff section
    // Line 51 in the diff would be "+line 51"
    expect(result.result).not.toContain('+line 51');
    // The raw content still exists in the file
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(content);
  });

  it('caps existing-file diff at 50 lines and adds truncation notice', async () => {
    const filePath = path.join(tmpDir, 'huge-existing.txt');
    const oldLines = Array.from({ length: 60 }, (_, i) => `old ${i + 1}`);
    const newLines = Array.from({ length: 60 }, (_, i) => `new ${i + 1}`);
    fs.writeFileSync(filePath, oldLines.join('\n'));

    const result = await executeTool(
      makeTool('write_file', { path: filePath, content: newLines.join('\n') }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('[wrote:');
    expect(result.result).toContain('truncated');
  });
});

// ===========================================================================
// edit_file preview
// ===========================================================================

describe('edit_file preview header (#119)', () => {
  it('shows a diff of the changed section with - and + lines', async () => {
    const filePath = path.join(tmpDir, 'edit-me.ts');
    fs.writeFileSync(filePath, 'function hello() {\n  return "world";\n}\n');

    const result = await executeTool(
      makeTool('edit_file', {
        path: filePath,
        old_string: 'return "world";',
        new_string: 'return "earth";',
      }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('[edited:');
    expect(result.result).toContain('replaced 1 occurrence');
    expect(result.result).toContain('--- a/');
    expect(result.result).toContain('+++ b/');
    expect(result.result).toContain('-return "world";');
    expect(result.result).toContain('+return "earth";');
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('return "earth";');
  });

  it('shows replace_all count in the header', async () => {
    const filePath = path.join(tmpDir, 'multi.txt');
    fs.writeFileSync(filePath, 'foo\nfoo\nfoo\n');

    const result = await executeTool(
      makeTool('edit_file', {
        path: filePath,
        old_string: 'foo',
        new_string: 'bar',
        replace_all: true,
      }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('replaced 3 occurrences');
    expect(result.result).toContain('-foo');
    expect(result.result).toContain('+bar');
  });

  it('caps edit diff at 50 lines for large old_string/new_string', async () => {
    const filePath = path.join(tmpDir, 'big-edit.txt');
    const oldLines = Array.from({ length: 40 }, (_, i) => `old line ${i + 1}`);
    const newLines = Array.from({ length: 40 }, (_, i) => `new line ${i + 1}`);
    fs.writeFileSync(filePath, oldLines.join('\n'));

    const result = await executeTool(
      makeTool('edit_file', {
        path: filePath,
        old_string: oldLines.join('\n'),
        new_string: newLines.join('\n'),
      }),
      tmpDir,
    );

    expect(result.isError).toBeUndefined();
    expect(result.result).toContain('[edited:');
    // 40 removed + 40 added = 80 lines > 50 cap
    expect(result.result).toContain('truncated');
  });
});
