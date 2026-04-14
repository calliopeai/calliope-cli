/**
 * Scuttlebot HTTP API Client
 *
 * Provides agent registration and health check via the scuttlebot HTTP API.
 * All runtime messaging goes through IRC (see irc-client.ts).
 */

export interface ScuttlebotConfig {
  /** HTTP API base URL for registration (e.g. "http://localhost:3000"). */
  url: string;
  /** API bearer token. */
  token: string;
  /** IRC server address, host:port (e.g. "127.0.0.1:6667"). */
  ircAddr: string;
  /** Primary channel (no # prefix). */
  channel: string;
  /** All channels (no # prefix). */
  channels: string[];
  /** Agent nick. */
  nick?: string;
}

export interface AgentCredentials {
  nick: string;
  passphrase: string;
}

export class ScuttlebotHTTPClient {
  private config: ScuttlebotConfig;

  constructor(config: ScuttlebotConfig) {
    this.config = config;
  }

  /**
   * Register an agent (or rotate if already registered) and return IRC credentials.
   *
   * Mirrors the relay's registerOrRotate logic:
   *   POST /v1/agents/register → 201 Created: use passphrase
   *                            → 409 Conflict: rotate instead
   *   POST /v1/agents/{nick}/rotate → use new passphrase
   */
  async register(nick: string, agentType?: string, channels?: string[]): Promise<AgentCredentials> {
    const raw = channels || this.config.channels;
    const channelList = raw.map(c => c.startsWith('#') ? c : `#${c}`);
    const registerResp = await fetch(`${this.config.url}/v1/agents/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        nick,
        type: agentType || 'worker',
        channels: channelList,
      }),
    });

    if (registerResp.status === 201) {
      const data = await registerResp.json() as {
        credentials: { nick: string; passphrase: string };
      };
      return { nick: data.credentials.nick, passphrase: data.credentials.passphrase };
    }

    if (registerResp.status === 409) {
      // Nick already registered — rotate to get fresh credentials
      return this.rotate(nick);
    }

    const body = await registerResp.text().catch(() => '');
    throw new Error(`Registration failed: ${registerResp.status} ${registerResp.statusText}${body ? ` — ${body}` : ''}`);
  }

  /**
   * Rotate credentials for an existing agent nick.
   *
   * POST /v1/agents/{nick}/rotate
   */
  async rotate(nick: string): Promise<AgentCredentials> {
    const response = await fetch(`${this.config.url}/v1/agents/${nick}/rotate`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.config.token}` },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Rotate failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
    }

    const data = await response.json() as { passphrase: string };
    return { nick, passphrase: data.passphrase };
  }

  /**
   * Delete agent registration on close (session cleanup).
   *
   * DELETE /v1/agents/{nick}
   */
  async deleteAgent(nick: string): Promise<void> {
    try {
      await fetch(`${this.config.url}/v1/agents/${nick}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${this.config.token}` },
      });
    } catch {
      // Best-effort
    }
  }

  /**
   * Touch presence for a nick in a channel — marks the agent as online
   * in the registry. Required for the admin UI to show the agent as live.
   *
   * POST /v1/channels/{channel}/presence
   */
  async touchPresence(channel: string, nick: string): Promise<void> {
    if (!this.config.url || !this.config.token) return;
    const channelName = channel.startsWith('#') ? channel.slice(1) : channel;
    try {
      await fetch(`${this.config.url}/v1/channels/${channelName}/presence`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ nick }),
      });
    } catch {
      // Silently fail — presence is best-effort
    }
  }

  /**
   * Check server health.
   *
   * GET /v1/status
   */
  async healthCheck(): Promise<boolean> {
    try {
      const url = `${this.config.url}/v1/status`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.token}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
