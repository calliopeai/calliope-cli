/**
 * Judgment evaluation over two engines:
 *  - any chat backend: the model is prompted for a probability distribution per
 *    question and the answer types are derived here (prompted engine);
 *  - `typesafe`: the native TypeSafe endpoint, whose System One models return
 *    calibrated distributions directly.
 * Both return the same JudgmentResponse contract.
 */
import * as config from '../config.js';
import { chat, selectProvider, type ChatOptions } from '../providers/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { DEFAULT_MODELS, type LLMProvider, type Message } from '../types.js';
import { JudgmentError, type Answer, type JudgmentEngine, type JudgmentRequest, type JudgmentResponse, type Question, type ScoreQuestion } from './types.js';

/**
 * The prompted engine's `chat()` call admits the same bounded-execution
 * controls any other in-runtime caller uses: a reviewed output limit and,
 * when the caller supplies one, an `attemptBudget` that reserves and settles
 * the request against its ledger. Neither has an effect on the native
 * TypeSafe engine, which never calls `chat()`; `evaluate()` rejects them for
 * `provider: 'typesafe'` rather than silently admitting an unaccounted call.
 */
export interface EvaluateOptions extends Pick<ChatOptions, 'maxOutputTokens' | 'bounded' | 'attemptBudget'> {
  provider?: JudgmentEngine;
  model?: string;
  signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';
const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';
const MAX_QUESTIONS = 64;
const MAX_OPTIONS = 32;
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// ---------------------------------------------------------------------------
// Validation

function invalid(message: string): never { throw new JudgmentError('invalid-request', message); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateInstructions(id: string, value: unknown): void {
  if (typeof value === 'string') { if (!value.trim()) invalid(`Question "${id}" has empty instructions.`); return; }
  if (isRecord(value) || Array.isArray(value)) return;
  invalid(`Question "${id}" needs string, object or array instructions.`);
}

function validateQuestion(id: string, value: unknown): Question {
  if (!isRecord(value)) invalid(`Question "${id}" must be an object.`);
  validateInstructions(id, value.instructions);
  switch (value.type) {
    case 'noul': {
      const criteria = value.criteria;
      if (criteria !== undefined) {
        if (!isRecord(criteria)) invalid(`Question "${id}": noul criteria must be an object with optional "true"/"false" strings.`);
        for (const key of Object.keys(criteria)) {
          if (key !== 'true' && key !== 'false') invalid(`Question "${id}": noul criteria only accept "true" and "false" keys.`);
          if (typeof criteria[key] !== 'string') invalid(`Question "${id}": noul criteria "${key}" must be a string.`);
        }
      }
      return value as unknown as Question;
    }
    case 'choice': {
      const criteria = value.criteria;
      if (!isRecord(criteria)) invalid(`Question "${id}": choice criteria must map each option to a description or null.`);
      const options = Object.keys(criteria);
      if (options.length < 2) invalid(`Question "${id}": choice needs at least two options.`);
      if (options.length > MAX_OPTIONS) invalid(`Question "${id}": choice allows at most ${MAX_OPTIONS} options.`);
      for (const option of options) {
        if (!option.trim()) invalid(`Question "${id}": choice options must be non-empty strings.`);
        const description = criteria[option];
        if (description !== null && typeof description !== 'string') invalid(`Question "${id}": option "${option}" must describe with a string or null.`);
      }
      return value as unknown as Question;
    }
    case 'score': {
      const criteria = value.criteria;
      if (!Array.isArray(criteria) || criteria.length < 2) invalid(`Question "${id}": score criteria must be an ordered array of at least two level descriptions.`);
      if (criteria.length > MAX_OPTIONS) invalid(`Question "${id}": score allows at most ${MAX_OPTIONS} levels.`);
      for (const level of criteria) if (typeof level !== 'string' || !level.trim()) invalid(`Question "${id}": every score level must be a non-empty string.`);
      return value as unknown as Question;
    }
    default:
      invalid(`Question "${id}" has unknown type ${JSON.stringify(value.type)}; expected noul, choice or score.`);
  }
}

/** Reject malformed input before any network call; returns a typed copy. */
export function validateRequest(input: unknown): JudgmentRequest {
  if (!isRecord(input)) invalid('Request must be an object with "state" and "questions".');
  if (input.state === undefined || input.state === null) invalid('Request "state" is required.');
  if (typeof input.state === 'string' && !input.state.trim()) invalid('Request "state" must not be empty.');
  if (!isRecord(input.questions)) invalid('Request "questions" must be a map of question id to question.');
  const ids = Object.keys(input.questions);
  if (!ids.length) invalid('Request needs at least one question.');
  if (ids.length > MAX_QUESTIONS) invalid(`Request allows at most ${MAX_QUESTIONS} questions.`);
  const questions: Record<string, Question> = {};
  for (const id of ids) {
    if (!ID_PATTERN.test(id)) invalid(`Question id ${JSON.stringify(id)} must match ${ID_PATTERN}.`);
    questions[id] = validateQuestion(id, input.questions[id]);
  }
  return { state: input.state, questions };
}

// ---------------------------------------------------------------------------
// Prompted engine

/** The keys the model must assign probability to, in order. */
function outcomeKeys(question: Question): string[] {
  if (question.type === 'noul') return ['yes', 'no'];
  if (question.type === 'choice') return Object.keys(question.criteria);
  return question.criteria.map((_, index) => String(index));
}

/** Question ids are replaced by positional ids so they never reach the model. */
function positionalQuestions(questions: Record<string, Question>): { ids: string[]; prompt: Record<string, unknown> } {
  const ids = Object.keys(questions), prompt: Record<string, unknown> = {};
  ids.forEach((id, index) => {
    const question = questions[id]!;
    const entry: Record<string, unknown> = { type: question.type, instructions: question.instructions };
    if (question.type === 'noul') {
      entry.outcomes = { yes: question.criteria?.true ?? 'The answer is yes', no: question.criteria?.false ?? 'The answer is no' };
    } else if (question.type === 'choice') {
      entry.outcomes = Object.fromEntries(Object.entries(question.criteria).map(([option, description]) => [option, description ?? option]));
    } else {
      entry.outcomes = Object.fromEntries(question.criteria.map((level, i) => [String(i), level]));
      entry.note = 'Outcomes are ordered levels from lowest to highest.';
    }
    prompt[`q${index + 1}`] = entry;
  });
  return { ids, prompt };
}

const SYSTEM_PROMPT = `You are a calibrated judgment engine. You do not converse, explain or reason aloud.
You receive STATE (text or JSON) and QUESTIONS. For each question, assign a probability to every listed outcome key, reflecting how likely that outcome is the correct judgment given only the STATE. Probabilities for one question must sum to 1. Use the full range: near-certain judgments get near 0 or 1, genuinely ambiguous ones spread probability.
Reply with exactly one JSON object and nothing else: {"q1": {"<outcome>": <probability>, ...}, "q2": {...}}. Include every question id and every outcome key. No prose, no code fences.`;

export function buildMessages(request: JudgmentRequest): { messages: Message[]; ids: string[] } {
  const { ids, prompt } = positionalQuestions(request.questions);
  const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state, null, 2);
  const user = `STATE:\n${state}\n\nQUESTIONS:\n${JSON.stringify(prompt, null, 2)}`;
  return { messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], ids };
}

