import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  colorFg,
  colorBg,
  bold,
  dim,
  detectBestMode,
  getTerminalImageInfo,
  renderBanner,
  renderAsciiArt,
  renderSkinBanner,
  renderColoredBanner,
  renderSplashAnimation,
  renderTransition,
  getImageModeLabel,
  type ImageMode,
  type TransitionConfig,
} from '../src/terminal-image.js';

// ============================================================================
// ANSI Color Helpers
// ============================================================================

describe('colorFg', () => {
  it('should apply 24-bit ANSI foreground color for valid hex', () => {
    const result = colorFg('hello', '#FF0000');
    expect(result).toContain('\x1b[38;2;255;0;0m');
    expect(result).toContain('hello');
    expect(result).toContain('\x1b[0m');
  });

  it('should handle hex without leading #', () => {
    const result = colorFg('test', 'FF0000');
    expect(result).toContain('\x1b[38;2;255;0;0m');
    expect(result).toContain('test');
  });

  it('should handle white (#FFFFFF)', () => {
    const result = colorFg('x', '#FFFFFF');
    expect(result).toContain('\x1b[38;2;255;255;255m');
  });

  it('should handle black (#000000)', () => {
    const result = colorFg('x', '#000000');
    expect(result).toContain('\x1b[38;2;0;0;0m');
  });

  it('should handle mixed case hex values', () => {
    const result = colorFg('x', '#aaBBcc');
    expect(result).toContain('\x1b[38;2;170;187;204m');
  });

  it('should return text unchanged for invalid hex', () => {
    expect(colorFg('hello', 'not-hex')).toBe('hello');
    expect(colorFg('hello', '#GG0000')).toBe('hello');
    expect(colorFg('hello', '#FF')).toBe('hello');
    expect(colorFg('hello', '')).toBe('hello');
  });

  it('should handle empty text', () => {
    const result = colorFg('', '#FF0000');
    expect(result).toContain('\x1b[38;2;255;0;0m');
    expect(result).toContain('\x1b[0m');
  });

  it('should handle text with special characters', () => {
    const result = colorFg('hello\nworld', '#00FF00');
    expect(result).toContain('hello\nworld');
    expect(result).toContain('\x1b[38;2;0;255;0m');
  });

  it('should produce correct RGB values for an arbitrary color', () => {
    // #1A2B3C => r=26, g=43, b=60
    const result = colorFg('test', '#1A2B3C');
    expect(result).toContain('\x1b[38;2;26;43;60m');
  });
});

describe('colorBg', () => {
  it('should apply 24-bit ANSI background color for valid hex', () => {
    const result = colorBg('hello', '#00FF00');
    expect(result).toContain('\x1b[48;2;0;255;0m');
    expect(result).toContain('hello');
    expect(result).toContain('\x1b[0m');
  });

  it('should return text unchanged for invalid hex', () => {
    expect(colorBg('hello', 'xyz')).toBe('hello');
  });
});

describe('bold', () => {
  it('should wrap text with bold ANSI codes', () => {
    const result = bold('test');
    expect(result).toBe('\x1b[1mtest\x1b[0m');
  });

  it('should handle empty text', () => {
    const result = bold('');
    expect(result).toBe('\x1b[1m\x1b[0m');
  });
});

describe('dim', () => {
  it('should wrap text with dim ANSI codes', () => {
    const result = dim('test');
    expect(result).toBe('\x1b[2mtest\x1b[0m');
  });

  it('should handle empty text', () => {
    const result = dim('');
    expect(result).toBe('\x1b[2m\x1b[0m');
  });
});

// ============================================================================
// hexToRgb (tested indirectly through colorFg)
// ============================================================================

describe('hexToRgb (via colorFg)', () => {
  it('should correctly parse 6-digit hex with #', () => {
    const result = colorFg('x', '#AB12EF');
    // AB=171, 12=18, EF=239
    expect(result).toContain('\x1b[38;2;171;18;239m');
  });

  it('should correctly parse 6-digit hex without #', () => {
    const result = colorFg('x', 'AB12EF');
    expect(result).toContain('\x1b[38;2;171;18;239m');
  });

  it('should reject 3-digit shorthand hex', () => {
    // hexToRgb only matches 6-digit hex
    expect(colorFg('x', '#F00')).toBe('x');
  });

  it('should reject 8-digit hex (with alpha)', () => {
    expect(colorFg('x', '#FF000080')).toBe('x');
  });
});

