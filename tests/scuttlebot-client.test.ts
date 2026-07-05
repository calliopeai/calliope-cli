/**
 * Tests for src/scuttlebot/client.ts — the orchestration layer.
 *
 * We mock at the module seams rather than the socket: the IRC client, the HTTP
 * client and the channel-config resolver are all replaced with fakes that
 * record calls and expose the wired-up envelope / instruction handlers. `node:fs`
 * is stubbed so the ~/.config/scuttlebot-relay.env fallback is always empty,
 * keeping the config resolution deterministic across machines.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Fakes (hoisted so vi.mock factories can reference them) ─────────────
const H = vi.hoisted(() => {
  const irc = { instances: [] as any[], connectImpl: null as null | (() => Promise<void>), connected: true };

  class FakeIRC {
    opts: any;
    envelopeHandlers: Array<(env: any, channel: string) => void> = [];
    instructionHandlers: Array<(text: string, from: string, channel: string) => void> = [];
    sends: Array<{ method: string; channel: string; arg: any }> = [];
    _connected = false;
    constructor(opts: any) {
      this.opts = opts;
      irc.instances.push(this);
    }
    onEnvelope(h: (env: any, channel: string) => void) {
      this.envelopeHandlers.push(h);
    }
    onInstruction(h: (text: string, from: string, channel: string) => void) {
      this.instructionHandlers.push(h);
    }
    async connect() {
      if (irc.connectImpl) await irc.connectImpl();
      this._connected = irc.connected;
    }
    sendEnvelope(channel: string, env: any) {
      this.sends.push({ method: 'sendEnvelope', channel, arg: env });
    }
    sendRaw(channel: string, text: string) {
      this.sends.push({ method: 'sendRaw', channel, arg: text });
    }
    async disconnect() {
      this._connected = false;
    }
    isConnected() {
      return this._connected;
    }
    emitEnvelope(env: any, channel: string) {
      for (const h of this.envelopeHandlers) h(env, channel);
    }
    emitInstruction(text: string, from: string, channel: string) {
      for (const h of this.instructionHandlers) h(text, from, channel);
    }
  }

  const http = { instances: [] as any[], registerImpl: null as null | ((...a: any[]) => any) };

  class FakeHTTP {
    config: any;
    calls: Array<{ method: string; args: any[] }> = [];
    constructor(config: any) {
      this.config = config;
      http.instances.push(this);
    }
    async register(nick: string, type?: string, channels?: string[]) {
      this.calls.push({ method: 'register', args: [nick, type, channels] });
      if (http.registerImpl) return http.registerImpl(nick, type, channels);
      return { nick: `${nick}-reg`, passphrase: 'pp' };
    }
    async deleteAgent(nick: string) {
      this.calls.push({ method: 'deleteAgent', args: [nick] });
    }
    async touchPresence(channel: string, nick: string) {
      this.calls.push({ method: 'touchPresence', args: [channel, nick] });
    }
    async healthCheck() {
      return true;
    }
  }

  const cfg = {
    resolved: {
      channel: 'general',
      channels: ['general'] as string[],
      url: undefined as string | undefined,
      ircAddr: undefined as string | undefined,
      tls: undefined as boolean | undefined,
      nick: undefined as string | undefined,
    },
  };

  return { irc, FakeIRC, http, FakeHTTP, cfg };
});

vi.mock('../src/scuttlebot/irc-client.js', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, ScuttlebotIRCClient: H.FakeIRC };
});
vi.mock('../src/scuttlebot/http-client.js', () => ({ ScuttlebotHTTPClient: H.FakeHTTP }));
vi.mock('../src/scuttlebot/config.js', () => ({
  resolveChannelConfig: (_cwd: string, _channel?: string, _channels?: string) => H.cfg.resolved,
}));
vi.mock('node:fs', () => {
  const readFileSync = () => {
    throw new Error('ENOENT');
  };
  return { readFileSync, default: { readFileSync } };
});

import { ScuttlebotClient } from '../src/scuttlebot/client.js';

// ── Env management ──────────────────────────────────────────────────────
const ENV_KEYS = [
  'SCUTTLEBOT_PASSPHRASE',
  'SCUTTLEBOT_TOKEN',
  'SCUTTLEBOT_URL',
  'SCUTTLEBOT_CHANNEL',
  'SCUTTLEBOT_CHANNELS',
  'SCUTTLEBOT_IRC_ADDR',
  'SCUTTLEBOT_NICK',
];
let savedEnv: Record<string, string | undefined> = {};

const lastIrc = () => H.irc.instances[H.irc.instances.length - 1] as InstanceType<typeof H.FakeIRC>;
const lastHttp = () => H.http.instances[H.http.instances.length - 1] as InstanceType<typeof H.FakeHTTP>;

beforeEach(() => {
  vi.useFakeTimers();
  H.irc.instances.length = 0;
  H.irc.connectImpl = null;
  H.irc.connected = true;
  H.http.instances.length = 0;
  H.http.registerImpl = null;
  H.cfg.resolved = { channel: 'general', channels: ['general'], url: undefined, ircAddr: undefined, tls: undefined, nick: undefined };

  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// initialize
// ═══════════════════════════════════════════════════════════════════════

describe('initialize', () => {
  it('returns false when neither passphrase nor token is configured', async () => {
    const c = new ScuttlebotClient();
    await expect(c.initialize('sess', '/tmp/proj')).resolves.toBe(false);
    expect(c.isEnabled()).toBe(false);
    expect(H.irc.instances).toHaveLength(0);
  });

  it('connects in pre-registered mode using the configured nick', async () => {
    process.env.SCUTTLEBOT_PASSPHRASE = 'pass-abc';
    process.env.SCUTTLEBOT_NICK = 'calliope';
    const c = new ScuttlebotClient();

    const ok = await c.initialize('sess', '/tmp/proj');

    expect(ok).toBe(true);
    expect(c.isEnabled()).toBe(true);
    const irc = lastIrc();
    expect(irc.opts.nick).toBe('calliope');
    expect(irc.opts.passphrase).toBe('pass-abc');
    expect(irc.opts.channels).toEqual(['#general']);
    // No url+token, so no HTTP client for presence.
    expect(H.http.instances).toHaveLength(0);
    // Announces presence with an agent.hello envelope.
    const hello = irc.sends.find((s) => s.method === 'sendEnvelope');
    expect(hello?.arg.type).toBe('agent.hello');
    expect(hello?.arg.from).toBe('calliope');
  });

  it('defaults the nick to "calliope" when nothing else provides one', async () => {
    process.env.SCUTTLEBOT_PASSPHRASE = 'pass-abc';
    const c = new ScuttlebotClient();
    await c.initialize('sess', '/tmp/proj');
    expect(lastIrc().opts.nick).toBe('calliope');
  });

  it('creates an HTTP presence client in pre-registered mode when url+token are set', async () => {
    process.env.SCUTTLEBOT_PASSPHRASE = 'pass-abc';
    process.env.SCUTTLEBOT_NICK = 'calliope';
    process.env.SCUTTLEBOT_URL = 'http://relay';
    process.env.SCUTTLEBOT_TOKEN = 'tok';
    const c = new ScuttlebotClient();

    await c.initialize('sess', '/tmp/proj');

    const http = lastHttp();
    expect(http.calls.some((call) => call.method === 'touchPresence')).toBe(true);

    // Heartbeat: advancing 60s issues another presence touch.
    const before = http.calls.filter((call) => call.method === 'touchPresence').length;
    await vi.advanceTimersByTimeAsync(60_000);
    const after = http.calls.filter((call) => call.method === 'touchPresence').length;
    expect(after).toBeGreaterThan(before);

    await c.disconnect();
  });

  it('registers dynamically via HTTP when a token (but no passphrase) is set', async () => {
    process.env.SCUTTLEBOT_TOKEN = 'tok';
    process.env.SCUTTLEBOT_URL = 'http://relay';
    const c = new ScuttlebotClient();

    const ok = await c.initialize('sess', '/tmp/My Project!');

    expect(ok).toBe(true);
    const http = lastHttp();
    const reg = http.calls.find((call) => call.method === 'register');
    expect(reg).toBeDefined();
    // Session nick: calliope-<sanitized-basename>-<8 hex>
    expect(reg!.args[0]).toMatch(/^calliope-My-Project-[0-9a-f]{8}$/);
    expect(reg!.args[1]).toBe('worker');
    // IRC uses the credentials returned by register().
    expect(lastIrc().opts.nick).toBe(`${reg!.args[0]}-reg`);
  });

  it('uses SCUTTLEBOT_NICK verbatim (sanitized) in dynamic mode', async () => {
    process.env.SCUTTLEBOT_TOKEN = 'tok';
    process.env.SCUTTLEBOT_URL = 'http://relay';
    process.env.SCUTTLEBOT_NICK = 'my bot!';
    const c = new ScuttlebotClient();

    await c.initialize('sess', '/tmp/proj');
    const reg = lastHttp().calls.find((call) => call.method === 'register')!;
    expect(reg.args[0]).toBe('my-bot');
  });

  it('returns false in dynamic mode when the URL is missing', async () => {
    process.env.SCUTTLEBOT_TOKEN = 'tok'; // token but no url
    const c = new ScuttlebotClient();

    await expect(c.initialize('sess', '/tmp/proj')).resolves.toBe(false);
    expect(c.isEnabled()).toBe(false);
    expect(H.irc.instances).toHaveLength(0);
  });

  it('swallows connection errors and reports disabled', async () => {
    process.env.SCUTTLEBOT_PASSPHRASE = 'pass-abc';
    H.irc.connectImpl = async () => {
      throw new Error('connection refused');
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new ScuttlebotClient();

    const ok = await c.initialize('sess', '/tmp/proj');

    expect(ok).toBe(false);
    expect(c.isEnabled()).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('passes tls:true when the IRC address is on port 6697', async () => {
    process.env.SCUTTLEBOT_PASSPHRASE = 'pass-abc';
    process.env.SCUTTLEBOT_IRC_ADDR = 'irc.relay:6697';
    const c = new ScuttlebotClient();

    await c.initialize('sess', '/tmp/proj');
    expect(lastIrc().opts.tls).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Posting + mirroring
// ═══════════════════════════════════════════════════════════════════════

async function enabledClient(nick = 'calliope'): Promise<ScuttlebotClient> {
  process.env.SCUTTLEBOT_PASSPHRASE = 'pass-abc';
  process.env.SCUTTLEBOT_NICK = nick;
  const c = new ScuttlebotClient();
  await c.initialize('sess', '/tmp/proj');
  lastIrc().sends.length = 0; // clear the hello envelope
  return c;
}

describe('postMessage', () => {
  it('sends plain text to the primary channel', async () => {
    const c = await enabledClient();
    await c.postMessage('build finished');
    const send = lastIrc().sends.find((s) => s.method === 'sendRaw');
    expect(send).toEqual({ method: 'sendRaw', channel: 'general', arg: 'build finished' });
  });

  it('redacts secrets before posting', async () => {
    const c = await enabledClient();
    await c.postMessage('token deadbeefdeadbeefdeadbeefdeadbeef key sk-ABC123 API_KEY=hunter2 bearer xy.z');
    const arg = lastIrc().sends.find((s) => s.method === 'sendRaw')!.arg as string;
    expect(arg).not.toContain('deadbeefdeadbeefdeadbeefdeadbeef');
    expect(arg).not.toContain('sk-ABC123');
    expect(arg).not.toContain('hunter2');
    expect(arg).toContain('[REDACTED]');
    expect(arg).toContain('bearer [REDACTED]');
  });

  it('is a no-op when disabled', async () => {
    const c = new ScuttlebotClient();
    await c.postMessage('dropped');
    expect(H.irc.instances).toHaveLength(0);
  });
});

describe('presence envelopes', () => {
  it('postOnline emits agent.hello and postOffline emits agent.bye', async () => {
    const c = await enabledClient();

    await c.postOnline();
    await c.postOffline();

    const types = lastIrc()
      .sends.filter((s) => s.method === 'sendEnvelope')
      .map((s) => s.arg.type);
    expect(types).toContain('agent.hello');
    expect(types).toContain('agent.bye');
  });
});

describe('mirrorToolCall', () => {
  it('formats the tool name with a path / command / pattern argument', async () => {
    const c = await enabledClient();

    await c.mirrorToolCall('read_file', { path: '/tmp/a.txt' });
    await c.mirrorToolCall('shell', { command: 'ls -la' });
    await c.mirrorToolCall('grep', { pattern: 'TODO' });

    const args = lastIrc()
      .sends.filter((s) => s.method === 'sendRaw')
      .map((s) => s.arg);
    expect(args).toContain('read_file /tmp/a.txt');
    expect(args).toContain('shell ls -la');
    expect(args).toContain('grep TODO');
  });

  it('sends just the tool name when there are no recognised args', async () => {
    const c = await enabledClient();
    await c.mirrorToolCall('list_dir');
    expect(lastIrc().sends.find((s) => s.method === 'sendRaw')!.arg).toBe('list_dir');
  });

  it('is a no-op when disabled', async () => {
    const c = new ScuttlebotClient();
    await c.mirrorToolCall('shell', { command: 'ls' });
    expect(H.irc.instances).toHaveLength(0);
  });
});

describe('mirrorAssistant', () => {
  it('passes short messages through unchanged', async () => {
    const c = await enabledClient();
    await c.mirrorAssistant('done');
    expect(lastIrc().sends.find((s) => s.method === 'sendRaw')!.arg).toBe('done');
  });

  it('truncates messages longer than 200 characters', async () => {
    const c = await enabledClient();
    await c.mirrorAssistant('x'.repeat(300));
    const arg = lastIrc().sends.find((s) => s.method === 'sendRaw')!.arg as string;
    expect(arg).toHaveLength(200);
    expect(arg.endsWith('...')).toBe(true);
  });

  it('is a no-op when disabled', async () => {
    const c = new ScuttlebotClient();
    await c.mirrorAssistant('hi');
    expect(H.irc.instances).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Instruction routing
// ═══════════════════════════════════════════════════════════════════════

describe('startPolling / instruction routing', () => {
  it('routes a task.create envelope to the instruction handler', async () => {
    const c = await enabledClient();
    const got: string[] = [];
    c.startPolling((instr) => got.push(instr));

    lastIrc().emitEnvelope(
      { v: 1, type: 'task.create', id: 'x', from: 'boss', ts: 1, payload: { instruction: 'do X' } },
      '#general',
    );
    expect(got).toEqual(['do X']);
  });

  it('falls back through prompt / text / stringified payload', async () => {
    const c = await enabledClient();
    const got: string[] = [];
    c.startPolling((instr) => got.push(instr));
    const irc = lastIrc();

    irc.emitEnvelope({ v: 1, type: 'task.create', id: '1', from: 'b', ts: 1, payload: { prompt: 'P' } }, '#g');
    irc.emitEnvelope({ v: 1, type: 'task.create', id: '2', from: 'b', ts: 1, payload: { text: 'T' } }, '#g');
    irc.emitEnvelope({ v: 1, type: 'task.create', id: '3', from: 'b', ts: 1, payload: { other: 'O' } }, '#g');

    expect(got[0]).toBe('P');
    expect(got[1]).toBe('T');
    expect(got[2]).toBe(JSON.stringify({ other: 'O' }));
  });

  it('ignores non-task.create envelopes', async () => {
    const c = await enabledClient();
    const got: string[] = [];
    c.startPolling((instr) => got.push(instr));

    lastIrc().emitEnvelope({ v: 1, type: 'agent.hello', id: 'x', from: 'boss', ts: 1 }, '#general');
    expect(got).toHaveLength(0);
  });

  it('strips the addressing prefix from human instructions', async () => {
    const c = await enabledClient('calliope');
    const got: string[] = [];
    c.startPolling((instr) => got.push(instr));

    lastIrc().emitInstruction('calliope: please ship it', 'alice', '#general');
    expect(got).toEqual(['please ship it']);
  });

  it('stopPolling detaches the handler', async () => {
    const c = await enabledClient();
    const got: string[] = [];
    c.startPolling((instr) => got.push(instr));
    c.stopPolling();

    lastIrc().emitEnvelope(
      { v: 1, type: 'task.create', id: 'x', from: 'boss', ts: 1, payload: { instruction: 'do X' } },
      '#general',
    );
    expect(got).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Status + disconnect
// ═══════════════════════════════════════════════════════════════════════

describe('getStatus', () => {
  it('reports a disabled, unconnected shape before initialization', () => {
    const c = new ScuttlebotClient();
    expect(c.getStatus()).toEqual({ enabled: false, config: undefined, nick: undefined, connected: false });
  });

  it('reflects the live connection once initialized', async () => {
    const c = await enabledClient('calliope');
    const status = c.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.nick).toBe('calliope');
    expect(status.connected).toBe(true);
    expect(status.config?.channel).toBe('general');
  });
});

describe('disconnect', () => {
  it('deletes the session registration in dynamic mode', async () => {
    process.env.SCUTTLEBOT_TOKEN = 'tok';
    process.env.SCUTTLEBOT_URL = 'http://relay';
    const c = new ScuttlebotClient();
    await c.initialize('sess', '/tmp/proj');
    const irc = lastIrc();
    const http = lastHttp();

    await c.disconnect();

    // Bye envelope sent, IRC disconnected, registration deleted.
    expect(irc.sends.some((s) => s.method === 'sendEnvelope' && s.arg.type === 'agent.bye')).toBe(true);
    expect(http.calls.some((call) => call.method === 'deleteAgent')).toBe(true);
    expect(c.isEnabled()).toBe(false);
    expect(c.getStatus().connected).toBe(false);
  });

  it('does not delete a registration it did not create (pre-registered mode)', async () => {
    process.env.SCUTTLEBOT_PASSPHRASE = 'pass-abc';
    process.env.SCUTTLEBOT_URL = 'http://relay';
    process.env.SCUTTLEBOT_TOKEN = 'tok';
    const c = new ScuttlebotClient();
    await c.initialize('sess', '/tmp/proj');
    const http = lastHttp();

    await c.disconnect();

    expect(http.calls.some((call) => call.method === 'deleteAgent')).toBe(false);
  });

  it('stops the presence heartbeat', async () => {
    process.env.SCUTTLEBOT_PASSPHRASE = 'pass-abc';
    process.env.SCUTTLEBOT_NICK = 'calliope';
    process.env.SCUTTLEBOT_URL = 'http://relay';
    process.env.SCUTTLEBOT_TOKEN = 'tok';
    const c = new ScuttlebotClient();
    await c.initialize('sess', '/tmp/proj');
    const http = lastHttp();

    await c.disconnect();
    const after = http.calls.filter((call) => call.method === 'touchPresence').length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(http.calls.filter((call) => call.method === 'touchPresence').length).toBe(after);
  });
});
