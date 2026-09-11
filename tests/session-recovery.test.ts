import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readConversation, writeConversation, retainMessages, validateMessages, MAX_SNAPSHOT_BYTES } from '../src/sessions/index.js';
import * as storage from '../src/storage.js';
import type { Message } from '../src/types.js';

// Keep real filesystem behavior while permitting one injected fsync failure.
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));

let root: string, dir: string;
const originalPaths = { ...storage.paths };
const hello: Message[] = [{ role: 'user', content: 'hello' }];
const save = (messages = hello, expectedRevision: string | null = null) => writeConversation(dir, 'test', messages, { expectedRevision, status: 'active' });
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-recovery-')));
  dir = join(root, 'session'); fs.mkdirSync(dir);
  for (const [key, value] of Object.entries(originalPaths)) storage.paths[key as keyof typeof storage.paths] = value.replace(originalPaths.root, join(root, 'store'));
});
afterEach(() => { vi.restoreAllMocks(); Object.assign(storage.paths, originalPaths); fs.rmSync(root, { recursive: true, force: true }); });

it('round-trips versioned private snapshots with opaque reasoning, tool and image metadata', () => {
  const messages: Message[] = [
    { role: 'system', content: 'public test' },
    { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'toy' }, { type: 'text', text: 'describe' }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'one', name: 'read_file', arguments: { path: 'toy.txt' } }],
      providerMetadata: { bedrock: { reasoningContent: [{ reasoningText: { text: 'public', signature: 'opaque-signature' } }] }, calliopeRouting: { provider: 'bedrock', model: 'discovered' }, extension: { nested: [null, 2, true] } } },
    { role: 'tool', toolCallId: 'one', content: 'toy result' },
  ];
  const written = save(messages);
  expect(readConversation(dir, 'test')).toEqual(written);
  expect(written.messages).toEqual(messages);
  expect(fs.statSync(join(dir, 'messages.json')).mode & 0o777).toBe(0o600);
  expect(fs.readdirSync(dir)).toEqual(['events', 'messages.json']);
  messages[2]!.providerMetadata!.extension = 'changed';
  expect(readConversation(dir, 'test').messages).toEqual(written.messages);
});

it('migrates a legacy message array on an explicit revision match', () => {
  fs.writeFileSync(join(dir, 'messages.json'), JSON.stringify(hello));
  const legacy = readConversation(dir, 'test');
  expect(legacy.revision).toMatch(/^legacy:/);
  const saved = save([...legacy.messages, { role: 'assistant', content: 'hi' }], legacy.revision);
  expect(saved.version).toBe(1); expect(readConversation(dir, 'test').messages).toHaveLength(2);
});

it('rejects stale writers instead of overwriting newer state', () => {
  const first = save();
  const second = save([{ role: 'user', content: 'other terminal' }], first.revision);
  expect(() => save(hello, first.revision)).toThrow(/another terminal/);
  expect(readConversation(dir, 'test')).toEqual(second);
  expect(fs.readdirSync(dir)).toEqual(['events', 'messages.json']);
});

it('rejects a real other-process lock without stealing it', () => {
  execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "owner", {flag:"wx"})', join(dir, 'messages.lock')]);
  expect(() => save()).toThrow(/locked/);
  expect(fs.readFileSync(join(dir, 'messages.lock'), 'utf8')).toBe('owner');
  expect(readConversation(dir, 'test').revision).toBeNull();
});

it.each(['{', '{}', '{"version":2}', '[{"role":"alien","content":"x"}]', '[{"role":"tool","content":"x"}]', '[{"role":"user","content":5}]'])('reports malformed snapshots and preserves their bytes: %s', raw => {
  const file = join(dir, 'messages.json'); fs.writeFileSync(file, raw);
  expect(() => readConversation(dir, 'test')).toThrow(/damaged/);
  expect(() => save()).toThrow(/damaged/);
  expect(fs.readFileSync(file, 'utf8')).toBe(raw);
});

it('detects content tampering and wrong-session imports without echoing content', () => {
  const snapshot = save();
  expect(() => readConversation(dir, 'other')).toThrow(/damaged/);
  snapshot.messages[0]!.content = 'private-marker';
  fs.writeFileSync(join(dir, 'messages.json'), JSON.stringify(snapshot));
  try { readConversation(dir, 'test'); throw new Error('expected rejection'); }
  catch (error) { expect(String(error)).toContain('damaged'); expect(String(error)).not.toContain('private-marker'); }
});

it.each(['symlink', 'dangling', 'directory', 'fifo'])('refuses unsafe snapshot file types: %s', type => {
  const file = join(dir, 'messages.json'), outside = join(root, 'outside');
  if (type === 'symlink' || type === 'dangling') { if (type === 'symlink') fs.writeFileSync(outside, JSON.stringify(hello)); fs.symlinkSync(outside, file); }
  if (type === 'directory') fs.mkdirSync(file);
  if (type === 'fifo') execFileSync('mkfifo', [file]);
  expect(() => readConversation(dir, 'test')).toThrow();
  expect(() => save()).toThrow();
  if (type === 'symlink') expect(fs.readFileSync(outside, 'utf8')).toBe(JSON.stringify(hello));
});

