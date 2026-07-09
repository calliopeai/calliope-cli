/**
 * Calliope CLI - Local Model Excellence
 *
 * A single home for the behaviours that make Calliope a good harness for
 * self-hosted 7-70B models (Ollama, or an OpenAI-compatible/LiteLLM server
 * pointed at localhost / a private box running vLLM etc.). Cloud providers are
 * untouched — every helper here is a no-op or "cloud" answer unless the active
 * backend is detected as local.
 *
 * Responsibilities:
 *  - Detect whether a provider/baseUrl pair is a local backend.
 *  - Simplify tool JSON-schemas before they are sent to a local model (lossless
 *    for execution — tools.ts still validates the real args).
 *  - Compute and verify content anchor hashes for stale-view-protected edits.
 *  - Detect malformed tool calls and describe how to repair them.
 *  - Build the JSON-schema envelope used to grammar-constrain a repair reply.
 *  - Probe a local model's capabilities (context length, native tool calls,
 *    JSON-schema `format` support) and cache the result per session.
 *  - Pick the compact vs full system prompt for a provider.
 */

import { createHash } from 'node:crypto';
import * as config from './config.js';
import type { LLMProvider, Tool, ToolCall } from './types.js';
import { getSystemPrompt } from './types.js';
import { getModelContextLimit } from './model-detection.js';

// ============================================================================
// Backend detection
// ============================================================================

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal']);

/**
 * True when a URL points at the local machine (loopback host, `*.local`, or the
 * docker host bridge). Used to decide whether an openai-compat / LiteLLM server
 * is a self-hosted backend rather than a hosted proxy.
 */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // Not a parseable URL — fall back to a substring check on the raw value.
    const lower = url.toLowerCase();
    return [...LOOPBACK_HOSTS].some(h => lower.includes(h)) || lower.includes('.local');
  }
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith('.local')) return true;
  return false;
}

/**
 * Whether the active backend is a locally-hosted model.
 *
 *  - `ollama` is always local.
 *  - `openai-compat` / `litellm` are local when their base URL is loopback
 *    (LM Studio, vLLM, llama.cpp, a local LiteLLM proxy, ...).
 *  - Everything else (Anthropic, OpenAI, Bedrock, hosted OpenAI-compat, and the
 *    `auto` sentinel) is treated as cloud.
 *
 * `baseUrl` defaults to the configured base URL for the provider.
 */
export function isLocalBackend(provider: LLMProvider, baseUrl?: string): boolean {
  if (provider === 'ollama') return true;
  if (provider === 'litellm' || provider === 'openai-compat') {
    const url = baseUrl ?? config.getBaseUrl(provider);
    return isLoopbackUrl(url);
  }
  return false;
}

// ============================================================================
// Schema simplification (feature 1)
// ============================================================================

/** Maximum enum values kept in a simplified schema (execution still accepts any). */
const ENUM_CAP = 12;
/** Maximum characters kept for a tool description in a simplified schema. */
const TOOL_DESC_CAP = 200;
/** Maximum characters kept for a property description in a simplified schema. */
const PROP_DESC_CAP = 80;

/**
 * The `anchor_hash` property injected into `edit_file`'s SIMPLIFIED schema only
 * (feature 4). tools.ts accepts it from any caller, but it is only advertised to
 * local models — cloud schemas stay inert.
 */
export const ANCHOR_HASH_PROPERTY = {
  type: 'string',
  description: 'Optional 8-char hash from the last read_file of this file (stale-edit guard); echo it to confirm your view is current.',
} as const;

/** The property key models echo back on an anchored edit. */
export const ANCHOR_HASH_KEY = 'anchor_hash';

/**
 * Reduce a verbose description to its first sentence, single-line and capped.
 * Multi-paragraph tool descriptions (e.g. `configure`) collapse to their lede.
 */
export function firstSentence(text: string | undefined, cap: number): string {
  if (!text) return text ?? '';
  let s = text.trim();
  // Drop everything after the first newline — verbose schemas put reference
  // material on subsequent lines.
  const nl = s.search(/\r?\n/);
  if (nl !== -1) s = s.slice(0, nl).trim();
  // Keep only the first sentence within that line.
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  if (m) s = m[0].trim();
  if (s.length > cap) s = s.slice(0, cap - 1).trimEnd() + '…';
  return s;
}

interface SchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

function simplifyProperty(prop: SchemaProperty): SchemaProperty {
  const out: SchemaProperty = { type: prop.type };
  if (prop.description) out.description = firstSentence(prop.description, PROP_DESC_CAP);
  if (prop.enum) out.enum = prop.enum.length > ENUM_CAP ? prop.enum.slice(0, ENUM_CAP) : prop.enum;
  if (prop.items) out.items = prop.items;
  return out;
}

/**
 * Simplify a tool schema for a local model: first-sentence descriptions, capped
 * enum listings, and (for `edit_file`) the optional `anchor_hash` param.
 *
 * LOSSLESS FOR EXECUTION: the returned schema only changes what the model is
 * shown. tools.ts validates the real arguments independently, so trimming a
 * description or truncating an enum listing cannot break a valid call.
 *
 * Calliope's tool schemas are already flat (no nested object properties), so the
 * "flatten nested objects" goal is a structural no-op here; the real token win
 * is in the descriptions and enums.
 */
