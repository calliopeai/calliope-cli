import { INVENTORY_SCHEMA } from './schema.js';
import { parseArgs } from 'node:util';
import { isCancellation } from '../cancellation.js';
import { inventorySource, MigrationError, KIT_VERSION } from './inventory.js';
export const MIGRATION_USAGE = 'calliope migration capabilities|schema|inventory --repository <root> --revision <full-commit> [--path <relative-prefix>] [--json]';
export async function runMigrationCommand(args: string[], options: { signal?: AbortSignal; write?: (line: string) => void } = {}): Promise<number> {
  const write = options.write ?? (line => process.stdout.write(line));
  const json = args.includes('--json');
  try {
    if (args.length > 140 || args.some(arg => arg.length > 4096 || /[\x00-\x1f\x7f]/.test(arg))) throw new MigrationError('invalid', MIGRATION_USAGE);
    const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, repository: { type: 'string' }, revision: { type: 'string' }, path: { type: 'string', multiple: true } } });
    if (positionals.length !== 1) throw new MigrationError('invalid', MIGRATION_USAGE);
    if (positionals[0] === 'schema' && !values.repository && !values.revision && !values.path) { write(JSON.stringify(INVENTORY_SCHEMA) + '\n'); return 0; }
    if (positionals[0] === 'capabilities' && !values.repository && !values.revision && !values.path) {
      write(JSON.stringify({ kit: KIT_VERSION, phases: ['inventory'], dependencyAnalysis: ['npm-declarations'], schemas: ['calliope.migration.inventory/v1'], execution: false }) + '\n'); return 0;
    }
    if (positionals[0] !== 'inventory' || !values.repository || !values.revision) throw new MigrationError('invalid', MIGRATION_USAGE);
    const result = await inventorySource({ repository: values.repository, revision: values.revision, ...(values.path ? { readPaths: values.path } : {}) }, options);
    write(json ? JSON.stringify(result) + '\n' : `Commit ${result.source.commit}\n${result.files.length} tracked entries; ${result.packages.length} package manifests; ${result.graph.cycles.length} declared dependency cycles.\nInventory ${result.digest}\nUse --json for exact files, findings and limitations. No repository code was executed.\n`);
    return 0;
  } catch (error) {
    const code = isCancellation(error) ? 'cancelled' : error instanceof MigrationError ? error.code : 'unavailable';
    const message = error instanceof MigrationError ? error.message : code === 'cancelled' ? 'Migration inventory cancelled.' : 'Migration inventory could not read the selected local revision within its bounds.';
    write(json ? JSON.stringify({ error: { code, message } }) + '\n' : message + '\n'); return code === 'cancelled' ? 130 : 1;
  }
}
