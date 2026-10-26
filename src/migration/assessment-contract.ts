import { canonicalJson, digest } from '../approvals/index.js';
import { MigrationError, sourcePath } from './inventory.js';
import type { SourcePin } from './verification.js';

export const ASSESSMENT_VERSION = 'assessment-v1';
export type PilotMeasurement = { evidenceId: string; reportDigest: string; costMicros: number; workMs: number; reviewMs: number };
export type AssessmentRequest = {
  format: 'calliope.migration.assessment-request/v1';
  source: { revision: string; readPaths: string[] };
  target: { adapter: string; stack: string; runtime: { image: string; node: string } };
  intent: { kind: 'port' | 'redesign' | 'incremental-upgrade'; motivation: string; compatibility: string[]; deployment: string[]; success: string[] };
  budget: { currency: 'USD'; maxCostMicros: number; maxDurationMs: number; concurrency: number };
  rules: SourcePin;
  units: { source: string; target: string; dependencies: string[]; risk: 'low' | 'medium' | 'high'; rationale: string }[];
  exclusions: { path: string; reason: string }[];
  pilots: { source: string; plan: unknown; report: unknown; measurement: PilotMeasurement | null }[];
};
function fail(message: string): never { throw new MigrationError('invalid', message); }
function shape(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail('Invalid migration assessment fields.');
}
function text(v: unknown, max = 2048): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) fail('Use nonempty bounded assessment text.');
}
function array(v: unknown, max: number, min = 0): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail('Keep assessment lists within their declared bounds.');
}
function integer(v: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail('Use bounded integer assessment budgets and measurements.');
}
function path(v: unknown): asserts v is string { text(v, 1024); sourcePath(v); if (v === '.') fail('Select a file path, not the repository root.'); }
function pin(v: unknown) {
  shape(v, ['revision', 'path', 'object']); path(v.path);
  if (![v.revision, v.object].every(s => typeof s === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s))) fail('Pin assessment inputs to full Git commits and blobs.');
}
export function analyzeAssessmentRequest(input: unknown) {
  let raw: string;
  try { raw = canonicalJson(input); } catch { return fail('Use plain JSON for the assessment request.'); }
  if (Buffer.byteLength(raw) > 2097152) fail('Keep an assessment request within 2 MiB.');
  const v: unknown = JSON.parse(raw);
  shape(v, ['format', 'source', 'target', 'intent', 'budget', 'rules', 'units', 'exclusions', 'pilots']);
  if (v.format !== 'calliope.migration.assessment-request/v1') fail('Unsupported assessment request version.');
  shape(v.source, ['revision', 'readPaths']);
  if (typeof v.source.revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.source.revision)) fail('Select a full immutable source commit.');
  array(v.source.readPaths, 64, 1);
  for (const p of v.source.readPaths) { text(p, 1024); sourcePath(p); }
  if (new Set(v.source.readPaths).size !== v.source.readPaths.length) fail('Use distinct read paths.');
  shape(v.target, ['adapter', 'stack', 'runtime']); text(v.target.adapter, 128); text(v.target.stack);
  shape(v.target.runtime, ['image', 'node']); text(v.target.runtime.image, 128); text(v.target.runtime.node, 64);
  shape(v.intent, ['kind', 'motivation', 'compatibility', 'deployment', 'success']);
  if (!['port', 'redesign', 'incremental-upgrade'].includes(String(v.intent.kind)) || typeof v.intent.kind !== 'string') fail('Choose port, redesign or incremental-upgrade explicitly.');
  text(v.intent.motivation);
  for (const key of ['compatibility', 'deployment', 'success']) { array(v.intent[key], 16, 1); for (const row of v.intent[key]) text(row); }
  shape(v.budget, ['currency', 'maxCostMicros', 'maxDurationMs', 'concurrency']);
  if (v.budget.currency !== 'USD') fail('This assessment version measures costs in USD micros.');
  integer(v.budget.maxCostMicros, 0, 1000000000000000); integer(v.budget.maxDurationMs, 1, 2678400000); integer(v.budget.concurrency, 1, 32);
  pin(v.rules);
  array(v.units, 128, 1); const sources = new Set<string>(), targets = new Set<string>();
  for (const row of v.units) {
    shape(row, ['source', 'target', 'dependencies', 'risk', 'rationale']); path(row.source); path(row.target); text(row.rationale);
    if (sources.has(row.source) || targets.has(row.target)) fail('Each source and target must have one unit owner.');
    sources.add(row.source); targets.add(row.target);
    if (typeof row.risk !== 'string' || !['low', 'medium', 'high'].includes(row.risk)) fail('Declare each unit risk.');
    array(row.dependencies, 128); for (const p of row.dependencies) path(p);
    if (new Set(row.dependencies).size !== row.dependencies.length) fail('Use distinct unit dependencies.');
  }
  for (const row of v.units as AssessmentRequest['units']) {
    if (sources.has(row.target)) fail('Targets cannot overwrite selected source units.');
    if (row.dependencies.some(p => !sources.has(p))) fail('Every unit dependency must name another declared source unit.');
  }
  array(v.exclusions, 128); const excluded = new Set<string>();
  for (const row of v.exclusions) {
    shape(row, ['path', 'reason']); path(row.path); text(row.reason);
    if (sources.has(row.path) || excluded.has(row.path)) fail('Exclude a source only once and never while migrating it.');
    excluded.add(row.path);
  }
  array(v.pilots, 16); const pilots = new Set<string>();
  for (const row of v.pilots) {
    shape(row, ['source', 'plan', 'report', 'measurement']); path(row.source);
    if (!sources.has(row.source) || pilots.has(row.source)) fail('Attach at most one pilot to each declared unit.');
    pilots.add(row.source);
    if (row.measurement !== null) {
      const m = row.measurement; shape(m, ['evidenceId', 'reportDigest', 'costMicros', 'workMs', 'reviewMs']); text(m.evidenceId, 256);
      if (typeof m.reportDigest !== 'string' || !/^[a-f0-9]{64}$/.test(m.reportDigest)) fail('Bind measurements to their exact verification report.');
      integer(m.costMicros, 0, 1000000000000); integer(m.workMs, 1, 1000000000); integer(m.reviewMs, 0, 1000000000);
    }
  }
  const request = v as unknown as AssessmentRequest;
  return { request, digest: digest(raw) };
}
