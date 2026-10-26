/** Native session restrictions survive save/branch; a marker never supplies authority. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executionBinding, assertExecutionBinding, parseDelegatedExecutionOptions } from '../src/execution/delegated.js';
import { validSessionExecutionBinding } from '../src/sessions/execution-binding.js';
import { createSession, getSessionById, getSessionDirById, saveSessionConversation } from '../src/storage.js';
import { runTurn } from '../src/runtime/turn.js';
import { branchSession } from '../src/session-management/actions.js';
import { ReservationLedger, manifestHash, type AgentExecution } from '../src/execution/index.js';
import { executionManifest } from './helpers/execution-manifest.js';

let root: string, project: string, execution: AgentExecution;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-session-binding-')));
  project = join(root, 'project'); mkdirSync(project);
  const manifest = executionManifest(project);
  const ledger = new ReservationLedger(join(root, 'budget')); ledger.create(manifest);
  execution = { ledger, manifestHash: manifestHash(manifest), agentId: 'a', maxOutputTokens: 100 };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('delegated session binding', () => {
  it('persists the exact task attempt through save and branch and rejects task replacement or downgrade', async () => {
    execution.attribution={version:1,kind:'task',eventId:randomUUID(),eventHash:'a'.repeat(64),sessionId:randomUUID(),taskId:'inspect-a',attempt:1};
    const binding=executionBinding(execution);
    expect(validSessionExecutionBinding(binding)).toBe(true);
    const session=createSession(project,{activate:false,executionBinding:binding});
    saveSessionConversation(session.id,[{role:'user',content:'continue'}],{expectedRevision:null,status:'completed'});
    const branch=await branchSession(session.id,{kind:'safety'});
    expect(getSessionById(session.id)?.executionBinding).toEqual(binding);
    expect(getSessionById(branch.session.id)?.executionBinding).toEqual(binding);
    const {attribution,...unbound}=execution;
    expect(()=>assertExecutionBinding(binding,unbound)).toThrow();
    expect(()=>assertExecutionBinding(executionBinding(unbound),execution)).toThrow();
    for(const patch of [{attempt:2},{taskId:'inspect-b'},{eventId:randomUUID()},{eventHash:'b'.repeat(64)},{sessionId:randomUUID()}]){
      expect(()=>assertExecutionBinding(binding,{...execution,attribution:{...attribution,...patch}})).toThrow();
    }
    for(const patch of [{attempt:0},{attempt:5},{kind:'supervision'},{eventId:'bad'},{eventHash:'bad'},{sessionId:''},{taskId:'../a'},{extra:true}]){
      expect(validSessionExecutionBinding({...binding,attribution:{...attribution,...patch}})).toBe(false);
    }
  });

  it('requires the exact original account and manifest, without granting an allowance', () => {
    const binding = executionBinding(execution);
    expect(() => assertExecutionBinding(binding, execution)).not.toThrow();
    expect(() => assertExecutionBinding(undefined, undefined)).not.toThrow();
    expect(() => assertExecutionBinding(undefined, execution)).not.toThrow();
    expect(() => assertExecutionBinding(undefined, execution, true)).toThrow('original parent ledger');
    expect(() => assertExecutionBinding(binding, undefined)).toThrow('original parent ledger');
    expect(() => assertExecutionBinding(binding, { ...execution, agentId: 'b' })).toThrow('original parent ledger');
    expect(() => assertExecutionBinding(binding, { ...execution, manifestHash: 'f'.repeat(64) })).toThrow('original parent ledger');
    expect(() => executionBinding({ ...execution, agentId: '../root' })).toThrow('Invalid session execution binding');
  });

  it.each([null, [], {}, { version: 2 }, { version: 1, manifestHash: 'a'.repeat(64), agentId: '../a' },
    { version: 1, manifestHash: 'a'.repeat(64), agentId: 'a', allowance: 100000 },
    { version: 1, manifestHash: 'invalid', agentId: 'a' }])('rejects malformed persisted restrictions: %j', value => {
    expect(validSessionExecutionBinding(value)).toBe(false);
    expect(() => createSession(project, { executionBinding: value as never })).toThrow('invalid session execution binding');
  });

  it('preserves a cloned restriction through a save and safety branch, without new ledger events', async () => {
    const binding = executionBinding(execution);
    const session = createSession(project, { activate: false, executionBinding: binding });
    binding.agentId = 'b';
    expect(getSessionById(session.id)?.executionBinding).toEqual(executionBinding(execution));
    const history = readFileSync(join(execution.ledger.root, 'history.json'), 'utf8');
    saveSessionConversation(session.id, [{ role: 'user', content: 'continue' }], { expectedRevision: null, status: 'completed' });
    expect(getSessionById(session.id)?.executionBinding).toEqual(executionBinding(execution));
    const branched = await branchSession(session.id, { kind: 'safety' });
    expect(branched.session.executionBinding).toEqual(executionBinding(execution));
    expect(getSessionById(branched.session.id)?.executionBinding).toEqual(executionBinding(execution));
    expect(readFileSync(join(execution.ledger.root, 'history.json'), 'utf8')).toBe(history);
    expect(() => assertExecutionBinding(branched.session.executionBinding, undefined)).toThrow('original parent ledger');
  });

  it('denies inference through another client when it omits the retained execution context', async () => {
    const session = createSession(project, { activate: false, executionBinding: executionBinding(execution) });
    await expect(runTurn({ sessionId: session.id, cwd: project } as never)).rejects.toThrow('original parent ledger');
  });

  it('rejects invalid stored metadata instead of loading its conversation', () => {
    const session = createSession(project, { activate: false, executionBinding: executionBinding(execution) });
    const file = join(getSessionDirById(session.id)!, 'session.json');
    writeFileSync(file, JSON.stringify({ ...session, executionBinding: { version: 1 } }));
    expect(getSessionById(session.id)).toBeNull();
  });
});

describe('delegation argument parser', () => {
  const complete = ['--ledger-url', 'http://localhost:1234', '--ledger-token-file', '/private/child.token', '--ledger-agent', 'child'];
  it('accepts only a complete tuple and leaves ordinary invocations undelegated', () => {
    expect(parseDelegatedExecutionOptions(complete)).toEqual({ url: 'http://localhost:1234', tokenFile: '/private/child.token', agentId: 'child' });
    expect(parseDelegatedExecutionOptions(['acp'])).toBeUndefined();
  });
  it.each([
    ['--ledger-url'], ['--ledger-url', ''], ['--ledger-url', '--ledger-agent'], ['--ledger-agent', 'child'],
    [...complete, '--ledger-agent', 'other'], ['--ledger-url=x', '--ledger-token-file=y', '--ledger-agent=z'],
    [...complete, '--ledger-token-files', '/other'],
  ].map(args => ({ args })))('fails closed on malformed tuples: $args', ({ args }) => {
    expect(() => parseDelegatedExecutionOptions(args)).toThrow();
  });
});
