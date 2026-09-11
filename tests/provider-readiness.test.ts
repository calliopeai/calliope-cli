import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BACKENDS } from '../scripts/conformance/contract.mjs';
import { createReadiness, credentialStatus, REQUIRED_CHECKS } from '../scripts/conformance/readiness.mjs';

const directory = new URL('./fixtures/provider-wire/', import.meta.url);
const captures = readdirSync(directory).filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(readFileSync(new URL(file, directory), 'utf8')));

it('requires evidence for new providers and excludes retired AI21', () => {
  const ids = BACKENDS.map(b => b.id);
  expect(ids).toEqual(expect.arrayContaining(['deepseek', 'xai', 'cerebras']));
  expect(ids).not.toContain('ai21');
  const report = createReadiness([]);
  expect(report.requiredWireCombinations).toBe(BACKENDS.length * 4);
  expect(report.productGateReady).toBe(false);
  expect(report.adapters.every(a => Object.keys(a.checks).length === REQUIRED_CHECKS.length)).toBe(true);
});

it('counts unique historical captures without treating missing access or untested semantics as passing', () => {
  // Control the missing-evidence case even when the real corpus gains DeepSeek captures.
  const evidence = captures.filter(capture => capture.backend !== 'deepseek');
  const report = createReadiness([...evidence, ...evidence], { deepseek: 'missing', anthropic: 'missing' });
  expect(report.capturedWireCombinations).toBe(evidence.length);
  expect(report.adapters.find(a => a.id === 'deepseek')!.checks['text-json']).toBe('unavailable');
  const anthropic = report.adapters.find(a => a.id === 'anthropic')!;
  expect(anthropic.credentials).toBe('missing');
  expect(anthropic.checks['text-json']).toBe('captured');
  expect(anthropic.checks.cancellation).toBe('unavailable');
  expect(report.wireGateReady).toBe(false);
  expect(report.productGateReady).toBe(false);
});

it('keeps incomplete usage explicit and rejects malformed or secret-bearing status input', () => {
  const report = createReadiness(captures);
  expect(report.adapters.find(a => a.id === 'litellm')!.checks.usage).toBe('incomplete');
  expect(() => createReadiness(captures, { google: 'secret-key' })).toThrow('credential values');
  expect(() => createReadiness([{ version: 99 }])).toThrow('provenance');
});

it('never copies credentials into status, handles native AWS and keyless local endpoints', () => {
  const config = { getApiKey: () => 'secret-key', getBaseUrl: () => 'http://user:secret@localhost', getProviderCred: () => ({}) };
  for (const backend of BACKENDS) {
    const status = credentialStatus(backend, config, { AWS_ACCESS_KEY_ID: 'secret', AWS_SECRET_ACCESS_KEY: 'secret' });
    expect(status).toBe('configured');
    expect(JSON.stringify(createReadiness([], { [backend.id]: status }))).not.toContain('secret');
  }
  const missing = { getApiKey: () => undefined, getBaseUrl: () => undefined, getProviderCred: () => ({}) };
  expect(credentialStatus(BACKENDS.find(b => b.id === 'bedrock-native')!, missing, { AWS_ACCESS_KEY_ID: 'partial' })).toBe('missing');
  expect(credentialStatus(BACKENDS.find(b => b.id === 'bedrock-native')!, { ...missing, hasAWSCredentials: () => true }, {})).toBe('configured');
  expect(credentialStatus(BACKENDS.find(b => b.id === 'openai-compat')!, missing, {})).toBe('missing-endpoint');
});
