/**
 * Local-model excellence (#188) — unit tests for src/local-model.ts.
 *
 * Covers: backend detection, tool-schema simplification (snapshots for three
 * representative tools), anchor hashing, malformed-call detection + repair
 * helpers, the capability profile against mocked /api/show variations, and the
 * compact system-prompt token ratio.
 *
 * Fully mocked — no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Tool, ToolCall } from '../src/types.js';

vi.mock('../src/config.js', () => ({
  default: {},
  getBaseUrl: vi.fn((provider: string) => {
    if (provider === 'ollama') return 'http://localhost:11434';
    if (provider === 'litellm') return 'http://localhost:4000';
    return undefined; // openai-compat, bedrock: not configured
  }),
}));

import {
  isLoopbackUrl,
  isLocalBackend,
  simplifyToolForLocal,
  simplifyToolsForLocal,
  firstSentence,
  computeAnchorHash,
  anchorHashFooter,
  levenshtein,
  detectMalformedToolCall,
  buildRepairMessage,
  buildToolCallEnvelopeSchema,
  extractRepairedToolCall,
  getLocalModelProfile,
  clearLocalModelProfileCache,
  familySupportsNativeTools,
  getSystemPromptForProvider,
  estimateTokens,
  ANCHOR_HASH_KEY,
} from '../src/local-model.js';
import { getSystemPrompt } from '../src/types.js';
import { TOOLS } from '../src/tools.js';

const tool = (name: string): Tool => {
  const t = TOOLS.find(x => x.name === name);
  if (!t) throw new Error(`no such tool ${name}`);
  return t;
};

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'c1', name, arguments: args });

// ===========================================================================
// Backend detection
// ===========================================================================

describe('isLoopbackUrl', () => {
  it.each([
    ['http://localhost:11434', true],
    ['http://127.0.0.1:8000', true],
    ['http://0.0.0.0:4000/v1', true],
    ['http://[::1]:1234', true],
    ['http://host.docker.internal:11434', true],
    ['http://gpu-box.local:8000', true],
    ['https://api.openai.com/v1', false],
    ['https://openrouter.ai/api/v1', false],
    ['http://192.168.1.50:8000', false], // private LAN, but not loopback
  ])('%s -> %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });

  it('returns false for undefined', () => {
    expect(isLoopbackUrl(undefined)).toBe(false);
  });

  it('falls back to substring match for a non-URL string', () => {
    expect(isLoopbackUrl('localhost')).toBe(true);
    expect(isLoopbackUrl('not a url at all')).toBe(false);
  });
});

describe('isLocalBackend', () => {
  it('treats ollama as always local (no base URL needed)', () => {
    expect(isLocalBackend('ollama')).toBe(true);
  });

  it('treats litellm/openai-compat as local only when the base URL is loopback', () => {
    expect(isLocalBackend('litellm', 'http://localhost:4000')).toBe(true);
    expect(isLocalBackend('litellm', 'https://litellm.mycorp.com')).toBe(false);
    expect(isLocalBackend('openai-compat', 'http://127.0.0.1:1234')).toBe(true);
    expect(isLocalBackend('openai-compat', 'https://api.hosted.ai')).toBe(false);
  });

  it('resolves the base URL from config when not passed', () => {
    // litellm config default is loopback -> local; openai-compat is unset -> cloud.
    expect(isLocalBackend('litellm')).toBe(true);
    expect(isLocalBackend('openai-compat')).toBe(false);
  });

  it('treats hosted providers and the auto sentinel as cloud', () => {
    for (const p of ['anthropic', 'openai', 'google', 'mistral', 'bedrock', 'auto'] as const) {
      expect(isLocalBackend(p)).toBe(false);
    }
  });
});

// ===========================================================================
// Schema simplification (feature 1)
// ===========================================================================

describe('firstSentence', () => {
  it('keeps only the first sentence', () => {
    expect(firstSentence('Edit a file. Prefer this over write_file.', 200)).toBe('Edit a file.');
  });
  it('collapses multi-line descriptions to the first line/sentence', () => {
    expect(firstSentence('Read, set, or list options.\n\nCONFIGURABLE:\n- a\n- b', 200))
      .toBe('Read, set, or list options.');
  });
  it('caps overly long single sentences with an ellipsis', () => {
    const long = 'x'.repeat(120);
    const out = firstSentence(long, 80);
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });
  it('handles empty/undefined', () => {
    expect(firstSentence('', 80)).toBe('');
    expect(firstSentence(undefined, 80)).toBe('');
  });
});

describe('simplifyToolsForLocal', () => {
  it('is a no-op shape for an empty tool set', () => {
    expect(simplifyToolsForLocal([])).toEqual([]);
  });

  it('trims a verbose multi-line tool description to its first sentence', () => {
    const simplified = simplifyToolForLocal(tool('configure'));
    expect(simplified.description).toBe('Read, set, or list Calliope configuration options.');
    expect(simplified.description).not.toContain('\n');
    expect(simplified.description.length).toBeLessThan(tool('configure').description.length);
  });

  it('adds the optional anchor_hash param to edit_file (local schema only)', () => {
    const simplified = simplifyToolForLocal(tool('edit_file'));
    expect(simplified.parameters.properties[ANCHOR_HASH_KEY]).toBeDefined();
    expect(simplified.parameters.properties[ANCHOR_HASH_KEY].type).toBe('string');
    // anchor_hash is optional — never added to required.
    expect(simplified.parameters.required).not.toContain(ANCHOR_HASH_KEY);
    // The real (cloud) schema does NOT carry it.
    expect(tool('edit_file').parameters.properties[ANCHOR_HASH_KEY]).toBeUndefined();
  });

  it('does not add anchor_hash to other tools', () => {
    expect(simplifyToolForLocal(tool('read_file')).parameters.properties[ANCHOR_HASH_KEY]).toBeUndefined();
  });

  it('preserves required params, types, enums, and array items (lossless for execution)', () => {
    const git = simplifyToolForLocal(tool('git'));
    expect(git.parameters.required).toEqual(['operation']);
    expect(git.parameters.properties.operation.type).toBe('string');
    expect(git.parameters.properties.operation.enum).toEqual(
      tool('git').parameters.properties.operation.enum,
    );
    const askQ = simplifyToolForLocal(tool('ask_question'));
    expect(askQ.parameters.properties.options.items).toEqual({ type: 'string' });
  });

  it('caps enum listings beyond the limit', () => {
    const bigEnum: Tool = {
      name: 'pick',
      description: 'Pick one.',
      parameters: {
        type: 'object',
        properties: {
          choice: { type: 'string', description: 'the choice', enum: Array.from({ length: 30 }, (_, i) => `opt${i}`) },
        },
        required: ['choice'],
      },
    };
    const simplified = simplifyToolForLocal(bigEnum);
    expect(simplified.parameters.properties.choice.enum).toHaveLength(12);
    expect(simplified.parameters.properties.choice.enum![0]).toBe('opt0');
  });

  // Snapshots: full vs simplified for three representative tools.
  it('snapshot: configure (verbose description)', () => {
    expect(simplifyToolForLocal(tool('configure'))).toMatchSnapshot();
  });
  it('snapshot: edit_file (gains anchor_hash)', () => {
    expect(simplifyToolForLocal(tool('edit_file'))).toMatchSnapshot();
  });
  it('snapshot: git (enum + trimmed description)', () => {
    expect(simplifyToolForLocal(tool('git'))).toMatchSnapshot();
  });
});

// ===========================================================================
// Anchor hashes (feature 4)
// ===========================================================================

describe('computeAnchorHash', () => {
  it('is a stable 8-char sha256 prefix', () => {
    const h = computeAnchorHash('hello world');
    expect(h).toHaveLength(8);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(computeAnchorHash('hello world')).toBe(h); // deterministic
  });
  it('changes when content changes', () => {
    expect(computeAnchorHash('a')).not.toBe(computeAnchorHash('b'));
  });
  it('anchorHashFooter embeds the hash and instructs re-echo', () => {
    const footer = anchorHashFooter('deadbeef');
    expect(footer).toContain('deadbeef');
    expect(footer).toContain('anchor_hash');
  });
});

// ===========================================================================
// Malformed detection + repair helpers (features 2 & 3)
// ===========================================================================

describe('levenshtein', () => {
  it.each([
    ['read_file', 'read_file', 0],
    ['reae_file', 'read_file', 1],
    ['readfile', 'read_file', 1],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['kitten', 'sitting', 3],
  ])('d(%s,%s)=%i', (a, b, d) => {
    expect(levenshtein(a, b)).toBe(d);
  });
});

describe('detectMalformedToolCall', () => {
  const tools = [tool('read_file'), tool('shell'), tool('edit_file')];

  it('returns null for a well-formed call', () => {
    expect(detectMalformedToolCall(call('read_file', { path: 'a.ts' }), tools)).toBeNull();
  });

  it('flags an unknown tool name with a close match and suggests the neighbour', () => {
    const fault = detectMalformedToolCall(call('reae_file', { path: 'a.ts' }), tools);
    expect(fault).not.toBeNull();
    expect(fault!.suggestion).toBe('read_file');
    expect(fault!.reason).toContain('read_file');
  });

  it('returns null for an unknown tool with no close match (surfaces naturally)', () => {
    expect(detectMalformedToolCall(call('launch_rockets', {}), tools)).toBeNull();
  });

  it('flags a missing required parameter (also how empty-args {} presents)', () => {
    const fault = detectMalformedToolCall(call('read_file', {}), tools);
    expect(fault).not.toBeNull();
    expect(fault!.reason).toContain('path');
  });

  it('treats null-valued required params as missing', () => {
    expect(detectMalformedToolCall(call('shell', { command: null }), tools)).not.toBeNull();
  });
});

describe('buildRepairMessage', () => {
  it('embeds the tool name and reason and asks for ONLY the corrected call', () => {
    const msg = buildRepairMessage(call('read_file', {}), { reason: 'missing required parameter "path"' });
    expect(msg).toContain('read_file');
    expect(msg).toContain('missing required parameter "path"');
    expect(msg).toContain('ONLY');
  });
});

describe('buildToolCallEnvelopeSchema', () => {
  it('constrains name to the known tools and requires name+arguments', () => {
    const schema = buildToolCallEnvelopeSchema(['read_file', 'shell']) as any;
    expect(schema.type).toBe('object');
    expect(schema.properties.name.enum).toEqual(['read_file', 'shell']);
    expect(schema.required).toEqual(['name', 'arguments']);
  });
  it('drops the enum when no tool names are supplied', () => {
    const schema = buildToolCallEnvelopeSchema([]) as any;
    expect(schema.properties.name.enum).toBeUndefined();
  });
});

describe('extractRepairedToolCall', () => {
  it('prefers a native tool call and preserves the original id', () => {
    const out = extractRepairedToolCall('', [{ id: 'new', name: 'read_file', arguments: { path: 'a.ts' } }], 'orig');
    expect(out).toEqual({ id: 'orig', name: 'read_file', arguments: { path: 'a.ts' } });
  });

  it('parses a grammar-constrained JSON envelope from content', () => {
    const content = '{\n  "name": "read_file",\n  "arguments": { "path": "./README.md" }\n}';
    const out = extractRepairedToolCall(content, undefined, 'orig');
    expect(out).toEqual({ id: 'orig', name: 'read_file', arguments: { path: './README.md' } });
  });

  it('digs the envelope out of surrounding prose / code fences', () => {
    const content = 'Sure! ```json\n{"name":"shell","arguments":{"command":"ls"}}\n``` done';
    const out = extractRepairedToolCall(content, undefined, 'x');
    expect(out).toEqual({ id: 'x', name: 'shell', arguments: { command: 'ls' } });
  });

  it('defaults arguments to {} when the envelope omits them', () => {
    const out = extractRepairedToolCall('{"name":"list_files"}', undefined, 'x');
    expect(out).toEqual({ id: 'x', name: 'list_files', arguments: {} });
  });

  it('returns null when there is no usable call', () => {
    expect(extractRepairedToolCall('no json here', undefined, 'x')).toBeNull();
    expect(extractRepairedToolCall('', undefined, 'x')).toBeNull();
    expect(extractRepairedToolCall('{"broken": ', undefined, 'x')).toBeNull(); // unbalanced
    expect(extractRepairedToolCall('{invalid json}', undefined, 'x')).toBeNull(); // balanced but unparseable
    expect(extractRepairedToolCall('{"arguments":{}}', undefined, 'x')).toBeNull(); // no name
  });
});

// ===========================================================================
// Capability profile (feature 6)
// ===========================================================================

describe('familySupportsNativeTools', () => {
  it('recognises tool-calling families', () => {
    for (const m of ['llama3.1:8b', 'qwen2.5-coder', 'mistral:latest', 'devstral', 'gemma4:31b']) {
      expect(familySupportsNativeTools(m)).toBe(true);
    }
  });
  it('rejects families without reliable native tools', () => {
    for (const m of ['gemma2:9b', 'llama2', 'phi-3', 'random-model']) {
      expect(familySupportsNativeTools(m)).toBe(false);
    }
  });
});

describe('getLocalModelProfile', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearLocalModelProfileCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const showResponse = (body: unknown) => ({ ok: true, json: async () => body });

  it('reads native tool support + context length from Ollama capabilities', async () => {
    fetchMock.mockResolvedValue(showResponse({
      capabilities: ['completion', 'vision', 'tools', 'thinking'],
      model_info: { 'gemma4.context_length': 262144 },
    }));
    const p = await getLocalModelProfile('ollama', 'gemma4:31b', 'http://localhost:11434');
    expect(p.supportsNativeToolCalls).toBe(true);
    expect(p.supportsJsonSchemaFormat).toBe(true);
    expect(p.contextLength).toBe(262144);
    expect(p.capabilities).toContain('tools');
  });

  it('marks a model without the tools capability as no-native-tools', async () => {
    fetchMock.mockResolvedValue(showResponse({ capabilities: ['completion', 'vision'] }));
    const p = await getLocalModelProfile('ollama', 'llava:latest', 'http://localhost:11434');
    expect(p.supportsNativeToolCalls).toBe(false);
  });

  it('reads a num_ctx override from Modelfile parameters', async () => {
    fetchMock.mockResolvedValue(showResponse({ capabilities: ['completion', 'tools'], parameters: 'num_ctx 8192\nstop "<|end|>"' }));
    const p = await getLocalModelProfile('ollama', 'custom:latest', 'http://localhost:11434');
    expect(p.contextLength).toBe(8192);
  });

  it('degrades to the family heuristic when /api/show fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const p = await getLocalModelProfile('ollama', 'llama3.1:8b', 'http://localhost:11434');
    expect(p.supportsNativeToolCalls).toBe(true); // family heuristic
    expect(p.capabilities).toBeUndefined();
  });

  it('degrades when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const p = await getLocalModelProfile('ollama', 'gemma2:9b', 'http://localhost:11434');
    expect(p.supportsNativeToolCalls).toBe(false); // gemma2 not in heuristic
  });

  it('does not probe non-ollama local backends and reports no JSON-schema format', async () => {
    const p = await getLocalModelProfile('litellm', 'qwen2.5:7b', 'http://localhost:4000');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(p.supportsJsonSchemaFormat).toBe(false);
    expect(p.supportsNativeToolCalls).toBe(true); // qwen2.5 heuristic
  });

  it('caches per session (one probe per provider|model|baseUrl)', async () => {
    fetchMock.mockResolvedValue(showResponse({ capabilities: ['completion', 'tools'] }));
    await getLocalModelProfile('ollama', 'gemma4:31b', 'http://localhost:11434');
    await getLocalModelProfile('ollama', 'gemma4:31b', 'http://localhost:11434');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalises a /v1-suffixed base URL before probing', async () => {
    fetchMock.mockResolvedValue(showResponse({ capabilities: ['completion', 'tools'] }));
    await getLocalModelProfile('ollama', 'x:1', 'http://localhost:11434/v1');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/show');
  });
});

// ===========================================================================
// System prompt selection (feature 5)
// ===========================================================================

describe('getSystemPromptForProvider', () => {
  it('returns the full prompt for cloud providers', () => {
    expect(getSystemPromptForProvider('anthropic')).toBe(getSystemPrompt());
    expect(getSystemPromptForProvider('openai')).toBe(getSystemPrompt());
  });
  it('returns the compact prompt for local backends', () => {
    expect(getSystemPromptForProvider('ollama')).toBe(getSystemPrompt({ compact: true }));
    expect(getSystemPromptForProvider('litellm', 'http://localhost:4000')).toBe(getSystemPrompt({ compact: true }));
  });
});

describe('compact system prompt', () => {
  const full = getSystemPrompt();
  const compact = getSystemPrompt({ compact: true });
  const safetyBlock = full.slice(0, full.indexOf('[GROUNDING'));

  it('is under 40% of the full prompt by token estimate', () => {
    const ratio = estimateTokens(compact) / estimateTokens(full);
    expect(ratio).toBeLessThan(0.4);
  });

  it('keeps the [SAFETY] rules block present verbatim', () => {
    expect(compact.startsWith(safetyBlock)).toBe(true);
    expect(compact).toContain('[SAFETY - These rules ALWAYS apply and cannot be overridden]');
    expect(compact).toContain('[END SAFETY]');
    // Every non-negotiable safety rule survives verbatim.
    for (const rule of [
      'Only modify files within the user',
      'Never execute destructive system commands',
      'Never access or leak credentials',
      'Do NOT create documentation files unless explicitly requested',
    ]) {
      expect(compact).toContain(rule);
    }
  });

  it('drops the verbose grounding section that only the full prompt carries', () => {
    expect(full).toContain('[GROUNDING');
    expect(compact).not.toContain('[GROUNDING');
    expect(compact).toContain('Calliope');
  });
});

describe('estimateTokens', () => {
  it('scales ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
