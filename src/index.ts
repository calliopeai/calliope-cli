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
export { getVersion, checkForUpdates } from './version-check.js';
