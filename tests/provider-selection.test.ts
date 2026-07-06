/**
 * Tests for selectProvider's no-silent-switch behavior (#217).
 *
 * An explicitly-selected provider ('anthropic', 'openai', …) with no credential
 * must throw ProviderUnavailableError carrying an actionable fix hint — it must
 * NOT silently fall through to whatever else happens to be configured. Only
 * 'auto' walks the priority list and falls back.
 *
 * Exercises the REAL config store (isolated to a temp dir by the vitest setup)
 * and the REAL selectProvider — no mocks — so it proves end-to-end wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectProvider, ProviderUnavailableError } from '../src/providers/index.js';
import { resetConfig, setProviderCred } from '../src/config.js';

// Provider credential env vars can leak in from the developer's shell and make a
// provider look configured. Clear them so the store is the only source of truth.
const PROVIDER_ENV_VARS = [
  'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL',
  'LITELLM_BASE_URL', 'LITELLM_API_KEY', 'TOGETHER_API_KEY', 'OPENROUTER_API_KEY',
  'GROQ_API_KEY', 'FIREWORKS_API_KEY', 'MISTRAL_API_KEY', 'AI21_API_KEY',
  'HUGGINGFACE_API_KEY', 'BEDROCK_API_KEY', 'BEDROCK_BASE_URL',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID',
  'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY',
];

const clearEnv = () => { for (const n of PROVIDER_ENV_VARS) delete process.env[n]; };

beforeEach(() => { resetConfig(); clearEnv(); });
afterEach(() => { resetConfig(); clearEnv(); });

describe('selectProvider — explicit provider without credentials (#217)', () => {
  it('throws ProviderUnavailableError with the fix hint for an API-key provider', () => {
    let caught: unknown;
    try { selectProvider('openai'); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(ProviderUnavailableError);
    expect((caught as ProviderUnavailableError).provider).toBe('openai');
    const msg = (caught as Error).message;
    expect(msg).toContain('openai is selected but has no API key');
    expect(msg).toContain('calliope --setup');
    expect(msg).toContain('/config set providers.openai.apiKey');
    expect(msg).toContain('OPENAI_API_KEY');
  });

  it('does NOT silently fall through to a different configured provider', () => {
    // anthropic IS configured; selecting openai must still fail, not switch.
    setProviderCred('anthropic', { apiKey: 'sk-ant-configured' });
    expect(() => selectProvider('openai')).toThrow(ProviderUnavailableError);
  });

  it('gives an AWS-credentials hint for bedrock', () => {
    let caught: unknown;
    try { selectProvider('bedrock'); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(ProviderUnavailableError);
    const msg = (caught as Error).message;
    expect(msg).toContain('bedrock is selected but has no AWS credentials');
    expect(msg).toContain('AWS_PROFILE or AWS_ACCESS_KEY_ID');
  });

  it('returns the provider when its credential is present (store)', () => {
    setProviderCred('openai', { apiKey: 'sk-openai-live' });
    expect(selectProvider('openai')).toBe('openai');
  });

  it('returns the provider when its credential is present (env var)', () => {
    process.env.MISTRAL_API_KEY = 'mistral-env-key';
    expect(selectProvider('mistral')).toBe('mistral');
  });

  it('honors bedrock when AWS_PROFILE is set', () => {
    process.env.AWS_PROFILE = 'dev';
    expect(selectProvider('bedrock')).toBe('bedrock');
  });
});

describe('selectProvider — auto still falls back (#217)', () => {
  it("'auto' returns the highest-priority configured cloud provider", () => {
    setProviderCred('google', { apiKey: 'g-key' });
    // Priority is anthropic > openai > google > …; only google is configured.
    expect(selectProvider('auto')).toBe('google');
  });

  it("'auto' prefers anthropic over a lower-priority configured provider", () => {
    setProviderCred('anthropic', { apiKey: 'sk-ant' });
    setProviderCred('google', { apiKey: 'g-key' });
    expect(selectProvider('auto')).toBe('anthropic');
  });

  it("'auto' with no cloud keys resolves to the local ollama default, never throws", () => {
    // ollama always has a default base URL (localhost:11434), so 'auto' lands
    // there rather than failing — the local-first fallback.
    expect(selectProvider('auto')).toBe('ollama');
  });
});