export function simplifyToolForLocal(tool: Tool): Tool {
  const properties: Record<string, SchemaProperty> = {};
  for (const [key, prop] of Object.entries(tool.parameters.properties)) {
    properties[key] = simplifyProperty(prop as SchemaProperty);
  }
  // Advertise the stale-view guard to local models on edit_file only.
  if (tool.name === 'edit_file') {
    properties[ANCHOR_HASH_KEY] = { ...ANCHOR_HASH_PROPERTY };
  }
  return {
    name: tool.name,
    description: firstSentence(tool.description, TOOL_DESC_CAP),
    parameters: {
      type: 'object',
      properties: properties as Tool['parameters']['properties'],
      ...(tool.parameters.required ? { required: tool.parameters.required } : {}),
    },
  };
}

/** Simplify a whole tool set for a local backend. Empty in → empty out. */
export function simplifyToolsForLocal(tools: Tool[]): Tool[] {
  return tools.map(simplifyToolForLocal);
}

// ============================================================================
// Anchor hashes (feature 4)
// ============================================================================

/** 8-char sha256 prefix of file content — the stable "view id" a model echoes. */
export function computeAnchorHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}

/** Footer appended to read_file output for local backends so the model can echo the hash. */
export function anchorHashFooter(hash: string): string {
  return `\n[anchor_hash: ${hash} — pass as anchor_hash to edit_file to confirm this view is current]`;
}

// ============================================================================
// Malformed tool-call detection + repair (features 2 & 3)
// ============================================================================

/** Classic Levenshtein edit distance (iterative, two-row). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Max edit distance for an unknown tool name to count as a repairable typo. */
const NAME_MATCH_THRESHOLD = 2;

export interface MalformedToolCall {
  /** Human-readable reason, embedded verbatim in the corrective message. */
  reason: string;
  /** Suggested correct tool name, when the fault is a close-miss name. */
  suggestion?: string;
}

/**
 * Detect whether a parsed tool call is malformed in a way worth one repair
 * round-trip. Returns null for a well-formed call OR for an unknown tool with no
 * close match (there is nothing to correct — let it surface naturally).
 *
 *  - unknown tool name with a close Levenshtein match → suggest the neighbour
 *  - missing a required parameter (also how unparseable-args `{}` presents)
 */
export function detectMalformedToolCall(call: ToolCall, tools: Tool[]): MalformedToolCall | null {
  const known = tools.find(t => t.name === call.name);
  if (!known) {
    let best: string | undefined;
    let bestDist = Infinity;
    for (const t of tools) {
      const d = levenshtein(call.name.toLowerCase(), t.name.toLowerCase());
      if (d < bestDist) {
        bestDist = d;
        best = t.name;
      }
    }
    if (best && bestDist <= NAME_MATCH_THRESHOLD && bestDist < best.length) {
      return { reason: `unknown tool "${call.name}"; did you mean "${best}"?`, suggestion: best };
    }
    return null;
  }

  const args = (call.arguments ?? {}) as Record<string, unknown>;
  for (const req of known.parameters.required ?? []) {
    const value = args[req];
    if (value === undefined || value === null) {
      return { reason: `missing required parameter "${req}"` };
    }
  }
  return null;
}

/** The compact corrective message sent on a repair round-trip. */
export function buildRepairMessage(call: ToolCall, fault: MalformedToolCall): string {
  return `Your tool call to "${call.name}" was malformed: ${fault.reason}. Reply with ONLY the corrected tool call, nothing else.`;
}

/**
 * JSON-schema envelope for a single tool call, used to grammar-constrain a
 * repair reply via Ollama's `format` parameter. Constraining every response
 * would break prose, so this is only ever applied on the repair round-trip.
 */
export function buildToolCallEnvelopeSchema(toolNames: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      name: toolNames.length > 0 ? { type: 'string', enum: toolNames } : { type: 'string' },
      arguments: { type: 'object' },
    },
    required: ['name', 'arguments'],
  };
}

/**
 * Extract a corrected tool call from a repair response. Accepts either a native
 * tool call (Ollama returned `tool_calls`) or a grammar-constrained JSON
 * envelope in the text content (`{"name":...,"arguments":{...}}`). Returns null
 * when neither yields a usable call. `id` is preserved so the assistant/tool
 * message threading stays intact.
 */
export function extractRepairedToolCall(
  content: string,
  nativeToolCalls: ToolCall[] | undefined,
  id: string,
): ToolCall | null {
  if (nativeToolCalls && nativeToolCalls.length > 0) {
    const first = nativeToolCalls[0]!;
    return { id, name: first.name, arguments: first.arguments ?? {} };
  }
  const text = content.trim();
  if (!text) return null;
  // Pull the first balanced JSON object out of the reply (models often wrap it
  // in prose or a code fence despite the "ONLY" instruction).
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { name?: unknown; arguments?: unknown };
    if (typeof parsed.name !== 'string' || !parsed.name) return null;
    const args = (parsed.arguments && typeof parsed.arguments === 'object')
      ? parsed.arguments as Record<string, unknown>
      : {};
    return { id, name: parsed.name, arguments: args };
  } catch {
    return null;
  }
}

