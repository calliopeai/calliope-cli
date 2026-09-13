import { ExecutionLimitError } from '../execution/types.js';
import type { ProviderPriceCeiling } from './types.js';

/** API controls, not a model catalogue. Account-enforced plugins must also be
 * disabled by the operator: OpenRouter can forbid request-level overrides. */
export function openRouterBounds(ceiling: ProviderPriceCeiling | undefined) {
  if (!ceiling || ![ceiling.input, ceiling.output].every(n => Number.isFinite(n) && n >= 0))
    throw new ExecutionLimitError('budget', 'Bounded OpenRouter requests require admitted input/output price ceilings.');
  return {
    provider: { allow_fallbacks: false, require_parameters: true,
      max_price: { prompt: ceiling.input, completion: ceiling.output, request: 0, image: 0 } },
    service_tier: 'default' as const,
    modalities: ['text'] as ['text'],
    plugins: ['web', 'file-parser', 'response-healing', 'auto-router', 'pareto-router', 'context-compression', 'fusion']
      .map(id => ({ id, enabled: false })),
  };
}
