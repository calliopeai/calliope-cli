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

/**
 * Provider credentials. One entry per provider in the nested `providers` map.
 * Not every field applies to every provider (e.g. `region`/`profile` are Bedrock,
 * `baseUrl` is Ollama/LiteLLM/Bedrock/openai-compat).
 */
export interface ProviderCred {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  region?: string;
  profile?: string;
}

export interface CalliopeConfig {
  // Setup state
  setupComplete: boolean;

  // Provider settings
  defaultProvider: LLMProvider;
  defaultModel?: string;

  // Provider credentials, keyed by provider name (e.g. 'anthropic', 'ollama',
  // 'bedrock', 'openai-compat'). Replaces the old flat *ApiKey / *BaseUrl keys.
  providers?: Partial<Record<string, ProviderCred>>;

  // Agent settings
  fleet?: { enabled: boolean };
  maxIterations: number;
  maxIterationTime: number;   // Max seconds per iteration (0 = no limit, default: 600)

  // Session settings
  autoSaveHistory: boolean;

  // Update settings
  autoUpgrade: boolean;  // Prompt to upgrade on startup if update available

  // Display settings
  collapseTools: boolean;      // Auto-collapse tool output
  toolDisplayLimit: number;    // Show last N tools expanded, rest collapsed (0 = all expanded)
  diffStyle: 'inline' | 'unified' | 'side-by-side';  // Diff display style

  // Circuit Breakers
  circuitBreakersEnabled: boolean;

  // Sandbox
  sandboxMode: 'auto' | 'native' | 'docker' | 'off';

  // Smart Routing
  routing?: { enabled: boolean; costSensitivity: number };  // costSensitivity 0-1 (0 = best quality, 1 = cheapest)

  // Session Lifecycle
  sessionLogLimit: number;    // Cap retained ledger entries/runs/failures per session (0 = unlimited)

  // Governance (#189) — audit trail, budget caps, policy hook.
  // Audit run logs are ON by default (local disk, cheap; the audit trail is the point).
  audit?: {
    enabled?: boolean;   // default true
    dir?: string;        // override for the run-log directory (default ~/.calliope-cli/runs)
    retention?: number;  // keep the most recent N run-log files (default 100)
  };
  // Spend caps. Any cap left undefined is not enforced.
  budget?: {
    maxCostPerRun?: number;      // USD, per agent run
    maxTokensPerRun?: number;    // input+output tokens, per agent run
    maxCostPerProject?: number;  // USD, accumulated across runs in a project dir
  };
  // Pre-tool policy hook. `command` receives the tool-call JSON on stdin;
  // exit 0 = allow, non-zero = deny (stderr = reason), timeout = deny (fail closed).
  policy?: {
    command?: string;
    timeoutMs?: number;  // default 5000
  };
}

const DEFAULT_CONFIG: CalliopeConfig = {
  setupComplete: false,
  defaultProvider: 'auto',
  maxIterations: 0,  // 0 = unlimited (circuit breakers provide safety)
  maxIterationTime: 600,  // 10 minutes per iteration (seconds, 0 = no limit)
  autoSaveHistory: true,
  autoUpgrade: true,
  collapseTools: false,
  toolDisplayLimit: 0,  // 0 = show all expanded
  diffStyle: 'inline',
  circuitBreakersEnabled: false,
  sandboxMode: 'auto',
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
    providers: { type: 'object' },
    fleet: { type: 'object' },
    maxIterations: { type: 'number', minimum: 0, maximum: 1000000 },
    maxIterationTime: { type: 'number', minimum: 0, maximum: 3600 },
    autoSaveHistory: { type: 'boolean' },
    autoUpgrade: { type: 'boolean' },
    collapseTools: { type: 'boolean' },
    toolDisplayLimit: { type: 'number', minimum: 0, maximum: 100 },
    diffStyle: { type: 'string', enum: ['inline', 'unified', 'side-by-side'] },
    circuitBreakersEnabled: { type: 'boolean' },
    sandboxMode: { type: 'string', enum: ['auto', 'native', 'docker', 'off'] },
    routing: { type: 'object' },
    sessionLogLimit: { type: 'number', minimum: 0, maximum: 100000 },
    audit: { type: 'object' },
    budget: { type: 'object' },
    policy: { type: 'object' },
  },
});

// ---------------------------------------------------------------------------
// Provider credential resolution
//
// Environment variables take precedence over stored config for every provider
// except the openai-compat base URL, which historically preferred the stored
// value — preserved here byte-for-byte. `model` has no environment fallback.
// ---------------------------------------------------------------------------

