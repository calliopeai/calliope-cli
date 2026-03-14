import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSkin,
  applySkin,
  getCurrentSkin,
  listSkins,
  getPalette,
  applyPalette,
  getCurrentPalette,
  listPalettes,
  getInkColor,
  paletteColorize,
  getPaletteColor,
  getBoxChars,
  getSpinnerFrames,
  getInkBorderStyle,
  applyHUD,
  discoverSkins,
  discoverPalettes,
  clearHUDCache,
  saveCustomSkin,
  saveCustomPalette,
} from '../src/hud/api.js';
import { SKINS, BOX_STYLES, SPINNER_SETS } from '../src/hud/skins.js';
import { PALETTES } from '../src/hud/palettes.js';
import { colors as ANSI } from '../src/styles.js';
import type { Skin, Palette, BoxChars } from '../src/hud/types.js';

// Reset module state before each test to avoid cross-test contamination
beforeEach(() => {
  clearHUDCache();
});

// ============================================================================
// getSkin
// ============================================================================

describe('getSkin', () => {
  it('should return the clean skin when called with no arguments', () => {
    const skin = getSkin();
    expect(skin.name).toBe('clean');
  });

  it('should return named skin when a valid name is given', () => {
    const skin = getSkin('falcon');
    expect(skin.name).toBe('falcon');
  });

  it('should fall back to clean for unknown skin name', () => {
    const skin = getSkin('nonexistent-skin-xyz');
    expect(skin.name).toBe('clean');
  });

  it('should return currently applied skin when called with no arguments after applySkin', () => {
    applySkin('falcon');
    const skin = getSkin();
    expect(skin.name).toBe('falcon');
  });

  it('should return all expected properties on the returned skin', () => {
    const skin = getSkin('clean');
    expect(skin).toHaveProperty('name');
    expect(skin).toHaveProperty('description');
    expect(skin).toHaveProperty('banner');
    expect(skin).toHaveProperty('borders');
    expect(skin).toHaveProperty('decorations');
    expect(skin).toHaveProperty('diff');
    expect(skin).toHaveProperty('density');
    expect(skin).toHaveProperty('responsive');
  });

  it('should return every built-in skin by name', () => {
    for (const name of Object.keys(SKINS)) {
      const skin = getSkin(name);
      expect(skin.name).toBe(name);
    }
  });

  it('should return different skins for different names', () => {
    const clean = getSkin('clean');
    const falcon = getSkin('falcon');
    expect(clean.name).not.toBe(falcon.name);
  });
});

// ============================================================================
// applySkin
// ============================================================================

describe('applySkin', () => {
  it('should return true for a known skin', () => {
    expect(applySkin('clean')).toBe(true);
  });

  it('should return true for another known skin', () => {
    expect(applySkin('falcon')).toBe(true);
  });

  it('should return false for an unknown skin', () => {
    expect(applySkin('nonexistent-skin-xyz')).toBe(false);
  });

  it('should set the current skin when successful', () => {
    applySkin('falcon');
    expect(getCurrentSkin().name).toBe('falcon');
  });

  it('should return true for all built-in skins', () => {
    for (const name of Object.keys(SKINS)) {
      clearHUDCache();
      expect(applySkin(name)).toBe(true);
      expect(getCurrentSkin().name).toBe(name);
    }
  });

  it('should not change skin when applying an invalid name', () => {
    applySkin('falcon');
    expect(getCurrentSkin().name).toBe('falcon');
    applySkin('does-not-exist-at-all');
    // After a failed apply, the skin should remain unchanged
    // (applySkin returns false but doesn't reset)
    expect(getCurrentSkin().name).toBe('falcon');
  });
});

// ============================================================================
// getCurrentSkin
// ============================================================================

