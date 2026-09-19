import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import type { LLMResponse } from '../src/types.js';

const mockChat = vi.fn();
vi.mock('../src/providers/index.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  selectProvider: (p: string) => (p && p !== 'auto' ? p : 'anthropic'),
}));

import { decidePolicy, runJudgePolicy, validatePolicyRules, type PolicyRules } from '../src/judgment/policy.js';
import { runJudge } from '../src/judgment/cli.js';
import type { Answer } from '../src/judgment/types.js';

const rules: PolicyRules = {
  questions: {
    destructive: { type: 'noul', instructions: 'Would this permanently destroy data outside a build directory?' },
    scope: { type: 'choice', instructions: 'Where does this write?', criteria: { workspace: 'Inside the project', system: 'Outside the project', none: 'It does not write' } },
    blast: { type: 'score', instructions: 'How wide is the blast radius?', criteria: ['One file', 'One directory', 'The whole machine'] },
  },
  deny: [
    { question: 'destructive', above: 0.7, reason: 'destructive command' },
    { question: 'scope', is: 'system', minConfidence: 0.6, reason: 'writes outside the workspace' },
    { question: 'blast', atLeast: 1.5, reason: 'blast radius too wide' },
  ],
};

const toolCall = { id: 'call_1', name: 'shell', arguments: { command: 'rm -rf /' } };

/** The model's distribution per question, in the order the questions are declared. */
function reply(...distributions: Record<string, number>[]): LLMResponse {
  const content = JSON.stringify(Object.fromEntries(distributions.map((d, i) => [`q${i + 1}`, d])));
  return { content, finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 30 } };
}
const safe = () => reply({ yes: 0.02, no: 0.98 }, { workspace: 0.9, system: 0.05, none: 0.05 }, { '0': 0.9, '1': 0.08, '2': 0.02 });

let dir: string;
const out: string[] = [];
const err: string[] = [];
const write = (t: string) => { out.push(t); };
const writeErr = (t: string) => { err.push(t); };

beforeEach(() => {
  config.resetConfig(); mockChat.mockReset(); out.length = 0; err.length = 0;
  dir = fs.mkdtempSync(join(os.tmpdir(), 'judge-policy-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected networking'); }));
});
afterEach(() => { config.resetConfig(); fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function rulesFile(value: unknown = rules): string {
  const path = join(dir, 'rules.json'); fs.writeFileSync(path, JSON.stringify(value)); return path;
}

describe('validatePolicyRules', () => {
  it('accepts one operator per primitive and keeps the declared questions', () => {
    expect(validatePolicyRules(rules)).toEqual(rules);
  });

  it.each([
    [{ questions: rules.questions }, /non-empty "deny"/],
    [{ questions: rules.questions, deny: [] }, /non-empty "deny"/],
    [{ deny: rules.deny }, /"questions" map/],
    [{ questions: rules.questions, deny: [{ question: 'nope', above: 0.5, reason: 'x' }] }, /unknown question/],
    [{ questions: rules.questions, deny: [{ question: 'destructive', above: 0.5 }] }, /needs a reason/],
    [{ questions: rules.questions, deny: [{ question: 'destructive', reason: 'x' }] }, /exactly one of above, is or atLeast/],
    [{ questions: rules.questions, deny: [{ question: 'destructive', above: 0.5, is: 'system', reason: 'x' }] }, /exactly one of above, is or atLeast/],
    [{ questions: rules.questions, deny: [{ question: 'destructive', is: 'system', reason: 'x' }] }, /"is" applies to a choice/],
    [{ questions: rules.questions, deny: [{ question: 'scope', above: 0.5, reason: 'x' }] }, /"above" applies to a noul/],
    [{ questions: rules.questions, deny: [{ question: 'blast', is: 'x', reason: 'x' }] }, /"is" applies to a choice/],
    [{ questions: rules.questions, deny: [{ question: 'scope', is: 'legal', reason: 'x' }] }, /must name one of its options/],
    [{ questions: rules.questions, deny: [{ question: 'destructive', above: 2, reason: 'x' }] }, /between 0 and 1/],
    [{ questions: rules.questions, deny: [{ question: 'blast', atLeast: 9, reason: 'x' }] }, /between 0 and 2/],
    [{ questions: rules.questions, deny: [{ question: 'destructive', above: 0.5, minConfidence: 0.5, reason: 'x' }] }, /carries no confidence/],
  ])('rejects malformed rules %#', (input, pattern) => {
    expect(() => validatePolicyRules(input)).toThrowError(expect.objectContaining({ code: 'invalid-request', message: expect.stringMatching(pattern) }));
  });
});

describe('decidePolicy', () => {
  const answers = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
    destructive: { type: 'noul', noul: 0.1 },
    scope: { type: 'choice', choice: 'workspace', probabilities: { workspace: 0.9, system: 0.05, none: 0.05 }, confidence: 0.85 },
    blast: { type: 'score', score: 0.2, legend: { '0': 'One file', '1': 'One directory', '2': 'The whole machine' }, probabilities: { '0': 0.8, '1': 0.2, '2': 0 }, confidence: 0.7 },
    ...over,
  });

  it('allows when no rule matches', () => {
    expect(decidePolicy(rules, answers())).toEqual({ decision: 'allow' });
  });

  it('denies on a noul above its threshold, and not at the threshold', () => {
    expect(decidePolicy(rules, answers({ destructive: { type: 'noul', noul: 0.71 } }))).toMatchObject({ decision: 'deny', reason: 'destructive command' });
    expect(decidePolicy(rules, answers({ destructive: { type: 'noul', noul: 0.7 } }))).toEqual({ decision: 'allow' });
  });

  it('denies on a selected choice only above minConfidence', () => {
    const system = (confidence: number): Answer => ({ type: 'choice', choice: 'system', probabilities: { workspace: 0.2, system: 0.7, none: 0.1 }, confidence });
    expect(decidePolicy(rules, answers({ scope: system(0.6) }))).toMatchObject({ decision: 'deny', reason: 'writes outside the workspace' });
    expect(decidePolicy(rules, answers({ scope: system(0.59) }))).toEqual({ decision: 'allow' });
  });

  it('denies on a score at or above its level', () => {
    const blast = (score: number): Answer => ({ type: 'score', score, legend: { '0': 'a', '1': 'b', '2': 'c' }, probabilities: { '0': 0, '1': 0.5, '2': 0.5 }, confidence: 0.8 });
    expect(decidePolicy(rules, answers({ blast: blast(1.5) }))).toMatchObject({ decision: 'deny', reason: 'blast radius too wide' });
    expect(decidePolicy(rules, answers({ blast: blast(1.49) }))).toEqual({ decision: 'allow' });
  });

  it('reports the first matching rule when several match', () => {
    expect(decidePolicy(rules, answers({
      destructive: { type: 'noul', noul: 0.99 },
      scope: { type: 'choice', choice: 'system', probabilities: { workspace: 0, system: 1, none: 0 }, confidence: 1 },
    }))).toMatchObject({ reason: 'destructive command' });
  });

  it('treats a missing answer as a failure rather than an allow', () => {
    const { destructive: _omitted, ...missing } = answers();
    expect(() => decidePolicy(rules, missing)).toThrowError(expect.objectContaining({ code: 'model-output' }));
  });
});

