/** evaluate() threading chat()'s bounded-execution controls: real chat() and ledger, only HTTP is synthetic. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import { providerTarget } from '../src/health/index.js';
import { ExecutionGuard, ExecutionLimitError, ReservationLedger, manifestHash } from '../src/execution/index.js';
import { executionManifest } from './helpers/execution-manifest.js';
import { projectBudgetPath } from '../src/budget.js';
import { clearModelCache } from '../src/model-detection.js';
import { evaluate } from '../src/judgment/evaluate.js';
import { JudgmentError, type JudgmentRequest } from '../src/judgment/types.js';
import type { RouteCandidate } from '../src/routing/index.js';

const OUTPUT_LIMIT = 40;
const request: JudgmentRequest = { state: 'Help! My payouts have been failing for 3 days.', questions: { urgent: { type: 'noul', instructions: 'Does this convey urgency?' } } };
const modelJson = JSON.stringify({ q1: { yes: 0.9, no: 0.1 } });
const chatCompletion = (content: string) => ({
  id: 'chat_1', object: 'chat.completion', created: 1, model: 'judgment-toy',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let root: string, project: string, route: RouteCandidate, requests: { path: string; body: unknown }[];
let respond: (path: string, body: unknown) => Promise<Response>;

function guard(maxOutputTokens = OUTPUT_LIMIT) {
  const manifest = executionManifest(project), ledger = new ReservationLedger(join(root, 'ledger'));
  ledger.create(manifest);
  return { ledger, manifest, execution: new ExecutionGuard({ ledger, manifestHash: manifestHash(manifest), agentId: 'a', maxOutputTokens }, project) };
}

beforeEach(() => {
  config.resetConfig(); clearModelCache();
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-judgment-bounded-')));
  project = join(root, 'project'); fs.mkdirSync(project);
  vi.stubEnv('CALLIOPE_BILLING_FILE', join(root, 'billing.json')); // left unwritten: no billing evidence, plain estimate quote
  vi.stubEnv('DEEPSEEK_API_KEY', ''); vi.stubEnv('DEEPSEEK_BASE_URL', '');
  config.setProviderCred('deepseek', { apiKey: 'synthetic', baseUrl: 'https://judgment-bounded.invalid/v1' });
  // Non-local, non-measured reservations conservatively charge the full discovered context
  // window (not a tokenizer estimate); keep it small so two attempts fit the fixture's account budget.
  route = { provider: 'deepseek', model: 'judgment-toy', target: providerTarget('deepseek').key, evidence: 'live', discoveredAt: new Date().toISOString(), capabilities: { chat: true }, contextLength: 500, maxOutputTokens: 200, price: { input: 2, output: 5 }, estimatedCost: null, latencyMs: null, errorRate: null, score: 0, reason: 'Live discovery fixture' };
  requests = [];
  respond = async () => json(chatCompletion(modelJson));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), body = req.method === 'POST' ? await req.json() : undefined;
    requests.push({ path: new URL(req.url).pathname, body });
    return respond(new URL(req.url).pathname, body);
  }));
});
afterEach(() => {
  config.resetConfig(); clearModelCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  fs.rmSync(join(projectBudgetPath(project), '..'), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('evaluate() bounded execution', () => {
  it('reserves through a real ExecutionGuard ledger, bounds the wire request to the reviewed limit, and settles exactly once', async () => {
    const { execution, ledger } = guard();
    const budget = execution.budget(route, [], [], false);
    const response = await evaluate(request, { provider: 'deepseek', model: route.model, maxOutputTokens: OUTPUT_LIMIT, attemptBudget: budget });
    expect(response.answers.urgent).toMatchObject({ type: 'noul', noul: 0.9 });
    expect(requests).toHaveLength(1);
    expect((requests[0]!.body as { max_tokens: number }).max_tokens).toBe(OUTPUT_LIMIT);
    const saved = ledger.read(project), entries = Object.values(saved.projection.requests);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe('settled');
    expect(saved.projection.spent.tokens).toBeGreaterThan(0);
  });

  it('never admits a request when bounded is set without a reviewed output limit, and never reserves or dials out', async () => {
    const reserve = vi.fn(), settle = vi.fn();
    await expect(evaluate(request, { provider: 'deepseek', model: route.model, bounded: true, attemptBudget: { reserve, settle } }))
      .rejects.toMatchObject({ name: 'ExecutionLimitError', code: 'invalid' });
    expect(reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates an admission denial as-is, with no network call and no reservation retained', async () => {
    const reserve = vi.fn(async () => { throw new ExecutionLimitError('budget', 'No capacity.'); }), settle = vi.fn();
    await expect(evaluate(request, { provider: 'deepseek', model: route.model, maxOutputTokens: OUTPUT_LIMIT, attemptBudget: { reserve, settle } }))
      .rejects.toMatchObject({ name: 'ExecutionLimitError', code: 'budget', message: 'No capacity.' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reserves and settles each attempt independently across a real transient failure: no doubled or dropped charge', async () => {
    const { execution, ledger } = guard();
    const budget = execution.budget(route, [], [], false);
    let attempts = 0;
    respond = async () => { attempts++; return attempts === 1 ? json({ error: { message: 'Synthetic unavailable' } }, 503) : json(chatCompletion(modelJson)); };
    const response = await evaluate(request, { provider: 'deepseek', model: route.model, maxOutputTokens: OUTPUT_LIMIT, attemptBudget: budget });
    expect(response.answers.urgent).toMatchObject({ type: 'noul' });
    expect(attempts).toBe(2);
    const saved = ledger.read(project), entries = Object.values(saved.projection.requests);
    // One reservation per attempt: the failed first attempt keeps its charge (state 'unknown', never refunded
    // or reused for the retry), and the second attempt is reserved and settled fresh.
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.state)).toEqual(['unknown', 'settled']);
    expect(saved.projection.spent.tokens).toBeGreaterThan(0);
  }, 15000); // real shared server-error backoff, not synthetic

  it.each([
    ['attemptBudget', { attemptBudget: { reserve: vi.fn(), settle: vi.fn() } }],
    ['bounded', { bounded: true }],
    ['maxOutputTokens', { maxOutputTokens: OUTPUT_LIMIT }],
  ] as const)('rejects %s for the typesafe engine before any network call, since it never calls chat()', async (_label, extra) => {
    await expect(evaluate(request, { provider: 'typesafe', ...extra })).rejects.toMatchObject(expect.objectContaining({ code: 'invalid-request' }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects typesafe with every bounded control set together, in one error', async () => {
    const reserve = vi.fn(), settle = vi.fn();
    await expect(evaluate(request, { provider: 'typesafe', bounded: true, maxOutputTokens: OUTPUT_LIMIT, attemptBudget: { reserve, settle } }))
      .rejects.toBeInstanceOf(JudgmentError);
    expect(reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
