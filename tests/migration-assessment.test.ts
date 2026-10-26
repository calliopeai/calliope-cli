import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, digest } from '../src/approvals/index.js';
import { assessMigration, analyzeAssessmentRequest, analyzeVerificationPlan, migrationExample, runMigrationCommand, ASSESSMENT_SCHEMAS, type AssessmentRequest, type VerificationPlan, type AssessmentOptions } from '../src/migration/index.js';
import * as isolated from '../src/isolation/process.js';

let root: string, request: AssessmentRequest;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const seal = (value: any) => { const { digest: _old, ...body } = value; return { ...body, digest: digest(canonicalJson(body)) }; };
// Deliberately synthetic receipts for pure assessment tests. The packaged qualification uses real native reports.
function pilot(source = 'source.mjs', target = 'candidate.mts') {
  const revision = git('rev-parse', 'HEAD'), pin = (path: string) => ({ revision, path, object: git('rev-parse', revision + ':' + path) }), example = migrationExample();
  const plan: VerificationPlan = { format: 'calliope.migration.verification-plan/v1', adapter: example.adapter as VerificationPlan['adapter'], verifier: 'byte-parity-v1',
    runtime: { image: 'sha256:' + 'a'.repeat(64), node: process.version }, source: pin(source), candidate: pin(target), negative: pin('negative.mts'), rules: pin('RULES.md'), cases: example.cases, negativeControl: example.negativeControl, limits: example.limits };
  const analysis = analyzeVerificationPlan(plan), fingerprint = (text: string) => ({ sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) });
  const rows: [string, string | null, string[], { exitCode: number; stdout: string; stderr: string }][] = [
    ['runtime', null, ['node', '--version'], { exitCode: 0, stdout: process.version + '\n', stderr: '' }],
    ...plan.cases.map(c => ['baseline', c.id, ['node', '/project/program.mjs', c.argument], c.expected] as [string, string, string[], typeof c.expected]),
    ['negative-control', plan.negativeControl.caseId, ['node', '/project/program.mts', plan.cases.find(c => c.id === plan.negativeControl.caseId)!.argument], plan.negativeControl.expected],
    ...plan.cases.map(c => ['candidate', c.id, ['node', '/project/program.mts', c.argument], c.expected] as [string, string, string[], typeof c.expected]),
  ];
  const report = seal({ format: 'calliope.migration.verification-report/v1', verifier: plan.verifier, adapter: plan.adapter, planDigest: analysis.digest, runtime: plan.runtime,
    pins: { source: plan.source, candidate: plan.candidate, negative: plan.negative, rules: plan.rules }, outcome: 'passed', reason: 'Synthetic test observations',
    observations: rows.map(([phase, caseId, argv, b], i) => ({ phase, caseId, matches: true, evidence: { version: 1, kind: 'isolated-command', argv, image: plan.runtime.image,
      exitCode: b.exitCode, outcome: b.exitCode === 0 ? 'passed' : 'failed', truncated: false, durationMs: 1, container: 'fixture-' + i, cleanupConfirmed: true,
      cleanup: { version: 1, removal: { outcome: 'removed', exitCode: 0 } }, outputDigests: { version: 1, stdout: fingerprint(b.stdout), stderr: fingerprint(b.stderr) } } })),
    commandsUsed: analysis.commandCount, commandLimit: analysis.commandCount, retainedWorkspace: null, limitations: ['Synthetic test data.'] });
  return { source, plan, report, measurement: { evidenceId: 'fixture-ledger:' + source, reportDigest: report.digest, costMicros: 1000, workMs: 100, reviewMs: 20 } };
}
const accept: AssessmentOptions['review'] = async () => ({ decision: 'accepted', receipt: 'fixture-independent-review:1' });
const implementation = { kitSha256: digest('synthetic unit-test kit identity'), verifierSha256: digest('synthetic unit-test verifier identity') };
const run = (options: AssessmentOptions = { review: accept }) => assessMigration(root, request, { implementation, ...options });
const codes = (result: Awaited<ReturnType<typeof assessMigration>>) => result.findings.map(f => f.code);
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'migration-assessment-fixture-'));
  for (const [path, value] of Object.entries(migrationExample().files)) fs.writeFileSync(join(root, path), value);
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'assessment-fixture', scripts: { test: 'touch SCRIPT_MUST_NOT_RUN' } }));
  fs.mkdirSync(join(root, 'test')); fs.writeFileSync(join(root, 'test/original.mjs'), 'throw Error("MUST NOT EXECUTE");\n');
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('add', '.'); git('commit', '-qm', 'Assessment fixture');
  const first = pilot();
  request = { format: 'calliope.migration.assessment-request/v1', source: { revision: first.plan.source.revision, readPaths: ['.'] },
    target: { adapter: first.plan.adapter, stack: 'TypeScript CLI on pinned Node 24', runtime: first.plan.runtime },
    intent: { kind: 'port', motivation: 'Add types without changing the public CLI.', compatibility: ['Preserve output bytes and exit codes.'], deployment: ['Local CLI only; no external data migration.'], success: ['All declared public-interface cases match.'] },
    budget: { currency: 'USD', maxCostMicros: 1000000, maxDurationMs: 60000, concurrency: 2 }, rules: first.plan.rules,
    units: [{ source: 'source.mjs', target: 'candidate.mts', dependencies: [], risk: 'high', rationale: 'Pilot valid and invalid input behavior before scaling.' }],
    exclusions: [{ path: 'candidate.mts', reason: 'Already-generated pilot target.' }, { path: 'negative.mts', reason: 'Known broken verification control.' }], pilots: [first] };
  vi.spyOn(isolated, 'runIsolatedCommand').mockRejectedValue(Error('Assessment must not execute'));
  vi.spyOn(isolated, 'assertLocalIsolationImage').mockRejectedValue(Error('Assessment must not contact Docker'));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
