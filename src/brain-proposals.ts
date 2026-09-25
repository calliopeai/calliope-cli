/**
 * Calliope CLI binding for an external adopted Project Brain's maintenance
 * primitives (project-brain#292): `maintenance-proposals/v1` reports and
 * maintained-summary update previews, built only from an explicit CLI-supplied
 * operator identity and configuration.
 *
 * The target brain's own `scripts/inspect-maintenance.py` and
 * `scripts/maintain-summary.py` are the core contract this binds to
 * (https://github.com/ConflictHQ/project-brain, `template/docs/primitives/
 * semantic-maintenance.md` and `maintained-summaries.md`). This module never
 * reimplements that logic: it only invokes those scripts as subprocesses and
 * relays their output for independent review. Neither action ever passes
 * `--propose` — there is no persist path here, only a read-only preview. A
 * request or candidate carrying a model-selected actor, reviewer or grant is
 * refused before either script runs.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import { BrainError } from './brain/types.js';
import { cancellationError, isCancellation, throwIfCancelled } from './cancellation.js';

const execFileAsync = promisify(execFile);

const DEFAULT_INTERPRETER = 'python3';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Keys a model-authored draft can carry that must never reach the core
 * primitives from producer input: identity and review status come only from
 * host configuration and explicit CLI arguments, never a request/candidate field.
 */
const FORBIDDEN_IDENTITY_KEYS = ['actor', 'grants', 'grant', 'principal', 'reviewer', 'reviewedBy', 'review'] as const;

export function refuseForwardedIdentity(payload: unknown, where: string): void {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const found = FORBIDDEN_IDENTITY_KEYS.filter((key) => key in (payload as Record<string, unknown>));
    if (found.length) throw new BrainError('policy-denied', `${where} carries model-selected identity or grant fields: ${found.sort().join(', ')}`);
  }
}

