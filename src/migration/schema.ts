// Packaged artifact contract; source evidence does not authorize worker execution.
const text = { type: 'string' };
const strings = { type: 'array', items: text };
const nullableText = { type: ['string', 'null'] };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const oid = { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' };
const object = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false });
export const INVENTORY_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://calliope.ai/schemas/migration/inventory-v1',
  ...object({
    format: { const: 'calliope.migration.inventory/v1' }, kit: { const: 'inventory-v1' }, digest: hash,
    source: object({ commit: oid, tree: oid, mode: { const: 'committed-files-only' }, readPaths: { ...strings, minItems: 1, maxItems: 64, uniqueItems: true } }),
    files: { type: 'array', minItems: 1, maxItems: 5000, items: object({ path: text, object: oid, bytes: { type: ['integer', 'null'], minimum: 0 }, mode: { enum: ['100644', '100755', '120000', '160000'] }, surface: { enum: ['source', 'test', 'manifest', 'build-config', 'lockfile', 'symlink', 'submodule', 'other'] } }) },
    packages: { type: 'array', maxItems: 128, items: object({ path: text, name: nullableText, scripts: strings, dependencies: { type: 'array', maxItems: 2048, items: object({ name: text, section: { enum: ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] }, kind: { enum: ['workspace', 'file', 'registry', 'opaque'] }, specDigest: hash, displaySpec: nullableText, target: nullableText }) } }) },
    graph: object({ kind: { const: 'declared-local-package-dependencies' }, order: { type: ['array', 'null'], items: text }, cycles: { type: 'array', items: strings } }),
    findings: { type: 'array', items: object({ code: text, path: text, dependency: text }, ['dependency']) },
    limitations: strings,
  }),
};

const pin = object({ revision: oid, path: text, object: oid });
const runtime = object({ image: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, node: { type: 'string', pattern: '^v24\\.\\d+\\.\\d+$' } });
const expected = object({ exitCode: { type: 'integer', minimum: 0, maximum: 124 }, stdout: text, stderr: text });
const fingerprint = object({ sha256: hash, bytes: { type: 'integer', minimum: 0, maximum: 65536 } });
const cleanupResult = object({ outcome: { enum: ['removed', 'absent', 'timeout', 'error', 'present'] }, exitCode: { type: ['integer', 'null'] } });
const evidence = object({
  version: { const: 1 }, kind: { const: 'isolated-command' }, argv: strings, image: runtime.properties.image,
  exitCode: { type: 'integer' }, outcome: { enum: ['passed', 'failed', 'cancelled', 'timeout', 'unavailable'] },
  truncated: { type: 'boolean' }, durationMs: { type: 'integer', minimum: 0 }, container: text, cleanupConfirmed: { type: 'boolean' },
  cleanup: object({ version: { const: 1 }, removal: cleanupResult, verification: cleanupResult }, ['verification']),
  outputDigests: object({ version: { const: 1 }, stdout: fingerprint, stderr: fingerprint }),
}, ['cleanup', 'outputDigests']);
export const VERIFICATION_SCHEMAS = {
  plan: { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://calliope.ai/schemas/migration/verification-plan-v1',
    ...object({ format: { const: 'calliope.migration.verification-plan/v1' }, adapter: { const: 'javascript-to-typescript-cli/v1' }, verifier: { const: 'byte-parity-v1' }, runtime,
      source: pin, candidate: pin, negative: pin, rules: pin,
      cases: { type: 'array', minItems: 1, maxItems: 8, items: object({ id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, argument: { type: 'string', minLength: 1, maxLength: 8192 }, expected }) },
      negativeControl: object({ caseId: text, expected }), limits: object({ commandTimeoutMs: { type: 'integer', minimum: 100, maximum: 10000 }, totalMs: { type: 'integer', minimum: 100, maximum: 300000 } }),
    }) },
  report: { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://calliope.ai/schemas/migration/verification-report-v1',
    ...object({ format: { const: 'calliope.migration.verification-report/v1' }, verifier: { const: 'byte-parity-v1' }, adapter: { const: 'javascript-to-typescript-cli/v1' }, planDigest: hash, runtime,
      pins: object({ source: pin, candidate: pin, negative: pin, rules: pin }),
      outcome: { enum: ['passed', 'input-failure', 'baseline-failure', 'verifier-failure', 'regression', 'environment-failure', 'cancelled'] }, reason: text,
      observations: { type: 'array', maxItems: 18, items: object({ phase: { enum: ['runtime', 'baseline', 'negative-control', 'candidate'] }, caseId: nullableText, matches: { type: ['boolean', 'null'] }, evidence }) },
      commandsUsed: { type: 'integer', minimum: 0, maximum: 19 }, commandLimit: { type: 'integer', minimum: 4, maximum: 18 }, retainedWorkspace: nullableText, limitations: strings, digest: hash,
    }) },
};

export const EVIDENCE_REVIEW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://calliope.ai/schemas/migration/evidence-review-v1',
  ...object({
    format: { const: 'calliope.migration.evidence-review/v1' }, planDigest: hash, reportDigest: hash,
    status: { enum: ['passing-observations', 'not-passing'] },
    caseIds: { ...strings, minItems: 1, maxItems: 8, uniqueItems: true },
    findings: { type: 'array', maxItems: 128, items: object({ code: text, observation: { type: ['integer', 'null'], minimum: 0, maximum: 17 } }) },
    authority: { const: 'Supplied observation integrity only. No producer authentication, independent review or execution approval is implied.' }, digest: hash,
  }),
};
