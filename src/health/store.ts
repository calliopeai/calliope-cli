/** Immutable per-event files avoid a shared append offset across CLI processes. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import * as config from '../config.js';
import type { HealthEvent, HealthObservation, HealthSettings } from './types.js';

export const DEFAULT_HEALTH_SETTINGS: Readonly<HealthSettings> = {
  retentionEvents: 1000, retentionDays: 30, failureThreshold: 3,
  failureWindowMs: 300000, quarantineMs: 60000, probeTimeoutMs: 10000,
};
const limits: Record<keyof HealthSettings, [number, number]> = {
  retentionEvents: [10, 10000], retentionDays: [1, 365], failureThreshold: [1, 100],
  failureWindowMs: [1000, 86400000], quarantineMs: [1000, 86400000], probeTimeoutMs: [100, 60000],
};
export function healthSettings(overrides: Partial<HealthSettings> = {}): HealthSettings {
  const settings = { ...DEFAULT_HEALTH_SETTINGS, ...overrides };
  for (const key of Object.keys(settings) as (keyof HealthSettings)[]) {
    const value = settings[key], range = limits[key];
    if (!range || !Number.isInteger(value) || value < range[0] || value > range[1]) throw new Error('Invalid provider health settings');
  }
  return settings;
}
export function healthDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonical((item as Record<string, unknown>)[key])).join(',') + '}';
    return JSON.stringify(item);
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const eventName = /^\d{13}-[0-9a-f-]{36}\.json$/;
const fields = new Set(['version', 'id', 'at', 'source', 'originId', 'sha256', 'provider', 'target', 'type', 'outcome', 'durationMs', 'retryIndex', 'failure', 'httpStatus', 'modelCount', 'capabilities', 'evidenceHash']);
const failures = ['authentication', 'quota', 'rate_limit', 'timeout', 'network', 'server', 'invalid_request', 'response', 'unknown'];

/** No free-form error/message/model/endpoint strings are accepted at this boundary. */
export function validateHealthEvent(value: unknown, now = Date.now()): HealthEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider health event');
  const e = value as HealthEvent;
  const invalid = () => { throw new Error('Invalid provider health event schema or integrity'); };
  if (Object.keys(e).some(key => !fields.has(key)) || e.version !== 1 || !uuid.test(e.id) ||
      !hash.test(e.target) || !config.getProviderNames().includes(e.provider) ||
      !['attempt', 'discovery', 'conformance', 'reset'].includes(e.type) ||
      !['local', 'imported'].includes(e.source) || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) ||
      Date.parse(e.at) > now + 300000 || new Date(e.at).toISOString() !== e.at ||
      (e.source === 'imported' ? !uuid.test(e.originId ?? '') : e.originId !== undefined)) invalid();
  for (const key of ['durationMs', 'retryIndex', 'httpStatus', 'modelCount'] as const) {
    const n = e[key];
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > (key === 'durationMs' ? 86400000 : key === 'modelCount' ? 1000000 : key === 'httpStatus' ? 599 : 100))) invalid();
  }
  if (e.httpStatus !== undefined && e.httpStatus < 100) invalid();
  if (e.failure !== undefined && !failures.includes(e.failure)) invalid();
  if (e.type === 'reset') {
    if (Object.keys(e).some(key => !['version', 'id', 'at', 'source', 'originId', 'sha256', 'provider', 'target', 'type'].includes(key))) invalid();
  } else if (!['success', 'error', 'timeout', 'cancelled'].includes(e.outcome ?? '')) invalid();
  if (e.capabilities !== undefined) {
    if (!e.capabilities || typeof e.capabilities !== 'object' || Array.isArray(e.capabilities) ||
        Object.entries(e.capabilities).some(([key, val]) => !['tools', 'streaming', 'cancellation', 'usage'].includes(key) || typeof val !== 'boolean')) invalid();
  }
  if (e.evidenceHash !== undefined && !hash.test(e.evidenceHash)) invalid();
  if (e.type === 'conformance' && !e.evidenceHash) invalid();
  const { sha256, ...body } = e;
  if (!hash.test(sha256) || healthDigest(body) !== sha256) invalid();
  return e;
}