it('refuses a session directory symlink', () => {
  const other = join(root, 'other'); fs.mkdirSync(other); fs.rmdirSync(dir); fs.symlinkSync(other, dir);
  expect(() => save()).toThrow(); expect(fs.readdirSync(other)).toEqual([]);
});

it('bounds bytes, message count, metadata depth and non-JSON metadata', () => {
  fs.writeFileSync(join(dir, 'messages.json'), ' '.repeat(MAX_SNAPSHOT_BYTES + 1));
  expect(() => readConversation(dir, 'test')).toThrow(); fs.unlinkSync(join(dir, 'messages.json'));
  expect(() => save([{ role: 'user', content: 'x'.repeat(MAX_SNAPSHOT_BYTES) }])).toThrow(/16 MiB/);
  expect(() => validateMessages(Array.from({ length: 10001 }, () => hello[0]))).toThrow();
  for (const value of [NaN, Infinity, () => {}, BigInt(1), new Date()]) expect(() => save([{ role: 'assistant', content: '', providerMetadata: { value } }])).toThrow();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(() => save([{ role: 'assistant', content: '', providerMetadata: cycle }])).toThrow();
  expect(fs.readdirSync(dir)).toEqual([]);
});

it('retains the system message and complete tool groups at the tail boundary', () => {
  const messages: Message[] = [{ role: 'system', content: 'instructions' }, ...hello,
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', arguments: {} }, { id: 'b', name: 'read', arguments: {} }] },
    { role: 'tool', toolCallId: 'a', content: 'a' }, { role: 'tool', toolCallId: 'b', content: 'b' }, { role: 'user', content: 'continue' }];
  expect(retainMessages(messages, 3)).toEqual([messages[0], ...messages.slice(2)]);
  const snapshot = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', cap: 3 });
  expect(snapshot.droppedMessages).toBe(1);
  expect(() => retainMessages(messages, 0)).toThrow();
});

it('cancels before changing any recovery state', () => {
  const controller = new AbortController(); controller.abort();
  expect(() => writeConversation(dir, 'test', hello, { expectedRevision: null, status: 'active', signal: controller.signal })).toThrow();
  expect(fs.readdirSync(dir)).toEqual([]);
});

it('pins simultaneous terminals to separate sessions even for same-named projects', () => {
  const a = storage.createSession(join(root, 'a', 'project'));
  const b = storage.createSession(join(root, 'b', 'project'));
  const c = storage.createSession(a.projectPath);
  expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  storage.saveSessionConversation(a.id, hello, { expectedRevision: null, status: 'cancelled' });
  storage.addChatMessage({ role: 'user', content: 'belongs to A' }, a.id);
  expect(storage.readSessionConversation(a.id).messages).toEqual(hello);
  expect(storage.readSessionConversation(b.id).messages).toEqual([]);
  expect(storage.readSessionConversation(c.id).messages).toEqual([]);
  expect(storage.getChatHistory(undefined, a.id)[0]?.content).toBe('belongs to A');
  expect(storage.getChatHistory(undefined, c.id)).toEqual([]);
  expect(() => storage.saveSessionConversation('missing', hello, { expectedRevision: null, status: 'active' })).toThrow(/not found/);
});

it('isolates session-scoped tool state across interleaved runtimes', async () => {
  const { withSession } = await import('../src/sessions/index.js');
  const a = storage.createSession(join(root, 'project'));
  const b = storage.createSession(join(root, 'project'));
  await Promise.all([a, b].map(session => withSession(session.id, async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    storage.addTodo(session.id);
    expect(storage.getCurrentSession()?.id).toBe(session.id);
    expect(storage.getSessionTodos().map(todo => todo.content)).toEqual([session.id]);
  })));
  expect(storage.getCurrentSession()?.id).toBe(b.id);
  expect(() => withSession('missing', () => storage.getSessionTodos())).toThrow(/no saved session/);
});


it('keeps the previous snapshot and cleans temporary files when fsync fails', () => {
  const saved = save();
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk failure'); });
  expect(() => save(hello, saved.revision)).toThrow(/disk space/);
  expect(readConversation(dir, 'test')).toEqual(saved);
  expect(fs.readdirSync(dir)).toEqual(['events', 'messages.json']);
});

it('rejects orphan or duplicate tool results and duplicate tool IDs', () => {
  const tool: Message = { role: 'tool', toolCallId: 'one', content: 'result' };
  const assistant: Message = { role: 'assistant', content: '', toolCalls: [{ id: 'one', name: 'read', arguments: {} }] };
  expect(() => validateMessages([tool])).toThrow();
  expect(() => validateMessages([assistant, tool, tool])).toThrow();
  expect(() => validateMessages([{ ...assistant, toolCalls: [...assistant.toolCalls!, ...assistant.toolCalls!] }])).toThrow();
});

it('skips malformed, symlinked and pipe session metadata without hanging or exposing contents', () => {
  const session = storage.createSession(root);
  const file = join(storage.getSessionDirById(session.id)!, 'session.json');
  fs.unlinkSync(file); execFileSync('mkfifo', [file]);
  expect(storage.listSessions()).toEqual([]);
  fs.unlinkSync(file); fs.symlinkSync(join(root, 'missing'), file);
  expect(storage.getSessionById(session.id)).toBeNull();
  fs.unlinkSync(file); fs.writeFileSync(file, '{');
  expect(storage.getSessionById(session.id)).toBeNull();
});
