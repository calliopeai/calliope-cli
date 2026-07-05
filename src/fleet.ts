/**
 * Fleet mode — the single integration point for the scuttlebot IRC relay.
 *
 * Scuttlebot lets a fleet of agents and human operators coordinate in a
 * self-hosted IRC channel (which doubles as an audit trail). It is gated
 * behind the `fleet.enabled` config flag, default OFF. When disabled,
 * every function here is a synchronous no-op and the scuttlebot module
 * is never loaded — zero import cost, zero loop overhead.
 *
 * This file must remain the ONLY importer of src/scuttlebot/.
 */

import config from './config.js';
import type { ScuttlebotClient, ScuttlebotIntegration } from './scuttlebot/client.js';

let client: ScuttlebotClient | null = null;

/** Whether fleet mode is switched on in config (does not mean connected). */
export function fleetConfigured(): boolean {
  return config.get('fleet')?.enabled === true;
}

/** Whether the relay is loaded and active (connected or connecting). */
export function fleetActive(): boolean {
  return client !== null && client.isEnabled();
}

async function loadClient(): Promise<ScuttlebotClient> {
  if (!client) {
    const mod = await import('./scuttlebot/index.js');
    client = mod.scuttlebotClient;
  }
  return client;
}

/** Enable fleet mode in config and connect. Returns true if connected. */
export async function fleetEnable(sessionId: string, cwd: string): Promise<boolean> {
  config.set('fleet', { ...(config.get('fleet') ?? {}), enabled: true });
  return fleetInit(sessionId, cwd);
}

/** Disable fleet mode: disconnect (if loaded) and persist enabled=false. */
export async function fleetDisable(): Promise<void> {
  if (client) {
    await client.postOffline().catch(() => {});
    await client.disconnect().catch(() => {});
    client = null;
  }
  config.set('fleet', { ...(config.get('fleet') ?? {}), enabled: false });
}

/** Connect at session start. No-op unless fleet.enabled. */
export async function fleetInit(sessionId: string, cwd: string): Promise<boolean> {
  if (!fleetConfigured()) return false;
  const c = await loadClient();
  return c.initialize(sessionId, cwd);
}

export function fleetStatus(): ScuttlebotIntegration | null {
  if (!fleetActive()) return null;
  return client!.getStatus();
}

export function fleetStartPolling(onInstruction: (instruction: string) => void): void {
  if (!fleetActive()) return;
  client!.startPolling(onInstruction);
}

export function fleetPostOnline(): void {
  if (!fleetActive()) return;
  client!.postOnline().catch(() => {});
}

export async function fleetPostOffline(): Promise<void> {
  if (!fleetActive()) return;
  await client!.postOffline().catch(() => {});
  await client!.disconnect().catch(() => {});
}

export function fleetPostMessage(text: string): void {
  if (!fleetActive()) return;
  client!.postMessage(text).catch(() => {});
}

export async function fleetMirrorToolCall(name: string, args: unknown): Promise<void> {
  if (!fleetActive()) return;
  await client!.mirrorToolCall(name, args as Record<string, unknown>).catch(() => {});
}

export function fleetMirrorAssistant(content: string): void {
  if (!fleetActive()) return;
  client!.mirrorAssistant(content).catch(() => {});
}
