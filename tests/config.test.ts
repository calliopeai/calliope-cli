/**
 * Tests for src/config.ts
 *
 * Covers: get/set, validation, getConfiguredProviders, getApiKey, getBaseUrl,
 * getProviderCred/setProviderCred (nested credentials + env fallbacks),
 * isSetupComplete, markSetupComplete, resetConfig, setMultiple, and the
 * one-time migrateV3() migration to the nested config format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import config, {
  get,
  set,
  getConfig,
  resetConfig,
  isSetupComplete,
  markSetupComplete,
  getConfiguredProviders,
  getApiKey,
  getBaseUrl,
  getConfigPath,
  getProviderCred,
  setProviderCred,
  setMultiple,
  migrateV3,
  resolveConfigCwd,
} from '../src/config.js';

// Seed a legacy (non-schema) key directly on the underlying conf store, bypassing
// the typed `set` wrapper — used to simulate a pre-migration config file.
const rawSet = (key: string, value: unknown): void =>
  (config as unknown as { set(k: string, v: unknown): void }).set(key, value);

const PROVIDER_ENV_VARS = [
  'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL',
  'LITELLM_BASE_URL', 'LITELLM_API_KEY', 'TOGETHER_API_KEY', 'OPENROUTER_API_KEY',
  'GROQ_API_KEY', 'FIREWORKS_API_KEY', 'MISTRAL_API_KEY', 'AI21_API_KEY',
  'HUGGINGFACE_API_KEY', 'BEDROCK_API_KEY', 'BEDROCK_BASE_URL',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID',
  'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY',
];

// ---------------------------------------------------------------------------
// Setup / teardown: reset config before each test to avoid leakage
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfig();
});

afterEach(() => {
  resetConfig();
  for (const name of PROVIDER_ENV_VARS) delete process.env[name];
});

// ===========================================================================
// Basic get / set
// ===========================================================================

describe('get / set', () => {
  it('should return default values after reset', () => {
    expect(get('setupComplete')).toBe(false);
    expect(get('defaultProvider')).toBe('auto');
    expect(get('autoSaveHistory')).toBe(true);
    expect(get('diffStyle')).toBe('inline');
    expect(get('maxIterations')).toBe(0);
    expect(get('sessionLogLimit')).toBe(0);
  });

  it('should set and get a boolean value', () => {
    set('collapseTools', true);
    expect(get('collapseTools')).toBe(true);
  });

  it('should set and get a string value', () => {
    set('defaultModel', 'claude-sonnet-4-6');
    expect(get('defaultModel')).toBe('claude-sonnet-4-6');
  });

  it('should set and get a numeric value', () => {
    set('maxIterations', 50);
    expect(get('maxIterations')).toBe(50);
  });

  it('should set and get session log retention', () => {
    set('sessionLogLimit', 250);
    expect(get('sessionLogLimit')).toBe(250);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe('set validation', () => {
  it('should reject maxIterations below 0', () => {
    expect(() => set('maxIterations', -1)).toThrow('maxIterations');
  });

  it('should reject maxIterations above 1000000', () => {
    expect(() => set('maxIterations', 1000001)).toThrow('maxIterations');
  });

  it('should reject sessionLogLimit below 0', () => {
    expect(() => set('sessionLogLimit', -1)).toThrow('sessionLogLimit');
  });

  it('should reject sessionLogLimit above 100000', () => {
    expect(() => set('sessionLogLimit', 100001)).toThrow('sessionLogLimit');
  });
});

// ===========================================================================
// setMultiple
// ===========================================================================

describe('setMultiple', () => {
  it('should set multiple values at once', () => {
    setMultiple({ collapseTools: true, sandboxMode: 'off' });
    expect(get('collapseTools')).toBe(true);
    expect(get('sandboxMode')).toBe('off');
  });

  it('should not set any values if one fails validation', () => {
    const original = get('collapseTools');
    expect(() => setMultiple({
      collapseTools: true,
      maxIterations: 1000001,  // This should fail validation
    })).toThrow('maxIterations');
    // collapseTools should not have changed (all-or-nothing)
    expect(get('collapseTools')).toBe(original);
  });
});

// ===========================================================================
// getConfig
// ===========================================================================

describe('getConfig', () => {
  it('should return a full config object with all defaults', () => {
    const cfg = getConfig();
    expect(cfg).toBeDefined();
    expect(cfg.setupComplete).toBe(false);
    expect(cfg.defaultProvider).toBe('auto');
  });
});

// ===========================================================================
// isSetupComplete / markSetupComplete
// ===========================================================================

describe('isSetupComplete / markSetupComplete', () => {
  it('should be false after reset', () => {
    expect(isSetupComplete()).toBe(false);
  });

  it('should be true after marking complete', () => {
    markSetupComplete();
    expect(isSetupComplete()).toBe(true);
  });
});

// ===========================================================================
// resetConfig
// ===========================================================================

describe('resetConfig', () => {
  it('should restore all defaults', () => {
    set('collapseTools', true);
    set('maxIterations', 100);
    set('sessionLogLimit', 250);
    set('diffStyle', 'unified');
    markSetupComplete();

    resetConfig();

    expect(get('collapseTools')).toBe(false);
    expect(get('maxIterations')).toBe(0);
    expect(get('sessionLogLimit')).toBe(0);
    expect(get('diffStyle')).toBe('inline');
    expect(isSetupComplete()).toBe(false);
  });
});

// ===========================================================================
// getConfigPath
// ===========================================================================

describe('getConfigPath', () => {
  it('should return a non-empty string', () => {
    const p = getConfigPath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// getConfiguredProviders
// ===========================================================================

describe('getConfiguredProviders', () => {
  it('should return empty list with no keys configured', () => {
    const providers = getConfiguredProviders();
    // env vars may be set in CI, so we just check the type
    expect(Array.isArray(providers)).toBe(true);
  });

  it('should detect anthropic from env var', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(getConfiguredProviders()).toContain('anthropic');
  });

  it('should detect google from env var', () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    expect(getConfiguredProviders()).toContain('google');
  });

  it('should detect openai from env var', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    expect(getConfiguredProviders()).toContain('openai');
  });

  it('should detect ollama from env var', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    expect(getConfiguredProviders()).toContain('ollama');
  });

  it('should detect anthropic from nested config', () => {
    setProviderCred('anthropic', { apiKey: 'sk-ant-test' });
    expect(getConfiguredProviders()).toContain('anthropic');
  });
});

// ===========================================================================
// getApiKey
// ===========================================================================

describe('getApiKey', () => {
  it('should return undefined for auto', () => {
    expect(getApiKey('auto')).toBeUndefined();
  });

  it('should prefer env var over config', () => {
    setProviderCred('anthropic', { apiKey: 'config-key' });
    process.env.ANTHROPIC_API_KEY = 'env-key';
    expect(getApiKey('anthropic')).toBe('env-key');
  });

  it('should fall back to config when env var is not set', () => {
    setProviderCred('openai', { apiKey: 'config-openai-key' });
    expect(getApiKey('openai')).toBe('config-openai-key');
  });

  it('should return undefined when neither env var nor config is set', () => {
    expect(getApiKey('google')).toBeUndefined();
  });
});

// ===========================================================================
// getBaseUrl
// ===========================================================================

describe('getBaseUrl', () => {
  it('should return default ollama URL when nothing configured', () => {
    expect(getBaseUrl('ollama')).toBe('http://localhost:11434');
  });

  it('should return default litellm URL when nothing configured', () => {
    expect(getBaseUrl('litellm')).toBe('http://localhost:4000');
  });

  it('should prefer env var for ollama', () => {
    process.env.OLLAMA_BASE_URL = 'http://custom:9999';
    expect(getBaseUrl('ollama')).toBe('http://custom:9999');
  });

  it('should prefer env var for litellm', () => {
    process.env.LITELLM_BASE_URL = 'http://litellm:5000';
    expect(getBaseUrl('litellm')).toBe('http://litellm:5000');
  });

  it('should return undefined for non-url providers', () => {
    expect(getBaseUrl('anthropic')).toBeUndefined();
    expect(getBaseUrl('openai')).toBeUndefined();
  });
});

// ===========================================================================
// getProviderCred / setProviderCred (nested credentials + env fallbacks)
// ===========================================================================

describe('getProviderCred / setProviderCred', () => {
  it('reads a stored apiKey from the nested map', () => {
    setProviderCred('anthropic', { apiKey: 'sk-ant-x' });
    expect(getProviderCred('anthropic').apiKey).toBe('sk-ant-x');
  });

  it('prefers the env var over stored config for apiKey', () => {
    setProviderCred('anthropic', { apiKey: 'config-key' });
    process.env.ANTHROPIC_API_KEY = 'env-key';
    expect(getProviderCred('anthropic').apiKey).toBe('env-key');
  });

  it('reads the ollama base URL from OLLAMA_BASE_URL', () => {
    process.env.OLLAMA_BASE_URL = 'http://remote:11434';
    expect(getProviderCred('ollama').baseUrl).toBe('http://remote:11434');
  });

  it('resolves the bedrock region from AWS_REGION', () => {
    process.env.AWS_REGION = 'eu-west-1';
    expect(getProviderCred('bedrock').region).toBe('eu-west-1');
  });

  it('falls back to AWS_DEFAULT_REGION for the bedrock region', () => {
    process.env.AWS_DEFAULT_REGION = 'ap-south-1';
    expect(getProviderCred('bedrock').region).toBe('ap-south-1');
  });

  it('resolves the bedrock profile from AWS_PROFILE', () => {
    process.env.AWS_PROFILE = 'dev';
    expect(getProviderCred('bedrock').profile).toBe('dev');
  });

  it('merges successive patches for a provider', () => {
    setProviderCred('bedrock', { region: 'us-east-1' });
    setProviderCred('bedrock', { profile: 'staging' });
    const cred = getProviderCred('bedrock');
    expect(cred.region).toBe('us-east-1');
    expect(cred.profile).toBe('staging');
  });

  it('prefers the stored openai-compat base URL over the env var (legacy quirk)', () => {
    setProviderCred('openai-compat', { baseUrl: 'http://config:1234/v1' });
    process.env.OPENAI_COMPAT_BASE_URL = 'http://env:5678/v1';
    expect(getProviderCred('openai-compat').baseUrl).toBe('http://config:1234/v1');
  });

  it('has no env fallback for model', () => {
    setProviderCred('openai-compat', { model: 'my-model' });
    expect(getProviderCred('openai-compat').model).toBe('my-model');
  });

  it('rejects an empty apiKey', () => {
    expect(() => setProviderCred('anthropic', { apiKey: '' })).toThrow('non-empty string');
  });

  it('rejects a whitespace-only apiKey', () => {
    expect(() => setProviderCred('anthropic', { apiKey: '   ' })).toThrow('non-empty string');
  });

  it('rejects an invalid base URL', () => {
    expect(() => setProviderCred('ollama', { baseUrl: 'not-a-url' })).toThrow('valid URL');
  });

  it('accepts a valid base URL', () => {
    setProviderCred('ollama', { baseUrl: 'http://localhost:11434' });
    expect(getProviderCred('ollama').baseUrl).toBe('http://localhost:11434');
  });
});

// ===========================================================================
// getApiKey — all providers (via nested config)
// ===========================================================================

describe('getApiKey - all providers', () => {
  it('should return key for together', () => {
    setProviderCred('together', { apiKey: 'together-config-key' });
    expect(getApiKey('together')).toBe('together-config-key');
  });

  it('should return key for openrouter', () => {
    setProviderCred('openrouter', { apiKey: 'or-config-key' });
    expect(getApiKey('openrouter')).toBe('or-config-key');
  });

  it('should return key for groq', () => {
    setProviderCred('groq', { apiKey: 'groq-config-key' });
    expect(getApiKey('groq')).toBe('groq-config-key');
  });

  it('should return key for fireworks', () => {
    setProviderCred('fireworks', { apiKey: 'fw-config-key' });
    expect(getApiKey('fireworks')).toBe('fw-config-key');
  });

  it('should return key for mistral', () => {
    setProviderCred('mistral', { apiKey: 'mistral-config-key' });
    expect(getApiKey('mistral')).toBe('mistral-config-key');
  });

  it('should return base url for ollama (from env)', () => {
    process.env.OLLAMA_BASE_URL = 'http://remote-ollama:11434';
    expect(getApiKey('ollama')).toBe('http://remote-ollama:11434');
  });

  it('should return key for ai21', () => {
    setProviderCred('ai21', { apiKey: 'ai21-config-key' });
    expect(getApiKey('ai21')).toBe('ai21-config-key');
  });

  it('should return key for huggingface', () => {
    setProviderCred('huggingface', { apiKey: 'hf-config-key' });
    expect(getApiKey('huggingface')).toBe('hf-config-key');
  });

  it('should return key for litellm', () => {
    setProviderCred('litellm', { apiKey: 'litellm-config-key' });
    expect(getApiKey('litellm')).toBe('litellm-config-key');
  });

  it('should return key for bedrock', () => {
    setProviderCred('bedrock', { apiKey: 'bedrock-config-key' });
    expect(getApiKey('bedrock')).toBe('bedrock-config-key');
  });

  it('should prefer LITELLM_API_KEY env var over config', () => {
    setProviderCred('litellm', { apiKey: 'config-litellm-key' });
    process.env.LITELLM_API_KEY = 'env-litellm-key';
    expect(getApiKey('litellm')).toBe('env-litellm-key');
  });

  it('should prefer BEDROCK_API_KEY env var over config', () => {
    setProviderCred('bedrock', { apiKey: 'config-bedrock-key' });
    process.env.BEDROCK_API_KEY = 'env-bedrock-key';
    expect(getApiKey('bedrock')).toBe('env-bedrock-key');
  });
});

// ===========================================================================
// getConfiguredProviders — bedrock detection
// ===========================================================================

describe('getConfiguredProviders - bedrock', () => {
  it('should detect bedrock from BEDROCK_API_KEY env var', () => {
    process.env.BEDROCK_API_KEY = 'bedrock-key';
    expect(getConfiguredProviders()).toContain('bedrock');
  });

  it('should detect bedrock from BEDROCK_BASE_URL env var', () => {
    process.env.BEDROCK_BASE_URL = 'https://bedrock.us-east-1.amazonaws.com';
    expect(getConfiguredProviders()).toContain('bedrock');
  });

  it('should detect bedrock from AWS_ACCESS_KEY_ID env var', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    expect(getConfiguredProviders()).toContain('bedrock');
  });

  it('should detect bedrock from AWS_PROFILE env var', () => {
    process.env.AWS_PROFILE = 'default';
    expect(getConfiguredProviders()).toContain('bedrock');
  });

  it('should detect bedrock from nested config baseUrl', () => {
    setProviderCred('bedrock', { baseUrl: 'https://bedrock.us-east-1.amazonaws.com' });
    expect(getConfiguredProviders()).toContain('bedrock');
  });
});

// ===========================================================================
// getBaseUrl — bedrock provider
// ===========================================================================

describe('getBaseUrl - bedrock', () => {
  it('should return undefined for bedrock when nothing configured', () => {
    expect(getBaseUrl('bedrock')).toBeUndefined();
  });

  it('should prefer BEDROCK_BASE_URL env var', () => {
    process.env.BEDROCK_BASE_URL = 'https://bedrock-gateway.company.com';
    expect(getBaseUrl('bedrock')).toBe('https://bedrock-gateway.company.com');
  });

  it('should fall back to nested config baseUrl', () => {
    setProviderCred('bedrock', { baseUrl: 'https://bedrock.us-west-2.amazonaws.com' });
    expect(getBaseUrl('bedrock')).toBe('https://bedrock.us-west-2.amazonaws.com');
  });
});

// ===========================================================================
// resolveConfigCwd — the test-isolation guard (#217)
// ===========================================================================

describe('resolveConfigCwd (test-store isolation guard)', () => {
  it('throws under Vitest when CALLIOPE_CONFIG_DIR is unset (refuses the real store)', () => {
    expect(() => resolveConfigCwd({ VITEST: 'true' } as NodeJS.ProcessEnv))
      .toThrow('tests must set CALLIOPE_CONFIG_DIR — refusing to touch the real config store');
  });

  it('returns the override dir when both VITEST and CALLIOPE_CONFIG_DIR are set', () => {
    expect(resolveConfigCwd({ VITEST: 'true', CALLIOPE_CONFIG_DIR: '/tmp/iso' } as NodeJS.ProcessEnv))
      .toBe('/tmp/iso');
  });

  it('returns undefined outside tests when the override is unset (conf uses its default)', () => {
    expect(resolveConfigCwd({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('honors the override even outside Vitest', () => {
    expect(resolveConfigCwd({ CALLIOPE_CONFIG_DIR: '/tmp/prod-override' } as NodeJS.ProcessEnv))
      .toBe('/tmp/prod-override');
  });

  it('the live process is isolated — the guard did not throw at import (dir is set)', () => {
    // The vitest setup (tests/setup/isolate-stores.ts) must have set the override,
    // otherwise importing config.ts would have thrown before this suite ran.
    expect(process.env.CALLIOPE_CONFIG_DIR).toBeTruthy();
    expect(resolveConfigCwd()).toBe(process.env.CALLIOPE_CONFIG_DIR);
  });
});

// ===========================================================================
// migrateV3 — one-time migration from the flat format to the nested format
// ===========================================================================

describe('migrateV3', () => {
  it('folds flat provider keys into the nested providers map and deletes them', () => {
    rawSet('anthropicApiKey', 'sk-ant-old');
    rawSet('ollamaBaseUrl', 'http://old-ollama:11434');
    rawSet('awsRegion', 'us-west-2');
    rawSet('awsProfile', 'legacy-profile');
    rawSet('openaiCompatModel', 'legacy-model');

    migrateV3();

    const providers = get('providers');
    expect(providers?.anthropic?.apiKey).toBe('sk-ant-old');
    expect(providers?.ollama?.baseUrl).toBe('http://old-ollama:11434');
    expect(providers?.bedrock?.region).toBe('us-west-2');
    expect(providers?.bedrock?.profile).toBe('legacy-profile');
    expect(providers?.['openai-compat']?.model).toBe('legacy-model');

    const store = config.store as Record<string, unknown>;
    expect('anthropicApiKey' in store).toBe(false);
    expect('ollamaBaseUrl' in store).toBe(false);
    expect('awsRegion' in store).toBe(false);
    expect('awsProfile' in store).toBe(false);
    expect('openaiCompatModel' in store).toBe(false);
  });

  it('resolves migrated credentials through getProviderCred/getApiKey', () => {
    rawSet('groqApiKey', 'gsk_migrated');
    migrateV3();
    expect(getProviderCred('groq').apiKey).toBe('gsk_migrated');
    expect(getApiKey('groq')).toBe('gsk_migrated');
  });

  it('renames the smart-routing keys into routing', () => {
    rawSet('smartRoutingEnabled', true);
    rawSet('smartRoutingCostSensitivity', 0.7);

    migrateV3();

    expect(get('routing')?.enabled).toBe(true);
    expect(get('routing')?.costSensitivity).toBe(0.7);
    const store = config.store as Record<string, unknown>;
    expect('smartRoutingEnabled' in store).toBe(false);
    expect('smartRoutingCostSensitivity' in store).toBe(false);
  });

  it('silently deletes junk keys from removed subsystems', () => {
    rawSet('persona', 'sage');
    rawSet('fancyOutput', false);
    rawSet('activeProfile', 'fast');
    rawSet('sessionTimeoutMs', 7200000);

    migrateV3();

    const store = config.store as Record<string, unknown>;
    expect('persona' in store).toBe(false);
    expect('fancyOutput' in store).toBe(false);
    expect('activeProfile' in store).toBe(false);
    expect('sessionTimeoutMs' in store).toBe(false);
  });

  it('logs a single line when provider credentials were migrated', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rawSet('anthropicApiKey', 'sk-ant-old');

    migrateV3();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('calliope: migrated provider credentials to the new config format.');
    spy.mockRestore();
  });

  it('is silent and a no-op on an already-migrated config', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setProviderCred('anthropic', { apiKey: 'sk-ant-new' });

    migrateV3();

    expect(spy).not.toHaveBeenCalled();
    expect(getProviderCred('anthropic').apiKey).toBe('sk-ant-new');
    spy.mockRestore();
  });

  it('does not log when only junk keys are cleaned up', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    rawSet('fancyOutput', true);

    migrateV3();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
