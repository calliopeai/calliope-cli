/** Re-evaluate supplied receipts. Integrity is not producer authentication or execution authority. */
import { canonicalJson, digest } from '../approvals/index.js';
import { MigrationError } from './inventory.js';
import { analyzeVerificationPlan, behaviorFingerprint, compareBehavior, comparatorHealthy, type ExpectedBehavior } from './verification.js';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(message: string): never { throw new MigrationError('invalid', message); }
function fields(value: unknown, required: string[], optional: string[] = []): asserts value is RecordValue {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('Invalid migration evidence fields.');
}

export function analyzeVerificationEvidence(inputPlan: unknown, inputReport: unknown) {
  if (!comparatorHealthy()) fail('The evidence comparator failed its adversarial self-check.');
  const analysis = analyzeVerificationPlan(inputPlan), { plan } = analysis;
  let encoded: string;
  try { encoded = canonicalJson(inputReport); } catch { return fail('Use bounded plain JSON for verification evidence.'); }
  if (Buffer.byteLength(encoded) > 262144) fail('Keep verification evidence within 256 KiB.');
  const report: unknown = JSON.parse(encoded);
  fields(report, ['format', 'verifier', 'adapter', 'planDigest', 'runtime', 'pins', 'outcome', 'reason', 'observations', 'commandsUsed', 'commandLimit', 'retainedWorkspace', 'limitations', 'digest']);
  if (report.format !== 'calliope.migration.verification-report/v1' || report.verifier !== plan.verifier || report.adapter !== plan.adapter) fail('Unsupported verification evidence format.');
  const { digest: suppliedDigest, ...body } = report;
  if (!hash(suppliedDigest) || digest(canonicalJson(body)) !== suppliedDigest) fail('Verification evidence digest does not match its contents.');
  if (report.planDigest !== analysis.digest || !same(report.runtime, plan.runtime) || !same(report.pins, { source: plan.source, candidate: plan.candidate, negative: plan.negative, rules: plan.rules })) fail('Verification evidence belongs to different source, rules, runtime or cases.');
  const outcomes = ['passed', 'input-failure', 'baseline-failure', 'verifier-failure', 'regression', 'environment-failure', 'cancelled'];
  if (typeof report.outcome !== 'string' || !outcomes.includes(report.outcome) || typeof report.reason !== 'string' || report.reason.length > 4096 || !Array.isArray(report.limitations) || report.limitations.length > 32 || report.limitations.some(v => typeof v !== 'string' || v.length > 4096) || report.retainedWorkspace !== null && (typeof report.retainedWorkspace !== 'string' || report.retainedWorkspace.length > 4096)) fail('Invalid verification outcome metadata.');
  if (!Array.isArray(report.observations) || report.observations.length > analysis.commandCount || !Number.isSafeInteger(report.commandsUsed) || Number(report.commandsUsed) < report.observations.length || Number(report.commandsUsed) > analysis.commandCount + 1 || report.commandLimit !== analysis.commandCount) fail('Invalid verification command accounting.');
  const expected = [
    { phase: 'runtime', caseId: null, argv: ['node', '--version'], behavior: { exitCode: 0, stdout: plan.runtime.node + '\n', stderr: '' } },
    ...plan.cases.map(c => ({ phase: 'baseline', caseId: c.id, argv: ['node', '/project/program.mjs', c.argument], behavior: c.expected })),
    { phase: 'negative-control', caseId: plan.negativeControl.caseId, argv: ['node', '/project/program.mts', plan.cases.find(c => c.id === plan.negativeControl.caseId)!.argument], behavior: plan.negativeControl.expected },
    ...plan.cases.map(c => ({ phase: 'candidate', caseId: c.id, argv: ['node', '/project/program.mts', c.argument], behavior: c.expected })),
  ];
  const findings: { code: string; observation: number | null }[] = [];
  const containers = new Set<string>();
  for (const [index, row] of report.observations.entries()) {
    fields(row, ['phase', 'caseId', 'matches', 'evidence']);
    const wanted = expected[index]!;
    if (row.phase !== wanted.phase || row.caseId !== wanted.caseId || ![true, false, null].includes(row.matches as boolean | null)) fail('Verification observations are missing, duplicated or out of order.');
    const evidence = row.evidence;
    fields(evidence, ['version', 'kind', 'argv', 'image', 'exitCode', 'outcome', 'truncated', 'durationMs', 'container', 'cleanupConfirmed'], ['cleanup', 'outputDigests']);
    if (evidence.version !== 1 || evidence.kind !== 'isolated-command' || evidence.image !== plan.runtime.image || !same(evidence.argv, wanted.argv) || typeof evidence.container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(evidence.container) || !Number.isSafeInteger(evidence.exitCode) || !Number.isSafeInteger(evidence.durationMs) || Number(evidence.durationMs) < 0 || typeof evidence.truncated !== 'boolean' || typeof evidence.cleanupConfirmed !== 'boolean' || typeof evidence.outcome !== 'string' || !['passed', 'failed', 'cancelled', 'timeout', 'unavailable'].includes(evidence.outcome)) fail('Verification command evidence does not match its declared observation.');
    if (containers.has(evidence.container)) findings.push({ code: 'reused-container-identity', observation: index });
    containers.add(evidence.container);
    if (evidence.cleanup !== undefined) {
      fields(evidence.cleanup, ['version', 'removal'], ['verification']);
      if (evidence.cleanup.version !== 1) fail('Unsupported cleanup evidence.');
      for (const key of ['removal', 'verification']) {
        const result = evidence.cleanup[key]; if (result === undefined) continue;
        fields(result, ['outcome', 'exitCode']);
        if (typeof result.outcome !== 'string' || !(key === 'removal' ? ['removed', 'absent', 'timeout', 'error'] : ['absent', 'present', 'timeout', 'error']).includes(String(result.outcome)) || result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) fail('Invalid cleanup evidence.');
      }
      const removal = evidence.cleanup.removal as RecordValue, verification = evidence.cleanup.verification as RecordValue | undefined;
      if (evidence.cleanupConfirmed && !['removed', 'absent'].includes(String(removal.outcome)) && verification?.outcome !== 'absent' || verification?.outcome === 'present' && evidence.cleanupConfirmed || removal.outcome === 'removed' && removal.exitCode !== 0 || removal.outcome === 'absent' && removal.exitCode !== 1 || verification?.outcome === 'absent' && verification.exitCode !== 1) findings.push({ code: 'contradictory-cleanup', observation: index });
    }
    else findings.push({ code: 'missing-cleanup-evidence', observation: index });
    const outputs = evidence.outputDigests;
    if (outputs !== undefined) {
      fields(outputs, ['version', 'stdout', 'stderr']);
      if (outputs.version !== 1) fail('Unsupported output fingerprint version.');
      for (const key of ['stdout', 'stderr']) {
        fields(outputs[key], ['sha256', 'bytes']); const stream = outputs[key] as RecordValue;
        if (!hash(stream.sha256) || !Number.isSafeInteger(stream.bytes) || Number(stream.bytes) < 0 || Number(stream.bytes) > 65536) fail('Invalid output fingerprint.');
      }
    }
    const complete = evidence.cleanupConfirmed && !evidence.truncated && ['passed', 'failed'].includes(String(evidence.outcome)) && outputs !== undefined;
    if (!complete || !object(outputs)) { findings.push({ code: 'incomplete-observation', observation: index }); continue; }
    if ((evidence.exitCode === 0) !== (evidence.outcome === 'passed')) findings.push({ code: 'contradictory-command-outcome', observation: index });
    const got = { exitCode: evidence.exitCode as number, stdout: outputs.stdout as { sha256: string; bytes: number }, stderr: outputs.stderr as { sha256: string; bytes: number } };
    const matches = compareBehavior(got, behaviorFingerprint(wanted.behavior as ExpectedBehavior));
    if (row.matches !== matches) findings.push({ code: 'contradictory-comparison', observation: index });
    if (!matches) findings.push({ code: wanted.phase === 'candidate' ? 'candidate-regression' : wanted.phase === 'baseline' ? 'baseline-failure' : wanted.phase === 'negative-control' ? 'ineffective-negative-control' : 'runtime-mismatch', observation: index });
    if (wanted.phase === 'negative-control' && compareBehavior(got, behaviorFingerprint(plan.cases.find(c => c.id === wanted.caseId)!.expected))) findings.push({ code: 'negative-control-matches-baseline', observation: index });
  }
  if (report.observations.length !== analysis.commandCount || report.commandsUsed !== analysis.commandCount) findings.push({ code: 'incomplete-command-coverage', observation: null });
  if (report.retainedWorkspace !== null) findings.push({ code: 'retained-workspace', observation: null });
  if (report.outcome !== 'passed') findings.push({ code: 'reported-' + report.outcome, observation: null });
  const value = { format: 'calliope.migration.evidence-review/v1', planDigest: analysis.digest, reportDigest: suppliedDigest as string,
    status: findings.length ? 'not-passing' : 'passing-observations', caseIds: plan.cases.map(c => c.id), findings,
    authority: 'Supplied observation integrity only. No producer authentication, independent review or execution approval is implied.' };
  return { ...value, digest: digest(canonicalJson(value)) };
}