// ============================================================================
// Terminal Capability Detection
// ============================================================================

describe('detectBestMode', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Create a clean env for each test so env vars don't leak
    process.env = { ...originalEnv };
    // Clear all the detection-relevant env vars
    delete process.env.ITERM_SESSION_ID;
    delete process.env.LC_TERMINAL;
    delete process.env.TERM_PROGRAM;
    delete process.env.KITTY_PID;
    delete process.env.TERM;
    delete process.env.GHOSTTY_RESOURCES_DIR;
    delete process.env.COLORTERM;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // iTerm2 detection
  it('should detect iterm2 when ITERM_SESSION_ID is set', () => {
    process.env.ITERM_SESSION_ID = 'some-session-id';
    expect(detectBestMode()).toBe('iterm2');
  });

  it('should detect iterm2 when LC_TERMINAL is iTerm2', () => {
    process.env.LC_TERMINAL = 'iTerm2';
    expect(detectBestMode()).toBe('iterm2');
  });

  it('should detect iterm2 when TERM_PROGRAM is iTerm.app', () => {
    process.env.TERM_PROGRAM = 'iTerm.app';
    expect(detectBestMode()).toBe('iterm2');
  });

  it('should detect iterm2 when TERM_PROGRAM is WezTerm', () => {
    process.env.TERM_PROGRAM = 'WezTerm';
    expect(detectBestMode()).toBe('iterm2');
  });

  // Kitty detection
  it('should detect kitty when KITTY_PID is set', () => {
    process.env.KITTY_PID = '12345';
    expect(detectBestMode()).toBe('kitty');
  });

  it('should detect kitty when TERM is xterm-kitty', () => {
    process.env.TERM = 'xterm-kitty';
    expect(detectBestMode()).toBe('kitty');
  });

  it('should detect kitty when GHOSTTY_RESOURCES_DIR is set', () => {
    process.env.GHOSTTY_RESOURCES_DIR = '/some/path';
    expect(detectBestMode()).toBe('kitty');
  });

  // Truecolor detection
  it('should detect halfblock when COLORTERM is truecolor', () => {
    process.env.COLORTERM = 'truecolor';
    expect(detectBestMode()).toBe('halfblock');
  });

  it('should detect halfblock when COLORTERM is 24bit', () => {
    process.env.COLORTERM = '24bit';
    expect(detectBestMode()).toBe('halfblock');
  });

  // Fallback
  it('should fall back to ascii when no special env vars are set', () => {
    expect(detectBestMode()).toBe('ascii');
  });

  // Priority: iTerm2 > Kitty > halfblock
  it('should prefer iterm2 over kitty when both env vars are set', () => {
    process.env.ITERM_SESSION_ID = 'session';
    process.env.KITTY_PID = '12345';
    expect(detectBestMode()).toBe('iterm2');
  });

  it('should prefer iterm2 over halfblock when both env vars are set', () => {
    process.env.TERM_PROGRAM = 'WezTerm';
    process.env.COLORTERM = 'truecolor';
    expect(detectBestMode()).toBe('iterm2');
  });

  it('should prefer kitty over halfblock when both env vars are set', () => {
    process.env.KITTY_PID = '12345';
    process.env.COLORTERM = 'truecolor';
    expect(detectBestMode()).toBe('kitty');
  });
});

