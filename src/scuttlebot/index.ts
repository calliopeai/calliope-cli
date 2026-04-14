/**
 * Scuttlebot Integration
 *
 * Native scuttlebot support for Calliope CLI.
 * Registers via HTTP API, then connects directly to IRC for
 * real-time mirroring and operator intervention.
 */

export { scuttlebotClient } from './client.js';
export type { ScuttlebotIntegration } from './client.js';
export type { ScuttlebotConfig, AgentCredentials } from './http-client.js';
export type { Envelope, IRCClientOptions } from './irc-client.js';
export { ScuttlebotIRCClient, matchesRecipient, newEnvelope, MessageTypes } from './irc-client.js';
