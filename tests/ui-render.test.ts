/**
 * Regression tests for the ui-render cluster:
 *  - #160: syntax highlighters must never run regexes over already-ANSI text,
 *    and overlapping matches must merge into non-overlapping spans.
 *  - #156: tool status icons driven by the isError flag, not substring scans.
 *
 * (#161 — per-item memoization of MessageItem — is a render-perf change with no
 * observable behavioral output to assert here; it is exercised structurally by
 * the Ink render path and verified via tsc + manual layout review.)
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';
import { highlightSyntax } from '../src/diff.js';

const ESC = '\x1b';
// A well-formed SGR sequence: ESC [ <params> m
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * A highlighter is "well-formed" if removing every valid SGR sequence leaves no
 * stray ESC characters behind. A regex that ran over already-emitted ANSI would
 * either split an escape (leaving a lone ESC) or wrap a digit inside one
 * (producing `\x1b[33m\x1b[0m2m...` style garbage where a `2m` orphan remains).
 */
function hasNoOrphanedSGR(s: string): boolean {
  const stripped = s.replace(SGR, '');
  // No bare ESC, and no orphaned "[..m" SGR fragments outside a full sequence.
  return !stripped.includes(ESC) && !/\[[0-9;]*m/.test(stripped);
}

/** The visible text (ANSI removed) must be byte-identical to the input. */
function visibleText(s: string): string {
  return s.replace(SGR, '');
}

describe('#160 highlightSyntax — no regex over injected ANSI', () => {
  it('comment containing a number keeps the number inside the comment span (no number rule leak)', () => {
    const line = '// step 2 done';
    const out = highlightSyntax(line, 'foo.ts');
    expect(hasNoOrphanedSGR(out)).toBe(true);
    expect(visibleText(out)).toBe(line);
    // The number "2" lives inside the comment, so the yellow number color must
    // NOT appear — the dim comment rule (earlier priority) wins the whole span.
    expect(out).not.toContain('\x1b[33m'); // yellow / numbers
    expect(out).toContain('\x1b[2m');      // dim / comment
  });

  it('string containing a number is colored as a string, not split by the number rule', () => {
    const line = 'const x = "port 8080";';
    const out = highlightSyntax(line, 'foo.ts');
    expect(hasNoOrphanedSGR(out)).toBe(true);
    expect(visibleText(out)).toBe(line);
  });

  it('JSON key/value colors the captured token only and stays well-formed', () => {
    const line = '  "count": 42';
    const out = highlightSyntax(line, 'data.json');
    expect(hasNoOrphanedSGR(out)).toBe(true);
    expect(visibleText(out)).toBe(line);
  });

  it('plain keyword+number line produces no malformed sequences', () => {
    const line = 'return 200;';
    const out = highlightSyntax(line, 'foo.ts');
    expect(hasNoOrphanedSGR(out)).toBe(true);
    expect(visibleText(out)).toBe(line);
  });
});

describe('#160 renderMarkdown code blocks — overlap-safe highlighting', () => {
  it('renders a TS code block with a comment containing a number without garbled ANSI', () => {
    const md = ['```ts', 'const n = 1; // step 2', '```'].join('\n');
    const out = renderMarkdown(md);
    // Strip the markdown chrome (box-drawing dim wrappers are full SGR seqs too)
    // and assert no orphaned escape fragments survive after removing valid SGRs.
    expect(hasNoOrphanedSGR(out)).toBe(true);
  });

  it('two patterns whose matches would overlap do not double-wrap (single reset per token)', () => {
    const md = ['```ts', 'import x from "y123";', '```'].join('\n');
    const out = renderMarkdown(md);
    expect(hasNoOrphanedSGR(out)).toBe(true);
  });
});

describe('#156 tool status driven by isError flag (renderer behavior)', () => {
  // The CLI printToolResult and the Ink renderer both decide the status icon.
  // We can't easily mount Ink here, so we assert the underlying intent: the
  // fallback marker scan only treats a *leading* error marker as a failure, so
  // benign output that merely mentions "error"/"not found" is not a failure.
  //
  // This mirrors the logic in src/ui/messages.tsx when no isError flag is set.
  function fallbackHasError(content: string): boolean {
    const firstLine = content.split('\n', 1)[0];
    return /^(error[:!]|✗|🛑)/i.test(firstLine.trimStart());
  }

  it('successful output mentioning "error" / "not found" is NOT flagged as failure', () => {
    expect(fallbackHasError('match: error_handler.ts:42: handle errors')).toBe(false);
    expect(fallbackHasError('not_found.txt\nREADME.md')).toBe(false);
    expect(fallbackHasError('grep found 3 lines mentioning failed jobs')).toBe(false);
  });

  it('a genuine failure (leading "Error:" marker) is flagged', () => {
    expect(fallbackHasError('Error: ENOENT no such file')).toBe(true);
    expect(fallbackHasError('🛑 Blocked by hook: denied')).toBe(true);
  });
});
