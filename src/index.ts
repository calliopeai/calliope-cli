/**
 * Calliope CLI
 *
 * Multi-model AI agent CLI with autonomous agent loops.
 *
 * @packageDocumentation
 */

// Re-export from config (excluding types that are in types.ts)
export {
  getConfig,
  get,
  set,
  setMultiple,
  isSetupComplete,
  markSetupComplete,
  getConfigPath,
  resetConfig,
  getConfiguredProviders,
  getApiKey,
  getBaseUrl,
  CalliopeConfig,
} from './config.js';
export * from './providers/index.js';
export * from './tools.js';
export * from './types.js';
export { runSetup, reconfigure } from './setup.js';
export { getVersion, checkForUpdates, getLatestVersion, performUpgrade } from './version-check.js';
export { selectModelInteractively, getAvailableModels, clearModelCache, getModelInfo, getModelContextLimit, preWarmModelCache } from './model-detection.js';
export type { ModelInfo } from './model-detection.js';

// HUD system
export {
  getCurrentSkin,
  getPalette, applyPalette, getCurrentPalette,
  getBoxChars, getSpinnerFrames, getPaletteColor, paletteColorize,
  getInkColor, getInkBorderStyle,
  clearHUDCache,
} from './hud/api.js';
export type { Skin, Palette, PaletteColors, SemanticColorKey, BoxChars, HUDConfig } from './hud/types.js';

// Headless renderer
export { runHeadless } from './headless.js';
export type { HeadlessEvent, HeadlessOptions, HeadlessOutputMode } from './headless.js';

