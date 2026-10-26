import { INVENTORY_SCHEMA } from './schema.js';
const text = { type: 'string', minLength: 1, maxLength: 2048 };
const path = { type: 'string', minLength: 1, maxLength: 1024 };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const oid = { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' };
const list = (items: unknown, maxItems: number, minItems = 0) => ({ type: 'array', items, maxItems, minItems });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const integer = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum });
const pin = object({ revision: oid, path, object: oid });
const source = object({ revision: oid, readPaths: { ...list(path, 64, 1), uniqueItems: true } });
const target = object({ adapter: { ...text, maxLength: 128 }, stack: text, runtime: object({ image: { ...text, maxLength: 128 }, node: { ...text, maxLength: 64 } }) });
const intent = object({ kind: { enum: ['port', 'redesign', 'incremental-upgrade'] }, motivation: text, compatibility: list(text, 16, 1), deployment: list(text, 16, 1), success: list(text, 16, 1) });
const budget = object({ currency: { const: 'USD' }, maxCostMicros: integer(0, 1000000000000000), maxDurationMs: integer(1, 2678400000), concurrency: integer(1, 32) });
const exclusion = object({ path, reason: text });
const measurement = object({ evidenceId: { ...text, maxLength: 256 }, reportDigest: hash, costMicros: integer(0, 1000000000000), workMs: integer(1, 1000000000), reviewMs: integer(0, 1000000000) });
const risk = { enum: ['low', 'medium', 'high'] };
const pilot = object({ source: path, planDigest: nullable(hash), reportDigest: nullable(hash), status: { enum: ['stale', 'invalid', 'passing-observations', 'not-passing'] }, measurementDigest: nullable(hash) });
const unitId = { type: 'string', pattern: '^unit-[a-f0-9]{24}$' };
const range = object({ low: integer(0, Number.MAX_SAFE_INTEGER), high: integer(0, Number.MAX_SAFE_INTEGER) });
export const ASSESSMENT_SCHEMAS = {
  request: { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://calliope.ai/schemas/migration/assessment-request-v1',
    ...object({ format: { const: 'calliope.migration.assessment-request/v1' }, source, target, intent, budget, rules: pin,
      units: list(object({ source: path, target: path, dependencies: { ...list(path, 128), uniqueItems: true }, risk, rationale: text }), 128, 1), exclusions: list(exclusion, 128),
      pilots: list(object({ source: path, plan: {}, report: {}, measurement: nullable(measurement) }), 16) }) },
  report: { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://calliope.ai/schemas/migration/assessment-v1',
    ...object({ format: { const: 'calliope.migration.assessment/v1' }, requestDigest: hash, inventoryDigest: hash,
      implementation: nullable(object({ kitSha256: hash, verifierSha256: hash })),
      kit: object({ inventory: { const: 'inventory-v1' }, assessment: { const: 'assessment-v1' }, verifier: { const: 'byte-parity-v1' } }), rules: pin, source, target,
      recommendation: { enum: ['go', 'investigate', 'do-not-migrate'] }, recommendationScope: text,
      findings: list(object({ code: text, source: nullable(path), severity: { enum: ['investigate', 'do-not-migrate'] } }), 20000),
      review: object({ digest: hash, result: nullable(object({ decision: { enum: ['accepted', 'rejected'] }, receipt: { type: 'string', pattern: '^[a-zA-Z0-9_.:-]{1,256}$' } })) }),
      estimate: object({ status: { enum: ['insufficient-reviewed-evidence', 'measured-pilot-range'] }, units: integer(1, 128), observedPilots: integer(0, 16), costMicros: nullable(range), durationMs: nullable(range) }),
      estimateAssumptions: list(text, 16), inventory: INVENTORY_SCHEMA,
      rulebook: object({ format: { const: 'calliope.migration.rulebook/v1' }, intent, sourceRules: pin, exclusions: list(exclusion, 128), preserve: { ...(INVENTORY_SCHEMA.properties.files as Record<string, unknown>), minItems: 0 }, requirements: list(text, 16) }),
      manifest: object({ format: { const: 'calliope.migration.work-manifest/v1' },
        pilotGroups: list(object({ risk, units: integer(1, 128), passingPilots: list(unitId, 16) }), 3),
        units: list(object({ id: unitId, source: object({ revision: oid, path, object: nullable(oid) }), target: path, dependencies: list(unitId, 128), risk, rationale: text, bindingDigest: hash, state: { const: 'planned' }, pilot: nullable(pilot) }), 128, 1),
        graph: object({ kind: { const: 'declared-unit-dependencies' }, order: nullable(list(unitId, 128)), cycles: list(list(unitId, 128), 128) }),
        evidenceStorage: object({ root: path, files: list(path, 16), unitFiles: list(path, 16), written: { const: false } }) }),
      limitations: list(text, 16), execution: { const: 'none' }, digest: hash }) },
};
