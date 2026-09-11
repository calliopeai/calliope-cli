import * as config from '../config.js';
import type { ModelPreference, PreferenceSource, ResolvedPreference } from './types.js';
import { readProjectDefaults } from './store.js';
import { validatePreference } from './validate.js';

/** Snapshot a temporary override without losing the origin of inherited fields. */
export function applyTurnPreference(base: ResolvedPreference, override: ModelPreference = {}): ResolvedPreference {
  const value = validatePreference(override);
  const next = { ...base, sources: { ...base.sources }, warnings: [...base.warnings] };
  if (value.provider !== undefined) {
    if (value.provider !== base.provider) { delete next.model; next.sources.model = null; }
    next.provider = value.provider; next.sources.provider = 'turn';
  }
  if (Object.hasOwn(value, 'model')) {
    if (value.model) next.model = value.model; else delete next.model;
    next.sources.model = value.model ? 'turn' : null;
  }
  return next;
}

/** Apply low-to-high priority layers without carrying a foreign provider's model. */
export function mergePreferences(layers: { source: PreferenceSource; value: ModelPreference }[], warnings: string[] = []): ResolvedPreference {
  const result: ResolvedPreference = { provider: 'auto', sources: { provider: 'global', model: null }, warnings: [...warnings] };
  for (const { source, value } of layers) {
    const layer = validatePreference(value);
    if (layer.provider !== undefined) {
      if (layer.provider !== result.provider) { delete result.model; result.sources.model = null; }
      result.provider = layer.provider; result.sources.provider = source;
    }
    if (Object.hasOwn(layer, 'model')) {
      if (layer.model) result.model = layer.model; else delete result.model;
      result.sources.model = layer.model ? source : null;
    }
  }
  return result;
}

export function resolvePreferences(cwd: string, options: { turn?: ModelPreference; session?: ModelPreference; env?: NodeJS.ProcessEnv } = {}): ResolvedPreference {
  const project = readProjectDefaults(cwd), env = options.env ?? process.env;
  return mergePreferences([
    { source: 'global', value: { provider: config.get('defaultProvider'), model: config.get('defaultModel') || null } },
    { source: 'project', value: project.selection ?? {} },
    { source: 'environment', value: { ...(env.CALLIOPE_PROVIDER ? { provider: env.CALLIOPE_PROVIDER as ModelPreference['provider'] } : {}), ...(env.CALLIOPE_MODEL ? { model: env.CALLIOPE_MODEL } : {}) } },
    { source: 'session', value: options.session ?? {} },
    { source: 'turn', value: options.turn ?? {} },
  ], project.warning ? [project.warning] : []);
}
