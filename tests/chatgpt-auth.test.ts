import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { prepareAuthorization, ChatGPTStore, validateIdentity, tokenRequest, accessToken, logout, login } from '../src/auth/chatgpt/index.js';
const host = `urn:uuid:${randomUUID()}`;
const redirect = 'http://127.0.0.1:34567/auth/callback';
const account = { clientId: 'oaiapp_test', subject: 'person', scopes: ['chatgpt.tokens.use.direct'], accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: Date.now() + 3600000 };
function callback(attempt: ReturnType<typeof prepareAuthorization>, extra: Record<string, string> = {}) {
  return `${redirect}?${new URLSearchParams({ state: new URL(attempt.url).searchParams.get('state')!, code: 'secret-code', client_id: 'oaiapp_test', ...extra })}`;
}
const dirs: string[] = [];
function store() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-')); dirs.push(d); return new ChatGPTStore(path.join(d, 'private')); }
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
describe('ChatGPT authorization', () => {
  it('creates fresh PKCE and binds the exact redirect and issued client', () => {
    const a = prepareAuthorization(host, redirect), b = prepareAuthorization(host, redirect);
    const p = new URL(a.url).searchParams;
    expect(p.get('state')).not.toBe(new URL(b.url).searchParams.get('state'));
    expect(p.get('nonce')).toBe(a.nonce); expect(p.get('client_id')).toBe('dynamic_agent_client');
    expect(p.get('agent_name_hint')).toBe('Calliope AI CLI');
    const result = a.consume(callback(a));
    expect(result.form.get('client_id')).toBe('oaiapp_test'); expect(result.form.get('redirect_uri')).toBe(redirect);
    expect(createHash('sha256').update(result.form.get('code_verifier')!).digest('base64url')).toBe(p.get('code_challenge'));
    expect(() => a.consume(callback(a))).toThrow('rejected');
  });
  it('reauthorizes an issued client, keeps hints and accepts omitted client_id', () => {
    const a = prepareAuthorization(host, redirect, { ...account, idToken: 'hint', email: 'person@example.test' });
    expect(new URL(a.url).searchParams.has('agent_name_hint')).toBe(false);
    const u = new URL(callback(a)); u.searchParams.delete('client_id');
    expect(a.consume(u.href).clientId).toBe(account.clientId);
  });
  it.each(['http://localhost:34567/auth/callback', 'https://127.0.0.1:34567/auth/callback', 'http://127.0.0.1:34567/callback', `${redirect}?x=y`, `${redirect}#x`, 'http://user@127.0.0.1:34567/auth/callback'])('rejects redirect %s', uri => expect(() => prepareAuthorization(host, uri)).toThrow());
  it.each([{ state: 'wrong' }, { code: '' }, { client_id: '' }, { client_id: 'dynamic_agent_client' }, { error: 'access_denied' }])('rejects malformed or denied callbacks %j', change => { const a = prepareAuthorization(host, redirect); expect(() => a.consume(callback(a, change))).toThrow(); });
  it.each(['&state=x', '#fragment', '&code=duplicate'])('rejects ambiguous callback %s', suffix => { const a = prepareAuthorization(host, redirect); expect(() => a.consume(callback(a) + suffix)).toThrow(); });
  it('rejects a changed issued client', () => { const a = prepareAuthorization(host, redirect, account); expect(() => a.consume(callback(a, { client_id: 'oaiapp_other' }))).toThrow(); });
  it('expires and cancels attempts', () => {
    const a = prepareAuthorization(host, redirect, undefined, 0); expect(() => a.consume(callback(a), 300001)).toThrow();
    const b = prepareAuthorization(host, redirect); b.cancel(); expect(() => b.consume(callback(b))).toThrow();
  });
  it('does not include callback secrets in errors', () => { const a = prepareAuthorization(host, redirect); expect(() => a.consume(callback(a, { state: 'secret-access' }))).toThrow(/^ChatGPT callback rejected/); });
});
describe('identity validation', () => {
  it('requires a signed identity bound to issuer, audience, nonce and selected account', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const key = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test' }] });
    const sign = (claims: Record<string, unknown> = {}) => new SignJWT({ nonce: 'nonce', email: 'person@example.test', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setSubject('person').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    const token = await sign();
    expect(await validateIdentity(token, 'oaiapp_test', 'nonce', account, key)).toEqual({ subject: 'person', email: 'person@example.test' });
    await expect(validateIdentity(token, 'oaiapp_wrong', 'nonce', account, key)).rejects.toThrow('verification');
    await expect(validateIdentity(token, 'oaiapp_test', 'wrong', account, key)).rejects.toThrow('verification');
    await expect(validateIdentity(token, 'oaiapp_test', 'nonce', { ...account, subject: 'other' }, key)).rejects.toThrow('verification');
    await expect(validateIdentity(token.slice(0, -10), 'oaiapp_test', 'nonce', account, key)).rejects.toThrow('verification');
  });
});
describe('protected account state', () => {
  it('persists a stable host and independent registrations atomically', async () => {
    const s = store(); expect(s.read()).toBeUndefined();
    await s.update(state => { state.accounts[account.clientId] = account; state.active = account.clientId; });
    const hostId = s.read()!.hostId;
    await s.update(state => { state.accounts.oaiapp_other = { ...account, clientId: 'oaiapp_other', subject: 'other' }; });
    expect(s.read()!.hostId).toBe(hostId); expect(s.active()).toEqual(account);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(s.directory, 'credentials.json')).mode & 0o777).toBe(0o600);
    expect(await accessToken(s)).toEqual({ token: account.accessToken, clientId: account.clientId });
  });
  it('keeps the original state on a failed update and prevents concurrent writes', async () => {
    const s = store(); await s.update(() => {});
    const original = s.read(); await expect(s.update(() => { throw Error('denied'); })).rejects.toThrow('denied'); expect(s.read()).toEqual(original);
    await s.update(async () => { await expect(s.update(() => {})).rejects.toThrow('busy'); });
  });
  it('rejects corrupt and insecure storage', async () => {
    const s = store(); await s.update(() => {});
    const file = path.join(s.directory, 'credentials.json'); fs.writeFileSync(file, '{}'); expect(() => s.read()).toThrow('unreadable');
    if (process.platform !== 'win32') { fs.chmodSync(file, 0o644); expect(() => s.read()).toThrow('private'); }
  });
  it('refreshes rotating tokens and preserves transient failure state', async () => {
    const s = store(); await s.update(state => { state.active = account.clientId; state.accounts[account.clientId] = { ...account, expiresAt: 1 }; });
    const fetcher = vi.fn().mockRejectedValueOnce(Error('secret-access')).mockResolvedValueOnce(Response.json({ access_token: 'renewed', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })); vi.stubGlobal('fetch', fetcher);
    await expect(accessToken(s)).rejects.toThrow('request failed'); expect(s.active()?.refreshToken).toBe('secret-refresh');
    expect((await accessToken(s)).token).toBe('renewed'); expect(s.active()?.refreshToken).toBe('rotated');
    const form = fetcher.mock.calls[1]![1].body as URLSearchParams; expect(form.get('scope')).toBeNull(); expect(form.get('client_id')).toBe(account.clientId);
  });
  it('refuses missing plan permission before networking', async () => {
    const s = store(); await s.update(state => { state.active = account.clientId; state.accounts[account.clientId] = { ...account, scopes: [] }; });
    const f = vi.fn(); vi.stubGlobal('fetch', f); await expect(accessToken(s)).rejects.toThrow('unavailable'); expect(f).not.toHaveBeenCalled();
  });
  it('signs out locally even if revocation fails, retaining registration and host', async () => {
    const s = store(); await s.update(state => { state.active = account.clientId; state.accounts[account.clientId] = { ...account, idToken: 'secret-id' }; });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('network')));
    expect(await logout(s)).toBe(false); expect(s.active()).toEqual({ clientId: account.clientId, subject: account.subject, scopes: [] });
  });
  it('uses a verified same-origin revocation endpoint', async () => {
    const s = store(); await s.update(state => { state.active = account.clientId; state.accounts[account.clientId] = account; });
    const f = vi.fn().mockResolvedValueOnce(Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://evil.test/revoke' })); vi.stubGlobal('fetch', f);
    expect(await logout(s)).toBe(false); expect(f).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { error: 'invalid_grant' }, { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: -1, scope: 's' }])('redacts bad token responses %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status: 'error' in body ? 400 : 200 })));
    await expect(tokenRequest(new URLSearchParams())).rejects.toThrow(/ChatGPT/);
  });
  it('binds the listener before browser launch and closes it after denied consent', async () => {
    const s = store(); let callbackUrl = '';
    await expect(login(s, undefined, undefined, async url => {
      const auth = new URL(url); callbackUrl = auth.searchParams.get('redirect_uri')!;
      const response = await fetch(`${callbackUrl}?${new URLSearchParams({ state: auth.searchParams.get('state')!, error: 'access_denied' })}`);
      expect(response.status).toBe(400);
    })).rejects.toThrow('denied');
    expect(s.read()?.hostId).toMatch(/^urn:uuid:/); expect(s.active()).toBeUndefined(); await expect(fetch(callbackUrl)).rejects.toThrow();
  });
  it('handles cancellation and browser-launch failure without replacing the account', async () => {
    const s = store(); await s.update(state => { state.active = account.clientId; state.accounts[account.clientId] = account; });
    const controller = new AbortController(); controller.abort();
    await expect(login(s, undefined, controller.signal, async () => {})).rejects.toThrow('cancelled');
    await expect(login(s, undefined, undefined, async () => { throw Error('browser unavailable'); })).rejects.toThrow('browser');
    expect(s.active()).toEqual(account);
  });
});
it('clears revoked refresh credentials while retaining the registration', async () => {
  const s = store(); await s.update(state => { state.active = account.clientId; state.accounts[account.clientId] = { ...account, expiresAt: 1 }; });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 })));
  await expect(accessToken(s)).rejects.toThrow('expired or revoked'); expect(s.active()?.accessToken).toBeUndefined(); expect(s.active()?.clientId).toBe(account.clientId);
});
it('persists rotated credentials even when plan permission is withdrawn', async () => {
  const s = store(); await s.update(state => { state.active = account.clientId; state.accounts[account.clientId] = { ...account, expiresAt: 1 }; });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ access_token: 'new-access', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600, scope: 'openid' })));
  await expect(accessToken(s)).rejects.toThrow('permission was removed'); expect(s.active()?.refreshToken).toBe('rotated'); expect(s.active()?.scopes).toEqual(['openid']);
});
it('completes loopback login with verified JWKS and atomically activates the account', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'login-key', alg: 'RS256', use: 'sig' };
  const realFetch = globalThis.fetch;
  let nonce = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    if (String(url).endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (String(url).endsWith('/oauth/token')) {
      const body = init?.body as URLSearchParams; expect(body.get('client_id')).toBe('oaiapp_login'); expect(body.get('code')).toBe('authorization');
      const token = await new SignJWT({ nonce, email: 'verified@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'login-key' }).setIssuer('https://auth.openai.com').setAudience('oaiapp_login').setSubject('verified-person').setIssuedAt().setExpirationTime('5m').sign(privateKey);
      return Response.json({ access_token: 'access', refresh_token: 'refresh', id_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' });
    }
    throw Error('Unexpected network');
  }));
  const s = store();
  await login(s, undefined, undefined, async address => {
    const url = new URL(address); nonce = url.searchParams.get('nonce')!;
    const redirect = url.searchParams.get('redirect_uri')!;
    const irrelevant = await fetch(redirect.replace('/auth/callback', '/favicon.ico')); expect(irrelevant.status).toBe(404);
    const callback = await fetch(`${redirect}?${new URLSearchParams({ state: url.searchParams.get('state')!, code: 'authorization', client_id: 'oaiapp_login' })}`); expect(callback.status).toBe(200);
  });
  expect(s.active()).toMatchObject({ clientId: 'oaiapp_login', subject: 'verified-person', email: 'verified@example.test', accessToken: 'access' });
});
