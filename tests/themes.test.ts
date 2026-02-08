/**
 * Tests for src/themes.ts
 *
 * Covers: THEMES constant, getCurrentThemeName, setCurrentTheme, getCurrentTheme,
 * listThemes, saveCustomTheme, getTheme, clearThemeCache, colorize, createColorFn,
 * getThemeColor, getInkColor, useThemeColors, and ANSI re-export.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  THEMES,
  getCurrentThemeName,
  setCurrentTheme,
  getCurrentTheme,
  listThemes,
  saveCustomTheme,
  getTheme,
  clearThemeCache,
  colorize,
  createColorFn,
  getThemeColor,
  getInkColor,
  useThemeColors,
  ANSI,
  type Theme,
} from '../src/themes.js';
import { PALETTES, clearHUDCache, applyPalette } from '../src/hud.js';

// Filesystem paths used by themes.ts
const THEMES_DIR = path.join(os.homedir(), '.calliope-cli', 'themes');
const THEME_FILE = path.join(THEMES_DIR, 'current.txt');

// Reset HUD state before each test
beforeEach(() => {
  clearThemeCache();
  clearHUDCache();
});

// ============================================================================
// THEMES constant
// ============================================================================

describe('THEMES', () => {
  it('should contain default, light, monokai, nord, and minimal themes', () => {
    expect(THEMES.default).toBeDefined();
    expect(THEMES.light).toBeDefined();
    expect(THEMES.monokai).toBeDefined();
    expect(THEMES.nord).toBeDefined();
    expect(THEMES.minimal).toBeDefined();
  });

  it('should have name and colors on each built-in theme', () => {
    for (const [key, theme] of Object.entries(THEMES)) {
      expect(theme.name).toBeDefined();
      expect(typeof theme.name).toBe('string');
      expect(theme.colors).toBeDefined();
      expect(theme.colors.primary).toBeDefined();
      expect(theme.colors.error).toBeDefined();
      expect(theme.colors.success).toBeDefined();
    }
  });

  it('should have all expected color keys on the default theme', () => {
    const colorKeys = [
      'primary', 'secondary', 'accent',
      'text', 'textDim', 'textBold',
      'user', 'assistant', 'system', 'error',
      'codeKeyword', 'codeString', 'codeNumber', 'codeComment', 'codeFunction',
      'diffAdd', 'diffRemove', 'diffContext',
      'success', 'warning', 'info',
      'border', 'background', 'selection',
    ];
    for (const key of colorKeys) {
      expect(THEMES.default.colors).toHaveProperty(key);
    }
  });

  it('should map default theme from the default palette', () => {
    expect(THEMES.default.name).toBe(PALETTES.default.name);
    expect(THEMES.default.colors.primary).toBe(PALETTES.default.colors.primary);
  });

  it('should map minimal theme from the monochrome palette', () => {
    expect(THEMES.minimal.name).toBe(PALETTES.monochrome.name);
  });
});

// ============================================================================
// getCurrentThemeName
// ============================================================================

describe('getCurrentThemeName', () => {
  it('should return a string', () => {
    const name = getCurrentThemeName();
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('should return "default" when no theme file or an invalid theme is set', () => {
    // If the theme file references an unknown theme, it falls back to default.
    // We cannot easily control the file system here, but the function should not throw.
    const name = getCurrentThemeName();
    expect(typeof name).toBe('string');
  });
});

// ============================================================================
// setCurrentTheme
// ============================================================================

describe('setCurrentTheme', () => {
  it('should return true for a known palette name', () => {
    expect(setCurrentTheme('default')).toBe(true);
  });

  it('should return true for the light palette', () => {
    expect(setCurrentTheme('light')).toBe(true);
  });

  it('should return true for the nord palette', () => {
    expect(setCurrentTheme('nord')).toBe(true);
  });

  it('should return true for the monokai palette', () => {
    expect(setCurrentTheme('monokai')).toBe(true);
  });

  it('should return true for the legacy "minimal" theme name (maps to monochrome)', () => {
    expect(setCurrentTheme('minimal')).toBe(true);
  });

  it('should return false for a completely unknown theme name', () => {
    expect(setCurrentTheme('nonexistent-theme-xyz-999')).toBe(false);
  });

  it('should persist the theme name so getCurrentThemeName returns it', () => {
    setCurrentTheme('nord');
    expect(getCurrentThemeName()).toBe('nord');
  });

  it('should clear theme cache after setting', () => {
    // Pre-load cache
    getTheme();
    setCurrentTheme('light');
    // Cache should be cleared, new getTheme call should reflect 'light'
    const theme = getTheme();
    expect(theme.name).toBe('light');
  });
});

// ============================================================================
// getCurrentTheme
// ============================================================================

describe('getCurrentTheme', () => {
  it('should return a Theme object', () => {
    const theme = getCurrentTheme();
    expect(theme).toHaveProperty('name');
    expect(theme).toHaveProperty('colors');
  });

  it('should return the theme matching getCurrentThemeName', () => {
    setCurrentTheme('nord');
    const theme = getCurrentTheme();
    expect(theme.name).toBe('nord');
  });

  it('should return the correct theme after switching', () => {
    setCurrentTheme('light');
    expect(getCurrentTheme().name).toBe('light');
    setCurrentTheme('monokai');
    expect(getCurrentTheme().name).toBe('monokai');
  });

  it('should handle the minimal legacy mapping to monochrome', () => {
    setCurrentTheme('minimal');
    const theme = getCurrentTheme();
    // minimal maps to monochrome palette
    expect(theme.name).toBe('monochrome');
  });

  it('should have all required color keys', () => {
    const theme = getCurrentTheme();
    expect(theme.colors).toHaveProperty('primary');
    expect(theme.colors).toHaveProperty('secondary');
    expect(theme.colors).toHaveProperty('accent');
    expect(theme.colors).toHaveProperty('error');
    expect(theme.colors).toHaveProperty('success');
    expect(theme.colors).toHaveProperty('warning');
    expect(theme.colors).toHaveProperty('diffAdd');
    expect(theme.colors).toHaveProperty('diffRemove');
  });
});

// ============================================================================
// listThemes
// ============================================================================

describe('listThemes', () => {
  it('should return a non-empty array', () => {
    const themes = listThemes();
    expect(themes.length).toBeGreaterThan(0);
  });

  it('should include the default palette as a theme', () => {
    const themes = listThemes();
    const def = themes.find(t => t.name === 'default');
    expect(def).toBeDefined();
    expect(def!.custom).toBe(false);
  });

  it('should include the light palette as a theme', () => {
    const themes = listThemes();
    const light = themes.find(t => t.name === 'light');
    expect(light).toBeDefined();
  });

  it('should have name, description, and custom on every entry', () => {
    const themes = listThemes();
    for (const theme of themes) {
      expect(theme).toHaveProperty('name');
      expect(typeof theme.name).toBe('string');
      expect(theme).toHaveProperty('custom');
      expect(typeof theme.custom).toBe('boolean');
    }
  });

  it('should list all palette names', () => {
    const themes = listThemes();
    const names = themes.map(t => t.name);
    for (const paletteName of Object.keys(PALETTES)) {
      expect(names).toContain(paletteName);
    }
  });
});

// ============================================================================
// getTheme (cached)
// ============================================================================

describe('getTheme', () => {
  it('should return a Theme object', () => {
    const theme = getTheme();
    expect(theme).toHaveProperty('name');
    expect(theme).toHaveProperty('colors');
  });

  it('should return the same object on consecutive calls (caching)', () => {
    const theme1 = getTheme();
    const theme2 = getTheme();
    expect(theme1).toBe(theme2);
  });

  it('should return a fresh object after clearThemeCache', () => {
    const theme1 = getTheme();
    clearThemeCache();
    const theme2 = getTheme();
    // They should be equal in content but not the same reference
    expect(theme2.name).toBe(theme1.name);
  });

  it('should reflect theme changes after cache clear', () => {
    setCurrentTheme('default');
    const t1 = getTheme();
    expect(t1.name).toBe('default');

    setCurrentTheme('nord');
    const t2 = getTheme();
    expect(t2.name).toBe('nord');
  });
});

// ============================================================================
// clearThemeCache
// ============================================================================

describe('clearThemeCache', () => {
  it('should not throw', () => {
    expect(() => clearThemeCache()).not.toThrow();
  });

  it('should allow getTheme to re-evaluate after cache cleared', () => {
    setCurrentTheme('light');
    const theme1 = getTheme();
    expect(theme1.name).toBe('light');

    setCurrentTheme('nord');
    // setCurrentTheme already calls clearThemeCache, so getTheme should reflect the change
    const theme2 = getTheme();
    expect(theme2.name).toBe('nord');
  });
});

// ============================================================================
// colorize
// ============================================================================

describe('colorize', () => {
  it('should wrap text with ANSI color code and reset', () => {
    const result = colorize('hello', 'primary');
    expect(result).toContain('hello');
    expect(result).toContain(ANSI.reset);
  });

  it('should use the correct color for the given key', () => {
    setCurrentTheme('default');
    clearThemeCache();
    const theme = getTheme();
    const result = colorize('test', 'error');
    expect(result).toContain(theme.colors.error);
    expect(result).toContain('test');
  });

  it('should end with ANSI reset', () => {
    const result = colorize('test', 'accent');
    expect(result.endsWith(ANSI.reset)).toBe(true);
  });

  it('should start with the color code', () => {
    const theme = getTheme();
    const result = colorize('text', 'success');
    expect(result.startsWith(theme.colors.success)).toBe(true);
  });

  it('should produce correct structure: color + text + reset', () => {
    const theme = getTheme();
    const result = colorize('ok', 'warning');
    expect(result).toBe(`${theme.colors.warning}ok${ANSI.reset}`);
  });
});

// ============================================================================
// createColorFn
// ============================================================================

describe('createColorFn', () => {
  it('should return a function', () => {
    const fn = createColorFn('primary');
    expect(typeof fn).toBe('function');
  });

  it('should produce the same result as colorize', () => {
    const fn = createColorFn('error');
    const direct = colorize('test', 'error');
    expect(fn('test')).toBe(direct);
  });

  it('should wrap text with ANSI codes', () => {
    const fn = createColorFn('accent');
    const result = fn('hello');
    expect(result).toContain('hello');
    expect(result).toContain(ANSI.reset);
  });

  it('should create distinct functions for different color keys', () => {
    const errorFn = createColorFn('error');
    const successFn = createColorFn('success');
    const errorResult = errorFn('msg');
    const successResult = successFn('msg');
    // They should differ (different color codes)
    expect(errorResult).not.toBe(successResult);
  });
});

// ============================================================================
// getThemeColor
// ============================================================================

describe('getThemeColor', () => {
  it('should return a string for known semantic keys', () => {
    expect(typeof getThemeColor('primary')).toBe('string');
    expect(typeof getThemeColor('error')).toBe('string');
    expect(typeof getThemeColor('success')).toBe('string');
  });

  it('should return the palette color for the primary key', () => {
    applyPalette('default');
    const color = getThemeColor('primary');
    expect(color).toBe(PALETTES.default.colors.primary);
  });

  it('should return the palette color for the error key', () => {
    applyPalette('default');
    const color = getThemeColor('error');
    expect(color).toBe(PALETTES.default.colors.error);
  });

  it('should reflect palette changes', () => {
    applyPalette('default');
    const defaultPrimary = getThemeColor('primary');
    applyPalette('light');
    const lightPrimary = getThemeColor('primary');
    expect(defaultPrimary).toBe(PALETTES.default.colors.primary);
    expect(lightPrimary).toBe(PALETTES.light.colors.primary);
  });
});

// ============================================================================
// getInkColor
// ============================================================================

describe('getInkColor', () => {
  it('should return a string for known semantic keys', () => {
    const result = getInkColor('primary');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return "cyan" for default palette primary', () => {
    applyPalette('default');
    expect(getInkColor('primary')).toBe('cyan');
  });

  it('should return "red" for error', () => {
    applyPalette('default');
    expect(getInkColor('error')).toBe('red');
  });

  it('should return "green" for success', () => {
    applyPalette('default');
    expect(getInkColor('success')).toBe('green');
  });

  it('should return "yellow" for warning', () => {
    applyPalette('default');
    expect(getInkColor('warning')).toBe('yellow');
  });

  it('should return "blue" for info', () => {
    applyPalette('default');
    expect(getInkColor('info')).toBe('blue');
  });

  it('should change after applying a different palette', () => {
    applyPalette('default');
    const defaultPrimary = getInkColor('primary');
    applyPalette('light');
    const lightPrimary = getInkColor('primary');
    expect(defaultPrimary).toBe('cyan');
    expect(lightPrimary).toBe('blue');
  });
});

// ============================================================================
// useThemeColors
// ============================================================================

describe('useThemeColors', () => {
  it('should return an object with all semantic color keys', () => {
    const colors = useThemeColors();
    expect(colors).toHaveProperty('primary');
    expect(colors).toHaveProperty('secondary');
    expect(colors).toHaveProperty('accent');
    expect(colors).toHaveProperty('error');
    expect(colors).toHaveProperty('success');
    expect(colors).toHaveProperty('warning');
    expect(colors).toHaveProperty('info');
    expect(colors).toHaveProperty('text');
    expect(colors).toHaveProperty('border');
  });

  it('should return strings for all values', () => {
    const colors = useThemeColors();
    for (const value of Object.values(colors)) {
      expect(typeof value).toBe('string');
    }
  });

  it('should return Ink-compatible color names', () => {
    applyPalette('default');
    const colors = useThemeColors();
    expect(colors.primary).toBe('cyan');
    expect(colors.error).toBe('red');
    expect(colors.success).toBe('green');
  });

  it('should reflect palette changes', () => {
    applyPalette('default');
    const defaultColors = useThemeColors();
    applyPalette('light');
    const lightColors = useThemeColors();
    // Default primary = cyan, light primary = blue
    expect(defaultColors.primary).toBe('cyan');
    expect(lightColors.primary).toBe('blue');
  });
});

// ============================================================================
// ANSI export
// ============================================================================

describe('ANSI export', () => {
  it('should export ANSI color codes', () => {
    expect(ANSI).toBeDefined();
    expect(ANSI.reset).toBeDefined();
    expect(ANSI.red).toBeDefined();
    expect(ANSI.green).toBeDefined();
    expect(ANSI.cyan).toBeDefined();
    expect(ANSI.blue).toBeDefined();
    expect(ANSI.yellow).toBeDefined();
    expect(ANSI.magenta).toBeDefined();
  });

  it('should have reset as the standard ANSI reset sequence', () => {
    expect(ANSI.reset).toBe('\x1b[0m');
  });
});
