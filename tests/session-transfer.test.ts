import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as storage from '../src/storage.js';
import * as config from '../src/config.js';
import { branchSession, selectSession, sessionHistory, compareConversations, exportSession, importSession, readSessionTransfer, writeSessionTransfer, sessionCommand, runSessionCommand, conversationMarkdown, messageText } from '../src/session-management/index.js';
import { makeBundle, parseBundle, installBundle, readConversation, writeConversation, readToolState, validateToolState, installToolState, toolStateHash, MAX_TOOL_STATE_BYTES, MAX_HISTORY_BYTES, MAX_BUNDLE_BYTES, hash } from '../src/sessions/index.js';
import { IterationLedger } from '../src/iteration-ledger.js';
import { RunLog, resetRunLogs, readRunLog, verifyChain } from '../src/runlog.js';
import { checkTrust } from '../src/trust.js';
import type { Message } from '../src/types.js';
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
let root: string, project: string, source: storage.Session;
const originalPaths = { ...storage.paths };
const messages: Message[] = [{ role: 'system', content: 'private-test-instructions' }, { role: 'user', content: 'public toy' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'toy', name: 'read_file', arguments: { path: 'toy.txt' } }], providerMetadata: { google: { thoughtSignature: 'opaque-test-signature' } } },
  { role: 'tool', toolCallId: 'toy', content: 'private-test-response' }];
const dir = () => storage.getSessionDirById(source.id)!;
const transfer = () => join(project, 'session.json');
const text = async () => JSON.stringify(makeBundle(await sessionHistory(source.id), readToolState(dir())));
beforeEach(() => {
  config.resetConfig(); resetRunLogs();
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-transfer-'))); project = join(root, 'project'); fs.mkdirSync(project);
  for (const [key, value] of Object.entries(originalPaths)) storage.paths[key as keyof typeof storage.paths] = value.replace(originalPaths.root, join(root, 'store'));
  source = storage.createSession(project);
  storage.saveSessionConversation(source.id, messages, { expectedRevision: null, status: 'cancelled' });
});
afterEach(() => { vi.restoreAllMocks(); resetRunLogs(); config.resetConfig(); Object.assign(storage.paths, originalPaths); fs.rmSync(root, { recursive: true, force: true }); });

it('branches current conversation and tool state with durable provenance and independent later saves', async () => {
  storage.addTodo('toy task'); storage.setActiveTodo(storage.getSessionTodos()[0]!.id);
  storage.savePlan({ id: 'toy', title: 'Toy plan', phases: [{ name: 'one', steps: ['read'] }], status: 'draft', createdAt: new Date().toISOString() });
  storage.setActivePlan(storage.getPlans()[0]!);
  const ledger = new IterationLedger(); storage.saveIterationLedger(ledger, source.id);
  const original = storage.readSessionConversation(source.id), tools = readToolState(dir());
  const branch = await branchSession(source.id, { name: 'experiment' });
  expect(branch.session.lineage).toMatchObject({ kind: 'manual', name: 'experiment', sessionId: source.id, revision: original.revision });
  expect(branch.state.messages).toEqual(messages); expect(branch.state.revision).not.toBe(original.revision);
  expect(readToolState(storage.getSessionDirById(branch.session.id)!)).toEqual(tools);
  expect(selectSession('experiment', project).id).toBe(branch.session.id);
  expect(storage.getCurrentSession()?.id).toBe(source.id);
  storage.saveSessionConversation(branch.session.id, [...messages, { role: 'user', content: 'branch only' }], { expectedRevision: branch.state.revision, status: 'active' });
  expect(storage.readSessionConversation(source.id)).toEqual(original);
  expect((await sessionHistory(branch.session.id)).events).toHaveLength(2);
  expect(compareConversations(original, storage.readSessionConversation(branch.session.id))).toMatchObject({ commonMessages: 4, removed: [], added: [{ role: 'user', content: 'branch only' }] });
  expect(toolStateHash(tools)).toMatch(/^[a-f0-9]{64}$/);
});

