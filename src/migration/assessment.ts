/** Read-only feasibility and planning; native workflow owners retain execution authority. */
import { canonicalJson, digest } from '../approvals/index.js';
import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { cancellable, isCancellation, throwIfCancelled } from '../cancellation.js';
import { inventorySource, dependencyGraph, KIT_VERSION, MigrationError } from './inventory.js';
import { analyzeVerificationPlan, VERIFIER_VERSION, VERIFICATION_ADAPTER, type SourcePin } from './verification.js';
import { analyzeVerificationEvidence } from './evidence.js';
import { analyzeAssessmentRequest, ASSESSMENT_VERSION, type AssessmentRequest } from './assessment-contract.js';

type Finding = { code: string; source: string | null; severity: 'investigate' | 'do-not-migrate' };
export type AssessmentImplementation = { kitSha256: string; verifierSha256: string };
export type AssessmentReviewRequest = { digest: string; repository: string; implementation: AssessmentImplementation | null; requestDigest: string; inventoryDigest: string; request: AssessmentRequest; findings: Finding[] };
export type AssessmentReview = { decision: 'accepted' | 'rejected'; receipt: string };
export type AssessmentOptions = {
  signal?: AbortSignal;
  /** Trusted host's installed kit artifact and verifier implementation hashes, not claims copied from request JSON. */
  implementation?: AssessmentImplementation;
  /** Trusted host verifies provenance, scope/criteria coverage, risk classification and measured pilot accounting.
   * Never construct this capability from request JSON. Acceptance does not authorize execution. */
  review?: (input: AssessmentReviewRequest) => Promise<AssessmentReview>;
};
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const unitId = (path: string) => 'unit-' + digest(path).slice(0, 24);