function readJson(path: string, where: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new BrainError('invalid', `${where} is unavailable: ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BrainError('invalid', `${where} is not valid JSON: ${path}`);
  }
}

function parseJsonOutput(raw: string, where: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new BrainError('unavailable', `${where} did not return valid JSON`);
  }
}

interface RunOptions {
  /** Test-only override; production always resolves the real `python3`. */
  interpreter?: string;
  signal?: AbortSignal;
}

interface ExecFileFailure extends Error {
  code?: string | number;
  stderr?: string;
}

async function runPrimitive(root: string, scriptName: string, argv: string[], options: RunOptions): Promise<string> {
  throwIfCancelled(options.signal);
  const interpreter = options.interpreter ?? DEFAULT_INTERPRETER;
  const scriptPath = join(root, 'scripts', scriptName);
  if (!existsSync(scriptPath))
    throw new BrainError('unavailable', `${scriptPath} is unavailable; --root must be an adopted Project Brain instance`);
  try {
    const { stdout } = await execFileAsync(interpreter, [scriptPath, ...argv], {
      cwd: root,
      signal: options.signal,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    if (isCancellation(error)) throw cancellationError();
    const failure = error as ExecFileFailure;
    if (failure.code === 'ENOENT') throw new BrainError('unavailable', `${interpreter} is unavailable to run ${scriptName}`);
    const detail = failure.stderr?.toString().trim();
    throw new BrainError('unavailable', detail || `${scriptName} failed`);
  }
}

export interface MaintenanceReportOptions extends RunOptions {
  root: string;
  hostConfig: string;
  /** Trusted local operator identity, never a producer/request field. */
  actor: string;
  requestPath: string;
  maxFindings?: number;
  maxBytes?: number;
  now?: string;
  outputPath?: string;
}

export interface MaintenanceReportResult {
  report: unknown;
  outputPath?: string;
}

/** Build a `maintenance-proposals/v1` report for independent review. */
export async function maintenanceReport(options: MaintenanceReportOptions): Promise<MaintenanceReportResult> {
  const request = readJson(options.requestPath, 'maintenance request');
  refuseForwardedIdentity(request, 'maintenance request');
  const argv = ['--root', options.root, '--host-config', options.hostConfig, '--actor', options.actor, '--request', options.requestPath];
  if (options.maxFindings !== undefined) argv.push('--max-findings', String(options.maxFindings));
  if (options.maxBytes !== undefined) argv.push('--max-bytes', String(options.maxBytes));
  if (options.now !== undefined) argv.push('--now', options.now);
  if (options.outputPath !== undefined) argv.push('--output', options.outputPath);
  const stdout = await runPrimitive(options.root, 'inspect-maintenance.py', argv, options);
  if (options.outputPath !== undefined) return { report: null, outputPath: options.outputPath };
  return { report: parseJsonOutput(stdout, 'maintenance report') };
}

export interface SummaryPlanOptions extends RunOptions {
  root: string;
  hostConfig: string;
  inputPath: string;
  now?: string;
  outputPath?: string;
}

export interface SummaryPlanResult {
  preview: unknown;
  outputPath?: string;
}

/**
 * Preview a maintained-summary amendment; this binding never proposes or
 * commits it. `--propose` is never sent — there is no persist path here.
 */
export async function summaryPlan(options: SummaryPlanOptions): Promise<SummaryPlanResult> {
  const input = readJson(options.inputPath, 'summary plan input');
  refuseForwardedIdentity(input, 'summary plan input');
  refuseForwardedIdentity(input !== null && typeof input === 'object' ? (input as Record<string, unknown>)['candidate'] : undefined, 'summary plan candidate');
  const argv = ['--root', options.root, '--host-config', options.hostConfig, '--input', options.inputPath];
  if (options.now !== undefined) argv.push('--now', options.now);
  if (options.outputPath !== undefined) argv.push('--output', options.outputPath);
  const stdout = await runPrimitive(options.root, 'maintain-summary.py', argv, options);
  if (options.outputPath !== undefined) return { preview: null, outputPath: options.outputPath };
  return { preview: parseJsonOutput(stdout, 'summary plan preview') };
}

const USAGE =
  'calliope brain-proposals maintenance-report --root <path> --host-config <path> --actor <id> --request <path> ' +
  '[--max-findings N] [--max-bytes N] [--now <iso>] [--output <path>] | ' +
  'calliope brain-proposals summary-plan --root <path> --host-config <path> --input <path> [--now <iso>] [--output <path>]';

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new BrainError('invalid', `--${flag} must be a positive integer`);
  return n;
}

export interface BrainProposalsRunOptions {
  write?: (line: string) => void;
  signal?: AbortSignal;
  /** Test-only override; production always resolves the real `python3`. */
  interpreter?: string;
}

function emitEnvelope(write: (line: string) => void, action: string, body: { data: unknown } | { error: { code: string; message: string } }): void {
  write(JSON.stringify({ version: 1, type: 'brain-proposals', action, localOnly: true, ...body }) + '\n');
}

/**
 * `calliope brain-proposals maintenance-report|summary-plan` — headless-only.
 * Output is always the one-line JSON envelope: both target primitives are
 * JSON-only contracts, so a bespoke human-text mode would just relabel their
 * own fields.
 */
export async function runBrainProposalsCommand(args: string[], options: BrainProposalsRunOptions = {}): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const action = args[0];
  try {
    throwIfCancelled(options.signal);
    if (action !== 'maintenance-report' && action !== 'summary-plan') throw new BrainError('invalid', USAGE);
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        root: { type: 'string' },
        'host-config': { type: 'string' },
        actor: { type: 'string' },
        request: { type: 'string' },
        input: { type: 'string' },
        'max-findings': { type: 'string' },
        'max-bytes': { type: 'string' },
        now: { type: 'string' },
        output: { type: 'string' },
      },
    });
    if (!values.root || !values['host-config']) throw new BrainError('invalid', USAGE);
    let data: unknown;
    if (action === 'maintenance-report') {
      if (!values.actor || !values.request) throw new BrainError('invalid', USAGE);
      const result = await maintenanceReport({
        root: values.root,
        hostConfig: values['host-config'],
        actor: values.actor,
        requestPath: values.request,
        maxFindings: parsePositiveInt(values['max-findings'], 'max-findings'),
        maxBytes: parsePositiveInt(values['max-bytes'], 'max-bytes'),
        now: values.now,
        outputPath: values.output,
        interpreter: options.interpreter,
        signal: options.signal,
      });
      data = result.outputPath !== undefined ? { outputPath: result.outputPath } : result.report;
    } else {
      if (!values.input) throw new BrainError('invalid', USAGE);
      const result = await summaryPlan({
        root: values.root,
        hostConfig: values['host-config'],
        inputPath: values.input,
        now: values.now,
        outputPath: values.output,
        interpreter: options.interpreter,
        signal: options.signal,
      });
      data = result.outputPath !== undefined ? { outputPath: result.outputPath } : result.preview;
    }
    emitEnvelope(write, action, { data });
    return 0;
  } catch (error) {
    const cancelled = options.signal?.aborted || isCancellation(error);
    const known = error instanceof BrainError;
    const invalid = error instanceof TypeError;
    const code = cancelled ? 'cancelled' : known ? error.code : invalid ? 'invalid' : 'unavailable';
    const message = cancelled
      ? 'brain-proposals operation cancelled.'
      : known
        ? error.message
        : invalid
          ? USAGE
          : 'brain-proposals operation failed; inspect stderr, --root and --host-config.';
    emitEnvelope(write, action ?? 'unknown', { error: { code, message } });
    return cancelled ? 130 : code === 'invalid' ? 2 : code === 'policy-denied' ? 3 : 1;
  }
}
