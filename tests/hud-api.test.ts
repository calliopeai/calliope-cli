import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCurrentSkin,
  getPalette,
  applyPalette,
  getCurrentPalette,
  getBoxChars,
  getSpinnerFrames,
  getPaletteColor,
  paletteColorize,
  getInkColor,
  getInkBorderStyle,
  clearHUDCache,
} from '../src/hud/api.js';
import { SKINS, BOX_STYLES, SPINNER_SETS } from '../src/hud/skins.js';
import { PALETTES } from '../src/hud/palettes.js';
import { colors as ANSI } from '../src/styles.js';
import type { Skin } from '../src/hud/types.js';

// Reset module state before each test to avoid cross-test contamination
beforeEach(() => {
  clearHUDCache();
});

// ============================================================================
// getCurrentSkin (single built-in skin)
// ============================================================================

describe('getCurrentSkin', () => {
  it('should return the clean skin', () => {
    const skin = getCurrentSkin();
    expect(skin.name).toBe('clean');
  });

  it('should return a full Skin object with all required fields', () => {
    const skin = getCurrentSkin();
    expect(typeof skin.name).toBe('string');
    expect(typeof skin.description).toBe('string');
    expect(skin.banner).toBeDefined();
    expect(skin.borders).toBeDefined();
    expect(skin.decorations).toBeDefined();
    expect(skin.diff).toBeDefined();
    expect(skin.responsive).toBeDefined();
  });

  it('should use rounded borders and the default palette', () => {
    const skin = getCurrentSkin();
    expect(skin.borders.style).toBe('rounded');
    expect(skin.defaultPalette).toBe('default');
  });
});

// ============================================================================
// getPalette
// ============================================================================

describe('getPalette', () => {
  it('should return the default palette when called with no arguments', () => {
    const palette = getPalette();
    expect(palette.name).toBe('default');
  });

  it('should return named palette when a valid name is given', () => {
    const palette = getPalette('light');
    expect(palette.name).toBe('light');
  });

  it('should fall back to default for unknown palette name', () => {
    const palette = getPalette('nonexistent-palette-xyz');
    expect(palette.name).toBe('default');
  });

  it('should return currently applied palette when called with no arguments after applyPalette', () => {
    applyPalette('light');
    const palette = getPalette();
    expect(palette.name).toBe('light');
  });

  it('should return default when called with undefined', () => {
    const palette = getPalette(undefined);
    expect(palette.name).toBe('default');
  });

  it('should return all expected properties on the returned palette', () => {
    const palette = getPalette('default');
    expect(palette).toHaveProperty('name');
    expect(palette).toHaveProperty('description');
    expect(palette).toHaveProperty('colors');
    expect(palette.colors).toHaveProperty('primary');
    expect(palette.colors).toHaveProperty('accent');
    expect(palette.colors).toHaveProperty('error');
    expect(palette.colors).toHaveProperty('success');
  });

  it('should return every built-in palette by name', () => {
    for (const name of Object.keys(PALETTES)) {
      const palette = getPalette(name);
      expect(palette.name).toBe(name);
    }
  });

  it('should expose exactly the three built-in palettes', () => {
    expect(Object.keys(PALETTES).sort()).toEqual(['default', 'light', 'monochrome']);
  });

  it('should return all 24 color keys on every palette', () => {
    const requiredKeys = [
      'primary', 'secondary', 'accent',
      'text', 'textDim', 'textBold',
      'user', 'assistant', 'system', 'error',
      'codeKeyword', 'codeString', 'codeNumber', 'codeComment', 'codeFunction',
      'diffAdd', 'diffRemove', 'diffContext',
      'success', 'warning', 'info',
      'border', 'background', 'selection',
    ];
    for (const name of Object.keys(PALETTES)) {
      const palette = getPalette(name);
      for (const key of requiredKeys) {
        expect(palette.colors).toHaveProperty(key);
      }
    }
  });
});

// ============================================================================
// applyPalette
// ============================================================================

