/**
 * Scuttlebot IRC Client
 *
 * Zero-dependency IRC client using Node.js net.Socket.
 * Connects directly to Ergo IRC server with SASL PLAIN auth.
 * Handles the scuttlebot envelope protocol (JSON over PRIVMSG).
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import * as crypto from 'node:crypto';

// ── Envelope protocol ────────────────────────────────────────────────

/** Wire envelope — matches the Go protocol.Envelope. */
export interface Envelope {
  v: 1;
  type: string;
  id: string;
  from: string;
  to?: string[];
  ts: number;
  payload?: unknown;
}

/** Well-known message types. */
export const MessageTypes = {
  AgentHello:   'agent.hello',
  AgentBye:     'agent.bye',
  TaskCreate:   'task.create',
  TaskUpdate:   'task.update',
  TaskComplete: 'task.complete',
} as const;

/**
 * Check whether an envelope is addressed to `nick` with `agentType`.
 *
 * Ported from Go's protocol.MatchesRecipient:
 *   - empty/nil to     -> true (broadcast)
 *   - @all              -> true
 *   - @workers etc.     -> agentType match
 *   - @prefix-*         -> nick starts with prefix-
 *   - bare string       -> exact nick match
 */
export function matchesRecipient(env: Envelope, nick: string, agentType: string): boolean {
  if (!env.to || env.to.length === 0) {
    return true;
  }

  for (const token of env.to) {
    switch (token) {
      case '@all':
        return true;
      case '@operators':
        if (agentType === 'operator') return true;
        break;
      case '@orchestrators':
        if (agentType === 'orchestrator') return true;
        break;
      case '@workers':
        if (agentType === 'worker') return true;
        break;
      case '@observers':
        if (agentType === 'observer') return true;
        break;
      default:
        if (token.startsWith('@')) {
          // @prefix-* glob: strip @ and trailing *
          const body = token.slice(1);
          if (body.endsWith('-*')) {
            const prefix = body.slice(0, -1); // keep the trailing dash
            if (nick.startsWith(prefix)) return true;
          }
        } else if (token === nick) {
          return true;
        }
    }
  }

  return false;
}

/** Create a new envelope with a generated ID and current timestamp. */
export function newEnvelope(
  type: string,
  from: string,
  opts?: { to?: string[]; payload?: unknown },
): Envelope {
  return {
    v: 1,
    type,
    id: crypto.randomUUID(),
    from,
    ts: Date.now(),
    ...(opts?.to ? { to: opts.to } : {}),
    ...(opts?.payload !== undefined ? { payload: opts.payload } : {}),
  };
}

/** Validate that a parsed object looks like a valid Envelope. */
function isEnvelope(obj: unknown): obj is Envelope {
  if (typeof obj !== 'object' || obj === null) return false;
  const e = obj as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.type === 'string' && e.type !== '' &&
    typeof e.id === 'string' && e.id !== '' &&
    typeof e.from === 'string' && e.from !== '' &&
    typeof e.ts === 'number'
  );
}

// ── IRC Client ───────────────────────────────────────────────────────

/** Agent nick prefixes that indicate non-human senders. */
const AGENT_PREFIXES = ['claude-', 'codex-', 'gemini-', 'calliope-'];

/** Known service bots to ignore for instruction delivery. */
const SERVICE_BOTS = new Set([
  'bridge', 'oracle', 'sentinel', 'steward', 'scribe',
  'warden', 'snitch', 'herald', 'scroll', 'systembot', 'auditbot',
]);

export interface IRCClientOptions {
  /** IRC server address, "host:port". */
  serverAddr: string;
  /** Nick (also used as SASL username). */
  nick: string;
  /** SASL PLAIN passphrase from registration. */
  passphrase: string;
  /** Channels to join (with or without # prefix). */
  channels: string[];
  /** Agent type for recipient matching. Defaults to 'worker'. */
  agentType?: string;
  /** Use TLS. Inferred from port 6697 if not specified. */
  tls?: boolean;
}

type EnvelopeHandler = (env: Envelope, channel: string) => void;
type InstructionHandler = (text: string, from: string, channel: string) => void;

export class ScuttlebotIRCClient {
  private readonly opts: IRCClientOptions;
  private readonly agentType: string;
  private socket: net.Socket | null = null;
  private connected = false;
  private destroyed = false;

  private envelopeHandlers: EnvelopeHandler[] = [];
  private instructionHandlers: InstructionHandler[] = [];

  // Reconnect state
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000; // ms, doubles up to 60s
  private shouldReconnect = true;

