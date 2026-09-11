/** Normalize provider metadata without inferring support or price from a model name. */
export interface ModelCapabilities {
  chat?: boolean;
  tools?: boolean;
  streaming?: boolean;
  vision?: boolean;
  thinking?: boolean;
  json?: boolean;
}
export class ModelDiscoveryError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelDiscoveryError'; }
}
export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  aliases?: string[];
  contextLength?: number;
  maxOutputTokens?: number;
  pricing?: { input?: number; output?: number };
  capabilities?: ModelCapabilities;
  evidence?: { source: 'live' | 'emergency'; at: string };
}
export function positiveLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
export function price(value: unknown, scale = 1): number | undefined {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 && Number.isFinite(parsed * scale) ? parsed * scale : undefined;
}
export function capability(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && 'supported' in value && typeof value.supported === 'boolean') return value.supported;
  return undefined;
}
export function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function anthropicMetadata(value: unknown): Omit<ModelInfo, 'id'> {
  const model = object(value), caps = object(model.capabilities);
  return { contextLength: positiveLimit(model.max_input_tokens), maxOutputTokens: positiveLimit(model.max_tokens),
    capabilities: { chat: true, vision: capability(caps.image_input), thinking: capability(caps.thinking), json: capability(caps.structured_outputs) } };
}

/** Mistral fields and common compatible-server extensions; absent fields stay unknown. */
export function compatibleMetadata(value: unknown): Omit<ModelInfo, 'id'> {
  const model = object(value), caps = object(model.capabilities), costs = object(model.pricing);
  const supported = stringList(model.supported_parameters);
  return {
    aliases: stringList(model.aliases),
    contextLength: positiveLimit(model.max_context_length ?? model.context_length),
    maxOutputTokens: positiveLimit(model.max_output_tokens),
    pricing: { input: price(costs.input), output: price(costs.output) },
    capabilities: {
      chat: model.archived === true ? false : capability(caps.completion_chat ?? caps.chat),
      tools: capability(caps.function_calling ?? caps.tools) ?? (supported ? supported.includes('tools') : undefined),
      streaming: capability(caps.streaming), vision: capability(caps.vision),
      thinking: capability(caps.thinking ?? caps.reasoning), json: capability(caps.json),
    },
  };
}

export function validateModels(models: ModelInfo[]): ModelInfo[] {
  if (!Array.isArray(models) || models.length > 10000) throw new ModelDiscoveryError('Invalid model discovery response');
  const ids = new Set<string>();
  for (const model of models) {
    if (!model || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 512 || /[\x00-\x1f\x7f]/.test(model.id) || ids.has(model.id)) throw new ModelDiscoveryError('Invalid or duplicate discovered model identity');
    ids.add(model.id);
    for (const limit of [model.contextLength, model.maxOutputTokens]) if (limit !== undefined && positiveLimit(limit) === undefined) throw new ModelDiscoveryError('Invalid discovered token limit');
    for (const cost of [model.pricing?.input, model.pricing?.output]) if (cost !== undefined && price(cost) === undefined) throw new ModelDiscoveryError('Invalid discovered model price');
  }
  return models;
}
