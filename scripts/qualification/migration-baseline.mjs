// Real packaged CLI and local isolated commands. Retain evidence for caller-managed archival/cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: Object.fromEntries(['package', 'root', 'image', 'runtime-version'].map(k => [k, { type: 'string' }])) });
assert.ok(Object.values(values).length === 4 && values.package && values.root);
assert.match(values.image, /^sha256:[a-f0-9]{64}$/);
assert.match(values['runtime-version'], /^v24\.\d+\.\d+$/);
const root = fs.realpathSync(values.root), pkg = fs.realpathSync(values.package);
assert.deepEqual(fs.readdirSync(root), [], 'Use an empty owned disposable root');
const repository = path.join(root, 'repository'), home = path.join(root, 'private-home'), tmp = path.join(root, 'tmp');
for (const p of [repository, home, tmp]) fs.mkdirSync(p, { mode: 0o700 });
fs.writeFileSync(path.join(root, 'qualification-marker'), 'calliope-migration-baseline');
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmp,
  XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const cli = (...args) => {
  const r = spawnSync(process.execPath, [path.join(pkg, 'dist/bin.js'), 'migration', ...args, '--json'], { cwd: repository, env, encoding: 'utf8', timeout: 180000, maxBuffer: 1048576 });
  assert.ok(r.status === 0 || r.status === 1, r.error?.message || r.stderr);
  return { exit: r.status, value: JSON.parse(r.stdout) };
};
const save = (name, value) => { const p = path.join(root, name); fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n'); return p; };
const example = cli('example').value, capabilities = cli('capabilities').value;
assert.ok(capabilities.phases.includes('verify-baseline') && capabilities.phases.includes('review-baseline-evidence'));
for (const [name, text] of Object.entries(example.files)) if (name !== 'candidate.mts') fs.writeFileSync(path.join(repository, name), text);
git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('add', '.'); git('commit', '-qm', 'Original baseline and known regression');
const revision = git('rev-parse', 'HEAD'), pin = name => ({ revision, path: name, object: git('rev-parse', revision + ':' + name) });
const plan = { format: 'calliope.migration.baseline-plan/v1', adapter: 'javascript-to-typescript-cli/v1', verifier: 'byte-parity-v1',
  runtime: { image: values.image, node: values['runtime-version'] }, source: pin('source.mjs'), negative: pin('negative.mts'), rules: pin('RULES.md'),
  cases: example.cases, negativeControl: example.negativeControl, limits: example.limits };
const checks = [], reports = [];
function runBaseline(name, input, outcome) {
  const file = save(name + '-plan.json', input), review = cli('review-baseline', '--plan', file);
  assert.equal(review.exit, 0);
  const result = cli('verify-baseline', '--repository', repository, '--plan', file, '--approve', review.value.digest);
  assert.equal(result.value.outcome, outcome); assert.equal(result.exit, outcome === 'baseline-verified' ? 0 : 1);
  assert.ok(!result.value.pins.candidate && !result.value.observations.some(r => r.phase === 'candidate'));
  const report = save(name + '-report.json', result.value), evidence = cli('review-baseline-evidence', '--plan', file, '--report', report);
  assert.equal(evidence.value.status, outcome === 'baseline-verified' ? 'baseline-observations' : 'not-passing');
  reports.push(result.value); checks.push({ name, outcome, commands: result.value.commandsUsed, digest: result.value.digest });
  return { file, report, value: result.value };
}
assert.ok(!fs.existsSync(path.join(repository, 'candidate.mts')));
const positive = runBaseline('original', plan, 'baseline-verified');
assert.ok(!fs.existsSync(path.join(repository, 'candidate.mts')));
const unsupported = structuredClone(plan); unsupported.adapter = 'unsupported-language/v1';
const unsupportedFile = save('unsupported-adapter-plan.json', unsupported);
const unsupportedResult = cli('verify-baseline', '--repository', repository, '--plan', unsupportedFile, '--approve', 'a'.repeat(64));
assert.equal(unsupportedResult.exit, 1); assert.equal(unsupportedResult.value.error.code, 'invalid');
checks.push({ name: 'unsupported-adapter', outcome: 'invalid' });
const broken = structuredClone(plan); broken.cases[0].expected.stdout = 'incorrect baseline';
runBaseline('broken-baseline', broken, 'baseline-failure');
const stale = structuredClone(plan); stale.source.object = 'b'.repeat(40);
runBaseline('stale-source', stale, 'input-failure');
const staleRules = structuredClone(plan); staleRules.rules.object = 'b'.repeat(40);
runBaseline('stale-rules', staleRules, 'input-failure');
fs.writeFileSync(path.join(repository, 'negative.mts'), example.files['candidate.mts']); git('add', '.'); git('commit', '-qm', 'Ineffective known regression');
const ineffective = structuredClone(plan); ineffective.negative = { revision: git('rev-parse', 'HEAD'), path: 'negative.mts', object: git('rev-parse', 'HEAD:negative.mts') };
runBaseline('ineffective-negative', ineffective, 'verifier-failure');
fs.writeFileSync(path.join(repository, 'candidate.mts'), example.files['candidate.mts']); git('add', '.'); git('commit', '-qm', 'Candidate after baseline');
const full = { ...plan, format: 'calliope.migration.verification-plan/v1', candidate: { revision: git('rev-parse', 'HEAD'), path: 'candidate.mts', object: git('rev-parse', 'HEAD:candidate.mts') } };
const fullFile = save('full-plan.json', full), review = cli('review-verification', '--plan', fullFile);
assert.equal(cli('verify', '--repository', repository, '--plan', fullFile, '--approve', positive.value.planDigest).exit, 1);
const verified = cli('verify', '--repository', repository, '--plan', fullFile, '--approve', review.value.digest);
assert.equal(verified.exit, 0); assert.equal(verified.value.outcome, 'passed'); reports.push(verified.value);
const fullReport = save('full-report.json', verified.value);
const cliReview = cli('review-evidence', '--plan', fullFile, '--report', fullReport).value;
assert.equal(cliReview.status, 'passing-observations');
const hostReview = spawnSync(process.execPath, ['--input-type=module', '-e',
  `import fs from 'node:fs'; import {pathToFileURL} from 'node:url';
   const [modulePath,planPath,reportPath]=process.argv.slice(1);
   const {analyzeVerificationEvidence}=await import(pathToFileURL(modulePath).href);
   console.log(JSON.stringify(analyzeVerificationEvidence(JSON.parse(fs.readFileSync(planPath)),JSON.parse(fs.readFileSync(reportPath)))));`,
  path.join(pkg, 'dist/migration/index.js'), fullFile, fullReport], { cwd: repository, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1048576 });
assert.equal(hostReview.status, 0, hostReview.stderr);
assert.deepEqual(JSON.parse(hostReview.stdout), cliReview, 'Embedded host and CLI must consume the same packaged evidence');
assert.equal(cli('review-evidence', '--plan', fullFile, '--report', positive.report).exit, 1);
assert.equal(cli('review-baseline-evidence', '--plan', positive.file, '--report', fullReport).exit, 1);
const brokenTarget = { ...full, candidate: plan.negative };
const brokenTargetFile = save('broken-target-plan.json', brokenTarget);
const brokenTargetReview = cli('review-verification', '--plan', brokenTargetFile);
assert.equal(brokenTargetReview.exit, 0);
const brokenTargetResult = cli('verify', '--repository', repository, '--plan', brokenTargetFile, '--approve', brokenTargetReview.value.digest);
assert.equal(brokenTargetResult.exit, 1); assert.equal(brokenTargetResult.value.outcome, 'regression');
reports.push(brokenTargetResult.value); save('broken-target-report.json', brokenTargetResult.value);
checks.push({ name: 'broken-target', outcome: 'regression', commands: brokenTargetResult.value.commandsUsed });
const containers = reports.flatMap(report => report.observations.map(row => row.evidence.container));
assert.equal(new Set(containers).size, containers.length);
for (const container of containers) {
  const r = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', 'container', 'inspect', container], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1); assert.ok(r.stderr.includes('No such container: ' + container) || r.stderr.includes('No such object: ' + container));
}
const result = { passed: true, capabilities, checks, fullVerification: { outcome: verified.value.outcome, commands: verified.value.commandsUsed, digest: verified.value.digest },
  noCandidateAtBaseline: true, distinctApprovalAndEvidence: true, embeddedHostEvidenceParity: true, containersConfirmedAbsent: containers.length,
  runtime: plan.runtime, limits: 'Local Linux container on macOS ARM64. No paid inference, native Astrolift dispatch or hosted allowance qualification.' };
save('result.json', result); console.log(JSON.stringify(result));
