import * as config from '../config.js';
import type { ModelPreference } from './types.js';

export function validatePreference(value: unknown): ModelPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Model preference must be an object');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['provider', 'model'].includes(key))) throw new Error('Only provider and model are allowed in a model preference');
  if (data.provider !== undefined && data.provider !== 'auto' && !config.getProviderNames().includes(data.provider as never)) throw new Error('Unknown or retired provider preference');
  if (data.model !== undefined && data.model !== null && (typeof data.model !== 'string' || !data.model.trim() || data.model.length > 512 || /[\x00-\x1f\x7f]/.test(data.model))) throw new Error('Invalid model preference');
  return { ...(data.provider !== undefined ? { provider: data.provider as ModelPreference['provider'] } : {}),
    ...(Object.hasOwn(data, 'model') ? { model: data.model === undefined ? null : data.model as string | null } : {}) };
}