it('branches unsaved edits at the history budget without changing the full source, and rejects a stale source cursor', async () => {
  const saved = storage.readSessionConversation(source.id);
  const budgetFile = join(dir(), 'events', 'orphan-budget'); const fd = fs.openSync(budgetFile, 'w'); fs.ftruncateSync(fd, MAX_HISTORY_BYTES); fs.closeSync(fd);
  const edited: Message[] = [...messages, { role: 'user', content: 'unsaved edit' }];
  const branch = await branchSession(source.id, { name: 'at-limit', messages: edited, expectedRevision: saved.revision });
  expect(branch.state.messages).toEqual(edited); expect(storage.readSessionConversation(source.id)).toEqual(saved);
  expect(fs.statSync(budgetFile).size).toBe(MAX_HISTORY_BYTES);
  await expect(branchSession(source.id, { messages: edited, expectedRevision: 'stale' })).rejects.toThrow(/another terminal/);
  await expect(branchSession(source.id, { messages: edited })).rejects.toThrow(/requires/);
});

it('retains the recorded omission count when branching an unchanged resumed projection', async () => {
  const previous = storage.readSessionConversation(source.id);
  const retained = writeConversation(dir(), source.id, messages, { expectedRevision: previous.revision, status: 'completed', cap: 3 });
  expect(retained.droppedMessages).toBe(1);
  const branch = await branchSession(source.id, { messages: retained.messages, expectedRevision: retained.revision });
  expect(branch.state.messages).toEqual(retained.messages); expect(branch.state.droppedMessages).toBe(1);
});

it('preserves a failed branch without switching or overwriting the source and validates lineage metadata on restart', async () => {
  const saved = storage.readSessionConversation(source.id);
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk'); });
  await expect(branchSession(source.id)).rejects.toThrow();
  expect(storage.readSessionConversation(source.id)).toEqual(saved); expect(storage.getCurrentSession()?.id).toBe(source.id);
  const partial = storage.listSessions(10000).find(item => item.lineage?.sessionId === source.id)!;
  expect(storage.readSessionConversation(partial.id).revision).toBeNull();
  const metadataFile = join(storage.getSessionDirById(partial.id)!, 'session.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')); metadata.lineage.name = '\nprivate-marker'; fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  expect(storage.getSessionById(partial.id)).toBeNull();
});

it('round-trips immutable event IDs, tool state and opaque metadata without importing trust or changing the active session', async () => {
  storage.addTodo('keep toy task'); const first = await sessionHistory(source.id);
  storage.saveSessionConversation(source.id, [...messages, { role: 'user', content: 'next' }], { expectedRevision: first.snapshot.revision, status: 'interrupted' });
  const original = await sessionHistory(source.id), beforeTrust = checkTrust(project).trusted;
  await exportSession(project, source.id, 'session.json');
  const imported = await importSession(project, 'session.json');
  expect(imported.session.id).not.toBe(source.id);
  expect(storage.getCurrentSession()?.id).toBe(source.id); expect(checkTrust(project).trusted).toBe(beforeTrust);
  expect(imported.session.lineage).toMatchObject({ kind: 'import', sessionId: source.id, revision: original.snapshot.revision });
  expect(imported.state.messages).toEqual(original.snapshot.messages);
  expect((await sessionHistory(imported.session.id)).events).toEqual(original.events);
  expect(readToolState(storage.getSessionDirById(imported.session.id)!)).toEqual(readToolState(dir()));
  const saved = storage.saveSessionConversation(imported.session.id, [...imported.state.messages, { role: 'assistant', content: 'new checkpoint' }], { expectedRevision: imported.state.revision, status: 'completed' });
  const continued = await sessionHistory(imported.session.id);
  expect(continued.snapshot).toEqual(saved); expect(continued.events.at(-1)?.sessionId).toBe(imported.session.id);
  expect(continued.events.at(-1)?.parent?.sessionId).toBe(source.id);
  await exportSession(project, imported.session.id, 'again.json');
  expect((await importSession(project, 'again.json')).state.messages).toEqual(saved.messages);
  expect(fs.statSync(transfer()).mode & 0o777).toBe(0o600);
});

it('replays a known immutable revision even when the current cached snapshot is damaged', async () => {
  const revision = storage.readSessionConversation(source.id).revision!;
  fs.writeFileSync(join(dir(), 'messages.json'), '{');
  expect((await sessionHistory(source.id, revision)).snapshot.messages).toEqual(messages);
  await expect(sessionHistory(source.id)).rejects.toThrow(/damaged/);
});

