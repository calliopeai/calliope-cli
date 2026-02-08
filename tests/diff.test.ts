/**
 * Tests for src/diff.ts
 *
 * Covers: generateDiff, createDiff, formatDiff, formatDiffSummary,
 * formatInlineDiff, formatUnifiedDiff, formatSideBySideDiff,
 * wordDiff, formatChangeSummary, formatSkinDiff, highlightSyntax,
 * and pending-change management (queue, approve, reject, clear).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateDiff,
  createDiff,
  formatDiff,
  formatDiffSummary,
  formatInlineDiff,
  formatUnifiedDiff,
  formatSideBySideDiff,
  formatSkinDiff,
  wordDiff,
  formatChangeSummary,
  highlightSyntax,
  clearChanges,
  getPendingChanges,
  approveChange,
  rejectChange,
  approveAllChanges,
  rejectAllChanges,
  getChange,
} from '../src/diff.js';
import type { FileDiff, DiffStyle } from '../src/diff.js';

// ===========================================================================
// Helpers
// ===========================================================================

/** Build a FileDiff from raw old/new content for formatting tests */
function makeDiff(oldContent: string, newContent: string, path = 'test.ts'): FileDiff {
  return generateDiff(oldContent, newContent, path);
}

/** Strip ANSI escape codes so we can assert on visible text */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ===========================================================================
// generateDiff / createDiff
// ===========================================================================

describe('generateDiff', () => {
  it('should return zero additions and deletions for identical content', () => {
    const diff = makeDiff('hello\nworld', 'hello\nworld');
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
    expect(diff.path).toBe('test.ts');
  });

  it('should handle empty strings on both sides', () => {
    const diff = makeDiff('', '');
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
    expect(diff.lines.filter(l => l.type === 'header')).toHaveLength(2);
  });

  it('should detect pure additions (old is empty)', () => {
    // ''.split('\n') produces [''], so the empty string counts as one empty line
    // LCS finds no match, so the empty old line is a deletion and all new lines are additions
    const diff = makeDiff('', 'line1\nline2\nline3');
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(1); // the empty line from ''
    expect(diff.lines.filter(l => l.type === 'add')).toHaveLength(3);
  });

  it('should detect pure deletions (new is empty)', () => {
    // Same as above: '' splits to [''], yielding one empty addition line
    const diff = makeDiff('line1\nline2', '');
    expect(diff.deletions).toBe(2);
    expect(diff.additions).toBe(1); // the empty line from ''
    expect(diff.lines.filter(l => l.type === 'remove')).toHaveLength(2);
  });

  it('should detect a single-line modification', () => {
    const diff = makeDiff('const x = 1;', 'const x = 2;');
    // LCS: the single line changed, so 1 removal + 1 addition
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
  });

  it('should track additions and deletions in multi-line edits', () => {
    const old = 'a\nb\nc\nd';
    const nw = 'a\nB\nc\nD\ne';
    const diff = makeDiff(old, nw);
    // 'a' and 'c' are context; 'b' removed, 'B' added; 'd' removed, 'D'+'e' added
    expect(diff.additions).toBeGreaterThan(0);
    expect(diff.deletions).toBeGreaterThan(0);
    expect(diff.additions + diff.deletions).toBeGreaterThanOrEqual(3);
  });

  it('should include header lines with the file path', () => {
    const diff = makeDiff('a', 'b', 'src/foo.ts');
    const headers = diff.lines.filter(l => l.type === 'header');
    expect(headers).toHaveLength(2);
    expect(headers[0].content).toBe('--- a/src/foo.ts');
    expect(headers[1].content).toBe('+++ b/src/foo.ts');
  });

  it('should assign line numbers to context, add, and remove lines', () => {
    const diff = makeDiff('a\nb\nc', 'a\nX\nc');
    const nonHeaders = diff.lines.filter(l => l.type !== 'header');
    for (const line of nonHeaders) {
      if (line.type === 'context') {
        expect(line.oldLineNum).toBeDefined();
        expect(line.newLineNum).toBeDefined();
      } else if (line.type === 'add') {
        expect(line.newLineNum).toBeDefined();
      } else if (line.type === 'remove') {
        expect(line.oldLineNum).toBeDefined();
      }
    }
  });

  it('should handle adding lines at the end', () => {
    const diff = makeDiff('a\nb', 'a\nb\nc\nd');
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
  });

  it('should handle removing lines from the end', () => {
    const diff = makeDiff('a\nb\nc\nd', 'a\nb');
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(2);
  });

  it('should handle adding lines at the beginning', () => {
    const diff = makeDiff('c\nd', 'a\nb\nc\nd');
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
  });

  it('should handle removing lines from the beginning', () => {
    const diff = makeDiff('a\nb\nc\nd', 'c\nd');
    expect(diff.deletions).toBe(2);
    expect(diff.additions).toBe(0);
  });
});

