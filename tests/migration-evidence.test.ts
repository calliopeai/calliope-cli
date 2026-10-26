import { afterEach, describe, expect, it, vi } from 'vitest';
import * as verifier from '../src/migration/verification.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, digest } from '../src/approvals/index.js';
import { analyzeVerificationEvidence, analyzeVerificationPlan, EVIDENCE_REVIEW_SCHEMA, runMigrationCommand, type VerificationPlan } from '../src/migration/index.js';

// Synthetic observation contracts, not evidence of real container isolation.
function fixture() {
  const pin = (path: string) => ({ revision: 'a'.repeat(40), path, object: 'b'.repeat(40) });
  const plan: VerificationPlan = { format: 'calliope.migration.verification-plan/v1', adapter: 'javascript-to-typescript-cli/v1', verifier: 'byte-parity-v1',
    runtime: { image: 'sha256:' + 'c'.repeat(64), node: 'v24.21.0' },
    source: pin('source.mjs'), candidate: pin('candidate.mts'), negative: pin('negative.mts'), rules: pin('RULES.md'),
    cases: [{ id: 'valid', argument: 'valid', expected: { exitCode: 0, stdout: '1\n', stderr: '' } }, { id: 'invalid', argument: 'invalid', expected: { exitCode: 1, stdout: '', stderr: 'invalid input\n' } }],
    negativeControl: { caseId: 'valid', expected: { exitCode: 0, stdout: '2\n', stderr: '' } }, limits: { commandTimeoutMs: 1000, totalMs: 10000 } };
  const analysis = analyzeVerificationPlan(plan);
  const rows = [
    ['runtime', null, ['node', '--version'], { exitCode: 0, stdout: 'v24.21.0\n', stderr: '' }],
    ...plan.cases.map(c => ['baseline', c.id, ['node', '/project/program.mjs', c.argument], c.expected]),
    ['negative-control', 'valid', ['node', '/project/program.mts', 'valid'], plan.negativeControl.expected],
    ...plan.cases.map(c => ['candidate', c.id, ['node', '/project/program.mts', c.argument], c.expected]),
  ];
  const fingerprint = (text: string) => ({ sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
  const report: any = { format: 'calliope.migration.verification-report/v1', verifier: plan.verifier, adapter: plan.adapter, planDigest: analysis.digest, runtime: plan.runtime,
    pins: { source: plan.source, candidate: plan.candidate, negative: plan.negative, rules: plan.rules }, outcome: 'passed', reason: 'Synthetic test evidence',
    observations: rows.map(([phase, caseId, argv, behavior], index) => {
      const b = behavior as { exitCode: number; stdout: string; stderr: string };
      return { phase, caseId, matches: true, evidence: { version: 1, kind: 'isolated-command', argv, image: plan.runtime.image, exitCode: b.exitCode,
        outcome: b.exitCode === 0 ? 'passed' : 'failed', truncated: false, durationMs: 100, container: 'fixture-' + index, cleanupConfirmed: true,
        cleanup: { version: 1, removal: { outcome: 'removed', exitCode: 0 } }, outputDigests: { version: 1, stdout: fingerprint(b.stdout), stderr: fingerprint(b.stderr) } } };
    }), commandsUsed: analysis.commandCount, commandLimit: analysis.commandCount, retainedWorkspace: null, limitations: ['Synthetic unit fixture only.'] };
  return { plan, report: seal(report) };
}
function seal(report: any) { const { digest: _old, ...body } = report; return { ...body, digest: digest(canonicalJson(body)) }; }
function codes(report: any, plan = fixture().plan) { return analyzeVerificationEvidence(plan, seal(report)).findings.map(f => f.code); }
let root: string | undefined;
afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = undefined; } });

