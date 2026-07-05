/**
 * UI Module - Modals barrel
 *
 * Re-exports every modal component and the ProviderEntry type. Consumers import
 * from './modals/index.js'.
 */

export { ModelSelector, SessionSelector, ProviderSelector } from './selectors.js';
export type { ProviderEntry } from './selectors.js';
export { UpgradePrompt, ComplexityWarning, SessionResumePrompt, ToolConfirmation } from './prompts.js';
export { ApiKeySetup, KeybindingsModal } from './setup.js';
