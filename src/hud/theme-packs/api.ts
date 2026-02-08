/**
 * Theme Pack API
 *
 * Functions to apply, list, and manage theme packs.
 * Also populates legacy SKINS/PALETTES/COMPANIONS registries.
 */

import type { ThemePack, ThemeCategory } from './types.js';
import { THEME_PACKS } from './index.js';
import { SKINS } from '../skins.js';
import { PALETTES } from '../palettes.js';
import { applySkin, applyPalette, getCurrentSkin } from '../api.js';
import { COMPANIONS, applyCompanion } from '../../companions.js';

// ============================================================================
// State
// ============================================================================

let currentPack: ThemePack | null = null;
let currentMode: 'professional' | 'immersive' = 'immersive';

// ============================================================================
// Theme Pack Management
// ============================================================================

/**
 * Apply a complete theme pack — sets skin, palette, and companion in one call.
 */
export function applyThemePack(
  name: string,
  mode: 'professional' | 'immersive' = 'immersive',
): boolean {
  const pack = THEME_PACKS[name];
  if (!pack) return false;

  applySkin(pack.skin.name);
  applyPalette(pack.palette.name);

  const companion = mode === 'professional'
    ? pack.companions.professional
    : pack.companions.immersive;
  applyCompanion(companion.name);

  currentPack = pack;
  currentMode = mode;
  return true;
}

/**
 * Switch between professional and immersive mode for the active pack.
 */
export function setCompanionMode(mode: 'professional' | 'immersive'): boolean {
  if (!currentPack) {
    // Try to find a pack matching the current skin
    const skin = getCurrentSkin();
    const pack = Object.values(THEME_PACKS).find(p => p.skin.name === skin.name);
    if (!pack) return false;
    currentPack = pack;
  }

  const companion = mode === 'professional'
    ? currentPack.companions.professional
    : currentPack.companions.immersive;
  applyCompanion(companion.name);
  currentMode = mode;
  return true;
}

/**
 * Get the currently active theme pack, if any.
 */
export function getCurrentPack(): ThemePack | null {
  return currentPack;
}

/**
 * Get the current companion mode.
 */
export function getCompanionMode(): 'professional' | 'immersive' {
  return currentMode;
}

/**
 * Get a theme pack by name.
 */
export function getThemePack(name: string): ThemePack | undefined {
  return THEME_PACKS[name];
}

/**
 * List all theme packs, optionally filtered by category.
 */
export function listThemePacks(
  category?: ThemeCategory,
): Array<{ name: string; description: string; category: ThemeCategory }> {
  const packs = Object.values(THEME_PACKS);
  const filtered = category ? packs.filter(p => p.category === category) : packs;
  return filtered.map(p => ({
    name: p.name,
    description: p.description,
    category: p.category,
  }));
}

/**
 * Get all companions for a given theme pack.
 */
export function getPackCompanions(packName: string): string[] {
  const pack = THEME_PACKS[packName];
  if (!pack) return [];
  const names = [pack.companions.professional.name, pack.companions.immersive.name];
  if (pack.companions.additional) {
    names.push(...pack.companions.additional.map(c => c.name));
  }
  return names;
}

// ============================================================================
// Legacy Registry Population
// ============================================================================

let populated = false;

/**
 * Populate SKINS, PALETTES, and COMPANIONS from all registered theme packs.
 * Called once at startup to ensure backward compatibility.
 */
export function populateLegacyRegistries(): void {
  if (populated) return;
  populated = true;

  for (const pack of Object.values(THEME_PACKS)) {
    // Register skin
    if (!SKINS[pack.skin.name]) {
      SKINS[pack.skin.name] = pack.skin;
    }

    // Register palette
    if (!PALETTES[pack.palette.name]) {
      PALETTES[pack.palette.name] = pack.palette;
    }

    // Register all companions
    if (!COMPANIONS[pack.companions.professional.name]) {
      COMPANIONS[pack.companions.professional.name] = pack.companions.professional;
    }
    if (!COMPANIONS[pack.companions.immersive.name]) {
      COMPANIONS[pack.companions.immersive.name] = pack.companions.immersive;
    }
    if (pack.companions.additional) {
      for (const comp of pack.companions.additional) {
        if (!COMPANIONS[comp.name]) {
          COMPANIONS[comp.name] = comp;
        }
      }
    }
  }
}
