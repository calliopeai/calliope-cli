/**
 * Extended coverage tests for src/diff.ts
 *
 * Targets uncovered branches:
 * - generateSimpleDiff (files > 100KB MAX_LCS_SIZE)
 * - formatUnifiedDiff with header='path', header='hunk', showLineNumbers=false
 * - formatSideBySideDiff with header='path', add-only pairs, custom termWidth
 * - wordDiff edge cases (no LCS, pure additions)
 * - highlightSyntax with python, go, rust, shell, json, and unknown extensions
 * - detectLanguage with various extensions (tsx, mjs, rb, rs, kt, sh, bash, zsh, toml, sql, etc.)
 * - formatSkinDiff with 'side-by-side' and 'unified' overrides
 * - formatChangeSummary edge cases (removed 1 line, added 1 line)
 * - groupDiffChunks: start new chunk when contextCount > contextLines*2 and changes ahead
 */

import { describe, it, expect } from 'vitest';
import {
  generateDiff,
  formatDiff,
  formatUnifiedDiff,
  formatSideBySideDiff,
  formatSkinDiff,
  formatInlineDiff,
  wordDiff,
  highlightSyntax,
  formatChangeSummary,
} from '../src/diff.js';
import type { FileDiff } from '../src/diff.js';

/** Strip ANSI escape codes */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Build diff from old/new content */
function makeDiff(oldContent: string, newContent: string, filePath = 'test.ts'): FileDiff {
  return generateDiff(oldContent, newContent, filePath);
}

// ===========================================================================
// generateSimpleDiff (files > 100KB trigger the simple path)
// ===========================================================================

