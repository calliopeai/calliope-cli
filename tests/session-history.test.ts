import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Message } from '../src/types.js';
import { readConversation, writeConversation, replaySessionHistory, replayEvents, makeEvent, eventLink, applyEvent,
  readSessionEvent, MAX_HISTORY_BYTES, type ConversationState } from '../src/sessions/index.js';

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
let root: string, dir: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-history-'))); dir = join(root, 'session'); fs.mkdirSync(dir); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const messages = [{ role: 'user' as const, content: 'public toy prompt' }];
const save = (value: Message[], expectedRevision: string | null = null) => writeConversation(dir, 'test', value, { expectedRevision, status: 'active' });

it('records compact deltas and deterministically projects every committed revision', async () => {
  const one = save(messages);
  const two = save([...messages, { role: 'assistant', content: 'toy answer', providerMetadata: { opaque: { signature: 'toy-signature' } } }], one.revision);
  const event = readSessionEvent(dir, 'test', two.revision);
  expect(event.change.keep).toBe(1); expect(event.change.append).toHaveLength(1);
  expect((await replaySessionHistory(dir, 'test', one.history!)).snapshot).toEqual(one);
  const replay = await replaySessionHistory(dir, 'test', two.history!);
  expect(replay.snapshot).toEqual(two); expect(replay.events).toHaveLength(2);
  expect((await replayEvents([...replay.events].reverse(), two.history!, 'test')).snapshot).toEqual(two);
});

it('records tools, cancellation placeholders and compaction without losing metadata', async () => {
  const one = save(messages);
  const history: Message[] = [...messages, { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read', arguments: {} }], providerMetadata: { bedrock: { reasoningContent: [{ signature: 'opaque' }] } } },
    { role: 'tool', toolCallId: 'call', content: 'Outcome unknown; do not replay automatically.' }];
  const two = writeConversation(dir, 'test', history, { expectedRevision: one.revision, status: 'cancelled' });
  expect((await replaySessionHistory(dir, 'test', two.history!)).snapshot.messages).toEqual(history);
  const three = save([{ role: 'system', content: 'Summary of prior work' }, { role: 'user', content: 'next' }], two.revision);
  expect((await replaySessionHistory(dir, 'test', three.history!)).snapshot).toEqual(three);
  expect(readSessionEvent(dir, 'test', three.revision).change.keep).toBe(0);
});

it('anchors legacy data on first save and does not invent earlier revisions', async () => {
  fs.writeFileSync(join(dir, 'messages.json'), JSON.stringify(messages));
  const legacy = readConversation(dir, 'test');
  const saved = save([...messages, { role: 'assistant', content: 'next' }], legacy.revision);
  const replay = await replaySessionHistory(dir, 'test', saved.history!);
  expect(replay.events).toHaveLength(2); expect(replay.events[0]!.parent).toBeNull();
  expect(applyEvent(null, replay.events[0]!).messages).toEqual(messages);
});

it('preserves uncommitted records after failed replacement and follows only the committed head', async () => {
  const one = save(messages);
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('replacement failed'); });
  expect(() => save([...messages, { role: 'assistant', content: 'orphan' }], one.revision)).toThrow(/disk space/);
  rename.mockRestore();
  expect(fs.readdirSync(join(dir, 'events'))).toHaveLength(2);
  expect(readConversation(dir, 'test')).toEqual(one);
  expect((await replaySessionHistory(dir, 'test', one.history!)).events).toHaveLength(1);
  const two = save([...messages, { role: 'assistant', content: 'committed' }], one.revision);
  expect((await replaySessionHistory(dir, 'test', two.history!)).snapshot).toEqual(two);
  expect(fs.readdirSync(join(dir, 'events'))).toHaveLength(3);
});

it('detects damaged ancestry during replay and damaged head records during ordinary reads', async () => {
  const one = save(messages), two = save([...messages, { role: 'assistant', content: 'next' }], one.revision);
  const rootEvent = join(dir, 'events', `${one.revision}.json`);
  fs.writeFileSync(rootEvent, '{}');
  await expect(replaySessionHistory(dir, 'test', two.history!)).rejects.toThrow(/damaged/);
  expect(readConversation(dir, 'test')).toEqual(two); // Cached projection validates its own head.
  fs.unlinkSync(join(dir, 'events', `${two.revision}.json`));
  expect(() => readConversation(dir, 'test')).toThrow(/damaged/);
});

it('refuses symlink history directories and non-regular records', () => {
  const outside = join(root, 'outside'); fs.mkdirSync(outside); fs.symlinkSync(outside, join(dir, 'events'));
  expect(() => save(messages)).toThrow(); expect(fs.readdirSync(outside)).toEqual([]);
  fs.unlinkSync(join(dir, 'events')); const one = save(messages);
  const event = join(dir, 'events', `${one.revision}.json`); fs.unlinkSync(event); fs.symlinkSync(join(root, 'missing'), event);
  expect(() => readConversation(dir, 'test')).toThrow();
});

it('enforces a hard byte budget without deleting history or overwriting the snapshot', () => {
  const one = save(messages);
  const fd = fs.openSync(join(dir, 'events', 'orphan.json'), 'wx'); fs.ftruncateSync(fd, MAX_HISTORY_BYTES); fs.closeSync(fd);
  expect(() => save(messages, one.revision)).toThrow(/history budget/);
  expect(readConversation(dir, 'test')).toEqual(one);
  expect(fs.statSync(join(dir, 'events', 'orphan.json')).size).toBe(MAX_HISTORY_BYTES);
});

it('rejects malformed changes, missing links, duplicates and invalid state hashes', async () => {
  const one = save(messages); const event = readSessionEvent(dir, 'test', one.revision);
  await expect(replayEvents([], one.history!, 'test')).rejects.toThrow();
  await expect(replayEvents([event, event], one.history!, 'test')).rejects.toThrow();
  await expect(replayEvents([event], { ...one.history!, id: randomUUID() }, 'test')).rejects.toThrow();
  for (const change of [{ keep: 2 }, { status: 'unknown' }, { droppedMessages: -1 }, { append: [{ role: 'alien' }] }]) {
    await expect(replayEvents([{ ...event, change: { ...event.change, ...change } } as typeof event], one.history!, 'test')).rejects.toThrow();
  }
});

it('cancels long projection work cooperatively', async () => {
  const events = []; let previous: ConversationState | null = null;
  for (let i = 0; i < 65; i++) {
    const next: ConversationState = { messages, revision: null, status: 'active', droppedMessages: 0 };
    const event = makeEvent('test', previous, next, events.length ? eventLink(events.at(-1)!) : null);
    events.push(event); previous = applyEvent(previous, event);
  }
  const controller = new AbortController(); setImmediate(() => controller.abort());
  await expect(replayEvents(events, eventLink(events.at(-1)!), 'test', controller.signal)).rejects.toThrow();
});
