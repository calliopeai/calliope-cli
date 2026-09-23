/**
 * `calliope attach` (#378): the Agent Host Protocol client pieces, driven with
 * a scripted WebSocket-shaped object and a fake fetch. The live path (a real
 * agent host behind JupyterHub) is verified by hand; see the PR.
 */

import { describe, it, expect } from 'vitest';
import {
  AhpConnection, FALLBACK_EXIT, SUPPORTED_VERSIONS, checkInitialize, defaultChatUri,
  follow, isDisabled, preflight, resolveHubHost, runAttach,
} from '../src/attach.js';

class FakeSocket {
  sent: any[] = [];
  private listeners: Record<string, Array<(ev: any) => void>> = {};
  addEventListener(type: string, fn: (ev: any) => void) { (this.listeners[type] ??= []).push(fn); }
  emit(type: string, ev: any) { for (const fn of this.listeners[type] ?? []) fn(ev); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close', { code: 1000 }); }
  serverSends(msg: unknown) { this.emit('message', { data: JSON.stringify(msg) }); }
}

const status = (s: number, location = '') => ({ status: s, ok: s >= 200 && s < 300, headers: new Headers(location ? { location } : {}), json: async () => ({}) }) as unknown as Response;

describe('attach: contract pieces', () => {
  it('honours the kill switch values and nothing else', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'disabled']) expect(isDisabled({ CALLIOPE_AHP: v })).toBe(true);
    for (const v of [undefined, '', 'on', '1']) expect(isDisabled({ CALLIOPE_AHP: v })).toBe(false);
  });

  it('builds the default chat channel the host uses', () => {
    const session = 'claude:/kr1-1790129715591';
    const uri = defaultChatUri(session);
    expect(uri.startsWith('ahp-chat://default/')).toBe(true);
    expect(Buffer.from(uri.slice('ahp-chat://default/'.length), 'base64url').toString()).toBe(session);
    expect(uri).not.toMatch(/[+/=]$/);
  });

  it('preflight: 426 means reachable, 401/403 auth, anything else unreachable', async () => {
    expect(await preflight('ws://h/a/', {}, async () => status(426))).toBeUndefined();
    expect((await preflight('ws://h/a/', {}, async () => status(403)))?.reason).toBe('auth');
    expect((await preflight('ws://h/a/', {}, async () => status(401)))?.reason).toBe('auth');
    expect((await preflight('ws://h/a/', {}, async () => status(302, '/hub/login?next=%2Fuser%2Fu%2F')))?.reason).toBe('auth');
    expect((await preflight('ws://h/a/', {}, async () => status(302, '/somewhere/else')))?.reason).toBe('unreachable');
    expect((await preflight('ws://h/a/', {}, async () => status(503)))?.reason).toBe('unreachable');
    expect((await preflight('ws://h/a/', {}, async () => { throw new Error('ECONNREFUSED'); }))?.reason).toBe('unreachable');
  });

  it('preflight asks over http(s) with the credential', async () => {
    let seen: { url?: string; auth?: string } = {};
    await preflight('wss://hub/user/u/agent-host/', { Authorization: 'token t' }, async (url, init) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>).Authorization };
      return status(426);
    });
    expect(seen).toEqual({ url: 'https://hub/user/u/agent-host/', auth: 'token t' });
  });

  it('initialize: a supported version is fine; -32005 or a foreign version is version', () => {
    expect(checkInitialize({ result: { protocolVersion: '1.0.0' } })).toBeUndefined();
    expect(checkInitialize({ error: { code: -32005, message: 'no' } })?.reason).toBe('version');
    expect(checkInitialize({ result: { protocolVersion: '9.9.9' } })?.reason).toBe('version');
    expect(checkInitialize({ error: { code: -32000, message: 'boom' } })?.reason).toBe('unreachable');
    expect(SUPPORTED_VERSIONS).toContain('1.0.0');
  });

  it('resolveHubHost: ready server resolves; refused spawn is unentitled; bad token is auth', async () => {
    const ready = async () => ({ ok: true, status: 200, json: async () => ({ servers: { agenthost: { ready: true, url: '/user/u/agenthost/' } } }) }) as unknown as Response;
    expect(await resolveHubHost({ hubUrl: 'https://hub', user: 'u', token: 't', fetchImpl: ready as typeof fetch }))
      .toEqual({ ok: true, url: 'wss://hub/user/u/agenthost/agent-host/' });

    const calls: string[] = [];
    const refused = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
      return init?.method === 'POST' ? status(403) : ({ ok: true, status: 200, json: async () => ({ servers: {} }) }) as unknown as Response;
    }) as typeof fetch;
    expect((await resolveHubHost({ hubUrl: 'https://hub', user: 'u', token: 't', fetchImpl: refused }) as { reason: string }).reason).toBe('unentitled');
    expect(calls).toEqual(['GET /hub/api/users/u', 'POST /hub/api/users/u/servers/agenthost']);

    const badToken = (async () => status(403)) as typeof fetch;
    expect((await resolveHubHost({ hubUrl: 'https://hub', user: 'u', token: 'x', fetchImpl: badToken }) as { reason: string }).reason).toBe('auth');
  });

  it('runAttach with the kill switch falls back without touching the network', async () => {
    expect(await runAttach(['--url', 'ws://127.0.0.1:1/'], { CALLIOPE_AHP: 'off' })).toBe(FALLBACK_EXIT);
  });
});

