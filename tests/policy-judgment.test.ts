import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import type { LLMResponse, ToolCall } from '../src/types.js';

const mockChat = vi.fn();
vi.mock('../src/providers/index.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  selectProvider: (p: string) => (p && p !== 'auto' ? p : 'anthropic'),
}));

import { evaluatePolicy, getPolicyJudgment, isPolicyEnabled } from '../src/policy.js';

const rules = {
  questions: {
    destructive: { type: 'noul', instructions: 'Would this irreversibly destroy data?' },
    scope: { type: 'choice', instructions: 'What does it operate on?', criteria: { workspace: 'the project', system: 'outside it' } },
  },
  deny: [
    { question: 'destructive', above: 0.6, reason: 'irreversible data loss' },
    { question: 'scope', is: 'system', minConfidence: 0.5, reason: 'operates outside the project' },
  ],
};

const call: ToolCall = { id: 'c1', name: 'shell', arguments: { command: 'rm -rf /' } };
const reply = (destructive: number, system: number): LLMResponse => ({
  content: JSON.stringify({ q1: { yes: destructive, no: 1 - destructive }, q2: { workspace: 1 - system, system } }),
  finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20 },
});

let dir: string, rulesPath: string;
beforeEach(() => {
  config.resetConfig(); mockChat.mockReset();
  dir = fs.mkdtempSync(join(os.tmpdir(), 'policy-judgment-'));
  rulesPath = join(dir, 'rules.json'); fs.writeFileSync(rulesPath, JSON.stringify(rules));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected networking'); }));
});
afterEach(() => { config.resetConfig(); fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('stays off until an operator configures it, and allows with source none', async () => {
  expect(getPolicyJudgment()).toBeUndefined();
  expect(isPolicyEnabled()).toBe(false);
  expect(await evaluatePolicy(call)).toMatchObject({ decision: 'allow', source: 'none' });
  expect(mockChat).not.toHaveBeenCalled();
});

it('enables the hook from config alone and judges the tool call in process', async () => {
  config.set('policy', { judgment: rulesPath, judgmentProvider: 'ollama', judgmentModel: 'qwen3.8:latest' });
  expect(isPolicyEnabled()).toBe(true);
  mockChat.mockResolvedValueOnce(reply(0.95, 0.9));
  const denied = await evaluatePolicy(call);
  expect(denied).toMatchObject({ decision: 'deny', source: 'policy', reason: 'irreversible data loss' });
  expect(denied.durationMs).toBeGreaterThanOrEqual(0);
  const [provider, messages, tools, model] = mockChat.mock.calls[0]! as [string, { content: string }[], unknown[], string];
  expect(provider).toBe('ollama');
  expect(model).toBe('qwen3.8:latest');
  expect(tools).toEqual([]);
  expect(messages[1]!.content).toContain('"command": "rm -rf /"');
});

it('allows a tool call no rule matches', async () => {
  config.set('policy', { judgment: rulesPath, judgmentProvider: 'ollama' });
  mockChat.mockResolvedValueOnce(reply(0.01, 0.02));
  expect(await evaluatePolicy(call)).toMatchObject({ decision: 'allow', source: 'policy' });
});

it('denies when both sources are configured rather than silently picking one', async () => {
  config.set('policy', { command: 'true', judgment: rulesPath });
  expect(await evaluatePolicy(call)).toMatchObject({ decision: 'deny', source: 'policy', reason: expect.stringContaining('both set') });
  expect(mockChat).not.toHaveBeenCalled();
});

it.each([
  ['unreadable rules', () => join(dir, 'missing.json'), () => { /* never called */ }],
  ['invalid rules', () => { const p = join(dir, 'bad.json'); fs.writeFileSync(p, '{"questions":{},"deny":[]}'); return p; }, () => { /* never called */ }],
])('denies on %s without calling a provider', async (_label, path) => {
  config.set('policy', { judgment: path(), judgmentProvider: 'ollama' });
  expect(await evaluatePolicy(call)).toMatchObject({ decision: 'deny', source: 'policy', reason: expect.stringContaining('could not decide') });
  expect(mockChat).not.toHaveBeenCalled();
});

it('denies on an unknown configured provider before spending anything', async () => {
  config.set('policy', { judgment: rulesPath, judgmentProvider: 'not-a-provider' });
  expect(await evaluatePolicy(call)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('Unknown judgment provider') });
  expect(mockChat).not.toHaveBeenCalled();
});

it('denies when the provider fails or the model returns unusable output', async () => {
  config.set('policy', { judgment: rulesPath, judgmentProvider: 'ollama' });
  mockChat.mockRejectedValueOnce(new Error('provider down'));
  expect(await evaluatePolicy(call)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('provider down') });
  mockChat.mockResolvedValueOnce({ content: 'not json', finishReason: 'stop' } as LLMResponse);
  expect(await evaluatePolicy(call)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('could not decide') });
});

