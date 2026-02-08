import { describe, it, expect } from 'vitest';
import { renderMarkdown, stripMarkdown } from '../src/markdown.js';
import { colors } from '../src/styles.js';

// =============================================================================
// renderMarkdown
// =============================================================================

describe('renderMarkdown', () => {
  // ---------------------------------------------------------------------------
  // Headers
  // ---------------------------------------------------------------------------

  describe('headers', () => {
    it('should render h1 with bold, brightCyan, and underline', () => {
      const result = renderMarkdown('# Hello World');
      expect(result).toContain(colors.bold);
      expect(result).toContain(colors.brightCyan);
      expect(result).toContain(colors.underline);
      expect(result).toContain('Hello World');
      expect(result).toContain(colors.reset);
      // Should strip the "# " prefix
      expect(result).not.toContain('# ');
    });

    it('should render h2 with bold and brightCyan', () => {
      const result = renderMarkdown('## Section');
      expect(result).toContain(colors.bold);
      expect(result).toContain(colors.brightCyan);
      expect(result).toContain('Section');
      // h2 should not have underline
      expect(result).not.toContain(colors.underline);
      expect(result).not.toContain('## ');
    });

    it('should render h3 with bold and cyan', () => {
      const result = renderMarkdown('### Subsection');
      expect(result).toContain(colors.bold);
      expect(result).toContain(colors.cyan);
      expect(result).toContain('Subsection');
      expect(result).not.toContain('### ');
    });

    it('should distinguish h1, h2, h3 styling', () => {
      const h1 = renderMarkdown('# Title');
      const h2 = renderMarkdown('## Title');
      const h3 = renderMarkdown('### Title');
      // h1 has underline, h2 and h3 do not
      expect(h1).toContain(colors.underline);
      expect(h2).not.toContain(colors.underline);
      expect(h3).not.toContain(colors.underline);
      // h3 uses cyan, h1/h2 use brightCyan
      expect(h3).toContain(colors.cyan);
    });
  });

  // ---------------------------------------------------------------------------
  // Inline formatting
  // ---------------------------------------------------------------------------

  describe('inline formatting', () => {
    it('should render bold with **', () => {
      const result = renderMarkdown('This is **bold** text');
      expect(result).toContain(colors.bold);
      expect(result).toContain('bold');
      expect(result).not.toContain('**');
    });

    it('should render bold with __', () => {
      const result = renderMarkdown('This is __bold__ text');
      expect(result).toContain(colors.bold);
      expect(result).toContain('bold');
      expect(result).not.toContain('__');
    });

    it('should render italic with *', () => {
      const result = renderMarkdown('This is *italic* text');
      expect(result).toContain(colors.italic);
      expect(result).toContain('italic');
    });

    it('should render italic with _', () => {
      const result = renderMarkdown('This is _italic_ text');
      expect(result).toContain(colors.italic);
      expect(result).toContain('italic');
    });

    it('should render inline code with backticks', () => {
      const result = renderMarkdown('Use `console.log` for debugging');
      expect(result).toContain(colors.bgGray);
      expect(result).toContain(colors.white);
      expect(result).toContain('console.log');
      expect(result).toContain(colors.reset);
    });

    it('should render links', () => {
      const result = renderMarkdown('Visit [Example](https://example.com)');
      expect(result).toContain(colors.underline);
      expect(result).toContain(colors.blue);
      expect(result).toContain('Example');
      expect(result).toContain('https://example.com');
      expect(result).not.toContain('[Example]');
    });

    it('should handle multiple inline formats in one line', () => {
      const result = renderMarkdown('**bold** and `code` and *italic*');
      expect(result).toContain(colors.bold);
      expect(result).toContain(colors.bgGray);
      expect(result).toContain(colors.italic);
    });
  });

  // ---------------------------------------------------------------------------
  // Lists
  // ---------------------------------------------------------------------------

  describe('lists', () => {
    it('should render unordered list with dash', () => {
      const result = renderMarkdown('- item one');
      expect(result).toContain(colors.cyan);
      // Bullet character
      expect(result).toContain('\u2022');
      expect(result).toContain('item one');
    });

    it('should render unordered list with asterisk', () => {
      const result = renderMarkdown('* item two');
      expect(result).toContain('\u2022');
      expect(result).toContain('item two');
    });

    it('should render unordered list with plus', () => {
      const result = renderMarkdown('+ item three');
      expect(result).toContain('\u2022');
      expect(result).toContain('item three');
    });

    it('should preserve indentation in nested lists', () => {
      const result = renderMarkdown('  - nested item');
      expect(result).toContain('  ');
      expect(result).toContain('\u2022');
      expect(result).toContain('nested item');
    });

    it('should render ordered list items', () => {
      const result = renderMarkdown('1. First item');
      expect(result).toContain(colors.cyan);
      expect(result).toContain('1.');
      expect(result).toContain('First item');
    });

    it('should render multi-digit ordered list numbers', () => {
      const result = renderMarkdown('12. Twelfth item');
      expect(result).toContain('12.');
      expect(result).toContain('Twelfth item');
    });
  });

  // ---------------------------------------------------------------------------
  // Blockquotes
  // ---------------------------------------------------------------------------

  describe('blockquotes', () => {
    it('should render blockquote with dim bar and italic text', () => {
      const result = renderMarkdown('> This is a quote');
      expect(result).toContain(colors.dim);
      expect(result).toContain('\u2502'); // vertical bar
      expect(result).toContain(colors.italic);
      expect(result).toContain('This is a quote');
      // Should strip the "> " prefix
      expect(result).not.toMatch(/> This/);
    });
  });

  // ---------------------------------------------------------------------------
  // Horizontal rules
  // ---------------------------------------------------------------------------

  describe('horizontal rules', () => {
    it('should render --- as a horizontal rule', () => {
      const result = renderMarkdown('---');
      expect(result).toContain(colors.dim);
      expect(result).toContain('\u2500'.repeat(40));
      expect(result).toContain(colors.reset);
    });

    it('should render *** as a horizontal rule', () => {
      const result = renderMarkdown('***');
      expect(result).toContain('\u2500'.repeat(40));
    });

    it('should render ___ as a horizontal rule', () => {
      const result = renderMarkdown('___');
      expect(result).toContain('\u2500'.repeat(40));
    });

    it('should render longer rule markers', () => {
      const result = renderMarkdown('-----');
      expect(result).toContain('\u2500'.repeat(40));
    });
  });

  // ---------------------------------------------------------------------------
  // Code blocks
  // ---------------------------------------------------------------------------

  describe('code blocks', () => {
    it('should render a basic code block', () => {
      const input = '```\nhello world\n```';
      const result = renderMarkdown(input);
      expect(result).toContain('hello world');
      // Code block header with default label
      expect(result).toContain('code');
      // Bottom border
      expect(result).toContain('\u2570');
      expect(result).toContain('\u2500'.repeat(40));
    });

    it('should render a code block with language label', () => {
      const input = '```javascript\nconst x = 1;\n```';
      const result = renderMarkdown(input);
      expect(result).toContain('javascript');
      expect(result).toContain('const');
      expect(result).toContain('x');
    });

    it('should apply syntax highlighting for known languages', () => {
      const input = '```typescript\nconst foo = "bar";\n```';
      const result = renderMarkdown(input);
      // The keyword "const" should get a color applied (magenta for TS keywords)
      expect(result).toContain(colors.magenta);
      // The string "bar" should be highlighted (green for strings)
      expect(result).toContain(colors.green);
    });

    it('should handle language aliases', () => {
      const input = '```js\nconst x = 1;\n```';
      const result = renderMarkdown(input);
      // 'js' maps to 'javascript', so keywords should be highlighted
      expect(result).toContain(colors.magenta);
    });

    it('should handle python code blocks', () => {
      const input = '```python\ndef hello():\n    return True\n```';
      const result = renderMarkdown(input);
      expect(result).toContain('python');
      // Python keywords should be highlighted
      expect(result).toContain(colors.magenta);
    });

    it('should handle unknown language without crashing', () => {
      const input = '```brainfuck\n+++[>++<-]\n```';
      const result = renderMarkdown(input);
      // Should still display the code block
      expect(result).toContain('brainfuck');
      expect(result).toContain('+++[>++<-]');
      // Unknown languages get white color
      expect(result).toContain(colors.white);
    });

    it('should handle multi-line code blocks', () => {
      const input = '```bash\necho "hello"\necho "world"\n```';
      const result = renderMarkdown(input);
      expect(result).toContain('hello');
      expect(result).toContain('world');
      // Each line should be prefixed with the code line marker
      const lines = result.split('\n');
      const codeLines = lines.filter(l => l.includes('\u2502'));
      expect(codeLines.length).toBe(2);
    });

    it('should handle empty code blocks', () => {
      const input = '```\n```';
      const result = renderMarkdown(input);
      // Should still render the code block structure
      expect(result).toContain('code');
    });

    it('should handle unclosed code blocks gracefully', () => {
      const input = '```python\ndef hello():\n    pass';
      const result = renderMarkdown(input);
      // Should still render the code content
      expect(result).toContain('python');
      expect(result).toContain('hello');
      expect(result).toContain('pass');
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed content
  // ---------------------------------------------------------------------------

  describe('mixed content', () => {
    it('should handle multiple elements in sequence', () => {
      const input = [
        '# Title',
        '',
        'Some **bold** text.',
        '',
        '- item 1',
        '- item 2',
        '',
        '```js',
        'const x = 1;',
        '```',
      ].join('\n');
      const result = renderMarkdown(input);
      // Title
      expect(result).toContain('Title');
      expect(result).toContain(colors.underline);
      // Bold
      expect(result).toContain(colors.bold);
      // List bullets
      expect(result).toContain('\u2022');
      // Code block
      expect(result).toContain('const');
    });

    it('should preserve empty lines as-is', () => {
      const result = renderMarkdown('line 1\n\nline 2');
      const lines = result.split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe('');
    });

    it('should pass through plain text unchanged', () => {
      const result = renderMarkdown('Just plain text.');
      expect(result).toBe('Just plain text.');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty string input', () => {
      const result = renderMarkdown('');
      expect(result).toBe('');
    });

    it('should handle input with only newlines', () => {
      const result = renderMarkdown('\n\n\n');
      expect(result).toBe('\n\n\n');
    });

    it('should not treat # without space as a header', () => {
      const result = renderMarkdown('#hashtag');
      expect(result).toBe('#hashtag');
    });

    it('should handle lines that look like headers but are inside code blocks', () => {
      const input = '```\n# not a header\n```';
      const result = renderMarkdown(input);
      // The # should NOT be treated as a header (no brightCyan/underline applied)
      // It should be inside the code block as literal text
      expect(result).not.toContain(colors.underline);
    });

    it('should handle multiple code blocks', () => {
      const input = '```js\nconst a = 1;\n```\n\nSome text\n\n```python\ndef b():\n    pass\n```';
      const result = renderMarkdown(input);
      expect(result).toContain('js');
      expect(result).toContain('python');
      expect(result).toContain('Some text');
    });
  });
});

// =============================================================================
// stripMarkdown
// =============================================================================

describe('stripMarkdown', () => {
  describe('inline formatting removal', () => {
    it('should strip bold (**)', () => {
      expect(stripMarkdown('**bold**')).toBe('bold');
    });

    it('should strip bold (__)', () => {
      expect(stripMarkdown('__bold__')).toBe('bold');
    });

    it('should strip italic (*)', () => {
      expect(stripMarkdown('*italic*')).toBe('italic');
    });

    it('should strip italic (_)', () => {
      expect(stripMarkdown('_italic_')).toBe('italic');
    });

    it('should strip inline code backticks', () => {
      expect(stripMarkdown('Use `code` here')).toBe('Use code here');
    });

    it('should strip link syntax and keep text', () => {
      expect(stripMarkdown('[Example](https://example.com)')).toBe('Example');
    });
  });

  describe('block element removal', () => {
    it('should strip header markers', () => {
      expect(stripMarkdown('# Title')).toBe('Title');
      expect(stripMarkdown('## Section')).toBe('Section');
      expect(stripMarkdown('### Subsection')).toBe('Subsection');
    });

    it('should strip blockquote markers', () => {
      expect(stripMarkdown('> Quoted text')).toBe('Quoted text');
    });

    it('should convert unordered list markers to bullet', () => {
      expect(stripMarkdown('- item')).toBe('\u2022 item');
      expect(stripMarkdown('* item')).toBe('\u2022 item');
      expect(stripMarkdown('+ item')).toBe('\u2022 item');
    });

    it('should preserve ordered list numbers', () => {
      const result = stripMarkdown('1. First');
      expect(result).toContain('1.');
      expect(result).toContain('First');
    });
  });

  describe('code block handling', () => {
    it('should strip code fences but keep content', () => {
      const result = stripMarkdown('```js\nconst x = 1;\n```');
      expect(result).toContain('const x = 1;');
      expect(result).not.toContain('```');
    });

    it('should strip code fences from multi-line blocks', () => {
      const result = stripMarkdown('```\nline1\nline2\n```');
      expect(result).toContain('line1');
      expect(result).toContain('line2');
      expect(result).not.toContain('```');
    });
  });

  describe('combined formatting', () => {
    it('should strip all formatting from complex text', () => {
      const input = '# Hello **World** with `code` and [link](url)';
      const result = stripMarkdown(input);
      expect(result).toBe('Hello World with code and link');
    });

    it('should handle empty string', () => {
      expect(stripMarkdown('')).toBe('');
    });

    it('should return plain text unchanged', () => {
      expect(stripMarkdown('Just plain text')).toBe('Just plain text');
    });
  });
});
