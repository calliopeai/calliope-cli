/**
 * Tests for src/providers/openai-compat-shims.ts
 *
 * Covers:
 * - detectShim: URL-based detection for each server type
 * - detectShim: OPENAI_COMPAT_SHIM env var override
 * - transformRequest: per-shim parameter transforms
 * - supportsTools / supportsStreaming capability flags
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectShim } from '../src/providers/openai-compat-shims.js';
import type { CompatShim } from '../src/providers/openai-compat-shims.js';
import type { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseParams(overrides: Partial<ChatCompletionCreateParamsBase> = {}): ChatCompletionCreateParamsBase {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  } as ChatCompletionCreateParamsBase;
}

function saveAndClearShimEnv(): string | undefined {
  const saved = process.env.OPENAI_COMPAT_SHIM;
  delete process.env.OPENAI_COMPAT_SHIM;
  return saved;
}

function restoreShimEnv(saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env.OPENAI_COMPAT_SHIM;
  } else {
    process.env.OPENAI_COMPAT_SHIM = saved;
  }
}

// ---------------------------------------------------------------------------
// 1. detectShim — URL-based detection
// ---------------------------------------------------------------------------

describe('detectShim — URL pattern detection', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = saveAndClearShimEnv();
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('detects lmstudio via port 1234', () => {
    const shim = detectShim('http://localhost:1234/v1');
    expect(shim.id).toBe('lmstudio');
  });

  it('detects lmstudio on non-localhost via port 1234', () => {
    const shim = detectShim('http://192.168.1.10:1234/v1');
    expect(shim.id).toBe('lmstudio');
  });

  it('detects anythingllm via port 3001', () => {
    const shim = detectShim('http://localhost:3001/v1');
    expect(shim.id).toBe('anythingllm');
  });

  it('detects anythingllm via /api/openai path', () => {
    const shim = detectShim('http://192.168.1.5:3001/api/openai/v1');
    expect(shim.id).toBe('anythingllm');
  });

  it('detects anythingllm via /api/openai path without port 3001', () => {
    const shim = detectShim('http://anythingllm.internal/api/openai');
    expect(shim.id).toBe('anythingllm');
  });

  it('detects vllm via port 8000', () => {
    const shim = detectShim('http://localhost:8000/v1');
    expect(shim.id).toBe('vllm');
  });

  it('detects vllm on remote host via port 8000', () => {
    const shim = detectShim('http://10.0.0.5:8000/v1');
    expect(shim.id).toBe('vllm');
  });

  it('detects jan via port 1337', () => {
    const shim = detectShim('http://localhost:1337/v1');
    expect(shim.id).toBe('jan');
  });

  it('detects localai via port 8080', () => {
    const shim = detectShim('http://localhost:8080/v1');
    expect(shim.id).toBe('localai');
  });

  it('returns none for unknown port (9999)', () => {
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.id).toBe('none');
  });

  it('returns none for ollama port (11434) — handled separately', () => {
    const shim = detectShim('http://localhost:11434/v1');
    expect(shim.id).toBe('none');
  });

  it('returns none for a random remote URL', () => {
    const shim = detectShim('https://api.example.com/v1');
    expect(shim.id).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 2. detectShim — OPENAI_COMPAT_SHIM env var override
// ---------------------------------------------------------------------------

describe('detectShim — OPENAI_COMPAT_SHIM env var override', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.OPENAI_COMPAT_SHIM;
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('env var lmstudio overrides URL (even for unknown port)', () => {
    process.env.OPENAI_COMPAT_SHIM = 'lmstudio';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.id).toBe('lmstudio');
  });

  it('env var anythingllm overrides URL', () => {
    process.env.OPENAI_COMPAT_SHIM = 'anythingllm';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.id).toBe('anythingllm');
  });

  it('env var vllm overrides URL', () => {
    process.env.OPENAI_COMPAT_SHIM = 'vllm';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.id).toBe('vllm');
  });

  it('env var jan overrides URL', () => {
    process.env.OPENAI_COMPAT_SHIM = 'jan';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.id).toBe('jan');
  });

  it('env var localai overrides URL', () => {
    process.env.OPENAI_COMPAT_SHIM = 'localai';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.id).toBe('localai');
  });

  it('env var none returns pass-through shim', () => {
    process.env.OPENAI_COMPAT_SHIM = 'none';
    const shim = detectShim('http://localhost:1234/v1');
    expect(shim.id).toBe('none');
  });

  it('unknown env var value falls through to URL auto-detect', () => {
    process.env.OPENAI_COMPAT_SHIM = 'unknown-server';
    const shim = detectShim('http://localhost:1234/v1');
    // Should fall through to URL detection → lmstudio
    expect(shim.id).toBe('lmstudio');
  });

  it('empty env var value falls through to URL auto-detect', () => {
    process.env.OPENAI_COMPAT_SHIM = '';
    const shim = detectShim('http://localhost:1337/v1');
    // Empty string not in SHIM_MAP, falls through to URL detect → jan
    expect(shim.id).toBe('jan');
  });
});

// ---------------------------------------------------------------------------
// 3. LM Studio transformRequest
// ---------------------------------------------------------------------------

describe('lmstudio — transformRequest', () => {
  let shim: CompatShim;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = saveAndClearShimEnv();
    process.env.OPENAI_COMPAT_SHIM = 'lmstudio';
    shim = detectShim('http://localhost:9999/v1');
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('adds max_tokens 8192 when not set', () => {
    const result = shim.transformRequest(baseParams());
    expect(result.max_tokens).toBe(8192);
  });

  it('adds max_tokens 8192 when max_tokens is null', () => {
    const result = shim.transformRequest(baseParams({ max_tokens: null }));
    expect(result.max_tokens).toBe(8192);
  });

  it('keeps existing max_tokens when already set to 4000', () => {
    const result = shim.transformRequest(baseParams({ max_tokens: 4000 }));
    expect(result.max_tokens).toBe(4000);
  });

  it('keeps existing max_tokens when set to 1', () => {
    const result = shim.transformRequest(baseParams({ max_tokens: 1 }));
    expect(result.max_tokens).toBe(1);
  });

  it('does not modify messages or model', () => {
    const params = baseParams({ model: 'my-model' });
    const result = shim.transformRequest(params);
    expect(result.model).toBe('my-model');
    expect(result.messages).toEqual(params.messages);
  });
});

// ---------------------------------------------------------------------------
// 4. vLLM transformRequest
// ---------------------------------------------------------------------------

describe('vllm — transformRequest', () => {
  let shim: CompatShim;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = saveAndClearShimEnv();
    process.env.OPENAI_COMPAT_SHIM = 'vllm';
    shim = detectShim('http://localhost:9999/v1');
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('adds max_tokens 4096 when not set', () => {
    const result = shim.transformRequest(baseParams());
    expect(result.max_tokens).toBe(4096);
  });

  it('adds max_tokens 4096 when max_tokens is null', () => {
    const result = shim.transformRequest(baseParams({ max_tokens: null }));
    expect(result.max_tokens).toBe(4096);
  });

  it('keeps existing max_tokens when set to 2000', () => {
    const result = shim.transformRequest(baseParams({ max_tokens: 2000 }));
    expect(result.max_tokens).toBe(2000);
  });

  it('does not strip tools — vLLM supports them', () => {
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: {} } }];
    const params = baseParams({ tools });
    const result = shim.transformRequest(params);
    expect(result.tools).toEqual(tools);
  });
});

// ---------------------------------------------------------------------------
// 5. AnythingLLM transformRequest
// ---------------------------------------------------------------------------

describe('anythingllm — transformRequest', () => {
  let shim: CompatShim;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = saveAndClearShimEnv();
    process.env.OPENAI_COMPAT_SHIM = 'anythingllm';
    shim = detectShim('http://localhost:9999/v1');
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('strips tools array', () => {
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: {} } }];
    const result = shim.transformRequest(baseParams({ tools }));
    expect(result.tools).toBeUndefined();
  });

  it('strips tool_choice', () => {
    const result = shim.transformRequest(baseParams({ tool_choice: 'auto' }));
    expect(result.tool_choice).toBeUndefined();
  });

  it('does NOT strip messages', () => {
    const params = baseParams();
    const result = shim.transformRequest(params);
    expect(result.messages).toEqual(params.messages);
  });

  it('does NOT strip model', () => {
    const params = baseParams({ model: 'llama3' });
    const result = shim.transformRequest(params);
    expect(result.model).toBe('llama3');
  });

  it('passes through params without tools cleanly', () => {
    const params = baseParams();
    const result = shim.transformRequest(params);
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Jan transformRequest
// ---------------------------------------------------------------------------

describe('jan — transformRequest', () => {
  let shim: CompatShim;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = saveAndClearShimEnv();
    process.env.OPENAI_COMPAT_SHIM = 'jan';
    shim = detectShim('http://localhost:9999/v1');
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('strips tools array', () => {
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: {} } }];
    const result = shim.transformRequest(baseParams({ tools }));
    expect(result.tools).toBeUndefined();
  });

  it('strips tool_choice', () => {
    const result = shim.transformRequest(baseParams({ tool_choice: 'auto' }));
    expect(result.tool_choice).toBeUndefined();
  });

  it('does not strip messages or model', () => {
    const params = baseParams({ model: 'mistral' });
    const result = shim.transformRequest(params);
    expect(result.model).toBe('mistral');
    expect(result.messages).toEqual(params.messages);
  });
});

// ---------------------------------------------------------------------------
// 7. LocalAI transformRequest
// ---------------------------------------------------------------------------

describe('localai — transformRequest', () => {
  let shim: CompatShim;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = saveAndClearShimEnv();
    process.env.OPENAI_COMPAT_SHIM = 'localai';
    shim = detectShim('http://localhost:9999/v1');
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('strips tools array', () => {
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: {} } }];
    const result = shim.transformRequest(baseParams({ tools }));
    expect(result.tools).toBeUndefined();
  });

  it('strips tool_choice', () => {
    const result = shim.transformRequest(baseParams({ tool_choice: 'auto' }));
    expect(result.tool_choice).toBeUndefined();
  });

  it('converts system message to user message with [SYSTEM] prefix', () => {
    const params = baseParams({
      messages: [{ role: 'system', content: 'You are helpful' }],
    });
    const result = shim.transformRequest(params);
    expect(result.messages[0]).toEqual({ role: 'user', content: '[SYSTEM] You are helpful' });
  });

  it('does not modify non-system messages', () => {
    const params = baseParams({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const result = shim.transformRequest(params);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('converts only system messages when mixed with other roles', () => {
    const params = baseParams({
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
    });
    const result = shim.transformRequest(params);
    expect(result.messages[0]).toEqual({ role: 'user', content: '[SYSTEM] Be concise' });
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hi' });
    expect(result.messages[2]).toEqual({ role: 'assistant', content: 'Hello!' });
  });

  it('handles multiple system messages', () => {
    const params = baseParams({
      messages: [
        { role: 'system', content: 'First system' },
        { role: 'system', content: 'Second system' },
        { role: 'user', content: 'Question' },
      ],
    });
    const result = shim.transformRequest(params);
    expect(result.messages[0]).toEqual({ role: 'user', content: '[SYSTEM] First system' });
    expect(result.messages[1]).toEqual({ role: 'user', content: '[SYSTEM] Second system' });
    expect(result.messages[2]).toEqual({ role: 'user', content: 'Question' });
  });

  it('passes through params with no system messages unchanged (except tool strip)', () => {
    const params = baseParams({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
    });
    const result = shim.transformRequest(params);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });
});

// ---------------------------------------------------------------------------
// 8. supportsTools and supportsStreaming flags
// ---------------------------------------------------------------------------

describe('shim capability flags', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = saveAndClearShimEnv();
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('lmstudio: supportsTools=true, supportsStreaming=true', () => {
    process.env.OPENAI_COMPAT_SHIM = 'lmstudio';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.supportsTools).toBe(true);
    expect(shim.supportsStreaming).toBe(true);
  });

  it('anythingllm: supportsTools=false, supportsStreaming=true', () => {
    process.env.OPENAI_COMPAT_SHIM = 'anythingllm';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.supportsTools).toBe(false);
    expect(shim.supportsStreaming).toBe(true);
  });

  it('vllm: supportsTools=true, supportsStreaming=true', () => {
    process.env.OPENAI_COMPAT_SHIM = 'vllm';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.supportsTools).toBe(true);
    expect(shim.supportsStreaming).toBe(true);
  });

  it('jan: supportsTools=false, supportsStreaming=true', () => {
    process.env.OPENAI_COMPAT_SHIM = 'jan';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.supportsTools).toBe(false);
    expect(shim.supportsStreaming).toBe(true);
  });

  it('localai: supportsTools=false, supportsStreaming=true', () => {
    process.env.OPENAI_COMPAT_SHIM = 'localai';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.supportsTools).toBe(false);
    expect(shim.supportsStreaming).toBe(true);
  });

  it('none: supportsTools=true, supportsStreaming=true', () => {
    process.env.OPENAI_COMPAT_SHIM = 'none';
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.supportsTools).toBe(true);
    expect(shim.supportsStreaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. none shim (pass-through)
// ---------------------------------------------------------------------------

describe('none shim — pass-through behavior', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = saveAndClearShimEnv();
    process.env.OPENAI_COMPAT_SHIM = 'none';
  });

  afterEach(() => {
    restoreShimEnv(savedEnv);
  });

  it('returns params unchanged', () => {
    const shim = detectShim('http://localhost:9999/v1');
    const tools = [{ type: 'function' as const, function: { name: 'f', parameters: {} } }];
    const params = baseParams({ tools, max_tokens: 2048 });
    const result = shim.transformRequest(params);
    expect(result).toBe(params); // identity — same reference
  });

  it('has id none', () => {
    const shim = detectShim('http://localhost:9999/v1');
    expect(shim.id).toBe('none');
  });
});
