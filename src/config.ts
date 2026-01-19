/**
 * Calliope CLI Configuration
 *
 * Manages user preferences and API keys using the conf package.
 * Config is stored in ~/.config/calliope/config.json (or platform equivalent)
 */

import Conf from 'conf';

// Re-export types from canonical source
export type { LLMProvider, AgentPersona } from './types.js';
import type { LLMProvider, AgentPersona } from './types.js';

export interface Profile {
  provider: LLMProvider;
  model?: string;
  persona: AgentPersona;
  confirmMode?: boolean;
}

export interface CalliopeConfig {
  // Setup state
  setupComplete: boolean;

  // Provider settings
  defaultProvider: LLMProvider;
  defaultModel?: string;

  // API Keys (stored securely via conf)
  anthropicApiKey?: string;
  googleApiKey?: string;
  openaiApiKey?: string;
  togetherApiKey?: string;
  openrouterApiKey?: string;
  groqApiKey?: string;
  fireworksApiKey?: string;
  mistralApiKey?: string;
  ollamaBaseUrl?: string;  // Ollama uses base URL, not API key
  ai21ApiKey?: string;
  huggingfaceApiKey?: string;
  litellmBaseUrl?: string;  // LiteLLM proxy URL
  litellmApiKey?: string;

  // Agent settings
  persona: AgentPersona;
  maxIterations: number;
  fancyOutput: boolean;

  // Session settings
  autoSaveHistory: boolean;
  workspaceRoot?: string;

  // Update settings
  autoUpgrade: boolean;  // Prompt to upgrade on startup if update available

  // Profiles
  profiles?: Record<string, Profile>;
  activeProfile?: string;
}

const DEFAULT_CONFIG: CalliopeConfig = {
  setupComplete: false,
  defaultProvider: 'auto',
  persona: 'calliope',
  maxIterations: 500,
  fancyOutput: true,
  autoSaveHistory: true,
  autoUpgrade: true,
};

// Create config store
const config = new Conf<CalliopeConfig>({
  projectName: 'calliope',
  defaults: DEFAULT_CONFIG,
  schema: {
    setupComplete: { type: 'boolean' },
    defaultProvider: { type: 'string' },
    defaultModel: { type: 'string' },
    anthropicApiKey: { type: 'string' },
    googleApiKey: { type: 'string' },
    openaiApiKey: { type: 'string' },
    togetherApiKey: { type: 'string' },
    openrouterApiKey: { type: 'string' },
    groqApiKey: { type: 'string' },
    fireworksApiKey: { type: 'string' },
    mistralApiKey: { type: 'string' },
    ollamaBaseUrl: { type: 'string' },
    ai21ApiKey: { type: 'string' },
    huggingfaceApiKey: { type: 'string' },
    litellmBaseUrl: { type: 'string' },
    litellmApiKey: { type: 'string' },
    persona: { type: 'string', enum: ['calliope', 'professional', 'minimal'] },
    maxIterations: { type: 'number', minimum: 1, maximum: 10000 },
    fancyOutput: { type: 'boolean' },
    autoSaveHistory: { type: 'boolean' },
    workspaceRoot: { type: 'string' },
    autoUpgrade: { type: 'boolean' },
  },
});

/**
 * Get the full config object
 */
export function getConfig(): CalliopeConfig {
  return config.store;
}

/**
 * Get a specific config value
 */
export function get<K extends keyof CalliopeConfig>(key: K): CalliopeConfig[K] {
  return config.get(key);
}

/**
 * Set a config value with validation
 */
export function set<K extends keyof CalliopeConfig>(key: K, value: CalliopeConfig[K]): void {
  // Validate API keys are non-empty strings when set
  if (key.toString().endsWith('ApiKey') && value !== undefined) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`API key for ${key} must be a non-empty string`);
    }
  }

  // Validate URLs are proper format
  if (key.toString().endsWith('BaseUrl') && value !== undefined) {
    if (typeof value !== 'string') {
      throw new Error(`Base URL for ${key} must be a string`);
    }
    try {
      new URL(value);
    } catch {
      throw new Error(`Base URL for ${key} must be a valid URL`);
    }
  }

  // Validate numeric bounds
  if (key === 'maxIterations' && typeof value === 'number') {
    if (value < 1 || value > 1000) {
      throw new Error('maxIterations must be between 1 and 1000');
    }
  }

  config.set(key, value);
}

/**
 * Set multiple config values with validation
 */
export function setMultiple(values: Partial<CalliopeConfig>): void {
  // Validate all values first before setting any
  for (const [key, value] of Object.entries(values)) {
    const typedKey = key as keyof CalliopeConfig;
    // Will throw if validation fails
    validateConfigValue(typedKey, value);
  }
  // All validations passed, now set values
  for (const [key, value] of Object.entries(values)) {
    config.set(key as keyof CalliopeConfig, value);
  }
}

/**
 * Validate a single config value without setting it
 */
function validateConfigValue(key: keyof CalliopeConfig, value: unknown): void {
  if (key.toString().endsWith('ApiKey') && value !== undefined) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`API key for ${key} must be a non-empty string`);
    }
  }
  if (key.toString().endsWith('BaseUrl') && value !== undefined && value !== null) {
    if (typeof value !== 'string') {
      throw new Error(`Base URL for ${key} must be a string`);
    }
    try {
      new URL(value);
    } catch {
      throw new Error(`Base URL for ${key} must be a valid URL`);
    }
  }
  if (key === 'maxIterations' && typeof value === 'number') {
    if (value < 1 || value > 1000) {
      throw new Error('maxIterations must be between 1 and 1000');
    }
  }
}

/**
 * Check if setup is complete
 */
export function isSetupComplete(): boolean {
  return config.get('setupComplete') === true;
}