it('denies mutations before creating sessions/files and records scope without private contents', async () => {
  const log = RunLog.open('transfer-test', { dir: join(root, 'logs') });
  const options = { runlog: log, confirmation: 'mutating' as const };
  await expect(branchSession(source.id, options)).rejects.toThrow(/denied/);
  await expect(writeSessionTransfer(project, 'session.json', await text(), { ...options, confirmation: 'mutating' })).rejects.toThrow(/denied/);
  fs.writeFileSync(transfer(), await text());
  await expect(importSession(project, 'session.json', { ...options, mode: 'plan' })).rejects.toThrow(/denied/);
  expect(storage.listSessions()).toHaveLength(1);
  const events = readRunLog(log.filePath); expect(verifyChain(events).ok).toBe(true);
  expect(JSON.stringify(events)).toContain(transfer());
  expect(JSON.stringify(events)).not.toContain('private-test'); expect(JSON.stringify(events)).not.toContain('opaque-test-signature');
});

it('cancels permission waits and leaves no partial transfer or session', async () => {
  const controller = new AbortController();
  await expect(writeSessionTransfer(project, 'session.json', await text(), { signal: controller.signal, confirmation: 'mutating', approve: async () => { controller.abort(); return 'allow'; } })).rejects.toThrow(/cancelled/);
  await expect(branchSession(source.id, { signal: controller.signal })).rejects.toThrow(/cancelled/);
  await expect(importSession(project, 'session.json', { signal: controller.signal })).rejects.toThrow(/cancelled/);
  await expect(parseBundle('{}', controller.signal)).rejects.toThrow(/cancelled/);
  expect(fs.readdirSync(project)).toEqual([]); expect(storage.listSessions()).toHaveLength(1);
});

it('rejects duplicate branch names as ambiguous and foreign project sessions', async () => {
  await branchSession(source.id, { name: 'duplicate' }); await branchSession(source.id, { name: 'duplicate' });
  expect(() => selectSession('duplicate', project)).toThrow(/Ambiguous/);
  expect(() => selectSession(source.id, root)).toThrow(/belongs/);
  expect(() => selectSession('missing', project)).toThrow(/not found/);
  await expect(branchSession('missing')).rejects.toThrow(/not found/);
  for (const name of ['', '../escape', 'name\n', 'a'.repeat(65)]) await expect(branchSession(source.id, { name })).rejects.toThrow(/Branch names/);
});

it('refuses existing export files including concurrent writers without losing either source', async () => {
  const raw = await text();
  const outcomes = await Promise.allSettled([writeSessionTransfer(project, 'session.json', raw), writeSessionTransfer(project, 'session.json', 'later')]);
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(fs.readFileSync(transfer(), 'utf8')).toBe(outcomes[0]!.status === 'fulfilled' ? raw : 'later');
  expect(fs.readdirSync(project)).toEqual(['session.json']);
});

it.each(['../outside.json', '', 'bad\nname'])('rejects unsafe transfer paths %j', async path => {
  await expect(writeSessionTransfer(project, path, '{}')).rejects.toThrow();
  await expect(readSessionTransfer(project, path)).rejects.toThrow();
});

it('refuses symlink files/directories and detects directory replacement during approval', async () => {
  fs.writeFileSync(join(root, 'outside'), 'unchanged'); fs.symlinkSync(join(root, 'outside'), transfer());
  await expect(readSessionTransfer(project, 'session.json')).rejects.toThrow();
  await expect(writeSessionTransfer(project, 'session.json', '{}')).rejects.toThrow();
  expect(fs.readFileSync(join(root, 'outside'), 'utf8')).toBe('unchanged');
  fs.unlinkSync(transfer()); fs.symlinkSync(root, join(project, 'linked'));
  await expect(readSessionTransfer(project, 'linked/outside')).rejects.toThrow(/symlink/);
  const nested = join(project, 'nested'); fs.mkdirSync(nested);
  await expect(writeSessionTransfer(project, 'nested/export.json', '{}', { confirmation: 'mutating', approve: async () => {
    fs.renameSync(nested, join(project, 'moved')); fs.mkdirSync(nested); return 'allow';
  } })).rejects.toThrow(/changed/);
  expect(fs.readdirSync(nested)).toEqual([]);
});

