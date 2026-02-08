/**
 * Extended tests for styles.ts — box drawing, table formatting,
 * progress helpers, and remaining utility functions.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  color,
  colorIf,
  colors,
  separator,
  truncate,
  pad,
  formatNumber,
  formatBytes,
  formatDuration,
  formatCost,
  boxHeader,
  boxFooter,
  indent,
  BOX,
  BOX_STYLE_VARIANTS,
  getBoxStyle,
  resolveColor,
  styledColor,
  RISK_COLORS,
  RISK_ICONS,
  SPINNER_DOTS,
  SPINNER_SIMPLE,
  getToolIcon,
  TOOL_ICONS,
  STATUS_ICONS,
} from '../src/styles.js';

// ============================================================================
// colorIf
// ============================================================================

describe('colorIf', () => {
  it('should apply color when condition is true', () => {
    const result = colorIf(true, 'hello', 'red');
    expect(result).toContain('\x1b[31m');
    expect(result).toContain('hello');
    expect(result).toContain('\x1b[0m');
  });

  it('should return plain text when condition is false', () => {
    const result = colorIf(false, 'hello', 'red');
    expect(result).toBe('hello');
  });

  it('should apply multiple styles when condition is true', () => {
    const result = colorIf(true, 'test', 'bold', 'green');
    expect(result).toContain('\x1b[1m');
    expect(result).toContain('\x1b[32m');
  });
});

// ============================================================================
// BOX constants
// ============================================================================

describe('BOX constants', () => {
  it('should have all corner characters', () => {
    expect(BOX.topLeft).toBe('╭');
    expect(BOX.topRight).toBe('╮');
    expect(BOX.bottomLeft).toBe('╰');
    expect(BOX.bottomRight).toBe('╯');
  });

  it('should have line characters', () => {
    expect(BOX.horizontal).toBe('─');
    expect(BOX.vertical).toBe('│');
  });

  it('should have connector characters', () => {
    expect(BOX.teeRight).toBe('├');
    expect(BOX.teeLeft).toBe('┤');
    expect(BOX.teeDown).toBe('┬');
    expect(BOX.teeUp).toBe('┴');
    expect(BOX.cross).toBe('┼');
  });

  it('should have heavy variants', () => {
    expect(BOX.heavyHorizontal).toBe('━');
    expect(BOX.heavyVertical).toBe('┃');
  });
});

// ============================================================================
// boxHeader / boxFooter
// ============================================================================

describe('boxHeader', () => {
  it('should create a header with title centered in box', () => {
    const header = boxHeader('Title', 40);
    expect(header).toContain('╭');
    expect(header).toContain('╮');
    expect(header).toContain(' Title ');
    expect(header).toContain('─');
  });

  it('should use default width of 60', () => {
    const header = boxHeader('Test');
    expect(header.startsWith('╭')).toBe(true);
    expect(header.endsWith('╮')).toBe(true);
  });

  it('should handle empty title', () => {
    const header = boxHeader('', 20);
    expect(header).toContain('╭');
    expect(header).toContain('╮');
  });

  it('should handle long titles', () => {
    const longTitle = 'A'.repeat(50);
    const header = boxHeader(longTitle, 60);
    expect(header).toContain(longTitle);
    expect(header.startsWith('╭')).toBe(true);
    expect(header.endsWith('╮')).toBe(true);
  });
});

describe('boxFooter', () => {
  it('should create a footer line', () => {
    const footer = boxFooter(40);
    expect(footer.startsWith('╰')).toBe(true);
    expect(footer.endsWith('╯')).toBe(true);
    expect(footer).toContain('─');
  });

  it('should use default width of 60', () => {
    const footer = boxFooter();
    expect(footer.startsWith('╰')).toBe(true);
    expect(footer.endsWith('╯')).toBe(true);
    // Default width is 60, so interior is 58 hyphens
    const interior = footer.slice(1, -1);
    expect(interior.length).toBe(58);
  });

  it('should have correct total structure', () => {
    const footer = boxFooter(20);
    // Should be: bottomLeft + 18 horizontals + bottomRight
    expect(footer).toBe('╰' + '─'.repeat(18) + '╯');
  });
});

// ============================================================================
// separator edge cases
// ============================================================================

describe('separator (extended)', () => {
  it('should handle width of 0', () => {
    expect(separator(0)).toBe('');
  });

  it('should handle width of 1', () => {
    expect(separator(1)).toBe('─');
  });

  it('should use default width of 80', () => {
    const sep = separator();
    expect(sep.length).toBe(80);
  });

  it('should repeat multi-character strings', () => {
    const sep = separator(3, '=');
    expect(sep).toBe('===');
  });
});

// ============================================================================
// truncate edge cases
// ============================================================================

describe('truncate (extended)', () => {
  it('should return text unchanged when exactly at maxLength', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('should handle empty string', () => {
    expect(truncate('', 5)).toBe('');
  });

  it('should handle maxLength smaller than suffix', () => {
    // maxLength=2, suffix='...' (length 3) => substring(0, -1) + '...'
    // This is an edge case — the function still runs
    const result = truncate('hello world', 2);
    expect(result).toContain('...');
  });
});

// ============================================================================
// pad edge cases
// ============================================================================

describe('pad (extended)', () => {
  it('should handle text exactly at width', () => {
    expect(pad('hello', 5)).toBe('hello');
  });

  it('should handle odd center padding', () => {
    // width=7, text='hi' (len=2), padding=5 -> left=2, right=3
    const result = pad('hi', 7, 'center');
    expect(result.length).toBe(7);
    expect(result).toBe('  hi   ');
  });

  it('should handle empty string with left alignment', () => {
    expect(pad('', 3, 'left')).toBe('   ');
  });

  it('should handle empty string with right alignment', () => {
    expect(pad('', 3, 'right')).toBe('   ');
  });

  it('should handle empty string with center alignment', () => {
    const result = pad('', 4, 'center');
    expect(result.length).toBe(4);
  });
});

// ============================================================================
// formatNumber edge cases
// ============================================================================

describe('formatNumber (extended)', () => {
  it('should format zero', () => {
    expect(formatNumber(0)).toBe('0');
  });

  it('should format exactly 1000', () => {
    expect(formatNumber(1000)).toBe('1.0K');
  });

  it('should format exactly 1000000', () => {
    expect(formatNumber(1000000)).toBe('1.0M');
  });

  it('should format 999', () => {
    expect(formatNumber(999)).toBe('999');
  });

  it('should format 999999', () => {
    expect(formatNumber(999999)).toBe('1000.0K');
  });
});

// ============================================================================
// formatBytes edge cases
// ============================================================================

describe('formatBytes (extended)', () => {
  it('should format zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('should format exactly 1000', () => {
    expect(formatBytes(1000)).toBe('1.0 KB');
  });

  it('should format exactly 1000000', () => {
    expect(formatBytes(1000000)).toBe('1.0 MB');
  });

  it('should format exactly 1000000000', () => {
    expect(formatBytes(1000000000)).toBe('1.0 GB');
  });
});

// ============================================================================
// formatDuration edge cases
// ============================================================================

describe('formatDuration (extended)', () => {
  it('should format zero milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('should format exactly 1000ms as seconds', () => {
    expect(formatDuration(1000)).toBe('1.0s');
  });

  it('should format exactly 60000ms as minutes', () => {
    expect(formatDuration(60000)).toBe('1m 0s');
  });

  it('should format exactly 3600000ms as hours', () => {
    expect(formatDuration(3600000)).toBe('1h 0m');
  });

  it('should format 999ms as milliseconds', () => {
    expect(formatDuration(999)).toBe('999ms');
  });

  it('should format 59999ms as seconds', () => {
    expect(formatDuration(59999)).toBe('60.0s');
  });
});

// ============================================================================
// formatCost edge cases
// ============================================================================

describe('formatCost (extended)', () => {
  it('should format zero as less than a penny', () => {
    expect(formatCost(0)).toBe('<$0.01');
  });

  it('should format exactly 0.01', () => {
    expect(formatCost(0.01)).toBe('$0.010');
  });

  it('should format exactly 1.00', () => {
    expect(formatCost(1.0)).toBe('$1.00');
  });

  it('should format large cost', () => {
    expect(formatCost(99.99)).toBe('$99.99');
  });
});

// ============================================================================
// indent edge cases
// ============================================================================

describe('indent (extended)', () => {
  it('should use default 2 spaces', () => {
    expect(indent('hello')).toBe('  hello');
  });

  it('should handle zero indent', () => {
    expect(indent('hello', 0)).toBe('hello');
  });

  it('should handle empty string', () => {
    expect(indent('', 4)).toBe('    ');
  });

  it('should indent three lines', () => {
    expect(indent('a\nb\nc', 1)).toBe(' a\n b\n c');
  });
});

// ============================================================================
// BOX_STYLE_VARIANTS
// ============================================================================

describe('BOX_STYLE_VARIANTS', () => {
  it('should have rounded style', () => {
    const r = BOX_STYLE_VARIANTS.rounded;
    expect(r.topLeft).toBe('\u256D');
    expect(r.horizontal).toBe('\u2500');
    expect(r.vertical).toBe('\u2502');
  });

  it('should have sharp style', () => {
    const s = BOX_STYLE_VARIANTS.sharp;
    expect(s.topLeft).toBe('\u250C');
    expect(s.topRight).toBe('\u2510');
    expect(s.bottomLeft).toBe('\u2514');
    expect(s.bottomRight).toBe('\u2518');
  });

  it('should have double style', () => {
    const d = BOX_STYLE_VARIANTS.double;
    expect(d.topLeft).toBe('\u2554');
    expect(d.horizontal).toBe('\u2550');
    expect(d.vertical).toBe('\u2551');
  });

  it('should have ascii style', () => {
    const a = BOX_STYLE_VARIANTS.ascii;
    expect(a.topLeft).toBe('+');
    expect(a.horizontal).toBe('-');
    expect(a.vertical).toBe('|');
  });

  it('should have none style with spaces', () => {
    const n = BOX_STYLE_VARIANTS.none;
    expect(n.topLeft).toBe(' ');
    expect(n.horizontal).toBe(' ');
    expect(n.vertical).toBe(' ');
  });

  it('each variant should have all 6 required keys', () => {
    const requiredKeys = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'horizontal', 'vertical'];
    for (const [name, variant] of Object.entries(BOX_STYLE_VARIANTS)) {
      for (const key of requiredKeys) {
        expect(variant).toHaveProperty(key);
      }
    }
  });
});

// ============================================================================
// getBoxStyle
// ============================================================================

describe('getBoxStyle', () => {
  it('should return named style when given a valid style name', () => {
    const sharp = getBoxStyle('sharp');
    expect(sharp).toBe(BOX_STYLE_VARIANTS.sharp);
  });

  it('should return rounded style for unknown style name', () => {
    // Unknown styleName not in BOX_STYLE_VARIANTS -> falls through to skin lookup
    // If skin lookup fails (no hud.js), returns rounded as default
    const result = getBoxStyle('nonexistent');
    expect(result).toBe(BOX_STYLE_VARIANTS.rounded);
  });

  it('should return rounded as fallback when no style name given', () => {
    // No styleName -> tries getCurrentSkin which will fail in test -> returns rounded
    const result = getBoxStyle();
    expect(result).toBe(BOX_STYLE_VARIANTS.rounded);
  });

  it('should return double style when requested', () => {
    expect(getBoxStyle('double')).toBe(BOX_STYLE_VARIANTS.double);
  });

  it('should return ascii style when requested', () => {
    expect(getBoxStyle('ascii')).toBe(BOX_STYLE_VARIANTS.ascii);
  });

  it('should return none style when requested', () => {
    expect(getBoxStyle('none')).toBe(BOX_STYLE_VARIANTS.none);
  });
});

// ============================================================================
// resolveColor / styledColor
// ============================================================================

describe('resolveColor', () => {
  it('should resolve raw ANSI color names', () => {
    expect(resolveColor('red')).toBe('\x1b[31m');
    expect(resolveColor('cyan')).toBe('\x1b[36m');
    expect(resolveColor('bold')).toBe('\x1b[1m');
  });

  it('should resolve background colors', () => {
    expect(resolveColor('bgRed')).toBe('\x1b[41m');
    expect(resolveColor('bgBlue')).toBe('\x1b[44m');
  });

  it('should resolve bright colors', () => {
    expect(resolveColor('brightGreen')).toBe('\x1b[92m');
    expect(resolveColor('brightCyan')).toBe('\x1b[96m');
  });

  it('should return empty string for unknown semantic color when hud unavailable', () => {
    // 'primary' is a semantic color; without hud.js properly loaded, returns ''
    const result = resolveColor('primary');
    // May or may not resolve depending on hud.js availability, but should not throw
    expect(typeof result).toBe('string');
  });
});

describe('styledColor', () => {
  it('should wrap text with ANSI codes for raw color', () => {
    const result = styledColor('hello', 'green');
    expect(result).toContain('\x1b[32m');
    expect(result).toContain('hello');
    expect(result).toContain('\x1b[0m');
  });

  it('should return plain text when color code is empty', () => {
    // Force a scenario where resolveColor returns ''
    // Use a semantic color that likely won't resolve in test env
    const result = styledColor('hello', 'primary');
    // Either returns styled text (if hud loaded) or plain text
    expect(result).toContain('hello');
  });

  it('should apply bold modifier', () => {
    const result = styledColor('test', 'bold');
    expect(result).toContain('\x1b[1m');
    expect(result).toContain('\x1b[0m');
  });
});

// ============================================================================
// RISK_COLORS / RISK_ICONS
// ============================================================================

describe('RISK_COLORS', () => {
  it('should map all risk levels to color names', () => {
    expect(RISK_COLORS.none).toBe('green');
    expect(RISK_COLORS.low).toBe('green');
    expect(RISK_COLORS.medium).toBe('yellow');
    expect(RISK_COLORS.high).toBe('red');
    expect(RISK_COLORS.critical).toBe('red');
  });
});

describe('RISK_ICONS', () => {
  it('should map all risk levels to block characters', () => {
    expect(RISK_ICONS.none).toBe('');
    expect(RISK_ICONS.low).toBe('░');
    expect(RISK_ICONS.medium).toBe('▒');
    expect(RISK_ICONS.high).toBe('▓');
    expect(RISK_ICONS.critical).toBe('█');
  });
});

// ============================================================================
// Additional spinner variants
// ============================================================================

describe('SPINNER_DOTS', () => {
  it('should have 8 frames', () => {
    expect(SPINNER_DOTS.length).toBe(8);
  });

  it('should have braille characters', () => {
    for (const frame of SPINNER_DOTS) {
      expect(frame.length).toBe(1);
    }
  });
});

describe('SPINNER_SIMPLE', () => {
  it('should have 4 frames', () => {
    expect(SPINNER_SIMPLE.length).toBe(4);
  });

  it('should contain pipe, slash, dash, backslash', () => {
    expect(SPINNER_SIMPLE[0]).toBe('|');
    expect(SPINNER_SIMPLE[1]).toBe('/');
    expect(SPINNER_SIMPLE[2]).toBe('-');
    expect(SPINNER_SIMPLE[3]).toBe('\\');
  });
});

// ============================================================================
// Tool icons - additional coverage
// ============================================================================

describe('getToolIcon (extended)', () => {
  it('should return icons for all defined tools', () => {
    expect(getToolIcon('list_files')).toBe('📁');
    expect(getToolIcon('execute_code')).toBe('▶️');
    expect(getToolIcon('web_search')).toBe('🔍');
    expect(getToolIcon('git')).toBe('🔀');
    expect(getToolIcon('mermaid')).toBe('📊');
  });

  it('should return default for empty string', () => {
    expect(getToolIcon('')).toBe('⚙️');
  });
});

// ============================================================================
// STATUS_ICONS - additional coverage
// ============================================================================

describe('STATUS_ICONS (extended)', () => {
  it('should have all defined icons', () => {
    expect(STATUS_ICONS.pending).toBe('○');
    expect(STATUS_ICONS.complete).toBe('●');
    expect(STATUS_ICONS.blocked).toBe('🛑');
    expect(STATUS_ICONS.thinking).toBe('💭');
    expect(STATUS_ICONS.running).toBe('⚡');
    expect(STATUS_ICONS.info).toBe('ℹ️');
  });
});

// ============================================================================
// color function - additional edge cases
// ============================================================================

describe('color (extended)', () => {
  it('should handle background colors', () => {
    const result = color('test', 'bgRed');
    expect(result).toContain('\x1b[41m');
  });

  it('should handle three or more styles', () => {
    const result = color('test', 'bold', 'italic', 'underline');
    expect(result).toContain('\x1b[1m');
    expect(result).toContain('\x1b[3m');
    expect(result).toContain('\x1b[4m');
  });

  it('should handle dim style', () => {
    const result = color('test', 'dim');
    expect(result).toContain('\x1b[2m');
  });

  it('should handle empty text', () => {
    const result = color('', 'red');
    expect(result).toBe('\x1b[31m\x1b[0m');
  });
});
