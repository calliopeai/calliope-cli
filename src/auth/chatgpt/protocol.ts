import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export class ChatGPTAuthError extends Error { constructor(message: string, readonly code?: 'reauthenticate') { super(message); this.name = 'ChatGPTAuthError'; } }
const fail = () => new ChatGPTAuthError('ChatGPT callback rejected. Start a new sign-in.');
export interface Registration { clientId: string; subject: string; email?: string; idToken?: string }
export function prepareAuthorization(hostId: string, redirectUri: string, registration?: Registration, now = Date.now()) {
  const uri = new URL(redirectUri);
  if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || uri.pathname !== '/auth/callback' || !uri.port || uri.search || uri.hash || uri.username || uri.password) throw fail();
  if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(hostId)) throw new ChatGPTAuthError('Invalid ChatGPT host identity.');
  if (registration && !/^oaiapp_[A-Za-z0-9_-]+$/.test(registration.clientId)) throw fail();
  const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ client_id: registration?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
    response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  if (!registration) params.set('agent_name_hint', 'Calliope AI CLI');
  else { if (registration.idToken) params.set('id_token_hint', registration.idToken); if (registration.email) params.set('login_hint', registration.email); }
  let consumed = false;
  return {
    url: `${ISSUER}/api/accounts/authorize?${params}`, nonce,
    cancel() { consumed = true; },
    consume(callback: string, at = Date.now()) {
      if (consumed) throw fail();
      consumed = true;
      if (at < now || at - now > 300000) throw fail();
      let url: URL; try { url = new URL(callback); } catch { throw fail(); }
      if (url.origin !== uri.origin || url.pathname !== uri.pathname || url.hash || url.username || url.password) throw fail();
      for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw fail();
      const received = Buffer.from(url.searchParams.get('state') ?? '');
      if (received.length !== state.length || !timingSafeEqual(received, Buffer.from(state))) throw fail();
      if (url.searchParams.has('error')) throw new ChatGPTAuthError('ChatGPT sign-in was denied or failed.');
      const clientId = url.searchParams.get('client_id') ?? registration?.clientId;
      const code = url.searchParams.get('code');
      if (!code || !clientId || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) || registration && clientId !== registration.clientId) throw fail();
      return { clientId, form: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code,
        code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }) };
    },
  };
}
