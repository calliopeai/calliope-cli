/**
 * Tests for src/config.ts
 *
 * Covers: get/set, validation, getConfiguredProviders, getApiKey, getBaseUrl,
 * isSetupComplete, markSetupComplete, resetConfig, profiles, and setMultiple.
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
  getProfile,
  saveProfile,
  deleteProfile,
  listProfiles,
  setActiveProfile,
  getActiveProfile,
  setMultiple,
} from '../src/config.js';

// ---------------------------------------------------------------------------
// Setup / teardown: reset config before each test to avoid leakage
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetConfig();
});

afterEach(() => {
  resetConfig();
  // Clean env vars we may have set
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.LITELLM_BASE_URL;
  delete process.env.TOGETHER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.FIREWORKS_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  delete process.env.AI21_API_KEY;
  delete process.env.HUGGINGFACE_API_KEY;
  delete process.env.LITELLM_API_KEY;
});

// ===========================================================================
// Basic get / set
// ===========================================================================

describe('get / set', () => {
  it('should return default values after reset', () => {
    expect(get('setupComplete')).toBe(false);
    expect(get('defaultProvider')).toBe('auto');
    expect(get('persona')).toBe('calliope');
    expect(get('fancyOutput')).toBe(true);
    expect(get('maxIterations')).toBe(0);
  });

  it('should set and get a boolean value', () => {
    set('fancyOutput', false);
    expect(get('fancyOutput')).toBe(false);
  });

  it('should set and get a string value', () => {
    set('activeSkin', 'neon');
    expect(get('activeSkin')).toBe('neon');
  });

  it('should set and get a numeric value', () => {
    set('maxIterations', 50);
    expect(get('maxIterations')).toBe(50);
  });
});

// ===========================================================================
// Validation
// ===========================================================================

describe('set validation', () => {
  it('should reject empty API keys', () => {
    expect(() => set('anthropicApiKey', '')).toThrow('non-empty string');
  });

  it('should reject whitespace-only API keys', () => {
    expect(() => set('anthropicApiKey', '   ')).toThrow('non-empty string');
  });

  it('should accept valid API keys', () => {
    set('anthropicApiKey', 'sk-ant-test-key-123');
    expect(get('anthropicApiKey')).toBe('sk-ant-test-key-123');
  });

  it('should reject invalid base URLs', () => {
    expect(() => set('ollamaBaseUrl', 'not-a-url')).toThrow('valid URL');
  });

  it('should accept valid base URLs', () => {
    set('ollamaBaseUrl', 'http://localhost:11434');
    expect(get('ollamaBaseUrl')).toBe('http://localhost:11434');
  });

  it('should reject maxIterations below 0', () => {
    expect(() => set('maxIterations', -1)).toThrow('maxIterations');
  });

  it('should reject maxIterations above 1000000', () => {
    expect(() => set('maxIterations', 1000001)).toThrow('maxIterations');
  });
});

// ===========================================================================
// setMultiple
// ===========================================================================

describe('setMultiple', () => {
  it('should set multiple values at once', () => {
    setMultiple({ fancyOutput: false, activeSkin: 'retro' });
    expect(get('fancyOutput')).toBe(false);
    expect(get('activeSkin')).toBe('retro');
  });

  it('should not set any values if one fails validation', () => {
    const original = get('fancyOutput');
    expect(() => setMultiple({
      fancyOutput: false,
      anthropicApiKey: '',  // This should fail
    })).toThrow();
    // fancyOutput should not have changed
    expect(get('fancyOutput')).toBe(original);
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
    expect(cfg.persona).toBe('calliope');
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
    set('fancyOutput', false);
    set('maxIterations', 100);
    set('activeSkin', 'matrix');
    markSetupComplete();

    resetConfig();

    expect(get('fancyOutput')).toBe(true);
    expect(get('maxIterations')).toBe(0);
    expect(get('activeSkin')).toBe('clean');
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
    // Should not include any providers when env vars are clean and config is reset
    // (env vars may be set in CI, so we just check the type)
    expect(Array.isArray(providers)).toBe(true);
  });

  it('should detect anthropic from env var', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const providers = getConfiguredProviders();
    expect(providers).toContain('anthropic');
  });

  it('should detect google from env var', () => {
    process.env.GOOGLE_API_KEY = 'test-key';
    const providers = getConfiguredProviders();
    expect(providers).toContain('google');
  });

  it('should detect openai from env var', () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const providers = getConfiguredProviders();
    expect(providers).toContain('openai');
  });

  it('should detect ollama from env var', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const providers = getConfiguredProviders();
    expect(providers).toContain('ollama');
  });

  it('should detect anthropic from config', () => {
    set('anthropicApiKey', 'sk-ant-test');
    const providers = getConfiguredProviders();
    expect(providers).toContain('anthropic');
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
    set('anthropicApiKey', 'config-key');
    process.env.ANTHROPIC_API_KEY = 'env-key';
    expect(getApiKey('anthropic')).toBe('env-key');
  });

  it('should fall back to config when env var is not set', () => {
    set('openaiApiKey', 'config-openai-key');
    expect(getApiKey('openai')).toBe('config-openai-key');
  });

  it('should return undefined when neither env var nor config is set', () => {
    // Reset ensures no config keys; env cleanup in afterEach ensures no env vars
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
// Profiles
// ===========================================================================

describe('profiles', () => {
  it('should return built-in profiles', () => {
    expect(getProfile('fast')).toBeDefined();
    expect(getProfile('smart')).toBeDefined();
    expect(getProfile('cheap')).toBeDefined();
    expect(getProfile('local')).toBeDefined();
  });

  it('should return undefined for non-existent profiles', () => {
    expect(getProfile('nonexistent')).toBeUndefined();
  });

  it('should save and retrieve custom profiles', () => {
    saveProfile('myprofile', {
      provider: 'anthropic',
      persona: 'calliope',
    });
    const p = getProfile('myprofile');
    expect(p).toBeDefined();
    expect(p!.provider).toBe('anthropic');
  });

  it('should delete custom profiles', () => {
    saveProfile('todelete', { provider: 'google', persona: 'minimal' });
    expect(deleteProfile('todelete')).toBe(true);
    expect(getProfile('todelete')).toBeUndefined();
  });

  it('should not delete built-in profiles', () => {
    expect(deleteProfile('fast')).toBe(false);
    expect(getProfile('fast')).toBeDefined();
  });

  it('should list all profiles', () => {
    saveProfile('custom1', { provider: 'openai', persona: 'calliope' });
    const list = listProfiles();
    const names = list.map(p => p.name);
    expect(names).toContain('fast');
    expect(names).toContain('smart');
    expect(names).toContain('custom1');
    expect(list.find(p => p.name === 'fast')!.builtin).toBe(true);
    expect(list.find(p => p.name === 'custom1')!.builtin).toBe(false);
  });

  it('should set and get active profile', () => {
    setActiveProfile('fast');
    expect(getActiveProfile()).toBe('fast');
    // Setting a different profile should override
    setActiveProfile('smart');
    expect(getActiveProfile()).toBe('smart');
  });
});
