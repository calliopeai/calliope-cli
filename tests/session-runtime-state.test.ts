import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyEvent, eventLink, hash, makeBundle, makeEvent, parseBundle, readConversation, replaySessionHistory,
  validateTurnRuntimeState, writeConversation, type TurnProgress, type TurnRuntimeState } from '../src/sessions/index.js';

let root: string, dir: string;
const messages = [{ role: 'user' as const, content: 'original goal' }];
const progress = (): TurnProgress => ({ version: 1, turnId: randomUUID(), iterationLimit: 8, completionLimit: 3, iterations: 2, completionChecks: 0 });
const runtime = (turnId: string): TurnRuntimeState => ({ version: 1, turnId, startedAt: 1000, deadline: 10000,
  maxCostUsd: 8, continuations: 2, responseUsageComplete: true,
  totals: { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.2, toolCalls: 1 },
  effect: { kind: 'provider', id: randomUUID() } });
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-runtime-state-')));
  dir = join(root, 'session'); fs.mkdirSync(dir);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it.each(['provider', 'tool', 'question', 'verification'] as const)('retains unresolved %s evidence through saves, history and portable transfer', async kind => {
  const allowance = progress(), state = runtime(allowance.turnId);
  state.effect = { kind, id: 'original-effect' };
  const first = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: allowance, runtimeState: state });
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: first.revision, status: 'interrupted' });
  expect(readConversation(dir, 'test')).toEqual(saved);
  expect(saved.runtimeState).toEqual(state);
  const replay = await replaySessionHistory(dir, 'test', saved.history!);
  expect(replay.events.every(event => event.version === 3)).toBe(true);
  expect(replay.snapshot).toEqual(saved);
  const parsed = await parseBundle(JSON.stringify(makeBundle(replay, [])));
  expect(parsed.replay.snapshot.runtimeState).toEqual(state);
  expect(parsed.replay.snapshot.progress).toEqual(allowance);
});

it.each(['turnId', 'startedAt', 'deadline', 'maxCostUsd', 'responseUsageComplete', 'inputTokens', 'outputTokens', 'estimatedCostUsd', 'toolCalls'])('refuses changed original authority or regained accounting in %s, even with resealed event hashes', key => {
  const allowance = progress(), state = runtime(allowance.turnId);
  state.responseUsageComplete = false;
  const original = { revision: null, messages, status: 'active' as const, droppedMessages: 0, progress: allowance, runtimeState: state };
  const anchor = makeEvent('test', null, original, null);
  const before = applyEvent(null, anchor);
  const changed = structuredClone(state);
  if (key === 'turnId') changed.turnId = randomUUID();
  else if (key === 'responseUsageComplete') changed.responseUsageComplete = true;
  else if (key in changed.totals) changed.totals[key as keyof typeof changed.totals] = 0;
  else if (key === 'startedAt' || key === 'deadline' || key === 'maxCostUsd') changed[key] = Number(changed[key]) + 1;
  const after = { ...before, runtimeState: changed };
  expect(() => makeEvent('test', before, after, eventLink(anchor))).toThrow(/invalid/);
  const valid = makeEvent('test', before, before, eventLink(anchor));
  valid.change.runtimeState = changed;
  const { hash: _hash, ...body } = valid;
  valid.hash = hash(JSON.stringify(body));
  expect(() => applyEvent(before, valid)).toThrow(/invalid/);
});

it('does not allow runtime evidence to disappear or attach to another turn', () => {
  const allowance = progress(), state = runtime(allowance.turnId);
  expect(() => writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', runtimeState: state })).toThrow(/invalid/);
  expect(() => writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: progress(), runtimeState: state })).toThrow(/invalid/);
  const before = { revision: null, messages, status: 'active' as const, droppedMessages: 0, progress: allowance, runtimeState: state };
  const anchor = makeEvent('test', null, before, null);
  expect(() => makeEvent('test', before, { ...before, runtimeState: undefined }, eventLink(anchor))).toThrow(/invalid/);
});

it('preserves unknown usage while recording later known usage and a new quiescent boundary', () => {
  const allowance = progress(), state = runtime(allowance.turnId);
  state.responseUsageComplete = false;
  const first = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: allowance, runtimeState: state });
  const next = { ...state, continuations: 0, effect: { kind: 'quiescent' as const }, totals: { ...state.totals, outputTokens: 30 } };
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: first.revision, status: 'active', runtimeState: next });
  expect(saved.runtimeState).toEqual(next);
  expect(saved.runtimeState?.responseUsageComplete).toBe(false);
});

