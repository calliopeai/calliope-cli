/**
 * Scuttlebot Integration Client
 *
 * Main integration point for scuttlebot. Registers via HTTP API, then connects
 * directly to IRC for all runtime messaging. No HTTP polling.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ScuttlebotHTTPClient, type ScuttlebotConfig } from './http-client.js';
import { ScuttlebotIRCClient, MessageTypes, newEnvelope } from './irc-client.js';
import { resolveChannelConfig } from './config.js';

/**
 * Load ~/.config/scuttlebot-relay.env as a fallback env source.
 * Returns a map of KEY → value for SCUTTLEBOT_* variables not already set in process.env.
 */
function loadRelayEnv(): Record<string, string> {
  const envFile = path.join(os.homedir(), '.config', 'scuttlebot-relay.env');
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    const result: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && val && !(key in process.env)) {
        result[key] = val;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Keys that should be picked up from the relay env file.
 * Project-specific keys (CHANNEL, NICK, PASSPHRASE) are intentionally excluded
 * so they don't bleed across projects.
 */
const RELAY_ENV_KEYS = new Set([
  'SCUTTLEBOT_URL',
  'SCUTTLEBOT_TOKEN',
  'SCUTTLEBOT_IRC_ADDR',
]);

/** Get a config value: process.env first, then relay env file fallback (server-level keys only). */
function getEnv(key: string, relayEnv: Record<string, string>): string | undefined {
  return process.env[key] ?? (RELAY_ENV_KEYS.has(key) ? relayEnv[key] : undefined);
}

export interface ScuttlebotIntegration {
  enabled: boolean;
  config?: ScuttlebotConfig;
  nick?: string;
  connected: boolean;
}

/**
 * Generate an 8-char hex session ID from cwd+pid+time — mirrors the relay's
 * defaultSessionID(target) which uses CRC32(path|pid|ppid|nanotime).
 */
function defaultSessionID(cwd: string): string {
  const input = `${cwd}|${process.pid}|${Date.now()}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Strip the addressed nick from the start of a message.
 * "calliope-calliope-cli-13f9af15: hi there" → "hi there"
 * Mirrors ircagent.TrimAddressedText from the relay.
 */
function trimAddressedText(text: string, nick: string): string {
  const trimmed = text.trim();
  // Match "nick: ", "nick, ", "nick " at start (case-insensitive)
  const prefix = new RegExp(`^${nick.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}[:\\s,]+`, 'i');
  return trimmed.replace(prefix, '').trim() || trimmed;
}

/** Sanitize a string for use as an IRC nick (matches relay's sanitize()). */
function sanitizeNick(value: string): string {
  let result = '';
  for (const ch of value) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') || ch === '-' || ch === '_') {
      result += ch;
    } else {
      result += '-';
    }
  }
  result = result.replace(/^-+|-+$/g, '');
  return result || 'session';
}

export class ScuttlebotClient {
  private httpClient: ScuttlebotHTTPClient | null = null;
  private ircClient: ScuttlebotIRCClient | null = null;
  private config: ScuttlebotConfig | null = null;
  private nick: string = '';
  private enabled: boolean = false;
  private registeredByClient = false; // track if we registered (for delete-on-close)
  private instructionHandler: ((instruction: string) => void) | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly PRESENCE_INTERVAL_MS = 60_000; // touch every 60s

  /**
   * Initialize from environment variables.
   *
   * Flow: resolve config -> register via HTTP -> connect IRC -> send agent.hello.
   */
  async initialize(sessionId: string, cwd: string): Promise<boolean> {
    // Load ~/.config/scuttlebot-relay.env as fallback (same source the relay agents use)
    const relayEnv = loadRelayEnv();

    // SCUTTLEBOT_PASSPHRASE = pre-registered mode (stable nick, skip HTTP registration)
    // SCUTTLEBOT_TOKEN      = dynamic registration mode (session nicks via HTTP API)
    const passphrase = getEnv('SCUTTLEBOT_PASSPHRASE', relayEnv);
    const token = getEnv('SCUTTLEBOT_TOKEN', relayEnv);

    if (!passphrase && !token) {
      this.enabled = false;
      return false;
    }

    const resolved = resolveChannelConfig(
      cwd,
      getEnv('SCUTTLEBOT_CHANNEL', relayEnv),
      getEnv('SCUTTLEBOT_CHANNELS', relayEnv),
    );
    const { channel, channels } = resolved;

    // IRC addr: env var > yaml > relay env > local default
    const ircAddr = getEnv('SCUTTLEBOT_IRC_ADDR', relayEnv) || resolved.ircAddr || '127.0.0.1:6667';
    const useTLS = resolved.tls ?? ircAddr.endsWith(':6697');

    // URL: env var > yaml > relay env
    const url = getEnv('SCUTTLEBOT_URL', relayEnv) || resolved.url || '';

    this.config = {
      url,
      token: token || '',
      ircAddr,
      channel,
      channels,
      nick: this.nick,
    };

    try {
      let ircNick: string;
      let ircPassphrase: string;

      if (passphrase) {
        // Pre-registered mode: use provided nick + passphrase, no HTTP call needed
        ircNick = getEnv('SCUTTLEBOT_NICK', relayEnv) || resolved.nick || 'calliope';
        ircPassphrase = passphrase;
        this.nick = ircNick;
        // Create HTTP client for presence/touch if URL+token available
        if (url && token) {
          this.httpClient = new ScuttlebotHTTPClient(this.config);
        }
      } else {
        // Dynamic registration mode: get session credentials via HTTP API
        if (!url || !token) {
          this.enabled = false;
          return false;
        }
        // Generate session nick: calliope-{basename}-{8hex} — matches relay pattern
        const basename = sanitizeNick(path.basename(cwd));
        const sessionSuffix = defaultSessionID(cwd);
        this.nick = sanitizeNick(
          getEnv('SCUTTLEBOT_NICK', relayEnv) || `calliope-${basename}-${sessionSuffix}`
        );

        this.httpClient = new ScuttlebotHTTPClient(this.config);
        const credentials = await this.httpClient.register(this.nick, 'worker', channels);
        ircNick = credentials.nick;
        ircPassphrase = credentials.passphrase;
        this.nick = ircNick;
        this.registeredByClient = true;
      }

      // Connect to IRC
      this.ircClient = new ScuttlebotIRCClient({
        serverAddr: ircAddr,
        nick: ircNick,
        passphrase: ircPassphrase,
        channels: channels.map(c => c.startsWith('#') ? c : `#${c}`),
        agentType: 'worker',
        tls: useTLS,
      });

      // Wire up envelope handler — deliver task.create to instruction handler
      this.ircClient.onEnvelope((env, _channel) => {
        if (env.type === MessageTypes.TaskCreate && this.instructionHandler) {
          // Extract instruction text from payload
          const payload = env.payload as Record<string, unknown> | undefined;
          const instruction = payload?.instruction ?? payload?.prompt ?? payload?.text ?? JSON.stringify(payload);
          this.instructionHandler(String(instruction));
        }
      });

      // Wire up human instruction handler — strip the addressing prefix before delivery
      // e.g. "calliope-calliope-cli-13f9af15: hi" → "hi"
      this.ircClient.onInstruction((text, _from, _channel) => {
        if (this.instructionHandler) {
          this.instructionHandler(trimAddressedText(text, this.nick));
        }
      });

      await this.ircClient.connect();

      // 3. Announce presence — IRC envelope + registry touch
      this.sendHello();
      await this.touchPresence();

      // 4. Heartbeat — keep registry showing agent as online
      this.presenceTimer = setInterval(() => {
        void this.touchPresence();
      }, ScuttlebotClient.PRESENCE_INTERVAL_MS);

      this.enabled = true;
      return true;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to initialize scuttlebot:', error instanceof Error ? error.message : String(error));
      this.enabled = false;
      return false;
    }
  }

  /**
   * Post a plain text message to the primary channel.
   */
  async postMessage(text: string): Promise<void> {
    if (!this.enabled || !this.config || !this.ircClient) return;
    this.ircClient.sendRaw(this.config.channel, this.sanitizeSecrets(text));
  }

  /**
   * Post online presence (agent.hello envelope).
   */
  async postOnline(): Promise<void> {
    this.sendHello();
  }

  /**
   * Post offline presence (agent.bye envelope).
   */
  async postOffline(): Promise<void> {
    this.sendBye();
  }

  /**
   * Mirror a tool call as a plain text status message.
   */
  async mirrorToolCall(toolName: string, args?: unknown): Promise<void> {
    if (!this.enabled || !this.config || !this.ircClient) return;

    let text = toolName;
    if (args && typeof args === 'object') {
      const argsObj = args as Record<string, unknown>;
      if ('path' in argsObj) text += ` ${argsObj.path}`;
      if ('command' in argsObj) text += ` ${argsObj.command}`;
      if ('pattern' in argsObj) text += ` ${argsObj.pattern}`;
    }

    this.ircClient.sendRaw(this.config.channel, this.sanitizeSecrets(text));
  }

  /**
   * Mirror assistant message as plain text.
   */
  async mirrorAssistant(message: string): Promise<void> {
    if (!this.enabled || !this.config || !this.ircClient) return;

    const truncated = message.length > 200
      ? message.slice(0, 197) + '...'
      : message;

    this.ircClient.sendRaw(this.config.channel, this.sanitizeSecrets(truncated));
  }

  /**
   * Register an instruction handler for incoming tasks/commands.
   */
  startPolling(handler: (instruction: string) => void): void {
    this.instructionHandler = handler;
  }

  /**
   * Stop listening for instructions.
   */
  stopPolling(): void {
    this.instructionHandler = null;
  }

  /**
   * Disconnect and cleanup.
   */
  async disconnect(): Promise<void> {
    this.stopPolling();

    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }

    if (this.ircClient) {
      this.sendBye();
      await this.ircClient.disconnect();
      this.ircClient = null;
    }

    // Delete session registration so it doesn't linger in the registry
    if (this.registeredByClient && this.httpClient && this.nick) {
      await this.httpClient.deleteAgent(this.nick);
    }

    this.httpClient = null;
    this.registeredByClient = false;
    this.enabled = false;
  }

  /**
   * Get integration status.
   */
  getStatus(): ScuttlebotIntegration {
    return {
      enabled: this.enabled,
      config: this.config || undefined,
      nick: this.nick || undefined,
      connected: this.ircClient?.isConnected() || false,
    };
  }

  /**
   * Check if enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private sendHello(): void {
    if (!this.ircClient || !this.config) return;
    this.ircClient.sendEnvelope(this.config.channel, {
      v: 1,
      type: MessageTypes.AgentHello,
      from: this.nick,
    });
  }

  private sendBye(): void {
    if (!this.ircClient || !this.config) return;
    this.ircClient.sendEnvelope(this.config.channel, {
      v: 1,
      type: MessageTypes.AgentBye,
      from: this.nick,
    });
  }

  /**
   * Touch presence via HTTP API so the registry marks this agent as online.
   * Best-effort — skipped silently if no URL/token configured.
   */
  private async touchPresence(): Promise<void> {
    if (!this.httpClient || !this.config?.channel || !this.nick) return;
    await this.httpClient.touchPresence(this.config.channel, this.nick);
  }

  /**
   * Sanitize secrets from text before posting.
   */
  private sanitizeSecrets(text: string): string {
    let sanitized = text;

    // Hex secrets (32+ chars)
    sanitized = sanitized.replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED]');

    // API keys (sk-...)
    sanitized = sanitized.replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]');

    // Bearer tokens
    sanitized = sanitized.replace(/bearer\s+[A-Za-z0-9._:-]+/gi, 'bearer [REDACTED]');

    // Environment variable assignments
    sanitized = sanitized.replace(
      /\b([A-Z0-9_]*(TOKEN|KEY|SECRET|PASSPHRASE)[A-Z0-9_]*)=([^ \t"'`]+)/gi,
      '$1=[REDACTED]',
    );

    return sanitized;
  }
}

// Singleton instance
export const scuttlebotClient = new ScuttlebotClient();