describe('calliope judge --policy', () => {
  it('exits 0 and writes nothing to stderr when the tool call is allowed', async () => {
    mockChat.mockResolvedValueOnce(safe());
    expect(await runJudgePolicy(rulesFile(), { provider: 'ollama', stdin: () => JSON.stringify(toolCall), write, writeErr })).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual([]);
  });

  it('sends the tool call as structured state and exits 1 with the reason on stderr', async () => {
    mockChat.mockResolvedValueOnce(reply({ yes: 0.95, no: 0.05 }, { workspace: 0.1, system: 0.8, none: 0.1 }, { '0': 0, '1': 0.1, '2': 0.9 }));
    expect(await runJudgePolicy(rulesFile(), { provider: 'ollama', stdin: () => JSON.stringify(toolCall), write, writeErr })).toBe(1);
    expect(err).toEqual(['destructive command\n']);
    const prompt = String(mockChat.mock.calls[0]![1][1].content);
    expect(prompt).toContain('"command": "rm -rf /"');
    expect(prompt).toContain('"name": "shell"');
  });

  it('prints the full verdict to stdout with --json for rule authoring', async () => {
    mockChat.mockResolvedValueOnce(safe());
    expect(await runJudgePolicy(rulesFile(), { provider: 'ollama', json: true, stdin: () => JSON.stringify(toolCall), write, writeErr })).toBe(0);
    const doc = JSON.parse(out[0]!);
    expect(doc).toMatchObject({ version: 1, type: 'judgment-policy', decision: 'allow', provider: 'ollama' });
    expect(doc.answers.destructive).toEqual({ type: 'noul', noul: 0.02 });
  });

  it.each([
    ['unreadable rules', () => join(dir, 'missing.json'), () => JSON.stringify(toolCall)],
    ['malformed rules', () => rulesFile({ questions: {}, deny: [] }), () => JSON.stringify(toolCall)],
    ['a non-JSON tool call', () => rulesFile(), () => 'not json'],
    ['a non-object tool call', () => rulesFile(), () => '"a string"'],
  ])('exits 2 and denies on %s without calling a provider', async (_label, path, input) => {
    expect(await runJudgePolicy(path(), { provider: 'ollama', stdin: input, write, writeErr })).toBe(2);
    expect(err[0]).toContain('policy engine could not decide');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('exits 2 when the provider fails or the model returns unusable output', async () => {
    mockChat.mockRejectedValueOnce(new Error('provider down'));
    expect(await runJudgePolicy(rulesFile(), { provider: 'ollama', stdin: () => JSON.stringify(toolCall), write, writeErr })).toBe(2);
    expect(err[0]).toContain('provider down');
    mockChat.mockResolvedValueOnce({ content: 'no json here', finishReason: 'stop' } as LLMResponse);
    expect(await runJudgePolicy(rulesFile(), { provider: 'ollama', stdin: () => JSON.stringify(toolCall), write, writeErr })).toBe(2);
    expect(err[1]).toContain('policy engine could not decide');
  });

  it('routes --policy through the judge command and rejects mixing it with other input flags', async () => {
    mockChat.mockResolvedValueOnce(safe());
    expect(await runJudge(['--policy', rulesFile(), '--provider', 'ollama'], { cwd: dir, stdin: () => JSON.stringify(toolCall), write, writeErr })).toBe(0);
    expect(await runJudge(['--policy', rulesFile(), '--request', 'x'], { cwd: dir, write, writeErr })).toBe(2);
    expect(out.at(-1)).toContain('--policy takes the pending tool call on stdin');
  });
});
