/**
 * Calliope CLI Configuration
 *
 * Manages user preferences and API keys using the conf package.
 * Config is stored in ~/.config/calliope/config.json (or platform equivalent)
 */

import Conf from 'conf';

export type LLMProvider = 'anthropic' | 'google' | 'openai' | 'together' | 'openrouter' | 'groq' | 'fireworks' | 'mistral' | 'ollama' | 'ai21' | 'huggingface' | 'litellm' | 'auto';
export type AgentPersona = 'calliope' | 'professional' | 'minimal';

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
}

const DEFAULT_CONFIG: CalliopeConfig = {
  setupComplete: false,
  defaultProvider: 'auto',
  persona: 'calliope',
  maxIterations: 20,
  fancyOutput: true,
  autoSaveHistory: true,
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
    maxIterations: { type: 'number', minimum: 1, maximum: 100 },
    fancyOutput: { type: 'boolean' },
    autoSaveHistory: { type: 'boolean' },
    workspaceRoot: { type: 'string' },
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
 * Set a config value
 */
export function set<K extends keyof CalliopeConfig>(key: K, value: CalliopeConfig[K]): void {
  config.set(key, value);
}

/**
 * Set multiple config values
 */
export function setMultiple(values: Partial<CalliopeConfig>): void {
  for (const [key, value] of Object.entries(values)) {
    config.set(key as keyof CalliopeConfig, value);
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

export default config;
