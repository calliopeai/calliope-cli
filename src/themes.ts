/**
 * Calliope CLI - Theme System
 *
 * Color themes for terminal output.
 * Now wired through the HUD Palette layer for the new skin/palette system.
 * Maintains full backward compatibility — existing theme names map to palette names.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { colors as ANSI } from './styles.js';
import {
  getCurrentPalette,
  applyPalette,
  clearHUDCache,
  getInkColor as hudGetInkColor,
} from './hud/api.js';
import type { SemanticColorKey, Palette } from './hud/types.js';
import { PALETTES } from './hud/palettes.js';

// ============================================================================
// Types (kept for backward compat)
// ============================================================================

export interface Theme {
  name: string;
  description?: string;
  colors: {
    // Primary UI
    primary: string;
    secondary: string;
    accent: string;

    // Text
    text: string;
    textDim: string;
    textBold: string;

    // Messages
    user: string;
    assistant: string;
    system: string;
    error: string;

    // Code
    codeKeyword: string;
    codeString: string;
    codeNumber: string;
    codeComment: string;
    codeFunction: string;

    // Diff
    diffAdd: string;
    diffRemove: string;
    diffContext: string;

    // Status
    success: string;
    warning: string;
    info: string;

    // UI elements
    border: string;
    background: string;
    selection: string;
  };
}

// ============================================================================
// Built-in Themes (backward compat — map to palettes)
// ============================================================================

function paletteToTheme(p: Palette): Theme {
  return {
    name: p.name,
    description: p.description,
    colors: { ...p.colors },
  };
}

const THEME_TO_PALETTE: Record<string, string> = {
  dark: 'default',
  light: 'light',
  'no-color': 'monochrome',
};

export const THEMES: Record<string, Theme> = {
  dark: paletteToTheme(PALETTES.default!),
  light: paletteToTheme(PALETTES.light!),
  'no-color': paletteToTheme(PALETTES.monochrome!),
};

// ============================================================================
// Theme Management
// ============================================================================

const THEMES_DIR = path.join(os.homedir(), '.calliope-cli', 'themes');
const THEME_FILE = path.join(THEMES_DIR, 'current.txt');

function ensureThemesDir(): void {
  if (!fs.existsSync(THEMES_DIR)) {
    fs.mkdirSync(THEMES_DIR, { recursive: true });
  }
}

/**
 * Get current theme name
 */
export function getCurrentThemeName(): string {
  ensureThemesDir();
  if (fs.existsSync(THEME_FILE)) {
    const name = fs.readFileSync(THEME_FILE, 'utf-8').trim();
    if (THEMES[name]) return name;
    // Legacy stored values (old theme or palette names) map to the nearest survivor
    if (name === 'light') return 'light';
    if (name === 'minimal' || name === 'monochrome') return 'no-color';
    return 'dark';
  }
  return 'dark';
}

/**
 * Set current theme (also applies the corresponding palette)
 */
export function setCurrentTheme(name: string): boolean {
  const paletteName = THEME_TO_PALETTE[name];
  if (!paletteName) return false;
  applyPalette(paletteName);
  ensureThemesDir();
  fs.writeFileSync(THEME_FILE, name);
  clearThemeCache();
  return true;
}

/**
 * Apply the palette for the currently persisted theme without rewriting it.
 * Called at startup to initialize HUD colors from the stored theme.
 */
export function applyCurrentTheme(): void {
  const paletteName = THEME_TO_PALETTE[getCurrentThemeName()] || 'default';
  applyPalette(paletteName);
}

/**
 * Get current theme
 */
export function getCurrentTheme(): Theme {
  const name = getCurrentThemeName();
  const theme = THEMES[name] ?? THEMES.dark!;
  // Carry the canonical theme name (palette snapshots use palette names)
  return { ...theme, name };
}

/**
 * List available themes (combines legacy themes + palettes)
 */
export function listThemes(): Array<{ name: string; description?: string; custom: boolean }> {
  return [
    { name: 'dark', description: 'Default dark theme', custom: false },
    { name: 'light', description: 'Light terminal backgrounds', custom: false },
    { name: 'no-color', description: 'Monochrome, no color output', custom: false },
  ];
}

// ============================================================================
// Color Helpers
// ============================================================================

let currentTheme: Theme | null = null;

/**
 * Get cached theme (for performance)
 */
export function getTheme(): Theme {
  if (!currentTheme) {
    currentTheme = getCurrentTheme();
  }
  return currentTheme;
}

/**
 * Clear theme cache (call after changing theme)
 */
export function clearThemeCache(): void {
  currentTheme = null;
  clearHUDCache();
}

/**
 * Apply color to text using semantic color key
 */
export function colorize(text: string, colorKey: keyof Theme['colors']): string {
  const theme = getTheme();
  const color = theme.colors[colorKey];
  return `${color}${text}${ANSI.reset}`;
}

/**
 * Create a color function for a specific color
 */
export function createColorFn(colorKey: keyof Theme['colors']): (text: string) => string {
  return (text: string) => colorize(text, colorKey);
}

// ============================================================================
// New HUD-aware helpers
// ============================================================================

/**
 * Get ANSI color code for a semantic color key from the current palette
 */
export function getThemeColor(key: SemanticColorKey): string {
  const palette = getCurrentPalette();
  return palette.colors[key] || '';
}

/**
 * Get Ink-compatible color name for a semantic color key
 */
export function getInkColor(key: SemanticColorKey): string {
  return hudGetInkColor(key);
}

/**
 * Hook-style helper for Ink components: returns all semantic colors as Ink-compatible names
 */
export function useThemeColors(): Record<SemanticColorKey, string> {
  const palette = getCurrentPalette();
  const result = {} as Record<SemanticColorKey, string>;
  for (const key of Object.keys(palette.colors) as SemanticColorKey[]) {
    result[key] = hudGetInkColor(key);
  }
  return result;
}

// Export ANSI codes for direct use
export { ANSI };
