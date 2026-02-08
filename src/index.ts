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
export * from './providers.js';
export * from './tools.js';
export * from './types.js';
export { startCLI } from './cli.js';
export { runSetup, reconfigure } from './setup.js';
export { getVersion, checkForUpdates, getLatestVersion, performUpgrade } from './version-check.js';
export { selectModelInteractively, getAvailableModels, clearModelCache, getModelInfo, getModelContextLimit, preWarmModelCache } from './model-detection.js';
export type { ModelInfo } from './model-detection.js';

// HUD system
export {
  getSkin, applySkin, getCurrentSkin, listSkins,
  getPalette, applyPalette, getCurrentPalette, listPalettes,
  applyHUD, discoverSkins, discoverPalettes,
  getBoxChars, getSpinnerFrames, getPaletteColor, paletteColorize,
  getInkColor, getInkBorderStyle,
  clearHUDCache,
} from './hud.js';
export type { Skin, Palette, PaletteColors, SemanticColorKey, BoxChars, HUDConfig } from './hud.js';

// Companions
export {
  getCompanion, applyCompanion, getCurrentCompanion, listCompanions,
  setMood, getMood, getMoodText,
  getToolLabel, getThinkingPhrase, getSuccessPhrase, getErrorPhrase, getStatusMessage,
} from './companions.js';
export type { PersonaCompanion, CompanionMoods, CompanionImmersion, MoodState } from './companions.js';

// Headless renderer
export { runHeadless } from './headless.js';
export type { HeadlessEvent, HeadlessOptions, HeadlessOutputMode } from './headless.js';

