import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import { ExecutionLimitError } from '../src/execution/index.js';
import type { ChatOptions } from '../src/providers/index.js';
import type { LLMResponse, Message } from '../src/types.js';

const mockChat = vi.fn();
vi.mock('../src/providers/index.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  selectProvider: (p: string) => (p && p !== 'auto' ? p : 'anthropic'),
}));

import { buildMessages, buildOutputSchema, confidenceOf, evaluate, normalizeDistribution, parseModelOutput, toAnswer, validateRequest } from '../src/judgment/evaluate.js';
import { formatJudgment, loadRequest, runJudge } from '../src/judgment/cli.js';
import { JudgmentError, type JudgmentRequest } from '../src/judgment/types.js';

const request: JudgmentRequest = {
  state: 'Help! My payouts have been failing for 3 days.',
  questions: {
    is_urgent: { type: 'noul', instructions: 'Does this convey urgency?', criteria: { true: 'Time-sensitive', false: 'No urgency' } },
    department: { type: 'choice', instructions: 'Which team should handle this?', criteria: { billing: 'Payments', technical: 'Bugs', sales: null } },
    frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
  },
};

const modelJson = JSON.stringify({
  q1: { yes: 0.92, no: 0.08 },
  q2: { billing: 0.85, technical: 0.1, sales: 0.05 },
  q3: { '0': 0.05, '1': 0.3, '2': 0.65 },
});

function reply(content: string, extra: Partial<LLMResponse> = {}): LLMResponse {
  return { content, finishReason: 'stop', usage: { inputTokens: 312, outputTokens: 48 }, ...extra };
}

