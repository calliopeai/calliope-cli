import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyEvent, hash, makeBundle, makeEvent, parseBundle, readConversation, replaySessionHistory, validateTurnProgress, writeConversation, type TurnProgress } from '../src/sessions/index.js';

let root: string, dir: string;
const messages = [{ role: 'user' as const, content: 'original goal' }];
const allowance = (): TurnProgress => ({ version: 1, turnId: randomUUID(), iterationLimit: 4, completionLimit: 2, iterations: 0, completionChecks: 0 });
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-turn-progress-')));
  dir = join(root, 'session'); fs.mkdirSync(dir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('retains consumed allowance through ordinary saves and exact history replay', async () => {
  const progress = allowance();
  const first = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress });
  progress.iterations = 2; progress.completionChecks = 1;
  const second = writeConversation(dir, 'test', messages, { expectedRevision: first.revision, status: 'active', progress });
  progress.iterations = 4;
  expect(second.progress?.iterations).toBe(2);
  const stopped = writeConversation(dir, 'test', messages, { expectedRevision: second.revision, status: 'interrupted' });
  expect(stopped.progress).toEqual(second.progress);
  expect(readConversation(dir, 'test')).toEqual(stopped);
  const replay = await replaySessionHistory(dir, 'test', stopped.history!);
  expect(replay.snapshot).toEqual(stopped);
  expect(replay.events.every(event => event.version === 2)).toBe(true);
});

it('keeps legacy history bytes and hashes unchanged when there is no progress', async () => {
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active' });
  expect(saved).not.toHaveProperty('progress');
  const replay = await replaySessionHistory(dir, 'test', saved.history!);
  expect(replay.events[0]!.version).toBe(1);
  expect(replay.events[0]!.change).not.toHaveProperty('progress');
  expect(replay.snapshot).toEqual(saved);
});

it.each([
  { iterations: -1 }, { iterations: 5 }, { iterations: 1.5 }, { iterations: Number.MAX_SAFE_INTEGER + 1 },
  { completionChecks: 1 }, { completionLimit: 9 }, { completionLimit: -1 }, { completionLimit: 1.5 },
  { completionChecks: 3, iterations: 3 }, { iterationLimit: -1 }, { iterationLimit: 0.5 },
  { turnId: 'another-turn' }, { version: 2 }, { extra: true },
])('rejects malformed allowance %j before writing events', change => {
  expect(() => writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: { ...allowance(), ...change } as TurnProgress })).toThrow(/invalid/);
  expect(fs.readdirSync(dir)).toEqual([]);
});

it('represents unlimited iterations explicitly without non-finite JSON', () => {
  const progress = { ...allowance(), iterationLimit: null, iterations: 100 };
  expect(() => validateTurnProgress(progress)).not.toThrow();
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress });
  expect(readConversation(dir, 'test').progress).toEqual(saved.progress);
});

it.each(['iterations', 'completionChecks', 'turnId', 'iterationLimit', 'completionLimit'] as const)('refuses rollback or changed original %s', field => {
  const progress = { ...allowance(), iterations: 2, completionChecks: 1 };
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress });
  const changed = { ...progress, [field]: field === 'turnId' ? randomUUID() : field === 'iterations' ? 1 : field === 'completionChecks' ? 0 : 3 };
  expect(() => writeConversation(dir, 'test', messages, { expectedRevision: saved.revision, status: 'active', progress: changed })).toThrow(/invalid/);
  expect(readConversation(dir, 'test')).toEqual(saved);
});

it('rejects snapshot progress altered independently of its event history', () => {
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: allowance() });
  const { checksum: _, ...body } = saved;
  body.progress!.iterations = 1;
  fs.writeFileSync(join(dir, 'messages.json'), JSON.stringify({ ...body, checksum: hash(JSON.stringify(body)) }));
  expect(() => readConversation(dir, 'test')).toThrow(/invalid/);
});

it('refuses history transitions that drop consumed allowance', () => {
  const previous = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: allowance() });
  const legacy = { revision: null, messages, status: 'active' as const, droppedMessages: 0 };
  const event = makeEvent('test', null, legacy, null);
  expect(() => applyEvent(previous, event)).toThrow(/invalid/);
});

it('preserves consumed allowance in portable history without granting a new turn', async () => {
  const progress = { ...allowance(), iterations: 2, completionChecks: 1 };
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'interrupted', progress });
  const replay = await replaySessionHistory(dir, 'test', saved.history!);
  const parsed = await parseBundle(JSON.stringify(makeBundle(replay, [])));
  expect(parsed.replay.snapshot).toEqual(saved);
});

it('carries original allowance evidence into a safety branch', async () => {
  const storage = await import('../src/storage.js');
  const { branchSession } = await import('../src/session-management/actions.js');
  const source = storage.createSession(root, { activate: false });
  let branchId: string | undefined;
  try {
    const progress = { ...allowance(), iterations: 2, completionChecks: 1 };
    storage.saveSessionConversation(source.id, messages, { expectedRevision: null, status: 'interrupted', progress });
    const branch = await branchSession(source.id, { kind: 'safety' });
    branchId = branch.session.id;
    expect(branch.state.progress).toEqual(progress);
    expect(storage.readSessionConversation(source.id).progress).toEqual(progress);
    expect(branch.session.lineage?.sessionId).toBe(source.id);
  } finally {
    for (const id of [source.id, branchId]) if (id) {
      const directory = storage.getSessionDirById(id);
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
