import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import * as config from '../src/config.js';
import {chat, getAvailableProviders, selectProvider} from '../src/providers/index.js';
import {chatOpenAICompatible} from '../src/providers/compat.js';
import {getAvailableModels} from '../src/model-detection.js';
import type {LLMProvider} from '../src/types.js';
import {BACKENDS} from '../scripts/conformance/contract.mjs';
import {createReadiness} from '../scripts/conformance/readiness.mjs';
import {validateCapture} from '../scripts/conformance/captures.mjs';
import {validateSemanticCapture, replaySemanticCapture} from '../scripts/conformance/semantic.mjs';
import {readFileSync} from 'node:fs';

const retired = 'litellm' as LLMProvider;
beforeEach(() => config.resetConfig());
afterEach(() => {config.resetConfig(); vi.unstubAllEnvs(); vi.restoreAllMocks();});

it('retains old configuration without using it as credentials or an automatic provider', () => {
  const stored={apiKey:'retained-fixture-key',baseUrl:'https://retired.invalid'};
  config.set('providers',{litellm:stored});
  vi.stubEnv('LITELLM_API_KEY','ignored-env-key');
  vi.stubEnv('LITELLM_BASE_URL','https://ignored.invalid');
  expect(config.getConfig().providers.litellm).toEqual(stored);
  expect(config.getProviderCred(retired)).toEqual({});
  expect(config.getApiKey(retired)).toBeUndefined();
  expect(config.getBaseUrl(retired)).toBeUndefined();
  expect(config.getProviderNames()).not.toContain(retired);
  expect(config.getConfiguredProviders()).not.toContain(retired);
  expect(getAvailableProviders()).not.toContain(retired);
  expect(() => config.set('defaultProvider',retired)).toThrow(/removed/);
  expect(() => config.setProviderCred(retired,{apiKey:'new-fixture-key'})).toThrow(/removed/);
  expect(config.getConfig().providers.litellm).toEqual(stored);
});

it('refuses explicit retired selection and discovery before any network request or fallback', async () => {
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('must not fetch'));
  expect(() => selectProvider(retired)).toThrow(/removed/);
  await expect(chat(retired,[{role:'user',content:'public fixture'}],[])).rejects.toThrow(/removed/);
  await expect(chatOpenAICompatible(retired,[{role:'user',content:'public fixture'}],[],'fixture')).rejects.toThrow(/removed/);
  await expect(getAvailableModels(retired)).rejects.toThrow(/removed/);
  expect(fetch).not.toHaveBeenCalled();
});

it('keeps historical capture integrity without counting a retired adapter as supported', () => {
  const old=JSON.parse(readFileSync(new URL('./fixtures/provider-wire/litellm-text-json.json',import.meta.url),'utf8'));
  expect(validateCapture(old)).toBe(old);
  expect(BACKENDS.some(backend=>backend.id==='litellm')).toBe(false);
  const report=createReadiness([old]);
  expect(report.capturedWireCombinations).toBe(0);
  expect(report.adapters.some(adapter=>adapter.id==='litellm')).toBe(false);
  expect(report.retired).toContainEqual({provider:'litellm',status:'retired',includedInReleaseGate:false});
});


it('keeps Hugging Face available while ignoring retained LiteLLM credentials', () => {
  for(const provider of config.getProviderNames()) {
    const env=config.getProviderEnvVars(provider);
    if(env.apiKey)vi.stubEnv(env.apiKey,'');
    if(env.baseUrl)vi.stubEnv(env.baseUrl,'');
  }
  config.set('providers',{litellm:{apiKey:'retired',baseUrl:'https://retired.invalid'},huggingface:{apiKey:'fixture-hf'}});
  expect(config.getConfiguredProviders()).toContain('huggingface');
  expect(getAvailableProviders()).toContain('huggingface');
  expect(selectProvider('auto')).toBe('huggingface');
  expect(getAvailableProviders()).not.toContain(retired);
});

it('retains semantic history but refuses to replay it as an active integration', async () => {
  const old=JSON.parse(readFileSync(new URL('./fixtures/provider-semantic/litellm-system-instructions-json-1.json',import.meta.url),'utf8'));
  expect(validateSemanticCapture(old)).toBe(old);
  await expect(replaySemanticCapture(old,{})).rejects.toThrow(/archival evidence only/);
});
