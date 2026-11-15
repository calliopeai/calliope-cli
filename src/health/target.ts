import { chatGPTSelected, chatGPTAccountKey } from '../providers/chatgpt.js';
import * as config from '../config.js';
import { PROVIDER_BASE_URLS } from '../providers/compat.js';
import { hasAWSCredentials } from '../providers/bedrock.js';
import { healthDigest } from './store.js';
import type { HealthProvider, HealthTarget } from './types.js';

function configuredEndpoint(provider: HealthProvider): { endpoint: string; protocol: string } {
  const credential = config.getProviderCred(provider);
  if (provider === 'anthropic') return { endpoint: credential.baseUrl || 'https://api.anthropic.com/v1', protocol: 'anthropic-messages' };
  if (provider === 'google') return { endpoint: credential.baseUrl || 'https://generativelanguage.googleapis.com/v1beta', protocol: 'google-genai' };
  if (provider === 'openai') return { endpoint: credential.baseUrl || 'https://api.openai.com/v1', protocol: 'openai-chat-and-responses' };
  if (provider === 'bedrock' && !credential.baseUrl) return { endpoint: `https://bedrock-runtime.${credential.region || 'us-east-1'}.amazonaws.com`, protocol: 'bedrock-converse' };
  return { endpoint: config.getBaseUrl(provider) || PROVIDER_BASE_URLS[provider] || '', protocol: provider === 'ollama' ? 'ollama' : 'openai-chat' };
}

/**
 * Exact endpoint identity (origin + pathname) used to match declared private targets.
 * Null for invalid URLs, non-http(s) schemes, and URLs carrying a query string or
 * userinfo, so those never match a declaration.
 */
export function endpointIdentity(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.username || url.password) return null;
    return url.origin + url.pathname;
  } catch { return null; }
}

/**
 * Whether the provider's live endpoint was declared private by the user in
 * `routing.privateTargets`. Read from config only; nothing is inferred from the host.
 */
export function isDeclaredPrivate(provider: HealthProvider): boolean {
  const live = endpointIdentity(chatGPTSelected() && provider === 'openai' ? 'https://api.openai.com/v1' : configuredEndpoint(provider).endpoint);
  if (live === null) return false;
  const declared = config.get('routing')?.privateTargets;
  return Array.isArray(declared) && declared.some(entry => entry?.provider === provider && typeof entry.endpoint === 'string' && endpointIdentity(entry.endpoint) === live);
}

export function providerTarget(provider: HealthProvider): HealthTarget {
  if (!config.getProviderNames().includes(provider)) throw new Error('Unknown or retired provider');
  const credential = config.getProviderCred(provider);
  if (provider === 'openai' && chatGPTSelected()) {
    const account = chatGPTAccountKey();
    return { provider, endpoint: 'https://api.openai.com/v1', protocol: 'chatgpt-responses', credentials: account === 'signed-out' ? 'missing' : 'configured', key: healthDigest({ provider, protocol: 'chatgpt-responses', account }) };
  }
  let credentials: HealthTarget['credentials'];
  const { endpoint, protocol } = configuredEndpoint(provider);
  if (provider === 'bedrock' && !credential.baseUrl) credentials = hasAWSCredentials() || !!credential.profile ? 'configured' : 'missing';
  else if (['ollama', 'openai-compat', 'bedrock'].includes(provider)) credentials = !endpoint ? 'missing' : credential.apiKey ? 'configured' : 'not-required';
  else credentials = credential.apiKey ? 'configured' : 'missing';
  let display = 'not-configured', identity = endpoint;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      // Sensitive URL components belong only in the digest; fragments never reach the server.
      identity = url.origin + url.pathname;
      if(url.search||url.username||url.password)identity=JSON.stringify({endpoint:identity,query:url.search,user:url.username,password:url.password});
      display = url.origin + (['', '/', '/v1', '/api/v1', '/v1beta'].includes(url.pathname) ? url.pathname : '/[configured-path]');
    } catch { display = 'invalid-endpoint'; credentials = 'missing'; }
  }
  return { provider, endpoint: display, protocol, credentials, key: healthDigest({ provider, endpoint: identity, protocol, profile: provider === 'bedrock' ? credential.profile ?? 'default' : '' }) };
}