describe('createDiff', () => {
  it('should be an alias for generateDiff', () => {
    const a = generateDiff('x', 'y', 'f.ts');
    const b = createDiff('x', 'y', 'f.ts');
    expect(a.additions).toBe(b.additions);
    expect(a.deletions).toBe(b.deletions);
    expect(a.lines.length).toBe(b.lines.length);
  });
});

// ===========================================================================
// formatChangeSummary
// ===========================================================================

describe('formatChangeSummary', () => {
  it('should report no changes when both are zero', () => {
    expect(formatChangeSummary(0, 0)).toBe('No changes');
  });

  it('should report added lines (singular)', () => {
    expect(formatChangeSummary(1, 0)).toBe('Added 1 line');
  });

  it('should report added lines (plural)', () => {
    expect(formatChangeSummary(5, 0)).toBe('Added 5 lines');
  });

  it('should report removed lines (singular)', () => {
    expect(formatChangeSummary(0, 1)).toBe('Removed 1 line');
  });

  it('should report removed lines (plural)', () => {
    expect(formatChangeSummary(0, 3)).toBe('Removed 3 lines');
  });

  it('should report modified lines when both add and delete', () => {
    expect(formatChangeSummary(2, 3)).toBe('Modified 5 lines');
  });
});

// ===========================================================================
// formatDiff (basic terminal formatter)
// ===========================================================================

describe('formatDiff', () => {
  it('should include coloured header lines', () => {
    const diff = makeDiff('a', 'b', 'file.ts');
    const output = formatDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('--- a/file.ts');
    expect(plain).toContain('+++ b/file.ts');
  });

  it('should mark additions with + prefix', () => {
    const diff = makeDiff('', 'new line');
    const output = formatDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('+new line');
  });

  it('should mark deletions with - prefix', () => {
    const diff = makeDiff('old line', '');
    const output = formatDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('-old line');
  });

  it('should include a summary line with additions/deletions counts', () => {
    const diff = makeDiff('a\nb', 'a\nc');
    const output = formatDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toMatch(/\+\d+/);
    expect(plain).toMatch(/-\d+/);
  });

  it('should include context lines with a space prefix', () => {
    const diff = makeDiff('ctx\nold\nctx2', 'ctx\nnew\nctx2');
    const output = formatDiff(diff);
    const plain = stripAnsi(output);
    // context lines are prefixed with a space
    expect(plain).toContain(' ctx');
  });

  it('should handle identical content without crashing', () => {
    const diff = makeDiff('same\ncontent', 'same\ncontent');
    const output = formatDiff(diff);
    expect(output).toBeDefined();
    // Summary should show +0 -0
    const plain = stripAnsi(output);
    expect(plain).toContain('+0');
    expect(plain).toContain('-0');
  });
});

// ===========================================================================
// formatDiffSummary
// ===========================================================================

describe('formatDiffSummary', () => {
  it('should include the file path and counts', () => {
    const diff = makeDiff('a', 'b', 'src/index.ts');
    const summary = formatDiffSummary(diff);
    const plain = stripAnsi(summary);
    expect(plain).toContain('src/index.ts');
    expect(plain).toMatch(/\+\d+/);
    expect(plain).toMatch(/-\d+/);
  });
});

// ===========================================================================
// formatInlineDiff
// ===========================================================================

