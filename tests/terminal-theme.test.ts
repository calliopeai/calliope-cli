/**
 * The CLI's colours come from the design system's terminal mapping (the
 * Workbench brand), at the terminal's colour depth and the chosen mode.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { brandTheme, sgr } from '../src/vendor/calliope-ui/tokens.terminal.js';
import { colorDepth, setColorDepth, themeOverride } from '../src/hud/terminal-theme.js';
import { brandPalette, PALETTES } from '../src/hud/palettes.js';
import { applyPalette, clearHUDCache, getInkColor } from '../src/hud/api.js';
import { getCurrentThemeName } from '../src/themes.js';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  setColorDepth('16');
  clearHUDCache();
});

describe('colour depth', () => {
  it('turns colour off for NO_COLOR', () => {
    process.env.NO_COLOR = '1';
    delete process.env.FORCE_COLOR;
    setColorDepth(undefined);
    expect(colorDepth()).toBe('none');
  });

  it('follows FORCE_COLOR when the output is piped', () => {
    process.env.FORCE_COLOR = '3';
    setColorDepth(undefined);
    expect(colorDepth()).toBe('truecolor');
  });
});

describe('theme override', () => {
  it('reads CALLIOPE_THEME', () => {
    expect(themeOverride({ CALLIOPE_THEME: 'light' })).toBe('light');
    expect(themeOverride({ CALLIOPE_THEME: ' Dark ' })).toBe('dark');
    expect(themeOverride({ CALLIOPE_THEME: 'no-color' })).toBe('no-color');
    expect(themeOverride({ CALLIOPE_THEME: 'solarized' })).toBeUndefined();
    expect(themeOverride({})).toBeUndefined();
  });

  it('wins over the stored theme, which defaults to dark', () => {
    expect(getCurrentThemeName()).toBe('dark');
    process.env.CALLIOPE_THEME = 'light';
    expect(getCurrentThemeName()).toBe('light');
  });
});

describe('brand palettes', () => {
  it.each(['dark', 'light'] as const)('paint the Workbench %s theme at every depth', (mode) => {
    const theme = brandTheme('workbench', mode);
    for (const depth of ['truecolor', '256', '16'] as const) {
      const palette = brandPalette(mode, depth);
      expect(palette.hex?.primary).toBe(theme.roles.primary);
      expect(palette.colors.primary).toBe(sgr(theme.roles.primary, depth));
      expect(palette.colors.error).toBe(sgr(theme.roles.danger, depth));
      expect(palette.colors.border).toBe(sgr(theme.roles.border, depth));
      expect(palette.colors.selection).toBe(sgr(theme.selection, depth, 'bg'));
      // Text stays the terminal's own foreground.
      expect(palette.colors.text).toBe('');
    }
  });

  it('paint nothing when the terminal takes no colour', () => {
    for (const mode of ['dark', 'light'] as const) {
      expect(Object.values(brandPalette(mode, 'none').colors).every((c) => c === '')).toBe(true);
    }
    setColorDepth('none');
    expect(Object.values(PALETTES.monochrome!.colors).every((c) => c === '')).toBe(true);
    expect(getInkColor('primary')).toBeUndefined();
  });

  it('give Ink the colour at the terminal depth', () => {
    const primary = brandTheme('workbench', 'dark').roles.primary;
    applyPalette('default');
    setColorDepth('truecolor');
    expect(getInkColor('primary')).toBe(primary);
    setColorDepth('256');
    expect(getInkColor('primary')).toMatch(/^ansi256\(\d+\)$/);
    setColorDepth('16');
    expect(getInkColor('primary')).toBe('blueBright');
    expect(getInkColor('text')).toBeUndefined();
  });
});
