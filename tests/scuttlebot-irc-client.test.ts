/**
 * Tests for src/scuttlebot/irc-client.ts
 *
 * The IRC client talks to a real TCP/TLS socket. We mock `node:net` and
 * `node:tls` at the module seam: each `createConnection`/`connect` call
 * returns a hand-rolled fake socket (a minimal EventEmitter that records
 * every `write()`), and the connect callback is captured rather than fired
 * so the test drives the SASL handshake deterministically by feeding raw
 * server lines through the socket's `data` event. Fake timers make the
 * 30s connect timeout, PING keepalive, reconnect backoff and QUIT drain
 * instantaneous and race-free.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Socket mock (hoisted so the vi.mock factories can see it) ───────────
const netMock = vi.hoisted(() => {
  interface FakeSocket {
    writes: string[];
    destroyed: boolean;
    setEncoding: () => FakeSocket;
    write: (data: string) => boolean;
    destroy: () => FakeSocket;
    on: (event: string, cb: (...a: unknown[]) => void) => FakeSocket;
    once: (event: string, cb: (...a: unknown[]) => void) => FakeSocket;
    off: (event: string, cb: (...a: unknown[]) => void) => FakeSocket;
    removeAllListeners: () => FakeSocket;
    emit: (event: string, ...args: unknown[]) => boolean;
    feed: (data: string) => void;
  }

  const sockets: FakeSocket[] = [];
  const onConnects: Array<undefined | (() => void)> = [];
  const tlsFlags: boolean[] = [];

  function makeSocket(): FakeSocket {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const socket: FakeSocket = {
      writes: [],
      destroyed: false,
      setEncoding() {
        return socket;
      },
      write(data: string) {
        socket.writes.push(data);
        return true;
      },
      destroy() {
        socket.destroyed = true;
        return socket;
      },
      on(event, cb) {
        (handlers[event] ??= []).push(cb);
        return socket;
      },
      once(event, cb) {
        const wrap = (...a: unknown[]) => {
          socket.off(event, wrap);
          cb(...a);
        };
        return socket.on(event, wrap);
      },
      off(event, cb) {
        if (handlers[event]) handlers[event] = handlers[event].filter((f) => f !== cb);
        return socket;
      },
      removeAllListeners() {
        for (const k of Object.keys(handlers)) delete handlers[k];
        return socket;
      },
      emit(event, ...args) {
        for (const cb of [...(handlers[event] ?? [])]) cb(...args);
        return true;
      },
      feed(data: string) {
        socket.emit('data', data);
      },
    };
    return socket;
  }

  function record(onConnect: undefined | (() => void), tls: boolean): FakeSocket {
    const s = makeSocket();
    sockets.push(s);
    onConnects.push(onConnect);
    tlsFlags.push(tls);
    return s;
  }

  return {
    sockets,
    onConnects,
    tlsFlags,
    createConnection: (_opts: unknown, onConnect?: () => void) => record(onConnect, false),
    tlsConnect: (_opts: unknown, onConnect?: () => void) => record(onConnect, true),
    reset() {
      sockets.length = 0;
      onConnects.length = 0;
      tlsFlags.length = 0;
    },
    last() {
      return {
        socket: sockets[sockets.length - 1],
        onConnect: onConnects[onConnects.length - 1],
      };
    },
  };
});

vi.mock('node:net', () => ({
  createConnection: netMock.createConnection,
  default: { createConnection: netMock.createConnection },
}));
vi.mock('node:tls', () => ({
  connect: netMock.tlsConnect,
  default: { connect: netMock.tlsConnect },
}));

import {
  ScuttlebotIRCClient,
  matchesRecipient,
  newEnvelope,
  MessageTypes,
  type Envelope,
  type IRCClientOptions,
} from '../src/scuttlebot/irc-client.js';

// ── Helpers ─────────────────────────────────────────────────────────────

const clients: ScuttlebotIRCClient[] = [];

function makeClient(overrides: Partial<IRCClientOptions> = {}): ScuttlebotIRCClient {
  const c = new ScuttlebotIRCClient({
    serverAddr: '127.0.0.1:6667',
    nick: 'mybot',
    passphrase: 'secret',
    channels: ['general'],
    agentType: 'worker',
    ...overrides,
  });
  clients.push(c);
  return c;
}

const written = (s: { writes: string[] }) => s.writes.join('');
const writtenLines = (s: { writes: string[] }) => written(s).split('\r\n').filter(Boolean);

/** Drive a full successful SASL handshake for the most recently created socket. */
function driveHandshake(nick = 'mybot'): { socket: ReturnType<typeof netMock.last>['socket'] } {
  const { socket, onConnect } = netMock.last();
  onConnect?.();
  socket.feed(':irc.test CAP * ACK :sasl\r\n');
  socket.feed('AUTHENTICATE +\r\n');
  socket.feed(`:irc.test 903 ${nick} :SASL authentication successful\r\n`);
  socket.feed(`:irc.test 001 ${nick} :Welcome to the network\r\n`);
  return { socket };
}