function commit() { git('add', '.'); git('commit', '-qm', 'Fixture revision'); request.source.revision = git('rev-parse', 'HEAD'); }
function refreshPilot() { const p = pilot(); request.pilots = [p]; request.rules = p.plan.rules; }

describe('read-only migration assessment', () => {
  it('derives a pinned rulebook and planned manifest, preserves dirty files and never dispatches work', async () => {
    fs.writeFileSync(join(root, 'candidate.mts'), 'unsaved work');
    const before = JSON.stringify(request), review = vi.fn(accept!);
    const result = await run({ review });
    expect(result.recommendation).toBe('go'); expect(result.findings).toEqual([]); expect(result.execution).toBe('none');
    expect(result.estimate).toMatchObject({ units: 1, observedPilots: 1, costMicros: { low: 1000, high: 1000 }, durationMs: { low: 120, high: 120 } });
    expect(result.manifest.units).toHaveLength(1); expect(result.manifest.units[0]?.state).toBe('planned');
    expect(result.rulebook.preserve.map(f => f.path)).toEqual(['package.json', 'test/original.mjs']);
    expect(result.manifest.evidenceStorage.written).toBe(false); expect(fs.existsSync(join(root, '.calliope'))).toBe(false);
    expect(fs.existsSync(join(root, 'SCRIPT_MUST_NOT_RUN'))).toBe(false); expect(fs.readFileSync(join(root, 'candidate.mts'), 'utf8')).toBe('unsaved work');
    expect(isolated.runIsolatedCommand).not.toHaveBeenCalled(); expect(isolated.assertLocalIsolationImage).not.toHaveBeenCalled();
    expect(review.mock.calls[0]![0].repository).toBe(fs.realpathSync(root)); expect(JSON.stringify(request)).toBe(before);
    const { digest: hash, ...body } = result; expect(hash).toBe(digest(canonicalJson(body)));
    expect((await run()).digest).toBe(result.digest);
  });
  it('requires a trusted host review before giving go or extrapolating measurements', async () => {
    const result = await run({}); expect(result.recommendation).toBe('investigate'); expect(result.estimate.costMicros).toBeNull();
    expect(codes(result)).toContain('evidence-and-coverage-review-required');
    expect(codes(await run({ review: async () => ({ decision: 'rejected', receipt: 'review:rejected' }) }))).toContain('evidence-and-coverage-review-rejected');
    expect(codes(await run({ review: async () => ({ decision: 'accepted', receipt: '/unsafe/receipt' }) }))).toContain('invalid-host-review');
    expect(codes(await run({ review: async () => { throw Error('private details'); } }))).toContain('host-review-unavailable');
    await expect(run({ review: 'accepted' as any })).rejects.toThrow('host callback');
  });
  it('isolates host review inputs and binds aliases to the canonical root', async () => {
    const alias = join(root, 'alias'); fs.symlinkSync(root, alias);
    const result = await assessMigration(alias, request, { implementation, review: async input => {
      expect(input.repository).toBe(fs.realpathSync(root)); fs.unlinkSync(alias); fs.symlinkSync('/missing', alias);
      input.request.units.length = 0; input.findings.push({ code: 'injected', source: null, severity: 'do-not-migrate' });
      return { decision: 'accepted', receipt: 'review:isolated' };
    } });
    expect(result.recommendation).toBe('go'); expect(result.manifest.units).toHaveLength(1); expect(codes(result)).not.toContain('injected');
  });
  it.each(['redesign', 'incremental-upgrade'] as const)('keeps %s separate from a verified structure-preserving port', async kind => {
    request.intent.kind = kind; const result = await run(); expect(result.recommendation).toBe('investigate'); expect(codes(result)).toContain('separate-' + kind + '-plan-required'); expect(result.estimate.costMicros).toBeNull();
  });
  it.each(['adapter', 'runtime', 'unit'] as const)('does not recommend using an unsupported %s even when the host accepts the supplied evidence', async kind => {
    if (kind === 'adapter') request.target.adapter = 'python-to-ruby/v1';
    else if (kind === 'runtime') request.target.runtime = { image: 'latest', node: 'v22.0.0' };
    else request.units[0]!.target = 'candidate.py';
    const result = await run(); expect(result.recommendation).toBe('do-not-migrate'); expect(codes(result)).toContain('unsupported-' + kind);
  });
  it('accounts for all selected sources and explicit exclusions', async () => {
    request.exclusions = []; let result = await run(); expect(codes(result)).toContain('unplanned-source');
    request.exclusions = [{ path: 'missing.mjs', reason: 'Does not exist.' }]; result = await run(); expect(codes(result)).toContain('exclusion-outside-inventory');
    request.units[0]!.source = 'missing.mjs'; request.exclusions = []; request.pilots = []; result = await run(); expect(codes(result)).toContain('unit-source-unavailable');
  });
  it('requires representative hard pilots, baseline evidence and measured review overhead', async () => {
    request.pilots = []; let result = await run(); expect(codes(result)).toEqual(expect.arrayContaining(['representative-pilot-required', 'missing-baseline-and-verifier-evidence']));
    const p = pilot(); request.pilots = [{ ...p, measurement: null }]; result = await run(); expect(codes(result)).toContain('missing-pilot-measurement');
    request.pilots = [{ ...p, measurement: { ...p.measurement, reportDigest: 'd'.repeat(64) } }]; result = await run(); expect(codes(result)).toContain('stale-pilot-measurement');
  });
  it('binds exact host-supplied kit and verifier artifacts and refuses unbound or malformed implementation claims', async () => {
    const first = await run();
    expect(codes(await run({ review: accept, implementation: undefined }))).toContain('implementation-binding-required');
    const changed = await run({ review: accept, implementation: { ...implementation, kitSha256: 'c'.repeat(64) } });
    expect(changed.review.digest).not.toBe(first.review.digest); expect(changed.manifest.units[0]!.bindingDigest).not.toBe(first.manifest.units[0]!.bindingDigest);
    await expect(run({ implementation: { kitSha256: 'latest', verifierSha256: 'd'.repeat(64) } })).rejects.toThrow('SHA-256');
    expect(() => analyzeAssessmentRequest({ ...request, implementation })).toThrow('fields');
  });
  it('refuses rewritten passed labels and broken or differently bound pilot evidence', async () => {
    const p = request.pilots[0]!; const report = p.report as any;
    report.observations.at(-1).evidence.outputDigests.stderr.sha256 = 'c'.repeat(64); p.report = seal(report); p.measurement!.reportDigest = (p.report as any).digest;
    expect(codes(await run())).toContain('nonpassing-pilot');
    p.report = { outcome: 'passed' }; expect(codes(await run())).toContain('invalid-pilot-evidence');
  });
  it('reads actual pinned blobs rather than accepting a self-consistent fabricated pin', async () => {
    const p = request.pilots[0]!, plan = p.plan as VerificationPlan, report = p.report as any;
    plan.candidate.object = 'e'.repeat(40); report.pins.candidate = plan.candidate; report.planDigest = analyzeVerificationPlan(plan).digest;
    p.report = seal(report); p.measurement!.reportDigest = (p.report as any).digest;
    const result = await run(); expect(codes(result)).toContain('stale-or-unsupported-evidence-pin'); expect(result.recommendation).toBe('investigate');
  });
  it('invalidates stale pilot evidence and manifest bindings after the selected source changes', async () => {
    const original = await run(); fs.appendFileSync(join(root, 'source.mjs'), '// changed revision\n'); commit();
    const changed = await run(); expect(codes(changed)).toContain('stale-pilot-binding'); expect(changed.recommendation).toBe('investigate');
    expect(changed.manifest.units[0]!.id).toBe(original.manifest.units[0]!.id); expect(changed.manifest.units[0]!.bindingDigest).not.toBe(original.manifest.units[0]!.bindingDigest);
  });
  it('does not read rule or pilot paths outside the declared scope', async () => {
    request.source.readPaths = ['source.mjs']; const result = await run(); expect(codes(result)).toContain('evidence-pin-outside-read-scope'); expect(result.estimate.costMicros).toBeNull();
    request.source.readPaths = ['.']; request.rules.revision = 'f'.repeat(40); expect(codes(await run())).toContain('evidence-revision-unavailable');
  });
  it('surfaces unit cycles and declared package cycles without creating a scheduler', async () => {
    request.units[0]!.dependencies = ['source.mjs']; const result = await run(); expect(codes(result)).toContain('unit-dependency-cycle'); expect(result.manifest.graph.order).toBeNull();
    for (const [name, dependency] of [['a', 'b'], ['b', 'a']]) {
      fs.mkdirSync(join(root, name!)); fs.writeFileSync(join(root, name!, 'package.json'), JSON.stringify({ name, dependencies: { [dependency!]: 'workspace:*' } }));
    }
    commit(); refreshPilot(); expect(codes(await run())).toContain('declared-package-cycle');
  });
  it('surfaces external dependencies and omitted package ordering', async () => {
    for (const name of ['a', 'b']) {
      fs.mkdirSync(join(root, name)); fs.writeFileSync(join(root, name, 'package.json'), JSON.stringify({ name, dependencies: name === 'a' ? { b: 'workspace:*', external: '^1.0.0' } : {} }));
      fs.writeFileSync(join(root, name, 'source.mjs'), 'process.stdout.write("test");');
    }
    commit(); request.units = ['a', 'b'].map(name => ({ source: name + '/source.mjs', target: name + '/target.mts', dependencies: [], risk: 'low', rationale: 'Declared independent unit.' })); request.pilots = [];
    const result = await run(); expect(codes(result)).toEqual(expect.arrayContaining(['external-dependency-needs-evidence', 'missing-declared-package-order']));
  });
  it('derives estimates from exactly the manifest unit count, dependency depth, concurrency and reviewed pilot measurements', async () => {
    fs.copyFileSync(join(root, 'source.mjs'), join(root, 'second.mjs')); fs.copyFileSync(join(root, 'candidate.mts'), join(root, 'second.mts')); commit(); refreshPilot();
    request.units.push({ source: 'second.mjs', target: 'second.mts', dependencies: ['source.mjs'], risk: 'high', rationale: 'Dependent hard unit.' }); request.exclusions.push({ path: 'second.mts', reason: 'Pilot target.' });
    const p = pilot('second.mjs', 'second.mts'); p.measurement = { ...p.measurement, costMicros: 3000, workMs: 300, reviewMs: 50 }; request.pilots.push(p);
    let result = await run(); expect(result.recommendation).toBe('go'); expect(result.estimate.units).toBe(result.manifest.units.length);
    expect(result.estimate).toMatchObject({ units: 2, costMicros: { low: 2000, high: 6000 }, durationMs: { low: 240, high: 700 } });
    request.units[1]!.dependencies = []; result = await run(); expect(result.estimate.durationMs!.low).toBe(140);
    request.budget.maxCostMicros = 4000; expect((await run()).recommendation).toBe('investigate');
    request.budget.maxCostMicros = 1000; expect((await run()).recommendation).toBe('do-not-migrate');
    request.budget.maxCostMicros = 100000; request.budget.maxDurationMs = 100; expect((await run()).recommendation).toBe('do-not-migrate');
  });
  it('shows representative risk-group coverage without treating unpiloted units as verified', async () => {
    fs.copyFileSync(join(root, 'source.mjs'), join(root, 'second.mjs')); commit(); refreshPilot();
    request.units.push({ source: 'second.mjs', target: 'second.mts', dependencies: [], risk: 'high', rationale: 'Same public interface; reviewed as represented by the first pilot.' });
    const result = await run(); expect(result.recommendation).toBe('go');
    expect(result.manifest.pilotGroups).toEqual([{ risk: 'high', units: 2, passingPilots: [result.manifest.units[0]!.id] }]);
    expect(result.manifest.units[1]).toMatchObject({ state: 'planned', pilot: null }); expect(result.estimate).toMatchObject({ units: 2, observedPilots: 1 });
  });
  it('honors cancellation, including a host review that never answers', async () => {
    const controller = new AbortController(); controller.abort(); await expect(run({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const later = new AbortController();
    await expect(run({ signal: later.signal, review: () => { setTimeout(() => later.abort(), 10); return new Promise(() => {}); } })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(assessMigration('/missing', request)).rejects.toThrow('repository is unavailable');
  });
  it.each([
    (r: any) => { r.extra = true; }, (r: any) => { r.format = 'unknown'; }, (r: any) => { r.source.revision = 'HEAD'; },
    (r: any) => { r.source.readPaths = ['../private']; }, (r: any) => { r.source.readPaths = ['.', '.']; },
    (r: any) => { r.intent.kind = ['port']; }, (r: any) => { r.intent.success = []; }, (r: any) => { r.intent.motivation = ''; },
    (r: any) => { r.budget.currency = 'EUR'; }, (r: any) => { r.budget.maxCostMicros = -1; }, (r: any) => { r.budget.concurrency = 33; },
    (r: any) => { r.units = []; }, (r: any) => { r.units.push(r.units[0]); }, (r: any) => { r.units[0].target = 'source.mjs'; },
    (r: any) => { r.units[0].dependencies = ['missing.mjs']; }, (r: any) => { r.units[0].dependencies = ['source.mjs', 'source.mjs']; },
    (r: any) => { r.units[0].risk = 'unknown'; }, (r: any) => { r.units[0].source = '.'; },
    (r: any) => { r.exclusions.push({ path: 'source.mjs', reason: 'Contradiction' }); },
    (r: any) => { r.pilots.push(r.pilots[0]); }, (r: any) => { r.pilots[0].measurement.workMs = 0; },
    (r: any) => { r.pilots[0].measurement.reportDigest = 'bad'; }, (r: any) => { r.rules.object = 'missing'; },
  ])('rejects ambiguous or invalid planning inputs %#', mutate => { mutate(request); expect(() => analyzeAssessmentRequest(request)).toThrow(); });
  it('bounds request size and accepts only JSON values', () => {
    expect(() => analyzeAssessmentRequest({ value: 1n })).toThrow('plain JSON');
    expect(() => analyzeAssessmentRequest({ value: 'x'.repeat(2097153) })).toThrow('2 MiB');
  });
  it('offers the read-only CLI and schemas without accepting review or execution authority from flags', async () => {
    const file = join(root, 'request.json'); fs.writeFileSync(file, JSON.stringify(request)); const lines: string[] = [], write = (text: string) => { lines.push(text); };
    expect(await runMigrationCommand(['assessment-schema'], { write })).toBe(0); expect(JSON.parse(lines.pop()!)).toEqual(ASSESSMENT_SCHEMAS);
    expect(await runMigrationCommand(['review-assessment', '--request', file], { write })).toBe(0); expect(JSON.parse(lines.pop()!).digest).toBe(analyzeAssessmentRequest(request).digest);
    const args = ['assess', '--request', file, '--repository', root, '--json']; expect(await runMigrationCommand(args, { write })).toBe(0);
    const report = JSON.parse(lines.pop()!); expect(report.recommendation).toBe('investigate'); expect(report.execution).toBe('none');
    expect(await runMigrationCommand([...args, '--approve', report.review.digest], { write })).toBe(1);
    expect(await runMigrationCommand(['inventory', '--request', file], { write })).toBe(1);
    expect(await runMigrationCommand(['review-assessment', '--request', file, '--repository', root], { write })).toBe(1);
  });
});
