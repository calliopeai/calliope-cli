import * as config from '../config.js';
import { PROVIDER_BASE_URLS } from '../providers/compat.js';
import { hasAWSCredentials } from '../providers/bedrock.js';
import { healthDigest } from './store.js';
import type { HealthProvider, HealthTarget } from './types.js';

export function providerTarget(provider: HealthProvider): HealthTarget {
  if (!config.getProviderNames().includes(provider)) throw new Error('Unknown or retired provider');
  const credential = config.getProviderCred(provider);
  let endpoint: string, protocol: string, credentials: HealthTarget['credentials'];
  if (provider === 'anthropic') { endpoint = 'https://api.anthropic.com/v1'; protocol = 'anthropic-messages'; }
  else if (provider === 'google') { endpoint = 'https://generativelanguage.googleapis.com/v1beta'; protocol = 'google-genai'; }
  else if (provider === 'openai') { endpoint = 'https://api.openai.com/v1'; protocol = 'openai-chat-and-responses'; }
  else if (provider === 'bedrock' && !credential.baseUrl) {
    endpoint = `https://bedrock-runtime.${credential.region || 'us-east-1'}.amazonaws.com`; protocol = 'bedrock-converse';
  } else {
    endpoint = config.getBaseUrl(provider) || PROVIDER_BASE_URLS[provider] || '';
    protocol = provider === 'ollama' ? 'ollama' : 'openai-chat';
  }
  if (provider === 'bedrock' && !credential.baseUrl) credentials = hasAWSCredentials() || !!credential.profile ? 'configured' : 'missing';
  else if (['ollama', 'litellm', 'openai-compat', 'bedrock'].includes(provider)) credentials = !endpoint ? 'missing' : credential.apiKey ? 'configured' : 'not-required';
  else credentials = credential.apiKey ? 'configured' : 'missing';
  let display = 'not-configured', identity = endpoint;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      // Userinfo, query strings, fragments and arbitrary path segments may contain credentials.
      identity = url.origin + url.pathname;
      display = url.origin + (['', '/', '/v1', '/api/v1', '/v1beta'].includes(url.pathname) ? url.pathname : '/[configured-path]');
    } catch { display = 'invalid-endpoint'; credentials = 'missing'; }
  }
  return { provider, endpoint: display, protocol, credentials, key: healthDigest({ provider, endpoint: identity, protocol, profile: provider === 'bedrock' ? credential.profile ?? 'default' : '' }) };
}