it('cannot retroactively manufacture initial execution evidence for an existing conversation', () => {
  const allowance = progress();
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: allowance });
  expect(() => writeConversation(dir, 'test', messages, { expectedRevision: saved.revision, status: 'active', runtimeState: runtime(allowance.turnId) })).toThrow(/invalid/);
  expect(readConversation(dir, 'test')).toEqual(saved);
});

it.each([
  { startedAt: -1 }, { startedAt: true }, { deadline: 999 }, { deadline: Infinity }, { maxCostUsd: 0 },
  { maxCostUsd: NaN }, { continuations: 5 }, { continuations: -1 }, { continuations: 0.5 }, { responseUsageComplete: 1 },
  { effect: { kind: 'quiescent', id: 'extra' } }, { effect: { kind: 'tool', id: 'invalid\u0000id' } },
  { effect: { kind: 'tool' } }, { effect: { kind: 'unknown', id: 'call' } },
  ...['provider', 'tool', 'question', 'verification'].map(kind => ({ effect: { kind: [kind], id: 'call' } })),
  { totals: { inputTokens: true, outputTokens: 1, estimatedCostUsd: 0, toolCalls: 0 } }, { extra: 1 },
])('rejects malformed durable evidence %j', change => {
  expect(() => validateTurnRuntimeState({ ...runtime(randomUUID()), ...change })).toThrow(/invalid/);
});

it('retains v2 phase and every active tool across exact history replay and transfer', async () => {
  const allowance = progress();
  const state: TurnRuntimeState = { ...runtime(allowance.turnId), version: 2, effect: { kind: 'tool', id: 'second' },
    execution: { phase: 'tools_pending', activeEffects: [{ kind: 'tool', id: 'first' }, { kind: 'tool', id: 'second' }] } };
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: allowance, runtimeState: state });
  const replay = await replaySessionHistory(dir, 'test', saved.history!);
  expect(replay.snapshot.runtimeState).toEqual(state);
  const parsed = await parseBundle(JSON.stringify(makeBundle(replay, [])));
  expect(parsed.replay.snapshot.runtimeState).toEqual(state);
  const downgrade = { ...state, version: 1 } as unknown as TurnRuntimeState;
  delete (downgrade as unknown as Record<string, unknown>).execution;
  expect(() => writeConversation(dir, 'test', messages, { expectedRevision: saved.revision, status: 'active', runtimeState: downgrade })).toThrow(/invalid/);
});

it.each([
  { phase: 'unknown', activeEffects: [] },
  { phase: 'ready', activeEffects: [{ kind: 'provider', id: 'one' }] },
  { phase: 'provider_pending', activeEffects: [] },
  { phase: 'provider_pending', activeEffects: [{ kind: 'provider', id: 'one' }, { kind: 'provider', id: 'two' }] },
  { phase: 'tools_pending', activeEffects: [{ kind: 'tool', id: 'same' }, { kind: 'tool', id: 'same' }] },
  { phase: 'tools_pending', activeEffects: [{ kind: 'question', id: 'one' }] },
  { phase: 'response_recorded', activeEffects: [], extra: true },
  { phase: 'tools_pending', activeEffects: [{ kind: 'tool', id: 'bad\u0000id' }] },
])('rejects contradictory or malformed v2 execution facts %j', execution => {
  expect(() => validateTurnRuntimeState({ ...runtime(randomUUID()), version: 2, execution })).toThrow(/invalid/);
});

it('does not upgrade old v1 evidence into a manufactured v2 execution phase', () => {
  const allowance = progress(), state = runtime(allowance.turnId);
  const saved = writeConversation(dir, 'test', messages, { expectedRevision: null, status: 'active', progress: allowance, runtimeState: state });
  const upgrade: TurnRuntimeState = { ...state, version: 2, execution: { phase: 'provider_pending', activeEffects: [{ kind: 'provider', id: state.effect.kind === 'quiescent' ? 'unused' : state.effect.id }] } };
  expect(() => writeConversation(dir, 'test', messages, { expectedRevision: saved.revision, status: 'active', runtimeState: upgrade })).toThrow(/invalid/);
});