beforeEach(() => { config.resetConfig(); mockChat.mockReset(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected networking'); })); });
afterEach(() => { config.resetConfig(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('validateRequest', () => {
  it('accepts every primitive and returns a typed copy', () => {
    expect(validateRequest(request)).toEqual(request);
  });

  it.each([
    [{ questions: request.questions }, /"state" is required/],
    [{ state: '   ', questions: request.questions }, /must not be empty/],
    [{ state: 'x', questions: {} }, /at least one question/],
    [{ state: 'x', questions: { 'bad id!': request.questions.is_urgent } }, /must match/],
    [{ state: 'x', questions: { q: { type: 'noul', instructions: '' } } }, /empty instructions/],
    [{ state: 'x', questions: { q: { type: 'noul', instructions: 'ok', criteria: { maybe: 'x' } } } }, /only accept "true" and "false"/],
    [{ state: 'x', questions: { q: { type: 'choice', instructions: 'ok', criteria: { only: null } } } }, /at least two options/],
    [{ state: 'x', questions: { q: { type: 'choice', instructions: 'ok', criteria: { a: 1, b: null } } } }, /string or null/],
    [{ state: 'x', questions: { q: { type: 'score', instructions: 'ok', criteria: ['one'] } } }, /at least two level/],
    [{ state: 'x', questions: { q: { type: 'score', instructions: 'ok', criteria: ['a', ''] } } }, /non-empty string/],
    [{ state: 'x', questions: { q: { type: 'rank', instructions: 'ok' } } }, /unknown type/],
  ])('rejects %j', (input, pattern) => {
    expect(() => validateRequest(input)).toThrowError(expect.objectContaining({ code: 'invalid-request', message: expect.stringMatching(pattern) }));
  });
});

describe('prompted engine', () => {
  it('never sends question ids to the model and constrains the output schema', () => {
    const { messages, ids } = buildMessages(request);
    expect(ids).toEqual(['is_urgent', 'department', 'frustration']);
    const text = messages.map(m => m.content).join('\n');
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).toContain('"q1"');
    expect(text).toContain('Payments');
    expect(text).toContain('Time-sensitive');
    expect(text).toContain('lowest to highest');
    const schema = buildOutputSchema(request) as { properties: Record<string, { required: string[] }>; required: string[] };
    expect(schema.required).toEqual(['q1', 'q2', 'q3']);
    expect(schema.properties.q1!.required).toEqual(['yes', 'no']);
    expect(schema.properties.q2!.required).toEqual(['billing', 'technical', 'sales']);
    expect(schema.properties.q3!.required).toEqual(['0', '1', '2']);
  });

  it('serializes structured state and instructions', () => {
    const { messages } = buildMessages({ state: { ticket: { text: 'hi' } }, questions: { q: { type: 'noul', instructions: { ask: 'is it a greeting?' } } } });
    expect(messages[1]!.content).toContain('"ticket"');
    expect(messages[1]!.content).toContain('is it a greeting?');
  });

  it('parses bare JSON, fenced JSON and JSON surrounded by prose', () => {
    expect(parseModelOutput(modelJson)).toMatchObject({ q1: { yes: 0.92 } });
    expect(parseModelOutput('```json\n' + modelJson + '\n```')).toMatchObject({ q2: { billing: 0.85 } });
    expect(parseModelOutput('Sure, here you go: ' + modelJson + ' Done.')).toMatchObject({ q3: { '2': 0.65 } });
  });

  it.each([['no json here'], ['{"q1": }'], ['[1,2]']])('rejects unusable output %j', (text) => {
    expect(() => parseModelOutput(text)).toThrowError(expect.objectContaining({ code: 'model-output' }));
  });

  it('normalizes distributions: fills missing keys, clamps negatives, renormalizes', () => {
    expect(normalizeDistribution('q', ['a', 'b', 'c'], { a: 2, b: 2, extra: 9 })).toEqual({ a: 0.5, b: 0.5, c: 0 });
    expect(normalizeDistribution('q', ['a', 'b'], { a: -1, b: 3 })).toEqual({ a: 0, b: 1 });
    expect(() => normalizeDistribution('q', ['a', 'b'], { a: 0, b: 'high' })).toThrowError(expect.objectContaining({ code: 'model-output' }));
    expect(() => normalizeDistribution('q', ['a', 'b'], 'nope')).toThrowError(expect.objectContaining({ code: 'model-output' }));
  });

  it('confidence is 1 when peaked, 0 when uniform, and scales with the lead over chance', () => {
    expect(confidenceOf({ a: 1, b: 0, c: 0 })).toBe(1);
    expect(confidenceOf({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })).toBe(0);
    expect(confidenceOf({ a: 0.5, b: 0.5 })).toBe(0);
    expect(confidenceOf({ a: 0.89, b: 0.11, c: 0 })).toBeCloseTo(0.835, 3);
    expect(confidenceOf({ only: 1 })).toBe(1);
  });

  it('derives typed answers: noul probability, top choice, expected score with legend', () => {
    expect(toAnswer(request.questions.is_urgent!, { yes: 0.92, no: 0.08 })).toEqual({ type: 'noul', noul: 0.92 });
    expect(toAnswer(request.questions.department!, { billing: 0.85, technical: 0.1, sales: 0.05 })).toMatchObject({ type: 'choice', choice: 'billing', probabilities: { billing: 0.85 } });
    const score = toAnswer(request.questions.frustration!, { '0': 0.05, '1': 0.3, '2': 0.65 });
    expect(score).toMatchObject({ type: 'score', score: 1.6, legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' } });
  });

  it('evaluates through chat() with no tools, an output schema, and reports the resolved backend', async () => {
    mockChat.mockResolvedValueOnce(reply(modelJson));
    const response = await evaluate(request, { provider: 'ollama', model: 'qwen:latest' });
    expect(mockChat).toHaveBeenCalledTimes(1);
    const [provider, messages, tools, model, onToken, onRetry, options] = mockChat.mock.calls[0]! as [string, Message[], unknown[], string, unknown, unknown, { format: unknown; selectionMode: string }];
    expect(provider).toBe('ollama');
    expect(messages[0]!.role).toBe('system');
    expect(tools).toEqual([]);
    expect(model).toBe('qwen:latest');
    expect(onToken).toBeUndefined();
    expect(onRetry).toBeUndefined();
    expect(options.format).toMatchObject({ type: 'object' });
    expect(options.selectionMode).toBe('explicit');
    // No bounded-execution controls by default: an unbudgeted judgment call behaves exactly as before #368.
    expect((options as ChatOptions).maxOutputTokens).toBeUndefined();
    expect((options as ChatOptions).bounded).toBeUndefined();
    expect((options as ChatOptions).attemptBudget).toBeUndefined();
    expect(response).toEqual({
      provider: 'ollama', model: 'qwen:latest',
      answers: {
        is_urgent: { type: 'noul', noul: 0.92 },
        department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.85, technical: 0.1, sales: 0.05 }, confidence: 0.775 },
        frustration: { type: 'score', score: 1.6, legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' }, probabilities: { '0': 0.05, '1': 0.3, '2': 0.65 }, confidence: 0.475 },
      },
      usage: { input_tokens: 312, output_tokens: 48 },
    });
  });

  it('resolves auto to the selected provider and its fallback model', async () => {
    mockChat.mockResolvedValueOnce(reply(modelJson));
    const response = await evaluate(request);
    expect(mockChat.mock.calls[0]![6]).toMatchObject({ selectionMode: 'auto' });
    expect(response.provider).toBe('anthropic');
    expect(response.model).toBeTruthy();
  });

  it('threads maxOutputTokens, bounded and attemptBudget into chat() unchanged, so a governed caller admits the same call it reserved', async () => {
    mockChat.mockResolvedValueOnce(reply(modelJson));
    const attemptBudget = { reserve: vi.fn(), settle: vi.fn() };
    await evaluate(request, { provider: 'openai', maxOutputTokens: 64, bounded: true, attemptBudget });
    const options = mockChat.mock.calls[0]![6] as ChatOptions;
    expect(options.maxOutputTokens).toBe(64);
    expect(options.bounded).toBe(true);
    expect(options.attemptBudget).toBe(attemptBudget); // same instance: evaluate() never wraps or clones the caller's budget
  });

  it('propagates a budget or admission failure from chat() unwrapped, so callers already handling ExecutionLimitError see the same shape', async () => {
    mockChat.mockRejectedValueOnce(new ExecutionLimitError('budget', 'Provider usage exceeded its reservation; further execution is stopped.'));
    await expect(evaluate(request, { provider: 'openai', maxOutputTokens: 64, attemptBudget: { reserve: vi.fn(), settle: vi.fn() } }))
      .rejects.toMatchObject({ name: 'ExecutionLimitError', code: 'budget' });
  });

  it('surfaces refusals, truncated answers and provider failures as typed errors', async () => {
    mockChat.mockResolvedValueOnce(reply('', { errorCode: 'refusal' }));
    await expect(evaluate(request, { provider: 'openai' })).rejects.toMatchObject({ code: 'model-output' });
    mockChat.mockResolvedValueOnce(reply('{"q1": {"yes": 1, "no": 0}}'));
    await expect(evaluate(request, { provider: 'openai' })).rejects.toMatchObject({ code: 'model-output', message: expect.stringContaining('department') });
    mockChat.mockRejectedValueOnce(new Error('boom'));
    await expect(evaluate(request, { provider: 'openai' })).rejects.toThrow('boom');
  });

  it('validates before any provider call and honors cancellation', async () => {
    await expect(evaluate({ state: 'x', questions: {} })).rejects.toMatchObject({ code: 'invalid-request' });
    const controller = new AbortController(); controller.abort();
    await expect(evaluate(request, { signal: controller.signal })).rejects.toThrow();
    expect(mockChat).not.toHaveBeenCalled();
  });
});

describe('typesafe engine', () => {
  const nativeAnswers = {
    model: 'jev-1.13.0',
    answers: {
      is_urgent: { type: 'noul', noul: 0.98 },
      department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.89, technical: 0.11, sales: 0 }, confidence: 0.83 },
      frustration: { type: 'score', score: 1.2, legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' }, probabilities: { '0': 0, '1': 0.8, '2': 0.2 }, confidence: 0.71 },
    },
    usage: { input_tokens: 443, output_tokens: 73 },
  };
  const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

  it('requires a credential and never calls the network without one', async () => {
    await expect(evaluate(request, { provider: 'typesafe' })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('TYPESAFE_API_KEY') });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts the documented request shape with the caller ids and passes native answers through', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'secret-key');
    const doFetch = vi.fn(async () => ok(nativeAnswers));
    const response = await evaluate(request, { provider: 'typesafe', fetch: doFetch as unknown as typeof fetch });
    const [url, init] = doFetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    expect(JSON.parse(String(init.body))).toEqual({ state: request.state, model: 'jev-latest', questions: request.questions });
    expect(response).toEqual({ provider: 'typesafe', model: 'jev-1.13.0', answers: nativeAnswers.answers, usage: nativeAnswers.usage });
  });

  it('prefers the stored credential and base URL when the env is unset, and honors --model', async () => {
    config.setProviderCred('typesafe', { apiKey: 'stored-key', baseUrl: 'https://proxy.invalid/v1/' });
    const doFetch = vi.fn(async () => ok(nativeAnswers));
    await evaluate(request, { provider: 'typesafe', model: 'jev-1.13.0', fetch: doFetch as unknown as typeof fetch });
    const [url, init] = doFetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://proxy.invalid/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer stored-key');
    expect(JSON.parse(String(init.body)).model).toBe('jev-1.13.0');
  });

  it('retries 429/529 with retry-after backoff and gives up after the bounded attempts', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('TYPESAFE_API_KEY', 'k');
      const doFetch = vi.fn()
        .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(new Response('overloaded', { status: 529 }))
        .mockResolvedValueOnce(ok(nativeAnswers));
      const pending = evaluate(request, { provider: 'typesafe', fetch: doFetch as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await pending).model).toBe('jev-1.13.0');
      expect(doFetch).toHaveBeenCalledTimes(3);

      const exhausted = vi.fn(async () => new Response('slow down', { status: 429 }));
      const failing = evaluate(request, { provider: 'typesafe', fetch: exhausted as unknown as typeof fetch });
      const rejected = expect(failing).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('429') });
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
      await rejected;
      expect(exhausted).toHaveBeenCalledTimes(4);
    } finally { vi.useRealTimers(); }
  });

  it('maps 422 to invalid-request, 401 to unavailable, and rejects malformed answers', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'k');
    const status = (code: number) => vi.fn(async () => new Response('{"detail":"bad"}', { status: code })) as unknown as typeof fetch;
    await expect(evaluate(request, { provider: 'typesafe', fetch: status(422) })).rejects.toMatchObject({ code: 'invalid-request', message: expect.stringContaining('422') });
    await expect(evaluate(request, { provider: 'typesafe', fetch: status(401) })).rejects.toMatchObject({ code: 'unavailable' });
    const wrongType = vi.fn(async () => ok({ ...nativeAnswers, answers: { ...nativeAnswers.answers, is_urgent: { type: 'choice', choice: 'x' } } })) as unknown as typeof fetch;
    await expect(evaluate(request, { provider: 'typesafe', fetch: wrongType })).rejects.toMatchObject({ code: 'model-output', message: expect.stringContaining('is_urgent') });
    const outsideCriteria = vi.fn(async () => ok({ ...nativeAnswers, answers: { ...nativeAnswers.answers, department: { ...nativeAnswers.answers.department, choice: 'legal' } } })) as unknown as typeof fetch;
    await expect(evaluate(request, { provider: 'typesafe', fetch: outsideCriteria })).rejects.toMatchObject({ code: 'model-output', message: expect.stringContaining('outside the criteria') });
    const notJson = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    await expect(evaluate(request, { provider: 'typesafe', fetch: notJson })).rejects.toMatchObject({ code: 'model-output' });
    const failing = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(evaluate(request, { provider: 'typesafe', fetch: failing })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('ECONNREFUSED') });
  });
});

