import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as config from '../src/config.js';
import * as hooks from '../src/hooks.js';
import { fixture } from './helpers/brain.js';
import {
  initBrain,
  noteBrain,
  exportKnowledgeGraphFile,
  exportBrain,
  importBrain,
  parseBrainBundle,
  parseExchangeArchive,
  makeExchange,
  BrainError,
  runBrainCommand,
  brainLines,
} from '../src/brain/index.js';
let f: ReturnType<typeof fixture>;
const opts = () => ({ base: f.base, confirmation: 'none' as const });
beforeEach(async () => {
  f = fixture();
  config.resetConfig();
  hooks.saveHooks([]);
  await initBrain(f.cwd, opts());
});
afterEach(() => {
  f.clean();
  config.resetConfig();
  hooks.saveHooks([]);
  vi.restoreAllMocks();
});
it('previews graph loss and requires acknowledgement before exclusive private output', async () => {
  await noteBrain(f.cwd, 'SQLite', 'Choose portable storage', 'decision', opts());
  const before = f.store.read();
  const preview = await exportKnowledgeGraphFile(f.cwd, 'graph.json', {
    ...opts(),
    preview: true,
  });
  expect(preview.report.losses[0]!.code).toBe('graph-history');
  expect(fs.existsSync(preview.path)).toBe(false);
  await expect(exportKnowledgeGraphFile(f.cwd, 'graph.json', opts())).rejects.toMatchObject({
    report: preview.report,
  });
  const result = await exportKnowledgeGraphFile(f.cwd, 'graph.json', {
    ...opts(),
    allowLoss: true,
  });
  expect(JSON.parse(fs.readFileSync(result.path, 'utf8')).format).toBe('calliope-kg/v1');
  expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
  await expect(
    exportKnowledgeGraphFile(f.cwd, 'graph.json', {
      ...opts(),
      allowLoss: true,
    }),
  ).rejects.toThrow();
  expect(f.store.read()).toEqual(before);
});
it('exports explicit scope/profile/capability claims inside a validated v2 archive', async () => {
  await noteBrain(f.cwd, 'Design', 'Knowledge system', 'decision', opts());
  const manifest = {
    scope: 'product',
    profiles: ['core'],
    capabilities: ['context-read'],
  };
  fs.writeFileSync(join(f.cwd, 'manifest.json'), JSON.stringify(manifest));
  await expect(
    exportKnowledgeGraphFile(f.cwd, 'graph.json', {
      ...opts(),
      manifestPath: 'manifest.json',
    }),
  ).rejects.toThrow('requires --exchange');
  const result = await exportKnowledgeGraphFile(f.cwd, 'graph.json', {
    ...opts(),
    allowLoss: true,
    exchange: true,
    manifestPath: 'manifest.json',
  });
  const archive = parseExchangeArchive(JSON.parse(fs.readFileSync(result.path, 'utf8')));
  expect(archive.manifest).toEqual(manifest);
  expect(archive.origin).toEqual(result.report.origin);
  fs.writeFileSync(join(f.cwd, 'array.json'), '[]');
  await expect(
    exportKnowledgeGraphFile(f.cwd, 'bad.json', {
      ...opts(),
      exchange: true,
      manifestPath: 'array.json',
    }),
  ).rejects.toThrow('object');
});
it('honors read and write denials and revocation after export approval', async () => {
  await noteBrain(f.cwd, 'Design', 'A claim', 'decision', opts());
  await expect(
    exportKnowledgeGraphFile(f.cwd, 'denied.json', {
      base: f.base,
      allowLoss: true,
    }),
  ).rejects.toThrow('denied');
  let revoked = false;
  await expect(
    exportKnowledgeGraphFile(f.cwd, 'denied.json', {
      ...opts(),
      allowLoss: true,
      confirmation: 'mutating',
      authorizeSource: () => {
        if (revoked) throw new BrainError('policy-denied', 'Revoked source');
      },
      approve: async () => {
        revoked = true;
        return 'allow';
      },
    }),
  ).rejects.toThrow('Revoked source');
  expect(fs.existsSync(join(f.cwd, 'denied.json'))).toBe(false);
});
it('rejects manifest changes during export review', async () => {
  fs.writeFileSync(join(f.cwd, 'manifest.json'), '{}');
  await expect(
    exportKnowledgeGraphFile(f.cwd, 'denied.json', {
      ...opts(),
      allowLoss: true,
      exchange: true,
      manifestPath: 'manifest.json',
      confirmation: 'mutating',
      approve: async () => {
        fs.writeFileSync(join(f.cwd, 'manifest.json'), '{"scope":"changed"}');
        return 'allow';
      },
    }),
  ).rejects.toThrow('Source content changed');
  expect(fs.existsSync(join(f.cwd, 'denied.json'))).toBe(false);
});
it('runs the shared native correction/reversal fixture through native import and full journal export', async () => {
  const raw = fs.readFileSync(
    new URL('./fixtures/brain-interchange/cli-bundle.json', import.meta.url),
    'utf8',
  );
  const original = parseBrainBundle(JSON.parse(raw));
  expect(original.journal.events).toHaveLength(3);
  expect(original.journal.events.some((event) => event.reverses)).toBe(true);
  fs.writeFileSync(join(f.cwd, 'native.json'), raw);
  const imported = await importBrain(f.cwd, 'native.json', opts());
  expect(Object.keys(imported.state.entities).length).toBeGreaterThan(0);
  const repeated = await importBrain(f.cwd, 'native.json', opts());
  expect(repeated.imported).toBe(0);
  fs.writeFileSync(join(f.cwd, 'native-copy.json'), JSON.stringify(original, null, 2));
  expect((await importBrain(f.cwd, 'native-copy.json', opts())).imported).toBe(0);
  const output = await exportBrain(f.cwd, 'full.json', opts());
  expect(parseBrainBundle(JSON.parse(fs.readFileSync(output.path, 'utf8'))).journal).toEqual(
    imported.journal,
  );
  await expect(
    importBrain(f.cwd, 'native.json', {
      ...opts(),
      authorizeSource: () => {
        throw new BrainError('policy-denied', 'Restricted');
      },
    }),
  ).rejects.toThrow('Restricted');
});
it('wraps and imports native history with manifest claims while verifying replay and origin binding', async () => {
  await noteBrain(f.cwd, 'Review', 'Original source claim', 'decision', opts());
  const origin = f.store.read();
  fs.writeFileSync(join(f.cwd, 'manifest.json'), '{"scope":"company","profiles":["core"]}');
  const output = await exportBrain(f.cwd, 'native-exchange.json', {
    ...opts(),
    exchange: true,
    manifestPath: 'manifest.json',
  });
  const archive = parseExchangeArchive(JSON.parse(fs.readFileSync(output.path, 'utf8')));
  expect(parseBrainBundle(archive.payload).journal).toEqual(origin.journal);
  await initBrain(f.cwd, { ...opts(), scope: 'global' });
  const imported = await importBrain(f.cwd, 'native-exchange.json', {
    ...opts(),
    scope: 'global',
  });
  expect(imported.transfer?.representation).toBe('journal-snapshot');
  expect(
    JSON.parse(imported.state.sources[imported.transfer!.metadataSourceId]!.content).manifest,
  ).toEqual(archive.manifest);
  const again = await importBrain(f.cwd, 'native-exchange.json', {
    ...opts(),
    scope: 'global',
  });
  expect(again.imported).toBe(0);
  const wrong = makeExchange(
    archive.payload,
    { ...archive.origin, revision: 'wrong' },
    archive.manifest,
  );
  fs.writeFileSync(join(f.cwd, 'wrong.json'), JSON.stringify(wrong));
  await expect(importBrain(f.cwd, 'wrong.json', opts())).rejects.toThrow('must match');
});
it('CLI exposes a versioned preview, acknowledgement error, commit and idempotent receipt', async () => {
  const kg = {
    format: 'conflict-kg/v1',
    nodes: [{ id: 'a', name: 'Alpha', type: 'decision', props: { confidence: 0.9 } }],
    edges: [],
  };
  fs.writeFileSync(join(f.cwd, 'input.json'), JSON.stringify(kg));
  let output = '';
  const run = async (args: string[]) => {
    output = '';
    return runBrainCommand(args, {
      ...opts(),
      cwd: f.cwd,
      write: (text) => {
        output += text;
      },
    });
  };
  const args = ['import', 'input.json', '--kg', '--origin', 'fixture', '--json'];
  expect(await run([...args, '--preview'])).toBe(0);
  expect(JSON.parse(output).data.preview).toBe(true);
  expect(await run(args)).toBe(2);
  expect(JSON.parse(output).error.report.losses[0].code).toBe('graph-history');
  expect(await run([...args, '--allow-loss'])).toBe(0);
  expect(JSON.parse(output).data.imported).toBe(3);
  expect(await run(args)).toBe(0);
  expect(JSON.parse(output).data.unchanged).toBe(true);
  expect(await run(['export', 'out.json', '--kg', '--exchange', '--preview', '--json'])).toBe(0);
  expect(JSON.parse(output).data.preview).toBe(true);
  expect(fs.existsSync(join(f.cwd, 'out.json'))).toBe(false);
  expect(await run(['import', 'input.json', '--preview', '--json'])).toBe(2);
  expect(await run(['status', '--origin', 'fixture', '--json'])).toBe(2);
});
it('terminal output explains losses and preview without exposing retained claims', async () => {
  const preview = await exportKnowledgeGraphFile(f.cwd, 'out.json', {
    ...opts(),
    preview: true,
  });
  expect(brainLines('export', preview).join('\n')).toContain('Preview only');
  let output = '';
  expect(
    await runBrainCommand(['export', 'out.json', '--kg'], {
      ...opts(),
      cwd: f.cwd,
      write: (text) => {
        output += text;
      },
    }),
  ).toBe(2);
  expect(output).toContain('graph-history');
  expect(output).toContain('--allow-loss');
});