it('cleans its temporary transfer after an I/O failure and reports missing files', async () => {
  vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw new Error('injected disk failure'); });
  await expect(writeSessionTransfer(project, 'session.json', '{}')).rejects.toThrow(/could not be saved/);
  expect(fs.readdirSync(project)).toEqual([]);
  await expect(readSessionTransfer(project, 'missing')).rejects.toThrow(/not found/);
});

it.each(['{', '{}', 'null', '[]', '{"version":2}'])('rejects malformed bundles before creating an import destination: %s', async raw => {
  fs.writeFileSync(transfer(), raw);
  await expect(importSession(project, 'session.json')).rejects.toThrow(/damaged/);
  expect(storage.listSessions()).toHaveLength(1); expect(fs.readFileSync(transfer(), 'utf8')).toBe(raw);
});

it('validates digests, ancestry, declared projection, versions and tool-state paths even with recomputed bundle hashes', async () => {
  const bundle = JSON.parse(await text());
  for (const mutate of [
    (v: any) => { v.events[0].change.append[0].content = 'tampered'; },
    (v: any) => { v.source.stateHash = '0'.repeat(64); },
    (v: any) => { v.source.revision = 'wrong'; },
    (v: any) => { v.version = 2; },
    (v: any) => { v.head.id = 'wrong'; },
    (v: any) => { v.events = [null]; },
    (v: any) => { v.toolState = [{ path: '../escape', content: 'no' }]; },
    (v: any) => { v.extra = true; },
  ]) {
    const copy = structuredClone(bundle); mutate(copy); delete copy.checksum; copy.checksum = hash(JSON.stringify(copy));
    await expect(parseBundle(JSON.stringify(copy))).rejects.toThrow();
  }
  bundle.checksum = 'bad'; await expect(parseBundle(JSON.stringify(bundle))).rejects.toThrow(/damaged/);
});

it('preserves a failed inactive import and rejects overwrites or another writer’s lock', async () => {
  const raw = await text();
  await expect(installBundle(dir(), source.id, raw)).rejects.toThrow(/new inactive/);
  const destination = storage.createSession(project, { activate: false }), target = storage.getSessionDirById(destination.id)!;
  fs.writeFileSync(join(target, 'messages.lock'), 'other');
  await expect(installBundle(target, destination.id, raw)).rejects.toThrow(/locked/);
  expect(fs.readFileSync(join(target, 'messages.lock'), 'utf8')).toBe('other'); fs.unlinkSync(join(target, 'messages.lock'));
  vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw new Error('failure'); });
  await expect(installBundle(target, destination.id, raw)).rejects.toThrow(/partial/);
  expect(readConversation(target, destination.id).revision).toBeNull();
  expect(fs.readdirSync(join(target, 'events'))).toHaveLength(1);
  expect(fs.existsSync(join(target, 'messages.lock'))).toBe(false);
  expect(storage.readSessionConversation(source.id).messages).toEqual(messages);
});

it('bounds transfer and tool-state bytes before mutation', async () => {
  const oversized = join(project, 'large'); const fd = fs.openSync(oversized, 'w'); fs.ftruncateSync(fd, MAX_BUNDLE_BYTES + 1); fs.closeSync(fd);
  await expect(readSessionTransfer(project, 'large')).rejects.toThrow();
  expect(() => validateToolState([{ path: 'todos.txt', content: 'x'.repeat(MAX_TOOL_STATE_BYTES + 1) }])).toThrow();
  await expect(writeSessionTransfer(project, 'session.json', 'x'.repeat(MAX_BUNDLE_BYTES + 1))).rejects.toThrow(/budget/);
});

it.each([
  null, {}, [{ path: 'todos.txt', content: 3 }], [{ path: 'todos.txt', content: '' }, { path: 'todos.txt', content: '' }],
  [{ path: 'plans/bad.json', content: '{}' }], [{ path: 'active-todo.json', content: '[]' }],
  [{ path: 'active-todo.json', content: '{' }], [{ path: 'ledger.json', content: '{"version":2}' }],
])('rejects malformed tool state %j', value => { expect(() => validateToolState(value)).toThrow(); });