describe('calliope judge', () => {
  let dir: string;
  const out: string[] = [];
  const write = (text: string) => { out.push(text); };
  beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'judge-')); out.length = 0; });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('runs a request file through the resolved provider and prints the JSON contract', async () => {
    const file = join(dir, 'req.json'); fs.writeFileSync(file, JSON.stringify(request));
    mockChat.mockResolvedValueOnce(reply(modelJson));
    expect(await runJudge(['--request', file, '--provider', 'ollama', '--model', 'qwen:latest', '--json'], { write, cwd: dir })).toBe(0);
    const doc = JSON.parse(out[0]!);
    expect(doc).toMatchObject({ version: 1, type: 'judgment', provider: 'ollama', model: 'qwen:latest', usage: { input_tokens: 312 } });
    expect(doc.answers.department.choice).toBe('billing');
  });

  it('reads the request from stdin and prints a readable table by default', async () => {
    mockChat.mockResolvedValueOnce(reply(modelJson));
    expect(await runJudge(['--request', '-', '--provider', 'ollama'], { write, cwd: dir, stdin: () => JSON.stringify(request) })).toBe(0);
    expect(out[0]).toContain('ollama/');
    expect(out[0]).toMatch(/is_urgent\tnoul\t0\.92/);
    expect(out[0]).toMatch(/department\tchoice\tbilling/);
    expect(out[0]).toMatch(/frustration\tscore\t1\.60.*Calm 0\.05/);
  });

  it('combines --questions with --state text or a --state-file (JSON files are parsed)', async () => {
    const questions = join(dir, 'q.json'); fs.writeFileSync(questions, JSON.stringify(request.questions));
    expect(loadRequest({ questions, state: 'plain text' }, () => '')).toEqual({ state: 'plain text', questions: request.questions });
    const stateJson = join(dir, 'state.json'); fs.writeFileSync(stateJson, '{"ticket": 1}');
    expect(loadRequest({ questions, 'state-file': stateJson }, () => '')).toEqual({ state: { ticket: 1 }, questions: request.questions });
    const stateTxt = join(dir, 'state.txt'); fs.writeFileSync(stateTxt, 'raw\n');
    expect(loadRequest({ questions, 'state-file': stateTxt }, () => '')).toEqual({ state: 'raw\n', questions: request.questions });
    expect(loadRequest({ questions, 'state-file': '-' }, () => 'from stdin')).toMatchObject({ state: 'from stdin' });
  });

  it.each([
    [[], /exactly one of --request or --questions/],
    [['--request', 'a', '--questions', 'b'], /exactly one of --request or --questions/],
    [['--request', 'a', '--state', 'x'], /already carries the state/],
    [['--questions', 'a'], /exactly one of --state or --state-file/],
  ])('rejects conflicting input flags %j with exit 2', async (args, pattern) => {
    expect(await runJudge([...args, '--json'], { write, cwd: dir })).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ error: 'invalid-request', message: expect.stringMatching(pattern) });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('rejects unknown flags, unknown providers and duplicate providers with usage', async () => {
    expect(await runJudge(['--bogus'], { write, cwd: dir })).toBe(2);
    expect(out[0]).toContain('calliope judge --request');
    expect(await runJudge(['--request', 'x', '--provider', 'nope'], { write, cwd: dir })).toBe(2);
    expect(await runJudge(['--request', 'x', '--provider', 'typesafe', '--provider', 'ollama'], { write, cwd: dir })).toBe(2);
    expect(await runJudge(['--request', 'x', '--provider=typesafe', '--provider', 'typesafe'], { write, cwd: dir })).toBe(2);
  });

  it('reports invalid request bodies as exit 2 and model failures as exit 1', async () => {
    const bad = join(dir, 'bad.json'); fs.writeFileSync(bad, '{"state": "x", "questions": {}}');
    expect(await runJudge(['--request', bad, '--provider', 'ollama', '--json'], { write, cwd: dir })).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ error: 'invalid-request' });
    const notJson = join(dir, 'not.json'); fs.writeFileSync(notJson, 'nope');
    expect(await runJudge(['--request', notJson, '--provider', 'ollama'], { write, cwd: dir })).toBe(2);
    const file = join(dir, 'req.json'); fs.writeFileSync(file, JSON.stringify(request));
    mockChat.mockResolvedValueOnce(reply('garbage'));
    expect(await runJudge(['--request', file, '--provider', 'ollama', '--json'], { write, cwd: dir })).toBe(1);
    expect(JSON.parse(out[2]!)).toMatchObject({ error: 'model-output' });
    mockChat.mockRejectedValueOnce(new Error('provider down'));
    expect(await runJudge(['--request', file, '--provider', 'ollama'], { write, cwd: dir })).toBe(1);
    expect(out[3]).toContain('provider down');
  });

  it('routes --provider typesafe to the native engine without touching chat providers', async () => {
    const file = join(dir, 'req.json'); fs.writeFileSync(file, JSON.stringify(request));
    expect(await runJudge(['--request', file, '--provider', 'typesafe', '--json'], { write, cwd: dir })).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ error: 'unavailable', message: expect.stringContaining('TYPESAFE_API_KEY') });
    expect(mockChat).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports cancellation as exit 130', async () => {
    const file = join(dir, 'req.json'); fs.writeFileSync(file, JSON.stringify(request));
    const controller = new AbortController(); controller.abort();
    expect(await runJudge(['--request', file, '--provider', 'ollama', '--json'], { write, cwd: dir, signal: controller.signal })).toBe(130);
    expect(JSON.parse(out[0]!)).toMatchObject({ error: 'cancelled' });
  });

  it('formats native answers with legends', () => {
    const text = formatJudgment({ provider: 'typesafe', model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 2 }, answers: {
      s: { type: 'score', score: 1.2, legend: { '0': 'Low', '1': 'High' }, probabilities: { '0': 0.2, '1': 0.8 }, confidence: 0.6 },
    } });
    expect(text).toContain('typesafe/jev-1.13.0');
    expect(text).toMatch(/s\tscore\t1\.20\t\(confidence 0\.60\)\tLow 0\.20 · High 0\.80/);
  });
});
