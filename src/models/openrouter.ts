import { price, type ModelInfo } from './metadata.js';

/** Token ceilings across every advertised context tier, in USD per million.
 * Optional web search is disabled by bounded transport. Other non-token fees
 * need a separate admission model; missing/malformed evidence is not free. */
export function openRouterPricing(value: unknown): ModelInfo['pricing'] {
  const unknown = { input: undefined, output: undefined };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const base = value as Record<string, unknown>;
  if (price(base.prompt) === undefined || price(base.completion) === undefined) return unknown;
  const overrides = base.overrides === undefined ? [] : base.overrides;
  if (!Array.isArray(overrides) || overrides.length > 100) return unknown;
  let input = 0, output = 0;
  for (const [index, item] of [base, ...overrides].entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return unknown;
    const tier = item as Record<string, unknown>;
    if (index && (!Number.isSafeInteger(tier.min_prompt_tokens) || (tier.min_prompt_tokens as number) < 0)) return unknown;
    for (const [key, value] of Object.entries(tier)) {
      if (!index && key === 'overrides' || index && key === 'min_prompt_tokens') continue;
      const rate = price(value, 1e6);
      if (rate === undefined) return unknown;
      if (['prompt', 'input_cache_read', 'input_cache_write'].includes(key)) input = Math.max(input, rate);
      else if (key === 'completion') output = Math.max(output, rate);
      else if (key !== 'web_search' && rate !== 0) return unknown;
    }
  }
  return { input, output };
}