const PROVIDER_ENV: Record<string, { apiKey?: string; baseUrl?: string; region?: string[]; profile?: string }> = {
  anthropic: { apiKey: 'ANTHROPIC_API_KEY' },
  google: { apiKey: 'GOOGLE_API_KEY' },
  openai: { apiKey: 'OPENAI_API_KEY' },
  together: { apiKey: 'TOGETHER_API_KEY' },
  openrouter: { apiKey: 'OPENROUTER_API_KEY' },
  groq: { apiKey: 'GROQ_API_KEY' },
  fireworks: { apiKey: 'FIREWORKS_API_KEY' },
  mistral: { apiKey: 'MISTRAL_API_KEY' },
  ollama: { baseUrl: 'OLLAMA_BASE_URL' },
  ai21: { apiKey: 'AI21_API_KEY' },
  huggingface: { apiKey: 'HUGGINGFACE_API_KEY' },
  litellm: { apiKey: 'LITELLM_API_KEY', baseUrl: 'LITELLM_BASE_URL' },
  bedrock: { apiKey: 'BEDROCK_API_KEY', baseUrl: 'BEDROCK_BASE_URL', region: ['AWS_REGION', 'AWS_DEFAULT_REGION'], profile: 'AWS_PROFILE' },
  'openai-compat': { apiKey: 'OPENAI_COMPAT_API_KEY', baseUrl: 'OPENAI_COMPAT_BASE_URL' },
};

function firstEnv(names?: string | string[]): string | undefined {
  if (!names) return undefined;
  for (const name of Array.isArray(names) ? names : [names]) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve credentials for a provider, merging the stored nested config with the
 * same environment-variable fallbacks that existed before the config shrink.
 */
export function getProviderCred(provider: string): ProviderCred {
  const stored: ProviderCred = (config.get('providers') ?? {})[provider] ?? {};
  const env = PROVIDER_ENV[provider] ?? {};
  // openai-compat prefers the stored base URL over the env var; all others prefer env.
  const baseUrl = provider === 'openai-compat'
    ? (stored.baseUrl || firstEnv(env.baseUrl))
    : (firstEnv(env.baseUrl) || stored.baseUrl);
  return {
    apiKey: firstEnv(env.apiKey) || stored.apiKey,
    baseUrl,
    model: stored.model,
    region: firstEnv(env.region) || stored.region,
    profile: firstEnv(env.profile) || stored.profile,
  };
}

/**
 * Write (merge) credentials for a provider into the nested `providers` map.
 * Only the fields present in `patch` are updated. Validates non-empty API keys
 * and well-formed base URLs, matching the old flat-key validation.
 */
export function setProviderCred(provider: string, patch: ProviderCred): void {
  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== 'string' || patch.apiKey.trim().length === 0) {
      throw new Error(`API key for ${provider} must be a non-empty string`);
    }
  }
  if (patch.baseUrl !== undefined) {
    if (typeof patch.baseUrl !== 'string') {
      throw new Error(`Base URL for ${provider} must be a string`);
    }
    try {
      new URL(patch.baseUrl);
    } catch {
      throw new Error(`Base URL for ${provider} must be a valid URL`);
    }
  }

  const all = { ...(config.get('providers') ?? {}) };
  const merged: ProviderCred = { ...(all[provider] ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  all[provider] = merged;
  config.set('providers', all);
}

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
  validateConfigValue(key, value);
  config.set(key, value);
}

/**
 * Set multiple config values with validation
 */
