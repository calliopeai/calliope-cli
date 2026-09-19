import * as fs from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../approvals/index.js';
import { authorizeSessionAction } from '../session-management/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { brainStore, BrainAccess, readBrainFile, projectFile, hasBrainSecrets } from './access.js';
import { parseExchangeJson, canonicalExchangeJson } from './exchange-json.js';
import { makeExchange, type BrainTransferOptions } from './exchange.js';
import { exportKnowledgeGraph } from './kg.js';
import { BrainTransferError, type TransferReport } from './transfer-report.js';
import { BrainError } from './types.js';
import { obj } from './validation.js';

/** Explicit graph projection, with source snapshots but without journal history. */
export async function exportKnowledgeGraphFile(
  cwd: string,
  path: string,
  options: BrainTransferOptions = {},
) {
  if (options.manifestPath && !options.exchange)
    throw new BrainError(
      'invalid',
      'A manifest requires --exchange so it can be retained in the archive.',
    );
  const store = brainStore(cwd, options),
    view = store.read(options.signal);
  await new BrainAccess(cwd, view.state.sources, options).all();
  const manifestFile = options.manifestPath
    ? await readBrainFile(cwd, options.manifestPath, options)
    : undefined;
  const manifest = manifestFile ? parseExchangeJson(manifestFile.original) : null;
  if (manifest !== null && !obj(manifest))
    throw new BrainError('invalid', 'Manifest must be an object.');
  const graph = exportKnowledgeGraph(view),
    origin = { id: view.state.header.id, revision: view.state.revision };
  const report: TransferReport = {
    format: 'calliope-brain-transfer-report/v1',
    operation: 'export',
    representation: 'graph-projection',
    origin,
    manifestHash: manifest ? digest(canonicalExchangeJson(manifest)) : null,
    losses: [
      {
        code: 'graph-history',
        message:
          'Graph export omits journal events, tombstones, reversals and unreferenced historical sources. Use native brain export to preserve full history.',
      },
    ],
    mappings: [],
    conflicts: 0,
    changes: 0,
  };
  const value = options.exchange
    ? makeExchange(graph as unknown as Record<string, unknown>, origin, manifest)
    : graph;
  if (hasBrainSecrets(value))
    throw new BrainError(
      'policy-denied',
      'Transfer matches current secret material; preserve it privately and export a reviewed sanitized scope.',
    );
  const content = JSON.stringify(value),
    target = projectFile(cwd, path);
  const receipt = {
    path: target.file,
    format: value.format,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    revision: view.state.revision,
    report,
  };
  if (options.preview) return { ...receipt, preview: true };
  if (!options.allowLoss)
    throw new BrainTransferError(
      'invalid',
      'Review the graph export report and pass --allow-loss to acknowledge its projection limits.',
      report,
    );
  await authorizeSessionAction(
    cwd,
    'write_file',
    {
      path: target.file,
      operation: 'brain-kg-export',
      format: value.format,
      digest: digest(content),
      bytes: Buffer.byteLength(content),
    },
    { ...options, confirmation: options.confirmation ?? 'mutating' },
  );
  // Re-evaluate retained-source scope after approval; foreign locators are never fetched.
  await new BrainAccess(cwd, view.state.sources, options).all();
  if (manifestFile) {
    await readBrainFile(cwd, options.manifestPath!, options);
    manifestFile.assertUnchanged();
  }
  if (hasBrainSecrets(value))
    throw new BrainError('policy-denied', 'Transfer now matches secret material; preview again.');
  target.recheck();
  throwIfCancelled(options.signal);
  const temp = join(
    dirname(target.file),
    '.' + basename(target.file) + '-' + randomUUID() + '.tmp',
  );
  let created = false;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    target.recheck();
    throwIfCancelled(options.signal);
    fs.linkSync(temp, target.file);
    const parent = fs.openSync(dirname(target.file), 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
    return { ...receipt, preview: false };
  } finally {
    if (created)
      try {
        target.recheck();
        fs.unlinkSync(temp);
      } catch {
        /* Preserve replaced directories. */
      }
  }
}