  // Incoming data buffer (IRC lines are \r\n delimited)
  private buffer = '';

  // SASL / registration state machine
  private saslState: 'none' | 'cap-req' | 'cap-ack' | 'auth-sent' | 'authenticated' | 'registered' = 'none';
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Client-initiated PING keepalive — detects dead TCP connections
  private static readonly PING_INTERVAL_MS = 30_000;
  private static readonly PING_TIMEOUT_MS  = 30_000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPing = false;

  // Signal handler registered for clean exit
  private exitHandler: (() => void) | null = null;

  constructor(opts: IRCClientOptions) {
    this.opts = opts;
    this.agentType = opts.agentType || 'worker';
  }

  /** Register a handler for incoming JSON envelopes. */
  onEnvelope(handler: EnvelopeHandler): void {
    this.envelopeHandlers.push(handler);
  }

  /** Register a handler for human instructions (non-JSON PRIVMSG that mention our nick). */
  onInstruction(handler: InstructionHandler): void {
    this.instructionHandlers.push(handler);
  }

  /**
   * Connect to the IRC server. Resolves once fully registered (numeric 001 received).
   * Rejects on timeout (30s) or fatal connection error during initial connect.
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.destroyed = false;
    this.shouldReconnect = true;

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      this.connectTimeout = setTimeout(() => {
        if (!this.connected) {
          const err = new Error('IRC connection timeout (30s)');
          this.connectReject?.(err);
          this.connectReject = null;
          this.connectResolve = null;
          this.cleanupSocket();
        }
      }, 30000);

      this.createConnection();
    });
  }

  /** Disconnect gracefully. Sends QUIT and closes the socket. */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    this.destroyed = true;

