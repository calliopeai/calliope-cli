import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ChatGPTStore, type Account } from './store.js';
import { ChatGPTAuthError, ISSUER, TOKEN_URL, RESOURCE, type Registration } from './protocol.js';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
export interface Tokens { access_token: string; refresh_token: string; id_token?: string; token_type: string; expires_in: number; scope: string; earliest_refresh_at?: number }
export async function tokenRequest(form: URLSearchParams, signal?: AbortSignal): Promise<Tokens> {
  let response: Response;
  try { response = await fetch(TOKEN_URL, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }); }
  catch { throw new ChatGPTAuthError('ChatGPT token request failed. Retry sign-in or check your connection.'); }
  let body: Record<string, unknown>; try { body = await response.json() as Record<string, unknown>; } catch { throw new ChatGPTAuthError('Invalid ChatGPT token response.'); }
  if (!response.ok) {
    const terminal = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(String(body.error));
    throw new ChatGPTAuthError(terminal ? 'ChatGPT session expired or revoked. Sign in again.' : `ChatGPT token request failed (HTTP ${response.status}).`, terminal ? 'reauthenticate' : undefined);
  }
  if (typeof body.access_token !== 'string' || !body.access_token || typeof body.refresh_token !== 'string' || !body.refresh_token || body.token_type !== 'Bearer' || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || typeof body.scope !== 'string') throw new ChatGPTAuthError('Invalid ChatGPT token response.');
  return body as unknown as Tokens;
}
export async function validateIdentity(token: string, clientId: string, nonce?: string, previous?: Registration, key: JWTVerifyGetKey = jwks) {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub'] });
    if (!payload.sub || nonce !== undefined && payload.nonce !== nonce || previous && payload.sub !== previous.subject) throw Error();
    return { subject: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) };
  } catch { throw new ChatGPTAuthError('ChatGPT identity verification failed. Sign in again.'); }
}
export function applyTokens(account: Account, tokens: Tokens): Account {
  return { ...account, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}), scopes: tokens.scope.split(/\s+/).filter(Boolean),
    expiresAt: Date.now() + tokens.expires_in * 1000, earliestRefreshAt: tokens.earliest_refresh_at ? tokens.earliest_refresh_at * 1000 : undefined };
}
export async function accessToken(store = new ChatGPTStore(), signal?: AbortSignal): Promise<{ token: string; clientId: string }> {
  const selected = store.active();
  if (!selected?.accessToken || !selected.refreshToken || !selected.scopes.includes('chatgpt.tokens.use.direct')) throw new ChatGPTAuthError('ChatGPT plan access is unavailable. Run calliope auth chatgpt login.');
  if ((selected.expiresAt ?? 0) > Date.now() + 60000) return { token: selected.accessToken, clientId: selected.clientId };
  const result = await store.update(async state => {
    if (state.active !== selected.clientId) throw new ChatGPTAuthError('ChatGPT account changed. Retry the request.');
    const a = state.accounts[selected.clientId]!;
    if ((a.expiresAt ?? 0) > Date.now() + 60000) return { token: a.accessToken!, clientId: a.clientId };
    if (a.earliestRefreshAt && a.earliestRefreshAt > Date.now()) throw new ChatGPTAuthError('ChatGPT token cannot refresh yet. Retry later.');
    let tokens: Tokens;
    try { tokens = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken!, resource: RESOURCE }), signal); }
    catch (error) {
      if (!(error instanceof ChatGPTAuthError) || error.code !== 'reauthenticate') throw error;
      state.accounts[a.clientId] = { clientId: a.clientId, subject: a.subject, email: a.email, scopes: [] };
      return { error };
    }
    if (tokens.id_token) await validateIdentity(tokens.id_token, a.clientId, undefined, a);
    state.accounts[a.clientId] = applyTokens(a, tokens);
    if (!state.accounts[a.clientId]!.scopes.includes('chatgpt.tokens.use.direct')) return { error: new ChatGPTAuthError('ChatGPT plan permission was removed. Sign in again.') };
    return { token: tokens.access_token, clientId: a.clientId };
  });
  if ('error' in result) throw result.error;
  return result;
}
export async function logout(store = new ChatGPTStore()): Promise<boolean> {
  return store.update(async state => {
    const a = state.active ? state.accounts[state.active] : undefined;
    if (!a) return true;
    let revoked = !a.refreshToken;
    if (a.refreshToken) {
      try {
        const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        const metadata = await discovery.json() as { issuer: string; revocation_endpoint: string };
        const endpoint = new URL(metadata.revocation_endpoint);
        if (!discovery.ok || metadata.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.username || endpoint.password) throw Error();
        const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }), signal: AbortSignal.timeout(10000) });
        revoked = response.ok;
      } catch { /* Local sign-out still removes every token. */ }
    }
    state.accounts[a.clientId] = { clientId: a.clientId, subject: a.subject, email: a.email, scopes: [] };
    return revoked;
  });
}
