import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { BrainStore } from '../src/brain/index.js';
import { fixture, changes, entity, source } from './helpers/brain.js';
const fixtures: ReturnType<typeof fixture>[] = [];
const setup = () => {
  const f = fixture();
  fixtures.push(f);
  return f;
};
afterEach(() => fixtures.splice(0).forEach((f) => f.clean()));
it('initializes, persists and restarts private project/global scopes without changing source files', async () => {
  const f = setup();
  fs.writeFileSync(join(f.cwd, 'README.md'), 'Original');
  expect(() => f.store.read()).toThrow('brain init');
  const initial = await f.store.init(),
    again = await f.store.init();
  expect(again).toEqual(initial);
  const a = await f.store.append(changes(entity()), 'human', 'Reviewed architecture');
  expect(new BrainStore(f.cwd, 'project', f.base).read()).toEqual(a);
  expect(fs.readFileSync(join(f.cwd, 'README.md'), 'utf8')).toBe('Original');
  expect(fs.statSync(join(f.store.root, 'history.json')).mode & 0o777).toBe(0o600);
  const global = new BrainStore(f.cwd, 'global', f.base);
  expect((await global.init()).state.header.project).toBeNull();
  expect(global.read().state.entities).toEqual({});
  expect(() => new BrainStore(f.cwd, 'wrong' as never, f.base)).toThrow('scope');
  expect(() => new BrainStore(f.cwd, 'project', join(f.cwd, 'brain'))).toThrow();
});
it('serializes concurrent writers and rejects stale review revisions without losing events', async () => {
  const f = setup();
  const initial = await f.store.init();
  await Promise.all([
    f.store.append(changes(entity('one')), 'human', 'One'),
    f.store.append(changes(entity('two')), 'human', 'Two'),
  ]);
  expect(Object.keys(f.store.read().state.entities).sort()).toEqual(['one', 'two']);
  expect(f.store.read().journal.events).toHaveLength(2);
  await expect(
    f.store.append(changes(entity('three')), 'human', 'Stale', {
      expectedRevision: initial.state.revision,
    }),
  ).rejects.toThrow('during review');
});
it('retains immutable source evidence when reversing and refuses conflicting later corrections', async () => {
  const f = setup();
  await f.store.init();
  const added = await f.store.append(changes(entity()), 'human', 'First');
  const edited = await f.store.append(
    [
      {
        kind: 'entity',
        id: 'document',
        expected: added.journal.events[0]!.id,
        value: entity('document', { name: 'Corrected' }),
      },
    ],
    'human',
    'Correction',
  );
  await expect(f.store.reverse(added.journal.events[0]!.id, 'Undo original')).rejects.toThrow(
    'Knowledge changed',
  );
  expect(
    (await f.store.reverse(edited.journal.events[1]!.id, 'Undo correction')).state.entities.document
      ?.name,
  ).toBe('Architecture');
  await expect(f.store.reverse('unknown', 'Undo')).rejects.toThrow('Unknown brain event');
  const evidence = await f.store.append(
    [{ kind: 'source', value: source('other') }],
    'human',
    'Evidence',
  );
  await expect(
    f.store.reverse(evidence.journal.events.at(-1)!.id, 'Undo evidence'),
  ).rejects.toThrow('immutable');
});
it('cancels before commit and detects last-moment history replacement', async () => {
  const f = setup();
  await f.store.init();
  const file = join(f.store.root, 'history.json'),
    original = fs.readFileSync(file),
    controller = new AbortController();
  await expect(
    f.store.append(changes(entity()), 'human', 'Cancelled', {
      signal: controller.signal,
      beforeCommit: () => controller.abort(),
    }),
  ).rejects.toThrow();
  expect(fs.readFileSync(file)).toEqual(original);
  await expect(
    f.store.append(changes(entity()), 'human', 'Raced', {
      beforeCommit: () => fs.writeFileSync(file, '{}'),
    }),
  ).rejects.toThrow('changed during final checks');
  expect(fs.readFileSync(file, 'utf8')).toBe('{}');
  expect(fs.readdirSync(f.store.root)).toEqual(['history.json']);
});
it('fails closed on broken history, aliases, shared file identities and moved project identities', async () => {
  const f = setup();
  await f.store.init();
  const file = join(f.store.root, 'history.json'),
    raw = fs.readFileSync(file);
  fs.writeFileSync(file, '{');
  expect(() => f.store.read()).toThrow('unreadable');
  fs.writeFileSync(file, raw);
  fs.linkSync(file, join(f.root, 'shared'));
  expect(() => f.store.read()).toThrow('share');
  fs.unlinkSync(join(f.root, 'shared'));
  fs.chmodSync(file, 0o644);
  expect(() => f.store.read()).toThrow();
  fs.chmodSync(file, 0o600);
  fs.renameSync(file, file + '.saved');
  fs.symlinkSync(file + '.saved', file);
  expect(() => f.store.read()).toThrow();
  fs.unlinkSync(file);
  fs.renameSync(file + '.saved', file);
  fs.renameSync(f.cwd, f.cwd + '.old');
  fs.mkdirSync(f.cwd);
  expect(() => f.store.read()).toThrow('identity');
});
it('does not delete a foreign replacement namespace after a failed write', async () => {
  const f = setup();
  await f.store.init();
  await expect(
    f.store.append(changes(entity()), 'human', 'Raced', {
      beforeCommit: () => {
        const root = f.store.root;
        fs.renameSync(root, root + '.old');
        fs.mkdirSync(root, { mode: 0o700 });
        for (const name of fs.readdirSync(root + '.old'))
          fs.writeFileSync(join(root, name), 'foreign', { mode: 0o600 });
      },
    }),
  ).rejects.toThrow('ownership');
  expect(fs.readdirSync(f.store.root).some((n) => n.endsWith('.tmp'))).toBe(true);
  expect(fs.readFileSync(join(f.store.root, 'writer.lock'), 'utf8')).toBe('foreign');
});
it('handles incomplete initialization, unavailable stores and cancelled lock acquisition', async () => {
  const f = setup();
  fs.mkdirSync(f.base, { mode: 0o700 });
  fs.mkdirSync(f.store.root, { mode: 0o700 });
  expect(() => f.store.read()).toThrow('incomplete');
  await f.store.init();
  fs.writeFileSync(join(f.store.root, 'writer.lock'), String(process.pid), { mode: 0o600 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await expect(
    f.store.append(changes(entity()), 'human', 'Wait', { signal: controller.signal }),
  ).rejects.toThrow();
  expect(fs.existsSync(join(f.store.root, 'writer.lock'))).toBe(true);
  await expect(f.store.init({ signal: AbortSignal.abort() })).rejects.toThrow();
});
it('rebuilds and persists a revision-bound index and rejects outdated replacement', async () => {
  const f = setup();
  await f.store.init();
  await f.store.append(changes(entity()), 'human', 'First');
  const index = await f.store.index();
  expect(index.cache).toBe('rebuilt');
  expect(index.search('portable')).toHaveLength(1);
  await f.store.saveIndex(index);
  const restart = await f.store.index();
  expect(restart.cache).toBe('valid');
  restart.close();
  await f.store.append(changes(entity('second')), 'human', 'Second');
  await expect(f.store.saveIndex(index)).rejects.toThrow('changed before index');
  index.close();
  const next = await f.store.index();
  const controller = new AbortController();
  await expect(
    f.store.saveIndex(next, { signal: controller.signal, beforeCommit: () => controller.abort() }),
  ).rejects.toThrow();
  next.close();
  fs.writeFileSync(join(f.store.root, 'index.sqlite'), 'damaged');
  const rebuilt = await f.store.index();
  expect(rebuilt.cache).toBe('rebuilt');
  expect(rebuilt.search('portable')).toHaveLength(2);
  rebuilt.close();
  expect(fs.readFileSync(join(f.store.root, 'index.sqlite'), 'utf8')).toBe('damaged');
});
