import { isCancellation } from '../cancellation.js';
import type { Capability, FailureKind, HealthEvent, HealthSettings, HealthSnapshot, HealthTarget } from './types.js';

/** Classify without copying any upstream text, request IDs or credentials. */
export function healthFailure(error: unknown): { failure: FailureKind; httpStatus?: number } {
  const e = error as { status?: unknown; name?: unknown; message?: unknown; code?: unknown } | undefined;
  const parsedStatus = typeof e?.message === 'string' ? Number(e.message.match(/(?:HTTP|API error:|returned)\s*(\d{3})/i)?.[1]) : NaN;
  const status = typeof e?.status === 'number' ? e.status : parsedStatus;
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  const text = [e?.name, e?.message, e?.code].filter(value => typeof value === 'string').join(' ').toLowerCase();
  const failure: FailureKind = /quota|credit_balance|billing/.test(text) ? 'quota'
    : httpStatus === 401 || httpStatus === 403 ? 'authentication'
    : httpStatus === 429 ? 'rate_limit'
    : httpStatus === 408 || httpStatus === 504 || /timeout|timed out|etimedout/.test(text) ? 'timeout'
    : httpStatus && httpStatus >= 500 ? 'server'
    : httpStatus && httpStatus >= 400 ? 'invalid_request'
    : /econn|enotfound|network|fetch failed|connection/.test(text) ? 'network' : 'unknown';
  return { failure, ...(httpStatus === undefined ? {} : { httpStatus }) };
}
export function healthOutcome(error: unknown, signal?: AbortSignal): 'cancelled' | 'timeout' | 'error' {
  if (signal?.aborted || isCancellation(error)) return signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  return healthFailure(error).failure === 'timeout' ? 'timeout' : 'error';
}
export function summarizeHealth(events: HealthEvent[], target: HealthTarget, settings: HealthSettings, now = Date.now()): HealthSnapshot {
  const relevant = events.filter(event => event.provider === target.provider && event.target === target.key);
  const local = relevant.filter(event => event.source === 'local').sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const recent = local.filter(event => now - Date.parse(event.at) <= settings.failureWindowMs && event.type === 'attempt');
  const samples = recent.filter(event => event.outcome !== 'cancelled');
  const last = (predicate: (e: HealthEvent) => boolean) => local.filter(predicate).at(-1);
  const success = last(e => e.type === 'attempt' && e.outcome === 'success');
  const failure = last(e => (e.type === 'attempt' || e.type === 'discovery') && (e.outcome === 'error' || e.outcome === 'timeout'));
  const discovery = last(e => e.type === 'discovery');
  const capabilities: HealthSnapshot['capabilities'] = { tools: 'unknown', streaming: 'unknown', cancellation: 'unknown', usage: 'unknown' };
  for (const e of local) for (const key of Object.keys(e.capabilities ?? {}) as Capability[]) capabilities[key] = e.capabilities![key]!;
  let consecutive: HealthEvent[] = [], triggeredFailures = 0;
  let triggeredAt: string | null = null, quarantineReason: FailureKind | null = null;
  for (const event of local) {
    if (event.type === 'reset' || (event.type === 'attempt' && event.outcome === 'success')) { consecutive = []; triggeredAt = null; quarantineReason = null; triggeredFailures = 0; }
    else if (event.type === 'attempt' && event.outcome !== 'cancelled') {
      // Evaluate the failure window at the event's time. A quarantine may
      // deliberately outlive that window and must retain its promised expiry.
      consecutive = consecutive.filter(prior => Date.parse(event.at) - Date.parse(prior.at) <= settings.failureWindowMs);
      consecutive.push(event);
      if (consecutive.length >= settings.failureThreshold) { triggeredAt = event.at; triggeredFailures = consecutive.length; quarantineReason = event.failure ?? (event.outcome === 'timeout' ? 'timeout' : 'unknown'); }
    }
  }
  const expiresAt = triggeredAt ? new Date(Date.parse(triggeredAt) + settings.quarantineMs).toISOString() : null;
  const active = !!expiresAt && Date.parse(expiresAt) > now;
  return { provider: target.provider, target: target.key, sampleCount: samples.length,
    latencyMs: samples.length ? Math.round(samples.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / samples.length) : null,
    errorRate: samples.length ? samples.filter(e => e.outcome !== 'success').length / samples.length : null,
    timeoutRate: samples.length ? samples.filter(e => e.outcome === 'timeout').length / samples.length : null,
    retryRate: samples.length ? samples.filter(e => (e.retryIndex ?? 0) > 0).length / samples.length : null,
    lastSuccessAt: success?.at ?? null,
    lastFailure: failure ? { at: failure.at, kind: failure.failure ?? 'unknown', httpStatus: failure.httpStatus ?? null } : null,
    discovery: { status: discovery?.outcome ?? 'unknown', at: discovery?.at ?? null, modelCount: discovery?.modelCount ?? null },
    lastSuccessfulConformanceAt: last(e => e.type === 'conformance' && e.outcome === 'success')?.at ?? null,
    capabilities, quarantine: { active, reason: quarantineReason, expiresAt, failures: active ? triggeredFailures : consecutive.filter(e => now - Date.parse(e.at) <= settings.failureWindowMs).length },
    importedEvents: relevant.length - local.length,
  };
}
export function healthRemediation(target: HealthTarget, health: HealthSnapshot): string[] {
  const steps: string[] = [];
  if (target.credentials === 'missing') steps.push(`Configure ${target.provider} credentials or endpoint with calliope --setup.`);
  const kind = health.lastFailure?.kind;
  if (kind === 'authentication') steps.push('Replace invalid credentials or refresh the AWS profile session.');
  else if (kind === 'quota') steps.push('Restore provider credit or increase the provider-side quota.');
  else if (kind === 'rate_limit') steps.push('Reduce concurrency and retry after the provider rate limit resets.');
  else if (kind === 'network' || kind === 'timeout') steps.push('Check endpoint reachability, network access and timeout settings.');
  else if (kind) steps.push('Probe model discovery and check provider availability and model compatibility.');
  if (health.quarantine.active) steps.push(`Quarantine expires at ${health.quarantine.expiresAt}; after remediation run calliope doctor provider ${target.provider} --reset.`);
  if (health.discovery.status !== 'success') steps.push(`Run calliope doctor provider ${target.provider} --probe to check model discovery.`);
  if (!health.lastSuccessfulConformanceAt) steps.push('No local successful conformance event is recorded; collect and verify real-wire evidence.');
  return steps;
}
