import { describe, it, expect, beforeEach } from 'vitest';
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
} from '../src/hud/api.js';
import { SKINS, BOX_STYLES, SPINNER_SETS } from '../src/hud/skins.js';
import { PALETTES } from '../src/hud/palettes.js';
import { colors as ANSI } from '../src/styles.js';

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
});