describe('getTerminalImageInfo', () => {
  const originalEnv = process.env;
  const originalColumns = process.stdout.columns;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.ITERM_SESSION_ID;
    delete process.env.LC_TERMINAL;
    delete process.env.TERM_PROGRAM;
    delete process.env.KITTY_PID;
    delete process.env.TERM;
    delete process.env.GHOSTTY_RESOURCES_DIR;
    delete process.env.COLORTERM;
    delete process.env.COLUMNS;
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, writable: true });
  });

  it('should return an object with mode, truecolor, and width', () => {
    const info = getTerminalImageInfo();
    expect(info).toHaveProperty('mode');
    expect(info).toHaveProperty('truecolor');
    expect(info).toHaveProperty('width');
  });

  it('should detect truecolor when COLORTERM is truecolor', () => {
    process.env.COLORTERM = 'truecolor';
    const info = getTerminalImageInfo();
    expect(info.truecolor).toBe(true);
  });

  it('should detect truecolor when COLORTERM is 24bit', () => {
    process.env.COLORTERM = '24bit';
    const info = getTerminalImageInfo();
    expect(info.truecolor).toBe(true);
  });

  it('should not detect truecolor when COLORTERM is not set', () => {
    const info = getTerminalImageInfo();
    expect(info.truecolor).toBe(false);
  });

  it('should use COLUMNS env var for width', () => {
    process.env.COLUMNS = '120';
    const info = getTerminalImageInfo();
    expect(info.width).toBe(120);
  });

  it('should fall back to 80 when no column info is available', () => {
    Object.defineProperty(process.stdout, 'columns', { value: undefined, writable: true });
    const info = getTerminalImageInfo();
    expect(info.width).toBe(80);
  });
});

// ============================================================================
// getImageModeLabel
// ============================================================================

