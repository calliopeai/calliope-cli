/** `calliope judge`: typed judgments from the terminal, for scripts and CI. */
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import { parseModelFlags } from '../preferences/flags.js';
import { resolvePreferences } from '../preferences/resolve.js';
import { evaluate } from './evaluate.js';
import { JudgmentError, type Answer, type JudgmentEngine, type JudgmentResponse } from './types.js';

export const JUDGE_USAGE = `calliope judge --request <file|-> [--provider <name>|typesafe] [--model <id>] [--json]
calliope judge --questions <file> (--state <text> | --state-file <file|->) [--provider <name>] [--model <id>] [--json]`;

export interface JudgeCommandOptions {
  signal?: AbortSignal;
  stdin?: () => string;
  write?: (text: string) => void;
  cwd?: string;
}

interface JudgeFailure { error: 'invalid-arguments' | 'invalid-request' | 'model-output' | 'unavailable' | 'cancelled'; message: string }

/** Remove `--provider typesafe` / `--provider=typesafe` before chat-provider parsing. */
function stripTypesafeFlag(args: string[]): { typesafe: boolean; args: string[] } {
  const kept: string[] = [];
  let typesafe = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') { kept.push(...args.slice(index)); break; }
    if (arg === '--provider=typesafe' || (arg === '--provider' && args[index + 1] === 'typesafe')) {
      if (typesafe) throw new Error('Duplicate --provider option');
      typesafe = true;
      if (arg === '--provider') index++;
      continue;
    }
    kept.push(arg);
  }
  return { typesafe, args: kept };
}

function readSource(path: string, stdin: () => string): string {
  return path === '-' ? stdin() : fs.readFileSync(path, 'utf8');
}

function parseJson(label: string, text: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new JudgmentError('invalid-request', `${label} is not valid JSON.`); }
}

/** Build the request from flags; the state may be raw text or a JSON document. */
export function loadRequest(values: { request?: string; questions?: string; state?: string; 'state-file'?: string }, stdin: () => string): unknown {
  const sources = [values.request, values.questions].filter(Boolean).length;
  if (sources !== 1) throw new JudgmentError('invalid-request', 'Pass exactly one of --request or --questions.');
  if (values.request) {
    if (values.state !== undefined || values['state-file'] !== undefined) throw new JudgmentError('invalid-request', '--request already carries the state.');
    return parseJson('Request', readSource(values.request, stdin));
  }
  const stateFlags = [values.state, values['state-file']].filter(v => v !== undefined).length;
  if (stateFlags !== 1) throw new JudgmentError('invalid-request', 'Pass exactly one of --state or --state-file with --questions.');
  const raw = values.state !== undefined ? values.state : readSource(values['state-file']!, stdin);
  let state: unknown = raw;
  if (values['state-file'] !== undefined && /\.json$/i.test(values['state-file'])) state = parseJson('State file', raw);
  return { state, questions: parseJson('Questions', readSource(values.questions!, stdin)) };
}

function formatAnswer(id: string, answer: Answer): string {
  const dist = (p: Record<string, number>, legend?: Record<string, string>) =>
    Object.entries(p).map(([key, value]) => `${legend?.[key] ?? key} ${value.toFixed(2)}`).join(' · ');
  if (answer.type === 'noul') return `${id}\tnoul\t${answer.noul.toFixed(2)}`;
  if (answer.type === 'choice') return `${id}\tchoice\t${answer.choice}\t(confidence ${answer.confidence.toFixed(2)})\t${dist(answer.probabilities)}`;
  return `${id}\tscore\t${answer.score.toFixed(2)}\t(confidence ${answer.confidence.toFixed(2)})\t${dist(answer.probabilities, answer.legend)}`;
}

export function formatJudgment(response: JudgmentResponse): string {
  const lines = [`${response.provider}/${response.model}  in ${response.usage.input_tokens} out ${response.usage.output_tokens}`];
  for (const [id, answer] of Object.entries(response.answers)) lines.push(formatAnswer(id, answer));
  return lines.join('\n') + '\n';
}

export async function runJudge(rawArgs: string[], options: JudgeCommandOptions = {}): Promise<number> {
  const write = options.write ?? ((text: string) => { process.stdout.write(text); });
  const stdin = options.stdin ?? (() => fs.readFileSync(0, 'utf8'));
  let json = false;
  const fail = (failure: JudgeFailure, exitCode: number): number => {
    if (json) write(JSON.stringify({ version: 1, type: 'judgment', ...failure }) + '\n');
    else write(`${failure.message}\n${failure.error === 'invalid-arguments' ? `\n${JUDGE_USAGE}\n` : ''}`);
    return exitCode;
  };
  // `typesafe` is a judgment engine, not a chat provider, so it never reaches
  // preference validation; every other --provider/--model flag resolves normally.
  let native: ReturnType<typeof stripTypesafeFlag>, preference: ReturnType<typeof parseModelFlags>['preference'], rest: string[];
  try { native = stripTypesafeFlag(rawArgs); ({ preference, args: rest } = parseModelFlags(native.args)); }
  catch (error) { return fail({ error: 'invalid-arguments', message: error instanceof Error ? error.message : String(error) }, 2); }
  if (native.typesafe && preference.provider !== undefined) return fail({ error: 'invalid-arguments', message: 'Duplicate --provider option' }, 2);
  let parsed: ReturnType<typeof parseArgs<{ options: Record<string, { type: 'string' | 'boolean' }> }>>;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: false, options: {
      json: { type: 'boolean' }, request: { type: 'string' }, questions: { type: 'string' }, state: { type: 'string' }, 'state-file': { type: 'string' },
    } });
  } catch (error) { return fail({ error: 'invalid-arguments', message: error instanceof Error ? error.message : String(error) }, 2); }
  json = !!parsed.values.json;

  let provider: JudgmentEngine, model: string | undefined;
  if (native.typesafe) { provider = 'typesafe'; model = preference.model ?? undefined; }
  else {
    const resolved = resolvePreferences(options.cwd ?? process.cwd(), { turn: preference });
    provider = resolved.provider; model = resolved.model;
  }

  try {
    const request = loadRequest(parsed.values as Parameters<typeof loadRequest>[0], stdin);
    const response = await evaluate(request, { provider, model, signal: options.signal });
    write(json ? JSON.stringify({ version: 1, type: 'judgment', ...response }) + '\n' : formatJudgment(response));
    return 0;
  } catch (error) {
    if (options.signal?.aborted) return fail({ error: 'cancelled', message: 'Judgment cancelled.' }, 130);
    if (error instanceof JudgmentError) return fail({ error: error.code, message: error.message }, error.code === 'invalid-request' ? 2 : 1);
    return fail({ error: 'unavailable', message: error instanceof Error ? error.message : String(error) }, 1);
  }
}