/**
 * Mark setup as complete
 */
export function markSetupComplete(): void {
  config.set('setupComplete', true);
}

/**
 * Get config file path (for display to user)
 */
export function getConfigPath(): string {
  return config.path;
}

/**
 * Reset config to defaults
 */
export function resetConfig(): void {
  config.clear();
}

/**
 * Check which providers have API keys configured
 */
export function getConfiguredProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];

  if (config.get('anthropicApiKey')) providers.push('anthropic');
  if (config.get('googleApiKey')) providers.push('google');
  if (config.get('openaiApiKey')) providers.push('openai');
  if (config.get('togetherApiKey')) providers.push('together');
  if (config.get('openrouterApiKey')) providers.push('openrouter');
  if (config.get('groqApiKey')) providers.push('groq');
  if (config.get('fireworksApiKey')) providers.push('fireworks');
  if (config.get('mistralApiKey')) providers.push('mistral');
  if (config.get('ollamaBaseUrl')) providers.push('ollama');
  if (config.get('ai21ApiKey')) providers.push('ai21');
  if (config.get('huggingfaceApiKey')) providers.push('huggingface');
  if (config.get('litellmBaseUrl')) providers.push('litellm');

  return providers;
}

/**
 * Get API key for a provider
 */
export function getApiKey(provider: LLMProvider): string | undefined {
  const keyMap: Record<LLMProvider, keyof CalliopeConfig | undefined> = {
    anthropic: 'anthropicApiKey',
    google: 'googleApiKey',
    openai: 'openaiApiKey',
    together: 'togetherApiKey',
    openrouter: 'openrouterApiKey',
    groq: 'groqApiKey',
    fireworks: 'fireworksApiKey',
    mistral: 'mistralApiKey',
    ollama: 'ollamaBaseUrl',  // Returns base URL for Ollama
    ai21: 'ai21ApiKey',
    huggingface: 'huggingfaceApiKey',
    litellm: 'litellmApiKey',
    auto: undefined,
  };

  const key = keyMap[provider];
  if (!key) return undefined;

  // Check environment variable first, then config
  const envMap: Record<string, string> = {
    anthropicApiKey: 'ANTHROPIC_API_KEY',
    googleApiKey: 'GOOGLE_API_KEY',
    openaiApiKey: 'OPENAI_API_KEY',
    togetherApiKey: 'TOGETHER_API_KEY',
    openrouterApiKey: 'OPENROUTER_API_KEY',
    groqApiKey: 'GROQ_API_KEY',
    fireworksApiKey: 'FIREWORKS_API_KEY',
    mistralApiKey: 'MISTRAL_API_KEY',
    ollamaBaseUrl: 'OLLAMA_BASE_URL',
    ai21ApiKey: 'AI21_API_KEY',
    huggingfaceApiKey: 'HUGGINGFACE_API_KEY',
    litellmApiKey: 'LITELLM_API_KEY',
  };

  const envVar = envMap[key];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }

  return config.get(key) as string | undefined;
}

/**
 * Get base URL for a provider (for Ollama/LiteLLM)
 */
export function getBaseUrl(provider: LLMProvider): string | undefined {
  if (provider === 'ollama') {
    return process.env.OLLAMA_BASE_URL || config.get('ollamaBaseUrl') || 'http://localhost:11434';
  }
  if (provider === 'litellm') {
    return process.env.LITELLM_BASE_URL || config.get('litellmBaseUrl') || 'http://localhost:4000';
  }
  return undefined;
}

// Built-in profiles
const BUILTIN_PROFILES: Record<string, Profile> = {
  fast: {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    persona: 'minimal',
    confirmMode: false,
  },
  smart: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    persona: 'calliope',
    confirmMode: true,
  },
  cheap: {
    provider: 'google',
    model: 'gemini-2.0-flash',
    persona: 'professional',
    confirmMode: true,
  },
  local: {
    provider: 'ollama',
    model: 'llama3.3',
    persona: 'professional',
    confirmMode: true,
  },
};

/**
 * Get a profile by name (built-in or custom)
 */
export function getProfile(name: string): Profile | undefined {
  // Check built-in profiles first
  if (BUILTIN_PROFILES[name]) {
    return BUILTIN_PROFILES[name];
  }
  // Check custom profiles
  const profiles = config.get('profiles') || {};
  return profiles[name];
}

/**
 * Save a custom profile
 */
export function saveProfile(name: string, profile: Profile): void {
  const profiles = config.get('profiles') || {};
  profiles[name] = profile;
  config.set('profiles', profiles);
}

/**
 * Delete a custom profile
 */
export function deleteProfile(name: string): boolean {
  if (BUILTIN_PROFILES[name]) {
    return false; // Can't delete built-in profiles
  }
  const profiles = config.get('profiles') || {};
  if (profiles[name]) {
    delete profiles[name];
    config.set('profiles', profiles);
    return true;
  }
  return false;
}

/**
 * List all available profiles
 */
export function listProfiles(): { name: string; profile: Profile; builtin: boolean }[] {
  const result: { name: string; profile: Profile; builtin: boolean }[] = [];

  // Add built-in profiles
  for (const [name, profile] of Object.entries(BUILTIN_PROFILES)) {
    result.push({ name, profile, builtin: true });
  }

  // Add custom profiles
  const customProfiles = config.get('profiles') || {};
  for (const [name, profile] of Object.entries(customProfiles)) {
    result.push({ name, profile, builtin: false });
  }

  return result;
}

/**
 * Set the active profile
 */
export function setActiveProfile(name: string | undefined): void {
  config.set('activeProfile', name);
}

/**
 * Get the active profile name
 */
export function getActiveProfile(): string | undefined {
  return config.get('activeProfile');
}

export default config;
