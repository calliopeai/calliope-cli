/**
 * Scuttlebot HTTP API Client
 *
 * Provides HTTP-based transport for scuttlebot integration.
 * Used when SCUTTLEBOT_TRANSPORT=http or as a fallback.
 */

export interface ScuttlebotConfig {
  url: string;
  token: string;
  channel: string;
  channels?: string[];
  nick?: string;
  transport?: 'http' | 'irc';
}

export interface Message {
  nick: string;
  text: string;
  timestamp: string;
}

export interface AgentRegistration {
  nick: string;
  password: string;
  agentType?: string;
}

export class ScuttlebotHTTPClient {
  private config: ScuttlebotConfig;
  private lastCheckTimestamp: string;

  constructor(config: ScuttlebotConfig) {
    this.config = config;
    this.lastCheckTimestamp = new Date().toISOString();
  }

  /**
   * Register an agent and get IRC credentials
   */
  async register(nick: string, agentType?: string): Promise<AgentRegistration> {
    const url = `${this.config.url}/v1/agents/register`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        nick,
        agent_type: agentType || 'calliope',
      }),
    });

    if (!response.ok) {
      throw new Error(`Registration failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    return {
      nick: data.nick,
      password: data.password,
      agentType: data.agent_type,
    };
  }

  /**
   * Post a message to a channel via HTTP
   */
  async postMessage(channel: string, text: string, nick?: string): Promise<void> {
    const channelName = channel.startsWith('#') ? channel.slice(1) : channel;
    const url = `${this.config.url}/v1/channels/${channelName}/messages`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        nick: nick || this.config.nick || 'calliope',
        text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to post message: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Get recent messages from a channel
   */
  async getMessages(channel: string, since?: string): Promise<Message[]> {
    const channelName = channel.startsWith('#') ? channel.slice(1) : channel;
    const url = `${this.config.url}/v1/channels/${channelName}/messages`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get messages: ${response.status} ${response.statusText}`);
    }

    const messages = await response.json() as Message[];
    
    // Filter to messages after the given timestamp
    if (since) {
      return messages.filter(m => m.timestamp > since);
    }
    
    return messages;
  }

  /**
   * Poll for new messages addressed to this session
   */
  async pollForInstructions(myNick: string, serviceBots: Set<string>): Promise<string | null> {
    const newMessages = await this.getMessages(
      this.config.channel,
      this.lastCheckTimestamp
    );

    if (newMessages.length === 0) {
      return null;
    }

    // Update timestamp for next poll
    this.lastCheckTimestamp = newMessages[newMessages.length - 1].timestamp;

    // Filter to messages mentioning this session
    const addressed = newMessages.filter(msg => {
      // Skip self
      if (msg.nick === myNick) return false;
      
      // Skip service bots
      if (serviceBots.has(msg.nick)) return false;
      
      // Skip other agent sessions
      if (msg.nick.match(/^(claude|codex|gemini|calliope)-/)) return false;
      
      // Must mention our nick
      return msg.text.includes(myNick);
    });

    if (addressed.length === 0) {
      return null;
    }

    // Return the most recent addressed message
    return addressed[addressed.length - 1].text;
  }

  /**
   * Check server health
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