export async function assessMigration(repository: string, input: unknown, options: AssessmentOptions = {}) {
  if (options.review !== undefined && typeof options.review !== 'function') throw new MigrationError('invalid', 'An assessment reviewer must be a host callback, never request data.');
  let implementation: AssessmentImplementation | null = null;
  if (options.implementation !== undefined) {
    const value = options.implementation;
    if (!value || Object.keys(value).length !== 2 || ![value.kitSha256, value.verifierSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) throw new MigrationError('invalid', 'The host must supply exact kit artifact and verifier SHA-256 identities.');
    implementation = { kitSha256: value.kitSha256, verifierSha256: value.verifierSha256 };
  }
  const { request, digest: requestDigest } = analyzeAssessmentRequest(input);
  if (typeof repository !== 'string' || repository.length > 4096 || /[\x00-\x1f\x7f]/.test(repository)) throw new MigrationError('invalid', 'Select a local repository root.');
  try { repository = realpathSync(repository); } catch { throw new MigrationError('unavailable', 'The assessment repository is unavailable.'); }
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]);
  throwIfCancelled(signal);
  const inventory = await inventorySource({ repository, revision: request.source.revision, readPaths: request.source.readPaths }, { signal });
  const files = new Map(inventory.files.map(f => [f.path, f]));
  const findings: Finding[] = [];
  const finding = (code: string, source: string | null = null, severity: Finding['severity'] = 'investigate') => findings.push({ code, source, severity });
  if (!implementation) finding('implementation-binding-required');
  const within = (path: string) => request.source.readPaths.some(p => p === '.' || p === path || path.startsWith(p + '/'));
  if (request.target.adapter !== VERIFICATION_ADAPTER) finding('unsupported-adapter', null, 'do-not-migrate');
  if (!/^sha256:[a-f0-9]{64}$/.test(request.target.runtime.image) || !/^v24\.\d+\.\d+$/.test(request.target.runtime.node)) finding('unsupported-runtime', null, 'do-not-migrate');
  if (request.intent.kind !== 'port') finding('separate-' + request.intent.kind + '-plan-required');
  for (const row of inventory.findings) finding('inventory-' + row.code, row.path);
  if (inventory.graph.cycles.length) finding('declared-package-cycle');
  for (const pkg of inventory.packages) for (const dep of pkg.dependencies) if (!dep.target) finding('external-dependency-needs-evidence', pkg.path);
  const sourcePaths = new Set(request.units.map(u => u.source)), excluded = new Set(request.exclusions.map(e => e.path));
  for (const file of inventory.files) if (file.surface === 'source' && !sourcePaths.has(file.path) && !excluded.has(file.path)) finding('unplanned-source', file.path);
  for (const exclusion of request.exclusions) if (!files.has(exclusion.path)) finding('exclusion-outside-inventory', exclusion.path);
  for (const unit of request.units) {
    const file = files.get(unit.source);
    if (!file || !['100644', '100755'].includes(file.mode) || file.surface !== 'source') finding('unit-source-unavailable', unit.source);
    if (!unit.source.endsWith('.mjs') || !unit.target.endsWith('.mts')) finding('unsupported-unit', unit.source, 'do-not-migrate');
    if (file?.bytes === null || (file?.bytes ?? 0) > 65536) finding('unsupported-unit-size', unit.source, 'do-not-migrate');
    if (files.has(unit.target) && !request.pilots.some(p => p.source === unit.source)) finding('existing-target-needs-review', unit.source);
  }
  const graph = dependencyGraph(request.units.map(u => ({ path: u.source, dependencies: u.dependencies.map(target => ({ target })) })));
  if (graph.cycles.length) finding('unit-dependency-cycle');
  const packageFor = (path: string) => inventory.packages.filter(p => {
    const directory = posix.dirname(p.path); return directory === '.' || path.startsWith(directory + '/');
  }).sort((a, b) => b.path.length - a.path.length)[0];
  for (const unit of request.units) {
    const pkg = packageFor(unit.source);
    for (const dep of pkg?.dependencies ?? []) if (dep.target && dep.target !== pkg!.path) {
      for (const other of request.units) if (packageFor(other.source)?.path === dep.target && !unit.dependencies.includes(other.source)) finding('missing-declared-package-order', unit.source);
    }
  }
  // Read every evidence pin through the existing bounded committed inventory, never the working tree.
  const pins: SourcePin[] = [request.rules];
  const pilots: { source: string; planDigest: string | null; reportDigest: string | null; status: string; measurementDigest: string | null }[] = [];
  for (const pilot of request.pilots) {
    try {
      const analysis = analyzeVerificationPlan(pilot.plan), review = analyzeVerificationEvidence(pilot.plan, pilot.report), plan = analysis.plan;
      const unit = request.units.find(u => u.source === pilot.source)!;
      const file = files.get(pilot.source);
      const bindingMatches = plan.source.revision === request.source.revision && plan.source.path === unit.source && plan.source.object === file?.object &&
        plan.candidate.path === unit.target && same(plan.rules, request.rules) && same(plan.runtime, request.target.runtime) && plan.adapter === request.target.adapter;
      const measurementMatches = pilot.measurement?.reportDigest === review.reportDigest;
      const status = !bindingMatches ? 'stale' : review.status;
      pilots.push({ source: pilot.source, planDigest: analysis.digest, reportDigest: review.reportDigest, status,
        measurementDigest: pilot.measurement && measurementMatches ? digest(canonicalJson(pilot.measurement)) : null });
      pins.push(plan.source, plan.candidate, plan.negative, plan.rules);
      if (!bindingMatches) finding('stale-pilot-binding', pilot.source);
      if (review.status !== 'passing-observations') finding('nonpassing-pilot', pilot.source);
      if (!pilot.measurement) finding('missing-pilot-measurement', pilot.source);
      else if (!measurementMatches) finding('stale-pilot-measurement', pilot.source);
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error;
      pilots.push({ source: pilot.source, planDigest: null, reportDigest: null, status: 'invalid', measurementDigest: null });
      finding('invalid-pilot-evidence', pilot.source);
    }
  }
  const grouped = new Map<string, SourcePin[]>();
  for (const pin of pins) {
    if (!within(pin.path)) { finding('evidence-pin-outside-read-scope', pin.path); continue; }
    grouped.set(pin.revision, [...(grouped.get(pin.revision) ?? []), pin]);
  }
  for (const [revision, group] of grouped) {
    const paths = [...new Set(group.map(p => p.path))].sort();
    try {
      const observed = await inventorySource({ repository, revision, readPaths: paths }, { signal });
      for (const pin of group) {
        const file = observed.files.find(f => f.path === pin.path);
        if (!file || file.object !== pin.object || !['100644', '100755'].includes(file.mode) || file.bytes === null || file.bytes > 65536) finding('stale-or-unsupported-evidence-pin', pin.path);
      }
    } catch (error) {
      if (isCancellation(error)) throw error;
      finding('evidence-revision-unavailable');
    }
  }
  const requiredPilots: string[] = [];
  const pilotGroups = [];
  for (const risk of ['low', 'medium', 'high']) {
    const choices = request.units.filter(u => u.risk === risk).map(u => u.source).sort();
    const passing = pilots.filter(p => choices.includes(p.source) && p.status === 'passing-observations').map(p => unitId(p.source)).sort();
    if (choices.length) pilotGroups.push({ risk, units: choices.length, passingPilots: passing });
    if (choices.length && !passing.length) requiredPilots.push(choices[0]!);
  }
  for (const source of requiredPilots) if (!pilots.some(p => p.source === source && p.status === 'passing-observations')) finding('representative-pilot-required', source);
  if (!pilots.length) finding('missing-baseline-and-verifier-evidence');
  const uniqueFindings = () => [...new Map(findings.map(f => [canonicalJson(f), f])).values()].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
  const reviewBody = { repository, implementation, requestDigest, inventoryDigest: inventory.digest, request, findings: uniqueFindings() };
  const reviewDigest = digest(canonicalJson(reviewBody));
  let review: AssessmentReview | null = null;
  if (options.review) {
    try {
      const value = await cancellable(options.review(JSON.parse(JSON.stringify({ ...reviewBody, digest: reviewDigest }))), signal);
      if (!value || Object.keys(value).length !== 2 || !['accepted', 'rejected'].includes(value.decision) || typeof value.receipt !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(value.receipt)) finding('invalid-host-review');
      else review = { decision: value.decision, receipt: value.receipt };
    } catch (error) { if (isCancellation(error)) throw error; finding('host-review-unavailable'); }
  }
  if (!review) finding('evidence-and-coverage-review-required');
  else if (review.decision !== 'accepted') finding('evidence-and-coverage-review-rejected');
  const measured = request.pilots.filter(p => pilots.some(row => row.source === p.source && row.status === 'passing-observations' && row.measurementDigest)).map(p => p.measurement!);
  let estimate: { status: string; units: number; observedPilots: number; costMicros: { low: number; high: number } | null; durationMs: { low: number; high: number } | null } = {
    status: 'insufficient-reviewed-evidence', units: request.units.length, observedPilots: measured.length, costMicros: null, durationMs: null,
  };
  if (review?.decision === 'accepted' && !findings.length && measured.length && graph.order) {
    const n = request.units.length, depths = new Map<string, number>();
    for (const path of graph.order) depths.set(path, 1 + Math.max(0, ...request.units.find(u => u.source === path)!.dependencies.map(d => depths.get(d)!)));
    const waves = Math.max(Math.ceil(n / request.budget.concurrency), ...depths.values());
    estimate = { status: 'measured-pilot-range', units: n, observedPilots: measured.length,
      costMicros: { low: n * Math.min(...measured.map(m => m.costMicros)), high: n * Math.max(...measured.map(m => m.costMicros)) },
      durationMs: { low: waves * Math.min(...measured.map(m => m.workMs)) + n * Math.min(...measured.map(m => m.reviewMs)), high: n * Math.max(...measured.map(m => m.workMs + m.reviewMs)) } };
    if (estimate.costMicros!.low > request.budget.maxCostMicros || estimate.durationMs!.low > request.budget.maxDurationMs) finding('measured-range-exceeds-budget', null, 'do-not-migrate');
    else if (estimate.costMicros!.high > request.budget.maxCostMicros || estimate.durationMs!.high > request.budget.maxDurationMs) finding('budget-overlaps-measured-range');
  }
  const finalFindings = uniqueFindings();
  const recommendation = finalFindings.some(f => f.severity === 'do-not-migrate') ? 'do-not-migrate' : finalFindings.length ? 'investigate' : 'go';
  const binding = { requestDigest, inventoryDigest: inventory.digest, kit: { inventory: KIT_VERSION, assessment: ASSESSMENT_VERSION, verifier: VERIFIER_VERSION }, implementation, rules: request.rules, source: request.source, target: request.target };
  const units = request.units.map(u => ({ id: unitId(u.source), source: { revision: request.source.revision, path: u.source, object: files.get(u.source)?.object ?? null }, target: u.target,
    dependencies: u.dependencies.map(unitId).sort(), risk: u.risk, rationale: u.rationale,
    bindingDigest: digest(canonicalJson({ binding, unit: u })), state: 'planned', pilot: pilots.find(p => p.source === u.source) ?? null }));
  const value = {
    format: 'calliope.migration.assessment/v1', ...binding, recommendation, recommendationScope: 'This pinned plan and supported adapter only; not a general verdict on the target technology.',
    findings: finalFindings, review: { digest: reviewDigest, result: review }, estimate,
    estimateAssumptions: ['Pilot costs include implementation, verification and independent review; the trusted host must verify their accounting receipts.', 'Ranges extrapolate measured pilot minima/maxima to every manifest unit; they are not statistical confidence intervals.', 'Lower duration uses concurrency and dependency depth, followed by serial review. Upper duration assumes serial work and review.', 'No unmeasured deployment, external data migration or operating cost is included.'],
    inventory,
    rulebook: { format: 'calliope.migration.rulebook/v1', intent: request.intent, sourceRules: request.rules, exclusions: request.exclusions,
      preserve: inventory.files.filter(f => ['test', 'manifest', 'build-config', 'lockfile'].includes(f.surface)),
      requirements: ['Preserve the pinned behavioral contract and original tests.', 'Criteria or compatibility changes require an independently reviewed new plan and evidence.', 'Keep implementation, review and verification states separate.', 'No merge, deployment or external data migration is authorized by assessment.'] },
    manifest: { format: 'calliope.migration.work-manifest/v1', units, pilotGroups, graph: { kind: 'declared-unit-dependencies', order: graph.order?.map(unitId) ?? null, cycles: graph.cycles.map(c => c.map(unitId)) },
      evidenceStorage: { root: '.calliope/migrations/' + requestDigest, files: ['assessment.json', 'rulebook.json', 'manifest.json'], unitFiles: ['source-pin.json', 'verification-plan.json', 'verification-report.json', 'measurement.json', 'review.json'], written: false } },
    limitations: ['Declared package and unit dependencies only; source imports and dynamic constructs are not statically analyzed.', 'Only declared cases of the self-contained JS-to-TS CLI adapter are evidenced, without TypeScript type-check or deployment proof.', 'Host review receipts are references, not portable authentication or permission grants.', 'Assessment does not create native workflow bindings, start workers, persist artifacts or propose brain changes. Those require their owning host.'],
    execution: 'none',
  };
  throwIfCancelled(signal);
  return { ...value, digest: digest(canonicalJson(value)) };
}
