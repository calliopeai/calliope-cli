/**
 * HUD System - Barrel Export
 *
 * Re-exports everything from the HUD subsystem modules.
 */

// Types
export type {
  BoxChars, Skin, PaletteColors, SemanticColorKey, Palette, HUDConfig,
  SkinIcons, SkinSplash, SkinFrame, SkinAnimations,
} from './types.js';

// Data
export { SKINS, BOX_STYLES, SPINNER_SETS } from './skins.js';
export { PALETTES } from './palettes.js';

// API
export {
  getSkin, applySkin, getCurrentSkin, listSkins,
  getPalette, applyPalette, getCurrentPalette, listPalettes,
  applyHUD, discoverSkins, discoverPalettes,
  getBoxChars, getSpinnerFrames, getPaletteColor, paletteColorize,
  getInkColor, getInkBorderStyle,
  saveCustomSkin, saveCustomPalette,
  clearHUDCache,
} from './api.js';

// Theme Packs
export type { ThemePack, ThemeCategory } from './theme-packs/index.js';
export {
  THEME_PACKS,
  applyThemePack, setCompanionMode,
  getCurrentPack, getCompanionMode,
  getThemePack, listThemePacks,
  getPackCompanions, populateLegacyRegistries,
} from './theme-packs/index.js';