it('imports a real Studio 1.2.0 producer under both graph aliases and as a native journal', async () => {
  const read = (name: string) =>
    fs.readFileSync(new URL('./fixtures/brain-interchange/' + name, import.meta.url), 'utf8');
  const bundle = parseBrainBundle(JSON.parse(read('studio-native.json')));
  fs.writeFileSync(join(f.cwd, 'studio-native.json'), JSON.stringify(bundle));
  const native = await importBrain(f.cwd, 'studio-native.json', opts());
  expect(Object.keys(native.state.entities).length).toBeGreaterThan(0);
  expect(Object.values(native.state.entities).every((record) => record.state === 'proposed')).toBe(
    true,
  );
  const graph = JSON.parse(read('studio-graph.json'));
  fs.writeFileSync(join(f.cwd, 'studio-graph.json'), JSON.stringify(graph));
  const { importKnowledgeGraph } = await import('../src/brain/index.js');
  const options = { ...opts(), allowLoss: true, origin: bundle.journal.header.id };
  const first = await importKnowledgeGraph(f.cwd, 'studio-graph.json', options);
  expect(first.report.losses.some((loss) => loss.code === 'unsupported-kind')).toBe(true);
  graph.format = 'conflict-kg/v1';
  fs.writeFileSync(join(f.cwd, 'studio-alias.json'), JSON.stringify(graph, null, 2));
  const repeat = await importKnowledgeGraph(f.cwd, 'studio-alias.json', options);
  expect(repeat.unchanged).toBe(true);
});