it('fails closed when the judgment outruns the configured timeout', async () => {
  config.set('policy', { judgment: rulesPath, judgmentProvider: 'ollama', timeoutMs: 20 });
  mockChat.mockImplementationOnce((...args: unknown[]) => new Promise((_resolve, reject) => {
    const signal = (args[6] as { signal?: AbortSignal }).signal!;
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  expect(await evaluatePolicy(call)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('timed out after 20ms') });
});

it('reports cancellation rather than a timeout when the caller aborts', async () => {
  config.set('policy', { judgment: rulesPath, judgmentProvider: 'ollama' });
  const controller = new AbortController();
  mockChat.mockImplementationOnce((...args: unknown[]) => new Promise((_resolve, reject) => {
    const signal = (args[6] as { signal?: AbortSignal }).signal!;
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    controller.abort();
  }));
  expect(await evaluatePolicy(call, { signal: controller.signal })).toMatchObject({ decision: 'deny', reason: 'Policy evaluation cancelled' });
});

it('accepts an explicit rules override without touching config', async () => {
  mockChat.mockResolvedValueOnce(reply(0.01, 0.9));
  expect(isPolicyEnabled({ judgment: rulesPath })).toBe(true);
  expect(await evaluatePolicy(call, { judgment: rulesPath })).toMatchObject({ decision: 'deny', reason: 'operates outside the project' });
});

it('defaults the judgment source to a latency-matched timeout and honors an explicit one', async () => {
  vi.useFakeTimers();
  config.set('policy', { judgment: rulesPath, judgmentProvider: 'ollama' });
  // Like the real adapter: nothing resolves, and the abort signal ends it.
  const hang = (...args: unknown[]) => new Promise<never>((_resolve, reject) => {
    const signal = (args[6] as { signal?: AbortSignal }).signal!;
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  mockChat.mockImplementationOnce(hang);
  const pending = evaluatePolicy(call);
  await vi.advanceTimersByTimeAsync(6000);   // past the 5000ms spawn default
  await vi.advanceTimersByTimeAsync(24100);  // past 30000ms
  expect(await pending).toMatchObject({ decision: 'deny', reason: expect.stringContaining('timed out after 30000ms') });

  config.set('policy', { judgment: rulesPath, judgmentProvider: 'ollama', timeoutMs: 1000 });
  mockChat.mockImplementationOnce(hang);
  const strict = evaluatePolicy(call);
  await vi.advanceTimersByTimeAsync(1100);
  expect(await strict).toMatchObject({ decision: 'deny', reason: expect.stringContaining('timed out after 1000ms') });
});

it('sets, validates and clears the policy keys through /config set', async () => {
  const messages: { type: string; content: string }[] = [];
  const ctx = { addMessage: (type: string, content: string) => { messages.push({ type, content }); } } as unknown as import('../src/ui/commands.js').CommandContext;
  const { handleCommand } = await import('../src/ui/commands.js');
  const last = () => messages.at(-1)!;

  await handleCommand(`/config set policy.judgment ${rulesPath}`, ctx);
  expect(last()).toMatchObject({ type: 'system', content: '✓ policy.judgment set' });
  expect(getPolicyJudgment()).toBe(rulesPath);

  await handleCommand('/config set policy.judgmentProvider typesafe', ctx);
  await handleCommand('/config set policy.judgmentModel jev-1.13.0', ctx);
  expect(config.get('policy')).toMatchObject({ judgment: rulesPath, judgmentProvider: 'typesafe', judgmentModel: 'jev-1.13.0' });

  await handleCommand('/config set policy.judgmentProvider not-a-provider', ctx);
  expect(last()).toMatchObject({ type: 'error', content: expect.stringContaining('Unknown judgment provider') });
  expect(config.get('policy')).toMatchObject({ judgmentProvider: 'typesafe' });

  await handleCommand('/config set policy.judgment off', ctx);
  expect(last()).toMatchObject({ content: '✓ policy.judgment cleared' });
  expect(getPolicyJudgment()).toBeUndefined();
});