/** Grammar schema for backends that constrain output (Ollama `format`); others ignore it. */
export function buildOutputSchema(request: JudgmentRequest): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  Object.values(request.questions).forEach((question, index) => {
    const keys = outcomeKeys(question);
    properties[`q${index + 1}`] = {
      type: 'object',
      properties: Object.fromEntries(keys.map(key => [key, { type: 'number' }])),
      required: keys,
      additionalProperties: false,
    };
  });
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/** Accept a bare object, or one wrapped in fences/prose; reject anything else. */
export function parseModelOutput(text: string): Record<string, unknown> {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new JudgmentError('model-output', 'The model returned no JSON object.');
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch { throw new JudgmentError('model-output', 'The model returned malformed JSON.'); }
  if (!isRecord(parsed)) throw new JudgmentError('model-output', 'The model returned JSON that is not an object.');
  return parsed;
}

/** Clamp, fill missing outcomes with 0 and renormalize; all-zero is a model failure. */
export function normalizeDistribution(id: string, keys: string[], raw: unknown): Record<string, number> {
  if (!isRecord(raw)) throw new JudgmentError('model-output', `No distribution returned for question "${id}".`);
  const values = keys.map(key => {
    const value = raw[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new JudgmentError('model-output', `Question "${id}" received no usable probabilities.`);
  return Object.fromEntries(keys.map((key, index) => [key, values[index]! / total]));
}

/**
 * How far the leading outcome sits above chance: (max - 1/n) / (1 - 1/n).
 * 1 when one outcome holds all mass, 0 when the distribution is uniform. This
 * tracks the confidence TypeSafe reports for the same distributions closely,
 * though their exact statistic is unpublished.
 */
export function confidenceOf(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities), n = values.length;
  if (n < 2) return 1;
  const chance = 1 / n;
  return round(Math.max(0, Math.min(1, (Math.max(...values) - chance) / (1 - chance))));
}

function round(value: number): number { return Math.round(value * 1e4) / 1e4; }

function roundAll(probabilities: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [key, round(value)]));
}