describe('applyPalette', () => {
  it('should return true for a known palette', () => {
    expect(applyPalette('default')).toBe(true);
  });

  it('should return true for the light palette', () => {
    expect(applyPalette('light')).toBe(true);
  });

  it('should return false for an unknown palette', () => {
    expect(applyPalette('nonexistent-palette-xyz')).toBe(false);
  });

  it('should set the current palette when successful', () => {
    applyPalette('light');
    expect(getCurrentPalette().name).toBe('light');
  });

  it('should return true for all built-in palettes', () => {
    for (const name of Object.keys(PALETTES)) {
      clearHUDCache();
      expect(applyPalette(name)).toBe(true);
      expect(getCurrentPalette().name).toBe(name);
    }
  });

  it('should not change palette when applying an invalid name', () => {
    applyPalette('light');
    expect(getCurrentPalette().name).toBe('light');
    applyPalette('this-palette-does-not-exist');
    expect(getCurrentPalette().name).toBe('light');
  });

  it('should handle empty string palette name gracefully', () => {
    expect(applyPalette('')).toBe(false);
  });

  it('should handle palette names with special characters', () => {
    expect(applyPalette('../../etc/passwd')).toBe(false);
  });

  it('should handle very long palette names', () => {
    expect(applyPalette('b'.repeat(1000))).toBe(false);
  });
});

// ============================================================================
// getCurrentPalette
// ============================================================================

describe('getCurrentPalette', () => {
  it('should return default palette initially', () => {
    const palette = getCurrentPalette();
    expect(palette.name).toBe('default');
  });

  it('should return the applied palette after applyPalette', () => {
    applyPalette('light');
    expect(getCurrentPalette().name).toBe('light');
  });

  it('should update when a different palette is applied', () => {
    applyPalette('light');
    expect(getCurrentPalette().name).toBe('light');
    applyPalette('default');
    expect(getCurrentPalette().name).toBe('default');
  });

  it('should return a Palette with valid colors object', () => {
    const palette = getCurrentPalette();
    expect(typeof palette.colors).toBe('object');
    expect(typeof palette.colors.primary).toBe('string');
    expect(typeof palette.colors.error).toBe('string');
  });
});

// ============================================================================
// getInkColor
// ============================================================================

describe('getInkColor', () => {
  it('should return a valid Ink color name for known ANSI codes', () => {
    // The default palette maps primary to ANSI.cyan which should resolve to 'cyan'
    expect(getInkColor('primary')).toBe('cyan');
  });

  it('should return correct Ink color for the error role (red)', () => {
    expect(getInkColor('error')).toBe('red');
  });

  it('should return correct Ink color for the success role (green)', () => {
    expect(getInkColor('success')).toBe('green');
  });

  it('should return correct Ink color for the warning role (yellow)', () => {
    expect(getInkColor('warning')).toBe('yellow');
  });

  it('should return correct Ink color for the info role (blue)', () => {
    expect(getInkColor('info')).toBe('blue');
  });

  it('should fall back to white for unmapped ANSI codes', () => {
    // background in default palette is empty string, which won't map
    expect(getInkColor('background')).toBe('white');
  });

  it('should change output after applying a different palette', () => {
    const defaultPrimary = getInkColor('primary');
    applyPalette('light');
    const lightPrimary = getInkColor('primary');
    // Light palette uses blue for primary, default uses cyan
    expect(defaultPrimary).toBe('cyan');
    expect(lightPrimary).toBe('blue');
  });

  it('should map core roles correctly for the default palette', () => {
    expect(getInkColor('secondary')).toBe('blue');
    expect(getInkColor('accent')).toBe('magenta');
    expect(getInkColor('user')).toBe('green');
    expect(getInkColor('assistant')).toBe('cyan');
    expect(getInkColor('system')).toBe('yellow');
    expect(getInkColor('text')).toBe('white');
    expect(getInkColor('textDim')).toBe('gray');
    expect(getInkColor('border')).toBe('gray');
  });

  it('should strip bold modifier and still map textBold correctly', () => {
    // textBold is bold + white, ansiToInkColor strips modifiers like \x1b[1m
    expect(getInkColor('textBold')).toBe('white');
  });

  it('should map code syntax colors correctly', () => {
    expect(getInkColor('codeKeyword')).toBe('magenta');
    expect(getInkColor('codeString')).toBe('green');
    expect(getInkColor('codeNumber')).toBe('cyan');
    expect(getInkColor('codeComment')).toBe('gray');
    expect(getInkColor('codeFunction')).toBe('yellow');
  });

  it('should map diff colors correctly', () => {
    expect(getInkColor('diffAdd')).toBe('green');
    expect(getInkColor('diffRemove')).toBe('red');
    expect(getInkColor('diffContext')).toBe('gray');
  });

  it('should return different ink colors when switching between palettes', () => {
    const results: string[] = [];
    for (const paletteName of ['default', 'light']) {
      clearHUDCache();
      applyPalette(paletteName);
      results.push(getInkColor('primary'));
    }
    expect(results[0]).toBe('cyan');
    expect(results[1]).toBe('blue');
  });

  it('should map all semantic keys for the light palette', () => {
    applyPalette('light');
    expect(getInkColor('primary')).toBe('blue');
    expect(getInkColor('error')).toBe('red');
    expect(getInkColor('success')).toBe('green');
    expect(getInkColor('warning')).toBe('yellow');
    expect(getInkColor('text')).toBe('black');
    expect(getInkColor('user')).toBe('blue');
    expect(getInkColor('assistant')).toBe('magenta');
  });
});