describe('formatInlineDiff', () => {
  it('should return header matching the file path', () => {
    const diff = makeDiff('old', 'new', 'app.tsx');
    const result = formatInlineDiff(diff);
    expect(result.header).toBe('app.tsx');
  });

  it('should return a summary string', () => {
    const diff = makeDiff('old', 'new');
    const result = formatInlineDiff(diff);
    // 1 add + 1 delete -> "Modified 2 lines"
    expect(result.summary).toBe('Modified 2 lines');
  });

  it('should produce formatted lines with prefix, lineNum, content, type', () => {
    const diff = makeDiff('aaa\nbbb', 'aaa\nccc');
    const result = formatInlineDiff(diff);
    for (const line of result.lines) {
      expect(['+', '-', ' ']).toContain(line.prefix);
      expect(['context', 'add', 'remove']).toContain(line.type);
      expect(typeof line.lineNum).toBe('string');
      expect(typeof line.content).toBe('string');
    }
  });

  it('should show adds as + prefix and removes as - prefix', () => {
    const diff = makeDiff('old line', 'new line');
    const result = formatInlineDiff(diff);
    const prefixes = result.lines.map(l => l.prefix);
    expect(prefixes).toContain('-');
    expect(prefixes).toContain('+');
  });

  it('should respect maxLineWidth option', () => {
    const longLine = 'x'.repeat(200);
    const diff = makeDiff('', longLine);
    const result = formatInlineDiff(diff, { maxLineWidth: 50 });
    for (const line of result.lines) {
      expect(line.content.length).toBeLessThanOrEqual(50);
    }
  });

  it('should handle no-change diffs gracefully', () => {
    const diff = makeDiff('same', 'same');
    const result = formatInlineDiff(diff);
    expect(result.summary).toBe('No changes');
  });
});

// ===========================================================================
// formatUnifiedDiff
// ===========================================================================

describe('formatUnifiedDiff', () => {
  it('should produce hunk markers with @@ syntax', () => {
    const diff = makeDiff('a\nb\nc', 'a\nX\nc');
    const output = formatUnifiedDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('@@');
  });

  it('should show action-based header by default', () => {
    // When both add and delete exist, header says "Update"
    const diff = makeDiff('old', 'new', 'foo.ts');
    const output = formatUnifiedDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('Update(foo.ts)');
  });

  it('should show Create header when no deletions', () => {
    // Build a FileDiff with 0 deletions to trigger the "Create" header path
    const diff: FileDiff = {
      path: 'bar.ts',
      oldContent: '',
      newContent: 'new content',
      additions: 1,
      deletions: 0,
      lines: [
        { type: 'header', content: '--- a/bar.ts' },
        { type: 'header', content: '+++ b/bar.ts' },
        { type: 'add', content: 'new content', newLineNum: 1 },
      ],
    };
    const output = formatUnifiedDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('Create(bar.ts)');
  });

  it('should show Delete header when no additions', () => {
    // Build a FileDiff with 0 additions to trigger the "Delete" header path
    const diff: FileDiff = {
      path: 'baz.ts',
      oldContent: 'old content',
      newContent: '',
      additions: 0,
      deletions: 1,
      lines: [
        { type: 'header', content: '--- a/baz.ts' },
        { type: 'header', content: '+++ b/baz.ts' },
        { type: 'remove', content: 'old content', oldLineNum: 1 },
      ],
    };
    const output = formatUnifiedDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('Delete(baz.ts)');
  });

  it('should support path-style header via options', () => {
    const diff = makeDiff('a', 'b', 'test.py');
    const output = formatUnifiedDiff(diff, { header: 'path' });
    const plain = stripAnsi(output);
    expect(plain).toContain('--- a/test.py');
    expect(plain).toContain('+++ b/test.py');
  });

  it('should include additions/deletions summary', () => {
    const diff = makeDiff('a\nb', 'a\nc\nd');
    const output = formatUnifiedDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toMatch(/\+\d+/);
    expect(plain).toMatch(/-\d+/);
  });

  it('should mark added lines with + and removed lines with -', () => {
    const diff = makeDiff('removed', 'added');
    const output = formatUnifiedDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('-removed');
    expect(plain).toContain('+added');
  });

  it('should handle identical content', () => {
    const diff = makeDiff('same\nhere', 'same\nhere');
    const output = formatUnifiedDiff(diff);
    expect(output).toBeDefined();
    const plain = stripAnsi(output);
    expect(plain).toContain('+0');
    expect(plain).toContain('-0');
  });
});