describe('read-only migration evidence review', () => {
  it('refuses to evaluate reports when its comparator fails qualification', () => {
    const { plan, report } = fixture();
    const mock = vi.spyOn(verifier, 'comparatorHealthy').mockReturnValue(false);
    try { expect(() => analyzeVerificationEvidence(plan, report)).toThrow('adversarial self-check'); }
    finally { mock.mockRestore(); }
  });
  it('rechecks complete observations including expected nonzero exits, without mutating inputs or granting execution', () => {
    const { plan, report } = fixture(), before = JSON.stringify({ plan, report });
    const result = analyzeVerificationEvidence(plan, report);
    expect(result.status).toBe('passing-observations'); expect(result.findings).toEqual([]); expect(result.caseIds).toEqual(['valid', 'invalid']);
    const { digest: hash, ...body } = result; expect(hash).toBe(digest(canonicalJson(body)));
    expect(result.authority).toContain('No producer authentication'); expect(JSON.stringify({ plan, report })).toBe(before);
  });
  it.each(['stdout', 'stderr', 'exitCode', 'length'])('detects a rewritten success label with altered %s observations even after the attacker recomputes its digest', field => {
    const { report } = fixture(), e = report.observations[4].evidence;
    if (field === 'exitCode') { e.exitCode = 1; e.outcome = 'failed'; }
    else if (field === 'length') e.outputDigests.stdout.bytes++;
    else e.outputDigests[field].sha256 = 'd'.repeat(64);
    expect(codes(report)).toEqual(expect.arrayContaining(['contradictory-comparison', 'candidate-regression']));
  });
  it.each([[0, 'runtime-mismatch'], [1, 'baseline-failure'], [3, 'ineffective-negative-control']] as const)('checks the prerequisite at observation %i', (index, code) => {
    const { report } = fixture(); report.observations[index].evidence.outputDigests.stdout.sha256 = 'd'.repeat(64);
    expect(codes(report)).toContain(code);
  });
  it('rejects a known bad control which actually produced baseline output', () => {
    const { report } = fixture(); report.observations[3].evidence.outputDigests = report.observations[1].evidence.outputDigests;
    expect(codes(report)).toContain('negative-control-matches-baseline');
  });
  it.each(['source', 'candidate', 'negative', 'rules'])('binds the %s pin, even when contents or the success label appear unchanged', role => {
    const { plan, report } = fixture(); const changed = structuredClone(plan) as any; changed[role].revision = 'e'.repeat(40);
    expect(() => analyzeVerificationEvidence(changed, report)).toThrow('different source');
    report.planDigest = analyzeVerificationPlan(changed).digest;
    expect(() => analyzeVerificationEvidence(changed, seal(report))).toThrow('different source');
  });
  it('binds the runtime, cases and rule configuration, refusing a stale report', () => {
    const { plan, report } = fixture(); plan.cases[0]!.argument = 'different';
    expect(() => analyzeVerificationEvidence(plan, report)).toThrow('different source');
    report.planDigest = analyzeVerificationPlan(plan).digest;
    expect(() => analyzeVerificationEvidence(plan, seal(report))).toThrow('declared observation');
  });
  it.each(['truncated', 'cleanup', 'legacy-output', 'timeout', 'unavailable', 'cancelled', 'missing-cleanup'])('does not promote %s evidence to passing', mode => {
    const { report } = fixture(), e = report.observations[0].evidence;
    if (mode === 'truncated') e.truncated = true;
    else if (mode === 'cleanup') e.cleanupConfirmed = false;
    else if (mode === 'legacy-output') delete e.outputDigests;
    else if (mode === 'missing-cleanup') delete e.cleanup;
    else e.outcome = mode;
    expect(codes(report)).toContain(mode === 'missing-cleanup' ? 'missing-cleanup-evidence' : 'incomplete-observation');
  });
  it('accepts native absence receipts and bounded cleanup recovery, but detects contradictions', () => {
    const { report } = fixture(), e = report.observations[0].evidence;
    e.cleanup.removal = { outcome: 'absent', exitCode: 1 }; expect(codes(report)).toEqual([]);
    e.cleanup.removal = { outcome: 'timeout', exitCode: null }; e.cleanup.verification = { outcome: 'absent', exitCode: 1 }; expect(codes(report)).toEqual([]);
    e.cleanup.verification.outcome = 'present'; expect(codes(report)).toContain('contradictory-cleanup');
    e.cleanup.verification = { outcome: 'absent', exitCode: 0 }; expect(codes(report)).toContain('contradictory-cleanup');
    delete e.cleanup.verification; e.cleanup.removal = { outcome: 'removed', exitCode: 1 }; expect(codes(report)).toContain('contradictory-cleanup');
    e.cleanup.removal = { outcome: 'absent', exitCode: 0 }; expect(codes(report)).toContain('contradictory-cleanup');
  });
  it('reports reused containers, contradictory exit status, uncertain cleanup and a nonpassing claimed outcome', () => {
    const { report } = fixture(); report.observations[1].evidence.container = report.observations[0].evidence.container;
    report.observations[0].evidence.outcome = 'failed'; report.retainedWorkspace = '/private/scratch'; report.outcome = 'regression';
    expect(codes(report)).toEqual(expect.arrayContaining(['reused-container-identity', 'contradictory-command-outcome', 'retained-workspace', 'reported-regression']));
    expect(JSON.stringify(analyzeVerificationEvidence(fixture().plan, seal(report)))).not.toContain('/private/scratch');
  });
  it('preserves valid stopped runs as nonpassing evidence, including an unused reservation', () => {
    const { report } = fixture(); report.observations = report.observations.slice(0, 2); report.commandsUsed = 3; report.outcome = 'environment-failure';
    expect(codes(report)).toEqual(['incomplete-command-coverage', 'reported-environment-failure']);
    report.observations = []; report.commandsUsed = 0; report.outcome = 'input-failure'; expect(codes(report)).toContain('reported-input-failure');
  });
  it.each([
    (r: any) => { r.format = 'unknown'; }, (r: any) => { r.digest = 'f'.repeat(64); },
    (r: any) => { r.extra = true; }, (r: any) => { r.reason = 4; }, (r: any) => { r.limitations = [null]; },
    (r: any) => { r.retainedWorkspace = 3; }, (r: any) => { r.outcome = 'maybe'; },
    (r: any) => { r.outcome = ['passed']; },
    (r: any) => { r.observations[0].evidence.outcome = ['passed']; },
    (r: any) => { r.observations[0].evidence.cleanup.removal.outcome = ['removed']; },
    (r: any) => { r.commandsUsed = 0; }, (r: any) => { r.commandLimit++; },
    (r: any) => { r.observations.reverse(); }, (r: any) => { r.observations[0].matches = 'yes'; },
    (r: any) => { r.observations[0].evidence.argv = ['sh', '-c', 'oops']; },
    (r: any) => { r.observations[0].evidence.image = 'latest'; },
    (r: any) => { r.observations[0].evidence.durationMs = -1; },
    (r: any) => { r.observations[0].evidence.container = ''; },
    (r: any) => { r.observations[0].evidence.cleanup.version = 2; },
    (r: any) => { r.observations[0].evidence.cleanup.removal.outcome = 'present'; },
    (r: any) => { r.observations[0].evidence.cleanup.removal.exitCode = '0'; },
    (r: any) => { r.observations[0].evidence.outputDigests.version = 2; },
    (r: any) => { r.observations[0].evidence.outputDigests.stdout.sha256 = 'invalid'; },
    (r: any) => { r.observations[0].evidence.outputDigests.stdout.bytes = 65537; },
    (r: any) => { r.observations[0].evidence.outputDigests.stdout.extra = true; },
    (r: any) => { r.observations[0].evidence.stdout = 'private raw output'; },
  ])('refuses malformed or unsupported supplied evidence %#', mutate => {
    const { plan, report } = fixture(); mutate(report);
    expect(() => analyzeVerificationEvidence(plan, report.digest === 'f'.repeat(64) ? report : seal(report))).toThrow();
  });
  it('bounds JSON and refuses non-JSON values before interpretation', () => {
    const { plan, report } = fixture(); report.reason = 'x'.repeat(262145);
    expect(() => analyzeVerificationEvidence(plan, report)).toThrow('256 KiB');
    expect(() => analyzeVerificationEvidence(plan, { value: 1n })).toThrow('plain JSON');
  });
  it('exposes an offline CLI contract with actionable nonpassing status and no execution flags', async () => {
    root = mkdtempSync(join(tmpdir(), 'migration-evidence-cli-'));
    const { plan, report } = fixture(), planFile = join(root, 'plan.json'), reportFile = join(root, 'report.json');
    writeFileSync(planFile, JSON.stringify(plan)); writeFileSync(reportFile, JSON.stringify(report));
    const lines: string[] = [], write = (text: string) => { lines.push(text); };
    const args = ['review-evidence', '--plan', planFile, '--report', reportFile, '--json'];
    expect(await runMigrationCommand(args, { write })).toBe(0); expect(JSON.parse(lines.pop()!).status).toBe('passing-observations');
    report.observations[4].evidence.outputDigests.stdout.sha256 = 'd'.repeat(64); writeFileSync(reportFile, JSON.stringify(seal(report)));
    expect(await runMigrationCommand(args, { write })).toBe(1); expect(JSON.parse(lines.pop()!).findings).toContainEqual({ code: 'candidate-regression', observation: 4 });
    for (const extra of [['--approve', 'digest'], ['--repository', root], ['--revision', plan.source.revision], ['--path', '.']]) expect(await runMigrationCommand([...args, ...extra], { write })).toBe(1);
    expect(await runMigrationCommand(['review-evidence', '--plan', planFile], { write })).toBe(1);
    expect(await runMigrationCommand(['inventory', '--report', reportFile], { write })).toBe(1);
    expect(await runMigrationCommand(['evidence-schema'], { write })).toBe(0); expect(JSON.parse(lines.pop()!)).toEqual(EVIDENCE_REVIEW_SCHEMA);
    writeFileSync(reportFile, 'broken JSON /private/secret'); expect(await runMigrationCommand(args, { write })).toBe(1);
    expect(lines.at(-1)).not.toContain('/private/secret');
  });
});