// ============================================================================
// paletteColorize
// ============================================================================

describe('paletteColorize', () => {
  it('should wrap text with ANSI color codes', () => {
    const result = paletteColorize('hello', 'primary');
    expect(result).toContain('hello');
    expect(result).toContain(ANSI.reset);
  });

  it('should end with ANSI reset', () => {
    expect(paletteColorize('test', 'accent').endsWith(ANSI.reset)).toBe(true);
  });

  it('should start with the palette color', () => {
    const color = getPaletteColor('primary');
    expect(paletteColorize('test', 'primary').startsWith(color)).toBe(true);
  });

  it('should produce correct structure: color + text + reset', () => {
    const color = getPaletteColor('success');
    expect(paletteColorize('ok', 'success')).toBe(`${color}ok${ANSI.reset}`);
  });

  it('should work with empty text', () => {
    const color = getPaletteColor('warning');
    expect(paletteColorize('', 'warning')).toBe(`${color}${ANSI.reset}`);
  });

  it('should work with different palettes applied', () => {
    applyPalette('light');
    const color = getPaletteColor('primary');
    const result = paletteColorize('test', 'primary');
    expect(result).toBe(`${color}test${ANSI.reset}`);
    expect(result).toContain(ANSI.blue); // light primary is blue
  });

  it('should colorize every semantic key without throwing', () => {
    const keys = [
      'primary', 'secondary', 'accent', 'text', 'textDim', 'textBold',
      'user', 'assistant', 'system', 'error',
      'codeKeyword', 'codeString', 'codeNumber', 'codeComment', 'codeFunction',
      'diffAdd', 'diffRemove', 'diffContext',
      'success', 'warning', 'info',
      'border', 'background', 'selection',
    ] as const;
    for (const key of keys) {
      const result = paletteColorize('x', key);
      expect(result).toContain('x');
      expect(result).toContain(ANSI.reset);
    }
  });
});

// ============================================================================
// getPaletteColor
// ============================================================================

