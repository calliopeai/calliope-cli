import * as config from '../config.js';
import { diagnoseProviders } from '../doctor.js';
import { selectRoute, RoutingUnavailableError, type RoutingDecision } from '../routing/index.js';
import type { ModelInfo } from '../models/index.js';
import type { Message, LLMProvider } from '../types.js';
import { RunLog } from '../runlog.js';
import { validatePreference } from './validate.js';
import type { ModelPreference } from './types.js';

export interface ProviderChoice {
  id: LLMProvider; label: string; configured: boolean; configHint: string;
  health: 'healthy' | 'degraded' | 'quarantined' | 'unknown' | 'missing'; note?: string;
}
export async function providerChoices(): Promise<ProviderChoice[]> {
  const { report } = await diagnoseProviders(['providers']);
  return [{ id: 'auto', label: 'Auto', configured: true, configHint: '', health: 'unknown', note: 'Use eligible providers and explain each route' },
    ...config.getProviderNames().map(id => {
      const health = report.providers.find(provider => provider.provider === id), env = config.getProviderEnvVars(id);
      return { id, label: id, configured: !!health && health.credentials !== 'missing', configHint: id === 'bedrock' ? 'AWS_PROFILE / BEDROCK_BASE_URL' : env.apiKey ?? env.baseUrl ?? 'provider configuration',
        health: !health ? 'unknown' as const : health.credentials === 'missing' ? 'missing' as const : health.quarantine.active ? 'quarantined' as const
          : health.sampleCount === 0 ? 'unknown' as const : health.errorRate ? 'degraded' as const : 'healthy' as const,
        note: health?.quarantine.active ? `until ${health.quarantine.expiresAt}; explicit recovery allowed` : undefined };
    })];
}
export function formatModelDetails(model: ModelInfo): string {
  const price = model.pricing, knownPrice = price?.input !== undefined && price.output !== undefined;
  const estimate = knownPrice ? (price.input! * 1000 + price.output! * 250) / 1000000 : undefined;
  return `context ${model.contextLength?.toLocaleString('en-US') ?? 'unknown'} · output ${model.maxOutputTokens?.toLocaleString('en-US') ?? 'unknown'} · `
    + (estimate !== undefined && Number.isFinite(estimate) ? `$${estimate.toFixed(6)} / 1k in + 250 out` : 'cost unknown')
    + ` · tools ${model.capabilities?.tools === undefined ? 'unknown' : model.capabilities.tools ? 'yes' : 'no'}`;
}
/** Validate choices before changing UI state. No inference or preference write occurs here. */
export async function validateSelection(preference: ModelPreference, messages: Message[], options: { signal?: AbortSignal; runlog?: RunLog } = {}): Promise<RoutingDecision> {
  const value = validatePreference(preference);
  const decision = await selectRoute({ provider: value.provider ?? 'auto', model: value.model ?? undefined, messages, signal: options.signal,
    preferences: config.get('routing'), requirements: { tools: true, streaming: true } });
  if (options.runlog) { options.runlog.routingDecision(decision); await options.runlog.flush(); }
  if (!decision.selected) throw new RoutingUnavailableError(decision);
  return decision;
}
