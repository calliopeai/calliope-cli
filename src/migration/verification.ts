import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, digest } from '../approvals/index.js';
import { throwIfCancelled, cancellable } from '../cancellation.js';
import { worktreeGit } from '../isolation/worktree.js';
import { assertLocalIsolationImage, runIsolatedCommand } from '../isolation/process.js';
import type { CommandEvidence } from '../isolation/contracts.js';
import { inventorySource, MigrationError, sourcePath } from './inventory.js';

export const VERIFIER_VERSION = 'byte-parity-v1';
export const VERIFICATION_ADAPTER = 'javascript-to-typescript-cli/v1';
export type SourcePin = { revision: string; path: string; object: string };
export type ExpectedBehavior = { exitCode: number; stdout: string; stderr: string };
export type BehaviorFingerprint = { exitCode: number; stdout: { sha256: string; bytes: number }; stderr: { sha256: string; bytes: number } };
export type VerificationPlan = {
  format: 'calliope.migration.verification-plan/v1'; adapter: typeof VERIFICATION_ADAPTER;
  verifier: typeof VERIFIER_VERSION; runtime: { image: string; node: string };
  source: SourcePin; candidate: SourcePin; negative: SourcePin; rules: SourcePin;
  cases: { id: string; argument: string; expected: ExpectedBehavior }[];
  negativeControl: { caseId: string; expected: ExpectedBehavior };
  limits: { commandTimeoutMs: number; totalMs: number };
};
function fail(message: string): never { throw new MigrationError('invalid', message); }
const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const oid = (s: unknown) => typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
function shape(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail('Invalid migration verification fields.');
}
function expected(v: unknown): void {
  shape(v, ['exitCode', 'stdout', 'stderr']);
  if (!Number.isSafeInteger(v.exitCode) || Number(v.exitCode) < 0 || Number(v.exitCode) > 124 ||
      typeof v.stdout !== 'string' || typeof v.stderr !== 'string' || Buffer.byteLength(v.stdout) > 8192 || Buffer.byteLength(v.stderr) > 8192) fail('Use bounded expected output and exit codes 0–124.');
}
export const byteFingerprint = (text: string) => ({ sha256: digest(text), bytes: Buffer.byteLength(text) });
export const behaviorFingerprint = (value: ExpectedBehavior): BehaviorFingerprint => ({ exitCode: value.exitCode, stdout: byteFingerprint(value.stdout), stderr: byteFingerprint(value.stderr) });
export function compareBehavior(a: BehaviorFingerprint, b: BehaviorFingerprint): boolean {
  return a.exitCode === b.exitCode && a.stdout.sha256 === b.stdout.sha256 && a.stdout.bytes === b.stdout.bytes && a.stderr.sha256 === b.stderr.sha256 && a.stderr.bytes === b.stderr.bytes;
}
/** Adversarial sanity checks run before any repository code, including the baseline. */
export function comparatorHealthy(compare = compareBehavior): boolean {
  const a = behaviorFingerprint({ exitCode: 0, stdout: 'public result\n', stderr: 'notice\n' });
  try { return compare(a, { ...a, stdout: { ...a.stdout }, stderr: { ...a.stderr } }) && !compare(a, { ...a, exitCode: 1 }) &&
    !compare(a, { ...a, stdout: byteFingerprint('public RESULT\n') }) &&
    !compare(a, { ...a, stderr: byteFingerprint('NOTICE\n') }) &&
    !compare(a, { ...a, stdout: { ...a.stdout, bytes: a.stdout.bytes + 1 } }) &&
    !compare(a, { ...a, stderr: { ...a.stderr, bytes: a.stderr.bytes + 1 } });
  } catch { return false; }
}
export function analyzeVerificationPlan(value: unknown) {
  let raw: string;
  try { raw = canonicalJson(value); } catch { return fail('Use bounded plain JSON for the verification plan.'); }
  if (Buffer.byteLength(raw) > 262144) fail('Keep a verification plan within 256 KiB.');
  const v: unknown = JSON.parse(raw);
  shape(v, ['format', 'adapter', 'verifier', 'runtime', 'source', 'candidate', 'negative', 'rules', 'cases', 'negativeControl', 'limits']);
  if (v.format !== 'calliope.migration.verification-plan/v1' || v.adapter !== VERIFICATION_ADAPTER || v.verifier !== VERIFIER_VERSION) fail('Unsupported migration adapter or verifier version.');
  shape(v.runtime, ['image', 'node']);
  if (typeof v.runtime.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.runtime.image) || typeof v.runtime.node !== 'string' || !/^v24\.\d+\.\d+$/.test(v.runtime.node)) fail('Pin a local Linux image and its exact Node 24 runtime version.');
  for (const role of ['source', 'candidate', 'negative', 'rules']) {
    const pin = v[role]; shape(pin, ['revision', 'path', 'object']);
    if (!oid(pin.revision) || !oid(pin.object) || typeof pin.path !== 'string' || pin.path === '.') fail('Pin every program and rulebook to a full Git commit, path and blob.');
    sourcePath(pin.path);
    if (role === 'source' && !pin.path.endsWith('.mjs') || ['candidate', 'negative'].includes(role) && !pin.path.endsWith('.mts')) fail('This adapter compares self-contained .mjs and .mts command-line programs.');
  }
  if (!Array.isArray(v.cases) || !v.cases.length || v.cases.length > 8) fail('Provide 1–8 public-interface cases.');
  const ids = new Set<string>();
  for (const row of v.cases) {
    shape(row, ['id', 'argument', 'expected']);
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id) || ids.has(row.id) || typeof row.argument !== 'string' || !row.argument.length || row.argument.length > 8192 || /[\x00-\x1f\x7f]/.test(row.argument)) fail('Use unique case IDs and one bounded argument per case.');
    ids.add(row.id); expected(row.expected);
  }
  shape(v.negativeControl, ['caseId', 'expected']);
  if (typeof v.negativeControl.caseId !== 'string' || !ids.has(v.negativeControl.caseId)) fail('Select a declared case for the negative control.');
  expected(v.negativeControl.expected);
  shape(v.limits, ['commandTimeoutMs', 'totalMs']);
  if (!Number.isSafeInteger(v.limits.commandTimeoutMs) || Number(v.limits.commandTimeoutMs) < 100 || Number(v.limits.commandTimeoutMs) > 10000 ||
      !Number.isSafeInteger(v.limits.totalMs) || Number(v.limits.totalMs) < Number(v.limits.commandTimeoutMs) || Number(v.limits.totalMs) > 300000) fail('Bound each command to 100–10,000ms and the full observation to at most 300,000ms.');
  const plan = v as unknown as VerificationPlan;
  // Validate declared data independently of the comparator being qualified.
  if (canonicalJson(plan.negativeControl.expected) === canonicalJson(plan.cases.find(c => c.id === plan.negativeControl.caseId)!.expected)) fail('The known negative control must differ from the baseline behavior.');
  return { plan, digest: digest(raw), commandCount: 2 * plan.cases.length + 2 };
}

