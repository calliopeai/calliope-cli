/** Offline release evidence inventory. Unknown or unavailable never means pass. */
import { BACKENDS } from './contract.mjs';
import { validateCapture, missingCaptures } from './captures.mjs';

export const REQUIRED_CHECKS = [
  'text-json', 'text-stream', 'tool-json', 'tool-stream', 'cancellation',
  'provider-error', 'usage', 'system-instructions', 'tool-result-replay',
];

/** Accept only credential presence, never credential values or upstream errors. */
export function credentialStatus(backend, config, env = process.env) {
  if (backend.id === 'bedrock-native') {
    return Boolean((env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
      env.AWS_PROFILE || config.getProviderCred('bedrock').profile || config.hasAWSCredentials?.()) ? 'configured' : 'missing';
  }
  if (['ollama', 'litellm', 'bedrock-compat', 'openai-compat'].includes(backend.id)) {
    return config.getBaseUrl(backend.provider) ? 'configured' : 'missing-endpoint';
  }
  return config.getApiKey(backend.provider) ? 'configured' : 'missing';
}

export function createReadiness(captures, availability = {}, now = new Date()) {
  captures.forEach(validateCapture);
  const adapters = BACKENDS.map(backend => {
    const evidence = captures.filter(capture => capture.backend === backend.id);
    const credentials = availability[backend.id] ?? 'not-inspected';
    if (!['configured', 'missing', 'missing-endpoint', 'not-inspected'].includes(credentials)) {
      throw new Error('Invalid credential status; credential values must never enter the ledger');
    }
    const absent = credentials === 'missing' || credentials === 'missing-endpoint' ? 'unavailable' : 'missing';
    const checks = Object.fromEntries(REQUIRED_CHECKS.map(check => [check, absent]));
    for (const capture of evidence) checks[`${capture.scenario}-${capture.stream ? 'stream' : 'json'}`] = 'captured';
    // Usage is independently observed in all four modes, not inferred from SDK support.
    if (['text', 'tool'].every(scenario => [false, true].every(stream => evidence.some(capture =>
      capture.scenario === scenario && capture.stream === stream && validUsage(capture.expected.usage))))) {
      checks.usage = 'captured';
    } else if (evidence.some(capture => !validUsage(capture.expected.usage))) {
      checks.usage = 'incomplete';
    }
    return { id: backend.id, provider: backend.provider, protocol: backend.protocol, credentials, checks,
      lastCapturedAt: evidence.map(c => c.provenance.capturedAt).sort().at(-1) ?? null };
  });
  const missing = missingCaptures(captures);
  return {
    version: 1, generatedAt: now.toISOString(),
    evidence: 'historical real-wire captures; credential presence does not establish current access',
    adapterCount: BACKENDS.length, requiredWireCombinations: BACKENDS.length * 4,
    capturedWireCombinations: BACKENDS.length * 4 - missing.length,
    wireGateReady: missing.length === 0,
    productGateReady: adapters.every(adapter => Object.values(adapter.checks).every(status => status === 'captured')),
    missingWireCombinations: missing, adapters,
    retired: [{ provider: 'ai21', status: 'retired', includedInReleaseGate: false }],
  };
}

function validUsage(usage) {
  return usage && [usage.inputTokens, usage.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0);
}
