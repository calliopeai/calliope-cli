/**
 * Calliope CLI Configuration
 *
 * Manages user preferences and API keys using the conf package.
 * Config is stored in ~/.config/calliope/config.json (or platform equivalent)
 */

import Conf from 'conf';

// Re-export types from canonical source
export type { LLMProvider } from './types.js';
import type { LLMProvider } from './types.js';

export interface Profile {
  provider: LLMProvider;
  model?: string;
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
  bedrockApiKey?: string;   // AWS Bedrock API key (for gateway/proxy auth)
  bedrockBaseUrl?: string;  // AWS Bedrock gateway/proxy URL
  awsRegion?: string;       // AWS region for Bedrock (default: us-east-1)
  awsProfile?: string;      // AWS named profile
  openaiCompatBaseUrl?: string;  // Generic OpenAI-compatible server base URL
  openaiCompatApiKey?: string;   // Generic OpenAI-compatible server API key
  openaiCompatModel?: string;    // Override model for OpenAI-compatible server

  // Agent settings
  maxIterations: number;
  maxIterationTime: number;   // Max seconds per iteration (0 = no limit, default: 600)
  fancyOutput: boolean;

  // Session settings
  autoSaveHistory: boolean;
  workspaceRoot?: string;

  // Update settings
  autoUpgrade: boolean;  // Prompt to upgrade on startup if update available

  // Display settings
  collapseTools: boolean;      // Auto-collapse tool output
  collapseThinking: boolean;   // Auto-collapse think blocks
  toolDisplayLimit: number;    // Show last N tools expanded, rest collapsed (0 = all expanded)
  layout: 'classic' | 'response-top' | 'response-bottom' | 'split' | 'zen' | 'focus' | 'dashboard' | 'minimal';  // UI layout preference
  density: 'normal' | 'compact';  // Display density (compact = less whitespace)

  // HUD settings
  useEmojis: boolean;           // Enable/disable emoji in UI decorations (default: true)
  diffStyle: 'inline' | 'unified' | 'side-by-side';  // Diff display style
  borderStyle: 'rounded' | 'sharp' | 'double' | 'ascii' | 'none';  // Border style override
  bannerStyle: 'full' | 'compact' | 'none';  // Banner display style

  // Circuit Breakers
  circuitBreakersEnabled: boolean;

  // Sandbox
  sandboxMode: 'auto' | 'native' | 'docker' | 'off';

  // Smart Routing
  smartRoutingEnabled: boolean;
  smartRoutingCostSensitivity: number;  // 0-1: 0 = best quality, 1 = cheapest

  // Session Lifecycle
  sessionTimeoutMs?: number;  // Idle timeout in ms (0 or undefined = disabled)
  sessionLogLimit: number;    // Cap retained ledger entries/runs/failures per session (0 = unlimited)

  // API Server

  // Profiles
  profiles?: Record<string, Profile>;
  activeProfile?: string;
}