export interface VerificationOptions {
  signal?: AbortSignal;
  /** Host authority. Never accept an approval callback from agent-authored JSON. */
  approve: (request: { digest: string; repository: string; pins: SourcePin[]; image: string; commandCount: number; totalMs: number }) => Promise<boolean>;
  /** A host may impose an earlier inherited deadline and reserve commands in its ledger. */
  deadline?: number;
  reserveCommand?: (request: { digest: string; phase: string; caseId: string | null; command: number }) => Promise<boolean>;
}
type Phase = 'runtime' | 'baseline' | 'negative-control' | 'candidate';
type Outcome = 'passed' | 'input-failure' | 'baseline-failure' | 'verifier-failure' | 'regression' | 'environment-failure' | 'cancelled';
class SourceInputError extends MigrationError {
  constructor(message: string) { super('invalid', message); }
}

/** The existing isolated-command owner executes every observation; no provider or worker scheduler. */
export async function verifyMigration(repository: string, input: unknown, options: VerificationOptions) {
  const { plan, digest: planDigest, commandCount } = analyzeVerificationPlan(input);
  if (!options || typeof options.approve !== 'function' || options.deadline !== undefined && !Number.isFinite(options.deadline)) fail('A host approval hook and a valid inherited deadline are required.');
  throwIfCancelled(options.signal);
  if (typeof repository !== 'string' || repository.length > 4096 || /[\x00-\x1f\x7f]/.test(repository)) fail('Select a local repository root.');
  try { repository = realpathSync(repository); } catch { throw new MigrationError('unavailable', 'The selected repository is unavailable.'); }
  const approved = await cancellable(options.approve({ digest: planDigest, repository, pins: JSON.parse(JSON.stringify([plan.source, plan.candidate, plan.negative, plan.rules])), image: plan.runtime.image, commandCount, totalMs: plan.limits.totalMs }), options.signal);
  if (!approved) fail('Migration verification was not approved; no program was executed.');
  const deadline = Math.min(Date.now() + plan.limits.totalMs, options.deadline ?? Infinity);
  if (deadline <= Date.now()) fail('The inherited verification deadline has expired.');
  const timer = new AbortController(), signal = AbortSignal.any([timer.signal, ...(options.signal ? [options.signal] : [])]);
  const alarm = setTimeout(() => timer.abort(), Math.max(1, deadline - Date.now()));
  const checkBudget = () => { if (Date.now() >= deadline) timer.abort(); throwIfCancelled(signal); };
  const observations: { phase: Phase; caseId: string | null; matches: boolean | null; evidence: Omit<CommandEvidence, 'stdout' | 'stderr'> }[] = [];
  let scratch: string | undefined, safeToRemove = true, outcome: Outcome = 'environment-failure', reason = 'Verification did not complete.', commands = 0;
  const programs = new Map<string, { directory: string; file: string; bytes: string; extension: string }>();
  try {
    if (!comparatorHealthy()) { outcome = 'verifier-failure'; reason = 'Comparator self-test failed.'; }
    else {
      // Read only exact approved Git objects. The working checkout is never executed.
      const material: { role: string; text: string; extension: string }[] = [];
      for (const role of ['source', 'candidate', 'negative', 'rules'] as const) {
        const pin = plan[role], inventory = await inventorySource({ repository, revision: pin.revision, readPaths: [pin.path] }, { signal });
        const file = inventory.files[0];
        if (inventory.files.length !== 1 || !file || file.path !== pin.path || !['100644', '100755'].includes(file.mode) || file.object !== pin.object || file.bytes === null || file.bytes > 65536) throw new SourceInputError('A source/rule pin is stale, unsupported or exceeds 64 KiB. Replan before execution.');
        const text = await worktreeGit(repository, ['--no-replace-objects', 'cat-file', 'blob', pin.object], signal);
        const bytes = Buffer.byteLength(text), object = createHash(pin.object.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes}\0`).update(text).digest('hex');
        if (object !== pin.object || bytes !== file.bytes) throw new SourceInputError('Source bytes changed or are not valid UTF-8.');
        if (role !== 'rules') material.push({ role, text, extension: role === 'source' ? 'mjs' : 'mts' });
      }
      await assertLocalIsolationImage(plan.runtime.image, signal);
      scratch = mkdtempSync(join(tmpdir(), 'calliope-migration-check-'));
      for (const { role, text, extension } of material) {
        const directory = join(scratch, role); mkdirSync(directory, { mode: 0o700 });
        const file = join(directory, `program.${extension}`); writeFileSync(file, text, { mode: 0o400, flag: 'wx' });
        programs.set(role, { directory, file, bytes: digest(text), extension });
      }
      const observe = async (phase: Phase, role: string, caseId: string | null, argument?: string): Promise<BehaviorFingerprint | null> => {
        checkBudget();
        if (++commands > commandCount || options.reserveCommand && !await cancellable(options.reserveCommand({ digest: planDigest, phase, caseId, command: commands }), signal)) fail('The host command allowance refused verification.');
        checkBudget();
        const program = programs.get(role)!;
        const unchanged = () => lstatSync(program.file).isFile() && !lstatSync(program.file).isSymbolicLink() && lstatSync(program.file).size <= 65536 && digest(readFileSync(program.file, 'utf8')) === program.bytes;
        if (!unchanged()) throw new SourceInputError('The isolated source snapshot changed.');
        const argv = phase === 'runtime' ? ['node', '--version'] : ['node', `/project/program.${program.extension}`, argument!];
        safeToRemove = false; // A lost runner result must retain the mount for inspection.
        const receipt = await runIsolatedCommand(plan.runtime.image, { artifactId: `${phase}-${caseId ?? 'version'}`, argv, timeoutMs: Math.max(1, Math.min(plan.limits.commandTimeoutMs, deadline - Date.now())) }, [{ source: program.directory, target: '/project' }], signal);
        safeToRemove = receipt.cleanupConfirmed;
        const { stdout: _stdout, stderr: _stderr, ...evidence } = receipt;
        const row = { phase, caseId, matches: null as boolean | null, evidence }; observations.push(row);
        const outputs = receipt.outputDigests;
        if (!unchanged() || !receipt.cleanupConfirmed || receipt.truncated || !['passed', 'failed'].includes(receipt.outcome) || !outputs || outputs.version !== 1 ||
            !hash(outputs.stdout.sha256) || !hash(outputs.stderr.sha256)) return null;
        return { exitCode: receipt.exitCode, stdout: outputs.stdout, stderr: outputs.stderr };
      };
      const check = async (phase: Phase, role: string, id: string | null, want: ExpectedBehavior, argument?: string) => {
        const got = await observe(phase, role, id, argument);
        if (!got) return null;
        const matches = compareBehavior(got, behaviorFingerprint(want)); observations.at(-1)!.matches = matches;
        return { got, matches };
      };
      const run = async () => {
        const runtime = await check('runtime', 'source', null, { exitCode: 0, stdout: plan.runtime.node + '\n', stderr: '' });
        if (!runtime?.matches) return { outcome: 'environment-failure' as const, reason: 'The pinned runtime was unavailable or did not match.' };
        for (const c of plan.cases) {
          const baseline = await check('baseline', 'source', c.id, c.expected, c.argument);
          if (!baseline) return { outcome: 'environment-failure' as const, reason: 'Baseline observation was incomplete.' };
          if (!baseline.matches) return { outcome: 'baseline-failure' as const, reason: 'The original program does not meet the pinned public-interface contract.' };
        }
        const c = plan.cases.find(row => row.id === plan.negativeControl.caseId)!;
        const negative = await check('negative-control', 'negative', c.id, plan.negativeControl.expected, c.argument);
        if (!negative) return { outcome: 'environment-failure' as const, reason: 'Negative-control observation was incomplete.' };
        if (!negative.matches || compareBehavior(negative.got, behaviorFingerprint(c.expected))) return { outcome: 'verifier-failure' as const, reason: 'The known regression was not reproduced and rejected as expected.' };
        let regression = false;
        for (const item of plan.cases) {
          const candidate = await check('candidate', 'candidate', item.id, item.expected, item.argument);
          if (!candidate) return { outcome: 'environment-failure' as const, reason: 'Candidate observation was incomplete.' };
          if (!candidate.matches) regression = true;
        }
        return { outcome: regression ? 'regression' as const : 'passed' as const, reason: regression ? 'Candidate behavior differs on at least one declared case.' : 'Baseline, negative control and candidate observations satisfy the declared contract.' };
      };
      ({ outcome, reason } = await run());
    }
  } catch (error) {
    outcome = options.signal?.aborted ? 'cancelled' : error instanceof SourceInputError ? 'input-failure' : 'environment-failure';
    reason = error instanceof MigrationError ? error.message : timer.signal.aborted ? 'Verification exceeded its total deadline.' : 'Verification could not obtain complete native execution evidence.';
  } finally {
    clearTimeout(alarm);
    if (scratch && safeToRemove) { try { rmSync(scratch, { recursive: true }); scratch = undefined; } catch { /* Retain the exact scratch path for host cleanup. */ } }
  }
  if (options.signal?.aborted) { outcome = 'cancelled'; reason = 'Verification cancelled.'; }
  else if (timer.signal.aborted || Date.now() >= deadline) { outcome = 'environment-failure'; reason = 'Verification exceeded its total deadline.'; }
  const report = { format: 'calliope.migration.verification-report/v1', verifier: VERIFIER_VERSION, adapter: plan.adapter, planDigest, runtime: plan.runtime,
    pins: { source: plan.source, candidate: plan.candidate, negative: plan.negative, rules: plan.rules }, outcome, reason, observations,
    commandsUsed: commands, commandLimit: commandCount, retainedWorkspace: scratch ?? null,
    limitations: ['Only declared cases of this self-contained command-line interface were compared; this is not proof of general program equivalence.', 'No TypeScript type-check, dependency install, migration dispatch or rollout was performed.'] };
  return { ...report, digest: digest(canonicalJson(report)) };
}
