/**
 * Built-in Palettes
 *
 * Dark and light are the Calliope AI Workbench brand from the design system's
 * terminal token mapping (see terminal-theme.ts), rendered at the terminal's
 * colour depth; monochrome stays black and white. Every palette is empty when
 * the terminal takes no colour (NO_COLOR, a pipe).
 */

import { colors as ANSI } from '../styles.js';
import type { Palette, PaletteColors, SemanticColorKey } from './types.js';
import { brandTerminalTheme, colorDepth, sgr, type ColorDepth, type Mode } from './terminal-theme.js';

/**
 * Which brand colour each key takes. Text is the terminal's own foreground
 * (""), so it reads whatever the terminal's background; code and diff colours
 * come from the brand's ANSI set and roles.
 */
function brandHex(mode: Mode): PaletteColors {
  const t = brandTerminalTheme(mode);
  const r = t.roles;
  return {
    primary: r.primary,
    secondary: r.muted,
    accent: r.primary,
    text: '',
    textDim: r.muted,
    textBold: '',
    user: r.info,
    assistant: r.primary,
    system: r.warning,
    error: r.danger,
    codeKeyword: r.primary,
    codeString: t.ansi.green,
    codeNumber: t.ansi.yellow,
    codeComment: r.muted,
    codeFunction: t.ansi.brightCyan,
    diffAdd: r.success,
    diffRemove: r.danger,
    diffContext: r.muted,
    success: r.success,
    warning: r.warning,
    info: r.info,
    border: r.border,
    background: '',
    selection: t.selection,
  };
}

const cache = new Map<string, Palette>();

/** The brand palette for a mode at a colour depth. */
export function brandPalette(mode: Mode, depth: ColorDepth = colorDepth()): Palette {
  const key = `${mode}/${depth}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const hex = brandHex(mode);
  const colors = {} as PaletteColors;
  for (const name of Object.keys(hex) as SemanticColorKey[]) {
    const value = hex[name];
    colors[name] = value ? sgr(value, depth, name === 'selection' ? 'bg' : 'fg') : '';
  }
  if (depth !== 'none') colors.textBold = ANSI.bold;
  const palette: Palette = {
    name: mode === 'dark' ? 'default' : 'light',
    description: mode === 'dark' ? 'Calliope AI Workbench, dark terminals' : 'Calliope AI Workbench, light terminals',
    colors,
    hex,
  };
  cache.set(key, palette);
  return palette;
}

const MONOCHROME: Palette = {
  name: 'monochrome',
  description: 'Black & white only',
  colors: {
    primary: ANSI.white,
    secondary: ANSI.gray,
    accent: ANSI.white,
    text: ANSI.white,
    textDim: ANSI.gray,
    textBold: ANSI.bold + ANSI.white,
    user: ANSI.white,
    assistant: ANSI.white,
    system: ANSI.gray,
    error: ANSI.white,
    codeKeyword: ANSI.bold + ANSI.white,
    codeString: ANSI.white,
    codeNumber: ANSI.white,
    codeComment: ANSI.gray,
    codeFunction: ANSI.white,
    diffAdd: ANSI.white,
    diffRemove: ANSI.dim + ANSI.white,
    diffContext: ANSI.gray,
    success: ANSI.white,
    warning: ANSI.white,
    info: ANSI.gray,
    border: ANSI.gray,
    background: '',
    selection: ANSI.bgGray,
  },
};

/** Every key with no colour, for a terminal that takes none. */
function blank(palette: Palette): Palette {
  const colors = Object.fromEntries(Object.keys(palette.colors).map((k) => [k, ''])) as unknown as PaletteColors;
  return { ...palette, colors };
}

export const PALETTES: Record<string, Palette> = {
  get default() {
    return brandPalette('dark');
  },
  get light() {
    return brandPalette('light');
  },
  get monochrome() {
    return colorDepth() === 'none' ? blank(MONOCHROME) : MONOCHROME;
  },
};