    this.stopPingKeepalive();
    this.unregisterExitHandler();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }

    if (this.socket && !this.socket.destroyed) {
      this.sendRawLine('QUIT :Session ended');
      // Give the server a moment to process QUIT before destroying
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.cleanupSocket();
          resolve();
        }, 500);
        this.socket?.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    this.connected = false;
  }

  /** Send a JSON envelope as PRIVMSG to a channel. */
  sendEnvelope(channel: string, env: Omit<Envelope, 'id' | 'ts'>): void {
    const full = newEnvelope(env.type, env.from, {
      to: env.to,
      payload: env.payload,
    });
    const json = JSON.stringify(full);
    this.sendPrivmsg(channel, json);
  }

  /** Send a plain text PRIVMSG to a channel. */
  sendRaw(channel: string, text: string): void {
    this.sendPrivmsg(channel, text);
  }

  /** Whether we are currently connected and registered on IRC. */
  isConnected(): boolean {
    return this.connected;
  }

  // ── Private: connection ──────────────────────────────────────────

  private createConnection(): void {
    const [host, portStr] = parseHostPort(this.opts.serverAddr);
    const port = parseInt(portStr, 10);
    const useTLS = this.opts.tls ?? port === 6697;

    this.buffer = '';
    this.saslState = 'none';

    const onConnect = () => {
      // TCP/TLS connected — begin IRC handshake
      this.saslState = 'cap-req';
      this.sendRawLine('CAP REQ :sasl');
      this.sendRawLine(`NICK ${this.opts.nick}`);
      this.sendRawLine(`USER ${this.opts.nick} 0 * :${this.opts.nick}`);
    };

    const socket: net.Socket = useTLS
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true }, onConnect)
      : net.createConnection({ host, port }, onConnect);

    socket.setEncoding('utf8');

    socket.on('data', (data: string) => {
      this.buffer += data;
      this.processBuffer();
    });

    socket.on('error', (err: Error) => {
      if (this.connectReject) {
        this.connectReject(err);
        this.connectReject = null;
        this.connectResolve = null;
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }
      }
      this.connected = false;
    });

    socket.on('close', () => {
      this.connected = false;
      this.socket = null;
      this.stopPingKeepalive();
      this.scheduleReconnect();
    });

    this.socket = socket;
  }

  private processBuffer(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (line.length > 0) {
        this.handleLine(line);
      }
    }
    // Also handle \n-only line endings (some servers)
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
    }
  }

  // ── Private: IRC line handling ───────────────────────────────────

  private handleLine(raw: string): void {
    // Strip IRCv3 message tags (we don't need them for now)
    let line = raw;
    if (line.startsWith('@')) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) return;
      line = line.slice(spaceIdx + 1);
    }

    // PING must be answered immediately
    if (line.startsWith('PING')) {
      const payload = line.slice(5); // after "PING "
      this.sendRawLine(`PONG ${payload}`);
      return;
    }

    const parsed = parseIRCMessage(line);
    if (!parsed) return;

    const { prefix, command, params } = parsed;

    switch (command) {
      // CAP negotiation
      case 'CAP': {
        // :server CAP * ACK :sasl
        const subCommand = params.length >= 2 ? params[1] : '';
        if (subCommand === 'ACK' && this.saslState === 'cap-req') {
          this.saslState = 'cap-ack';
          this.sendRawLine('AUTHENTICATE PLAIN');
        } else if (subCommand === 'NAK') {
          // Server rejected SASL — try without it
          this.sendRawLine('CAP END');
        }
        break;
      }

      case 'AUTHENTICATE': {
        // Server sends "AUTHENTICATE +" to request the credentials
        if (params[0] === '+' && this.saslState === 'cap-ack') {
          const credentials = `\0${this.opts.nick}\0${this.opts.passphrase}`;
          const encoded = Buffer.from(credentials).toString('base64');
          this.sendRawLine(`AUTHENTICATE ${encoded}`);
          this.saslState = 'auth-sent';
        }
        break;
      }

      // 903 = SASL auth successful
      case '903': {
        this.saslState = 'authenticated';
        this.sendRawLine('CAP END');
        break;
      }

      // 904/905 = SASL auth failed
      case '904':
      case '905': {
        const errMsg = params.length > 1 ? params.slice(1).join(' ') : 'SASL authentication failed';
        if (this.connectReject) {
          this.connectReject(new Error(errMsg));
          this.connectReject = null;
          this.connectResolve = null;
          if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
          }
        }
        this.cleanupSocket();
        break;
      }

      // 001 = RPL_WELCOME — fully registered
      case '001': {
        this.connected = true;
        this.saslState = 'registered';
        this.reconnectDelay = 2000; // reset backoff on successful connect

        // Join channels
        for (const ch of this.opts.channels) {
          const channelName = ch.startsWith('#') ? ch : `#${ch}`;
          this.sendRawLine(`JOIN ${channelName}`);
        }

        // Resolve the connect() promise
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }
        if (this.connectResolve) {
          this.connectResolve();
          this.connectResolve = null;
          this.connectReject = null;
        }

        // Start client-side PING keepalive and register clean-exit handler
        this.startPingKeepalive();
        this.registerExitHandler();
        break;
      }

      // PONG — server responded to our keepalive PING
      case 'PONG': {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        this.pendingPing = false;
        break;
      }

      // PRIVMSG — the main message handler
      case 'PRIVMSG': {
        if (params.length < 2) break;
        const channel = params[0]!;
        const text = params.slice(1).join(' ').replace(/^:/, '');
        const senderNick = extractNick(prefix);

        // Ignore our own messages
        if (senderNick === this.opts.nick) break;

        // Try to parse as JSON envelope
        try {
          const obj = JSON.parse(text);
          if (isEnvelope(obj)) {
            // Valid envelope — check recipient addressing
            if (matchesRecipient(obj, this.opts.nick, this.agentType)) {
              for (const handler of this.envelopeHandlers) {
                handler(obj, channel);
              }
            }
            break;
          }
        } catch {
          // Not JSON — fall through to human chat handling
        }

        // Non-JSON PRIVMSG: potential human instruction
        this.handleHumanChat(senderNick, channel, text);
        break;
      }

      // NOTICE — system/human commentary, silently ignored per protocol spec
      case 'NOTICE':
        break;

      // Other numerics we can safely ignore
      default:
        break;
    }
  }

  /**
   * Handle non-JSON PRIVMSG as potential human instructions.
   * Delivers to instruction handlers if:
   * - Message mentions our nick
   * - Sender is not a service bot
   * - Sender is not an agent (claude-/codex-/gemini-/calliope- prefix)
   */
  private handleHumanChat(senderNick: string, channel: string, text: string): void {
    if (this.instructionHandlers.length === 0) return;

    // Skip service bots
    if (SERVICE_BOTS.has(senderNick)) return;

    // Skip agent nicks
    for (const prefix of AGENT_PREFIXES) {
      if (senderNick.startsWith(prefix)) return;
    }

    // Must mention our nick (case-insensitive)
    if (!text.toLowerCase().includes(this.opts.nick.toLowerCase())) return;

    for (const handler of this.instructionHandlers) {
      handler(text, senderNick, channel);
    }
  }

  // ── Private: sending ─────────────────────────────────────────────

  private sendRawLine(line: string): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(line + '\r\n');
    }
  }

  private sendPrivmsg(channel: string, text: string): void {
    if (!this.connected || !this.socket) return;
    const channelName = channel.startsWith('#') ? channel : `#${channel}`;
    // IRC PRIVMSG has a ~512 byte line limit, but modern servers (Ergo) allow more.
    // Split on newlines to avoid sending multiline as one IRC message.
    const lines = text.split('\n');
    for (const line of lines) {
      if (line.length > 0) {
        this.sendRawLine(`PRIVMSG ${channelName} :${line}`);
      }
    }
  }

  // ── Private: keepalive ───────────────────────────────────────────

  private startPingKeepalive(): void {
    this.stopPingKeepalive();
    this.pingTimer = setInterval(() => {
      if (!this.connected || this.pendingPing) return;
      this.pendingPing = true;
      this.sendRawLine('PING :calliope');
      // If no PONG arrives within PING_TIMEOUT_MS, declare the connection dead
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.pendingPing = false;
        this.connected = false;
        this.cleanupSocket();
        this.scheduleReconnect();
      }, ScuttlebotIRCClient.PING_TIMEOUT_MS);
    }, ScuttlebotIRCClient.PING_INTERVAL_MS);
  }

  private stopPingKeepalive(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.pendingPing = false;
  }

  /**
   * Register SIGINT/SIGTERM handlers so we send QUIT before the process exits.
   * Uses a synchronous write — the OS TCP stack will flush it even if the
   * event loop drains immediately afterward.
   */
  private registerExitHandler(): void {
    this.unregisterExitHandler();
    this.exitHandler = () => {
      if (this.socket && !this.socket.destroyed) {
        try { this.socket.write('QUIT :Session ended\r\n'); } catch { /* ignore */ }
        try { this.socket.destroy(); } catch { /* ignore */ }
      }
    };
    process.once('SIGINT',  this.exitHandler);
    process.once('SIGTERM', this.exitHandler);
  }

  private unregisterExitHandler(): void {
    if (this.exitHandler) {
      process.off('SIGINT',  this.exitHandler);
      process.off('SIGTERM', this.exitHandler);
      this.exitHandler = null;
    }
  }

  // ── Private: reconnection ────────────────────────────────────────

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.destroyed) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect || this.destroyed) return;

      this.buffer = '';
      this.saslState = 'none';
      this.createConnection();
    }, this.reconnectDelay);

    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s max
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
  }

  private cleanupSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      if (!this.socket.destroyed) {
        this.socket.destroy();
      }
      this.socket = null;
    }
    this.connected = false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function parseHostPort(addr: string): [string, string] {
  const lastColon = addr.lastIndexOf(':');
  if (lastColon === -1) {
    return [addr, '6667'];
  }
  return [addr.slice(0, lastColon), addr.slice(lastColon + 1)];
}

