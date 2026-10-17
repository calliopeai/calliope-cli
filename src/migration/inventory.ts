/** Deterministic read-only input evidence for migration planning, not a feasibility verdict. */
import { realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { canonicalJson, digest } from '../approvals/index.js';
import { worktreeGit } from '../isolation/worktree.js';
import { throwIfCancelled } from '../cancellation.js';

export const KIT_VERSION = 'inventory-v1';
export class MigrationError extends Error {
  constructor(readonly code: 'invalid' | 'limit' | 'unavailable', message: string) { super(message); this.name = 'MigrationError'; }
}
const fail = (message: string): never => { throw new MigrationError('invalid', message); };
const oid = (s: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s);
const name = (s: string) => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(s) && s.length <= 214;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function sourcePath(value: string): string {
  if (!value || value.length > 1024 || /[\x00-\x1f\x7f\\\ufffd]/.test(value) || value !== '.' && (posix.isAbsolute(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'))) fail('Use normalized repository-relative read paths.');
  return value;
}
export type SourceFile = { path: string; object: string; bytes: number | null; mode: string; surface: string };
export type Finding = { code: string; path: string; dependency?: string };
export type Dependency = { name: string; section: string; kind: string; specDigest: string; displaySpec: string | null; target: string | null };
export type Package = { path: string; name: string | null; scripts: string[]; dependencies: Dependency[] };
const sorted = (xs: string[]) => [...new Set(xs)].sort();
function surface(path: string, mode: string): string {
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'submodule';
  const base = posix.basename(path);
  if (/(^|\/)(__tests__|tests?|specs?)(\/|$)|[.-](test|spec)\.[^.]+$/.test(path)) return 'test';
  if (/^(package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|Gemfile|pom\.xml)$/.test(base)) return 'manifest';
  if (/^(.*lock.*|.*\.lock)$/.test(base)) return 'lockfile';
  if (/^(Makefile|Dockerfile[^/]*|tsconfig[^/]*\.json|.*\.config\.[^.]+|build\.gradle[^/]*)$/.test(base) || path.startsWith('.github/workflows/')) return 'build-config';
  if (/\.(?:[cm]?[jt]sx?|py|go|rs|java|c|cpp|h|rb|cs|sh)$/.test(base)) return 'source';
  return 'other';
}
function dependencyKind(spec: string): string {
  if (/^workspace:(?:[*^~]|[~^<>=v0-9.*xX| -]+)$/.test(spec)) return 'workspace';
  if (spec.startsWith('file:')) return 'file';
  return /^(?:[~^<>=v0-9.*xX| -]+|[a-z][a-z0-9.-]*)$/.test(spec) ? 'registry' : 'opaque';
}
/** Return dependency-first batches or the exact strongly connected components. */
export function dependencyGraph(packages: Package[]): { order: string[] | null; cycles: string[][] } {
  const edges = new Map(packages.map(p => [p.path, sorted(p.dependencies.flatMap(d => d.target ? [d.target] : []))]));
  const indices = new Map<string, number>(), low = new Map<string, number>(), active = new Set<string>(), stack: string[] = [], cycles: string[][] = [], order: string[] = [];
  let index = 0;
  function visit(id: string): void {
    indices.set(id, index); low.set(id, index++); active.add(id); stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!indices.has(next)) { visit(next); low.set(id, Math.min(low.get(id)!, low.get(next)!)); }
      else if (active.has(next)) low.set(id, Math.min(low.get(id)!, indices.get(next)!));
    }
    if (low.get(id) === indices.get(id)) {
      const group: string[] = []; let popped: string;
      do { popped = stack.pop()!; active.delete(popped); group.push(popped); } while (popped !== id);
      if (group.length > 1 || edges.get(id)?.includes(id)) cycles.push(group.sort());
    }
    order.push(id);
  }
  for (const id of [...edges.keys()].sort()) if (!indices.has(id)) visit(id);
  return { order: cycles.length ? null : order, cycles: cycles.sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0) };
}

export async function inventorySource(input: { repository: string; revision: string; readPaths?: string[] }, options: { signal?: AbortSignal } = {}) {
  if (!input || typeof input.repository !== 'string' || input.repository.length > 4096 || /[\x00-\x1f\x7f]/.test(input.repository) || typeof input.revision !== 'string' || !oid(input.revision)) fail('Select a local repository and its full immutable commit ID.');
  if (input.readPaths !== undefined && (!Array.isArray(input.readPaths) || input.readPaths.length < 1 || input.readPaths.length > 64 || input.readPaths.some(p => typeof p !== 'string'))) fail('Provide 1–64 explicit read paths.');
  const readPaths = sorted((input.readPaths ?? ['.']).map(sourcePath));
  const within = (path: string) => readPaths.some(p => p === '.' || p === path || path.startsWith(p + '/'));
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]);
  throwIfCancelled(signal);
  let root: string;
  try { root = realpathSync(input.repository); } catch { throw new MigrationError('unavailable', 'The selected repository is unavailable.'); }
  const git = (args: string[]) => worktreeGit(root, ['--no-replace-objects', ...args], signal);
  const top = (await git(['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '');
  if (realpathSync(top) !== root) fail('Select the repository root, not a subdirectory.');
  // Older Git versions may ignore GIT_NO_LAZY_FETCH. Refuse promisor clones
  // before resolving objects rather than allowing missing evidence to fetch.
  const partial = await worktreeGit(root, ['config', '--name-only', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], signal, [0, 1]);
  if (partial.trim()) fail('Inventory requires a complete local clone without lazy-fetch configuration.');
  const commit = (await git(['rev-parse', '--verify', input.revision + '^{commit}'])).trim();
  if (commit !== input.revision) fail('Select a commit object, not a tag or another object type.');
  const tree = (await git(['rev-parse', '--verify', commit + '^{tree}'])).trim();
  if (!oid(tree)) fail('The source tree identity is invalid.');
  const raw = await git(['ls-tree', '-rlz', commit, '--', ...readPaths.map(p => p === '.' ? ':' : ':(literal)' + p)]);
  const files: SourceFile[] = [];
  for (const line of raw.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64}) +([0-9]+|-)\t(.+)$/.exec(line);
    if (!match) fail('Unsupported Git tree entry.');
    const [, mode, type, id, length, path] = match as unknown as [string, string, string, string, string, string];
    sourcePath(path); if (!within(path) || !oid(id)) fail('Git returned an entry outside the requested read scope.');
    if (!['100644', '100755', '120000', '160000'].includes(mode) || (mode === '160000') !== (type === 'commit')) fail('Unsupported Git file mode.');
    const bytes = length === '-' ? null : Number(length);
    if ((type === 'blob') !== (bytes !== null) || bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0)) fail('Invalid source file size.');
    files.push({ path, object: id, bytes, mode, surface: surface(path, mode) });
    if (files.length > 5000) throw new MigrationError('limit', 'Keep one inventory within 5,000 tracked entries; narrow the read scope.');
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.length) fail('The selected revision has no tracked files in this read scope.');
  const findings: Finding[] = [], packages: Package[] = [];
  let manifestBytes = 0, dependencies = 0;
  for (const file of files) {
    if (['symlink', 'submodule'].includes(file.surface)) { findings.push({ code: 'not-traversed-' + file.surface, path: file.path }); continue; }
    if (file.surface === 'manifest' && posix.basename(file.path) !== 'package.json') findings.push({ code: 'dependency-format-not-analyzed', path: file.path });
    if (posix.basename(file.path) !== 'package.json') continue;
    if (packages.length >= 128 || file.bytes! > 262144 || manifestBytes + file.bytes! > 4194304) { findings.push({ code: 'manifest-analysis-limit', path: file.path }); continue; }
    manifestBytes += file.bytes!;
    const text = await git(['cat-file', 'blob', file.object]);
    let data: unknown;
    try { if (text.includes('\ufffd')) throw Error('Invalid UTF-8'); data = JSON.parse(text); } catch { findings.push({ code: 'invalid-package-json', path: file.path }); continue; }
    if (!object(data)) { findings.push({ code: 'invalid-package-json', path: file.path }); continue; }
    const pkg: Package = { path: file.path, name: typeof data.name === 'string' && name(data.name) ? data.name : null, scripts: [], dependencies: [] };
    if (!pkg.name) findings.push({ code: 'missing-or-invalid-package-name', path: file.path });
    if (data.scripts !== undefined) {
      if (!object(data.scripts)) findings.push({ code: 'invalid-package-scripts', path: file.path });
      else for (const [key, value] of Object.entries(data.scripts)) {
        if (/^[a-zA-Z0-9_.:-]{1,128}$/.test(key) && typeof value === 'string') pkg.scripts.push(key);
        else findings.push({ code: 'invalid-package-script', path: file.path });
      }
    }
    pkg.scripts.sort();
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (data[section] === undefined) continue;
      if (!object(data[section])) { findings.push({ code: 'invalid-dependency-map', path: file.path }); continue; }
      for (const [key, spec] of Object.entries(data[section]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (++dependencies > 2048) throw new MigrationError('limit', 'Keep one inventory within 2,048 declared dependencies.');
        if (!name(key) || typeof spec !== 'string' || spec.length > 8192) { findings.push({ code: 'invalid-dependency', path: file.path }); continue; }
        const kind = dependencyKind(spec);
        pkg.dependencies.push({ name: key, section, kind, specDigest: digest(spec), displaySpec: kind === 'registry' ? spec : null, target: null });
        if (kind === 'file') {
          const candidate = posix.normalize(posix.join(posix.dirname(file.path), spec.slice(5), 'package.json'));
          if (!/[\x00-\x1f\x7f\\%]/.test(spec) && !posix.isAbsolute(spec.slice(5)) && !candidate.startsWith('../') && within(candidate)) pkg.dependencies.at(-1)!.target = candidate;
        }
      }
    }
    packages.push(pkg);
  }
  const paths = new Set(packages.map(p => p.path));
  for (const pkg of packages) for (const dep of pkg.dependencies) {
    if (dep.kind === 'workspace') {
      const matches = packages.filter(p => p.name === dep.name);
      if (matches.length === 1) dep.target = matches[0]!.path;
    }
    if (dep.target && !paths.has(dep.target)) dep.target = null;
    if (['file', 'workspace'].includes(dep.kind) && !dep.target) findings.push({ code: 'unresolved-local-dependency', path: pkg.path, dependency: dep.name });
    if (dep.kind === 'opaque') findings.push({ code: 'opaque-dependency-spec', path: pkg.path, dependency: dep.name });
  }
  const graph = dependencyGraph(packages);
  const value = { format: 'calliope.migration.inventory/v1', kit: KIT_VERSION, source: { commit, tree, mode: 'committed-files-only', readPaths },
    files, packages, graph: { kind: 'declared-local-package-dependencies', ...graph }, findings,
    limitations: ['Source imports and dynamic dependencies are not analyzed.', 'Package resolution, installability and workspace membership are not verified.', 'Build/test scripts are identified by name only and were not executed.', 'Inventory is input evidence, not a baseline, feasibility recommendation or migration approval.'] };
  throwIfCancelled(signal);
  return { ...value, digest: digest(canonicalJson(value)) };
}
export type MigrationInventory = Awaited<ReturnType<typeof inventorySource>>;
