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
