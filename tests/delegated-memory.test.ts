/** Project trust alone cannot widen the parent's granted file scope. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildMemoryContext, getGlobalMemoryPath } from '../src/memory.js';
import { trustProject } from '../src/trust.js';
import { ExecutionGuard, ReservationLedger, manifestHash } from '../src/execution/index.js';
import { executionManifest } from './helpers/execution-manifest.js';
let root: string, project: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-delegated-memory-'))); project = join(root, 'project'); mkdirSync(project); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(getGlobalMemoryPath(), { force: true }); });
function context(paths: string[]) {
  const manifest = executionManifest(project);
  manifest.accounts[1]!.allowedPaths = paths.map(path => ({ path, access: 'read' }));
  const ledger = new ReservationLedger(join(root, 'budget')); ledger.create(manifest);
  const guard = new ExecutionGuard({ ledger, manifestHash: manifestHash(manifest), agentId: 'a', maxOutputTokens: 100 }, project);
  return buildMemoryContext(project, { allowPath: path => !guard.check({ id: 'context', name: 'read_file', arguments: { path } }) });
}
it('includes allowed memory/context and trusted global preferences, but excludes denied project files', () => {
  writeFileSync(join(project, 'CALLIOPE.md'), '## Context\n- allowed project context\n');
  writeFileSync(join(project, 'README.md'), 'allowed readme');
  writeFileSync(join(project, 'CLAUDE.md'), 'denied claude');
  mkdirSync(dirname(getGlobalMemoryPath()), { recursive: true });
  writeFileSync(getGlobalMemoryPath(), '## Preferences\n- global trusted preference\n');
  trustProject(project);
  const value = context(['CALLIOPE.md', 'README.md']);
  expect(value).toContain('allowed project context'); expect(value).toContain('allowed readme');
  expect(value).toContain('global trusted preference'); expect(value).not.toContain('denied claude');
});
it('excludes parent memory and context symlinks outside the exact workspace', () => {
  writeFileSync(join(root, 'CALLIOPE.md'), '## Context\n- ancestor secret\n');
  writeFileSync(join(root, 'secret.txt'), 'symlink secret');
  symlinkSync(join(root, 'secret.txt'), join(project, 'README.md'));
  trustProject(project);
  const value = context(['.']);
  expect(value).not.toContain('ancestor secret'); expect(value).not.toContain('symlink secret');
});
it('does not turn file grants into project trust', () => {
  writeFileSync(join(project, 'README.md'), 'untrusted readme');
  expect(context(['.'])).not.toContain('untrusted readme');
});
