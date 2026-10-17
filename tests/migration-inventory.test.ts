import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { inventorySource, dependencyGraph, runMigrationCommand, INVENTORY_SCHEMA, type Package } from '../src/migration/index.js';
import { canonicalJson, digest } from '../src/approvals/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function repo(files: Record<string, string> = { 'index.js': 'module.exports = x => x + 1;' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-inventory-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  const put = (name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
  for (const [name, text] of Object.entries(files)) put(name, text);
  const commit = () => { git('add', '.'); git('commit', '-qm', 'Fixture'); return git('rev-parse', 'HEAD'); };
  return { root, git, put, commit, revision: commit() };
}
const pkg = (name: string, dependencies: Record<string, string> = {}, extra = {}) => JSON.stringify({ name, dependencies, ...extra });
const inspect = (r: ReturnType<typeof repo>, readPaths?: string[]) => inventorySource({ repository: r.root, revision: r.revision, ...(readPaths ? { readPaths } : {}) });

describe('pinned migration inventory', () => {
  it('reads immutable Git objects, preserves dirty/untracked files and index, and reports reproducible evidence', async () => {
    const r = repo({ 'src/a.ts': 'export const a: number = 1;', 'tests/a.test.ts': 'test evidence', 'tsconfig.json': '{}', 'package-lock.json': '{}', 'package.json': pkg('a', {}, { scripts: { build: 'touch MUST_NOT_RUN', test: 'echo SECRET_TEST_COMMAND' } }) });
    const original = await inspect(r); const index = fs.readFileSync(path.join(r.root, '.git/index'));
    r.put('src/a.ts', 'dirty'); r.put('untracked.txt', 'private');
    expect(await inspect(r)).toEqual(original); expect(fs.readFileSync(path.join(r.root, '.git/index'))).toEqual(index);
    expect(fs.readFileSync(path.join(r.root, 'src/a.ts'), 'utf8')).toBe('dirty'); expect(fs.existsSync(path.join(r.root, 'MUST_NOT_RUN'))).toBe(false);
    expect(original.files.map(f => f.surface)).toEqual(['lockfile', 'manifest', 'source', 'test', 'build-config']);
    expect(original.packages[0]?.scripts).toEqual(['build', 'test']); expect(JSON.stringify(original)).not.toContain('SECRET_TEST_COMMAND');
    const { digest: actual, ...body } = original; expect(actual).toBe(digest(canonicalJson(body)));
    const newer = r.commit(); expect((await inventorySource({ repository: r.root, revision: newer })).digest).not.toBe(actual);
    expect(await inspect(r)).toEqual(original);
  });
  it('resolves declared local package dependencies in dependency-first order and identifies missing/external evidence', async () => {
    const r = repo({ 'package.json': pkg('root', { a: 'workspace:*' }), 'packages/a/package.json': pkg('a', { b: 'file:../b', missing: 'workspace:*', external: '^2.0.0', remote: 'https://user:SECRET_TOKEN@example.test/pkg' }), 'packages/b/package.json': pkg('b'), 'pyproject.toml': '[project]' });
    const value = await inspect(r);
    expect(value.graph.order).toEqual(['packages/b/package.json', 'packages/a/package.json', 'package.json']);
    expect(value.graph.cycles).toEqual([]); expect(value.findings).toContainEqual({ code: 'unresolved-local-dependency', path: 'packages/a/package.json', dependency: 'missing' });
    expect(value.findings).toContainEqual({ code: 'dependency-format-not-analyzed', path: 'pyproject.toml' });
    expect(value.findings).toContainEqual({ code: 'opaque-dependency-spec', path: 'packages/a/package.json', dependency: 'remote' });
    expect(JSON.stringify(value)).not.toContain('SECRET_TOKEN'); expect(JSON.stringify(value)).not.toContain('user:');
  });
  it('reports exact cycle components, including self cycles, without calling their dependants cyclic', async () => {
    const r = repo({ 'package.json': pkg('root', { a: 'workspace:*' }), 'a/package.json': pkg('a', { b: 'workspace:^' }), 'b/package.json': pkg('b', { a: 'workspace:~' }), 'c/package.json': pkg('c', { c: 'workspace:*' }) });
    const value = await inspect(r); expect(value.graph.order).toBeNull(); expect(value.graph.cycles).toEqual([['a/package.json', 'b/package.json'], ['c/package.json']]);
  });
  it('does not infer ambiguous workspace names or aliases', async () => {
    const r = repo({ 'package.json': pkg('root', { a: 'workspace:*', alias: 'workspace:a@*' }), 'a/package.json': pkg('a'), 'duplicate/package.json': pkg('a'), 'alias/package.json': pkg('alias') });
    const value = await inspect(r); expect(value.packages.find(p => p.name === 'root')?.dependencies.every(d => d.target === null)).toBe(true);
    expect(value.findings.some(f => f.code === 'opaque-dependency-spec' && f.dependency === 'alias')).toBe(true);
  });
  it('limits exported evidence to literal read paths and does not resolve out-of-scope packages', async () => {
    const r = repo({ 'a/package.json': pkg('a', { b: 'file:../b' }), 'b/package.json': pkg('b'), 'a[*]/package.json': pkg('literal') });
    const value = await inspect(r, ['a']); expect(value.files.map(f => f.path)).toEqual(['a/package.json']); expect(value.packages[0]?.dependencies[0]?.target).toBeNull();
    expect(JSON.stringify(value)).not.toContain('b/package.json');
    expect((await inspect(r, ['a[*]'])).files.map(f => f.path)).toEqual(['a[*]/package.json']);
  });
  it('does not traverse symlinks or submodules, execute config/filter helpers or use Git replacement objects', async () => {
    const r = repo({ 'package.json': pkg('original'), '.gitattributes': '* filter=malicious' });
    fs.symlinkSync('/outside/private', path.join(r.root, 'outside'));
    r.git('config', 'filter.malicious.smudge', 'touch MUST_NOT_RUN');
    r.git('update-index', '--add', '--cacheinfo', '160000,' + r.revision + ',submodule');
    r.git('add', 'outside'); r.git('commit', '-qm', 'Links'); r.revision = r.git('rev-parse', 'HEAD');
    r.git('branch', 'baseline', r.revision); r.put('package.json', pkg('replacement')); const newer = r.commit();
    r.git('replace', r.revision, newer);
    const value = await inspect(r); expect(value.packages[0]?.name).toBe('original');
    expect(value.files.find(f => f.path === 'outside')?.surface).toBe('symlink'); expect(value.files.find(f => f.path === 'submodule')?.surface).toBe('submodule');
    expect(fs.existsSync(path.join(r.root, 'MUST_NOT_RUN'))).toBe(false);
  });
  it('keeps unsupported/malformed/oversized manifests explicit', async () => {
    const r = repo({ 'bad/package.json': '{', 'array/package.json': '[]', 'large/package.json': ' '.repeat(262145), 'other/package.json': JSON.stringify({ name: 'Invalid Name', scripts: [], dependencies: { bad: 3 } }), 'source.py': 'pass' });
    const value = await inspect(r); expect(value.findings.map(f => f.code)).toContain('manifest-analysis-limit'); expect(value.findings.map(f => f.code)).toContain('invalid-package-json'); expect(value.findings.map(f => f.code)).toContain('invalid-dependency');
  });
  it('refuses partial clones before object lookup, even when their current objects are local', async () => {
    const r = repo(); r.git('config', 'remote.origin.promisor', 'true');
    await expect(inspect(r)).rejects.toThrow('complete local clone');
    r.git('config', '--unset', 'remote.origin.promisor');
    r.git('config', 'extensions.partialclone', 'origin');
    await expect(inspect(r)).rejects.toThrow('complete local clone');
  });
  it('reports invalid dependency sections without treating them as an empty verified map', async () => {
    const r = repo({ 'package.json': pkg('a', {}, { devDependencies: ['unparsed'] }) });
    expect((await inspect(r)).findings).toContainEqual({ code: 'invalid-dependency-map', path: 'package.json' });
  });
  it.each(['HEAD', '--help', 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65)])('refuses mutable or malformed revisions: %s', async revision => {
    const r = repo(); await expect(inventorySource({ repository: r.root, revision })).rejects.toThrow('immutable commit');
  });
  it('refuses tags, nonexistent commits, subdirectory roots and empty scope', async () => {
    const r = repo({ 'src/a.js': 'a' }); r.git('tag', '-am', 'Tag', 'fixture-tag');
    await expect(inventorySource({ repository: r.root, revision: r.git('rev-parse', 'fixture-tag') })).rejects.toThrow('commit object');
    await expect(inventorySource({ repository: r.root, revision: '0'.repeat(40) })).rejects.toThrow();
    await expect(inventorySource({ repository: path.join(r.root, 'src'), revision: r.revision })).rejects.toThrow('repository root');
    await expect(inspect(r, ['missing'])).rejects.toThrow('no tracked files');
  });
  it.each([[], ['../secret'], ['/private'], ['a\\b'], ['.git'], ['a/../b']].map(readPaths => ({ readPaths })))('refuses invalid explicit scopes: $readPaths', async ({ readPaths }) => { const r = repo(); await expect(inspect(r, readPaths)).rejects.toThrow(); });
  it('cancels before reading and rejects oversized inventories/dependency maps', async () => {
    const r = repo(); await expect(inventorySource({ repository: r.root, revision: r.revision }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    r.put('package.json', pkg('huge', Object.fromEntries(Array.from({ length: 2049 }, (_, i) => ['dep' + i, '*'])))); r.revision = r.commit();
    await expect(inspect(r)).rejects.toThrow('2,048');
    // The reader inventories Git objects, not working files. Construct a real
    // oversized tree without thousands of unrelated filesystem writes.
    const blob = r.git('rev-parse', r.revision + ':index.js');
    const tree = execFileSync('git', ['mktree'], { cwd: r.root, encoding: 'utf8',
      input: Array.from({ length: 5001 }, (_, i) => `100644 blob ${blob}\tfile-${i}\n`).join(''),
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    r.revision = r.git('commit-tree', tree, '-m', 'Oversized inventory');
    await expect(inspect(r)).rejects.toThrow('5,000');
  });
  it('provides CLI capabilities/schema without credentials and structured failures without leaking input', async () => {
    const lines: string[] = [], write = (line: string) => { lines.push(line); };
    expect(await runMigrationCommand(['capabilities', '--json'], { write })).toBe(0); expect(JSON.parse(lines.pop()!).phases).toEqual(['inventory']);
    expect(await runMigrationCommand(['schema', '--json'], { write })).toBe(0); expect(JSON.parse(lines.pop()!)).toEqual(INVENTORY_SCHEMA);
    const r = repo(); expect(await runMigrationCommand(['inventory', '--repository', r.root, '--revision', r.revision, '--json'], { write })).toBe(0); expect(JSON.parse(lines.pop()!).digest).toBe((await inspect(r)).digest);
    expect(await runMigrationCommand(['inventory', '--repository', '/missing/SECRET', '--revision', r.revision, '--json'], { write })).toBe(1); expect(lines.pop()).not.toContain('SECRET');
    expect(await runMigrationCommand(['inventory', '--repository', r.root, '--revision', r.revision, '--json'], { write, signal: AbortSignal.abort() })).toBe(130);
    expect(await runMigrationCommand(['schema', '--revision', r.revision, '--json'], { write })).toBe(1);
    expect(await runMigrationCommand(['inventory', '--unknown', 'secret', '--json'], { write })).toBe(1); expect(lines.pop()).not.toContain('secret');
    expect(await runMigrationCommand(['inventory', '--repository', r.root, '--revision', r.revision], { write })).toBe(0); expect(lines.pop()).toContain('No repository code was executed');
  });
  it('handles an empty package graph', () => { expect(dependencyGraph([] as Package[])).toEqual({ order: [], cycles: [] }); });
});
