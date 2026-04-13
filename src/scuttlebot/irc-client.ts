/**
 * Scuttlebot IRC Socket Client
 *
 * Provides native IRC socket connection for scuttlebot integration.
 * Used when SCUTTLEBOT_TRANSPORT=irc.
 */

// @ts-ignore - irc-framework may not have types
import * as irc from 'irc-framework';
import type { ScuttlebotConfig } from './http-client.js';

export interface IRCConfig extends ScuttlebotConfig {
  ircAddr?: string;
  ircPassword?: string;
}

export class ScuttlebotIRCClient {
  private config: IRCConfig;
  private client: irc.Client | null = null;
  private connected = false;
  private messageHandlers: Array<(nick: string, channel: string, text: string) => void> = [];
  private serviceBots = new Set([
    'bridge', 'oracle', 'sentinel', 'steward', 'scribe',
    'warden', 'snitch', 'herald', 'scroll', 'systembot', 'auditbot'
  ]);

  constructor(config: IRCConfig) {
    this.config = config;
  }

  /**
   * Connect to IRC server with SASL authentication
   */
  async connect(nick: string, password?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const [host, port] = (this.config.ircAddr || '127.0.0.1:6667').split(':');
      
      this.client = new irc.Client();
      
      this.client.connect({
        host,
        port: parseInt(port, 10),
        nick,
        username: nick,
        gecos: 'Calliope AI Agent',
        tls: false, // Scuttlebot uses plaintext locally
        account: {
          account: nick,
          password: password || this.config.ircPassword || '',
        },
      });

      this.client.on('registered', () => {
        this.connected = true;
        
        // Join channels
        const channels = this.config.channels || [this.config.channel];
        for (const channel of channels) {
          const channelName = channel.startsWith('#') ? channel : `#${channel}`;
          this.client!.join(channelName);
        }
        
        resolve();
      });

      this.client.on('message', (event: any) => {
        // Filter messages
        if (event.nick === nick) return; // Skip self
        if (this.serviceBots.has(event.nick)) return; // Skip bots
        if (event.nick.match(/^(claude|codex|gemini|calliope)-/)) return; // Skip agents
        
        // Must mention our nick
        if (!event.message.includes(nick)) return;
        
        // Deliver to handlers
        for (const handler of this.messageHandlers) {
          handler(event.nick, event.target, event.message);
        }
      });

      this.client.on('close', () => {
        this.connected = false;
      });

      this.client.on('socket close', () => {
        this.connected = false;
      });

      // Timeout after 30s
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('IRC connection timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Send a message to a channel
   */
  async sendMessage(channel: string, text: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('IRC client not connected');
    }
    
    const channelName = channel.startsWith('#') ? channel : `#${channel}`;
    this.client.say(channelName, text);
  }

  /**
   * Register a message handler
   */
  onMessage(handler: (nick: string, channel: string, text: string) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Join a channel
   */
  async join(channel: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('IRC client not connected');
    }
    
    const channelName = channel.startsWith('#') ? channel : `#${channel}`;
    this.client.join(channelName);
  }

  /**
   * Part from a channel
   */
  async part(channel: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('IRC client not connected');
    }
    
    const channelName = channel.startsWith('#') ? channel : `#${channel}`;
    this.client.part(channelName);
  }

  /**
   * Disconnect from IRC
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.quit('Session ended');
      this.client = null;
      this.connected = false;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}
