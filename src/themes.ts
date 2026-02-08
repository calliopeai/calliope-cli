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
  getPalette,
  applyPalette,
  listPalettes,
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

export const THEMES: Record<string, Theme> = {
  default: paletteToTheme(PALETTES.default),
  light: paletteToTheme(PALETTES.light),
  monokai: paletteToTheme(PALETTES.monokai),
  nord: paletteToTheme(PALETTES.nord),
  minimal: paletteToTheme(PALETTES.monochrome),
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
    if (THEMES[name] || PALETTES[name] || fs.existsSync(path.join(THEMES_DIR, `${name}.json`))) {
      return name;
    }
  }
  return 'default';
}

/**
 * Set current theme (also applies the corresponding palette)
 */
export function setCurrentTheme(name: string): boolean {
  // Accept palette names as theme names
  if (PALETTES[name]) {
    applyPalette(name);
    ensureThemesDir();
    fs.writeFileSync(THEME_FILE, name);
    clearThemeCache();
    return true;
  }
  // Also accept legacy theme names
  const legacyMap: Record<string, string> = { minimal: 'monochrome' };
  const paletteName = legacyMap[name] || name;
  if (PALETTES[paletteName]) {
    applyPalette(paletteName);
    ensureThemesDir();
    fs.writeFileSync(THEME_FILE, name);
    clearThemeCache();
    return true;
  }
  if (!THEMES[name] && !fs.existsSync(path.join(THEMES_DIR, `${name}.json`))) {
    return false;
  }
  ensureThemesDir();
  fs.writeFileSync(THEME_FILE, name);
  clearThemeCache();
  return true;
}

/**
 * Get current theme
 */
export function getCurrentTheme(): Theme {
  const name = getCurrentThemeName();

  // Try palette system first
  const palette = getPalette(name);
  if (palette.name === name) {
    return paletteToTheme(palette);
  }

  // Legacy theme name mapping
  const legacyMap: Record<string, string> = { minimal: 'monochrome' };
  const mappedName = legacyMap[name];
  if (mappedName) {
    const p = getPalette(mappedName);
    return paletteToTheme(p);
  }

  // Check built-in themes
  if (THEMES[name]) {
    return THEMES[name];
  }

  // Check custom themes
  const customPath = path.join(THEMES_DIR, `${name}.json`);
  if (fs.existsSync(customPath)) {
    try {
      return JSON.parse(fs.readFileSync(customPath, 'utf-8'));
    } catch {
      // Fall back to default
    }
  }

  return THEMES.default;
}

/**
 * List available themes (combines legacy themes + palettes)
 */
export function listThemes(): Array<{ name: string; description?: string; custom: boolean }> {
  const themes: Array<{ name: string; description?: string; custom: boolean }> = [];

  // Add all palettes as themes
  for (const p of listPalettes()) {
    themes.push({ name: p.name, description: p.description, custom: p.custom });
  }

  // Custom themes from disk
  ensureThemesDir();
  try {
    const files = fs.readdirSync(THEMES_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const name = file.slice(0, -5);
        if (!themes.find(t => t.name === name)) {
          try {
            const theme = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, file), 'utf-8'));
            themes.push({ name, description: theme.description, custom: true });
          } catch {
            // Skip invalid files
          }
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return themes;
}

/**
 * Save a custom theme
 */
export function saveCustomTheme(theme: Theme): void {
  ensureThemesDir();
  fs.writeFileSync(
    path.join(THEMES_DIR, `${theme.name}.json`),
    JSON.stringify(theme, null, 2)
  );
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
