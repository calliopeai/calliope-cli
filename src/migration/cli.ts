import {sourceCandidateCapabilities} from '../orchestration/source-candidates.js';
import { INVENTORY_SCHEMA, VERIFICATION_SCHEMAS, BASELINE_SCHEMAS, EVIDENCE_REVIEW_SCHEMA } from './schema.js';
import { analyzeVerificationEvidence, analyzeBaselineEvidence } from './evidence.js';
import { analyzeAssessmentRequest } from './assessment-contract.js';
import { assessMigration } from './assessment.js';
import { ASSESSMENT_SCHEMAS } from './assessment-schema.js';
import { analyzeVerificationPlan, verifyMigration, analyzeBaselinePlan, verifyMigrationBaseline } from './verification.js';
import { realpathSync } from 'node:fs';
import { readArtifactBytes } from '../orchestration/execution-store.js';
import { migrationExample } from './example.js';
import { parseArgs } from 'node:util';
import { isCancellation } from '../cancellation.js';
import { inventorySource, MigrationError, KIT_VERSION } from './inventory.js';
export const MIGRATION_USAGE = 'calliope migration capabilities|schema|baseline-schema|review-baseline|verify-baseline|review-baseline-evidence|verification-schema|evidence-schema|assessment-schema|example|inventory|review-verification|verify|review-evidence|review-assessment|assess [--repository <root>] [--revision <full-commit>] [--path <relative-prefix>] [--plan <file>] [--report <file>] [--request <file>] [--approve <digest>] [--json]';
export async function runMigrationCommand(args: string[], options: { signal?: AbortSignal; write?: (line: string) => void } = {}): Promise<number> {
  const write = options.write ?? (line => process.stdout.write(line));
  const json = args.includes('--json');
  try {
    if (args.length > 140 || args.some(arg => arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg))) throw new MigrationError('invalid', MIGRATION_USAGE);
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, repository: { type: 'string' }, revision: { type: 'string' }, path: { type: 'string', multiple: true }, plan: { type: 'string' }, report: { type: 'string' }, request: { type: 'string' }, approve: { type: 'string' } } });
    if (positionals.length !== 1) throw new MigrationError('invalid', MIGRATION_USAGE);
    if (['assess', 'review-assessment'].includes(positionals[0]!)) {
      if (!values.request || values.plan || values.report || values.path || values.revision || values.approve || (positionals[0] === 'assess' ? !values.repository : values.repository)) throw new MigrationError('invalid', MIGRATION_USAGE);
      const input: unknown = JSON.parse(readArtifactBytes(realpathSync(values.request), 2097152).toString('utf8'));
      const result = positionals[0] === 'review-assessment' ? analyzeAssessmentRequest(input) : await assessMigration(values.repository!, input, { signal: options.signal });
      write(JSON.stringify(result) + '\n'); return 0;
    }
    if (values.request) throw new MigrationError('invalid', MIGRATION_USAGE);
    if (['review-evidence', 'review-baseline-evidence'].includes(positionals[0]!)) {
      if (!values.plan || !values.report || values.path || values.revision || values.repository || values.approve) throw new MigrationError('invalid', MIGRATION_USAGE);
      const read = (file: string): unknown => JSON.parse(readArtifactBytes(realpathSync(file), 262144).toString('utf8'));
      const result = (positionals[0] === 'review-baseline-evidence' ? analyzeBaselineEvidence : analyzeVerificationEvidence)(read(values.plan), read(values.report));
      write(JSON.stringify(result) + '\n');
      return ['passing-observations', 'baseline-observations'].includes(result.status) ? 0 : 1;
    }
    if (values.report) throw new MigrationError('invalid', MIGRATION_USAGE);
    if (['review-verification', 'verify', 'review-baseline', 'verify-baseline'].includes(positionals[0]!)) {
      const baselineOnly = positionals[0]!.endsWith('baseline'), execute = positionals[0] === 'verify' || positionals[0] === 'verify-baseline';
      if (!values.plan || values.path || values.revision || (execute ? !values.repository || !values.approve : values.repository || values.approve)) throw new MigrationError('invalid', MIGRATION_USAGE);
      const input: unknown = JSON.parse(readArtifactBytes(realpathSync(values.plan), 262144).toString('utf8'));
      const analysis = (baselineOnly ? analyzeBaselinePlan : analyzeVerificationPlan)(input);
      if (!execute) { write(JSON.stringify(analysis) + '\n'); return 0; }
      const result = await (baselineOnly ? verifyMigrationBaseline : verifyMigration)(values.repository!, input, { signal: options.signal, approve: async request => request.digest === values.approve });
      write(json ? JSON.stringify(result) + '\n' : `${result.outcome}: ${result.reason}\nVerification ${result.digest}\n`);
      return result.outcome === (baselineOnly ? 'baseline-verified' : 'passed') ? 0 : result.outcome === 'cancelled' ? 130 : 1;
    }
    if (values.plan || values.approve) throw new MigrationError('invalid', MIGRATION_USAGE);
    if (positionals[0] === 'example' && !values.repository && !values.revision && !values.path) { write(JSON.stringify(migrationExample()) + '\n'); return 0; }
    if (positionals[0] === 'baseline-schema' && !values.repository && !values.revision && !values.path) { write(JSON.stringify(BASELINE_SCHEMAS) + '\n'); return 0; }
    if (positionals[0] === 'verification-schema' && !values.repository && !values.revision && !values.path) { write(JSON.stringify(VERIFICATION_SCHEMAS) + '\n'); return 0; }
    if (positionals[0] === 'evidence-schema' && !values.repository && !values.revision && !values.path) { write(JSON.stringify(EVIDENCE_REVIEW_SCHEMA) + '\n'); return 0; }
    if (positionals[0] === 'assessment-schema' && !values.repository && !values.revision && !values.path) { write(JSON.stringify(ASSESSMENT_SCHEMAS) + '\n'); return 0; }
    if (positionals[0] === 'schema' && !values.repository && !values.revision && !values.path) { write(JSON.stringify(INVENTORY_SCHEMA) + '\n'); return 0; }
    if (positionals[0] === 'capabilities' && !values.repository && !values.revision && !values.path) {
      write(JSON.stringify({ kit: 'migration-v1', inventoryVersion: KIT_VERSION, phases: ['inventory', 'verify-baseline', 'review-baseline-evidence', 'verify', 'review-evidence', 'assess'], dependencyAnalysis: ['npm-declarations', 'declared-unit-dependencies'], schemas: ['calliope.migration.baseline-plan/v1', 'calliope.migration.baseline-report/v1', 'calliope.migration.baseline-evidence-review/v1', 'calliope.migration.inventory/v1', 'calliope.migration.verification-plan/v1', 'calliope.migration.verification-report/v1', 'calliope.migration.evidence-review/v1', 'calliope.migration.assessment-request/v1', 'calliope.migration.assessment/v1'], execution: { candidate: sourceCandidateCapabilities(), baseline: 'explicit-plan-digest-approval; no-candidate-read-or-execution', verification: 'explicit-plan-digest-approval', evidenceReview: 'read-only-no-execution-or-approval', assessment: 'read-only-no-dispatch; host-evidence-review-required-for-go', adapters: ['javascript-to-typescript-cli/v1'], backend: 'native-isolated-command' } }) + '\n'); return 0;
    }
    if (positionals[0] !== 'inventory' || !values.repository || !values.revision) throw new MigrationError('invalid', MIGRATION_USAGE);
    const result = await inventorySource({ repository: values.repository, revision: values.revision, ...(values.path ? { readPaths: values.path } : {}) }, options);
    write(json ? JSON.stringify(result) + '\n' : `Commit ${result.source.commit}\n${result.files.length} tracked entries; ${result.packages.length} package manifests; ${result.graph.cycles.length} declared dependency cycles.\nInventory ${result.digest}\nUse --json for exact files, findings and limitations. No repository code was executed.\n`);
    return 0;
  } catch (error) {
    const code = isCancellation(error) ? 'cancelled' : error instanceof MigrationError ? error.code : 'unavailable';
    const message = error instanceof MigrationError ? error.message : code === 'cancelled' ? 'Migration operation cancelled.' : 'Migration operation could not read its local inputs within their bounds.';
    write(json ? JSON.stringify({ error: { code, message } }) + '\n' : message + '\n'); return code === 'cancelled' ? 130 : 1;
  }
}