async function connectClient(c: ScuttlebotIRCClient, nick = 'mybot') {
  const p = c.connect();
  const { socket } = driveHandshake(nick);
  await p;
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  netMock.reset();
});

afterEach(async () => {
  // Tear down every client so PING intervals and process SIGINT/SIGTERM
  // listeners never leak across tests.
  for (const c of clients) {
    try {
      const p = c.disconnect();
      await vi.advanceTimersByTimeAsync(600);
      await p;
    } catch {
      /* already torn down */
    }
  }
  clients.length = 0;
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════
// Pure functions
// ═══════════════════════════════════════════════════════════════════════

describe('newEnvelope', () => {
  it('creates a v1 envelope with a generated id and timestamp', () => {
    const env = newEnvelope('task.create', 'boss');
    expect(env.v).toBe(1);
    expect(env.type).toBe('task.create');
    expect(env.from).toBe('boss');
    expect(typeof env.id).toBe('string');
    expect(env.id.length).toBeGreaterThan(0);
    expect(typeof env.ts).toBe('number');
    expect(env.to).toBeUndefined();
    expect(env.payload).toBeUndefined();
  });

  it('includes to and payload when provided', () => {
    const env = newEnvelope('task.create', 'boss', {
      to: ['@workers'],
      payload: { instruction: 'go' },
    });
    expect(env.to).toEqual(['@workers']);
    expect(env.payload).toEqual({ instruction: 'go' });
  });

  it('generates unique ids across calls', () => {
    const a = newEnvelope('x', 'me');
    const b = newEnvelope('x', 'me');
    expect(a.id).not.toBe(b.id);
  });
});

describe('matchesRecipient', () => {
  const base = (to?: string[]): Envelope => ({
    v: 1,
    type: 'task.create',
    id: 'id1',
    from: 'boss',
    ts: 1,
    ...(to ? { to } : {}),
  });

  it('treats an empty or missing recipient list as a broadcast', () => {
    expect(matchesRecipient(base(), 'anynick', 'worker')).toBe(true);
    expect(matchesRecipient(base([]), 'anynick', 'worker')).toBe(true);
  });

  it('matches @all for any agent', () => {
    expect(matchesRecipient(base(['@all']), 'nick', 'observer')).toBe(true);
  });

  it('matches agent-type tokens only for that type', () => {
    expect(matchesRecipient(base(['@workers']), 'n', 'worker')).toBe(true);
    expect(matchesRecipient(base(['@workers']), 'n', 'operator')).toBe(false);
    expect(matchesRecipient(base(['@operators']), 'n', 'operator')).toBe(true);
    expect(matchesRecipient(base(['@orchestrators']), 'n', 'orchestrator')).toBe(true);
    expect(matchesRecipient(base(['@observers']), 'n', 'observer')).toBe(true);
  });

  it('matches an @prefix-* glob against the nick prefix', () => {
    expect(matchesRecipient(base(['@calliope-*']), 'calliope-abc', 'worker')).toBe(true);
    expect(matchesRecipient(base(['@calliope-*']), 'codex-abc', 'worker')).toBe(false);
  });

  it('matches a bare nick exactly', () => {
    expect(matchesRecipient(base(['mybot']), 'mybot', 'worker')).toBe(true);
    expect(matchesRecipient(base(['someoneelse']), 'mybot', 'worker')).toBe(false);
  });

  it('scans multiple tokens and returns false when none match', () => {
    expect(matchesRecipient(base(['@operators', 'other']), 'mybot', 'worker')).toBe(false);
    expect(matchesRecipient(base(['@operators', 'mybot']), 'mybot', 'worker')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Connection lifecycle
// ═══════════════════════════════════════════════════════════════════════

describe('connect', () => {
  it('completes the SASL handshake and resolves once registered', async () => {
    const c = makeClient();
    const socket = await connectClient(c);

    expect(c.isConnected()).toBe(true);
    const lines = writtenLines(socket);
    expect(lines).toContain('CAP REQ :sasl');
    expect(lines).toContain('NICK mybot');
    expect(lines).toContain('USER mybot 0 * :mybot');
    expect(lines).toContain('AUTHENTICATE PLAIN');
    // SASL PLAIN payload: base64 of \0nick\0passphrase
    const expectedAuth = 'AUTHENTICATE ' + Buffer.from('\0mybot\0secret').toString('base64');
    expect(lines).toContain(expectedAuth);
    expect(lines).toContain('CAP END');
    // Joins its channel after 001
    expect(lines).toContain('JOIN #general');
  });

  it('is a no-op when already connected', async () => {
    const c = makeClient();
    await connectClient(c);
    const socketCount = netMock.sockets.length;
    await c.connect(); // should short-circuit
    expect(netMock.sockets.length).toBe(socketCount);
  });

  it('normalizes channel names without a leading # when joining', async () => {
    const c = makeClient({ channels: ['#ops', 'release'] });
    const socket = await connectClient(c);
    const lines = writtenLines(socket);
    expect(lines).toContain('JOIN #ops');
    expect(lines).toContain('JOIN #release');
  });

  it('uses tls.connect for port 6697', async () => {
    const c = makeClient({ serverAddr: 'irc.test:6697' });
    const p = c.connect();
    driveHandshake();
    await p;
    expect(netMock.tlsFlags[netMock.tlsFlags.length - 1]).toBe(true);
  });

  it('uses tls.connect when tls:true is set explicitly', async () => {
    const c = makeClient({ serverAddr: 'irc.test:6667', tls: true });
    const p = c.connect();
    driveHandshake();
    await p;
    expect(netMock.tlsFlags[netMock.tlsFlags.length - 1]).toBe(true);
  });

  it('rejects on connection timeout', async () => {
    const c = makeClient();
    const p = c.connect();
    const rejection = expect(p).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    expect(c.isConnected()).toBe(false);
  });

  it('rejects when the socket errors during connect', async () => {
    const c = makeClient();
    const p = c.connect();
    const { socket } = netMock.last();
    const rejection = expect(p).rejects.toThrow('ECONNREFUSED');
    socket.emit('error', new Error('ECONNREFUSED'));
    await rejection;
    expect(c.isConnected()).toBe(false);
  });

  it('rejects when SASL authentication fails (904)', async () => {
    const c = makeClient();
    const p = c.connect();
    const { socket, onConnect } = netMock.last();
    onConnect?.();
    socket.feed(':irc.test CAP * ACK :sasl\r\n');
    socket.feed('AUTHENTICATE +\r\n');
    const rejection = expect(p).rejects.toThrow(/bad password|SASL/i);
    socket.feed(':irc.test 904 mybot :SASL authentication failed: bad password\r\n');
    await rejection;
    expect(c.isConnected()).toBe(false);
  });

  it('sends CAP END when the server NAKs the sasl capability', async () => {
    const c = makeClient();
    c.connect().catch(() => {});
    const { socket, onConnect } = netMock.last();
    onConnect?.();
    socket.feed(':irc.test CAP * NAK :sasl\r\n');
    expect(writtenLines(socket)).toContain('CAP END');
  });

  it('defaults to port 6667 when the address has no port', async () => {
    const c = makeClient({ serverAddr: 'irc.test' });
    const p = c.connect();
    driveHandshake();
    await p;
    // No port -> not TLS (6667 default), so plain net.createConnection was used.
    expect(netMock.tlsFlags[netMock.tlsFlags.length - 1]).toBe(false);
    expect(c.isConnected()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Sending
// ═══════════════════════════════════════════════════════════════════════

describe('sending', () => {
  it('sendEnvelope serializes a JSON envelope to a PRIVMSG', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    socket.writes.length = 0;

    c.sendEnvelope('general', { v: 1, type: MessageTypes.AgentHello, from: 'mybot' });
    const line = writtenLines(socket).find((l) => l.startsWith('PRIVMSG #general :'));
    expect(line).toBeDefined();
    const json = JSON.parse(line!.replace('PRIVMSG #general :', ''));
    expect(json.type).toBe('agent.hello');
    expect(json.from).toBe('mybot');
    expect(json.v).toBe(1);
  });

  it('sendRaw sends a plain-text PRIVMSG and prefixes the channel with #', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    socket.writes.length = 0;

    c.sendRaw('general', 'hello world');
    expect(writtenLines(socket)).toContain('PRIVMSG #general :hello world');
  });

  it('splits multi-line text into separate PRIVMSGs and skips blank lines', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    socket.writes.length = 0;

    c.sendRaw('general', 'line one\n\nline two');
    const lines = writtenLines(socket);
    expect(lines).toContain('PRIVMSG #general :line one');
    expect(lines).toContain('PRIVMSG #general :line two');
    expect(lines.filter((l) => l === 'PRIVMSG #general :')).toHaveLength(0);
  });

  it('is a no-op when not connected', () => {
    const c = makeClient();
    c.sendRaw('general', 'dropped');
    // No socket was ever created because connect() was never called.
    expect(netMock.sockets.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Receiving — envelopes and human chat
// ═══════════════════════════════════════════════════════════════════════

describe('receiving PRIVMSG envelopes', () => {
  it('delivers a valid broadcast envelope to envelope handlers', async () => {
    const c = makeClient();
    const received: Array<{ env: Envelope; channel: string }> = [];
    c.onEnvelope((env, channel) => received.push({ env, channel }));
    const socket = await connectClient(c);

    const env = newEnvelope('task.create', 'boss', { payload: { instruction: 'go' } });
    socket.feed(`:boss!u@h PRIVMSG #general :${JSON.stringify(env)}\r\n`);

    expect(received).toHaveLength(1);
    expect(received[0].channel).toBe('#general');
    expect(received[0].env.type).toBe('task.create');
    expect((received[0].env.payload as { instruction: string }).instruction).toBe('go');
  });

  it('drops an envelope addressed to a different recipient', async () => {
    const c = makeClient();
    const received: Envelope[] = [];
    c.onEnvelope((env) => received.push(env));
    const socket = await connectClient(c);

    const env = newEnvelope('task.create', 'boss', { to: ['@operators'] });
    socket.feed(`:boss!u@h PRIVMSG #general :${JSON.stringify(env)}\r\n`);

    expect(received).toHaveLength(0);
  });

  it('ignores PRIVMSGs sent by our own nick', async () => {
    const c = makeClient();
    const received: Envelope[] = [];
    c.onEnvelope((env) => received.push(env));
    const socket = await connectClient(c);

    const env = newEnvelope('task.create', 'mybot');
    socket.feed(`:mybot!u@h PRIVMSG #general :${JSON.stringify(env)}\r\n`);

    expect(received).toHaveLength(0);
  });

  it('treats malformed JSON (missing envelope fields) as human chat, not an envelope', async () => {
    const c = makeClient();
    const envs: Envelope[] = [];
    const instructions: string[] = [];
    c.onEnvelope((env) => envs.push(env));
    c.onInstruction((text) => instructions.push(text));
    const socket = await connectClient(c);

    // Valid JSON object but not a valid envelope (no v/id/from/ts) and mentions the bot.
    socket.feed(':alice!u@h PRIVMSG #general :{"hello":"mybot"}\r\n');

    expect(envs).toHaveLength(0);
    expect(instructions).toHaveLength(1);
  });
});

describe('receiving human instructions', () => {
  it('delivers a human message that mentions our nick', async () => {
    const c = makeClient();
    const got: Array<{ text: string; from: string; channel: string }> = [];
    c.onInstruction((text, from, channel) => got.push({ text, from, channel }));
    const socket = await connectClient(c);

    socket.feed(':alice!u@h PRIVMSG #general :mybot please build it\r\n');

    expect(got).toEqual([{ text: 'mybot please build it', from: 'alice', channel: '#general' }]);
  });

  it('ignores human messages that do not mention our nick', async () => {
    const c = makeClient();
    const got: string[] = [];
    c.onInstruction((text) => got.push(text));
    const socket = await connectClient(c);

    socket.feed(':alice!u@h PRIVMSG #general :hello everyone\r\n');
    expect(got).toHaveLength(0);
  });

  it('ignores messages from known service bots', async () => {
    const c = makeClient();
    const got: string[] = [];
    c.onInstruction((text) => got.push(text));
    const socket = await connectClient(c);

    socket.feed(':oracle!u@h PRIVMSG #general :mybot status\r\n');
    expect(got).toHaveLength(0);
  });

  it('ignores messages from other agents (agent nick prefixes)', async () => {
    const c = makeClient();
    const got: string[] = [];
    c.onInstruction((text) => got.push(text));
    const socket = await connectClient(c);

    socket.feed(':claude-worker!u@h PRIVMSG #general :mybot hi\r\n');
    expect(got).toHaveLength(0);
  });

  it('does nothing when no instruction handlers are registered', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    // No onInstruction registered — must not throw.
    expect(() => socket.feed(':alice!u@h PRIVMSG #general :mybot hi\r\n')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Protocol edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('protocol parsing', () => {
  it('answers a server PING with a PONG', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    socket.writes.length = 0;

    socket.feed('PING :hub.irc.test\r\n');
    expect(writtenLines(socket)).toContain('PONG :hub.irc.test');
  });

  it('strips IRCv3 message tags before dispatch', async () => {
    const c = makeClient();
    const instructions: string[] = [];
    c.onInstruction((text) => instructions.push(text));
    const socket = await connectClient(c);

    socket.feed('@time=2020 :alice!u@h PRIVMSG #general :mybot tagged\r\n');
    expect(instructions).toEqual(['mybot tagged']);
  });

  it('ignores a bare tag line with no trailing message', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    // Line is only a tag, no space -> handleLine returns early without throwing.
    expect(() => socket.feed('@only-a-tag\r\n')).not.toThrow();
  });

  it('silently ignores NOTICE lines', async () => {
    const c = makeClient();
    const instructions: string[] = [];
    c.onInstruction((text) => instructions.push(text));
    const socket = await connectClient(c);

    socket.feed(':server NOTICE #general :mybot heads up\r\n');
    expect(instructions).toHaveLength(0);
  });

  it('buffers a message split across two data events', async () => {
    const c = makeClient();
    const instructions: string[] = [];
    c.onInstruction((text) => instructions.push(text));
    const socket = await connectClient(c);

    socket.feed(':alice!u@h PRIVMSG #general :mybot par');
    expect(instructions).toHaveLength(0); // no line terminator yet
    socket.feed('tial line\r\n');
    expect(instructions).toEqual(['mybot partial line']);
  });

  it('handles \\n-only line endings', async () => {
    const c = makeClient();
    const instructions: string[] = [];
    c.onInstruction((text) => instructions.push(text));
    const socket = await connectClient(c);

    socket.feed(':alice!u@h PRIVMSG #general :mybot newline only\n');
    expect(instructions).toEqual(['mybot newline only']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Keepalive + reconnect
// ═══════════════════════════════════════════════════════════════════════

describe('keepalive', () => {
  it('sends a client PING after the keepalive interval and clears it on PONG', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    socket.writes.length = 0;

    await vi.advanceTimersByTimeAsync(30000);
    expect(writtenLines(socket)).toContain('PING :calliope');

    // Server PONG clears the pending-ping state; the dead-connection timeout
    // must NOT fire afterwards.
    socket.feed(':irc.test PONG irc.test :calliope\r\n');
    socket.writes.length = 0;
    await vi.advanceTimersByTimeAsync(30000);
    // A new PING may be issued, but the connection is still alive.
    expect(c.isConnected()).toBe(true);
  });

  it('tears down and schedules a reconnect when no PONG arrives', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    const socketsBefore = netMock.sockets.length;

    await vi.advanceTimersByTimeAsync(30000); // PING sent
    expect(writtenLines(socket)).toContain('PING :calliope');
    await vi.advanceTimersByTimeAsync(30000); // no PONG -> dead
    expect(c.isConnected()).toBe(false);

    // Reconnect backoff kicks in.
    await vi.advanceTimersByTimeAsync(2000);
    expect(netMock.sockets.length).toBeGreaterThan(socketsBefore);
  });
});

describe('reconnect', () => {
  it('reconnects after an unexpected socket close', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    const socketsBefore = netMock.sockets.length;

    socket.emit('close');
    expect(c.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(netMock.sockets.length).toBe(socketsBefore + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Disconnect + exit handling
// ═══════════════════════════════════════════════════════════════════════

describe('disconnect', () => {
  it('sends QUIT and stops reconnecting', async () => {
    const c = makeClient();
    const socket = await connectClient(c);
    socket.writes.length = 0;

    const p = c.disconnect();
    // Simulate the server closing the connection in response to QUIT.
    socket.emit('close');
    await p;

    expect(written(socket)).toContain('QUIT :Session ended');
    expect(c.isConnected()).toBe(false);

    // After disconnect, a close does not trigger a reconnect.
    const socketsAfter = netMock.sockets.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(netMock.sockets.length).toBe(socketsAfter);
  });

  it('drains via the timeout when the server never closes', async () => {
    const c = makeClient();
    const socket = await connectClient(c);

    const p = c.disconnect();
    await vi.advanceTimersByTimeAsync(500); // drain timer
    await p;
    expect(written(socket)).toContain('QUIT :Session ended');
  });

  it('is safe to call when never connected', async () => {
    const c = makeClient();
    await expect(c.disconnect()).resolves.toBeUndefined();
  });

  it('registers a SIGINT/SIGTERM handler that QUITs on exit and unregisters on disconnect', async () => {
    const before = process.listeners('SIGINT');
    const c = makeClient();
    const socket = await connectClient(c);

    const added = process.listeners('SIGINT').filter((h) => !before.includes(h));
    expect(added).toHaveLength(1);

    socket.writes.length = 0;
    (added[0] as () => void)(); // invoke the exit handler directly (no real signal)
    expect(written(socket)).toContain('QUIT :Session ended');
    expect(socket.destroyed).toBe(true);

    const p = c.disconnect();
    await vi.advanceTimersByTimeAsync(600);
    await p;
    // Handler removed after disconnect.
    expect(process.listeners('SIGINT').filter((h) => !before.includes(h))).toHaveLength(0);
  });
});