// ============================================================================
// Capability detection (feature 6)
// ============================================================================

export interface LocalModelProfile {
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
  contextLength: number;
  supportsNativeToolCalls: boolean;
  supportsJsonSchemaFormat: boolean;
  /** Raw Ollama capability list when available (e.g. ['completion','tools',...]). */
  capabilities?: string[];
}

/**
 * Heuristic native-tool-call support by model family. Only consulted when the
 * backend does not report capabilities directly (older Ollama, non-Ollama local
 * servers). Errs toward the families known to emit reliable tool calls.
 */
export function familySupportsNativeTools(model: string): boolean {
  const m = model.toLowerCase();
  const families = [
    'llama3.1', 'llama-3.1', 'llama3.2', 'llama-3.2', 'llama3.3', 'llama-3.3', 'llama4', 'llama-4',
    'qwen2.5', 'qwen3', 'mistral', 'mixtral', 'devstral', 'command-r',
    'hermes', 'firefunction', 'functionary', 'gemma4', 'gpt-oss',
  ];
  return families.some(f => m.includes(f));
}

function normalizeOllamaBase(url: string | undefined): string {
  let base = url || 'http://localhost:11434';
  if (base.endsWith('/v1')) base = base.slice(0, -3);
  return base;
}

async function probeOllama(baseUrl: string, model: string): Promise<{ capabilities?: string[]; contextLength?: number }> {
  const response = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model }),
  });
  if (!response.ok) throw new Error(`Ollama /api/show returned ${response.status}`);
  const data = await response.json() as {
    capabilities?: string[];
    model_info?: Record<string, unknown>;
    parameters?: string;
  };
  let contextLength: number | undefined;
  if (data.model_info) {
    const ctxKey = Object.keys(data.model_info).find(k => k.includes('context_length') || k.includes('context_window'));
    if (ctxKey && typeof data.model_info[ctxKey] === 'number') {
      contextLength = data.model_info[ctxKey] as number;
    }
  }
  if (data.parameters) {
    const numCtx = data.parameters.match(/num_ctx\s+(\d+)/);
    if (numCtx) contextLength = parseInt(numCtx[1]!, 10);
  }
  return { capabilities: data.capabilities, contextLength };
}

// Per-session cache: a CLI process is one session, so a module-level map is the
// right lifetime. Keyed by provider|model|baseUrl.
const profileCache = new Map<string, LocalModelProfile>();

/** Clear the per-session capability cache (tests only). */
export function clearLocalModelProfileCache(): void {
  profileCache.clear();
}

/**
 * Resolve a local model's capability profile, caching per session.
 *
 *  - contextLength: Ollama /api/show model_info, else the family default.
 *  - supportsNativeToolCalls: Ollama `capabilities` includes 'tools' when
 *    reported, else a family heuristic.
 *  - supportsJsonSchemaFormat: true only for native Ollama (the /api/chat
 *    `format` path); other local servers don't share that parameter.
 *
 * Never throws: a failed probe degrades to heuristics.
 */
export async function getLocalModelProfile(
  provider: LLMProvider,
  model: string,
  baseUrl?: string,
): Promise<LocalModelProfile> {
  const url = baseUrl ?? config.getBaseUrl(provider);
  const key = `${provider}|${model}|${url ?? ''}`;
  const cached = profileCache.get(key);
  if (cached) return cached;

  let capabilities: string[] | undefined;
  let contextLength = getModelContextLimit(provider, model);
  let supportsNativeToolCalls = familySupportsNativeTools(model);
  const supportsJsonSchemaFormat = provider === 'ollama';

  if (provider === 'ollama') {
    try {
      const probe = await probeOllama(normalizeOllamaBase(url), model);
      if (probe.capabilities) {
        capabilities = probe.capabilities;
        supportsNativeToolCalls = probe.capabilities.includes('tools');
      }
      if (probe.contextLength && probe.contextLength > 0) contextLength = probe.contextLength;
    } catch {
      // Keep heuristic values.
    }
  }

  const profile: LocalModelProfile = {
    provider,
    model,
    baseUrl: url,
    contextLength,
    supportsNativeToolCalls,
    supportsJsonSchemaFormat,
    capabilities,
  };
  profileCache.set(key, profile);
  return profile;
}

// ============================================================================
// System prompt selection (feature 5)
// ============================================================================

/**
 * Pick the system prompt for a provider: the compact variant for a local
 * backend, the full prompt for cloud. The single seam every prompt-building call
 * site routes through, so provider checks are not scattered.
 *
 * The `auto` sentinel resolves to the full prompt (auto only selects a local
 * backend when no cloud provider is configured, an edge the request-time schema
 * simplification and repair loop still cover).
 */
export function getSystemPromptForProvider(provider: LLMProvider, baseUrl?: string): string {
  return getSystemPrompt({ compact: isLocalBackend(provider, baseUrl) });
}

/** Rough token estimate for a raw string (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