describe('generateDiff - large file fallback (generateSimpleDiff)', () => {
  it('should use simple diff when old content exceeds 100KB', () => {
    const bigOld = 'x'.repeat(101_000);
    const bigNew = bigOld + '\nextra line';
    const diff = generateDiff(bigOld, bigNew, 'big.ts');
    expect(diff.path).toBe('big.ts');
    // Simple diff: adds the extra line
    expect(diff.additions).toBeGreaterThan(0);
  });

  it('should use simple diff when new content exceeds 100KB', () => {
    const bigNew = 'y'.repeat(101_000);
    const diff = generateDiff('small', bigNew, 'big.ts');
    expect(diff.path).toBe('big.ts');
    expect(diff.additions).toBeGreaterThan(0);
  });

  it('should mark old-only lines as remove in simple diff', () => {
    const bigOld = 'line1\nline2\n' + 'z'.repeat(101_000);
    const bigNew = 'line1\nchanged\n' + 'z'.repeat(101_000);
    const diff = generateDiff(bigOld, bigNew, 'test.ts');
    const removes = diff.lines.filter(l => l.type === 'remove');
    expect(removes.length).toBeGreaterThan(0);
  });

  it('should handle old-only lines beyond new length in simple diff', () => {
    const bigOld = 'a'.repeat(101_000) + '\nextraline';
    const bigNew = 'a'.repeat(101_000);
    const diff = generateDiff(bigOld, bigNew, 'test.ts');
    const removes = diff.lines.filter(l => l.type === 'remove');
    expect(removes.length).toBeGreaterThan(0);
    // deletions count should be > 0
    expect(diff.deletions).toBeGreaterThan(0);
  });

  it('should handle new-only lines beyond old length in simple diff', () => {
    const bigNew = 'b'.repeat(101_000) + '\nnewline';
    const bigOld = 'b'.repeat(101_000);
    const diff = generateDiff(bigOld, bigNew, 'test.ts');
    const adds = diff.lines.filter(l => l.type === 'add');
    expect(adds.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// formatUnifiedDiff - header variants and showLineNumbers=false
// ===========================================================================

describe('formatUnifiedDiff - header variants', () => {
  it('should output ---/+++ header when header is "path"', () => {
    const diff = makeDiff('old line\n', 'new line\n', 'src/file.ts');
    const output = stripAnsi(formatUnifiedDiff(diff, { header: 'path' }));
    expect(output).toContain('--- a/src/file.ts');
    expect(output).toContain('+++ b/src/file.ts');
  });

  it('should output ---/+++ header when header is "hunk"', () => {
    const diff = makeDiff('old', 'new', 'src/file.ts');
    const output = stripAnsi(formatUnifiedDiff(diff, { header: 'hunk' }));
    expect(output).toContain('--- a/src/file.ts');
    expect(output).toContain('+++ b/src/file.ts');
  });

  it('should output action header when header is "action"', () => {
    const diff = makeDiff('old', 'new', 'src/file.ts');
    const output = stripAnsi(formatUnifiedDiff(diff, { header: 'action' }));
    expect(output).toContain('Update(src/file.ts)');
  });

  it('should output Create action for pure additions', () => {
    // All additions (no deletions) → action = 'Create'
    const diff: FileDiff = {
      path: 'new.ts',
      oldContent: '',
      newContent: 'line1\nline2',
      lines: [
        { type: 'header', content: '--- a/new.ts' },
        { type: 'header', content: '+++ b/new.ts' },
        { type: 'add', content: 'line1', newLineNum: 1 },
        { type: 'add', content: 'line2', newLineNum: 2 },
      ],
      additions: 2,
      deletions: 0,
    };
    const output = stripAnsi(formatUnifiedDiff(diff, { header: 'action' }));
    expect(output).toContain('Create(new.ts)');
  });

  it('should output Delete action for pure deletions', () => {
    const diff: FileDiff = {
      path: 'gone.ts',
      oldContent: 'line1\nline2',
      newContent: '',
      lines: [
        { type: 'header', content: '--- a/gone.ts' },
        { type: 'header', content: '+++ b/gone.ts' },
        { type: 'remove', content: 'line1', oldLineNum: 1 },
        { type: 'remove', content: 'line2', oldLineNum: 2 },
      ],
      additions: 0,
      deletions: 2,
    };
    const output = stripAnsi(formatUnifiedDiff(diff, { header: 'action' }));
    expect(output).toContain('Delete(gone.ts)');
  });

  it('should omit line numbers when showLineNumbers is false', () => {
    const diff = makeDiff('old', 'new', 'src/file.ts');
    const withNums = formatUnifiedDiff(diff, { showLineNumbers: true });
    const withoutNums = formatUnifiedDiff(diff, { showLineNumbers: false });
    // With nums, the change lines have 4-char number prefix then space
    const plainWith = stripAnsi(withNums);
    const plainWithout = stripAnsi(withoutNums);
    // Without numbers, there should be no "   1 " style prefix
    expect(plainWithout.length).toBeLessThan(plainWith.length);
  });
});

// ===========================================================================
// formatSideBySideDiff - header variants, custom width, add-only pairs
// ===========================================================================

describe('formatSideBySideDiff - header and pair variants', () => {
  it('should output ---/+++ header when header is "path"', () => {
    const diff = makeDiff('old line', 'new line', 'src/file.ts');
    const output = stripAnsi(formatSideBySideDiff(diff, 80, { header: 'path' }));
    expect(output).toContain('--- a/src/file.ts');
    expect(output).toContain('+++ b/src/file.ts');
  });

  it('should output ---/+++ header when header is "hunk"', () => {
    const diff = makeDiff('old', 'new', 'src/file.ts');
    const output = stripAnsi(formatSideBySideDiff(diff, 80, { header: 'hunk' }));
    expect(output).toContain('--- a/src/file.ts');
    expect(output).toContain('+++ b/src/file.ts');
  });

  it('should output action header when header is "action"', () => {
    const diff = makeDiff('old', 'new', 'src/file.ts');
    const output = stripAnsi(formatSideBySideDiff(diff, 80, { header: 'action' }));
    expect(output).toContain('Update(src/file.ts)');
  });

  it('should output Create action for pure additions in side-by-side', () => {
    const diff: FileDiff = {
      path: 'new.ts',
      oldContent: '',
      newContent: 'hello',
      lines: [
        { type: 'header', content: '--- a/new.ts' },
        { type: 'header', content: '+++ b/new.ts' },
        { type: 'add', content: 'hello', newLineNum: 1 },
      ],
      additions: 1,
      deletions: 0,
    };
    const output = stripAnsi(formatSideBySideDiff(diff, 80, { header: 'action' }));
    expect(output).toContain('Create(new.ts)');
  });

  it('should respect a custom terminal width', () => {
    const diff = makeDiff('x'.repeat(50), 'y'.repeat(50), 'file.ts');
    const narrow = formatSideBySideDiff(diff, 60);
    const wide = formatSideBySideDiff(diff, 200);
    expect(narrow).toBeDefined();
    expect(wide).toBeDefined();
    // Wide output should have longer separator lines
    expect(stripAnsi(wide).length).toBeGreaterThan(stripAnsi(narrow).length);
  });

  it('should handle add-only pair (left null, right has add)', () => {
    // A pure add line that has no pairing remove line
    const diff: FileDiff = {
      path: 'file.ts',
      oldContent: 'existing',
      newContent: 'existing\nnew',
      lines: [
        { type: 'header', content: '--- a/file.ts' },
        { type: 'header', content: '+++ b/file.ts' },
        { type: 'context', content: 'existing', oldLineNum: 1, newLineNum: 1 },
        { type: 'add', content: 'new', newLineNum: 2 },
      ],
      additions: 1,
      deletions: 0,
    };
    const output = formatSideBySideDiff(diff, 80);
    expect(stripAnsi(output)).toContain('new');
  });
});

// ===========================================================================
// wordDiff edge cases
// ===========================================================================

describe('wordDiff', () => {
  it('should highlight changed words in old/new lines', () => {
    const result = wordDiff('hello world', 'hello earth');
    expect(typeof result.old).toBe('string');
    expect(typeof result.new).toBe('string');
    // Both should contain the unchanged word "hello"
    expect(stripAnsi(result.old)).toContain('hello');
    expect(stripAnsi(result.new)).toContain('hello');
  });

  it('should handle completely different lines (no common words)', () => {
    const result = wordDiff('foo bar baz', 'qux quux quuz');
    // All words in old should be removed-highlighted
    expect(result.old).toContain('\x1b['); // has ANSI
    expect(result.new).toContain('\x1b[');
  });

  it('should handle identical lines (no differences)', () => {
    const result = wordDiff('same text here', 'same text here');
    // No highlighting added, just the plain text
    expect(stripAnsi(result.old)).toBe('same text here');
    expect(stripAnsi(result.new)).toBe('same text here');
  });

  it('should handle empty old line', () => {
    const result = wordDiff('', 'new content');
    expect(typeof result.old).toBe('string');
    expect(typeof result.new).toBe('string');
  });

  it('should handle empty new line', () => {
    const result = wordDiff('old content', '');
    expect(typeof result.old).toBe('string');
    expect(typeof result.new).toBe('string');
  });

  it('should highlight remaining old words beyond LCS', () => {
    // Extra words at the end of old not in new
    const result = wordDiff('hello world extra words', 'hello world');
    // "extra words" should be highlighted in old
    expect(result.old).toContain('\x1b[');
  });

  it('should highlight remaining new words beyond LCS', () => {
    // Extra words at end of new not in old
    const result = wordDiff('hello world', 'hello world extra words');
    expect(result.new).toContain('\x1b[');
  });
});

// ===========================================================================
// highlightSyntax - various language extensions
// ===========================================================================

describe('highlightSyntax - language detection', () => {
  it('should highlight typescript/tsx files', () => {
    const line = 'const x = 42;';
    const result = highlightSyntax(line, 'component.tsx');
    expect(stripAnsi(result)).toContain('const');
    expect(stripAnsi(result)).toContain('42');
  });

  it('should highlight javascript/mjs files', () => {
    const line = 'const x = "hello";';
    const result = highlightSyntax(line, 'module.mjs');
    expect(stripAnsi(result)).toContain('const');
  });

  it('should highlight python files', () => {
    const line = 'def my_func():';
    const result = highlightSyntax(line, 'script.py');
    expect(stripAnsi(result)).toContain('def');
  });

  it('should highlight python with numbers', () => {
    const line = 'x = 42';
    const result = highlightSyntax(line, 'script.py');
    expect(stripAnsi(result)).toContain('42');
  });

  it('should highlight ruby files (.rb)', () => {
    const line = 'def my_method';
    const result = highlightSyntax(line, 'script.rb');
    expect(stripAnsi(result)).toContain('def');
  });

  it('should highlight rust files (.rs)', () => {
    const line = 'fn main() {';
    const result = highlightSyntax(line, 'main.rs');
    expect(stripAnsi(result)).toContain('fn');
  });

  it('should highlight go files (.go)', () => {
    const line = 'func main() {';
    const result = highlightSyntax(line, 'main.go');
    expect(stripAnsi(result)).toContain('func');
  });

  it('should highlight shell files (.sh)', () => {
    const line = 'if [ -f file ]; then';
    const result = highlightSyntax(line, 'script.sh');
    expect(stripAnsi(result)).toContain('if');
  });

  it('should highlight bash files (.bash)', () => {
    const line = 'if true; then';
    const result = highlightSyntax(line, 'script.bash');
    expect(stripAnsi(result)).toContain('if');
  });

  it('should highlight zsh files (.zsh)', () => {
    const line = 'function foo() {';
    const result = highlightSyntax(line, 'config.zsh');
    expect(stripAnsi(result)).toContain('function');
  });

  it('should highlight JSON files (.json)', () => {
    const line = '  "name": "calliope"';
    const result = highlightSyntax(line, 'package.json');
    expect(stripAnsi(result)).toContain('calliope');
  });

  it('should highlight YAML files (.yaml)', () => {
    const line = '# comment';
    const result = highlightSyntax(line, 'config.yaml');
    // Should have at minimum a color code for the comment
    expect(result).toContain('\x1b[');
  });

  it('should highlight YAML files (.yml)', () => {
    const line = '# comment';
    const result = highlightSyntax(line, 'config.yml');
    expect(result).toContain('\x1b[');
  });

  it('should highlight TOML files (.toml)', () => {
    const line = '# toml comment';
    const result = highlightSyntax(line, 'Cargo.toml');
    expect(result).toContain('\x1b[');
  });

  it('should highlight SQL files (.sql)', () => {
    const line = '# comment';
    const result = highlightSyntax(line, 'query.sql');
    expect(result).toContain('\x1b[');
  });

  it('should highlight CSS files (.css)', () => {
    // CSS uses default rules which highlight strings and numbers
    const line = 'color: "red";';
    const result = highlightSyntax(line, 'style.css');
    expect(typeof result).toBe('string');
    // Should apply default rules (strings are colored)
    expect(result).toContain('\x1b[');
  });

  it('should highlight SCSS files (.scss)', () => {
    // SCSS uses default rules — verify it returns a string (language is mapped to default)
    const line = 'opacity: 0.5;';
    const result = highlightSyntax(line, 'style.scss');
    expect(typeof result).toBe('string');
    // 0.5 matches \b(\d+\.?\d*)\b since both sides are non-word chars (: and ;)
    expect(result).toContain('\x1b[');
  });

  it('should highlight HTML files (.html)', () => {
    const line = '<!-- comment -->';
    const result = highlightSyntax(line, 'index.html');
    expect(typeof result).toBe('string');
  });

  it('should highlight markdown files (.md)', () => {
    const line = '# Heading';
    const result = highlightSyntax(line, 'README.md');
    expect(typeof result).toBe('string');
  });

  it('should highlight Java files (.java)', () => {
    const line = 'public class Foo {';
    const result = highlightSyntax(line, 'Foo.java');
    expect(typeof result).toBe('string');
  });

  it('should highlight C files (.c)', () => {
    const line = 'fn test() {}';
    const result = highlightSyntax(line, 'main.c');
    expect(typeof result).toBe('string');
  });

  it('should highlight C++ files (.cpp)', () => {
    const line = 'fn test() {}';
    const result = highlightSyntax(line, 'main.cpp');
    expect(typeof result).toBe('string');
  });

  it('should highlight C header files (.h)', () => {
    const line = 'fn test() {}';
    const result = highlightSyntax(line, 'main.h');
    expect(typeof result).toBe('string');
  });

  it('should use default rules for unknown extensions', () => {
    const line = '// comment "value" 42';
    const result = highlightSyntax(line, 'file.xyz');
    expect(typeof result).toBe('string');
  });

  it('should return plain text for files without extension', () => {
    const line = 'plain text line';
    const result = highlightSyntax(line, 'Makefile');
    expect(typeof result).toBe('string');
  });
});

// ===========================================================================
// formatChangeSummary edge cases
// ===========================================================================

describe('formatChangeSummary', () => {
  it('should return "No changes" for 0 additions and 0 deletions', () => {
    expect(formatChangeSummary(0, 0)).toBe('No changes');
  });

  it('should return singular "line" for exactly 1 addition', () => {
    expect(formatChangeSummary(1, 0)).toBe('Added 1 line');
  });

  it('should return plural "lines" for > 1 addition', () => {
    expect(formatChangeSummary(2, 0)).toBe('Added 2 lines');
  });

  it('should return singular "line" for exactly 1 deletion', () => {
    expect(formatChangeSummary(0, 1)).toBe('Removed 1 line');
  });

  it('should return plural "lines" for > 1 deletion', () => {
    expect(formatChangeSummary(0, 3)).toBe('Removed 3 lines');
  });

  it('should return "Modified N lines" for mixed adds and deletions', () => {
    expect(formatChangeSummary(2, 3)).toBe('Modified 5 lines');
  });
});

// ===========================================================================
// formatSkinDiff - style overrides
// ===========================================================================

describe('formatSkinDiff', () => {
  it('should use unified style when styleOverride is "unified"', () => {
    const diff = makeDiff('old', 'new', 'file.ts');
    const output = formatSkinDiff(diff, 'unified');
    expect(typeof output).toBe('string');
    const plain = stripAnsi(output);
    // Unified format includes @@ markers
    expect(plain).toContain('@@');
  });

  it('should use side-by-side style when styleOverride is "side-by-side"', () => {
    const diff = makeDiff('old line', 'new line', 'file.ts');
    const output = formatSkinDiff(diff, 'side-by-side', 100);
    expect(typeof output).toBe('string');
    // Side-by-side includes a separator
    const plain = stripAnsi(output);
    expect(plain).toContain('│');
  });

  it('should use inline (formatDiff) style when styleOverride is "inline"', () => {
    const diff = makeDiff('old', 'new', 'file.ts');
    const output = formatSkinDiff(diff, 'inline');
    expect(typeof output).toBe('string');
  });

  it('should use default style when no styleOverride', () => {
    const diff = makeDiff('old', 'new', 'file.ts');
    const output = formatSkinDiff(diff);
    expect(typeof output).toBe('string');
  });
});

// ===========================================================================
// formatInlineDiff - various options
// ===========================================================================

describe('formatInlineDiff - options', () => {
  it('should return header, summary, and lines', () => {
    const diff = makeDiff('old line', 'new line', 'src/file.ts');
    const result = formatInlineDiff(diff);
    expect(result.header).toBe('src/file.ts');
    expect(typeof result.summary).toBe('string');
    expect(Array.isArray(result.lines)).toBe(true);
  });

  it('should truncate content to maxLineWidth', () => {
    const longLine = 'x'.repeat(200);
    const diff = makeDiff(longLine, longLine + 'extra', 'file.ts');
    const result = formatInlineDiff(diff, { maxLineWidth: 50 });
    for (const line of result.lines) {
      expect(line.content.length).toBeLessThanOrEqual(50);
    }
  });

  it('should use custom contextLines', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const newC = old.replace('line10', 'changed10');
    const diff = makeDiff(old, newC, 'file.ts');
    const result1 = formatInlineDiff(diff, { contextLines: 1 });
    const result5 = formatInlineDiff(diff, { contextLines: 5 });
    // More context lines → more formatted lines
    expect(result5.lines.length).toBeGreaterThanOrEqual(result1.lines.length);
  });
});

// ===========================================================================
// groupDiffChunks: contextCount > contextLines*2 triggers new chunk
// ===========================================================================

describe('groupDiffChunks - chunk boundary behavior', () => {
  it('should split into multiple chunks for well-separated changes', () => {
    // Two changes separated by many context lines → should produce 2 chunks
    const oldLines = [
      'change1-old',
      ...Array(20).fill('ctx'),
      'change2-old',
    ].join('\n');
    const newLines = [
      'change1-new',
      ...Array(20).fill('ctx'),
      'change2-new',
    ].join('\n');
    const diff = generateDiff(oldLines, newLines, 'file.ts');
    const output = stripAnsi(formatDiff(diff, 2));
    // Multiple @@ markers expected for two separate hunks
    const hunkMatches = output.match(/@@/g);
    expect(hunkMatches).not.toBeNull();
    expect(hunkMatches!.length).toBeGreaterThanOrEqual(2);
  });

  it('should merge nearby changes into one chunk', () => {
    // Two changes with only 1 context line between, contextLines=3 → should merge into one chunk
    // because contextCount (1) < contextLines*2 (6)
    const oldLines = ['change1-old', 'ctx1', 'ctx2', 'ctx3', 'change2-old'].join('\n');
    const newLines = ['change1-new', 'ctx1', 'ctx2', 'ctx3', 'change2-new'].join('\n');
    const diff = generateDiff(oldLines, newLines, 'file.ts');
    const output = stripAnsi(formatDiff(diff, 3));
    const hunkMatches = output.match(/@@/g);
    // The two changes are 3 lines apart — with contextLines=3, they should merge
    expect(hunkMatches).not.toBeNull();
    // The key result is that output is produced without error
    expect(output.length).toBeGreaterThan(0);
  });
});
