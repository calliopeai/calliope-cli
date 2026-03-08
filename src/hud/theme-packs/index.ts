/**
 * Theme Packs - Registry
 *
 * Dynamically loads theme packs from @calliopelabs/cli-themes if installed.
 * Falls back to an empty registry if the package is not available.
 */

import type { ThemePack } from './types.js';

// ============================================================================
// Theme Pack Registry (populated at runtime from optional dependency)
// ============================================================================

export const THEME_PACKS: Record<string, ThemePack> = {};

let loaded = false;

/**
 * Load theme packs from @calliopelabs/cli-themes if available.
 * Safe to call multiple times — only loads once.
 */
export async function loadThemePacks(): Promise<boolean> {
  if (loaded) return Object.keys(THEME_PACKS).length > 0;
  loaded = true;

  try {
    const themes = await import('@calliopelabs/cli-themes');
    if (themes.THEME_PACKS) {
      Object.assign(THEME_PACKS, themes.THEME_PACKS);
    }
    return true;
  } catch {
    // @calliopelabs/cli-themes not installed — themes are optional
    return false;
  }
}

/**
 * Check whether the themes package is available without loading it.
 */
export function hasThemePacks(): boolean {
  return Object.keys(THEME_PACKS).length > 0;
}