export function setMultiple(values: Partial<CalliopeConfig>): void {
  // Validate all values first before setting any
  for (const [key, value] of Object.entries(values)) {
    validateConfigValue(key as keyof CalliopeConfig, value);
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

  if (getProviderCred('anthropic').apiKey) providers.push('anthropic');
  if (getProviderCred('google').apiKey) providers.push('google');
  if (getProviderCred('openai').apiKey) providers.push('openai');
  if (getProviderCred('together').apiKey) providers.push('together');
  if (getProviderCred('openrouter').apiKey) providers.push('openrouter');
  if (getProviderCred('groq').apiKey) providers.push('groq');
  if (getProviderCred('fireworks').apiKey) providers.push('fireworks');
  if (getProviderCred('mistral').apiKey) providers.push('mistral');
  if (getProviderCred('ollama').baseUrl) providers.push('ollama');
  if (getProviderCred('ai21').apiKey) providers.push('ai21');
  if (getProviderCred('huggingface').apiKey) providers.push('huggingface');
  if (getProviderCred('litellm').baseUrl) providers.push('litellm');
  const bedrock = getProviderCred('bedrock');
  if (bedrock.apiKey || bedrock.baseUrl || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) providers.push('bedrock');
  if (getProviderCred('openai-compat').baseUrl) providers.push('openai-compat');

  return providers;
}

/**
 * Get API key for a provider
 */
export function getApiKey(provider: LLMProvider): string | undefined {
  // Ollama has no API key — its "key" is the base URL.
  if (provider === 'ollama') return getProviderCred('ollama').baseUrl;
  // openai-compat defaults to a placeholder key when none is configured.
  if (provider === 'openai-compat') return getProviderCred('openai-compat').apiKey || 'openai-compat';
  return getProviderCred(provider).apiKey;
}

/**
 * Get base URL for a provider (for Ollama/LiteLLM/Bedrock/openai-compat)
 */
export function getBaseUrl(provider: LLMProvider): string | undefined {
  if (provider === 'ollama') return getProviderCred('ollama').baseUrl || 'http://localhost:11434';
  if (provider === 'litellm') return getProviderCred('litellm').baseUrl || 'http://localhost:4000';
  if (provider === 'bedrock') return getProviderCred('bedrock').baseUrl;
  if (provider === 'openai-compat') return getProviderCred('openai-compat').baseUrl;
  return undefined;
}

// ---------------------------------------------------------------------------
// One-time migration to the nested provider-credential config format (#193)
// ---------------------------------------------------------------------------

// Old flat credential keys → [nested provider, field].
const LEGACY_FLAT_CREDS: Array<[string, string, keyof ProviderCred]> = [
  ['anthropicApiKey', 'anthropic', 'apiKey'],
  ['googleApiKey', 'google', 'apiKey'],
  ['openaiApiKey', 'openai', 'apiKey'],
  ['togetherApiKey', 'together', 'apiKey'],
  ['openrouterApiKey', 'openrouter', 'apiKey'],
  ['groqApiKey', 'groq', 'apiKey'],
  ['fireworksApiKey', 'fireworks', 'apiKey'],
  ['mistralApiKey', 'mistral', 'apiKey'],
  ['ai21ApiKey', 'ai21', 'apiKey'],
  ['huggingfaceApiKey', 'huggingface', 'apiKey'],
  ['ollamaBaseUrl', 'ollama', 'baseUrl'],
  ['litellmBaseUrl', 'litellm', 'baseUrl'],
  ['litellmApiKey', 'litellm', 'apiKey'],
  ['bedrockApiKey', 'bedrock', 'apiKey'],
  ['bedrockBaseUrl', 'bedrock', 'baseUrl'],
  ['awsRegion', 'bedrock', 'region'],
  ['awsProfile', 'bedrock', 'profile'],
  ['openaiCompatBaseUrl', 'openai-compat', 'baseUrl'],
  ['openaiCompatApiKey', 'openai-compat', 'apiKey'],
  ['openaiCompatModel', 'openai-compat', 'model'],
];

// The complete set of keys the current schema recognises. Anything else in a
// stored config is legacy (old flat creds, renamed routing keys, or junk from
// removed subsystems) and is dropped by the migration.
const SURVIVOR_KEYS = new Set<string>([
  'setupComplete', 'defaultProvider', 'defaultModel', 'providers', 'fleet',
  'maxIterations', 'maxIterationTime', 'autoSaveHistory', 'autoUpgrade',
  'collapseTools', 'toolDisplayLimit', 'diffStyle', 'circuitBreakersEnabled',
  'sandboxMode', 'routing', 'sessionLogLimit',
  // Governance (#189)
  'audit', 'budget', 'policy',
]);

/**
 * Migrate a stored config from the pre-#193 flat format to the nested format.
 * Runs once at startup and is idempotent — a second run is a no-op.
 *
 * Steps: (1) fold the old flat credential keys into `providers`, (2) rename the
 * smart-routing keys into `routing`, (3) drop every remaining non-survivor key
 * (cut settings + junk from removed subsystems). Values are read from a snapshot
 * so the live deletes below don't disturb the reads.
 */
export function migrateV3(): void {
  const store = { ...(config.store as unknown as Record<string, unknown>) };
  const raw = config as unknown as { delete(key: string): void };

  let hadFlatCred = false;
  const providers: Record<string, ProviderCred> = { ...((store.providers as Record<string, ProviderCred>) ?? {}) };

  for (const [flatKey, provider, field] of LEGACY_FLAT_CREDS) {
    if (flatKey in store) {
      hadFlatCred = true;
      const value = store[flatKey];
      if (typeof value === 'string' && value.length > 0) {
        providers[provider] = { ...(providers[provider] ?? {}), [field]: value };
      }
    }
  }

  // Fold the old smart-routing keys into the nested `routing` object.
  if (('smartRoutingEnabled' in store || 'smartRoutingCostSensitivity' in store) && !('routing' in store)) {
    const enabled = store.smartRoutingEnabled === true;
    const costSensitivity = typeof store.smartRoutingCostSensitivity === 'number'
      ? (store.smartRoutingCostSensitivity as number)
      : 0.3;
    config.set('routing', { enabled, costSensitivity });
  }

  if (hadFlatCred && Object.keys(providers).length > 0) {
    config.set('providers', providers);
  }

  // Drop every stored key not in the current schema: old flat creds, the renamed
  // routing keys, cut display settings, and junk from removed subsystems.
  for (const key of Object.keys(store)) {
    if (!SURVIVOR_KEYS.has(key)) raw.delete(key);
  }

  if (hadFlatCred) {
    console.error('calliope: migrated provider credentials to the new config format.');
  }
}

migrateV3();

export default config;
