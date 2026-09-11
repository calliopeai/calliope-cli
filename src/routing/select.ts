import { randomUUID } from 'node:crypto';
import * as config from '../config.js';
import { getAvailableModels, getDiscoveredModels, getPreviousDiscoveredModels, resolveModelAlias } from '../model-detection.js';
import { HealthStore, providerTarget, summarizeHealth, healthFailure, healthOutcome, type HealthProvider } from '../health/index.js';
import { capability, ModelDiscoveryError, type ModelInfo, type ModelCapabilities } from '../models/index.js';
import type { Message } from '../types.js';
import type { RouteCandidate, RoutingDecision, RoutingRequest, RoutingRequirements, RoutingPreferences } from './types.js';

export class RoutingUnavailableError extends Error {
  constructor(readonly decision: RoutingDecision) { super(decision.reason); this.name = 'RoutingUnavailableError'; }
}
function mismatch(model: ModelInfo, needs: RoutingRequirements): string | undefined {
  for (const key of ['chat', 'tools', 'streaming', 'vision', 'thinking', 'json'] as const) {
    if ((key === 'chat' || needs[key]) && model.capabilities?.[key] === false) return `discovery-rejects-${key}`;
  }
  if (needs.minOutputTokens !== undefined && model.maxOutputTokens !== undefined && needs.minOutputTokens > model.maxOutputTokens) return 'discovery-rejects-output-budget';
  return undefined;
}
/** Opaque provider state cannot be silently carried to a different adapter. */
function historyPin(messages: Message[]): { provider: string; model?: string } | undefined {
  let pin: { provider: string; model?: string } | undefined;
  for (const message of [...messages].reverse()) {
    if (!message.providerMetadata) continue;
    const keys = Object.keys(message.providerMetadata).filter(key => key !== 'calliopeRouting');
    if (!keys.length) continue;
    const origin = message.providerMetadata.calliopeRouting as { provider?: unknown; model?: unknown } | undefined;
    const provider = typeof origin?.provider === 'string' ? origin.provider : keys.length === 1 ? keys[0] : undefined;
    if (!provider) return { provider: 'unknown-protocol' };
    const model = typeof origin?.model === 'string' ? origin.model : undefined;
    if (pin && (pin.provider !== provider || (pin.model && model && pin.model !== model))) return { provider: 'mixed-protocol' };
    pin = { provider, model: pin?.model ?? model };
  }
  return pin;
}
export function formatRoutingDecision(decision: RoutingDecision): string {
  return decision.selected ? `Route: ${decision.selected.provider}/${decision.selected.model}. ${decision.reason}` : `Routing stopped: ${decision.reason}`;
}

