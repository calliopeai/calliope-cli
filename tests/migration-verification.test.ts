import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { analyzeBaselinePlan, verifyMigrationBaseline, analyzeBaselineEvidence, BASELINE_SCHEMAS, type BaselinePlan, analyzeVerificationEvidence, analyzeVerificationPlan, verifyMigration, migrationExample, comparatorHealthy, behaviorFingerprint, compareBehavior, runMigrationCommand, VERIFICATION_SCHEMAS, type VerificationPlan } from '../src/migration/index.js';
import { digest, canonicalJson } from '../src/approvals/index.js';
import { runIsolatedCommand, assertLocalIsolationImage } from '../src/isolation/process.js';
const faults = vi.hoisted(() => ({ mode: '', calls: 0 }));
// Fault-injection host executes only this test's authored fixture. It is not
// evidence of container isolation; the packaged smoke separately uses Docker.
vi.mock('../src/isolation/process.js', async () => {
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const fingerprint = (value: Buffer) => ({ sha256: createHash('sha256').update(value).digest('hex'), bytes: value.length });
  return {
    assertLocalIsolationImage: vi.fn(async () => { if (faults.mode === 'image') throw Error('Missing image'); }),
    runIsolatedCommand: vi.fn(async (image, command, mounts) => {
      faults.calls++;
      if (faults.mode === 'throw') throw Error('Lost executor result');
      const args = command.argv.slice(1).map((arg: string) => arg.replace(/^\/project\//, mounts[0].source + '/'));
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), exitCode = 0;
      try { stdout = execFileSync(process.execPath, args, { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH }, timeout: 2000 }); }
      catch (error) { const e = error as { status: number; stdout: Buffer; stderr: Buffer }; exitCode = e.status; stdout = e.stdout; stderr = e.stderr; }
      return { version: 1, kind: 'isolated-command', image, argv: command.argv, container: 'calliope-check-fixture-' + faults.calls, cleanupConfirmed: faults.mode !== 'cleanup',
        cleanup: { version: 1, removal: { outcome: faults.mode === 'cleanup' ? 'error' : 'removed', exitCode: faults.mode === 'cleanup' ? 1 : 0 } },
        outcome: faults.mode === 'timeout' ? 'timeout' : exitCode === 0 ? 'passed' : 'failed', exitCode, stdout: stdout.toString(), stderr: stderr.toString(), truncated: faults.mode === 'truncated', durationMs: 1,
        ...(faults.mode === 'old-receipt' ? {} : { outputDigests: { version: 1, stdout: fingerprint(stdout), stderr: fingerprint(stderr) } }) };
    }),
  };
});
let root: string, plan: VerificationPlan;
const retained: string[] = [];
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
beforeEach(() => {
  faults.mode = ''; faults.calls = 0; vi.clearAllMocks();
  root = fs.mkdtempSync(join(tmpdir(), 'migration-verifier-fixture-'));
  const example = migrationExample();
  for (const [name, text] of Object.entries(example.files)) fs.writeFileSync(join(root, name), text);
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('add', '.'); git('commit', '-qm', 'Fixture');
  const revision = git('rev-parse', 'HEAD'), pin = (path: string) => ({ revision, path, object: git('rev-parse', revision + ':' + path) });
  plan = { format: 'calliope.migration.verification-plan/v1', adapter: 'javascript-to-typescript-cli/v1', verifier: 'byte-parity-v1',
    runtime: { image: 'sha256:' + 'a'.repeat(64), node: process.version }, source: pin('source.mjs'), candidate: pin('candidate.mts'), negative: pin('negative.mts'), rules: pin('RULES.md'),
    cases: example.cases, negativeControl: example.negativeControl, limits: example.limits };
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); for (const dir of retained.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function run(options = {}) {
  const result = await verifyMigration(root, plan, { approve: async () => true, ...options });
  if (result.retainedWorkspace) retained.push(result.retainedWorkspace);
  return result;
}
describe('native migration behavior verification', () => {
  it('compares real fixture programs, validates the negative control, preserves dirty source and binds evidence', async () => {
    fs.writeFileSync(join(root, 'candidate.mts'), 'dirty work that must not execute');
    const value = await run(); expect(value.outcome).toBe('passed'); expect(value.commandsUsed).toBe(12); expect(value.retainedWorkspace).toBeNull();
    expect(value.observations.filter(o => o.phase === 'candidate').every(o => o.matches)).toBe(true);
    expect(value.observations.find(o => o.phase === 'negative-control')?.matches).toBe(true);
    expect(value.observations[0]?.evidence).not.toHaveProperty('stdout');
    expect(fs.readFileSync(join(root, 'candidate.mts'), 'utf8')).toBe('dirty work that must not execute');
    expect(value.planDigest).toBe(analyzeVerificationPlan(plan).digest);
    expect(analyzeVerificationEvidence(plan, value).status).toBe('passing-observations');
    const { digest: hash, ...body } = value; expect(hash).toBe(digest(canonicalJson(body)));
    const mount = vi.mocked(runIsolatedCommand).mock.calls[0]![2][0]!.source; expect(fs.existsSync(mount)).toBe(false);
  });
  it('detects a regression in a target that still exits successfully', async () => {
    plan.candidate = plan.negative; const value = await run(); expect(value.outcome).toBe('regression');
    expect(value.observations.filter(o => o.phase === 'candidate' && o.matches === false).map(o => o.caseId)).toEqual(['positive', 'negative-values']);
    const original = value.observations.find(o => o.phase === 'baseline' && o.caseId === 'positive')!.evidence.outputDigests!.stdout;
    const broken = value.observations.find(o => o.phase === 'candidate' && o.caseId === 'positive')!.evidence.outputDigests!.stdout;
    expect(original.bytes).toBe(broken.bytes); expect(original.sha256).not.toBe(broken.sha256);
  });
  it('does not execute a candidate when the original fails the contract', async () => {
    plan.cases[0]!.expected.stdout = 'wrong baseline'; const value = await run(); expect(value.outcome).toBe('baseline-failure'); expect(value.commandsUsed).toBe(2);
  });
  it('rejects an ineffective negative control and a broken comparator', async () => {
    expect(comparatorHealthy()).toBe(true); expect(comparatorHealthy(() => true)).toBe(false); expect(comparatorHealthy(() => false)).toBe(false);
    expect(comparatorHealthy((a, b) => a.stdout.sha256 === b.stdout.sha256)).toBe(false);
    expect(comparatorHealthy((a, b) => a === b)).toBe(false);
    expect(comparatorHealthy(() => { throw Error('Broken comparator'); })).toBe(false);
    expect(comparatorHealthy((a, b) => a.exitCode === b.exitCode && a.stdout.bytes === b.stdout.bytes && a.stderr.bytes === b.stderr.bytes)).toBe(false);
    plan.negative = plan.candidate; const value = await run(); expect(value.outcome).toBe('verifier-failure'); expect(value.observations.some(o => o.phase === 'candidate')).toBe(false);
  });
  it.each(['image', 'cleanup', 'timeout', 'truncated', 'old-receipt', 'throw'])('preserves %s as environment failure, retaining unconfirmed cleanup', async mode => {
    faults.mode = mode; const value = await run(); expect(value.outcome).toBe('environment-failure');
    expect(value.retainedWorkspace !== null).toBe(['cleanup', 'throw'].includes(mode));
  });
  it('requires exact host approval and honors command reservations and inherited deadlines', async () => {
    await expect(run({ approve: async () => false })).rejects.toThrow('not approved'); expect(runIsolatedCommand).not.toHaveBeenCalled();
    await expect(run({ deadline: Date.now() - 1 })).rejects.toThrow('expired');
    const reserveCommand = vi.fn(async () => false); const value = await run({ reserveCommand });
    expect(value.outcome).toBe('environment-failure'); expect(runIsolatedCommand).not.toHaveBeenCalled(); expect(reserveCommand).toHaveBeenCalledOnce();
  });
  it('binds host approval and subsequent reads to the canonical repository, not a movable alias', async () => {
    const alias = join(root, 'alias'); fs.symlinkSync(root, alias);
    const result = await verifyMigration(alias, plan, { approve: async request => {
      expect(request.repository).toBe(fs.realpathSync(root)); fs.unlinkSync(alias); fs.symlinkSync('/missing', alias); return true;
    } });
    expect(result.outcome).toBe('passed');
    await expect(verifyMigration('/missing', plan, { approve: async () => true })).rejects.toThrow('repository is unavailable');
  });
  it('keeps cancellation separate from successful work and rechecks after host reservation', async () => {
    const controller = new AbortController();
    const value = await run({ signal: controller.signal, reserveCommand: async () => { controller.abort(); return true; } });
    expect(value.outcome).toBe('cancelled'); expect(runIsolatedCommand).not.toHaveBeenCalled();
    await expect(run({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it.each(['source', 'rules'] as const)('refuses stale %s pins before execution', async role => {
    plan[role].object = 'b'.repeat(40); expect((await run()).outcome).toBe('input-failure'); expect(runIsolatedCommand).not.toHaveBeenCalled(); expect(assertLocalIsolationImage).not.toHaveBeenCalled();
  });
  it('refuses a runtime mismatch before baseline execution', async () => { plan.runtime.node = 'v24.999.0'; expect((await run()).outcome).toBe('environment-failure'); expect(faults.calls).toBe(1); });
  it.each(['oversized', 'invalid-utf8', 'symlink'])('refuses %s source without executing or traversing it', async kind => {
    const file = join(root, 'candidate.mts');
    if (kind === 'symlink') { fs.unlinkSync(file); fs.symlinkSync('/outside/private', file); }
    else fs.writeFileSync(file, kind === 'oversized' ? 'x'.repeat(65537) : Buffer.from([255, 254]));
    git('add', '.'); git('commit', '-qm', 'Unsupported source');
    plan.candidate.revision = git('rev-parse', 'HEAD'); plan.candidate.object = git('rev-parse', 'HEAD:candidate.mts');
    expect((await run()).outcome).toBe('input-failure'); expect(runIsolatedCommand).not.toHaveBeenCalled();
  });
  it('bounds a host reservation that never answers', async () => {
    const value = await run({ deadline: Date.now() + 1000, reserveCommand: () => new Promise<boolean>(() => {}) });
    expect(value.outcome).toBe('environment-failure'); expect(value.reason).toContain('deadline'); expect(runIsolatedCommand).not.toHaveBeenCalled();
  });
  it('checks the actual clock after a reservation instead of relying only on timer delivery', async () => {
    const deadline = Date.now() + 60000;
    try {
      const value = await run({ deadline, reserveCommand: async () => { vi.spyOn(Date, 'now').mockReturnValue(deadline + 1); return true; } });
      expect(value.outcome).toBe('environment-failure'); expect(runIsolatedCommand).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  it.each([
    (p: any) => { p.adapter = 'unsupported'; }, (p: any) => { p.source.revision = 'HEAD'; },
    (p: any) => { p.source.path = '../secret.mjs'; }, (p: any) => { p.candidate.path = 'candidate.js'; },
    (p: any) => { p.cases = []; }, (p: any) => { p.cases.push(p.cases[0]); },
    (p: any) => { p.cases[0].argument = 'line\nbreak'; }, (p: any) => { p.cases[0].expected.exitCode = 125; },
    (p: any) => { p.negativeControl.caseId = 'missing'; }, (p: any) => { p.negativeControl.expected = p.cases[0].expected; },
    (p: any) => { p.limits.totalMs = 300001; }, (p: any) => { p.extra = true; },
  ])('rejects unsupported or malformed plans without execution %#', async mutate => { mutate(plan); await expect(run()).rejects.toThrow(); expect(runIsolatedCommand).not.toHaveBeenCalled(); });
  it('compares stderr, byte lengths and exit status, not only visible text', () => {
    const a = behaviorFingerprint({ exitCode: 0, stdout: '\u001b[31mraw', stderr: '' });
    expect(compareBehavior(a, behaviorFingerprint({ exitCode: 0, stdout: 'raw', stderr: '' }))).toBe(false);
  });
  it('offers packaged schemas, examples, review hashes and approval-bound CLI execution', async () => {
    const lines: string[] = [], write = (text: string) => { lines.push(text); };
    expect(await runMigrationCommand(['verification-schema'], { write })).toBe(0); expect(JSON.parse(lines.pop()!)).toEqual(VERIFICATION_SCHEMAS);
    expect(await runMigrationCommand(['example'], { write })).toBe(0); expect(JSON.parse(lines.pop()!)).toEqual(migrationExample());
    const file = join(root, 'plan.json'); fs.writeFileSync(file, JSON.stringify(plan));
    expect(await runMigrationCommand(['review-verification', '--plan', file, '--json'], { write })).toBe(0);
    const hash = JSON.parse(lines.pop()!).digest;
    const args = ['verify', '--plan', file, '--repository', root, '--approve'];
    expect(await runMigrationCommand([...args, 'incorrect', '--json'], { write })).toBe(1); expect(runIsolatedCommand).not.toHaveBeenCalled();
    expect(await runMigrationCommand([...args, hash, '--json'], { write })).toBe(0); expect(JSON.parse(lines.pop()!).outcome).toBe('passed');
    expect(await runMigrationCommand(['review-verification', '--plan', file, '--approve', hash], { write })).toBe(1);
    expect(await runMigrationCommand(['inventory', '--plan', file], { write })).toBe(1);
  });
});


describe('baseline before candidate implementation', () => {
  const baselinePlan = (): BaselinePlan => {
    const { candidate: _candidate, ...base } = plan;
    return { ...base, format: 'calliope.migration.baseline-plan/v1' };
  };
  const baseline = async (input = baselinePlan(), options = {}) => {
    const result = await verifyMigrationBaseline(root, input, { approve: async () => true, ...options });
    if (result.retainedWorkspace) retained.push(result.retainedWorkspace);
    return result;
  };
  const rehash = (report: any) => {
    const { digest: _digest, ...body } = report;
    return { ...body, digest: digest(canonicalJson(body)) };
  };
  it('establishes original behavior without a candidate in the selected commit or approval', async () => {
    git('rm', 'candidate.mts'); git('commit', '-qm', 'Original and negative control only');
    const input = baselinePlan();
    for (const role of ['source', 'negative', 'rules'] as const) input[role].revision = git('rev-parse', 'HEAD');
    fs.writeFileSync(join(root, 'candidate.mts'), 'untracked candidate must remain untouched');
    const approve = vi.fn(async () => true), reserveCommand = vi.fn(async () => true);
    const value = await baseline(input, { approve, reserveCommand });
    expect(value.format).toBe('calliope.migration.baseline-report/v1');
    expect(value.outcome).toBe('baseline-verified'); expect(value.commandsUsed).toBe(input.cases.length + 2);
    expect(value.pins).not.toHaveProperty('candidate'); expect(value.observations.some(o => o.phase === 'candidate')).toBe(false);
    expect(approve.mock.calls[0]![0]).toEqual(expect.objectContaining({ pins: [input.source, input.negative, input.rules], commandCount: input.cases.length + 2, digest: analyzeBaselinePlan(input).digest }));
    expect(reserveCommand).toHaveBeenCalledTimes(input.cases.length + 2);
    expect(fs.readFileSync(join(root, 'candidate.mts'), 'utf8')).toBe('untracked candidate must remain untouched');
    expect(analyzeBaselineEvidence(input, value).status).toBe('baseline-observations');
    expect(() => analyzeVerificationEvidence(plan, value)).toThrow();
    expect(() => analyzeBaselineEvidence(input, { ...value, format: 'calliope.migration.verification-report/v1' })).toThrow();
  });
  it('keeps full verification, baseline plans and approval digests distinct', async () => {
    const input = baselinePlan();
    expect(analyzeBaselinePlan(input).digest).not.toBe(analyzeVerificationPlan(plan).digest);
    expect(() => analyzeVerificationPlan(input)).toThrow(); expect(() => analyzeBaselinePlan(plan)).toThrow();
    expect(() => analyzeBaselinePlan({ ...input, candidate: plan.candidate })).toThrow();
    await expect(baseline(input, { approve: async (request: { digest: string }) => request.digest === analyzeVerificationPlan(plan).digest })).rejects.toThrow('not approved');
    expect(runIsolatedCommand).not.toHaveBeenCalled();
  });
  it('does not treat a missing original baseline or accepted known regression as verified', async () => {
    const input = baselinePlan(); input.cases[0]!.expected.stdout = 'wrong original';
    const failed = await baseline(input); expect(failed.outcome).toBe('baseline-failure');
    expect(analyzeBaselineEvidence(input, failed).status).toBe('not-passing');
    input.cases[0]!.expected.stdout = migrationExample().cases[0]!.expected.stdout;
    input.negative = plan.candidate;
    const broken = await baseline(input); expect(broken.outcome).toBe('verifier-failure');
    expect(analyzeBaselineEvidence(input, broken).status).toBe('not-passing');
  });
  it.each(['source', 'negative', 'rules'] as const)('rejects a stale %s pin before any observation', async role => {
    const input = baselinePlan(); input[role].object = 'b'.repeat(40);
    expect((await baseline(input)).outcome).toBe('input-failure'); expect(runIsolatedCommand).not.toHaveBeenCalled();
  });
  it.each(['cleanup', 'timeout', 'truncated', 'old-receipt', 'throw'])('preserves %s as failed baseline evidence', async mode => {
    faults.mode = mode; const input = baselinePlan(), value = await baseline(input);
    expect(value.outcome).toBe('environment-failure'); expect(analyzeBaselineEvidence(input, value).status).toBe('not-passing');
    expect(value.retainedWorkspace !== null).toBe(['cleanup', 'throw'].includes(mode));
  });
  it('preserves inherited command allowance, deadline and cancellation', async () => {
    const input = baselinePlan();
    await expect(baseline(input, { deadline: Date.now() - 1 })).rejects.toThrow('expired');
    const refused = await baseline(input, { reserveCommand: async () => false });
    expect(refused.outcome).toBe('environment-failure'); expect(runIsolatedCommand).not.toHaveBeenCalled();
    const controller = new AbortController();
    const cancelled = await baseline(input, { signal: controller.signal, reserveCommand: async () => { controller.abort(); return true; } });
    expect(cancelled.outcome).toBe('cancelled'); expect(runIsolatedCommand).not.toHaveBeenCalled();
    expect(analyzeBaselineEvidence(input, cancelled).status).toBe('not-passing');
  });
  it('recomputes baseline evidence and rejects forged promotion or stale rules', async () => {
    const input = baselinePlan(), value = await baseline(input);
    const changed = structuredClone(value); changed.observations[1]!.evidence.outputDigests!.stdout.sha256 = 'f'.repeat(64);
    expect(analyzeBaselineEvidence(input, rehash(changed)).status).toBe('not-passing');
    expect(() => analyzeBaselineEvidence(input, rehash({ ...value, outcome: 'passed' }))).toThrow();
    const stale = structuredClone(input); stale.rules.object = 'b'.repeat(40);
    expect(() => analyzeBaselineEvidence(stale, value)).toThrow('different source');
    const missing = rehash({ ...value, observations: value.observations.slice(0, -1) });
    expect(analyzeBaselineEvidence(input, missing).status).toBe('not-passing');
  });
  it('exposes distinct baseline schema, review, execution and evidence commands', async () => {
    const lines: string[] = [], write = (text: string) => { lines.push(text); };
    const input = baselinePlan(), file = join(root, 'baseline.json'), report = join(root, 'baseline-report.json');
    fs.writeFileSync(file, JSON.stringify(input));
    expect(await runMigrationCommand(['baseline-schema', '--json'], { write })).toBe(0); expect(JSON.parse(lines.pop()!)).toEqual(BASELINE_SCHEMAS);
    expect(BASELINE_SCHEMAS.plan.required).not.toContain('candidate'); expect(BASELINE_SCHEMAS.plan.additionalProperties).toBe(false);
    expect(await runMigrationCommand(['review-baseline', '--plan', file, '--json'], { write })).toBe(0);
    const review = JSON.parse(lines.pop()!); expect(review.digest).toBe(analyzeBaselinePlan(input).digest);
    expect(await runMigrationCommand(['verify-baseline', '--repository', root, '--plan', file, '--approve', analyzeVerificationPlan(plan).digest, '--json'], { write })).toBe(1);
    expect(runIsolatedCommand).not.toHaveBeenCalled();
    expect(await runMigrationCommand(['verify-baseline', '--repository', root, '--plan', file, '--approve', review.digest, '--json'], { write })).toBe(0);
    const value = JSON.parse(lines.pop()!); expect(value.outcome).toBe('baseline-verified'); fs.writeFileSync(report, JSON.stringify(value));
    expect(await runMigrationCommand(['review-baseline-evidence', '--plan', file, '--report', report, '--json'], { write })).toBe(0);
    expect(JSON.parse(lines.pop()!).status).toBe('baseline-observations');
    expect(await runMigrationCommand(['review-evidence', '--plan', file, '--report', report, '--json'], { write })).toBe(1);
  });
});
