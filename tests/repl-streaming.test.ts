/** Real controller, SDK transport and persistence, with controlled stream events. */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import * as storage from '../src/storage.js';
import { useChatController, type ChatController } from '../src/ui/state/use-chat-controller.js';
import { clearModelCache } from '../src/model-detection.js';
import { _resetModeTracking } from '../src/ui/agent.js';
import { readToolOutputs } from '../src/sessions/index.js';
import { resetRunLogs, readRunLog, RunLog, verifyChain } from '../src/runlog.js';
let root: string, controller: ChatController, unmount: (() => void) | undefined, count: number, fail: (() => void) | undefined;
let tools = false;
function Harness() { controller = useChatController(); return null; }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const event = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'toy', model: 'live-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
beforeEach(() => {
  config.resetConfig(); clearModelCache(); resetRunLogs(); _resetModeTracking(); tools = false; count = 0; fail = undefined;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-stream-repl-'))); vi.spyOn(process, 'cwd').mockReturnValue(root);
  for (const provider of config.getProviderNames()) { const vars = config.getProviderEnvVars(provider); for (const name of [vars.apiKey, vars.baseUrl]) if (name) vi.stubEnv(name, ''); }
  vi.stubEnv('CALLIOPE_PROVIDER', ''); vi.stubEnv('CALLIOPE_MODEL', '');
  config.setProviderCred('deepseek', { apiKey: 'synthetic', baseUrl: 'https://repl-stream.invalid/v1' });
  config.set('defaultProvider', 'deepseek'); config.set('defaultModel', 'live-fixture'); config.set('maxIterations', 2); config.set('autoUpgrade', false);
  vi.stubGlobal('fetch', vi.fn(async input => {
    if (String(input).endsWith('/models')) return json({ data: [{ id: 'live-fixture', capabilities: { tools: true, streaming: true } }] });
    count++;
    const headers = { 'content-type': 'text/event-stream' };
    if (count === 1 && !tools) return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode(event({ content: 'Old partial' })));
      fail = () => { stream.enqueue(new TextEncoder().encode('data: {"error":{"message":"network interrupted TOKEN=opaque-secret"}}\n\n')); stream.close(); };
    } }), { headers });
    if (count === 1 && tools) return new Response(event({ content: 'Reading the file.', tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"many.txt"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n', { headers });
    return new Response(event({ content: 'New answer' }, 'stop') + 'data: [DONE]\n\n', { headers });
  }));
});
afterEach(() => { unmount?.(); unmount = undefined; config.resetConfig(); clearModelCache(); resetRunLogs(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });
async function mount() { const before = controller; unmount = render(React.createElement(Harness)).unmount; await vi.waitFor(() => { expect(controller).not.toBe(before); expect(controller.status.model).toBeTruthy(); }); }
it('clears a failed partial attempt and commits only the successful replacement, with restartable audit metadata', async () => {
  await mount(); const task = controller.input.onSubmitMessage('Say hello');
  await vi.waitFor(() => expect(controller.transcript.streamingResponse).toBe('Old partial')); fail!();
  await vi.waitFor(() => { expect(controller.transcript.streamingResponse).toBe(''); expect(controller.transcript.thinkingState?.status).toContain('Retrying'); });
  await task; await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.type === 'assistant' && message.content === 'New answer')).toBe(true));
  expect(JSON.stringify(controller.transcript)).not.toContain('opaque-secret'); expect(count).toBe(2);
  const session = storage.getCurrentSession()!; expect(storage.readSessionConversation(session.id).messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['New answer']);
  const events = readRunLog(RunLog.open(session.id).filePath); expect(verifyChain(events).ok).toBe(true);
  expect(events.filter(event => event.type === 'stream_attempt').map(event => (event.stream as { state: string }).state)).toEqual(['started','failed','retrying','started','completed']);
}, 15000);
it('cancels during retry with immediate visual feedback and no replacement request', async () => {
  await mount(); const task = controller.input.onSubmitMessage('Say hello'); await vi.waitFor(() => expect(controller.transcript.streamingResponse).toBe('Old partial')); fail!();
  await vi.waitFor(() => expect(controller.transcript.thinkingState?.status).toContain('Retrying')); controller.input.onEscape(); await task;
  await vi.waitFor(() => { expect(controller.transcript.streamingResponse).toBe(''); expect(controller.transcript.activityState).toBeNull(); });
  expect(count).toBe(1); expect(storage.readSessionConversation(storage.getCurrentSession()!.id).status).toBe('cancelled');
});
it('preserves tool prefaces and output beyond five lines, and opens retained output after controller restart', async () => {
  tools = true; writeFileSync(join(root, 'many.txt'), Array.from({ length: 30 }, (_, i) => `Result line ${i}`).join('\n'));
  await mount(); await controller.input.onSubmitMessage('Read the file');
  const session = storage.getCurrentSession()!;
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.type === 'assistant' && message.content === 'Reading the file.')).toBe(true));
  const message = controller.transcript.messages.find(message => message.toolOutput)!; expect(message.content.length).toBeLessThanOrEqual(505); expect(message.toolOutput!.retainedLines).toBeGreaterThan(5);
  const output = readToolOutputs(storage.getSessionDirById(session.id)!).records[0]!; expect(output.content).toContain('Result line 29');
  await controller.input.onSubmitMessage('/tools last'); await vi.waitFor(() => expect(controller.modal.modalMode).toBe('tool-output')); expect(controller.input.disabled).toBe(true);
  expect(controller.modal.toolOutput?.record.id).toBe(output.id); controller.modal.onModalCancel(); unmount!(); await mount();
  await controller.input.onSubmitMessage(`/resume ${session.id}`); await controller.input.onSubmitMessage('/tools last');
  await vi.waitFor(() => expect(controller.modal.toolOutput?.record.id).toBe(output.id)); expect(controller.modal.toolOutput?.record.content).toContain('Result line 29'); expect(count).toBe(2);
});