/** Derive the typed answer from a normalized distribution. */
export function toAnswer(question: Question, probabilities: Record<string, number>): Answer {
  if (question.type === 'noul') return { type: 'noul', noul: round(probabilities.yes ?? 0) };
  const confidence = confidenceOf(probabilities);
  if (question.type === 'choice') {
    const choice = Object.entries(probabilities).reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
    return { type: 'choice', choice, probabilities: roundAll(probabilities), confidence };
  }
  const score = Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
  const legend = Object.fromEntries(question.criteria.map((level, index) => [String(index), level]));
  return { type: 'score', score: round(score), legend, probabilities: roundAll(probabilities), confidence };
}

async function evaluatePrompted(request: JudgmentRequest, provider: LLMProvider, model: string | undefined, options: EvaluateOptions): Promise<JudgmentResponse> {
  const { messages, ids } = buildMessages(request);
  // Mirror chat()'s own resolution so the response names the backend that answered.
  const actualProvider = selectProvider(provider), actualModel = model || DEFAULT_MODELS[actualProvider];
  const chatOptions: ChatOptions = {
    signal: options.signal,
    format: buildOutputSchema(request),
    selectionMode: provider === 'auto' ? 'auto' : 'explicit',
    maxOutputTokens: options.maxOutputTokens,
    bounded: options.bounded,
    attemptBudget: options.attemptBudget,
  };
  const response = await chat(provider, messages, [], model, undefined, undefined, chatOptions);
  if (response.finishReason === 'error' || response.errorCode === 'refusal') throw new JudgmentError('model-output', 'The model did not complete the judgment request.');
  const parsed = parseModelOutput(response.content);
  const answers: Record<string, Answer> = {};
  ids.forEach((id, index) => {
    const question = request.questions[id]!;
    answers[id] = toAnswer(question, normalizeDistribution(id, outcomeKeys(question), parsed[`q${index + 1}`]));
  });
  return {
    provider: actualProvider,
    model: actualModel,
    answers,
    usage: { input_tokens: response.usage?.inputTokens ?? 0, output_tokens: response.usage?.outputTokens ?? 0 },
  };
}

// ---------------------------------------------------------------------------
// Native TypeSafe engine