/** Extract nick from an IRC prefix like "nick!user@host" or just "nick". */
function extractNick(prefix: string): string {
  const bang = prefix.indexOf('!');
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

interface ParsedIRCMessage {
  prefix: string;
  command: string;
  params: string[];
}

/**
 * Parse a single IRC protocol line into prefix, command, and params.
 * Handles the :prefix, trailing :param, and standard space-separated params.
 */
function parseIRCMessage(line: string): ParsedIRCMessage | null {
  let idx = 0;
  let prefix = '';

  // Optional prefix
  if (line[0] === ':') {
    const spaceIdx = line.indexOf(' ', 1);
    if (spaceIdx === -1) return null;
    prefix = line.slice(1, spaceIdx);
    idx = spaceIdx + 1;
  }

  // Skip whitespace
  while (idx < line.length && line[idx] === ' ') idx++;

  // Command
  const cmdEnd = line.indexOf(' ', idx);
  if (cmdEnd === -1) {
    return { prefix, command: line.slice(idx).toUpperCase(), params: [] };
  }
  const command = line.slice(idx, cmdEnd).toUpperCase();
  idx = cmdEnd + 1;

  // Skip whitespace
  while (idx < line.length && line[idx] === ' ') idx++;

  // Parameters
  const params: string[] = [];
  while (idx < line.length) {
    if (line[idx] === ':') {
      // Trailing parameter — rest of the line
      params.push(line.slice(idx + 1));
      break;
    }
    const nextSpace = line.indexOf(' ', idx);
    if (nextSpace === -1) {
      params.push(line.slice(idx));
      break;
    }
    params.push(line.slice(idx, nextSpace));
    idx = nextSpace + 1;
    while (idx < line.length && line[idx] === ' ') idx++;
  }

  return { prefix, command, params };
}