const DEFAULT_CONFIG: CalliopeConfig = {
  setupComplete: false,
  defaultProvider: 'auto',
  maxIterations: 0,  // 0 = unlimited (circuit breakers provide safety)
  maxIterationTime: 600,  // 10 minutes per iteration (seconds, 0 = no limit)
  fancyOutput: true,
  autoSaveHistory: true,
  autoUpgrade: true,
  collapseTools: false,
  collapseThinking: false,
  toolDisplayLimit: 0,  // 0 = show all expanded
  layout: 'response-bottom',  // Default: tools scroll up, response at bottom
  density: 'normal',  // normal or compact
  useEmojis: true,
  diffStyle: 'inline',
  borderStyle: 'rounded',
  bannerStyle: 'full',
  circuitBreakersEnabled: false,
  sandboxMode: 'auto',
  smartRoutingEnabled: false,
  smartRoutingCostSensitivity: 0.3,
  sessionLogLimit: 0,  // Unlimited by default; set > 0 to cap retained session log items
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
    bedrockApiKey: { type: 'string' },
    bedrockBaseUrl: { type: 'string' },
    awsRegion: { type: 'string' },
    awsProfile: { type: 'string' },
    openaiCompatBaseUrl: { type: 'string' },
    openaiCompatApiKey: { type: 'string' },
    openaiCompatModel: { type: 'string' },
    maxIterations: { type: 'number', minimum: 0, maximum: 1000000 },
    maxIterationTime: { type: 'number', minimum: 0, maximum: 3600 },
    fancyOutput: { type: 'boolean' },
    autoSaveHistory: { type: 'boolean' },
    workspaceRoot: { type: 'string' },
    autoUpgrade: { type: 'boolean' },
    collapseTools: { type: 'boolean' },
    collapseThinking: { type: 'boolean' },
    toolDisplayLimit: { type: 'number', minimum: 0, maximum: 100 },
    layout: { type: 'string', enum: ['classic', 'response-top', 'response-bottom', 'split', 'zen', 'focus', 'dashboard', 'minimal'] },
    density: { type: 'string', enum: ['normal', 'compact'] },
    diffStyle: { type: 'string', enum: ['inline', 'unified', 'side-by-side'] },
    borderStyle: { type: 'string', enum: ['rounded', 'sharp', 'double', 'ascii', 'none'] },
    bannerStyle: { type: 'string', enum: ['full', 'compact', 'none'] },
    useEmojis: { type: 'boolean' },
    circuitBreakersEnabled: { type: 'boolean' },
    sandboxMode: { type: 'string', enum: ['auto', 'native', 'docker', 'off'] },
    smartRoutingEnabled: { type: 'boolean' },
    smartRoutingCostSensitivity: { type: 'number', minimum: 0, maximum: 1 },
    sessionTimeoutMs: { type: 'number', minimum: 0 },
    sessionLogLimit: { type: 'number', minimum: 0, maximum: 100000 },
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
    if (value < 0 || value > 1000000) {
      throw new Error('maxIterations must be between 0 and 1000000 (0 = unlimited)');
    }
  }
  if (key === 'sessionLogLimit' && typeof value === 'number') {
    if (value < 0 || value > 100000) {
      throw new Error('sessionLogLimit must be between 0 and 100000 (0 = unlimited)');
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
    if (value < 0 || value > 1000000) {
      throw new Error('maxIterations must be between 0 and 1000000 (0 = unlimited)');
    }
  }
  if (key === 'sessionLogLimit' && typeof value === 'number') {
    if (value < 0 || value > 100000) {
      throw new Error('sessionLogLimit must be between 0 and 100000 (0 = unlimited)');
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

  if (config.get('anthropicApiKey') || process.env.ANTHROPIC_API_KEY) providers.push('anthropic');
  if (config.get('googleApiKey') || process.env.GOOGLE_API_KEY) providers.push('google');
  if (config.get('openaiApiKey') || process.env.OPENAI_API_KEY) providers.push('openai');
  if (config.get('togetherApiKey') || process.env.TOGETHER_API_KEY) providers.push('together');
  if (config.get('openrouterApiKey') || process.env.OPENROUTER_API_KEY) providers.push('openrouter');
  if (config.get('groqApiKey') || process.env.GROQ_API_KEY) providers.push('groq');
  if (config.get('fireworksApiKey') || process.env.FIREWORKS_API_KEY) providers.push('fireworks');
  if (config.get('mistralApiKey') || process.env.MISTRAL_API_KEY) providers.push('mistral');
  if (config.get('ollamaBaseUrl') || process.env.OLLAMA_BASE_URL) providers.push('ollama');
  if (config.get('ai21ApiKey') || process.env.AI21_API_KEY) providers.push('ai21');
  if (config.get('huggingfaceApiKey') || process.env.HUGGINGFACE_API_KEY) providers.push('huggingface');
  if (config.get('litellmBaseUrl') || process.env.LITELLM_BASE_URL) providers.push('litellm');
  if (config.get('bedrockApiKey') || process.env.BEDROCK_API_KEY || config.get('bedrockBaseUrl') || process.env.BEDROCK_BASE_URL || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) providers.push('bedrock');
  if (config.get('openaiCompatBaseUrl') || process.env.OPENAI_COMPAT_BASE_URL) providers.push('openai-compat');

  return providers;
}

/**
 * Get API key for a provider
 */
export function getApiKey(provider: LLMProvider): string | undefined {
  // Special handling for openai-compat: check env/config, default to 'openai-compat'
  if (provider === 'openai-compat') {
    return process.env.OPENAI_COMPAT_API_KEY || config.get('openaiCompatApiKey') || 'openai-compat';
  }

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
    bedrock: 'bedrockApiKey',
    'openai-compat': undefined,  // handled above
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
    bedrockApiKey: 'BEDROCK_API_KEY',
    bedrockBaseUrl: 'BEDROCK_BASE_URL',
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
  if (provider === 'bedrock') {
    return process.env.BEDROCK_BASE_URL || config.get('bedrockBaseUrl') || undefined;
  }
  if (provider === 'openai-compat') {
    return config.get('openaiCompatBaseUrl') || process.env.OPENAI_COMPAT_BASE_URL;
  }
  return undefined;
}

// Built-in profiles
const BUILTIN_PROFILES: Record<string, Profile> = {
  fast: {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    confirmMode: false,
  },
  smart: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    confirmMode: true,
  },
  cheap: {
    provider: 'google',
    model: 'gemini-2.0-flash',
    confirmMode: true,
  },
  local: {
    provider: 'ollama',
    model: 'llama3.3',
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