it('never overwrites live tool state or follows tool-state symlinks', () => {
  storage.addTodo('keep'); expect(() => installToolState(dir(), [{ path: 'todos.txt', content: 'replacement' }])).toThrow();
  fs.symlinkSync(join(root, 'outside'), join(dir(), 'plans', 'outside.json'));
  expect(() => readToolState(dir())).toThrow(); fs.unlinkSync(join(dir(), 'plans', 'outside.json'));
  fs.rmdirSync(join(dir(), 'plans')); fs.symlinkSync(root, join(dir(), 'plans'));
  expect(() => readToolState(dir())).toThrow();
});

it('provides stable local-only headless JSON for list, status, branching, replay, diff and transfers', async () => {
  const opts = { cwd: project };
  const list = await sessionCommand(['list', '--json'], opts);
  expect(list).toMatchObject({ exitCode: 0, report: { version: 1, type: 'session', action: 'list', localOnly: true, data: { sessions: [{ id: source.id }] } } });
  expect(await sessionCommand(['status', source.id], opts)).toMatchObject({ exitCode: 0, report: { data: { status: 'cancelled', messageCount: 4, session: { id: source.id } } } });
  const branch = await sessionCommand(['branch', source.id, 'cli-branch'], opts);
  expect(branch).toMatchObject({ exitCode: 0, report: { data: { session: { lineage: { name: 'cli-branch' } } } } });
  expect(await sessionCommand(['diff', source.id, 'cli-branch'], opts)).toMatchObject({ exitCode: 0, report: { data: { commonMessages: 4, removed: [], added: [] } } });
  expect(await sessionCommand(['export', source.id, 'session.json'], opts)).toMatchObject({ exitCode: 0, report: { data: { path: transfer() } } });
  expect(await sessionCommand(['import', 'session.json'], opts)).toMatchObject({ exitCode: 0, report: { data: { messageCount: 4, session: { lineage: { kind: 'import' } } } } });
  const output: string[] = [];
  expect(await runSessionCommand(['replay', source.id, '--json'], { ...opts, write: text => output.push(text) })).toBe(0);
  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0]!)).toMatchObject({ version: 1, type: 'session', localOnly: true, action: 'replay', data: { snapshot: { messages } } });
  output.length = 0;
  await runSessionCommand(['replay', source.id], { ...opts, write: text => output.push(text) });
  expect(output[0]).toContain('No tools executed'); expect(output[0]).not.toContain('opaque-test-signature');
  expect(conversationMarkdown(messages)).not.toContain('private-test-instructions');
  expect(messageText({ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'private-image' }, { type: 'text', text: 'toy' }] })).toBe('[Image: image/png]\ntoy');
});

it.each([['bogus'], ['status'], ['list', 'extra'], ['replay'], ['export', 'id'], ['list', '--unknown'], ['status', '\n']])('returns an argument-error JSON contract for %j', async args => {
  const output: string[] = [];
  expect(await runSessionCommand([...args, '--json'], { cwd: project, write: text => output.push(text) })).toBe(2);
  expect(JSON.parse(output[0]!)).toMatchObject({ version: 1, type: 'session', localOnly: true, error: { code: 'invalid-arguments' } });
});

it('distinguishes headless cancellation, policy denial, damaged state and other failures', async () => {
  const opts = { cwd: project };
  expect(await sessionCommand(['branch', source.id], { ...opts, mode: 'plan' })).toMatchObject({ exitCode: 3, report: { error: { code: 'policy-denied' } } });
  expect(await sessionCommand([], { ...opts, signal: AbortSignal.abort() })).toMatchObject({ exitCode: 130, report: { error: { code: 'cancelled' } } });
  expect(await sessionCommand(['status', 'missing'], opts)).toMatchObject({ exitCode: 1, report: { error: { code: 'operation-failed' } } });
  fs.writeFileSync(join(dir(), 'messages.json'), 'private-malformed-marker');
  const damaged = await sessionCommand(['status', source.id], opts);
  expect(damaged).toMatchObject({ exitCode: 1, report: { error: { code: 'invalid-session' } } });
  expect(JSON.stringify(damaged)).not.toContain('private-malformed-marker');
  const output: string[] = [];
  expect(await runSessionCommand(['status'], { ...opts, write: text => output.push(text) })).toBe(2);
  expect(output[0]).toContain('calliope session');
  output.length = 0; await runSessionCommand([], { ...opts, write: text => output.push(text) });
  expect(JSON.parse(output[0]!).sessions[0].id).toBe(source.id);
});
