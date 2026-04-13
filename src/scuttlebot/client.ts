/**
 * Scuttlebot Integration Client
 *
 * Main integration point for scuttlebot. Handles both HTTP and IRC transports,
 * mirrors tool calls and assistant messages, and polls for operator instructions.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { ScuttlebotHTTPClient, type ScuttlebotConfig } from './http-client.js';
import { ScuttlebotIRCClient } from './irc-client.js';
import { resolveChannelConfig } from './config.js';

export interface ScuttlebotIntegration {
  enabled: boolean;
  config?: ScuttlebotConfig;
  nick?: string;
  connected: boolean;
}

export class ScuttlebotClient {
  private httpClient: ScuttlebotHTTPClient | null = null;
  private ircClient: ScuttlebotIRCClient | null = null;
  private config: ScuttlebotConfig | null = null;
  private nick: string = '';
  private enabled: boolean = false;
  private transport: 'http' | 'irc' = 'http';
  private pollInterval: NodeJS.Timeout | null = null;
  private instructionHandler: ((instruction: string) => void) | null = null;
  private serviceBots = new Set([
    'bridge', 'oracle', 'sentinel', 'steward', 'scribe',
    'warden', 'snitch', 'herald', 'scroll', 'systembot', 'auditbot'
  ]);

  /**
   * Initialize from environment variables
   */
  async initialize(sessionId: string, cwd: string): Promise<boolean> {
    // Check if scuttlebot is configured
    const url = process.env.SCUTTLEBOT_URL;
    const token = process.env.SCUTTLEBOT_TOKEN;

    if (!url || !token) {
      this.enabled = false;
      return false;
    }

    const { channel, channels } = resolveChannelConfig(
      cwd,
      process.env.SCUTTLEBOT_CHANNEL,
      process.env.SCUTTLEBOT_CHANNELS
    );

    // Generate session nick: calliope-{basename}-{session}
    const basename = path.basename(cwd);
    const sessionSuffix = sessionId.slice(0, 8);
    this.nick = process.env.SCUTTLEBOT_NICK || `calliope-${basename}-${sessionSuffix}`;

    // Determine transport
    this.transport = (process.env.SCUTTLEBOT_TRANSPORT as 'http' | 'irc') || 'http';

    this.config = {
      url,
      token,
      channel,
      channels,
      nick: this.nick,
      transport: this.transport,
    };

    // Initialize appropriate client
    if (this.transport === 'irc') {
      await this.initializeIRC();
    } else {
      await this.initializeHTTP();
    }

    this.enabled = true;
    return true;
  }

  /**
   * Initialize HTTP transport
   */
  private async initializeHTTP(): Promise<void> {
    if (!this.config) throw new Error('Config not initialized');
    
    this.httpClient = new ScuttlebotHTTPClient(this.config);
    
    // Check server health
    const healthy = await this.httpClient.healthCheck();
    if (!healthy) {
      console.warn('⚠️  Scuttlebot server health check failed');
    }
  }

  /**
   * Initialize IRC transport
   */
  private async initializeIRC(): Promise<void> {
    if (!this.config) throw new Error('Config not initialized');
    
    this.ircClient = new ScuttlebotIRCClient({
      ...this.config,
      ircAddr: process.env.SCUTTLEBOT_IRC_ADDR,
      ircPassword: process.env.SCUTTLEBOT_IRC_PASS,
    });

    // Register to get credentials if no password provided
    if (!process.env.SCUTTLEBOT_IRC_PASS) {
      this.httpClient = new ScuttlebotHTTPClient(this.config);
      const registration = await this.httpClient.register(this.nick);
      await this.ircClient.connect(registration.nick, registration.password);
    } else {
      await this.ircClient.connect(this.nick, process.env.SCUTTLEBOT_IRC_PASS);
    }

    // Set up message handler
    this.ircClient.onMessage((nick, channel, text) => {
      if (this.instructionHandler) {
        this.instructionHandler(text);
      }
    });
  }

  /**
   * Post a message to the channel
   */
  async postMessage(text: string): Promise<void> {
    if (!this.enabled || !this.config) return;

    try {
      if (this.transport === 'irc' && this.ircClient) {
        await this.ircClient.sendMessage(this.config.channel, text);
      } else if (this.httpClient) {
        await this.httpClient.postMessage(this.config.channel, text, this.nick);
      }
    } catch (error) {
      console.error('Failed to post to scuttlebot:', error);
    }
  }

  /**
   * Post online presence
   */
  async postOnline(): Promise<void> {
    await this.postMessage('online');
  }

  /**
   * Post offline presence
   */
  async postOffline(): Promise<void> {
    await this.postMessage('offline');
  }

  /**
   * Mirror a tool call
   */
  async mirrorToolCall(toolName: string, args?: unknown): Promise<void> {
    if (!this.enabled) return;
    
    let text = toolName;
    if (args && typeof args === 'object') {
      const argsObj = args as Record<string, unknown>;
      // Add key arguments for context
      if ('path' in argsObj) text += ` ${argsObj.path}`;
      if ('command' in argsObj) text += ` ${argsObj.command}`;
      if ('pattern' in argsObj) text += ` ${argsObj.pattern}`;
    }
    
    await this.postMessage(this.sanitizeSecrets(text));
  }

  /**
   * Mirror assistant message
   */
  async mirrorAssistant(message: string): Promise<void> {
    if (!this.enabled) return;
    
    // Truncate long messages
    const truncated = message.length > 200 
      ? message.slice(0, 197) + '...'
      : message;
    
    await this.postMessage(`💬 ${this.sanitizeSecrets(truncated)}`);
  }

  /**
   * Start polling for operator instructions (HTTP mode only)
   */
  startPolling(handler: (instruction: string) => void): void {
    if (this.transport === 'irc') {
      // IRC mode uses real-time message handlers
      this.instructionHandler = handler;
      return;
    }

    if (!this.httpClient) return;
    
    this.instructionHandler = handler;
    
    const pollIntervalMs = parseInt(process.env.SCUTTLEBOT_POLL_INTERVAL || '2000', 10);
    
    this.pollInterval = setInterval(async () => {
      if (!this.httpClient) return;
      
      try {
        const instruction = await this.httpClient.pollForInstructions(
          this.nick,
          this.serviceBots
        );
        
        if (instruction && this.instructionHandler) {
          this.instructionHandler(instruction);
        }
      } catch (error) {
        // Silently fail on poll errors
      }
    }, pollIntervalMs);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Sanitize secrets from text before posting
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
      '$1=[REDACTED]'
    );
    
    return sanitized;
  }

  /**
   * Disconnect and cleanup
   */
  async disconnect(): Promise<void> {
    this.stopPolling();
    
    if (this.ircClient) {
      await this.ircClient.disconnect();
      this.ircClient = null;
    }
    
    this.httpClient = null;
    this.enabled = false;
  }

  /**
   * Get integration status
   */
  getStatus(): ScuttlebotIntegration {
    return {
      enabled: this.enabled,
      config: this.config || undefined,
      nick: this.nick || undefined,
      connected: this.ircClient?.isConnected() || !!this.httpClient,
    };
  }

  /**
   * Check if enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton instance
export const scuttlebotClient = new ScuttlebotClient();