export class HealthStore {
  readonly settings: HealthSettings;
  constructor(readonly directory = process.env.CALLIOPE_HEALTH_DIR || join(homedir(), '.calliope-cli', 'provider-health'), settings: Partial<HealthSettings> = config.get('providerHealth') ?? {}, private readonly clock: () => number = Date.now) {
    this.settings = healthSettings(settings);
    if (process.env.VITEST && !process.env.CALLIOPE_CONFIG_DIR) throw new Error('Provider health tests require isolated stores');
  }

  private names(): string[] {
    try {
      if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('Invalid health directory');
      return fs.readdirSync(this.directory).filter(name => eventName.test(name)).sort();
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Provider health history is unreadable'); }
  }
  private retained(names: string[]): string[] {
    const cutoff = this.clock() - this.settings.retentionDays * 86400000;
    return names.filter(name => Number(name.slice(0, 13)) >= cutoff).slice(-this.settings.retentionEvents);
  }
  read(): HealthEvent[] {
    return this.retained(this.names()).flatMap(name => {
      try {
        const file = join(this.directory, name);
        if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4096) throw new Error('Invalid health event file');
        const event = validateHealthEvent(JSON.parse(fs.readFileSync(file, 'utf8')), this.clock());
        if (name !== this.filename(event)) throw new Error('Invalid health event identity');
        return [event];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; // Concurrent retention.
        throw new Error('Provider health history failed validation; inspect or restore the local history');
      }
    });
  }
  private filename(event: HealthEvent): string { return `${Date.parse(event.at).toString().padStart(13, '0')}-${event.id}.json`; }
  append(observation: HealthObservation): HealthEvent {
    // Preserve causal order for sequential writers even within one clock tick.
    const newest = Number(this.names().at(-1)?.slice(0, 13) ?? 0);
    const at = new Date(Math.max(this.clock(), newest + 1)).toISOString();
    const body = { ...observation, version: 1 as const, id: randomUUID(), at, source: 'local' as const };
    const event = validateHealthEvent({ ...body, sha256: healthDigest(body) }, this.clock());
    this.publish([event]);
    return event;
  }
  private publish(events: HealthEvent[]): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('Provider health directory must not be a symlink');
    for (const event of events) {
      const temp = join(this.directory, `.${randomUUID()}.tmp`);
      const fd = fs.openSync(temp, 'wx', 0o600);
      try {
        try { fs.writeFileSync(fd, JSON.stringify(event) + '\n'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.linkSync(temp, join(this.directory, this.filename(event)));
      }
      finally { fs.unlinkSync(temp); }
    }
    const names = this.names(), keep = new Set(this.retained(names));
    for (const name of names) if (!keep.has(name)) {
      try { fs.unlinkSync(join(this.directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Provider health retention failed'); }
    }
  }
  export(): { version: 1; events: HealthEvent[] } { return { version: 1, events: this.read() }; }
  import(value: unknown): number {
    const bundle = value as { version?: unknown; events?: unknown };
    if (!bundle || bundle.version !== 1 || Object.keys(bundle).some(key => !['version', 'events'].includes(key)) ||
        !Array.isArray(bundle.events) || bundle.events.length > this.settings.retentionEvents) throw new Error('Invalid provider health import');
    const existing = new Set(this.read().map(event => event.originId ?? event.id));
    const validated = bundle.events.map(event => validateHealthEvent(event, this.clock()));
    // Validate the entire document before publishing any event. Imported resets,
    // failures and capabilities cannot alter local quarantine or routing state.
    const imported = validated.flatMap(event => {
      const originId = event.originId ?? event.id;
      if (existing.has(originId)) return [];
      existing.add(originId);
      const { sha256: _sha, ...body } = event;
      const importedBody = { ...body, id: randomUUID(), source: 'imported' as const, originId };
      return [{ ...importedBody, sha256: healthDigest(importedBody) }];
    });
    this.publish(imported);
    return imported.length;
  }
}