describe('getPaletteColor', () => {
  it('should return a non-empty string for known color keys', () => {
    expect(getPaletteColor('primary').length).toBeGreaterThan(0);
    expect(getPaletteColor('error').length).toBeGreaterThan(0);
    expect(getPaletteColor('accent').length).toBeGreaterThan(0);
  });

  it('should return ANSI code matching the default palette', () => {
    expect(getPaletteColor('primary')).toBe(ANSI.cyan);
    expect(getPaletteColor('error')).toBe(ANSI.red);
    expect(getPaletteColor('success')).toBe(ANSI.green);
  });

  it('should return palette color from applied palette', () => {
    applyPalette('light');
    expect(getPaletteColor('primary')).toBe(ANSI.blue);
  });

  it('should return empty string for background in default palette', () => {
    expect(getPaletteColor('background')).toBe('');
  });

  it('should return different values for different semantic keys', () => {
    expect(getPaletteColor('primary')).not.toBe(getPaletteColor('error'));
  });

  it('should reflect palette changes immediately', () => {
    const beforeApply = getPaletteColor('primary');
    applyPalette('light');
    const afterApply = getPaletteColor('primary');
    expect(beforeApply).toBe(ANSI.cyan);
    expect(afterApply).toBe(ANSI.blue);
  });
});

// ============================================================================
// getBoxChars
// ============================================================================

describe('getBoxChars', () => {
  it('should return box characters for the current skin', () => {
    const box = getBoxChars();
    expect(box).toHaveProperty('topLeft');
    expect(box).toHaveProperty('topRight');
    expect(box).toHaveProperty('bottomLeft');
    expect(box).toHaveProperty('bottomRight');
    expect(box).toHaveProperty('horizontal');
    expect(box).toHaveProperty('vertical');
  });

  it('should return rounded box characters for the clean skin', () => {
    expect(getBoxChars()).toEqual(BOX_STYLES.rounded);
  });

  it('should return custom box chars when skin has custom border style', () => {
    const customChars = {
      topLeft: '+', topRight: '+',
      bottomLeft: '+', bottomRight: '+',
      horizontal: '-', vertical: '|',
      teeRight: '+', teeLeft: '+',
      teeDown: '+', teeUp: '+', cross: '+',
    };
    const customSkin = {
      ...SKINS.clean,
      borders: { style: 'custom' as const, custom: customChars },
    };
    expect(getBoxChars(customSkin)).toEqual(customChars);
  });

  it('should fall back to rounded when custom style has no custom chars', () => {
    const skinWithoutCustom = {
      ...SKINS.clean,
      borders: { style: 'custom' as const },
    };
    expect(getBoxChars(skinWithoutCustom as Skin)).toEqual(BOX_STYLES.rounded);
  });

  it('should return all 11 required box character properties', () => {
    const box = getBoxChars();
    const expectedKeys = [
      'topLeft', 'topRight', 'bottomLeft', 'bottomRight',
      'horizontal', 'vertical', 'teeRight', 'teeLeft',
      'teeDown', 'teeUp', 'cross',
    ];
    for (const key of expectedKeys) {
      expect(box).toHaveProperty(key);
      expect(typeof (box as Record<string, string>)[key]).toBe('string');
    }
  });

  it('should return correct box styles for each border type', () => {
    for (const style of ['rounded', 'sharp', 'double', 'ascii', 'none'] as const) {
      const skin = { ...SKINS.clean, borders: { style } };
      expect(getBoxChars(skin as Skin)).toEqual(BOX_STYLES[style]);
    }
  });
});

// ============================================================================
// getSpinnerFrames
// ============================================================================

