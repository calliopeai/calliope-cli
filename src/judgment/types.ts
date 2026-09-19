/**
 * Typed judgments: small, composable units of semantic judgment that code can
 * threshold, weight and combine. One request evaluates a `state` against a map
 * of typed questions and returns one probabilistic answer per question.
 */
import type { LLMProvider } from '../types.js';

/** Any chat backend (prompted judgments) or the native TypeSafe endpoint. */
export type JudgmentEngine = LLMProvider | 'typesafe';

/** Free text, or structured guidance (definitions, contrasts, examples). */
export type Instructions = string | Record<string, unknown> | unknown[];

/** A yes/no judgment. The answer is the probability of yes. */
export interface NoulQuestion {
  type: 'noul';
  instructions: Instructions;
  criteria?: { true?: string; false?: string };
}

/** One option from a defined set. `null` means the option needs no rubric. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: Instructions;
  criteria: Record<string, string | null>;
}

/** A position along ordered levels; the answer can land between levels. */
export interface ScoreQuestion {
  type: 'score';
  instructions: Instructions;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface JudgmentRequest {
  /** Text or structured data to judge. */
  state: unknown;
  /** Keys are for the caller's code; they are never sent to the model. */
  questions: Record<string, Question>;
}

export interface NoulAnswer { type: 'noul'; noul: number }
export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  /** How far the leading outcome sits above chance: 1 is peaked, 0 is uniform. */
  confidence: number;
}
export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted level index; between levels is a valid result. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface JudgmentResponse {
  provider: JudgmentEngine;
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

export type JudgmentErrorCode = 'invalid-request' | 'model-output' | 'unavailable';

export class JudgmentError extends Error {
  constructor(readonly code: JudgmentErrorCode, message: string) {
    super(message);
    this.name = 'JudgmentError';
  }
}
