import * as fs from 'node:fs';
import { relative, resolve, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalPath, canonicalJson, digest, projectIdentity } from '../approvals/index.js';
import { getProviderCred, getProviderNames } from '../config.js';
import { redactSecrets } from '../runlog.js';
import {
  authorizeSessionAction,
  SessionPolicyError,
  type SessionActionOptions,
} from '../session-management/index.js';
import { readArtifactBytes } from '../orchestration/execution-store.js';
import { throwIfCancelled, isCancellation } from '../cancellation.js';
import { BrainStore } from './store.js';
import {
  BrainError,
  BRAIN_LIMITS,
  type BrainSource,
  type BrainEntity,
  type BrainEdge,
} from './types.js';
import { text } from './validation.js';
export interface BrainOptions extends SessionActionOptions {
  scope?: 'project' | 'global';
  base?: string;
  /** Trusted caller may narrow retained-source visibility beyond current project policy. */
  authorizeSource?: (source: BrainSource) => void | Promise<void>;
}
export const brainStore = (cwd: string, options: BrainOptions = {}) =>
  new BrainStore(cwd, options.scope, options.base);
export const byteHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Capture configured secrets once per structured scan; never cache them across operations. */
function brainSanitizer(): (value: string) => string {
  const secrets = [
    ...new Set(
      [
        ...getProviderNames().map((p) => getProviderCred(p).apiKey),
        ...Object.entries(process.env)
          .filter(([key]) => /(api.?key|token|secret|password|credential)/i.test(key))
          .map(([, value]) => value),
      ].filter((value): value is string => typeof value === 'string' && value.length >= 8),
    ),
  ].sort((a, b) => b.length - a.length);
  return (value) => {
    let result = value.replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    );
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    result = result.replace(
      /("[\w.-]*(?:api[-_]?key|token|secret|password|passwd|authorization|credential)[\w.-]*"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    );
    return String(redactSecrets(result));
  };
}
/** No model requests. Redact recognizable credentials and exact configured secret values. */
export const sanitizeBrainText = (value: string): string => brainSanitizer()(value);
export function sanitizeBrainValue<T>(value: T): T {
  const sanitize = brainSanitizer();
  const visit = (item: unknown): unknown =>
    typeof item === 'string'
      ? sanitize(item)
      : Array.isArray(item)
        ? item.map(visit)
        : item && typeof item === 'object'
          ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value)]))
          : item;
  return visit(redactSecrets(value)) as T;
}
export function hasBrainSecrets(value: unknown): boolean {
  const sanitize = brainSanitizer();
  const visit = (item: unknown): boolean =>
    typeof item === 'string'
      ? sanitize(item) !== item
      : Array.isArray(item)
        ? item.some(visit)
        : !!item &&
          typeof item === 'object' &&
          Object.entries(item).some(([key, value]) => visit(key) || visit(value));
  return visit(value);
}
export function projectFile(cwd: string, path: string, allowMissingParent = false) {
  text(path, 4096);
  const project = projectIdentity(cwd),
    file = resolve(project.project, path),
    rel = relative(project.project, file);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith('../') ||
    isAbsolute(rel) ||
    path.split(/[\\/]/).includes('..') ||
    canonicalPath(file) !== file
  )
    throw new BrainError(
      'policy-denied',
      'Brain files must stay inside the current project without traversal or aliases.',
    );
  let parent = dirname(file);
  if (allowMissingParent)
    while (!fs.existsSync(parent) && parent !== project.project) parent = dirname(parent);
  const before = fs.statSync(parent);
  const recheck = () => {
    const current = projectIdentity(project.project),
      after = fs.lstatSync(parent);
    if (
      current.projectKey !== project.projectKey ||
      canonicalPath(file) !== file ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      throw new BrainError('conflict', 'Source path changed during review.');
  };
  return { file, relative: rel, project, recheck };
}
export async function readBrainFile(
  cwd: string,
  path: string,
  options: BrainOptions = {},
  max = BRAIN_LIMITS.sourceBytes,
) {
  throwIfCancelled(options.signal);
  const target = projectFile(cwd, path);
  await authorizeSessionAction(
    cwd,
    'read_file',
    { path: target.file, operation: 'brain-read-source' },
    options,
  );
  target.recheck();
  if (fs.lstatSync(target.file).nlink !== 1)
    throw new BrainError('policy-denied', 'Brain input must not be a hard-linked file.');
  const bytes = readArtifactBytes(target.file, max);
  let original: string;
  try {
    original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BrainError('invalid', 'Brain input must be UTF-8 text.');
  }
  if (sanitizeBrainText(target.relative) !== target.relative)
    throw new BrainError('policy-denied', 'Source filename contains secret material.');
  const content = sanitizeBrainText(original);
  text(content, max, true);
  throwIfCancelled(options.signal);
  const hash = byteHash(bytes);
  return {
    ...target,
    original,
    content,
    hash,
    redacted: content !== original,
    assertUnchanged: () => {
      target.recheck();
      if (byteHash(readArtifactBytes(target.file, max)) !== hash)
        throw new BrainError('conflict', 'Source content changed during review; ingest it again.');
    },
  };
}
export async function authorizeBrain(
  cwd: string,
  operation: string,
  details: Record<string, unknown>,
  options: BrainOptions = {},
): Promise<void> {
  await authorizeSessionAction(
    cwd,
    'brain_' + operation,
    { path: projectIdentity(cwd).project, scope: options.scope ?? 'project', ...details },
    { ...options, confirmation: options.confirmation ?? 'mutating' },
  );
}
export type Freshness = 'current' | 'changed' | 'missing' | 'unverified';
export interface VisibleEntity extends BrainEntity {
  freshness: Freshness;
  effectiveState: BrainEntity['state'];
}
/** Check current source access before releasing content from a past ingestion. */
export class BrainAccess {
  private readonly checked = new Map<string, Promise<Freshness>>();
  constructor(
    readonly cwd: string,
    readonly sources: Record<string, BrainSource>,
    readonly options: BrainOptions = {},
  ) {}
  source(id: string): Promise<Freshness> {
    let check = this.checked.get(id);
    if (!check) {
      check = this.inspectSource(id);
      this.checked.set(id, check);
    }
    return check;
  }
  private async inspectSource(id: string): Promise<Freshness> {
    throwIfCancelled(this.options.signal);
    const source = this.sources[id];
    if (!source) throw new BrainError('invalid', 'Knowledge source is missing.');
    await this.options.authorizeSource?.(source);
    throwIfCancelled(this.options.signal);
    if (
      sanitizeBrainText(source.content) !== source.content ||
      sanitizeBrainText(source.name) !== source.name
    )
      throw new BrainError(
        'policy-denied',
        'Retained evidence matches newly configured secret material; review it privately before reuse.',
      );
    const locator = source.locator;
    if (locator.path && locator.projectKey) {
      if (locator.projectKey !== projectIdentity(this.cwd).projectKey)
        throw new BrainError(
          'policy-denied',
          'Source belongs to another project; use an explicit knowledge transfer.',
        );
      const target = projectFile(this.cwd, locator.path, true);
      await authorizeSessionAction(
        this.cwd,
        'read_file',
        { path: target.file, operation: 'brain-read-retained-source', sourceId: id },
        this.options,
      );
      target.recheck();
      if (source.kind === 'file')
        try {
          if (fs.lstatSync(target.file).nlink !== 1)
            throw new BrainError(
              'policy-denied',
              'Retained source now shares another file identity.',
            );
          return byteHash(readArtifactBytes(target.file, BRAIN_LIMITS.sourceBytes)) ===
            source.originalHash
            ? 'current'
            : 'changed';
        } catch (e) {
          if (e instanceof BrainError) throw e;
          return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unverified';
        }
    }
    return source.kind === 'human' ? 'current' : 'unverified';
  }
  async record<T extends BrainEntity | BrainEdge>(
    record: T,
  ): Promise<T & { freshness: Freshness; effectiveState: T['state'] }> {
    if (hasBrainSecrets(record))
      throw new BrainError(
        'policy-denied',
        'Knowledge matches newly configured secret material; review it privately before reuse.',
      );
    const states = [];
    for (const p of record.provenance) states.push(await this.source(p.sourceId));
    const freshness: Freshness = states.includes('changed')
      ? 'changed'
      : states.includes('missing')
        ? 'missing'
        : states.includes('unverified')
          ? 'unverified'
          : 'current';
    return {
      ...record,
      freshness,
      effectiveState:
        ['changed', 'missing'].includes(freshness) && record.state !== 'rejected'
          ? 'stale'
          : record.state,
    };
  }
  async visible<T extends BrainEntity | BrainEdge>(record: T) {
    try {
      return await this.record(record);
    } catch (e) {
      if (this.options.signal?.aborted || isCancellation(e)) throw e;
      if (
        e instanceof SessionPolicyError ||
        (e instanceof BrainError && e.code === 'policy-denied')
      )
        return null;
      throw e;
    }
  }
  async all(): Promise<void> {
    for (const id of Object.keys(this.sources)) {
      throwIfCancelled(this.options.signal);
      await this.source(id);
    }
  }
}
export function changeDigest(changes: unknown[]): string {
  return digest(changes.map((value) => digest(canonicalJson(value))).join('\n'));
}
