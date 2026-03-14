/**
 * OpenAI-Compatible Server Shims
 *
 * Provides compatibility shims for popular local inference servers:
 * LM Studio, AnythingLLM, vLLM, Jan, LocalAI.
 *
 * Each shim can detect its target server by URL pattern and transform
 * request parameters to work around server-specific limitations.
 */

import type { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions.js';

export interface CompatShim {
  id: 'lmstudio' | 'anythingllm' | 'vllm' | 'jan' | 'localai' | 'none';
  name: string;
  description: string;
  detect(baseUrl: string): boolean;
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase;
  supportsTools: boolean;
  supportsStreaming: boolean;
}

// ---------------------------------------------------------------------------
// One-time tool-strip warnings (keyed by shim id)
// Exported for test resets via resetToolWarnings()
// ---------------------------------------------------------------------------

const warnedShims = new Set<string>();

/** Reset tool-strip warnings — for use in tests only. */
export function resetToolWarnings(): void {
  warnedShims.clear();
}

// ---------------------------------------------------------------------------
// Shim implementations
// ---------------------------------------------------------------------------

const lmstudioShim: CompatShim = {
  id: 'lmstudio',
  name: 'LM Studio',
  description: 'Local LLM server by LM Studio (default port 1234)',
  supportsTools: true,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':1234');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if (result.max_tokens == null) {
      result.max_tokens = 8192;
    }
    return result;
  },
};

const anythingllmShim: CompatShim = {
  id: 'anythingllm',
  name: 'AnythingLLM',
  description: 'All-in-one AI application (default port 3001, /api/openai path)',
  supportsTools: false,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':3001') || baseUrl.includes('/api/openai');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if ((result.tools || result.tool_choice) && !warnedShims.has('anythingllm')) {
      warnedShims.add('anythingllm');
      process.stderr.write(
        '[openai-compat] AnythingLLM does not support tool_calls — stripping tools and tool_choice\n'
      );
    }
    delete result.tools;
    delete result.tool_choice;
    return result;
  },
};

const vllmShim: CompatShim = {
  id: 'vllm',
  name: 'vLLM',
  description: 'High-throughput inference engine (default port 8000)',
  supportsTools: true,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':8000');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if (result.max_tokens == null) {
      result.max_tokens = 4096;
    }
    return result;
  },
};

const janShim: CompatShim = {
  id: 'jan',
  name: 'Jan',
  description: 'Open-source local AI desktop app (default port 1337)',
  supportsTools: false,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':1337');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if ((result.tools || result.tool_choice) && !warnedShims.has('jan')) {
      warnedShims.add('jan');
      process.stderr.write(
        '[openai-compat] Jan does not support tool_calls — stripping tools and tool_choice\n'
      );
    }
    delete result.tools;
    delete result.tool_choice;
    return result;
  },
};

const localaiShim: CompatShim = {
  id: 'localai',
  name: 'LocalAI',
  description: 'Free, open-source OpenAI alternative (default port 8080)',
  supportsTools: false,
  supportsStreaming: true,
  detect(baseUrl: string): boolean {
    return baseUrl.includes(':8080');
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    const result = { ...params };
    if ((result.tools || result.tool_choice) && !warnedShims.has('localai')) {
      warnedShims.add('localai');
      process.stderr.write(
        '[openai-compat] LocalAI does not support tool_calls — stripping tools and tool_choice\n'
      );
    }
    delete result.tools;
    delete result.tool_choice;
    // Convert system role messages to user messages with [SYSTEM] prefix
    if (result.messages) {
      result.messages = result.messages.map((msg) => {
        if (msg.role === 'system') {
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return { role: 'user' as const, content: `[SYSTEM] ${content}` };
        }
        return msg;
      });
    }
    return result;
  },
};

const noneShim: CompatShim = {
  id: 'none',
  name: 'None (pass-through)',
  description: 'No shim applied — pass requests through unchanged',
  supportsTools: true,
  supportsStreaming: true,
  detect(_baseUrl: string): boolean {
    return false;
  },
  transformRequest(params: ChatCompletionCreateParamsBase): ChatCompletionCreateParamsBase {
    return params;
  },
};

// ---------------------------------------------------------------------------
// Detection order (priority: env var → URL pattern → fallback)
// ---------------------------------------------------------------------------

const ALL_SHIMS: CompatShim[] = [lmstudioShim, anythingllmShim, vllmShim, janShim, localaiShim];

const SHIM_MAP: Record<string, CompatShim> = {
  lmstudio: lmstudioShim,
  anythingllm: anythingllmShim,
  vllm: vllmShim,
  jan: janShim,
  localai: localaiShim,
  none: noneShim,
};

/**
 * Detect which compatibility shim to use for the given base URL.
 *
 * Priority:
 * 1. `OPENAI_COMPAT_SHIM` env var (exact match to shim id)
 * 2. URL pattern matching (in order: lmstudio, anythingllm, vllm, jan, localai)
 * 3. Fallback to pass-through (none)
 */
export function detectShim(baseUrl: string): CompatShim {
  // 1. Env var override
  const envShim = process.env.OPENAI_COMPAT_SHIM;
  if (envShim && envShim in SHIM_MAP) {
    const shim = SHIM_MAP[envShim];
    if (shim.id !== 'none') {
      process.stderr.write(`[openai-compat] Detected ${shim.name} — applying compatibility shim\n`);
    }
    return shim;
  }

  // 2. URL pattern matching
  for (const shim of ALL_SHIMS) {
    if (shim.detect(baseUrl)) {
      process.stderr.write(`[openai-compat] Detected ${shim.name} — applying compatibility shim\n`);
      return shim;
    }
  }

  // 3. Pass-through
  return noneShim;
}