describe('attach: following a session', () => {
  const session = 'claude:/s1';
  const chat = defaultChatUri(session);
  const action = (a: Record<string, unknown>, channel = chat) => ({ jsonrpc: '2.0', method: 'action', params: { channel, action: a } });

  it('streams deltas, approves a pending tool call, and ends after the turn with once', async () => {
    const ws = new FakeSocket();
    const conn = new AhpConnection(ws);
    const out: string[] = [];
    const asked: string[] = [];
    const { done } = follow(conn, session, {
      write: s => out.push(s),
      approve: async (title, input) => { asked.push(`${title}|${input}`); return true; },
      once: true,
    });
    ws.serverSends(action({ type: 'chat/turnStarted', turnId: 't1', message: { text: 'do it' } }));
    ws.serverSends(action({ type: 'chat/delta', turnId: 't1', partId: 'p', content: 'Hello' }));
    ws.serverSends(action({ type: 'chat/toolCallReady', turnId: 't1', toolCallId: 'c1', toolInput: 'touch x', confirmationTitle: { markdown: 'Run in terminal' } }));
    await new Promise(r => setImmediate(r));
    ws.serverSends(action({ type: 'chat/delta', turnId: 't1', partId: 'p', content: 'ignored' }, 'ahp-chat://default/other'));
    ws.serverSends(action({ type: 'chat/turnComplete', turnId: 't1' }));
    expect(await done).toBe('turnComplete');
    expect(asked).toEqual(['Run in terminal|touch x']);
    expect(ws.sent).toEqual([{
      jsonrpc: '2.0', method: 'dispatchAction',
      params: { channel: chat, clientSeq: 1, action: { type: 'chat/toolCallConfirmed', turnId: 't1', toolCallId: 'c1', approved: true, confirmed: 'user-action' } },
    }]);
    expect(out.join('')).toContain('Hello');
    expect(out.join('')).not.toContain('ignored');
  });

  it('a denial is sent as approved: false', async () => {
    const ws = new FakeSocket();
    const { done } = follow(new AhpConnection(ws), session, { write: () => {}, approve: async () => false, once: true });
    ws.serverSends(action({ type: 'chat/toolCallReady', turnId: 't1', toolCallId: 'c1', toolInput: 'rm -rf /', confirmationTitle: 'Run' }));
    await new Promise(r => setImmediate(r));
    ws.serverSends(action({ type: 'chat/turnComplete', turnId: 't1' }));
    await done;
    expect(ws.sent[0].params.action).toMatchObject({ type: 'chat/toolCallConfirmed', approved: false, toolCallId: 'c1' });
  });

  it('read-only never answers a confirmation', async () => {
    const ws = new FakeSocket();
    const out: string[] = [];
    const { done } = follow(new AhpConnection(ws), session, { write: s => out.push(s), once: true });
    ws.serverSends(action({ type: 'chat/toolCallReady', turnId: 't1', toolCallId: 'c1', toolInput: 'x', confirmationTitle: 'Run' }));
    ws.serverSends(action({ type: 'chat/turnComplete', turnId: 't1' }));
    await done;
    expect(ws.sent).toEqual([]);
    expect(out.join('')).toContain('waiting for approval elsewhere');
  });

  it('without once, following ends only when the connection closes', async () => {
    const ws = new FakeSocket();
    const { done } = follow(new AhpConnection(ws), session, { write: () => {} });
    ws.serverSends(action({ type: 'chat/turnComplete', turnId: 't1' }));
    let settled = false;
    done.then(() => { settled = true; });
    await new Promise(r => setImmediate(r));
    expect(settled).toBe(false);
    ws.emit('close', { code: 1006 });
    expect(await done).toContain('1006');
  });

  it('calls resolve by id and actions route to listeners', async () => {
    const ws = new FakeSocket();
    const conn = new AhpConnection(ws);
    const p = conn.call('listSessions', { channel: 'ahp-root://' });
    expect(ws.sent[0]).toMatchObject({ id: 1, method: 'listSessions' });
    ws.serverSends({ jsonrpc: '2.0', id: 1, result: { items: [] } });
    expect((await p).result).toEqual({ items: [] });
  });
});
