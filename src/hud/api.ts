/**
 * HUD API
 *
 * Palette state management plus Ink/ANSI color helpers. The CLI ships a single
 * built-in skin and three palettes (default / light / monochrome) mapped from
 * the dark / light / no-color themes.
 */

import { colors as ANSI } from '../styles.js';
import type { Skin, Palette, BoxChars, SemanticColorKey } from './types.js';
import { SKINS, BOX_STYLES, SPINNER_SETS } from './skins.js';
import { PALETTES } from './palettes.js';
import { colorDepth, inkColor } from './terminal-theme.js';

// ============================================================================
// State
// ============================================================================

let currentPalette: Palette | null = null;

// ============================================================================
// Skin (single built-in skin)
// ============================================================================

export function getCurrentSkin(): Skin {
  return SKINS.clean!;
}

// ============================================================================
// Palette Management
// ============================================================================

export function getPalette(name?: string): Palette {
  if (!name) {
    return currentPalette || PALETTES.default!;
  }
  return PALETTES[name] || PALETTES.default!;
}

export function applyPalette(name: string): boolean {
  if (PALETTES[name]) {
    currentPalette = PALETTES[name];
    return true;
  }
  return false;
}

export function getCurrentPalette(): Palette {
  return currentPalette || PALETTES.default!;
}

// ============================================================================
// Helpers
// ============================================================================

export function getBoxChars(skin?: Skin): BoxChars {
  const s = skin || getCurrentSkin();
  if (s.borders.style === 'custom' && s.borders.custom) {
    return s.borders.custom;
  }
  return BOX_STYLES[s.borders.style] || BOX_STYLES.rounded!;
}

export function getSpinnerFrames(skin?: Skin): string[] {
  const s = skin || getCurrentSkin();
  if (s.decorations.spinner === 'custom' && s.decorations.customSpinner) {
    return s.decorations.customSpinner;
  }
  return SPINNER_SETS[s.decorations.spinner] || SPINNER_SETS.braille!;
}

export function getPaletteColor(key: SemanticColorKey): string {
  const palette = getCurrentPalette();
  return palette.colors[key] || '';
}

export function paletteColorize(text: string, key: SemanticColorKey): string {
  const color = getPaletteColor(key);
  return `${color}${text}${ANSI.reset}`;
}

/**
 * An Ink `color` prop for a key: the brand colour at the terminal's depth
 * ("#rrggbb", "ansi256(n)" or an ANSI name), or undefined (the terminal's own
 * colour) when the terminal takes none or the key has no colour.
 */
export function getInkColor(key: SemanticColorKey): string | undefined {
  const depth = colorDepth();
  if (depth === 'none') return undefined;
  const palette = getCurrentPalette();
  if (!palette.hex) return ansiToInkColor(getPaletteColor(key));
  const hex = palette.hex[key];
  if (!hex) return undefined;
  // Every render asks; the nearest-colour search runs once per colour and depth.
  const cacheKey = `${hex}/${depth}`;
  let color = inkColors.get(cacheKey);
  if (color === undefined) inkColors.set(cacheKey, (color = inkColor(hex, depth)!));
  return color;
}

const inkColors = new Map<string, string>();

const ANSI_TO_INK: Record<string, string> = {
  [ANSI.black]: 'black',
  [ANSI.red]: 'red',
  [ANSI.green]: 'green',
  [ANSI.yellow]: 'yellow',
  [ANSI.blue]: 'blue',
  [ANSI.magenta]: 'magenta',
  [ANSI.cyan]: 'cyan',
  [ANSI.white]: 'white',
  [ANSI.gray]: 'gray',
  [ANSI.brightRed]: 'redBright',
  [ANSI.brightGreen]: 'greenBright',
  [ANSI.brightYellow]: 'yellowBright',
  [ANSI.brightBlue]: 'blueBright',
  [ANSI.brightMagenta]: 'magentaBright',
  [ANSI.brightCyan]: 'cyanBright',
  [ANSI.brightWhite]: 'whiteBright',
};

function ansiToInkColor(ansiCode: string): string {
  const stripped = ansiCode.replace(/\x1b\[(1|2|3|4)m/g, '');
  return ANSI_TO_INK[stripped] || 'white';
}

export function getInkBorderStyle(skin?: Skin): string {
  const s = skin || getCurrentSkin();
  const map: Record<string, string> = {
    rounded: 'round',
    sharp: 'single',
    double: 'double',
    ascii: 'classic',
    none: 'single',
  };
  return map[s.borders.style] || 'round';
}

export function clearHUDCache(): void {
  currentPalette = null;
}
