/**
 * Grammar-constrained output (#188 feature 3) — the Ollama provider passes the
 * JSON-schema `format` param on the repair round-trip, and degrades silently
 * (retry without it) when the server rejects the schema. Fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost:11434'),
  get: vi.fn(),
}));

vi.mock('../src/model-detection.js', () => ({
  getOllamaFallbackModel: vi.fn(),
  getModelContextLimit: vi.fn(() => 128000),
  getModelMaxOutput: vi.fn(() => 8192),
}));

vi.stubGlobal('fetch', vi.fn());

import { chatOllama } from '../src/providers/ollama.js';
import { buildToolCallEnvelopeSchema } from '../src/local-model.js';

const OK = (data: object) => ({
  ok: true,
  status: 200,
  json: async () => data,
  text: async () => JSON.stringify(data),
  clone: () => ({ text: async () => JSON.stringify(data) }),
  body: null,
});

const ERR = (status: number, body: string) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => body,
  clone: () => ({ text: async () => body }),
  body: null,
});

const toolCallResponse = {
  model: 'gemma4:31b',
  message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: { path: 'a.ts' } } }] },
  done: true,
  prompt_eval_count: 5,
  eval_count: 6,
};

const format = buildToolCallEnvelopeSchema(['read_file', 'shell']);

let bodies: any[];
beforeEach(() => {
  vi.clearAllMocks();
  bodies = [];
});

function captureThen(...responses: any[]) {
  let i = 0;
  vi.mocked(fetch).mockImplementation(async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return (responses[i++] ?? responses[responses.length - 1]) as Response;
  });
}

describe('chatOllama format param', () => {
  it('includes the format schema in the request body when provided', async () => {
    captureThen(OK(toolCallResponse));
    await chatOllama([{ role: 'user', content: 'read a.ts' }], [], 'gemma4:31b', undefined, { format });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].format).toEqual(format);
  });

  it('omits format when no options are passed (normal turns stay unconstrained)', async () => {
    captureThen(OK(toolCallResponse));
    await chatOllama([{ role: 'user', content: 'hi' }], [], 'gemma4:31b');
    expect(bodies[0].format).toBeUndefined();
  });

  it('degrades silently: retries WITHOUT format when the server rejects the schema (400)', async () => {
    captureThen(ERR(400, 'invalid format: unsupported schema'), OK(toolCallResponse));
    const res = await chatOllama([{ role: 'user', content: 'read a.ts' }], [], 'gemma4:31b', undefined, { format });
    // Two requests: the constrained one (rejected), then the unconstrained retry.
    expect(bodies).toHaveLength(2);
    expect(bodies[0].format).toEqual(format);
    expect(bodies[1].format).toBeUndefined();
    // The call still succeeds via the retry.
    expect(res.toolCalls).toHaveLength(1);
    expect(res.finishReason).toBe('tool_use');
  });

  it('does not retry-without-format when the constrained request succeeds', async () => {
    captureThen(OK(toolCallResponse));
    await chatOllama([{ role: 'user', content: 'read a.ts' }], [], 'gemma4:31b', undefined, { format });
    expect(bodies).toHaveLength(1);
  });

  it('surfaces the error when the format-less retry also fails', async () => {
    captureThen(ERR(400, 'bad format'), ERR(500, 'server exploded'));
    await expect(
      chatOllama([{ role: 'user', content: 'x' }], [], 'gemma4:31b', undefined, { format }),
    ).rejects.toThrow(/500/);
    expect(bodies).toHaveLength(2);
  });
});
