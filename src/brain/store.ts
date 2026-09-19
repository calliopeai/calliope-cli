import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalPath, digest, projectIdentity } from '../approvals/index.js';
import { throwIfCancelled, cancellableDelay } from '../cancellation.js';
import { assertExecutionStoreOutsideProject } from '../execution/index.js';
import { recoverDeadWriterLock } from '../execution/writer-recovery.js';
import { privateDirectory, readArtifactBytes } from '../orchestration/execution-store.js';
import {
  BrainError,
  BRAIN_LIMITS,
  type BrainHeader,
  type BrainEvent,
  type BrainChange,
  type BrainInspection,
  type BrainJournal,
} from './types.js';
import { BrainIndex } from './sqlite.js';
import { replayBrain, inverseChanges } from './journal.js';

export interface BrainWriteOptions {
  signal?: AbortSignal;
  expectedRevision?: string;
  beforeCommit?: () => void | Promise<void>;
}
function exists(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
function durable(file: string, bytes: string | Uint8Array): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function sync(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** Project/global namespaces are private and outside worker scope; source documents are never storage. */
export class BrainStore {
  readonly root: string;
  readonly base: string;
  readonly project: { root: string; key: string };
  constructor(
    cwd: string,
    readonly scope: 'project' | 'global' = 'project',
    base = join(homedir(), '.calliope-cli', 'brain'),
  ) {
    if (!['project', 'global'].includes(scope))
      throw new BrainError('invalid', 'Unknown brain scope.');
    const identity = projectIdentity(cwd);
    this.project = { root: identity.project, key: identity.projectKey };
    this.base = resolve(base);
    this.root = join(this.base, scope === 'global' ? 'global' : identity.projectKey);
    assertExecutionStoreOutsideProject(identity.project, this.base);
  }
  private identity(): fs.Stats {
    const current = projectIdentity(this.project.root);
    if (current.projectKey !== this.project.key)
      throw new BrainError(
        'conflict',
        'Project identity changed; no brain operation is authorized.',
      );
    if (canonicalPath(this.base) !== this.base || canonicalPath(this.root) !== this.root)
      throw new BrainError('conflict', 'Brain storage contains an alias.');
    privateDirectory(this.base);
    return privateDirectory(this.root);
  }
  read(signal?: AbortSignal): BrainInspection {
    throwIfCancelled(signal);
    if (!exists(this.root))
      throw new BrainError('not-found', 'No brain exists in this scope; run brain init.');
    this.identity();
    const file = join(this.root, 'history.json');
    if (!exists(file))
      throw new BrainError(
        'unavailable',
        'Brain initialization is incomplete; retry init after its writer stops.',
      );
    const stat = fs.lstatSync(file);
    if (stat.nlink !== 1)
      throw new BrainError('unavailable', 'Brain history must not share a writable file identity.');
    let value: unknown;
    try {
      value = JSON.parse(readArtifactBytes(file, BRAIN_LIMITS.journalBytes, true).toString());
    } catch {
      throw new BrainError(
        'unavailable',
        'Brain history is unreadable; preserve it and restore a verified backup.',
      );
    }
    const inspected = replayBrain(value, signal),
      header = inspected.journal.header;
    if (
      header.scope !== this.scope ||
      canonicalJson(header.project) !==
        canonicalJson(this.scope === 'project' ? this.project : null)
    )
      throw new BrainError('conflict', 'Brain history belongs to another project or scope.');
    throwIfCancelled(signal);
    return inspected;
  }
  private async locked<T>(
    operation: (check: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const before = this.identity(),
      lock = join(this.root, 'writer.lock');
    let fd: number | undefined;
    for (let n = 0; n < 50; n++) {
      throwIfCancelled(signal);
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        recoverDeadWriterLock(lock);
        await cancellableDelay(10, signal);
      }
    }
    if (fd === undefined)
      throw new BrainError('conflict', 'Another brain writer is active; retry after it finishes.');
    const captured = fs.fstatSync(fd);
    const check = () => {
      throwIfCancelled(signal);
      const after = this.identity(),
        current = fs.lstatSync(lock);
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        current.dev !== captured.dev ||
        current.ino !== captured.ino
      )
        throw new BrainError('conflict', 'Brain storage ownership changed during the write.');
    };
    try {
      fs.writeFileSync(fd, String(process.pid));
      return await operation(check);
    } finally {
      fs.closeSync(fd);
      try {
        const after = this.identity(),
          now = fs.lstatSync(lock);
        if (
          after.dev === before.dev &&
          after.ino === before.ino &&
          now.ino === captured.ino &&
          now.dev === captured.dev
        )
          fs.unlinkSync(lock);
      } catch {
        /* Preserve a foreign or interrupted writer's state. */
      }
    }
  }
  async init(options: BrainWriteOptions = {}): Promise<BrainInspection> {
    throwIfCancelled(options.signal);
    if (canonicalPath(this.base) !== this.base)
      throw new BrainError('conflict', 'Brain storage contains an alias.');
    fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
    privateDirectory(this.base);
    if (!exists(this.root))
      try {
        fs.mkdirSync(this.root, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    return this.locked(async (check) => {
      if (exists(join(this.root, 'history.json'))) return this.read(options.signal);
      const header: BrainHeader = {
          version: 1,
          id: randomUUID(),
          scope: this.scope,
          project: this.scope === 'project' ? this.project : null,
          createdAt: new Date().toISOString(),
        },
        journal: BrainJournal = {
          version: 1,
          header,
          events: [],
          hash: digest(canonicalJson(header)),
        };
      await this.save(journal, undefined, check, options);
      return this.read(options.signal);
    }, options.signal);
  }
  private async save(
    journal: BrainJournal,
    prior: Buffer | undefined,
    check: () => void,
    options: BrainWriteOptions,
  ): Promise<void> {
    const content = JSON.stringify(journal);
    if (Buffer.byteLength(content) > BRAIN_LIMITS.journalBytes)
      throw new BrainError(
        'limit',
        'Brain history reached its byte limit; preserve or export it before continuing.',
      );
    const file = join(this.root, 'history.json'),
      temp = join(this.root, randomUUID() + '.tmp'),
      root = this.identity();
    let temporary: fs.Stats | undefined;
    try {
      durable(temp, content);
      temporary = fs.lstatSync(temp);
      check();
      if (
        prior
          ? !readArtifactBytes(file, BRAIN_LIMITS.journalBytes, true).equals(prior)
          : exists(file)
      )
        throw new BrainError('conflict', 'Brain history changed before commit.');
      await options.beforeCommit?.();
      check();
      if (
        prior
          ? !readArtifactBytes(file, BRAIN_LIMITS.journalBytes, true).equals(prior)
          : exists(file)
      )
        throw new BrainError('conflict', 'Brain history changed during final checks.');
      fs.renameSync(temp, file);
      sync(this.root);
    } finally {
      this.cleanTemporary(temp, root, temporary);
    }
  }
  private cleanTemporary(file: string, root: fs.Stats, temporary?: fs.Stats): void {
    try {
      const current = this.identity(),
        stat = fs.lstatSync(file);
      if (
        temporary &&
        current.dev === root.dev &&
        current.ino === root.ino &&
        stat.dev === temporary.dev &&
        stat.ino === temporary.ino
      )
        fs.unlinkSync(file);
    } catch {
      /* Preserve foreign state; interrupted private temporary files may be inspected. */
    }
  }
  /** Reading a missing or damaged derived index never mutates the store. */
  async index(signal?: AbortSignal): Promise<BrainIndex> {
    const view = this.read(signal),
      file = join(this.root, 'index.sqlite');
    let bytes: Buffer | undefined;
    try {
      if (fs.lstatSync(file).nlink === 1)
        bytes = readArtifactBytes(file, BRAIN_LIMITS.indexBytes, true);
    } catch {
      /* The validated journal rebuilds a missing or damaged cache. */
    }
    return BrainIndex.open(view.state, bytes, signal);
  }
  async saveIndex(index: BrainIndex, options: BrainWriteOptions = {}): Promise<void> {
    const bytes = index.export();
    if (bytes.byteLength > BRAIN_LIMITS.indexBytes)
      throw new BrainError('limit', 'Brain index exceeds its byte limit.');
    await this.locked(async (check) => {
      if (this.read(options.signal).state.revision !== index.state.revision)
        throw new BrainError('conflict', 'Brain changed before index replacement.');
      const file = join(this.root, 'index.sqlite'),
        temp = join(this.root, randomUUID() + '.tmp'),
        root = this.identity();
      let temporary: fs.Stats | undefined;
      try {
        durable(temp, bytes);
        temporary = fs.lstatSync(temp);
        await options.beforeCommit?.();
        check();
        if (this.read(options.signal).state.revision !== index.state.revision)
          throw new BrainError('conflict', 'Brain changed during index replacement.');
        fs.renameSync(temp, file);
        sync(this.root);
      } finally {
        this.cleanTemporary(temp, root, temporary);
      }
    }, options.signal);
  }
  async append(
    changes: BrainChange[],
    actor: BrainEvent['actor'],
    reason: string,
    options: BrainWriteOptions = {},
  ): Promise<BrainInspection> {
    return this.commit(() => ({ changes, actor, reason, reverses: null }), options);
  }
  async reverse(
    eventId: string,
    reason: string,
    options: BrainWriteOptions = {},
  ): Promise<BrainInspection> {
    return this.commit((prior) => {
      const index = prior.journal.events.findIndex((e) => e.id === eventId);
      if (index < 0) throw new BrainError('not-found', 'Unknown brain event.');
      const prefix = prior.journal.events.slice(0, index),
        before = replayBrain(
          {
            ...prior.journal,
            events: prefix,
            hash: prefix.at(-1)?.hash ?? digest(canonicalJson(prior.journal.header)),
          },
          options.signal,
        ).state;
      const changes = inverseChanges(prior.journal.events[index]!, before);
      if (!changes.length)
        throw new BrainError(
          'conflict',
          'Source evidence is immutable; this event has no reversible knowledge changes.',
        );
      return { changes, actor: 'reversal', reason, reverses: eventId };
    }, options);
  }
  private async commit(
    make: (prior: BrainInspection) => Pick<BrainEvent, 'changes' | 'actor' | 'reason' | 'reverses'>,
    options: BrainWriteOptions,
  ): Promise<BrainInspection> {
    throwIfCancelled(options.signal);
    this.read(options.signal);
    return this.locked(async (check) => {
      const file = join(this.root, 'history.json'),
        raw = readArtifactBytes(file, BRAIN_LIMITS.journalBytes, true),
        prior = this.read(options.signal);
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== prior.state.revision
      )
        throw new BrainError('conflict', 'Brain revision changed during review.');
      if (prior.journal.events.length >= BRAIN_LIMITS.events)
        throw new BrainError(
          'limit',
          'Brain event retention reached; preserve or export its history.',
        );
      const proposal = make(prior),
        chunks: BrainChange[][] = [];
      let chunk: BrainChange[] = [],
        bytes = 0;
      if (
        !proposal.changes.length ||
        proposal.changes.length > BRAIN_LIMITS.entities + BRAIN_LIMITS.edges + BRAIN_LIMITS.sources
      )
        throw new BrainError('limit', 'Brain transaction record count is outside its bound.');
      for (const change of proposal.changes) {
        throwIfCancelled(options.signal);
        const size = Buffer.byteLength(JSON.stringify(change));
        if (chunk.length && (chunk.length === BRAIN_LIMITS.changes || bytes + size > 768 * 1024)) {
          chunks.push(chunk);
          chunk = [];
          bytes = 0;
        }
        chunk.push(change);
        bytes += size;
      }
      chunks.push(chunk);
      if (prior.journal.events.length + chunks.length > BRAIN_LIMITS.events)
        throw new BrainError(
          'limit',
          'Brain event retention reached; preserve or export its history.',
        );
      if (proposal.actor === 'reversal' && chunks.length !== 1)
        throw new BrainError('limit', 'A reversal must match one retained event.');
      const journal: BrainJournal = { ...prior.journal, events: [...prior.journal.events] };
      for (const changes of chunks) {
        const body = {
            version: 1 as const,
            id: randomUUID(),
            sequence: journal.events.length + 1,
            at: [new Date().toISOString(), journal.events.at(-1)?.at ?? journal.header.createdAt]
              .sort()
              .at(-1)!,
            previous: journal.hash,
            ...proposal,
            changes,
          },
          event: BrainEvent = { ...body, hash: digest(canonicalJson(body)) };
        journal.events.push(event);
        journal.hash = event.hash;
      }
      replayBrain(journal, options.signal);
      await this.save(journal, raw, check, options);
      return this.read(options.signal);
    }, options.signal);
  }
}