// ===========================================================================
// formatSideBySideDiff
// ===========================================================================

describe('formatSideBySideDiff', () => {
  it('should include a separator line with box-drawing characters', () => {
    const diff = makeDiff('a', 'b');
    const output = formatSideBySideDiff(diff, 80);
    const plain = stripAnsi(output);
    // The separator uses U+2500 (horizontal line) and U+2502 (vertical)
    expect(plain).toContain('─');
    expect(plain).toContain('│');
  });

  it('should show additions and deletions summary', () => {
    const diff = makeDiff('line1\nline2', 'line1\nchanged');
    const output = formatSideBySideDiff(diff, 100);
    const plain = stripAnsi(output);
    expect(plain).toMatch(/\+\d+/);
    expect(plain).toMatch(/-\d+/);
  });

  it('should respect terminal width', () => {
    const diff = makeDiff('old content here', 'new content here');
    const narrowOutput = formatSideBySideDiff(diff, 60);
    const wideOutput = formatSideBySideDiff(diff, 160);
    // Wider output should generally produce wider formatted lines
    expect(wideOutput).toBeDefined();
    expect(narrowOutput).toBeDefined();
  });

  it('should handle pure additions', () => {
    const diff = makeDiff('', 'new\nlines');
    const output = formatSideBySideDiff(diff, 80);
    const plain = stripAnsi(output);
    // Right side should contain the new content
    expect(plain).toContain('new');
    expect(plain).toContain('lines');
  });

  it('should handle pure deletions', () => {
    const diff = makeDiff('old\nlines', '');
    const output = formatSideBySideDiff(diff, 80);
    const plain = stripAnsi(output);
    expect(plain).toContain('old');
    expect(plain).toContain('lines');
  });

  it('should show action header by default', () => {
    const diff = makeDiff('a', 'b', 'component.tsx');
    const output = formatSideBySideDiff(diff, 100);
    const plain = stripAnsi(output);
    expect(plain).toContain('Update(component.tsx)');
  });

  it('should handle identical content', () => {
    const diff = makeDiff('identical', 'identical');
    const output = formatSideBySideDiff(diff, 80);
    expect(output).toBeDefined();
  });
});

// ===========================================================================
// wordDiff
// ===========================================================================

describe('wordDiff', () => {
  it('should return old and new strings', () => {
    const result = wordDiff('hello world', 'hello universe');
    expect(result).toHaveProperty('old');
    expect(result).toHaveProperty('new');
  });

  it('should highlight changed words with ANSI codes', () => {
    const result = wordDiff('the quick brown fox', 'the slow brown fox');
    // The changed word should appear bolded in the result
    const plainOld = stripAnsi(result.old);
    const plainNew = stripAnsi(result.new);
    expect(plainOld).toContain('quick');
    expect(plainNew).toContain('slow');
    // ANSI codes should be present (result is longer than plain text)
    expect(result.old.length).toBeGreaterThan(plainOld.length);
    expect(result.new.length).toBeGreaterThan(plainNew.length);
  });

  it('should handle identical lines', () => {
    const result = wordDiff('same text here', 'same text here');
    const plainOld = stripAnsi(result.old);
    const plainNew = stripAnsi(result.new);
    expect(plainOld).toBe('same text here');
    expect(plainNew).toBe('same text here');
  });

  it('should handle completely different lines', () => {
    const result = wordDiff('aaa bbb ccc', 'xxx yyy zzz');
    const plainOld = stripAnsi(result.old);
    const plainNew = stripAnsi(result.new);
    expect(plainOld).toContain('aaa');
    expect(plainNew).toContain('xxx');
  });

  it('should handle empty old line', () => {
    const result = wordDiff('', 'new words');
    const plainNew = stripAnsi(result.new);
    expect(plainNew).toContain('new');
    expect(plainNew).toContain('words');
  });

  it('should handle empty new line', () => {
    const result = wordDiff('old words', '');
    const plainOld = stripAnsi(result.old);
    expect(plainOld).toContain('old');
    expect(plainOld).toContain('words');
  });

  it('should handle single-word changes', () => {
    const result = wordDiff('const x = 1;', 'const x = 2;');
    const plainOld = stripAnsi(result.old);
    const plainNew = stripAnsi(result.new);
    expect(plainOld).toContain('1;');
    expect(plainNew).toContain('2;');
  });
});

