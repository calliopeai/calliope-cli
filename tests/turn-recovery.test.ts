/** Real storage, ledger and provider SDK; synthetic HTTP, not Native ownership qualification. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as config from '../src/config.js';
import { clearModelCache } from '../src/model-detection.js';
import { providerTarget } from '../src/health/target.js';
import { runTurn, prepareTurnRecovery, RuntimeControl, TURN_RECOVERY_PROTOCOL_VERSION, type TurnOptions, type TurnRecoveryInput, type PreparedTurnRecovery } from '../src/runtime/index.js';
import { ReservationLedger, manifestHash, requestCostNanos, type AgentExecution } from '../src/execution/index.js';
import { executionBinding } from '../src/execution/delegated.js';
import { createSession, readSessionConversation, saveSessionConversation, listSessions } from '../src/storage.js';
import { RunLog } from '../src/runlog.js';
import type { Message } from '../src/types.js';
import type { TurnRuntimeState } from '../src/sessions/runtime-state.js';
import type { TurnProgress } from '../src/sessions/turn-progress.js';
import { executionManifest } from './helpers/execution-manifest.js';
import { saveHooks } from '../src/hooks.js';
import { runHeadless } from '../src/headless.js';
import { createLedgerServer, LedgerServerState, mintLedgerToken } from '../src/execution/index.js';
import type { AddressInfo } from 'node:net';
import * as compressor from '../src/auto-compressor.js';

const realFetch = globalThis.fetch;

let root: string, project: string, ledger: ReservationLedger, execution: AgentExecution, requests: Record<string, unknown>[];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  config.resetConfig(); saveHooks([]); clearModelCache();
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-original-turn-')));
  project = join(root, 'project'); fs.mkdirSync(project); fs.mkdirSync(join(project, 'a'));
  config.set('budget', {}); config.set('policy', {}); config.set('sandbox', 'none');
  config.setProviderCred('deepseek', { apiKey: 'synthetic', baseUrl: 'https://recovery.invalid/v1' });
  const manifest = executionManifest(project, Date.now() - 10000);
  // This fixture's discovered full-context quote must fit the original account,
  // including the earlier settled request. Recovery never changes these limits.
  manifest.tokenBudget = manifest.accounts[0]!.tokenBudget = 10000;
  manifest.accounts[1]!.tokenBudget = manifest.accounts[2]!.tokenBudget = 5000;
  ledger = new ReservationLedger(join(root, 'ledger')); ledger.create(manifest);
  execution = { ledger, manifestHash: manifestHash(manifest), agentId: 'a', maxOutputTokens: 100,
    attribution: { version: 1, kind: 'task', taskId: 'original-task', attempt: 1,
      eventId: randomUUID(), eventHash: 'a'.repeat(64), sessionId: 'factory-original-run' } };
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url);
    expect(url.origin).toBe('https://recovery.invalid');
    if (url.pathname === '/v1/models') return json({ data: [{ id: 'toy', context_length: 2000, max_output_tokens: 100,
      pricing: { input: 1, output: 2 }, capabilities: { chat: true, tools: true, streaming: true } }] });
    expect(url.pathname).toBe('/v1/chat/completions');
    requests.push(await req.json() as Record<string, unknown>);
    return json({ id: 'resumed-reply', object: 'chat.completion', model: 'toy',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Original task complete.', reasoning_content: 'new opaque state' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  }));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); config.resetConfig(); saveHooks([]); clearModelCache();
  fs.rmSync(root, { recursive: true, force: true });
});

async function original(change?: (runtime: TurnRuntimeState & { version: 2 }, progress: TurnProgress, messages: Message[]) => void) {
  const reservation = { id: randomUUID(), agentId: 'a', provider: 'deepseek', model: 'toy', target: providerTarget('deepseek').key,
    inputTokens: 100, outputTokens: 100, inputPrice: 1, outputPrice: 2, costNanos: requestCostNanos(100, 100, 1, 2), attribution: execution.attribution };
  await ledger.reserve(project, execution.manifestHash, reservation);
  await ledger.settle(project, execution.manifestHash, { requestId: reservation.id, outcome: 'success', usage: { inputTokens: 9, outputTokens: 3 } });
  fs.writeFileSync(join(project, 'a/result.txt'), 'original write already completed');
  const session = createSession(project, { activate: false, executionBinding: executionBinding(execution) });
  const turnId = randomUUID(), startedAt = Date.now() - 5000;
  const progress: TurnProgress = { version: 1, turnId, iterationLimit: 3, completionLimit: 2, iterations: 1, completionChecks: 0 };
  const runtime: TurnRuntimeState & { version: 2 } = { version: 2, turnId, startedAt, deadline: startedAt + 60000,
    maxCostUsd: 0.005, continuations: 0, responseUsageComplete: true,
    totals: { inputTokens: 9, outputTokens: 3, estimatedCostUsd: 0.000015, toolCalls: 1 },
    effect: { kind: 'quiescent' }, execution: { phase: 'ready', activeEffects: [] } };
  const messages: Message[] = [
    { role: 'system', content: 'Keep the original acceptance criteria.' },
    { role: 'user', content: 'Finish this original task.' },
    { role: 'assistant', content: 'Writing the original result.',
      toolCalls: [{ id: 'original-write', name: 'write_file', arguments: { path: 'a/result.txt', content: 'original write already completed' } }],
      providerMetadata: { deepseek: { version: 1, reasoningContent: 'original opaque state' }, calliopeRouting: { provider: 'deepseek', model: 'toy' } } },
    { role: 'tool', toolCallId: 'original-write', content: 'Original write succeeded.' },
  ];
  change?.(runtime, progress, messages);
  const saved = saveSessionConversation(session.id, messages, { expectedRevision: null, status: 'active', progress, runtimeState: runtime });
  const checkpoint = { sessionId: session.id, revision: saved.revision, checksum: saved.checksum };
  const admit = vi.fn(async (proof: Parameters<TurnRecoveryInput['admit']>[0]) => {
    expect(proof.checkpoint).toEqual(checkpoint);
    expect(proof.executionBinding).toEqual(executionBinding(execution));
    expect(proof.executionBinding.version).toBe(2);
    expect(proof.runtimeState.turnId).toBe(turnId);
    expect(ledger.read(project).projection.spent.costNanos).toBe(15000);
    expect(requests).toHaveLength(0);
  });
  const input: TurnRecoveryInput = { version: 1, cwd: project, checkpoint,
    controls: { version: 1, sessionId: session.id, checkpoint: { revision: saved.revision, checksum: saved.checksum }, phase: 'running', pauses: [], steering: [] },
    request: { provider: 'deepseek', model: 'toy', reasoningEffort: null, target: providerTarget('deepseek').key, maxOutputTokens: 100 },
    policy: { confirmation: 'none', mode: null, parallel: false, continueOnLength: false, disableCompression: true,
      measuredInputReservation: false, inheritScope: false, maxRetries: 0, maxProviderRetries: null },
    nextIteration: 2, admit };
  return { session, saved, input, admit, runtime, progress, messages };
}

function options(prepared: PreparedTurnRecovery, extra: Partial<TurnOptions> = {}) {
  let saved = readSessionConversation(prepared.sessionId);
  const snapshots: TurnRuntimeState[] = [], allowances: TurnProgress[] = [];
  const opts: TurnOptions = { cwd: project, sessionId: prepared.sessionId, provider: 'deepseek', model: 'toy', prompt: '', messages: { current: [] },
    recovery: prepared, execution, control: prepared.control, confirmation: 'none', tools: () => [], disableCompression: true,
    retainRuntimeState: true, runtimeStateVersion: 2, retainTurnProgress: true,
    runlog: RunLog.open(prepared.sessionId, { enabled: false }),
    onCheckpoint: (messages, status, progress, runtimeState) => {
      saved = saveSessionConversation(prepared.sessionId, messages, { expectedRevision: saved.revision, status, progress, runtimeState });
    },
    onRuntimeStateCommitted: async state => { snapshots.push(structuredClone(state)); },
    onTurnProgressCommitted: async progress => { allowances.push(structuredClone(progress)); },
    controlSnapshot: () => ({ revision: saved.revision!, checksum: (saved as { checksum: string }).checksum }),
    onControlReady: async proof => { expect(proof.sessionId).toBe(prepared.sessionId); },
    maxCompletionChecks: 2,
    completionCheck: async () => ({ accepted: true, evidenceSha256: 'e'.repeat(64) }),
    ...extra };
  return { opts, snapshots, allowances };
}

it('resumes the exact original conversation, task account, counters and deadline without replaying its write', async () => {
  expect(TURN_RECOVERY_PROTOCOL_VERSION).toBe(1);
  const before = await original(), existingSessions = listSessions().map(item => item.id);
  const prepared = await prepareTurnRecovery(before.input);
  fs.writeFileSync(join(project, 'a/result.txt'), 'do not replay the original write');
  const { opts, snapshots, allowances } = options(prepared);
  const result = await runTurn(opts);
  expect(result.reason).toBe('completed'); expect(result.iterations).toBe(2);
  expect(result.totals).toMatchObject({ inputTokens: 16, outputTokens: 6, toolCalls: 1 });
  expect(result.totals.cost).toBeCloseTo(0.000028, 12); expect(result.totals.durationMs).toBeGreaterThanOrEqual(5000);
  expect(before.admit).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(1);
  expect((requests[0]!.messages as { role: string; reasoning_content?: string }[]).find(item => item.role === 'assistant')?.reasoning_content).toBe('original opaque state');
  expect(fs.readFileSync(join(project, 'a/result.txt'), 'utf8')).toBe('do not replay the original write');
  expect(readSessionConversation(before.session.id).messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(listSessions().map(item => item.id)).toEqual(existingSessions);
  expect(snapshots[0]).toEqual(before.runtime);
  expect(allowances.map(item => item.iterations)).toEqual([2, 2]);
  expect(snapshots.every(item => item.turnId === before.runtime.turnId && item.startedAt === before.runtime.startedAt && item.deadline === before.runtime.deadline)).toBe(true);
  expect(ledger.read(project).projection.spent).toEqual({ tokens: 22, costNanos: 28000 });
});

it('cannot reuse an admitted original recovery invocation', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input), current = options(prepared);
  await runTurn(current.opts);
  await expect(runTurn(options(prepared).opts)).rejects.toThrow(/consumed|original control/);
  expect(requests).toHaveLength(1);
});

it('detaches recovered routing decisions from presentation callback mutations', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  const { opts } = options(prepared, { onRoute: decision => {
    if (decision.selected) { decision.selected.provider = 'openai'; decision.selected.model = 'injected'; }
  } });
  expect((await runTurn(opts)).reason).toBe('completed');
  expect(requests).toHaveLength(1); expect(requests[0]!.model).toBe('toy');
});

it('refuses a provider target changed by a routing callback before dispatch', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  const { opts } = options(prepared, { onRoute: () => {
    config.setProviderCred('deepseek', { apiKey: 'synthetic', baseUrl: 'https://changed.invalid/v1' });
  } });
  await expect(runTurn(opts)).rejects.toThrow('Original recovery dispatch target changed');
  expect(requests).toHaveLength(0); expect(prepared.control.state.phase).toBe('stopped');
  expect(ledger.read(project).projection.spent.costNanos).toBe(15000);
});

it('refuses serialized preparation without consuming or stopping its genuine owner', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  const forged = { ...JSON.parse(JSON.stringify(prepared)), control: prepared.control } as PreparedTurnRecovery;
  await expect(runTurn(options(prepared, { recovery: forged }).opts)).rejects.toThrow('unavailable');
  expect(prepared.control.state.phase).toBe('running'); expect(requests).toHaveLength(0);
  expect((await runTurn(options(prepared).opts)).reason).toBe('completed');
});

it('refuses host ownership admission without changing the original conversation or spending', async () => {
  const before = await original();
  before.input.admit = vi.fn(async () => { throw new Error('Host refused original ownership'); });
  await expect(prepareTurnRecovery(before.input)).rejects.toThrow('Original recovery admission was not acknowledged');
  expect(before.input.admit).toHaveBeenCalledTimes(1);
  expect(readSessionConversation(before.session.id).revision).toBe(before.saved.revision);
  expect(requests).toHaveLength(0); expect(ledger.read(project).projection.spent.costNanos).toBe(15000);
});

it('cancels pending host admission and never continues after a late acknowledgment', async () => {
  const before = await original(), abort = new AbortController();
  let entered!: () => void, acknowledge!: () => void;
  const enteredAdmission = new Promise<void>(resolve => { entered = resolve; });
  const acknowledgment = new Promise<void>(resolve => { acknowledge = resolve; });
  before.input.admit = vi.fn(async () => { entered(); await acknowledgment; });
  const pending = prepareTurnRecovery({ ...before.input, signal: abort.signal });
  await enteredAdmission; abort.abort();
  await expect(pending).rejects.toThrow();
  acknowledge(); await acknowledgment; await Promise.resolve();
  expect(before.input.admit).toHaveBeenCalledTimes(1);
  expect(readSessionConversation(before.session.id).revision).toBe(before.saved.revision);
  expect(requests).toHaveLength(0); expect(ledger.read(project).projection.spent.costNanos).toBe(15000);
});

it('refuses an already bound recovered controller without stopping that external owner', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  prepared.control.bind(before.session.id);
  try {
    await expect(runTurn(options(prepared).opts)).rejects.toThrow('exact unbound original control history');
    expect(prepared.control.state.phase).toBe('running'); expect(requests).toHaveLength(0);
    expect(readSessionConversation(before.session.id).revision).toBe(before.saved.revision);
  } finally { prepared.control.stop(new Error('External fixture owner finished')); }
});

it('stops only its consumed original controller when a caller supplies another controller', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input), unrelated = new RuntimeControl();
  await expect(runTurn(options(prepared, { control: unrelated }).opts)).rejects.toThrow('original restored controller');
  expect(prepared.control.state.phase).toBe('stopped'); expect(unrelated.state.phase).toBe('running');
  expect(requests).toHaveLength(0); expect(readSessionConversation(before.session.id).revision).toBe(before.saved.revision);
  unrelated.stop(new Error('Unrelated fixture finished'));
});

it.each(['option', 'configuration'] as const)('durably retains a tightened %s cost cap across a second interruption', async source => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  if (source === 'configuration') config.set('budget', { maxCostPerRun: 0.00001 });
  const { opts } = options(prepared, { ...(source === 'option' ? { maxCostPerRun: 0.00001 } : {}),
    onControlReady: async () => { throw new Error('Synthetic loss of control acknowledgment'); } });
  await expect(runTurn(opts)).rejects.toThrow('Initial control checkpoint was not acknowledged');
  const saved = readSessionConversation(before.session.id);
  expect(saved.status).toBe('interrupted'); expect(saved.runtimeState?.maxCostUsd).toBe(0.00001);
  config.set('budget', {});
  const checkpoint = { sessionId: before.session.id, revision: saved.revision!, checksum: (saved as { checksum: string }).checksum };
  const again = await prepareTurnRecovery({ ...before.input, checkpoint,
    controls: { ...before.input.controls, checkpoint: { revision: checkpoint.revision, checksum: checkpoint.checksum } },
    admit: async proof => { expect(proof.runtimeState.maxCostUsd).toBe(0.00001); } });
  const result = await runTurn(options(again).opts);
  expect(result.reason).toBe('budget'); expect(requests).toHaveLength(0);
  expect(readSessionConversation(before.session.id).runtimeState?.maxCostUsd).toBe(0.00001);
  expect(ledger.read(project).projection.spent.costNanos).toBe(15000);
});

it('keeps recovered history private when the caller replaces its original message holder during admission', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  const { opts } = options(prepared);
  const holder = opts.messages;
  opts.onControlReady = async () => {
    holder.current.push({ role: 'user', content: 'Injected replacement history' });
    opts.messages = { current: [{ role: 'user', content: 'Another replacement holder' }] };
  };
  expect((await runTurn(opts)).reason).toBe('completed');
  expect(JSON.stringify(requests)).not.toContain('replacement');
  expect(readSessionConversation(before.session.id).messages.slice(0, before.messages.length)).toEqual(before.messages);
});

it('does not stop the active recovered owner when another invocation attempts to claim it', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  const { opts } = options(prepared, { onControlReady: async () => {
    await expect(runTurn(options(prepared).opts)).rejects.toThrow(/consumed/);
    expect(prepared.control.state.phase).toBe('running');
    expect(requests).toHaveLength(0);
  } });
  expect((await runTurn(opts)).reason).toBe('completed'); expect(requests).toHaveLength(1);
});

it('stops the consumed controller when retained disk evidence changes before runtime admission', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  saveSessionConversation(before.session.id, [...before.messages, { role: 'user', content: 'Changed on disk' }], {
    expectedRevision: before.saved.revision, status: 'active', progress: before.progress, runtimeState: before.runtime });
  await expect(runTurn(options(prepared).opts)).rejects.toThrow('checkpoint changed');
  expect(prepared.control.state.phase).toBe('stopped'); expect(requests).toHaveLength(0);
});

it('stops the consumed controller when runtime initialization fails before its checkpoint cleanup', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  const runtime = { version: 1 as const, tools: [], async execute() { return { result: 'unused' }; } };
  Object.defineProperty(runtime, 'tools', { get() { throw new Error('Synthetic host initialization failure'); } });
  await expect(runTurn(options(prepared, { toolRuntime: runtime }).opts)).rejects.toThrow('Host tool execution is unavailable or uncertain');
  expect(prepared.control.state.phase).toBe('stopped'); expect(requests).toHaveLength(0);
});

it('continues an admitted context-recorded iteration without repeating compression or consuming another iteration', async () => {
  const before = await original(runtime => { runtime.execution.phase = 'context_recorded'; });
  before.input.nextIteration = 1;
  before.input.policy.disableCompression = false;
  const prepared = await prepareTurnRecovery(before.input);
  const compress = vi.spyOn(compressor, 'autoCompress');
  const { opts, allowances } = options(prepared, { disableCompression: false });
  const result = await runTurn(opts);
  expect(result.reason).toBe('completed'); expect(result.iterations).toBe(1);
  expect(compress).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
  expect(allowances.map(item => item.iterations)).toEqual([1]);
  expect(readSessionConversation(before.session.id).progress?.turnId).toBe(before.runtime.turnId);
});

it('stops a claimed headless controller when original clock validation refuses preflight', async () => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await runHeadless({ recovery: prepared, cwd: project, maxTime: 999,
    ledger: { url: 'http://127.0.0.1:1', tokenFile: join(root, 'unused.token'), agentId: 'a' } })).toBe(2);
  expect(prepared.control.state.phase).toBe('stopped');
  expect(requests).toHaveLength(0);
  expect(readSessionConversation(before.session.id).revision).toBe(before.saved.revision);
});

it('retains the original paused receipt until its exact resume before another provider request', async () => {
  const before = await original();
  const paused = { ...before.input.checkpoint, requestId: 'original-pause', kind: 'paused' as const };
  before.input.controls.phase = 'paused';
  before.input.controls.pauses = [{ paused, resumed: null }];
  const prepared = await prepareTurnRecovery(before.input), committed: string[] = [];
  let resumed: ReturnType<typeof prepared.control.resume> | undefined;
  const { opts } = options(prepared, {
    onControlReady: async () => {
      expect(prepared.control.state.phase).toBe('paused');
      expect(requests).toHaveLength(0);
      await expect(prepared.control.pause('original-pause')).resolves.toEqual(paused);
      expect(() => prepared.control.resume({ ...paused, checksum: 'b'.repeat(64) })).toThrow('exact paused');
      resumed = prepared.control.resume(paused);
    },
    onControlCommitted: async receipt => { committed.push(receipt.kind); },
  });
  expect((await runTurn(opts)).reason).toBe('completed');
  await expect(resumed).resolves.toMatchObject({ sessionId: before.session.id, requestId: 'original-pause', kind: 'resumed' });
  expect(committed).toEqual(['resumed']); expect(requests).toHaveLength(1);
});

it('reopens the original headless conversation through its real HTTP task ledger without a new session or allowance', async () => {
  const before = await original();
  before.input.policy.disableCompression = false;
  before.input.policy.continueOnLength = true;
  const prepared = await prepareTurnRecovery(before.input), priorSessions = listSessions().map(item => item.id);
  const state = new LedgerServerState(join(root, 'server')), authority = 'c'.repeat(64);
  const savedLedger = ledger.read(project);
  if (execution.attribution?.kind !== 'task') throw new Error('Fixture requires original task attribution.');
  const server = createLedgerServer({ ledger, cwd: project, state, ownerAgentId: 'a', authority,
    taskExecution: { attribution: execution.attribution, maxOutputTokens: 100 } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokenFile = join(root, 'owner.token');
  fs.writeFileSync(tokenFile, mintLedgerToken(state.secret(), { v: 2, authority, run: savedLedger.manifest.runId,
    role: 'parent', owner: 'a', exp: savedLedger.manifest.deadline }), { mode: 0o600 });
  const providerFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(new Request(input, init).url).origin === url ? realFetch(input, init) : providerFetch(input, init));
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await runHeadless({ recovery: prepared, cwd: project, outputMode: 'json',
      ledger: { url, tokenFile, agentId: 'a', maxOutputTokens: 100 },
      retainRuntimeState: true, runtimeStateVersion: 2,
      onRuntimeStateCommitted: async proof => {
        expect(proof.sessionId).toBe(before.session.id);
        expect(proof.runtimeState.startedAt).toBe(before.runtime.startedAt);
        expect(proof.runtimeState.deadline).toBe(before.runtime.deadline);
      },
      onTurnProgressCommitted: async proof => { expect(proof.progress.turnId).toBe(before.progress.turnId); },
      onControlReady: async proof => { expect(proof.sessionId).toBe(before.session.id); },
      completionCheck: async () => ({ accepted: true, evidenceSha256: 'e'.repeat(64) }),
    });
    expect(code, output.join('')).toBe(0);
    expect(listSessions().map(item => item.id)).toEqual(priorSessions);
    const saved = readSessionConversation(before.session.id);
    expect(saved.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(saved.progress).toMatchObject({ turnId: before.progress.turnId, iterations: 2, completionChecks: 1 });
    expect(ledger.read(project).projection.spent).toEqual({ tokens: 22, costNanos: 28000 });
    expect(requests).toHaveLength(1);
    expect(output.join('')).toContain('"reason":"completed"');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('uses a stricter verifier installed through the original options of an ordinary headless invocation', async () => {
  const oldVerifier = vi.fn(async () => ({ accepted: true as const, evidenceSha256: 'a'.repeat(64) }));
  const stricterVerifier = vi.fn(async () => ({ accepted: false as const, feedback: 'Required artifact is missing.' }));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const opts: Parameters<typeof runHeadless>[0] = { cwd: project, provider: 'deepseek', model: 'toy', prompt: 'Complete the task.',
    maxIterations: 2, maxCompletionChecks: 1, control: new (await import('../src/runtime/control.js')).RuntimeControl(),
    completionCheck: oldVerifier, toolRuntime: { version: 1, tools: [], async execute() { throw new Error('No tools declared'); } },
    onControlReady: async () => { opts.completionCheck = stricterVerifier; } };
  expect(await runHeadless(opts)).not.toBe(0);
  expect(requests).toHaveLength(1); expect(oldVerifier).not.toHaveBeenCalled();
  expect(stricterVerifier).toHaveBeenCalledTimes(1);
});

it.each(['policy', 'account', 'output', 'prompt', 'iterations', 'effort', 'provider'] as const)('refuses changed %s before changing the checkpoint or dispatching', async kind => {
  const before = await original(), prepared = await prepareTurnRecovery(before.input);
  const changed: Partial<TurnOptions> = kind === 'policy' ? { maxRetries: 3 }
    : kind === 'account' ? { execution: { ...execution, agentId: 'b' } }
    : kind === 'output' ? { execution: { ...execution, maxOutputTokens: 200 } }
    : kind === 'prompt' ? { prompt: 'Replace the original task' }
    : kind === 'iterations' ? { maxIterations: 99 }
    : kind === 'effort' ? { reasoningEffort: 'high' }
    : { provider: 'openai' };
  await expect(runTurn(options(prepared, changed).opts)).rejects.toThrow();
  if (kind !== 'account') expect(prepared.control.state.phase).toBe('stopped');
  expect(readSessionConversation(before.session.id).revision).toBe(before.saved.revision);
  expect(requests).toHaveLength(0); expect(ledger.read(project).projection.spent.costNanos).toBe(15000);
});

it('requires the trusted host acknowledgment and rechecks the checkpoint afterward', async () => {
  const before = await original();
  before.input.admit = async () => {
    saveSessionConversation(before.session.id, [...before.messages, { role: 'user', content: 'Unacknowledged change' }], {
      expectedRevision: before.saved.revision, status: 'active', progress: before.progress, runtimeState: before.runtime });
  };
  await expect(prepareTurnRecovery(before.input)).rejects.toThrow('checkpoint changed');
  expect(requests).toHaveLength(0); expect(ledger.read(project).projection.spent.costNanos).toBe(15000);
});

it.each(['pending', 'usage', 'expired', 'iterations', 'checks'] as const)('holds original unresolved %s without asking for admission', async kind => {
  const before = await original((runtime, progress) => {
    if (kind === 'pending') { runtime.effect = { kind: 'provider', id: 'original-pending-request' }; runtime.execution = { phase: 'provider_pending', activeEffects: [{ kind: 'provider', id: 'original-pending-request' }] }; }
    if (kind === 'usage') runtime.responseUsageComplete = false;
    if (kind === 'expired') runtime.deadline = Date.now() - 1;
    if (kind === 'iterations') progress.iterations = 3;
    if (kind === 'checks') progress.completionChecks = progress.completionLimit = 1;
  });
  await expect(prepareTurnRecovery(before.input)).rejects.toThrow();
  expect(before.admit).not.toHaveBeenCalled(); expect(requests).toHaveLength(0);
  expect(readSessionConversation(before.session.id).revision).toBe(before.saved.revision);
  expect(ledger.read(project).projection.spent.costNanos).toBe(15000);
});