describe('getSpinnerFrames', () => {
  it('should return an array of strings', () => {
    const frames = getSpinnerFrames();
    expect(Array.isArray(frames)).toBe(true);
    expect(frames.length).toBeGreaterThan(0);
    expect(typeof frames[0]).toBe('string');
  });

  it('should return braille spinner for the clean skin', () => {
    expect(getSpinnerFrames()).toEqual(SPINNER_SETS.braille);
  });

  it('should return custom spinner frames when skin has custom spinner', () => {
    const customFrames = ['A', 'B', 'C', 'D'];
    const customSkin = {
      ...SKINS.clean,
      decorations: {
        ...SKINS.clean.decorations,
        spinner: 'custom' as const,
        customSpinner: customFrames,
      },
    };
    expect(getSpinnerFrames(customSkin as Skin)).toEqual(customFrames);
  });

  it('should fall back to braille when custom spinner has no customSpinner array', () => {
    const skinWithoutCustom = {
      ...SKINS.clean,
      decorations: {
        ...SKINS.clean.decorations,
        spinner: 'custom' as const,
      },
    };
    expect(getSpinnerFrames(skinWithoutCustom as Skin)).toEqual(SPINNER_SETS.braille);
  });

  it('should return the correct spinner set for each named spinner type', () => {
    for (const spinnerName of ['braille', 'dots', 'simple', 'blocks'] as const) {
      const skin = {
        ...SKINS.clean,
        decorations: { ...SKINS.clean.decorations, spinner: spinnerName },
      };
      expect(getSpinnerFrames(skin as Skin)).toEqual(SPINNER_SETS[spinnerName]);
    }
  });
});

// ============================================================================
// getInkBorderStyle
// ============================================================================

describe('getInkBorderStyle', () => {
  it('should return round for clean skin (rounded borders)', () => {
    expect(getInkBorderStyle()).toBe('round');
  });

  it('should map rounded to round', () => {
    const skin = { ...SKINS.clean, borders: { style: 'rounded' as const } };
    expect(getInkBorderStyle(skin as Skin)).toBe('round');
  });

  it('should map sharp to single', () => {
    const skin = { ...SKINS.clean, borders: { style: 'sharp' as const } };
    expect(getInkBorderStyle(skin as Skin)).toBe('single');
  });

  it('should map double to double', () => {
    const skin = { ...SKINS.clean, borders: { style: 'double' as const } };
    expect(getInkBorderStyle(skin as Skin)).toBe('double');
  });

  it('should map ascii to classic', () => {
    const skin = { ...SKINS.clean, borders: { style: 'ascii' as const } };
    expect(getInkBorderStyle(skin as Skin)).toBe('classic');
  });

  it('should map none to single', () => {
    const skin = { ...SKINS.clean, borders: { style: 'none' as const } };
    expect(getInkBorderStyle(skin as Skin)).toBe('single');
  });

  it('should fall back to round for unmapped border style', () => {
    const skin = { ...SKINS.clean, borders: { style: 'custom' as const } };
    expect(getInkBorderStyle(skin as Skin)).toBe('round');
  });
});

// ============================================================================
// clearHUDCache
// ============================================================================

describe('clearHUDCache', () => {
  it('should reset palette to default after clearing', () => {
    applyPalette('light');
    expect(getCurrentPalette().name).toBe('light');
    clearHUDCache();
    expect(getCurrentPalette().name).toBe('default');
  });

  it('should be safe to call multiple times', () => {
    clearHUDCache();
    clearHUDCache();
    clearHUDCache();
    expect(getCurrentPalette().name).toBe('default');
  });

  it('should make getInkColor return default palette colors', () => {
    applyPalette('light');
    expect(getInkColor('primary')).toBe('blue');
    clearHUDCache();
    expect(getInkColor('primary')).toBe('cyan');
  });
});

// ============================================================================
// Integration: single skin + palette switching
// ============================================================================

describe('skin + palette integration', () => {
  it('should keep box chars and spinner from the single skin regardless of palette', () => {
    for (const paletteName of Object.keys(PALETTES)) {
      clearHUDCache();
      applyPalette(paletteName);
      expect(getBoxChars()).toEqual(BOX_STYLES.rounded);
      expect(getSpinnerFrames()).toEqual(SPINNER_SETS.braille);
    }
  });

  it('should produce a valid Ink color for every applied palette', () => {
    for (const paletteName of Object.keys(PALETTES)) {
      clearHUDCache();
      applyPalette(paletteName);
      const color = getInkColor('primary');
      expect(typeof color).toBe('string');
      expect(color.length).toBeGreaterThan(0);
    }
  });
});
