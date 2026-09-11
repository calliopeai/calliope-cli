/** Real provider dispatcher + SDK parsing with synthetic stream faults. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as config from '../src/config.js';
import { chat, type StreamAttemptEvent } from '../src/providers/index.js';
import { StreamAttempt, validateStreamAttemptEvent } from '../src/providers/stream-attempt.js';
import { StreamInterruptedError, StreamProtocolError, classifyError, formatError } from '../src/errors.js';
import { renderReplay } from '../src/replay.js';
import type { RunLogLine } from '../src/runlog.js';
import { MAX_CONTENT_LENGTH } from '../src/providers/types.js';
const chunk = (text: string) => ({ id: 'toy', model: 'live-fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
const stream = (fail: boolean) => new Response([chunk('Hello '), ...(fail ? [{ error: { message: 'network failed TOKEN=opaque-secret' } }] : [chunk('world'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }])].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
beforeEach(() => {
  config.resetConfig(); config.setProviderCred('deepseek', { apiKey: 'synthetic', baseUrl: 'https://stream.invalid/v1' });
  vi.stubEnv('DEEPSEEK_API_KEY', ''); vi.stubEnv('DEEPSEEK_BASE_URL', '');
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(async () => stream(true)).mockImplementation(async () => stream(false)));
});
afterEach(() => { config.resetConfig(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('resets failed partial text before retry and records ordered attempts without content', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let visible = '', retried!: () => void; const waiting = new Promise<void>(resolve => { retried = resolve; });
  const events: StreamAttemptEvent[] = [], reset = vi.fn(() => { visible = ''; });
  const pending = chat('deepseek', [{ role: 'user', content: 'toy' }], [], 'live-fixture', token => { visible += token; }, () => retried(), { onStreamReset: reset, onStreamEvent: event => events.push(event) });
  await waiting; expect(reset).toHaveBeenCalledOnce(); expect(visible).toBe('');
  await vi.advanceTimersByTimeAsync(30000); expect((await pending).content).toBe('Hello world'); expect(visible).toBe('Hello world');
  expect(fetch).toHaveBeenCalledTimes(2); expect(events.map(event => [event.attempt, event.state])).toEqual([[1,'started'],[1,'failed'],[1,'retrying'],[2,'started'],[2,'completed']]);
  expect(events[0]!.id).toBe(events[2]!.id); expect(events[3]!.id).not.toBe(events[0]!.id);
  expect(JSON.stringify(events)).not.toContain('Hello'); expect(JSON.stringify(events)).not.toContain('opaque-secret');
});
it('stops append-only clients after partial output rather than duplicating chunks on automatic retry', async () => {
  const output: string[] = [], retry = vi.fn();
  await expect(chat('deepseek', [{ role: 'user', content: 'toy' }], [], 'live-fixture', token => output.push(token), retry)).rejects.toBeInstanceOf(StreamInterruptedError);
  expect(output).toEqual(['Hello ']); expect(fetch).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
  expect(classifyError(new StreamInterruptedError()).retryable).toBe(false);
});
it('cancels in the retry wait without another request or late output', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const controller = new AbortController(), reset = vi.fn(), events: StreamAttemptEvent[] = []; let retried!: () => void;
  const waiting = new Promise<void>(resolve => { retried = resolve; });
  const task = chat('deepseek', [{ role: 'user', content: 'toy' }], [], 'live-fixture', vi.fn(), () => retried(), { signal: controller.signal, onStreamReset: reset, onStreamEvent: event => events.push(event) });
  const assertion = expect(task).rejects.toMatchObject({ name: 'AbortError' }); await waiting; controller.abort(); await assertion;
  await vi.advanceTimersByTimeAsync(30000); expect(fetch).toHaveBeenCalledOnce();
  expect(events.at(-1)!.state).toBe('cancelled');
});
it('ignores settled/aborted attempt chunks and rejects malformed or oversized chunks', () => {
  const output = vi.fn(), event = vi.fn(), controller = new AbortController();
  const attempt = new StreamAttempt(1, output, event, controller.signal); attempt.push('first'); attempt.finish('failed'); attempt.push('late'); attempt.finish('completed');
  expect(output).toHaveBeenCalledTimes(1); expect(event.mock.calls.map(call => call[0].state)).toEqual(['started', 'failed']);
  const second = new StreamAttempt(2, output, event, controller.signal); controller.abort(); second.push('late'); expect(output).toHaveBeenCalledTimes(1);
  const bad = new StreamAttempt(3, output); expect(() => bad.push({} as string)).toThrow(StreamProtocolError);
  expect(() => bad.push('x'.repeat(MAX_CONTENT_LENGTH + 1))).toThrow(StreamProtocolError);
  expect(classifyError(new StreamProtocolError('bad')).retryable).toBe(false);
});

it('validates and replays stream metadata without accepting payload text or inventing a retry', () => {
  const events: StreamAttemptEvent[] = []; const attempt = new StreamAttempt(1, () => {}, event => events.push(event));
  attempt.push('ok'); attempt.finish('failed'); attempt.retry(1000);
  for (const event of events) expect(validateStreamAttemptEvent(event)).toEqual(event);
  for (const value of [null, {}, { ...events[0], attempt: 4 }, { ...events[0], emittedChars: -1 }, { ...events[0], content: 'untrusted' }, { ...events[2], delayMs: Infinity }])
    expect(() => validateStreamAttemptEvent(value)).toThrow(StreamProtocolError);
  const lines = events.map(stream => ({ type: 'stream_attempt', ts: '2026-09-11T00:00:00Z', stream })) as RunLogLine[];
  expect(renderReplay(lines, { ok: true })).toContain('retry in 1000ms');
  expect(renderReplay([{ ...lines[0], stream: { state: 'untrusted' } }] as RunLogLine[], { ok: true })).toContain('invalid stream attempt metadata');
  expect(formatError(new Error('network failure'), { retrying: false })).not.toContain('Auto-retry');
});