export function typesafeCredentials(): { apiKey?: string; baseUrl: string } {
  const stored = config.getProviderCred('typesafe');
  return {
    apiKey: process.env.TYPESAFE_API_KEY || stored.apiKey,
    baseUrl: (process.env.TYPESAFE_BASE_URL || stored.baseUrl || TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

function expectNumber(id: string, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new JudgmentError('model-output', `TypeSafe answer "${id}" is missing numeric "${field}".`);
  return value;
}

function expectDistribution(id: string, value: unknown): Record<string, number> {
  if (!isRecord(value)) throw new JudgmentError('model-output', `TypeSafe answer "${id}" is missing "probabilities".`);
  return Object.fromEntries(Object.entries(value).map(([key, p]) => [key, expectNumber(id, p, `probabilities.${key}`)]));
}

/** Keep the native answer, validating shape against the question that asked for it. */
function nativeAnswer(id: string, question: Question, raw: unknown): Answer {
  if (!isRecord(raw) || raw.type !== question.type) throw new JudgmentError('model-output', `TypeSafe answer "${id}" does not match its ${question.type} question.`);
  if (question.type === 'noul') return { type: 'noul', noul: expectNumber(id, raw.noul, 'noul') };
  if (question.type === 'choice') {
    if (typeof raw.choice !== 'string' || !(raw.choice in question.criteria)) throw new JudgmentError('model-output', `TypeSafe answer "${id}" chose an option outside the criteria.`);
    return { type: 'choice', choice: raw.choice, probabilities: expectDistribution(id, raw.probabilities), confidence: expectNumber(id, raw.confidence, 'confidence') };
  }
  const legend = isRecord(raw.legend) ? Object.fromEntries(Object.entries(raw.legend).map(([k, v]) => [k, String(v)])) : Object.fromEntries((question as ScoreQuestion).criteria.map((level, i) => [String(i), level]));
  return { type: 'score', score: expectNumber(id, raw.score, 'score'), legend, probabilities: expectDistribution(id, raw.probabilities), confidence: expectNumber(id, raw.confidence, 'confidence') };
}

const TYPESAFE_MAX_ATTEMPTS = 4;
const TYPESAFE_MAX_DELAY_MS = 30000;

/** Honor `retry-after` when present, else exponential backoff from 1s. */
function retryDelayMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get('retry-after'));
  const delay = Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** (attempt - 1);
  return Math.min(delay, TYPESAFE_MAX_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Cancelled')); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function evaluateTypesafe(request: JudgmentRequest, model: string, options: EvaluateOptions): Promise<JudgmentResponse> {
  const { apiKey, baseUrl } = typesafeCredentials();
  if (!apiKey) throw new JudgmentError('unavailable', 'TypeSafe needs TYPESAFE_API_KEY (or a stored typesafe credential).');
  const doFetch = options.fetch ?? fetch;
  const payload = JSON.stringify({ state: request.state, model, questions: request.questions });
  let response: Response;
  // Rate limits (429) and overload (529) are documented as retry-with-backoff.
  for (let attempt = 1; ; attempt++) {
    throwIfCancelled(options.signal);
    try {
      response = await doFetch(`${baseUrl}/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: payload,
        signal: options.signal,
      });
    } catch (error) {
      throwIfCancelled(options.signal);
      throw new JudgmentError('unavailable', `TypeSafe request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if ((response.status !== 429 && response.status !== 529) || attempt >= TYPESAFE_MAX_ATTEMPTS) break;
    await sleep(retryDelayMs(response, attempt), options.signal);
  }
  if (!response.ok) {
    const code = response.status === 422 ? 'invalid-request' : 'unavailable';
    let detail = '';
    try { detail = (await response.text()).slice(0, 300); } catch { /* body is optional */ }
    throw new JudgmentError(code, `TypeSafe returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new JudgmentError('model-output', 'TypeSafe returned a non-JSON body.'); }
  if (!isRecord(body) || !isRecord(body.answers)) throw new JudgmentError('model-output', 'TypeSafe response is missing "answers".');
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(request.questions)) answers[id] = nativeAnswer(id, question, body.answers[id]);
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    provider: 'typesafe',
    model: typeof body.model === 'string' ? body.model : model,
    answers,
    usage: { input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0, output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0 },
  };
}

// ---------------------------------------------------------------------------

/** Evaluate every question in one request; answers come back under the caller's ids. */
export async function evaluate(input: unknown, options: EvaluateOptions = {}): Promise<JudgmentResponse> {
  const request = validateRequest(input);
  throwIfCancelled(options.signal);
  const provider = options.provider ?? 'auto';
  if (provider === 'typesafe') {
    if (options.attemptBudget || options.bounded || options.maxOutputTokens !== undefined)
      invalid('Bounded execution controls (maxOutputTokens, bounded, attemptBudget) have no effect on the typesafe engine, which never calls chat().');
    return evaluateTypesafe(request, options.model ?? TYPESAFE_DEFAULT_MODEL, options);
  }
  return evaluatePrompted(request, provider, options.model, options);
}