/** Discovery sends no inference prompts. A whole decision has a fixed 30s deadline. */
export async function selectRoute(request: RoutingRequest): Promise<RoutingDecision> {
  const decision: RoutingDecision = { version: 1, id: randomUUID(), at: new Date().toISOString(), status: 'unavailable',
    requested: { provider: request?.origin?.provider ?? request?.provider ?? 'auto', model: (request?.origin ? request.origin.model : request?.model) ?? null },
    mode: request?.origin ? 'turn-pinned' : request?.provider === 'auto' ? 'auto' : 'explicit',
    selected: null, alternatives: [], exclusions: [], reason: 'No eligible discovered model. Run calliope doctor --probe or select a configured provider/model explicitly.' };
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      (request.signal !== undefined && !(request.signal instanceof AbortSignal)) ||
      (request.messages !== undefined && (!Array.isArray(request.messages) || request.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))))) {
    decision.reason = 'Invalid routing request.'; return decision;
  }
  const exclude = (provider: string, reason: string, model?: string) => {
    if (decision.exclusions.length < 1000) decision.exclusions.push({ provider, ...(model ? { model } : {}), reason });
  };
  const preferences: RoutingPreferences = request.preferences ?? config.get('routing') ?? {};
  const optimize = preferences.enabled ?? true;
  const costWeight = preferences.costSensitivity ?? 0.3;
  const probeTimeout = preferences.discoveryTimeoutMs ?? 5000;
  const names = config.getProviderNames();
  if (typeof optimize !== 'boolean' || typeof preferences !== 'object' || Array.isArray(preferences) || !Number.isFinite(costWeight) || costWeight < 0 || costWeight > 1 || !Number.isSafeInteger(probeTimeout) || probeTimeout < 100 || probeTimeout > 30000 ||
      (request.provider !== 'auto' && !names.includes(request.provider)) || (request.model !== undefined && (typeof request.model !== 'string' || !request.model.trim() || request.model.length > 512 || /[\x00-\x1f\x7f]/.test(request.model))) ||
      [preferences.providerPool, preferences.preferredProviders].some(pool => pool !== undefined && (!Array.isArray(pool) || pool.length > names.length || pool.some(provider => !names.includes(provider))))) {
    decision.reason = 'Invalid routing preferences or provider/model selection.'; return decision;
  }
  if (request.origin && request.origin.provider !== 'auto' && request.origin.provider !== request.provider) {
    decision.reason = 'A continuation cannot change the explicitly selected provider.'; return decision;
  }
  const needs = request.requirements ?? {};
  if (typeof needs !== 'object' || Array.isArray(needs) || ['chat', 'tools', 'streaming', 'vision', 'thinking', 'json'].some(key => {
    const value = needs[key as keyof RoutingRequirements]; return value !== undefined && typeof value !== 'boolean';
  }) || [needs.inputTokens, needs.outputTokens, needs.minOutputTokens].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    decision.reason = 'Invalid routing requirements or token estimate.'; return decision;
  }
  const pin = historyPin(request.messages ?? []);
  if (pin && !names.includes(pin.provider as HealthProvider)) {
    decision.reason = 'Provider-specific history has unknown or conflicting protocol owners. Start with normalized history before routing.'; return decision;
  }
  if (pin && (request.provider !== 'auto' && request.provider !== pin.provider || request.model && pin.model && request.model !== pin.model)) {
    decision.reason = 'Provider-specific history requires its original provider/model. Start a new session or branch with normalized history before switching.'; return decision;
  }
  if (pin) decision.mode = 'protocol-pinned';
  const explicit = (request.origin?.provider ?? request.provider) !== 'auto';
  let providers = request.provider !== 'auto' ? [request.provider as HealthProvider] : names;
  if (!explicit && preferences.providerPool?.length) providers = providers.filter(provider => preferences.providerPool!.includes(provider));
  if (pin) providers = providers.filter(provider => provider === pin.provider);
  // Preference defines a deterministic scan/tie order; health/cost/latency can
  // select another eligible provider only when provider selection is automatic.
  const preferredProviders = preferences.preferredProviders ?? [];
  providers.sort((a, b) => {
    const ai = preferredProviders.indexOf(a), bi = preferredProviders.indexOf(b);
    return (ai < 0 ? names.length : ai) - (bi < 0 ? names.length : bi);
  });
  const overall = AbortSignal.timeout(30000);
  let store: HealthStore | undefined, events: ReturnType<HealthStore['read']> = [];
  try { store = new HealthStore(); events = store.read(); }
  catch { exclude('health', 'local-health-history-unavailable'); }
  const candidates: RouteCandidate[] = [];
  for (const provider of providers) {
    if (request.signal?.aborted || overall.aborted) break;
    const target = providerTarget(provider);
    const preferredModel = request.model ?? pin?.model ?? (config.getProviderCred(provider).model || undefined);
    if (preferredModel && (typeof preferredModel !== 'string' || preferredModel.length > 512 || /[\x00-\x1f\x7f]/.test(preferredModel))) {
      exclude(provider, 'invalid-model-preference'); continue;
    }
    const health = store ? summarizeHealth(events, target, store.settings) : undefined;
    if (!explicit && target.credentials === 'missing') { exclude(provider, 'missing-configuration'); continue; }
    if (!explicit && health?.quarantine.active) { exclude(provider, 'quarantined'); continue; }
    const cached = getDiscoveredModels(provider);
    let models: ModelInfo[];
    let evidence: RouteCandidate['evidence'] = 'live';
    const signal = AbortSignal.any([overall, AbortSignal.timeout(probeTimeout), ...(request.signal ? [request.signal] : [])]);
    const started = Date.now();
    const recordDiscovery = (value: Parameters<HealthStore['append']>[0]) => {
      try { store?.append(value); } catch { exclude(provider, 'health-event-not-recorded'); }
    };
    try {
      if (target.credentials === 'missing') throw new Error('Provider configuration missing');
      models = cached ?? await getAvailableModels(provider, { quiet: true, throwOnError: true, cache: 'live', signal });
      if (!cached) recordDiscovery({ provider, target: target.key, type: 'discovery', outcome: 'success', modelCount: models.length, durationMs: Math.max(0, Date.now() - started) });
    } catch (error) {
      const outcome = healthOutcome(error, signal);
      recordDiscovery({ provider, target: target.key, type: 'discovery', outcome, durationMs: Math.max(0, Math.min(86400000, Date.now() - started)),
        ...(outcome === 'cancelled' ? {} : { ...healthFailure(error), ...(outcome === 'timeout' ? { failure: 'timeout' as const } : {}) }) });
      exclude(provider, `discovery-${outcome}`);
      if (signal.aborted && (request.signal?.aborted || overall.aborted)) break;
      if (error instanceof ModelDiscoveryError || error instanceof SyntaxError || (error instanceof TypeError && healthFailure(error).failure !== 'network')) { exclude(provider, 'invalid-discovery-response'); continue; }
      // Explicit selections remain usable on endpoints that lack a models API.
      // This exception never applies to successful negative discovery evidence.
      if (!explicit || !preferredModel) continue;
      const previous = getPreviousDiscoveredModels(provider)?.find(model => model.id === preferredModel || model.aliases?.includes(preferredModel));
      const negative = previous && mismatch(previous, needs);
      if (negative) { exclude(provider, `previous-${negative}`, preferredModel); continue; }
      models = [{ id: preferredModel }]; evidence = 'explicit-unverified';
    }
    if (preferredModel && evidence === 'live' && !models.some(model => model.id === preferredModel || model.aliases?.includes(preferredModel))) {
      try { const alias = await resolveModelAlias(provider, preferredModel, signal); if (alias) models = [...models.filter(model => model.id !== alias.id), alias]; }
      catch { exclude(provider, 'alias-discovery-failed', preferredModel); }
      if (signal.aborted && (request.signal?.aborted || overall.aborted)) break;
    }
    if (target.key !== providerTarget(provider).key || (evidence === 'live' && !getDiscoveredModels(provider))) {
      exclude(provider, 'configuration-changed-during-discovery'); continue;
    }
    for (const model of models) {
      if (preferredModel && model.id !== preferredModel && !model.aliases?.includes(preferredModel)) continue;
      const rejected = mismatch(model, needs);
      if (rejected) { exclude(provider, rejected, model.id); continue; }
      const estimatedCost = model.pricing?.input !== undefined && model.pricing.output !== undefined
        ? (needs.inputTokens ?? 1000) / 1000000 * model.pricing.input + (needs.outputTokens ?? 250) / 1000000 * model.pricing.output : null;
      if (estimatedCost !== null && !Number.isFinite(estimatedCost)) { exclude(provider, 'invalid-cost-estimate', model.id); continue; }
      const required = (Object.keys(needs) as (keyof ModelCapabilities)[]).filter(key => needs[key] === true);
      const capacity = model.contextLength === undefined ? 0.5 : Math.min(1, model.contextLength / Math.max(1, needs.inputTokens ?? 1000));
      const support = (required.reduce((sum, key) => sum + (capability(model.capabilities?.[key]) === true ? 1 : 0.5), 0) + capacity) / (required.length + 1);
      const healthScore = health?.errorRate === null || !health ? 0.5 : 1 - Math.min(1, health.errorRate * 0.7 + (health.timeoutRate ?? 0) * 0.15 + (health.retryRate ?? 0) * 0.15);
      const latencyScore = health?.latencyMs == null ? 0.5 : 1 / (1 + health.latencyMs / 1000);
      const costScore = estimatedCost === null ? 0 : 1 / (1 + estimatedCost * 1000);
      const score = (support * 0.4 + healthScore * 0.4 + latencyScore * 0.2) * (1 - costWeight) + costScore * costWeight;
      candidates.push({ provider, model: preferredModel ?? model.id, target: target.key, evidence,
        discoveredAt: model.evidence?.at ?? null, capabilities: model.capabilities ?? {}, contextLength: model.contextLength ?? null,
        maxOutputTokens: model.maxOutputTokens ?? null, price: model.pricing ?? null, estimatedCost,
        latencyMs: health?.latencyMs ?? null, errorRate: health?.errorRate ?? null, score,
        reason: `capability ${support.toFixed(2)}, health ${healthScore.toFixed(2)}, latency ${latencyScore.toFixed(2)}, cost ${estimatedCost === null ? 'unknown' : estimatedCost.toFixed(6) + ' USD estimated'}${health?.quarantine.active ? '; explicit quarantine recovery' : ''}` });
    }
    if (preferredModel && !models.some(model => model.id === preferredModel || model.aliases?.includes(preferredModel))) exclude(provider, 'model-not-in-live-discovery', preferredModel);
  }
  if (request.signal?.aborted) { decision.status = 'cancelled'; decision.reason = 'Routing cancelled before inference.'; return decision; }
  if (overall.aborted) { decision.reason = 'Model discovery exceeded the routing deadline; no inference was sent.'; return decision; }
  candidates.sort((a, b) => (optimize ? b.score - a.score : 0) || providers.indexOf(a.provider) - providers.indexOf(b.provider) || a.model.localeCompare(b.model));
  if (candidates.length) {
    decision.status = 'selected'; decision.selected = candidates[0]!; decision.alternatives = candidates.slice(1, 21);
    decision.reason = `${decision.mode} selection${optimize ? '' : ' in configured order (optimization disabled)'}; ${decision.selected.reason}.${decision.selected.evidence === 'explicit-unverified' ? ' Discovery unavailable; honoring the explicit model without claiming compatibility.' : ''}`;
  }
  return decision;
}