describe('getImageModeLabel', () => {
  it('should return correct label for iterm2', () => {
    expect(getImageModeLabel('iterm2')).toBe('iTerm2 Inline Image');
  });

  it('should return correct label for kitty', () => {
    expect(getImageModeLabel('kitty')).toBe('Kitty Graphics Protocol');
  });

  it('should return correct label for halfblock', () => {
    expect(getImageModeLabel('halfblock')).toBe('Unicode Half-Block');
  });

  it('should return correct label for braille', () => {
    expect(getImageModeLabel('braille')).toBe('Braille Dots');
  });

  it('should return correct label for ascii', () => {
    expect(getImageModeLabel('ascii')).toBe('ASCII');
  });

  it('should return correct label for none', () => {
    expect(getImageModeLabel('none')).toBe('None');
  });

  it('should cover all ImageMode values', () => {
    const allModes: ImageMode[] = ['iterm2', 'kitty', 'halfblock', 'braille', 'ascii', 'none'];
    for (const mode of allModes) {
      const label = getImageModeLabel(mode);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// renderBanner
// ============================================================================

describe('renderBanner', () => {
  it('should render text-only for "none" mode', () => {
    const result = renderBanner('Hello World', 'none');
    expect(result).toBe('Hello World');
    // Should not contain any box-drawing characters
    expect(result).not.toContain('\u2500');
    expect(result).not.toContain('+');
  });

  it('should render with ASCII borders for "ascii" mode', () => {
    const result = renderBanner('Test', 'ascii');
    expect(result).toContain('+');
    expect(result).toContain('-');
    expect(result).toContain('|');
    expect(result).toContain('Test');
  });

  it('should render with Unicode box-drawing for "halfblock" mode', () => {
    const result = renderBanner('Test', 'halfblock');
    expect(result).toContain('\u256D'); // top-left rounded
    expect(result).toContain('\u256E'); // top-right rounded
    expect(result).toContain('\u2570'); // bottom-left rounded
    expect(result).toContain('\u256F'); // bottom-right rounded
    expect(result).toContain('\u2500'); // horizontal
    expect(result).toContain('\u2502'); // vertical
    expect(result).toContain('Test');
  });

  it('should render with Unicode for iterm2 mode', () => {
    const result = renderBanner('Test', 'iterm2');
    expect(result).toContain('\u256D');
    expect(result).toContain('Test');
  });

  it('should render with Unicode for kitty mode', () => {
    const result = renderBanner('Test', 'kitty');
    expect(result).toContain('\u256D');
    expect(result).toContain('Test');
  });

  it('should produce minimum width of 40', () => {
    const result = renderBanner('Hi', 'ascii');
    const lines = result.split('\n');
    // Top border line includes 2-char indent + border chars
    expect(lines[0].length).toBeGreaterThanOrEqual(40);
  });

  it('should have exactly 3 lines (top, content, bottom)', () => {
    const result = renderBanner('Test', 'ascii');
    const lines = result.split('\n');
    expect(lines.length).toBe(3);
  });

  it('should contain double-line chars in the border', () => {
    const result = renderBanner('Test', 'halfblock');
    expect(result).toContain('\u2550'); // double horizontal
  });

  it('should contain = for double-line in ascii mode', () => {
    const result = renderBanner('Test', 'ascii');
    expect(result).toContain('=');
  });
});

// ============================================================================
// renderAsciiArt
// ============================================================================

describe('renderAsciiArt', () => {
  it('should return empty string for empty array', () => {
    expect(renderAsciiArt([])).toBe('');
  });

  it('should join lines with newlines', () => {
    const art = ['line1', 'line2', 'line3'];
    const result = renderAsciiArt(art);
    expect(result).toBe('line1\nline2\nline3');
  });

  it('should apply color function when provided', () => {
    const art = ['hello', 'world'];
    const colorFn = (line: string, _index: number) => `[${line}]`;
    const result = renderAsciiArt(art, colorFn);
    expect(result).toBe('[hello]\n[world]');
  });

  it('should pass line index to color function', () => {
    const art = ['a', 'b', 'c'];
    const indices: number[] = [];
    const colorFn = (line: string, index: number) => {
      indices.push(index);
      return line;
    };
    renderAsciiArt(art, colorFn);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('should render single-line art', () => {
    const result = renderAsciiArt(['solo']);
    expect(result).toBe('solo');
  });
});

// ============================================================================
// renderSkinBanner
// ============================================================================

describe('renderSkinBanner', () => {
  const sampleArt = [
    '  _____  ',
    ' / ___ \\ ',
    '| |   | |',
    '|_|   |_|',
  ];

  it('should wrap art in a Unicode frame for halfblock mode', () => {
    const result = renderSkinBanner(sampleArt, '#FF0000', undefined, 'halfblock');
    expect(result).toContain('\u256D'); // top-left
    expect(result).toContain('\u256E'); // top-right
    expect(result).toContain('\u2570'); // bottom-left
    expect(result).toContain('\u256F'); // bottom-right
  });

  it('should wrap art in ASCII frame for ascii mode', () => {
    const result = renderSkinBanner(sampleArt, '#FF0000', undefined, 'ascii');
    expect(result).toContain('+');
    expect(result).toContain('-');
    expect(result).toContain('|');
  });

  it('should apply color to frame elements when color is provided', () => {
    const result = renderSkinBanner(sampleArt, '#FF0000', undefined, 'halfblock');
    // ANSI color codes should be present
    expect(result).toContain('\x1b[38;2;255;0;0m');
  });

  it('should not apply color when color is undefined', () => {
    const result = renderSkinBanner(sampleArt, undefined, undefined, 'halfblock');
    expect(result).not.toContain('\x1b[38;2;');
  });

  it('should include tagline when provided', () => {
    const result = renderSkinBanner(sampleArt, '#FF0000', 'A cool tagline', 'halfblock');
    expect(result).toContain('A cool tagline');
  });

  it('should apply dim styling to tagline', () => {
    const result = renderSkinBanner(sampleArt, '#FF0000', 'My Tagline', 'halfblock');
    // dim = \x1b[2m
    expect(result).toContain('\x1b[2m');
    expect(result).toContain('My Tagline');
  });

  it('should not include tagline section when tagline is undefined', () => {
    const result = renderSkinBanner(sampleArt, '#FF0000', undefined, 'halfblock');
    const lines = result.split('\n');
    // Without tagline: top + spacing + 4 art lines + spacing + bottom = 8 lines
    expect(lines.length).toBe(8);
  });

  it('should add extra lines for tagline', () => {
    const resultWithout = renderSkinBanner(sampleArt, '#FF0000', undefined, 'halfblock');
    const resultWith = renderSkinBanner(sampleArt, '#FF0000', 'Tagline!', 'halfblock');
    const linesWithout = resultWithout.split('\n');
    const linesWith = resultWith.split('\n');
    // Tagline adds 2 extra lines (tagline + spacing)
    expect(linesWith.length).toBe(linesWithout.length + 2);
  });

  it('should handle art with ANSI escape codes by measuring visible width', () => {
    const coloredArt = [
      '\x1b[31mRed\x1b[0m',
      '\x1b[32mGreen\x1b[0m',
    ];
    // Should not throw and should produce valid output
    const result = renderSkinBanner(coloredArt, '#FFFFFF', undefined, 'halfblock');
    expect(result).toContain('\u256D');
    expect(result).toContain('\u256F');
  });

  it('should use none mode without unicode chars', () => {
    const result = renderSkinBanner(sampleArt, '#FF0000', undefined, 'none');
    expect(result).toContain('+');
    expect(result).toContain('-');
    expect(result).toContain('|');
  });
});

// ============================================================================
// renderColoredBanner
// ============================================================================

describe('renderColoredBanner', () => {
  const sampleColoredArt = [
    { text: 'Line 1', color: '#FF0000' },
    { text: 'Line 2', color: '#00FF00' },
    { text: 'Line 3', color: '#0000FF' },
  ];

  it('should render each line with its own color', () => {
    const result = renderColoredBanner(sampleColoredArt, undefined, 'halfblock');
    // Red
    expect(result).toContain('\x1b[38;2;255;0;0m');
    // Green
    expect(result).toContain('\x1b[38;2;0;255;0m');
    // Blue
    expect(result).toContain('\x1b[38;2;0;0;255m');
  });

  it('should use the first line color for the frame', () => {
    const result = renderColoredBanner(sampleColoredArt, undefined, 'halfblock');
    // Frame should use #FF0000 (first line color)
    const lines = result.split('\n');
    const topLine = lines[0];
    expect(topLine).toContain('\x1b[38;2;255;0;0m');
  });

  it('should render Unicode frame for halfblock mode', () => {
    const result = renderColoredBanner(sampleColoredArt, undefined, 'halfblock');
    expect(result).toContain('\u256D');
    expect(result).toContain('\u256E');
    expect(result).toContain('\u2570');
    expect(result).toContain('\u256F');
  });

  it('should render ASCII frame for ascii mode', () => {
    const result = renderColoredBanner(sampleColoredArt, undefined, 'ascii');
    expect(result).toContain('+');
    expect(result).toContain('-');
    expect(result).toContain('|');
  });

  it('should include tagline when provided', () => {
    const result = renderColoredBanner(sampleColoredArt, 'My Tagline', 'halfblock');
    expect(result).toContain('My Tagline');
    // Tagline should be dim
    expect(result).toContain('\x1b[2m');
  });

  it('should not include tagline section when tagline is undefined', () => {
    const result = renderColoredBanner(sampleColoredArt, undefined, 'halfblock');
    const lines = result.split('\n');
    // top + spacing + 3 art lines + spacing + bottom = 7 lines
    expect(lines.length).toBe(7);
  });

  it('should add extra lines for tagline', () => {
    const resultWithout = renderColoredBanner(sampleColoredArt, undefined, 'halfblock');
    const resultWith = renderColoredBanner(sampleColoredArt, 'Tag', 'halfblock');
    const linesWithout = resultWithout.split('\n');
    const linesWith = resultWith.split('\n');
    expect(linesWith.length).toBe(linesWithout.length + 2);
  });

  it('should handle single line of colored art', () => {
    const singleLine = [{ text: 'HELLO', color: '#AABBCC' }];
    const result = renderColoredBanner(singleLine, undefined, 'halfblock');
    expect(result).toContain('HELLO');
    expect(result).toContain('\x1b[38;2;170;187;204m');
  });

  it('should handle art with ANSI escape codes for width measurement', () => {
    const art = [
      { text: '\x1b[1mBold\x1b[0m', color: '#FFFFFF' },
    ];
    const result = renderColoredBanner(art, undefined, 'halfblock');
    expect(result).toContain('\u256D');
    expect(result).toContain('\u256F');
  });
});

// ============================================================================
// renderTransition — dispatch tests
// ============================================================================

describe('renderTransition', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  const originalIsTTY = process.stdout.isTTY;
  const originalColumns = process.stdout.columns;
  const originalRows = process.stdout.rows;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Mock console.log too since some effects use it
    vi.spyOn(console, 'log').mockImplementation(() => {});
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 80, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, writable: true });
  });

  it('should return immediately when effect is "none"', async () => {
    await renderTransition({ effect: 'none', duration: 100 });
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
  });

  it('should return immediately when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    await renderTransition({ effect: 'matrix-rain', duration: 100 });
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
  });

  it('should hide cursor at start and show cursor at end for matrix-rain', async () => {
    await renderTransition({ effect: 'matrix-rain', duration: 50, color: '#00FF00' });

    const calls = stdoutWriteSpy.mock.calls.map(c => c[0]);
    // First call should hide cursor
    expect(calls[0]).toBe('\x1b[?25l');
    // Last call should show cursor + clear screen
    expect(calls[calls.length - 1]).toBe('\x1b[2J\x1b[H');
    expect(calls[calls.length - 2]).toBe('\x1b[?25h');
  });

  it('should dispatch matrix-rain effect and write to stdout', async () => {
    await renderTransition({ effect: 'matrix-rain', duration: 50, color: '#00FF00' });
    // Should have written multiple frames
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch warp-speed effect and write to stdout', async () => {
    await renderTransition({ effect: 'warp-speed', duration: 60, color: '#FFFFFF' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch glitch effect and write to stdout', async () => {
    await renderTransition({ effect: 'glitch', duration: 80, color: '#FF0000' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch terminal-boot effect and write to stdout', async () => {
    await renderTransition({ effect: 'terminal-boot', duration: 50, color: '#00FF00' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch pixel-dissolve effect and write to stdout', async () => {
    await renderTransition({ effect: 'pixel-dissolve', duration: 60, color: '#0000FF' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch sparkle effect and write to stdout', async () => {
    await renderTransition({ effect: 'sparkle', duration: 80, color: '#FFD700' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch rainbow-wave effect and write to stdout', async () => {
    await renderTransition({ effect: 'rainbow-wave', duration: 60 });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch static-noise effect and write to stdout', async () => {
    await renderTransition({ effect: 'static-noise', duration: 50 });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch fade effect and write to stdout', async () => {
    await renderTransition({ effect: 'fade', duration: 60, color: '#FF00FF' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch fade-in effect (alias for fade)', async () => {
    await renderTransition({ effect: 'fade-in', duration: 60, color: '#FF00FF' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch scan-lines effect and write to stdout', async () => {
    await renderTransition({ effect: 'scan-lines', duration: 50, color: '#00FFFF' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should dispatch digital-rain (alias for matrix-rain)', async () => {
    await renderTransition({ effect: 'digital-rain', duration: 50, color: '#00FF00' });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should use default duration when not specified', async () => {
    // Should not throw, uses 1500ms default
    // We use a very short custom duration to avoid slow tests above,
    // but here we verify the config interface works without duration
    const config: TransitionConfig = { effect: 'none' };
    await renderTransition(config);
    // 'none' returns immediately so no stdout writes
    expect(stdoutWriteSpy).not.toHaveBeenCalled();
  });

  it('should use default colors when not specified', async () => {
    await renderTransition({ effect: 'matrix-rain', duration: 50 });
    // Should not throw and should write frames
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should pass custom chars to matrix-rain', async () => {
    await renderTransition({
      effect: 'matrix-rain',
      duration: 50,
      color: '#00FF00',
      chars: 'ABC',
    });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should pass chars array to matrix-rain', async () => {
    await renderTransition({
      effect: 'matrix-rain',
      duration: 50,
      color: '#00FF00',
      chars: ['X', 'Y', 'Z'],
    });
    expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThan(2);
  });

  it('should still restore cursor even for unknown effects', async () => {
    await renderTransition({ effect: 'unknown-effect', duration: 50 });
    const calls = stdoutWriteSpy.mock.calls.map(c => c[0]);
    // Should still have hide cursor, show cursor, and clear
    expect(calls).toContain('\x1b[?25l');
    expect(calls).toContain('\x1b[?25h');
  });
});

// ============================================================================
// renderSplashAnimation — stdout output tests
// ============================================================================

describe('renderSplashAnimation', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should render scan-lines animation via console.log', async () => {
    const art = ['line1', 'line2', 'line3'];
    await renderSplashAnimation(art, 'scan-lines', 1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(3);
  });

  it('should render typewriter animation via stdout.write', async () => {
    const art = ['hello', 'world'];
    await renderSplashAnimation(art, 'typewriter', 1);
    // Each line: write colored line + write newline = 2 writes per line
    expect(stdoutWriteSpy).toHaveBeenCalledTimes(4);
  });

  it('should render fade-in animation (two passes)', async () => {
    const art = ['line1', 'line2'];
    await renderSplashAnimation(art, 'fade-in', 1);
    // First pass: 2 console.log (dim), then cursor up write, then 2 console.log (bright)
    // console.log: 2 (dim) + 2 (bright) = 4
    expect(consoleLogSpy).toHaveBeenCalledTimes(4);
    // stdout.write: 1 (cursor move up)
    expect(stdoutWriteSpy).toHaveBeenCalledTimes(1);
  });

  it('should render drop-in animation via console.log', async () => {
    const art = ['a', 'b', 'c'];
    await renderSplashAnimation(art, 'drop-in', 1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(3);
  });

  it('should apply color when provided', async () => {
    const art = ['test'];
    await renderSplashAnimation(art, 'scan-lines', 1, '#FF0000');
    const firstCall = consoleLogSpy.mock.calls[0][0] as string;
    expect(firstCall).toContain('\x1b[38;2;255;0;0m');
  });

  it('should not apply color when not provided', async () => {
    const art = ['test'];
    await renderSplashAnimation(art, 'scan-lines', 1);
    const firstCall = consoleLogSpy.mock.calls[0][0] as string;
    expect(firstCall).toBe('test');
  });

  it('should handle empty art array without errors', async () => {
    await renderSplashAnimation([], 'scan-lines', 1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// TransitionConfig interface validation
// ============================================================================

describe('TransitionConfig', () => {
  it('should accept minimal config with just effect', () => {
    const config: TransitionConfig = { effect: 'matrix-rain' };
    expect(config.effect).toBe('matrix-rain');
    expect(config.duration).toBeUndefined();
    expect(config.color).toBeUndefined();
    expect(config.colorSecondary).toBeUndefined();
    expect(config.chars).toBeUndefined();
  });

  it('should accept full config with all properties', () => {
    const config: TransitionConfig = {
      effect: 'glitch',
      duration: 2000,
      color: '#FF0000',
      colorSecondary: '#00FF00',
      chars: 'ABCDEF',
    };
    expect(config.effect).toBe('glitch');
    expect(config.duration).toBe(2000);
    expect(config.color).toBe('#FF0000');
    expect(config.colorSecondary).toBe('#00FF00');
    expect(config.chars).toBe('ABCDEF');
  });

  it('should accept chars as an array of strings', () => {
    const config: TransitionConfig = {
      effect: 'digital-rain',
      chars: ['0', '1'],
    };
    expect(config.chars).toEqual(['0', '1']);
  });
});

// ============================================================================
// ImageMode type coverage
// ============================================================================

describe('ImageMode type', () => {
  it('should cover all six modes in getImageModeLabel', () => {
    const modes: ImageMode[] = ['iterm2', 'kitty', 'halfblock', 'braille', 'ascii', 'none'];
    const labels = modes.map(m => getImageModeLabel(m));
    // All labels should be unique
    const uniqueLabels = new Set(labels);
    expect(uniqueLabels.size).toBe(6);
  });
});
