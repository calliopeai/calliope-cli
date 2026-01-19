/**
 * Calliope CLI
 *
 * Multi-model AI agent CLI with Ralph Wiggum autonomous loops.
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

