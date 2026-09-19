/**
 * Judgment-backed policy engine for the pre-tool hook (see docs/governance.md).
 * Reads a pending tool call on stdin, judges it against reviewed questions, and
 * exits 0 to allow or non-zero to deny. Every failure denies: a policy engine
 * that cannot decide must never wave a tool through.
 */
import * as fs from 'node:fs';
import * as config from '../config.js';
import { evaluate } from './evaluate.js';
import { JudgmentError, type Answer, type JudgmentEngine, type JudgmentResponse, type Question } from './types.js';

/** Exactly one operator per rule, matching its question's primitive. */
export interface DenyRule {
  question: string;
  reason: string;
  /** noul: deny when the probability of yes exceeds this. */
  above?: number;
  /** choice: deny when this option is selected. */
  is?: string;
  /** score: deny when the weighted level reaches this. */
  atLeast?: number;
  /** choice/score: ignore the match below this confidence. */
  minConfidence?: number;
}

export interface PolicyRules {
  questions: Record<string, Question>;
  deny: DenyRule[];
}

export interface PolicyVerdict {
  decision: 'allow' | 'deny';
  reason?: string;
  rule?: DenyRule;
}

function invalid(message: string): never { throw new JudgmentError('invalid-request', message); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function probability(id: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid(`Rule for "${id}": "${field}" must be a number between 0 and 1.`);
  return value;
}

/**
 * Validate rules against their own questions, so a typo or a mismatched
 * operator fails when the policy is written rather than when a tool is judged.
 */
export function validatePolicyRules(input: unknown): PolicyRules {
  if (!isRecord(input)) invalid('Policy rules must be an object with "questions" and "deny".');
  if (!isRecord(input.questions)) invalid('Policy rules need a "questions" map.');
  if (!Array.isArray(input.deny) || input.deny.length === 0) invalid('Policy rules need a non-empty "deny" array.');
  const questions = input.questions as Record<string, Question>;
  const deny = input.deny.map((value, index) => {
    if (!isRecord(value)) invalid(`Deny rule ${index} must be an object.`);
    const id = value.question;
    if (typeof id !== 'string' || !Object.hasOwn(questions, id)) invalid(`Deny rule ${index} names unknown question ${JSON.stringify(id)}.`);
    if (typeof value.reason !== 'string' || !value.reason.trim()) invalid(`Deny rule for "${id}" needs a reason.`);
    const question = questions[id]!;
    const operators = (['above', 'is', 'atLeast'] as const).filter(name => value[name] !== undefined);
    if (operators.length !== 1) invalid(`Deny rule for "${id}" needs exactly one of above, is or atLeast.`);
    const rule: DenyRule = { question: id, reason: value.reason };
    if (value.minConfidence !== undefined) {
      if (question.type === 'noul') invalid(`Deny rule for "${id}": a noul answer carries no confidence.`);
      rule.minConfidence = probability(id, 'minConfidence', value.minConfidence);
    }
    switch (operators[0]) {
      case 'above':
        if (question.type !== 'noul') invalid(`Deny rule for "${id}": "above" applies to a noul question.`);
        rule.above = probability(id, 'above', value.above);
        break;
      case 'is': {
        if (question.type !== 'choice') invalid(`Deny rule for "${id}": "is" applies to a choice question.`);
        if (typeof value.is !== 'string' || !Object.hasOwn(question.criteria, value.is)) invalid(`Deny rule for "${id}": "is" must name one of its options.`);
        rule.is = value.is;
        break;
      }
      default: {
        if (question.type !== 'score') invalid(`Deny rule for "${id}": "atLeast" applies to a score question.`);
        const levels = question.criteria.length - 1;
        if (typeof value.atLeast !== 'number' || !Number.isFinite(value.atLeast) || value.atLeast < 0 || value.atLeast > levels) invalid(`Deny rule for "${id}": "atLeast" must be between 0 and ${levels}.`);
        rule.atLeast = value.atLeast;
        break;
      }
    }
    return rule;
  });
  return { questions, deny };
}

/** Deny wins, and the first matching rule supplies the reason. */
export function decidePolicy(rules: PolicyRules, answers: Record<string, Answer>): PolicyVerdict {
  for (const rule of rules.deny) {
    const answer = answers[rule.question];
    if (!answer) throw new JudgmentError('model-output', `No answer returned for question "${rule.question}".`);
    if (rule.minConfidence !== undefined && 'confidence' in answer && answer.confidence < rule.minConfidence) continue;
    const matched = answer.type === 'noul' ? rule.above !== undefined && answer.noul > rule.above
      : answer.type === 'choice' ? answer.choice === rule.is
      : rule.atLeast !== undefined && answer.score >= rule.atLeast;
    if (matched) return { decision: 'deny', reason: rule.reason, rule };
  }
  return { decision: 'allow' };
}

/** A configured engine name is operator input, so it is checked like any other. */
export function validateJudgmentEngine(value: unknown): JudgmentEngine {
  if (value === 'typesafe') return 'typesafe';
  if (typeof value !== 'string' || (value !== 'auto' && !config.getProviderNames().includes(value as never)))
    invalid(`Unknown judgment provider ${JSON.stringify(value)}.`);
  return value as JudgmentEngine;
}

export interface JudgeToolCallOptions {
  rulesPath: string;
  provider?: JudgmentEngine;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Judge one pending tool call against a rules file. Shared by the CLI engine
 * and the built-in `policy.judgment` setting so both decide identically.
 */
export async function judgeToolCall(toolCall: unknown, options: JudgeToolCallOptions): Promise<{ verdict: PolicyVerdict; response: JudgmentResponse }> {
  const rules = validatePolicyRules(JSON.parse(fs.readFileSync(options.rulesPath, 'utf8')));
  if (!isRecord(toolCall)) invalid('The pending tool call must be a JSON object.');
  const response = await evaluate({ state: toolCall, questions: rules.questions }, { provider: options.provider, model: options.model, signal: options.signal });
  return { verdict: decidePolicy(rules, response.answers), response };
}

export interface PolicyRunOptions {
  provider?: JudgmentEngine;
  model?: string;
  signal?: AbortSignal;
  json?: boolean;
  stdin?: () => string;
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
}

/**
 * Exit 0 allows, 1 denies by rule, 2 denies because the engine could not decide.
 * The hook treats every non-zero exit as a denial and reads stderr as the reason.
 */
export async function runJudgePolicy(rulesPath: string, options: PolicyRunOptions = {}): Promise<number> {
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  const writeErr = options.writeErr ?? ((text: string) => { process.stderr.write(text); });
  const stdin = options.stdin ?? (() => fs.readFileSync(0, 'utf8'));
  try {
    let toolCall: unknown;
    try { toolCall = JSON.parse(stdin()); }
    catch { invalid('The pending tool call on stdin is not valid JSON.'); }
    const { verdict, response } = await judgeToolCall(toolCall, { rulesPath, ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    if (options.json) write(JSON.stringify({ version: 1, type: 'judgment-policy', ...verdict, provider: response.provider, model: response.model, answers: response.answers, usage: response.usage }) + '\n');
    if (verdict.decision === 'allow') return 0;
    writeErr(`${verdict.reason}\n`);
    return 1;
  } catch (error) {
    const message = error instanceof JudgmentError || error instanceof Error ? error.message : String(error);
    writeErr(`policy engine could not decide: ${message}\n`);
    return 2;
  }
}