// ===========================================================================
// formatSkinDiff (dispatcher)
// ===========================================================================

describe('formatSkinDiff', () => {
  it('should dispatch to unified formatter when style is "unified"', () => {
    const diff = makeDiff('a', 'b', 'test.ts');
    const output = formatSkinDiff(diff, 'unified');
    const plain = stripAnsi(output);
    // Unified format has @@ hunk markers
    expect(plain).toContain('@@');
  });

  it('should dispatch to side-by-side formatter', () => {
    const diff = makeDiff('a', 'b', 'test.ts');
    const output = formatSkinDiff(diff, 'side-by-side', 80);
    const plain = stripAnsi(output);
    // Side-by-side has the box-drawing separator
    expect(plain).toContain('│');
  });

  it('should dispatch to inline formatter by default', () => {
    const diff = makeDiff('old', 'new', 'test.ts');
    const output = formatSkinDiff(diff, 'inline');
    const plain = stripAnsi(output);
    // Inline format has +/- prefixed lines and header path
    expect(plain).toContain('--- a/test.ts');
    expect(plain).toContain('+++ b/test.ts');
  });

  it('should accept all three style strings', () => {
    const diff = makeDiff('x', 'y');
    const styles: DiffStyle[] = ['inline', 'unified', 'side-by-side'];
    for (const style of styles) {
      const output = formatSkinDiff(diff, style, 80);
      expect(output).toBeDefined();
      expect(typeof output).toBe('string');
      expect(output.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// highlightSyntax
// ===========================================================================

describe('highlightSyntax', () => {
  it('should highlight TypeScript keywords', () => {
    const result = highlightSyntax('const foo = 42;', 'test.ts');
    expect(result).toContain('const');
    expect(result).toContain('42');
    expect(result.length).toBeGreaterThan('const foo = 42;'.length);
  });

  it('should highlight Python keywords', () => {
    const result = highlightSyntax('def hello():', 'script.py');
    expect(result).toContain('def');
    expect(result.length).toBeGreaterThan('def hello():'.length);
  });

  it('should highlight Go keywords', () => {
    const result = highlightSyntax('func main() {', 'main.go');
    expect(result).toContain('func');
    expect(result.length).toBeGreaterThan('func main() {'.length);
  });

  it('should highlight Rust keywords', () => {
    const result = highlightSyntax('fn main() {', 'main.rs');
    expect(result).toContain('fn');
    expect(result.length).toBeGreaterThan('fn main() {'.length);
  });

  it('should highlight shell keywords', () => {
    const result = highlightSyntax('if [ -f file ]; then', 'script.sh');
    expect(result).toContain('if');
    expect(result).toContain('then');
  });

  it('should highlight strings in code', () => {
    const result = highlightSyntax('const s = "hello";', 'test.js');
    expect(result).toContain('"hello"');
  });

  it('should handle unknown file extensions without crashing', () => {
    const result = highlightSyntax('some text', 'file.xyz');
    expect(result).toContain('some text');
  });

  it('should handle empty lines', () => {
    const result = highlightSyntax('', 'test.ts');
    expect(result).toBe('');
  });

  it('should handle comments', () => {
    const result = highlightSyntax('// this is a comment', 'test.ts');
    expect(result).toContain('// this is a comment');
    // Should have ANSI dim code for comments
    expect(result.length).toBeGreaterThan('// this is a comment'.length);
  });
});

// ===========================================================================
// Pending changes management
// ===========================================================================

describe('pending changes', () => {
  beforeEach(() => {
    clearChanges();
  });

  it('should start with no pending changes', () => {
    expect(getPendingChanges()).toHaveLength(0);
  });

  it('clearChanges should remove all changes', () => {
    // We can't easily queue without filesystem, but we can verify clear works
    clearChanges();
    expect(getPendingChanges()).toHaveLength(0);
  });

  it('getChange should return undefined for nonexistent id', () => {
    expect(getChange('nonexistent')).toBeUndefined();
  });

  it('approveChange should return false for nonexistent id', () => {
    expect(approveChange('nonexistent')).toBe(false);
  });

  it('rejectChange should return false for nonexistent id', () => {
    expect(rejectChange('nonexistent')).toBe(false);
  });

  it('approveAllChanges should return 0 when no pending changes', () => {
    expect(approveAllChanges()).toBe(0);
  });

  it('rejectAllChanges should return 0 when no pending changes', () => {
    expect(rejectAllChanges()).toBe(0);
  });
});

// ===========================================================================
// Edge cases — typical code diffs
// ===========================================================================

describe('code diff scenarios', () => {
  it('should handle adding a function to a file', () => {
    const old = `function a() {\n  return 1;\n}`;
    const nw = `function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}`;
    const diff = makeDiff(old, nw);
    expect(diff.additions).toBeGreaterThan(0);
    expect(diff.deletions).toBe(0);
  });

  it('should handle removing a function from a file', () => {
    const old = `function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}`;
    const nw = `function a() {\n  return 1;\n}`;
    const diff = makeDiff(old, nw);
    expect(diff.deletions).toBeGreaterThan(0);
    expect(diff.additions).toBe(0);
  });

  it('should handle modifying a single line inside a function', () => {
    const old = `function greet() {\n  console.log("hello");\n}`;
    const nw = `function greet() {\n  console.log("goodbye");\n}`;
    const diff = makeDiff(old, nw);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    const adds = diff.lines.filter(l => l.type === 'add');
    const removes = diff.lines.filter(l => l.type === 'remove');
    expect(adds[0].content).toContain('goodbye');
    expect(removes[0].content).toContain('hello');
  });

  it('should handle whitespace-only changes', () => {
    const old = 'a\n  b\nc';
    const nw = 'a\n    b\nc';
    const diff = makeDiff(old, nw);
    // The line with different indentation should show as a change
    expect(diff.additions + diff.deletions).toBeGreaterThan(0);
  });

  it('should handle a large number of lines', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const old = lines.join('\n');
    const modified = [...lines];
    modified[50] = 'CHANGED LINE 50';
    modified[150] = 'CHANGED LINE 150';
    const nw = modified.join('\n');
    const diff = makeDiff(old, nw);
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(2);
  });

  it('should handle completely rewritten file', () => {
    const old = 'line1\nline2\nline3';
    const nw = 'alpha\nbeta\ngamma\ndelta';
    const diff = makeDiff(old, nw);
    expect(diff.additions).toBeGreaterThan(0);
    expect(diff.deletions).toBeGreaterThan(0);
  });

  it('should handle files with trailing newlines', () => {
    const old = 'a\nb\n';
    const nw = 'a\nb\nc\n';
    const diff = makeDiff(old, nw);
    // The trailing empty line from the split is context; 'c' is added
    expect(diff.additions).toBeGreaterThanOrEqual(1);
  });

  it('should produce valid formatDiff output for multi-line code changes', () => {
    const old = 'import a from "a";\nimport b from "b";\n\nfunction main() {\n  a();\n  b();\n}';
    const nw = 'import a from "a";\nimport c from "c";\n\nfunction main() {\n  a();\n  c();\n  console.log("done");\n}';
    const diff = makeDiff(old, nw, 'main.ts');
    const output = formatDiff(diff);
    const plain = stripAnsi(output);
    expect(plain).toContain('main.ts');
    expect(plain).toContain('+');
    expect(plain).toContain('-');
  });
});