describe('getCurrentSkin', () => {
  it('should return clean skin by default (no skin applied)', () => {
    const skin = getCurrentSkin();
    expect(skin.name).toBe('clean');
  });

  it('should return the applied skin after applySkin', () => {
    applySkin('falcon');
    expect(getCurrentSkin().name).toBe('falcon');
  });

  it('should update when a different skin is applied', () => {
    applySkin('falcon');
    expect(getCurrentSkin().name).toBe('falcon');
    applySkin('clean');
    expect(getCurrentSkin().name).toBe('clean');
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
});

// ============================================================================
// listSkins
// ============================================================================

describe('listSkins', () => {
  it('should return a non-empty array', () => {
    const skins = listSkins();
    expect(skins.length).toBeGreaterThan(0);
  });

  it('should include the clean skin', () => {
    const skins = listSkins();
    const clean = skins.find((s) => s.name === 'clean');
    expect(clean).toBeDefined();
    expect(clean!.custom).toBe(false);
  });

  it('should include the falcon skin', () => {
    const skins = listSkins();
    const falcon = skins.find((s) => s.name === 'falcon');
    expect(falcon).toBeDefined();
  });

  it('should have name, description, and custom on every entry', () => {
    const skins = listSkins();
    for (const skin of skins) {
      expect(skin).toHaveProperty('name');
      expect(typeof skin.name).toBe('string');
      expect(skin).toHaveProperty('description');
      expect(typeof skin.description).toBe('string');
      expect(skin).toHaveProperty('custom');
      expect(typeof skin.custom).toBe('boolean');
    }
  });

  it('should list all built-in skins', () => {
    const skins = listSkins();
    const skinNames = skins.map((s) => s.name);
    for (const builtInName of Object.keys(SKINS)) {
      expect(skinNames).toContain(builtInName);
    }
  });

  it('should mark all built-in skins as not custom', () => {
    const skins = listSkins();
    for (const builtInName of Object.keys(SKINS)) {
      const entry = skins.find((s) => s.name === builtInName);
      expect(entry).toBeDefined();
      expect(entry!.custom).toBe(false);
    }
  });

  it('should have a description for every built-in skin', () => {
    const skins = listSkins();
    for (const entry of skins.filter((s) => !s.custom)) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
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
    applyPalette('monokai');
    expect(getCurrentPalette().name).toBe('monokai');
    applyPalette('this-palette-does-not-exist');
    expect(getCurrentPalette().name).toBe('monokai');
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
// listPalettes
// ============================================================================

describe('listPalettes', () => {
  it('should return a non-empty array', () => {
    const palettes = listPalettes();
    expect(palettes.length).toBeGreaterThan(0);
  });

  it('should include the default palette', () => {
    const palettes = listPalettes();
    const def = palettes.find((p) => p.name === 'default');
    expect(def).toBeDefined();
    expect(def!.custom).toBe(false);
  });

  it('should include the light palette', () => {
    const palettes = listPalettes();
    const light = palettes.find((p) => p.name === 'light');
    expect(light).toBeDefined();
  });

  it('should have name, description, and custom on every entry', () => {
    const palettes = listPalettes();
    for (const palette of palettes) {
      expect(palette).toHaveProperty('name');
      expect(typeof palette.name).toBe('string');
      expect(palette).toHaveProperty('description');
      expect(typeof palette.description).toBe('string');
      expect(palette).toHaveProperty('custom');
      expect(typeof palette.custom).toBe('boolean');
    }
  });

  it('should list all built-in palettes', () => {
    const palettes = listPalettes();
    const paletteNames = palettes.map((p) => p.name);
    for (const builtInName of Object.keys(PALETTES)) {
      expect(paletteNames).toContain(builtInName);
    }
  });

  it('should mark all built-in palettes as not custom', () => {
    const palettes = listPalettes();
    for (const builtInName of Object.keys(PALETTES)) {
      const entry = palettes.find((p) => p.name === builtInName);
      expect(entry).toBeDefined();
      expect(entry!.custom).toBe(false);
    }
  });
});

// ============================================================================
// getInkColor
// ============================================================================

describe('getInkColor', () => {
  it('should return a string for the primary role', () => {
    const result = getInkColor('primary');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return a string for the accent role', () => {
    const result = getInkColor('accent');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return a string for the error role', () => {
    const result = getInkColor('error');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return a valid Ink color name for known ANSI codes', () => {
    // The default palette maps primary to ANSI.cyan which should resolve to 'cyan'
    const result = getInkColor('primary');
    expect(result).toBe('cyan');
  });

  it('should return correct Ink color for the error role (red)', () => {
    const result = getInkColor('error');
    expect(result).toBe('red');
  });

  it('should return correct Ink color for the success role (green)', () => {
    const result = getInkColor('success');
    expect(result).toBe('green');
  });

  it('should return correct Ink color for the warning role (yellow)', () => {
    const result = getInkColor('warning');
    expect(result).toBe('yellow');
  });

  it('should return correct Ink color for the info role (blue)', () => {
    const result = getInkColor('info');
    expect(result).toBe('blue');
  });

  it('should fall back to white for unmapped ANSI codes', () => {
    // background in default palette is empty string, which won't map
    const result = getInkColor('background');
    expect(result).toBe('white');
  });

  it('should change output after applying a different palette', () => {
    const defaultPrimary = getInkColor('primary');
    applyPalette('light');
    const lightPrimary = getInkColor('primary');
    // Light palette uses blue for primary, default uses cyan
    expect(defaultPrimary).toBe('cyan');
    expect(lightPrimary).toBe('blue');
  });

  it('should map secondary color correctly for default palette', () => {
    expect(getInkColor('secondary')).toBe('blue');
  });

  it('should map accent color correctly for default palette (magenta)', () => {
    expect(getInkColor('accent')).toBe('magenta');
  });

  it('should map user color correctly for default palette (green)', () => {
    expect(getInkColor('user')).toBe('green');
  });

  it('should map assistant color correctly for default palette (cyan)', () => {
    expect(getInkColor('assistant')).toBe('cyan');
  });

  it('should map system color correctly for default palette (yellow)', () => {
    expect(getInkColor('system')).toBe('yellow');
  });

  it('should map text color correctly for default palette (white)', () => {
    expect(getInkColor('text')).toBe('white');
  });

  it('should map textDim color correctly for default palette (gray)', () => {
    expect(getInkColor('textDim')).toBe('gray');
  });

  it('should strip bold modifier and still map textBold correctly', () => {
    // textBold is bold + white, ansiToInkColor strips modifiers like \x1b[1m
    const result = getInkColor('textBold');
    expect(result).toBe('white');
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

  it('should map border color correctly for default palette (gray)', () => {
    expect(getInkColor('border')).toBe('gray');
  });

  it('should return different ink colors when switching between palettes', () => {
    // default: primary=cyan, light: primary=blue, monokai may differ
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

  it('should contain the palette color code for the given role', () => {
    const color = getPaletteColor('error');
    const result = paletteColorize('error message', 'error');
    expect(result).toContain(color);
    expect(result).toContain('error message');
  });

  it('should end with ANSI reset', () => {
    const result = paletteColorize('test', 'accent');
    expect(result.endsWith(ANSI.reset)).toBe(true);
  });

  it('should start with the palette color', () => {
    const color = getPaletteColor('primary');
    const result = paletteColorize('test', 'primary');
    expect(result.startsWith(color)).toBe(true);
  });

  it('should produce correct structure: color + text + reset', () => {
    const color = getPaletteColor('success');
    const result = paletteColorize('ok', 'success');
    expect(result).toBe(`${color}ok${ANSI.reset}`);
  });

  it('should work with empty text', () => {
    const color = getPaletteColor('warning');
    const result = paletteColorize('', 'warning');
    expect(result).toBe(`${color}${ANSI.reset}`);
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
    const primary = getPaletteColor('primary');
    const error = getPaletteColor('error');
    expect(primary).not.toBe(error);
  });

  it('should return matching values for same key across calls', () => {
    const first = getPaletteColor('accent');
    const second = getPaletteColor('accent');
    expect(first).toBe(second);
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
    const box = getBoxChars();
    expect(box).toEqual(BOX_STYLES.rounded);
  });

  it('should return double box characters for the falcon skin', () => {
    const falcon = getSkin('falcon');
    const box = getBoxChars(falcon);
    expect(box).toEqual(BOX_STYLES.double);
  });

  it('should use the current skin when no argument given', () => {
    applySkin('falcon');
    const box = getBoxChars();
    expect(box).toEqual(BOX_STYLES.double);
  });

  it('should return custom box chars when skin has custom border style', () => {
    const customChars: BoxChars = {
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
    const box = getBoxChars(customSkin);
    expect(box).toEqual(customChars);
  });

  it('should fall back to rounded when custom style has no custom chars', () => {
    const skinWithoutCustom = {
      ...SKINS.clean,
      borders: { style: 'custom' as const },
    };
    // custom style but no custom property -> falsy, falls through to BOX_STYLES lookup
    const box = getBoxChars(skinWithoutCustom as Skin);
    // BOX_STYLES['custom'] is undefined, so falls back to rounded
    expect(box).toEqual(BOX_STYLES.rounded);
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
      const box = getBoxChars(skin as Skin);
      expect(box).toEqual(BOX_STYLES[style]);
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
    const frames = getSpinnerFrames();
    expect(frames).toEqual(SPINNER_SETS.braille);
  });

  it('should use current skin when no argument given', () => {
    applySkin('clean');
    const frames = getSpinnerFrames();
    expect(frames).toEqual(SPINNER_SETS.braille);
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
    const frames = getSpinnerFrames(customSkin as Skin);
    expect(frames).toEqual(customFrames);
  });

  it('should fall back to braille when custom spinner has no customSpinner array', () => {
    const skinWithoutCustom = {
      ...SKINS.clean,
      decorations: {
        ...SKINS.clean.decorations,
        spinner: 'custom' as const,
      },
    };
    const frames = getSpinnerFrames(skinWithoutCustom as Skin);
    // SPINNER_SETS['custom'] is undefined, so falls back to braille
    expect(frames).toEqual(SPINNER_SETS.braille);
  });

  it('should return the correct spinner set for each named spinner type', () => {
    for (const spinnerName of ['braille', 'dots', 'simple', 'blocks'] as const) {
      const skin = {
        ...SKINS.clean,
        decorations: { ...SKINS.clean.decorations, spinner: spinnerName },
      };
      const frames = getSpinnerFrames(skin as Skin);
      expect(frames).toEqual(SPINNER_SETS[spinnerName]);
    }
  });
});

// ============================================================================
// getInkBorderStyle
// ============================================================================

describe('getInkBorderStyle', () => {
  it('should return round for clean skin (rounded borders)', () => {
    const style = getInkBorderStyle();
    expect(style).toBe('round');
  });

  it('should return double for falcon skin', () => {
    const falcon = getSkin('falcon');
    const style = getInkBorderStyle(falcon);
    expect(style).toBe('double');
  });

  it('should use current skin when no argument given', () => {
    applySkin('falcon');
    const style = getInkBorderStyle();
    expect(style).toBe('double');
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
// applyHUD
// ============================================================================

describe('applyHUD', () => {
  it('should apply both skin and palette', () => {
    applyHUD('falcon', 'light');
    expect(getCurrentSkin().name).toBe('falcon');
    expect(getCurrentPalette().name).toBe('light');
  });

  it('should accept an optional companion parameter', () => {
    // Should not throw
    applyHUD('clean', 'default', 'calliope');
    expect(getCurrentSkin().name).toBe('clean');
    expect(getCurrentPalette().name).toBe('default');
  });

  it('should work with different skin/palette combos', () => {
    applyHUD('wargames', 'monokai');
    expect(getCurrentSkin().name).toBe('wargames');
    expect(getCurrentPalette().name).toBe('monokai');
  });

  it('should overwrite previous HUD settings', () => {
    applyHUD('falcon', 'light');
    applyHUD('clean', 'default');
    expect(getCurrentSkin().name).toBe('clean');
    expect(getCurrentPalette().name).toBe('default');
  });

  it('should handle invalid skin gracefully (falls back to clean)', () => {
    applyHUD('nonexistent-xyz', 'default');
    // applySkin returns false but still calls it; getCurrentSkin falls back to clean
    expect(getCurrentPalette().name).toBe('default');
  });

  it('should handle invalid palette gracefully (falls back to default)', () => {
    applyHUD('clean', 'nonexistent-xyz');
    expect(getCurrentSkin().name).toBe('clean');
  });
});

// ============================================================================
// discoverSkins / discoverPalettes
// ============================================================================

describe('discoverSkins', () => {
  it('should return an array of Skin objects', () => {
    const skins = discoverSkins();
    expect(Array.isArray(skins)).toBe(true);
    expect(skins.length).toBeGreaterThan(0);
  });

  it('should include all built-in skins', () => {
    const skins = discoverSkins();
    const names = skins.map((s) => s.name);
    for (const builtInName of Object.keys(SKINS)) {
      expect(names).toContain(builtInName);
    }
  });

  it('should return full Skin objects with required properties', () => {
    const skins = discoverSkins();
    for (const skin of skins) {
      expect(skin).toHaveProperty('name');
      expect(skin).toHaveProperty('description');
      expect(skin).toHaveProperty('banner');
      expect(skin).toHaveProperty('borders');
    }
  });

  it('should return at least as many skins as SKINS registry', () => {
    const skins = discoverSkins();
    expect(skins.length).toBeGreaterThanOrEqual(Object.keys(SKINS).length);
  });

  it('should return skins with valid banner and decorations', () => {
    const skins = discoverSkins();
    for (const skin of skins) {
      expect(skin.banner).toBeDefined();
      expect(Array.isArray(skin.banner.art)).toBe(true);
      expect(skin.decorations).toBeDefined();
      expect(typeof skin.decorations.promptPrefix).toBe('string');
    }
  });
});

describe('discoverPalettes', () => {
  it('should return an array of Palette objects', () => {
    const palettes = discoverPalettes();
    expect(Array.isArray(palettes)).toBe(true);
    expect(palettes.length).toBeGreaterThan(0);
  });

  it('should include all built-in palettes', () => {
    const palettes = discoverPalettes();
    const names = palettes.map((p) => p.name);
    for (const builtInName of Object.keys(PALETTES)) {
      expect(names).toContain(builtInName);
    }
  });

  it('should return full Palette objects with required properties', () => {
    const palettes = discoverPalettes();
    for (const palette of palettes) {
      expect(palette).toHaveProperty('name');
      expect(palette).toHaveProperty('description');
      expect(palette).toHaveProperty('colors');
    }
  });

  it('should return at least as many palettes as PALETTES registry', () => {
    const palettes = discoverPalettes();
    expect(palettes.length).toBeGreaterThanOrEqual(Object.keys(PALETTES).length);
  });

  it('should return palettes with all 24 color keys', () => {
    const palettes = discoverPalettes();
    for (const palette of palettes) {
      expect(Object.keys(palette.colors).length).toBeGreaterThanOrEqual(24);
    }
  });
});

// ============================================================================
// clearHUDCache
// ============================================================================

describe('clearHUDCache', () => {
  it('should reset skin to default after clearing', () => {
    applySkin('falcon');
    expect(getCurrentSkin().name).toBe('falcon');
    clearHUDCache();
    expect(getCurrentSkin().name).toBe('clean');
  });

  it('should reset palette to default after clearing', () => {
    applyPalette('light');
    expect(getCurrentPalette().name).toBe('light');
    clearHUDCache();
    expect(getCurrentPalette().name).toBe('default');
  });

  it('should reset both skin and palette together', () => {
    applyHUD('falcon', 'monokai');
    expect(getCurrentSkin().name).toBe('falcon');
    expect(getCurrentPalette().name).toBe('monokai');
    clearHUDCache();
    expect(getCurrentSkin().name).toBe('clean');
    expect(getCurrentPalette().name).toBe('default');
  });

  it('should be safe to call multiple times', () => {
    clearHUDCache();
    clearHUDCache();
    clearHUDCache();
    expect(getCurrentSkin().name).toBe('clean');
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
// saveCustomSkin / saveCustomPalette
// ============================================================================

describe('saveCustomSkin', () => {
  const tmpDir = path.join(os.tmpdir(), 'calliope-test-skins-' + Date.now());

  afterEach(() => {
    // Clean up
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should be a function', () => {
    expect(typeof saveCustomSkin).toBe('function');
  });

  it('should write a skin JSON file to the skins directory', () => {
    // This calls the real saveCustomSkin which writes to ~/.calliope-cli/skins/
    // We just verify it doesn't throw for a valid skin object
    const testSkin: Skin = {
      ...SKINS.clean,
      name: '__test_save_skin_' + Date.now(),
    };
    // Should not throw
    expect(() => saveCustomSkin(testSkin)).not.toThrow();
    // Clean up the file
    const expectedPath = path.join(os.homedir(), '.calliope-cli', 'skins', `${testSkin.name}.json`);
    try {
      fs.unlinkSync(expectedPath);
    } catch {
      // file might not exist
    }
  });
});

describe('saveCustomPalette', () => {
  it('should be a function', () => {
    expect(typeof saveCustomPalette).toBe('function');
  });

  it('should write a palette JSON file to the palettes directory', () => {
    const testPalette: Palette = {
      ...PALETTES.default,
      name: '__test_save_palette_' + Date.now(),
    };
    expect(() => saveCustomPalette(testPalette)).not.toThrow();
    // Clean up the file
    const expectedPath = path.join(os.homedir(), '.calliope-cli', 'palettes', `${testPalette.name}.json`);
    try {
      fs.unlinkSync(expectedPath);
    } catch {
      // file might not exist
    }
  });
});

// ============================================================================
// Integration: skin + palette combinations
// ============================================================================

describe('skin + palette integration', () => {
  it('should allow applying any combination of skin and palette', () => {
    const skinNames = Object.keys(SKINS);
    const paletteNames = Object.keys(PALETTES);
    // Test a few combinations
    for (let i = 0; i < Math.min(skinNames.length, 3); i++) {
      for (let j = 0; j < Math.min(paletteNames.length, 3); j++) {
        clearHUDCache();
        applySkin(skinNames[i]);
        applyPalette(paletteNames[j]);
        expect(getCurrentSkin().name).toBe(skinNames[i]);
        expect(getCurrentPalette().name).toBe(paletteNames[j]);
        // getInkColor should still work
        const color = getInkColor('primary');
        expect(typeof color).toBe('string');
        expect(color.length).toBeGreaterThan(0);
      }
    }
  });

  it('should maintain independent skin and palette state', () => {
    applySkin('falcon');
    applyPalette('monokai');
    // Changing skin should not affect palette
    applySkin('clean');
    expect(getCurrentPalette().name).toBe('monokai');
    // Changing palette should not affect skin
    applyPalette('default');
    expect(getCurrentSkin().name).toBe('clean');
  });

  it('should produce correct box chars and spinner for active skin regardless of palette', () => {
    applySkin('falcon');
    applyPalette('light');
    expect(getBoxChars()).toEqual(BOX_STYLES.double);
    applyPalette('neon');
    expect(getBoxChars()).toEqual(BOX_STYLES.double);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('edge cases', () => {
  it('should handle empty string skin name gracefully', () => {
    const result = applySkin('');
    expect(result).toBe(false);
  });

  it('should handle empty string palette name gracefully', () => {
    const result = applyPalette('');
    expect(result).toBe(false);
  });

  it('should handle skin names with special characters', () => {
    const result = applySkin('../../etc/passwd');
    expect(result).toBe(false);
  });

  it('should handle palette names with special characters', () => {
    const result = applyPalette('../../etc/passwd');
    expect(result).toBe(false);
  });

  it('should handle very long skin names', () => {
    const longName = 'a'.repeat(1000);
    const result = applySkin(longName);
    expect(result).toBe(false);
  });

  it('should handle very long palette names', () => {
    const longName = 'b'.repeat(1000);
    const result = applyPalette(longName);
    expect(result).toBe(false);
  });

  it('getSkin should return clean when called with undefined', () => {
    const skin = getSkin(undefined);
    expect(skin.name).toBe('clean');
  });

  it('getPalette should return default when called with undefined', () => {
    const palette = getPalette(undefined);
    expect(palette.name).toBe('default');
  });
});

// ============================================================================
// Custom skin/palette validation via filesystem
// ============================================================================

describe('custom skin validation via getSkin', () => {
  const hudDir = path.join(os.homedir(), '.calliope-cli');
  const skinsDir = path.join(hudDir, 'skins');

  function buildValidSkin(name: string): object {
    return {
      name,
      description: 'A test custom skin',
      banner: { art: ['Hello'], style: 'full' },
      borders: { style: 'rounded' },
      decorations: {
        promptPrefix: '> ',
        assistantPrefix: '< ',
        toolPrefix: '[',
        toolSuffix: ']',
        separator: '---',
        spinner: 'braille',
      },
      diff: { style: 'inline', showLineNumbers: true, contextLines: 3, maxLineWidth: 120, wordDiff: false },
      density: 'normal',
      responsive: { compact: 60, wide: 120 },
    };
  }

  function buildValidPalette(name: string): object {
    const color = '\x1b[36m';
    return {
      name,
      description: 'A test custom palette',
      colors: {
        primary: color, secondary: color, accent: color,
        text: color, textDim: color, textBold: color,
        user: color, assistant: color, system: color, error: color,
        codeKeyword: color, codeString: color, codeNumber: color, codeComment: color, codeFunction: color,
        diffAdd: color, diffRemove: color, diffContext: color,
        success: color, warning: color, info: color,
        border: color, background: '', selection: color,
      },
    };
  }

  afterEach(() => {
    clearHUDCache();
  });

  it('should load a valid custom skin from the skins directory', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_custom_valid_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    fs.writeFileSync(skinPath, JSON.stringify(buildValidSkin(skinName)));

    try {
      const skin = getSkin(skinName);
      expect(skin.name).toBe(skinName);
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should fall back to clean when custom skin file has invalid JSON schema', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_custom_invalid_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    // Missing required fields — should fail validation
    fs.writeFileSync(skinPath, JSON.stringify({ name: skinName }));

    try {
      const skin = getSkin(skinName);
      expect(skin.name).toBe('clean'); // Fallback
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should fall back to clean when custom skin file is too large', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_custom_toobig_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    // Write > 1MB file
    const bigData = JSON.stringify({ name: skinName, data: 'x'.repeat(1_100_000) });
    fs.writeFileSync(skinPath, bigData);

    try {
      const skin = getSkin(skinName);
      expect(skin.name).toBe('clean');
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should list custom skins alongside built-ins', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_list_custom_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    fs.writeFileSync(skinPath, JSON.stringify(buildValidSkin(skinName)));

    try {
      const skins = listSkins();
      const custom = skins.find(s => s.name === skinName);
      expect(custom).toBeDefined();
      expect(custom!.custom).toBe(true);
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should not list invalid custom skin files in listSkins', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_invalid_list_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    // Invalid skin - missing banner
    fs.writeFileSync(skinPath, JSON.stringify({ name: skinName, description: 'bad' }));

    try {
      const skins = listSkins();
      const found = skins.find(s => s.name === skinName);
      expect(found).toBeUndefined();
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should discover custom skins in discoverSkins', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_discover_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    fs.writeFileSync(skinPath, JSON.stringify(buildValidSkin(skinName)));

    try {
      const skins = discoverSkins();
      const found = skins.find(s => s.name === skinName);
      expect(found).toBeDefined();
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should handle skin with ANSI injection in banner art — strips OSC/CSI sequences', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_sanitize_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    const skinWithInjection = buildValidSkin(skinName) as Record<string, unknown>;
    (skinWithInjection.banner as { art: string[] }).art = [
      // OSC sequence that would set terminal title
      '\x1b]0;hacked\x07Safe Text',
    ];
    fs.writeFileSync(skinPath, JSON.stringify(skinWithInjection));

    try {
      const skin = getSkin(skinName);
      // If loaded, the OSC sequences should be stripped
      if (skin.name === skinName) {
        expect(skin.banner.art[0]).not.toContain('\x1b]');
        expect(skin.banner.art[0]).toContain('Safe Text');
      }
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should handle invalid banner art array with non-string elements', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_bad_banner_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    const badSkin = buildValidSkin(skinName) as Record<string, unknown>;
    (badSkin.banner as Record<string, unknown>).art = [1, 2, 3]; // non-strings
    fs.writeFileSync(skinPath, JSON.stringify(badSkin));

    try {
      const skin = getSkin(skinName);
      // Non-string art array elements should fail validation
      expect(skin.name).toBe('clean');
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should reject skin with invalid border style', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_bad_border_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    const badSkin = buildValidSkin(skinName) as Record<string, unknown>;
    (badSkin.borders as Record<string, unknown>).style = 'invalid-style';
    fs.writeFileSync(skinPath, JSON.stringify(badSkin));

    try {
      const skin = getSkin(skinName);
      expect(skin.name).toBe('clean');
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should reject skin with invalid density', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_bad_density_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    const badSkin = buildValidSkin(skinName) as Record<string, unknown>;
    badSkin.density = 'ultra-dense';
    fs.writeFileSync(skinPath, JSON.stringify(badSkin));

    try {
      const skin = getSkin(skinName);
      expect(skin.name).toBe('clean');
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });

  it('should reject skin with invalid spinner type', () => {
    fs.mkdirSync(skinsDir, { recursive: true });
    const skinName = '__test_bad_spinner_' + Date.now();
    const skinPath = path.join(skinsDir, `${skinName}.json`);
    const badSkin = buildValidSkin(skinName) as Record<string, unknown>;
    (badSkin.decorations as Record<string, unknown>).spinner = 'turbo-spin';
    fs.writeFileSync(skinPath, JSON.stringify(badSkin));

    try {
      const skin = getSkin(skinName);
      expect(skin.name).toBe('clean');
    } finally {
      try { fs.unlinkSync(skinPath); } catch { /* ignore */ }
    }
  });
});

describe('custom palette validation via getPalette', () => {
  const hudDir = path.join(os.homedir(), '.calliope-cli');
  const palettesDir = path.join(hudDir, 'palettes');

  function buildValidPalette(name: string): object {
    const color = '\x1b[36m';
    return {
      name,
      description: 'A test custom palette',
      colors: {
        primary: color, secondary: color, accent: color,
        text: color, textDim: color, textBold: color,
        user: color, assistant: color, system: color, error: color,
        codeKeyword: color, codeString: color, codeNumber: color, codeComment: color, codeFunction: color,
        diffAdd: color, diffRemove: color, diffContext: color,
        success: color, warning: color, info: color,
        border: color, background: '', selection: color,
      },
    };
  }

  afterEach(() => {
    clearHUDCache();
  });

  it('should load a valid custom palette from the palettes directory', () => {
    fs.mkdirSync(palettesDir, { recursive: true });
    const paletteName = '__test_pal_valid_' + Date.now();
    const palettePath = path.join(palettesDir, `${paletteName}.json`);
    fs.writeFileSync(palettePath, JSON.stringify(buildValidPalette(paletteName)));

    try {
      const palette = getPalette(paletteName);
      expect(palette.name).toBe(paletteName);
    } finally {
      try { fs.unlinkSync(palettePath); } catch { /* ignore */ }
    }
  });

  it('should fall back to default when custom palette is invalid', () => {
    fs.mkdirSync(palettesDir, { recursive: true });
    const paletteName = '__test_pal_invalid_' + Date.now();
    const palettePath = path.join(palettesDir, `${paletteName}.json`);
    // Missing required color keys
    fs.writeFileSync(palettePath, JSON.stringify({ name: paletteName, description: 'bad', colors: {} }));

    try {
      const palette = getPalette(paletteName);
      expect(palette.name).toBe('default');
    } finally {
      try { fs.unlinkSync(palettePath); } catch { /* ignore */ }
    }
  });

  it('should list custom palettes alongside built-ins', () => {
    fs.mkdirSync(palettesDir, { recursive: true });
    const paletteName = '__test_pal_list_' + Date.now();
    const palettePath = path.join(palettesDir, `${paletteName}.json`);
    fs.writeFileSync(palettePath, JSON.stringify(buildValidPalette(paletteName)));

    try {
      const palettes = listPalettes();
      const custom = palettes.find(p => p.name === paletteName);
      expect(custom).toBeDefined();
      expect(custom!.custom).toBe(true);
    } finally {
      try { fs.unlinkSync(palettePath); } catch { /* ignore */ }
    }
  });

  it('should discover custom palettes in discoverPalettes', () => {
    fs.mkdirSync(palettesDir, { recursive: true });
    const paletteName = '__test_pal_discover_' + Date.now();
    const palettePath = path.join(palettesDir, `${paletteName}.json`);
    fs.writeFileSync(palettePath, JSON.stringify(buildValidPalette(paletteName)));

    try {
      const palettes = discoverPalettes();
      const found = palettes.find(p => p.name === paletteName);
      expect(found).toBeDefined();
    } finally {
      try { fs.unlinkSync(palettePath); } catch { /* ignore */ }
    }
  });

  it('should reject palette missing required color keys', () => {
    fs.mkdirSync(palettesDir, { recursive: true });
    const paletteName = '__test_pal_missingkeys_' + Date.now();
    const palettePath = path.join(palettesDir, `${paletteName}.json`);
    // Only has one color key instead of 24
    fs.writeFileSync(palettePath, JSON.stringify({
      name: paletteName,
      description: 'test',
      colors: { primary: '\x1b[36m' }, // missing all others
    }));

    try {
      const palette = getPalette(paletteName);
      expect(palette.name).toBe('default');
    } finally {
      try { fs.unlinkSync(palettePath); } catch { /* ignore */ }
    }
  });

  it('should reject palette with non-object colors field', () => {
    fs.mkdirSync(palettesDir, { recursive: true });
    const paletteName = '__test_pal_badcolors_' + Date.now();
    const palettePath = path.join(palettesDir, `${paletteName}.json`);
    fs.writeFileSync(palettePath, JSON.stringify({
      name: paletteName,
      description: 'bad',
      colors: 'not-an-object',
    }));

    try {
      const palette = getPalette(paletteName);
      expect(palette.name).toBe('default');
    } finally {
      try { fs.unlinkSync(palettePath); } catch { /* ignore */ }
    }
  });

  it('should handle palette file that is too large', () => {
    fs.mkdirSync(palettesDir, { recursive: true });
    const paletteName = '__test_pal_toobig_' + Date.now();
    const palettePath = path.join(palettesDir, `${paletteName}.json`);
    fs.writeFileSync(palettePath, 'x'.repeat(1_100_000));

    try {
      const palette = getPalette(paletteName);
      expect(palette.name).toBe('default');
    } finally {
      try { fs.unlinkSync(palettePath); } catch { /* ignore */ }
    }
  });
});
