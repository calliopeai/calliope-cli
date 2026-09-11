/** Real controller, runtime, discovery, SDK and persistence; synthetic transport. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import { clearModelCache } from '../src/model-detection.js';
import { useChatController, type ChatController } from '../src/ui/state/use-chat-controller.js';
import { _resetModeTracking } from '../src/ui/agent.js';
import { resetRunLogs, readRunLog, verifyChain, RunLog } from '../src/runlog.js';
import { saveProjectDefaults } from '../src/preferences/index.js';
import { trustProject } from '../src/trust.js';
import * as storage from '../src/storage.js';

let root: string, controller: ChatController, unmount: (() => void) | undefined;
let requests: { model: string; messages: { role: string; content: string }[] }[];
let holdFirst: boolean, release: (() => void) | undefined;
let firstSignal: AbortSignal | undefined;
let vision = true;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function Harness() { controller = useChatController(); return null; }
function stream(model: string) {
  const chunks = [
    { id: 'toy', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] },
    { id: 'toy', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
beforeEach(() => {
  config.resetConfig(); clearModelCache(); resetRunLogs(); _resetModeTracking();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-repl-turn-')));
  requests = []; holdFirst = false; release = undefined; firstSignal = undefined; vision = true;
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  for (const provider of config.getProviderNames()) {
    const vars = config.getProviderEnvVars(provider);
    for (const name of [vars.apiKey, vars.baseUrl]) if (name) vi.stubEnv(name, '');
  }
  vi.stubEnv('CALLIOPE_PROVIDER', ''); vi.stubEnv('CALLIOPE_MODEL', '');
  for (const provider of ['deepseek', 'xai'] as const) config.setProviderCred(provider, { apiKey: 'fake', baseUrl: `https://${provider}.invalid/v1` });
  config.set('defaultProvider', 'deepseek'); config.set('defaultModel', 'deepseek-live');
  config.set('maxIterations', 2); config.set('autoUpgrade', false);
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = new URL(String(input)), provider = url.hostname.split('.')[0]!;
    if (url.pathname === '/v1/models') return json({ data: [{ id: `${provider}-live`, capabilities: { tools: true, streaming: true, vision } }] });
    expect(url.pathname).toBe('/v1/chat/completions');
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (holdFirst && requests.length === 1) {
      firstSignal = init?.signal as AbortSignal;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(firstSignal!.reason);
        release = () => { firstSignal!.removeEventListener('abort', abort); resolve(); };
        firstSignal!.addEventListener('abort', abort, { once: true });
      });
    }
    return stream(body.model);
  }));
});
afterEach(() => { unmount?.(); unmount = undefined; release?.(); config.resetConfig(); clearModelCache(); resetRunLogs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function mount() {
  unmount = render(React.createElement(Harness)).unmount;
  await vi.waitFor(() => expect(controller.status.model).toBeTruthy());
}

it('runs each queued override separately and restores the session selection after the temporary turn', async () => {
  holdFirst = true; await mount();
  const pending = controller.input.onSubmitMessage('/once --provider xai --model xai-live -- First');
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  controller.input.onQueueMessage('Second');
  controller.input.onQueueMessage('/once --provider xai --model xai-live -- Third');
  controller.input.onQueueMessage('Fourth');
  await vi.waitFor(() => expect(controller.input.queuedCount).toBe(3));
  release!(); await pending;
  await vi.waitFor(() => expect(controller.input.isProcessing).toBe(false));
  expect(requests.map(request => request.model)).toEqual(['xai-live', 'deepseek-live', 'xai-live', 'deepseek-live']);
  expect(requests.map(request => request.messages.filter(message => message.role === 'user').at(-1)?.content)).toEqual(['First', 'Second', 'Third', 'Fourth']);
  expect(controller.input.queuedCount).toBe(0); expect(controller.status.provider).toBe('deepseek');
  expect(config.get('defaultProvider')).toBe('deepseek');
  const session = storage.getCurrentSession()!, events = readRunLog(RunLog.open(session.id).filePath);
  expect(verifyChain(events).ok).toBe(true);
  expect(events.filter(event => event.type === 'routing_decision').some(event => (event.decision as { preferenceSources?: { provider: string } }).preferenceSources?.provider === 'turn')).toBe(true);
});

it('cancels an override immediately, preserves queued work, and does not leak it into the next explicit turn', async () => {
  holdFirst = true; await mount();
  const pending = controller.input.onSubmitMessage('/once --provider xai --model xai-live -- First');
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  controller.input.onQueueMessage('Queued');
  await vi.waitFor(() => expect(controller.input.isProcessing).toBe(true));
  controller.input.onEscape(); await pending;
  expect(firstSignal?.aborted).toBe(true); expect(requests).toHaveLength(1);
  await vi.waitFor(() => expect(controller.input.queuedCount).toBe(1));
  await controller.input.onSubmitMessage('Resume');
  expect(requests.map(request => request.model)).toEqual(['xai-live', 'deepseek-live', 'deepseek-live']);
  await vi.waitFor(() => expect(controller.input.queuedCount).toBe(0));
});

it('restores trusted project preferences on restart and keeps direct provider switches local to the session', async () => {
  trustProject(root); await saveProjectDefaults(root, { provider: 'xai', model: 'xai-live' });
  await mount(); expect(controller.status.provider).toBe('xai');
  await controller.input.onSubmitMessage('/provider deepseek');
  await vi.waitFor(() => expect(controller.status.provider).toBe('deepseek'));
  expect(config.get('defaultProvider')).toBe('deepseek');
  unmount!(); await mount(); expect(controller.status.provider).toBe('xai');
});

it('parses a direct-send override before cancellation and preserves the model chosen for that turn', async () => {
  holdFirst = true; await mount();
  const pending = controller.input.onSubmitMessage('First');
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  controller.input.onDirectSend('/once --provider xai --model xai-live -- Replacement');
  await pending;
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  await vi.waitFor(() => expect(controller.input.isProcessing).toBe(false));
  expect(firstSignal?.aborted).toBe(true);
  expect(requests[1]).toMatchObject({ model: 'xai-live' });
  expect(requests[1]!.messages.filter(message => message.role === 'user').at(-1)?.content).toBe('Replacement');
  expect(controller.status.provider).toBe('deepseek');
});

it('keeps attached images for live capability validation and rejects discovered incompatibility', async () => {
  const file = join(root, 'toy.png');
  writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  await mount(); await controller.input.onSubmitMessage('Describe @toy.png');
  expect(requests).toHaveLength(1);
  const last = requests[0]!.messages.filter(message => message.role === 'user').at(-1)!;
  expect(last.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]));
  vision = false; clearModelCache(); await controller.input.onSubmitMessage('Describe @toy.png again');
  expect(requests).toHaveLength(1);
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content.includes('No eligible'))).toBe(true));
});

it('removing a queued override restores its submission-time base preference', async () => {
  holdFirst = true; await mount();
  const pending = controller.input.onSubmitMessage('First');
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  controller.input.onQueueMessage('/once --provider xai --model xai-live -- queued');
  await vi.waitFor(() => expect(controller.input.queuedCount).toBe(1));
  controller.input.onEditQueuedMessage(0, 'Edited');
  release!(); await pending;
  expect(requests.map(request => request.model)).toEqual(['deepseek-live', 'deepseek-live']);
});

it('applies the current session mode when a queued turn starts without changing its model snapshot', async () => {
  holdFirst = true; await mount();
  const pending = controller.input.onSubmitMessage('First');
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  controller.input.onQueueMessage('/once --provider xai --model xai-live -- Queued');
  controller.input.onCycleMode(); controller.input.onCycleMode();
  await vi.waitFor(() => expect(controller.input.currentMode).toBe('plan'));
  release!(); await pending;
  expect(requests.map(request => request.model)).toEqual(['deepseek-live', 'xai-live']);
  expect(requests[1]!.messages.some(message => message.role === 'system' && typeof message.content === 'string' && message.content.includes('PLAN mode: no mutating tools'))).toBe(true);
});

it('starts unique sessions, lists them and resumes a validated snapshot after restart', async () => {
  await mount(); await controller.input.onSubmitMessage('Remember the toy task');
  const first = storage.getCurrentSession()!;
  const saved = storage.readSessionConversation(first.id);
  expect(saved.status).toBe('completed');
  unmount!(); await mount();
  const second = storage.getCurrentSession()!; expect(second.id).not.toBe(first.id);
  expect(storage.readSessionConversation(first.id)).toEqual(saved);
  await controller.input.onSubmitMessage('/sessions');
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content.includes(first.id))).toBe(true));
  await controller.input.onSubmitMessage(`/resume ${first.id}`);
  await controller.input.onSubmitMessage('Continue the toy task');
  expect(requests.at(-1)!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Remember the toy task', 'Continue the toy task']);
  expect(storage.readSessionConversation(second.id).messages).toHaveLength(1);
  await vi.waitFor(() => expect(controller.input.isProcessing).toBe(false));
  await controller.input.onSubmitMessage('/NEW');
  expect(storage.getCurrentSession()!.id).not.toBe(first.id);
  await controller.input.onSubmitMessage('Fresh task');
  expect(requests.at(-1)!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Fresh task']);
});

it('branches, switches, compares, replays and transfers recorded conversations without extra inference', async () => {
  await mount(); await controller.input.onSubmitMessage('Original conversation');
  const original = storage.getCurrentSession()!;
  await vi.waitFor(() => expect(controller.input.isProcessing).toBe(false));
  await controller.input.onSubmitMessage('/branch experiment');
  const branch = storage.getCurrentSession()!; expect(branch.id).not.toBe(original.id);
  expect(branch.lineage?.name).toBe('experiment');
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.type === 'user' && message.content === 'Original conversation')).toBe(true));
  await controller.input.onSubmitMessage('Branch conversation');
  await vi.waitFor(() => expect(controller.input.isProcessing).toBe(false));
  await controller.input.onSubmitMessage(`/diff ${original.id}`);
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content.includes('2 added'))).toBe(true));
  await controller.input.onSubmitMessage('/replay');
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content.includes('events verified'))).toBe(true));
  await controller.input.onSubmitMessage('/export history.json');
  await controller.input.onSubmitMessage('/export readable.md');
  await controller.input.onSubmitMessage('/import history.json');
  expect(storage.getCurrentSession()?.id).toBe(branch.id);
  await vi.waitFor(() => expect(controller.transcript.messages.filter(message => message.type === 'error').map(message => message.content)).toEqual([]));
  const imported = storage.listSessions(10000).find(item => item.lineage?.kind === 'import' && item.lineage.sessionId === branch.id)!;
  expect(storage.readSessionConversation(imported.id).messages.filter(message => message.role === 'user')).toHaveLength(2);
  await controller.input.onSubmitMessage(`/checkout ${original.id}`);
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content === 'Original conversation')).toBe(true));
  expect(controller.transcript.messages.some(message => message.content === 'Branch conversation')).toBe(false);
  await controller.input.onSubmitMessage('/checkout experiment');
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content === 'Branch conversation')).toBe(true));
  expect(requests).toHaveLength(2);
});

it('refuses branch, transfer and checkout commands during an active turn', async () => {
  holdFirst = true; await mount(); const session = storage.getCurrentSession()!;
  const pending = controller.input.onSubmitMessage('Wait'); await vi.waitFor(() => expect(requests).toHaveLength(1));
  for (const command of ['/branch unsafe', `/checkout ${session.id}`, '/export active.json', '/import missing.json']) await controller.input.onSubmitMessage(command);
  expect(storage.getCurrentSession()?.id).toBe(session.id);
  expect(storage.listSessions(10000).some(item => item.lineage?.sessionId === session.id)).toBe(false);
  controller.input.onEscape(); await pending;
});

it('refuses damaged or cross-project resumes without losing current state', async () => {
  await mount(); await controller.input.onSubmitMessage('Keep current task');
  const active = storage.getCurrentSession()!;
  const other = storage.createSession(root);
  const file = join(storage.getSessionDirById(other.id)!, 'messages.json');
  writeFileSync(file, 'private-marker invalid JSON');
  await vi.waitFor(() => expect(controller.input.isProcessing).toBe(false));
  await controller.input.onSubmitMessage(`/resume ${other.id}`);
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content.includes('damaged'))).toBe(true));
  expect(controller.transcript.messages.some(message => message.content.includes('private-marker'))).toBe(false);
  const outside = storage.createSession(tmpdir());
  await controller.input.onSubmitMessage(`/resume ${outside.id}`);
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content.includes('belongs to'))).toBe(true));
  await controller.input.onSubmitMessage('Continue current task');
  expect(requests.at(-1)!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Keep current task', 'Continue current task']);
  expect(storage.readSessionConversation(active.id).messages.at(-1)?.content).toBe('Done.');
});

it('saves cancellation for recovery and refuses session switching during an active turn', async () => {
  holdFirst = true; await mount(); const session = storage.getCurrentSession()!;
  const pending = controller.input.onSubmitMessage('Interrupted toy task');
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  await controller.input.onSubmitMessage('/new');
  expect(storage.getCurrentSession()!.id).toBe(session.id);
  controller.input.onEscape(); await pending;
  expect(storage.readSessionConversation(session.id).status).toBe('cancelled');
  expect(storage.readSessionConversation(session.id).messages.at(-1)?.content).toBe('Interrupted toy task');
});

it('halts before inference on a stale session revision and recovers through explicit resume', async () => {
  await mount(); const session = storage.getCurrentSession()!, state = storage.readSessionConversation(session.id);
  storage.saveSessionConversation(session.id, [...state.messages, { role: 'user', content: 'Other terminal' }], { expectedRevision: state.revision, status: 'completed' });
  await controller.input.onSubmitMessage('Stale write');
  expect(requests).toEqual([]);
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.content.includes('another terminal'))).toBe(true));
  await vi.waitFor(() => expect(controller.input.isProcessing).toBe(false));
  await controller.input.onSubmitMessage('/resume');
  await controller.input.onSubmitMessage('Recovered');
  expect(requests.at(-1)!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Other terminal', 'Recovered']);
});


it('shows a recovery failure even when cancellation is already in progress', async () => {
  holdFirst = true; await mount(); const session = storage.getCurrentSession()!;
  const pending = controller.input.onSubmitMessage('Cancel with a competing writer');
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const state = storage.readSessionConversation(session.id);
  const replacement = storage.saveSessionConversation(session.id, state.messages, { expectedRevision: state.revision, status: 'interrupted' });
  controller.input.onEscape(); await pending;
  await vi.waitFor(() => expect(controller.transcript.messages.some(message => message.type === 'error' && message.content.includes('another terminal'))).toBe(true));
  expect(storage.readSessionConversation(session.id).revision).toBe(replacement.revision);
});
