/**
 * Scuttlebot Integration
 * 
 * Native scuttlebot support for Calliope CLI.
 * Enables real-time IRC mirroring and operator intervention.
 */

export { scuttlebotClient } from './client.js';
export type { ScuttlebotIntegration } from './client.js';
export type { ScuttlebotConfig, Message, AgentRegistration } from './http-client.js';
