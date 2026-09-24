/**
 * `calliope attach` (#378, #391): the Agent Host Protocol client pieces, driven
 * with a scripted WebSocket-shaped object and a fake fetch. The live path (a
 * real agent host behind JupyterHub) is verified by hand; see the PRs.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AhpConnection, FALLBACK_EXIT, SUPPORTED_VERSIONS, checkInitialize, defaultChatUri,
  follow, isDisabled, preflight, resolveHubHost, runAttach, type ChatSnapshot,
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

describe('attach: confirmations already waiting when it joins (#391)', () => {
  const session = 'claude:/s1';
  const chat = defaultChatUri(session);
  const action = (a: Record<string, unknown>, serverSeq?: number) => ({ jsonrpc: '2.0', method: 'action', params: { channel: chat, serverSeq, action: a } });
  const settle = () => new Promise(r => setImmediate(r));
  const pending = (toolCallId: string, extra: Record<string, unknown> = {}) =>
    ({ kind: 'toolCall', toolCall: { toolCallId, status: 'pending-confirmation', confirmationTitle: `Fetch ${toolCallId}?`, toolInput: `{"url":"https://example.com/${toolCallId}"}`, ...extra } });
  const state = (...responseParts: unknown[]) => ({ activeTurn: { id: 't1', responseParts } }) as ChatSnapshot['state'];
  /** A chat subscribe answer taken at server sequence 7. */
  const snapshot = (...responseParts: unknown[]): Promise<ChatSnapshot> => Promise.resolve({ fromSeq: 7, state: state(...responseParts) });
  const readyAction = (toolCallId: string) => ({ type: 'chat/toolCallReady', turnId: 't1', toolCallId, toolInput: `{"url":"https://example.com/${toolCallId}"}`, confirmationTitle: `Fetch ${toolCallId}?` });
  const confirmed = (toolCallId: string, clientSeq: number) => ({
    jsonrpc: '2.0', method: 'dispatchAction',
    params: { channel: chat, clientSeq, action: { type: 'chat/toolCallConfirmed', turnId: 't1', toolCallId, approved: true, confirmed: 'user-action' } },
  });
  /** An approve() the test answers by hand. Like the terminal prompt, it closes and answers no when withdrawn. */
  function manualApprove() {
    const asked: string[] = [];
    const signals: AbortSignal[] = [];
    const answers: Array<(ok: boolean) => void> = [];
    const approve = (title: string, input: string, signal: AbortSignal) => {
      asked.push(`${title}|${input}`);
      signals.push(signal);
      return new Promise<boolean>(resolve => {
        answers.push(resolve);
        signal.addEventListener('abort', () => resolve(false), { once: true });
      });
    };
    return { asked, signals, approve, answer: async (ok = true) => { answers.shift()!(ok); await settle(); } };
  }

  it('asks about a pending call in the snapshot and confirms it on the snapshot turn', async () => {
    const ws = new FakeSocket();
    const asked: string[] = [];
    const { done } = follow(new AhpConnection(ws), session, {
      write: () => {},
      approve: async (title, input) => { asked.push(`${title}|${input}`); return true; },
      once: true,
    }, snapshot(
      { kind: 'markdown', id: 'p1', content: 'Fetching' },
      { kind: 'toolCall', toolCall: { toolCallId: 'c0', status: 'completed' } },
      pending('c1'),
    ));
    await settle();
    ws.serverSends(action({ type: 'chat/turnComplete', turnId: 't1' }, 9));
    expect(await done).toBe('turnComplete');
    expect(asked).toEqual(['Fetch c1?|{"url":"https://example.com/c1"}']);
    expect(ws.sent).toEqual([confirmed('c1', 1)]);
  });

  it('asks nothing for a call the snapshot shows running, as a host without calliope-vscode#823 reports it', async () => {
    const ws = new FakeSocket();
    const asked: string[] = [];
    follow(new AhpConnection(ws), session, { write: () => {}, approve: async title => { asked.push(title); return true; } },
      snapshot({ kind: 'toolCall', toolCall: { toolCallId: 'c1', status: 'running', confirmed: 'not-needed' } }));
    await settle();
    expect(asked).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  it('read-only reports a waiting call from the snapshot and sends nothing', async () => {
    const ws = new FakeSocket();
    const out: string[] = [];
    follow(new AhpConnection(ws), session, { write: s => out.push(s) }, snapshot(pending('c1')));
    await settle();
    expect(out.join('')).toContain('[waiting for approval elsewhere] Fetch c1?: {"url":"https://example.com/c1"}');
    expect(ws.sent).toEqual([]);
  });

  it('a snapshot call announced again live is asked once', async () => {
    const ws = new FakeSocket();
    const user = manualApprove();
    follow(new AhpConnection(ws), session, { write: () => {}, approve: user.approve }, snapshot(pending('c1')));
    await settle();
    ws.serverSends(action(readyAction('c1'), 8));
    await user.answer(true);
    expect(user.asked).toHaveLength(1);
    expect(ws.sent).toEqual([confirmed('c1', 1)]);
  });

  it('asks about several waiting calls one at a time', async () => {
    const ws = new FakeSocket();
    const user = manualApprove();
    follow(new AhpConnection(ws), session, { write: () => {}, approve: user.approve }, snapshot(pending('c1'), pending('c2')));
    await settle();
    expect(user.asked.map(a => a.split('|')[0])).toEqual(['Fetch c1?']);
    await user.answer(true);
    expect(user.asked.map(a => a.split('|')[0])).toEqual(['Fetch c1?', 'Fetch c2?']);
    await user.answer(false);
    expect(ws.sent.map(m => [m.params.action.toolCallId, m.params.action.approved])).toEqual([['c1', true], ['c2', false]]);
  });

  it('withdraws the prompt for a call another client answers, and never asks about a queued one it answered', async () => {
    const ws = new FakeSocket();
    const out: string[] = [];
    const user = manualApprove();
    follow(new AhpConnection(ws), session, { write: s => out.push(s), approve: user.approve }, snapshot(pending('c1'), pending('c2')));
    await settle();
    // The prompt for c1 is open and c2 is queued behind it; another client answers both.
    ws.serverSends(action({ type: 'chat/toolCallConfirmed', turnId: 't1', toolCallId: 'c1', approved: true, confirmed: 'user-action' }, 8));
    ws.serverSends(action({ type: 'chat/toolCallConfirmed', turnId: 't1', toolCallId: 'c2', approved: false, reason: 'denied' }, 9));
    await settle();
    expect(user.signals.map(s => s.aborted)).toEqual([true]);
    expect(user.asked).toHaveLength(1);
    expect(ws.sent).toEqual([]);
    expect(out.join('')).toContain('[approval no longer needed; nothing sent]');
  });

  it('a call that asks again after it was answered is asked again', async () => {
    const ws = new FakeSocket();
    const user = manualApprove();
    follow(new AhpConnection(ws), session, { write: () => {}, approve: user.approve }, snapshot(pending('c1')));
    await settle();
    await user.answer(true);
    // The host echoes the answer, then the running tool needs a second permission.
    ws.serverSends(action({ type: 'chat/toolCallConfirmed', turnId: 't1', toolCallId: 'c1', approved: true, confirmed: 'user-action' }, 8));
    ws.serverSends(action({ type: 'chat/toolCallReady', turnId: 't1', toolCallId: 'c1', toolInput: 'outside the sandbox', confirmationTitle: 'Run outside the sandbox?' }, 9));
    await settle();
    await user.answer(true);
    expect(user.asked.map(a => a.split('|')[0])).toEqual(['Fetch c1?', 'Run outside the sandbox?']);
    expect(ws.sent).toEqual([confirmed('c1', 1), confirmed('c1', 2)]);
  });

  it('holds actions that arrive before the snapshot and applies them after it', async () => {
    const ws = new FakeSocket();
    const user = manualApprove();
    let answer!: (s: ChatSnapshot) => void;
    follow(new AhpConnection(ws), session, { write: () => {}, approve: user.approve }, new Promise<ChatSnapshot>(r => { answer = r; }));
    // Both come after the snapshot (serverSeq > 7) but reach the client first,
    // as they do when they share a network read with the subscribe answer.
    ws.serverSends(action({ type: 'chat/toolCallConfirmed', turnId: 't1', toolCallId: 'c1', approved: true, confirmed: 'user-action' }, 8));
    ws.serverSends(action(readyAction('c2'), 9));
    await settle();
    expect(user.asked).toEqual([]);
    answer({ fromSeq: 7, state: state(pending('c1')) });
    await settle();
    expect(user.asked.map(a => a.split('|')[0])).toEqual(['Fetch c2?']);
    await user.answer(true);
    expect(ws.sent.map(m => m.params.action.toolCallId)).toEqual(['c2']);
  });

  it('skips a held action the snapshot already includes', async () => {
    const ws = new FakeSocket();
    const user = manualApprove();
    let answer!: (s: ChatSnapshot) => void;
    follow(new AhpConnection(ws), session, { write: () => {}, approve: user.approve }, new Promise<ChatSnapshot>(r => { answer = r; }));
    // serverSeq 6 is at or before the snapshot, which shows the call answered since.
    ws.serverSends(action(readyAction('c1'), 6));
    answer({ fromSeq: 7, state: state({ kind: 'toolCall', toolCall: { toolCallId: 'c1', status: 'running', confirmed: 'user-action' } }) });
    await settle();
    expect(user.asked).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  it('withdraws an open prompt when the turn ends or the connection closes', async () => {
    for (const end of ['turnComplete', 'close'] as const) {
      const ws = new FakeSocket();
      const out: string[] = [];
      const user = manualApprove();
      const { done } = follow(new AhpConnection(ws), session, { write: s => out.push(s), approve: user.approve, once: true }, snapshot(pending('c1')));
      await settle();
      if (end === 'close') {
        ws.emit('close', { code: 1006 });
      } else {
        ws.serverSends(action({ type: 'chat/turnComplete', turnId: 't1' }, 8));
      }
      expect(await done).toBe(end === 'close' ? 'connection closed (1006)' : 'turnComplete');
      await settle();
      expect(user.signals.map(s => s.aborted)).toEqual([true]);
      expect(ws.sent).toEqual([]);
      expect(out.join('')).toContain('[approval no longer needed; nothing sent]');
    }
  });
});

describe('attach: runAttach reads the chat snapshot (#391)', () => {
  const session = 'claude:/s1';
  const chat = defaultChatUri(session);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * A host that answers initialize and both subscribes. It sends the chat
   * subscribe answer, a new approval and the turn's end in one burst, the way
   * frames that share one network read reach Node's WebSocket.
   */
  class FakeHost {
    static last: FakeHost | undefined;
    sent: any[] = [];
    private listeners: Record<string, Array<(ev: any) => void>> = {};
    constructor(readonly url: string) {
      FakeHost.last = this;
      setImmediate(() => this.emit('open', {}));
    }
    addEventListener(type: string, fn: (ev: any) => void) { (this.listeners[type] ??= []).push(fn); }
    emit(type: string, ev: any) { for (const fn of this.listeners[type] ?? []) fn(ev); }
    close() { this.emit('close', { code: 1000 }); }
    private reply(...msgs: unknown[]) { setImmediate(() => { for (const msg of msgs) this.emit('message', { data: JSON.stringify(msg) }); }); }
    send(data: string) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      const action = (serverSeq: number, a: Record<string, unknown>) => ({ jsonrpc: '2.0', method: 'action', params: { channel: chat, serverSeq, action: a } });
      if (msg.method === 'initialize') {
        this.reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '1.0.0' } });
      } else if (msg.method === 'subscribe' && msg.params.channel === chat) {
        this.reply(
          { jsonrpc: '2.0', id: msg.id, result: { snapshot: { resource: chat, fromSeq: 7, state: { turns: [], activeTurn: { id: 't1', responseParts: [
            { kind: 'toolCall', toolCall: { toolCallId: 'c1', status: 'pending-confirmation', confirmationTitle: 'Fetch URL?', toolInput: '{"url":"https://example.com"}' } },
          ] } } } } },
          action(8, { type: 'chat/toolCallReady', turnId: 't1', toolCallId: 'c2', toolInput: '{"url":"https://example.org"}', confirmationTitle: 'Fetch another URL?' }),
          action(9, { type: 'chat/turnComplete', turnId: 't1' }),
        );
      } else if (msg.method === 'subscribe') {
        this.reply({ jsonrpc: '2.0', id: msg.id, result: { snapshot: { resource: msg.params.channel, fromSeq: 7, state: {} } } });
      }
    }
  }

  it('reports the confirmation that was waiting before it joined, and the actions sent right behind the snapshot', async () => {
    vi.stubGlobal('WebSocket', FakeHost);
    vi.stubGlobal('fetch', async () => status(426));
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    const code = await runAttach(['--url', 'ws://host/agent-host/', session, '--read-only', '--once'], {});
    expect(code).toBe(0);
    expect(FakeHost.last!.sent.filter(m => m.method === 'subscribe').map(m => m.params.channel)).toEqual([session, chat]);
    expect(out.join('').match(/\[waiting for approval elsewhere\][^\n]*/g)).toEqual([
      '[waiting for approval elsewhere] Fetch URL?: {"url":"https://example.com"}',
      '[waiting for approval elsewhere] Fetch another URL?: {"url":"https://example.org"}',
    ]);
    expect(out.join('')).toContain('[turn complete]');
  });
});

describe('attach: top-level help', () => {
  it('lists calliope attach', async () => {
    // bin.ts loads env files from cwd and HOME at import; point both at an empty directory.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-attach-help-'));
    const prev = { cwd: process.cwd(), home: process.env.HOME };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.CALLIOPE_NO_AUTORUN = '1';
    try {
      process.chdir(dir);
      process.env.HOME = dir;
      vi.resetModules();
      const { printHelp } = await import('../src/bin.js');
      printHelp();
      expect(log.mock.calls.flat().join('\n')).toMatch(/calliope attach \(--url <ws-url> \| --hub <url> --user <name>\)/);
    } finally {
      log.mockRestore();
      delete process.env.CALLIOPE_NO_AUTORUN;
      process.chdir(prev.cwd);
      process.env.HOME = prev.home;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
