/** Real source-pinned host handler/transport/reducers; no models or cloud. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AhpConnection, SUPPORTED_VERSIONS, follow, runAttach } from '../../dist/attach.js';

if (!process.env.AHP_SOURCE) {
  throw new Error('Set AHP_SOURCE to the prepared pinned VS Code source; Node24 is required.');
}
const { createProtocolFixture, PROTOCOL_VERSION } = await import(pathToFileURL(resolve(process.env.AHP_FIXTURE_MODULE || 'scripts/qualification/ahp-fixture.mjs')).href);
if (process.env.AHP_EXPECTED_VERSION) assert.equal(PROTOCOL_VERSION, process.env.AHP_EXPECTED_VERSION);
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'protocol observation timed out'); await delay(10); }
}
async function connect(host) {
  const socket = new WebSocket(host.url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  const conn = new AhpConnection(socket);
  const answer = await conn.call('initialize', { channel: 'ahp-root://', protocolVersions: SUPPORTED_VERSIONS,
    clientId: 'calliope-cli-wire-proof', initialSubscriptions: ['ahp-root://'] }, { timeoutMs: 3000 });
  assert.equal(answer.error, undefined); assert.equal(answer.result.protocolVersion, PROTOCOL_VERSION);
  return conn;
}

test(`CLI actual ${PROTOCOL_VERSION} list/follow/approve/deny/error/cancel/loss and retained history`, { timeout: 15000 }, async t => {
  const host = await createProtocolFixture({ seeded: true });
  t.after(() => host.close());
  const conn = await connect(host); t.after(() => conn.close());
  const sessions = await conn.call('listSessions', { channel: 'ahp-root://' });
  assert.equal(sessions.result.items[0].resource, host.session);
  const session = conn.call('subscribe', { channel: host.session });
  const chat = session.then(() => conn.call('subscribe', { channel: host.chat }));
  let approved = true;
  const output = [];
  const { done } = follow(conn, host.session, { write: text => output.push(text), approve: async () => approved },
    chat.then(reply => reply.result.snapshot), session.then(reply => reply.result.snapshot));
  await chat;
  for (const allow of [true, false]) {
    approved = allow;
    const turn = allow ? 'allow' : 'deny';
    host.start(turn); host.requestApproval(turn, 'tool');
    await until(() => host.receivedActions.some(entry => entry.action.type === 'chat/toolCallConfirmed' && entry.action.turnId === turn));
    assert.equal(host.receivedActions.find(entry => entry.action.turnId === turn && entry.action.type === 'chat/toolCallConfirmed').action.approved, allow);
    assert.equal(host.snapshot().state.activeTurn.responseParts[0].toolCall.status, allow ? 'running' : 'cancelled');
    host.finish(turn, 'complete');
    await until(() => output.join('').match(/\[turn complete\]/g)?.length === (allow ? 1 : 2));
  }
  host.start('error'); host.finish('error', 'error');
  await until(() => output.join('').includes('Fixture error'));
  host.start('cancel'); host.finish('cancel', 'cancel');
  await until(() => output.join('').includes('[turn cancelled]'));
  host.start('live-on-host');
  await until(() => output.filter(text => text.startsWith('\n›')).length === 5);
  host.disconnect();
  assert.match(await done, /connection closed|host transport failed/);
  const reattached = await connect(host); t.after(() => reattached.close());
  const retained = await reattached.call('subscribe', { channel: host.chat });
  assert.deepEqual(retained.result.snapshot.state.turns.map(turn => turn.id), ['allow', 'deny', 'error', 'cancel']);
  assert.equal(retained.result.snapshot.state.activeTurn.id, 'live-on-host', 'detach leaves the active run on its host');
  assert.equal(host.receivedActions.some(entry => entry.action.type === 'chat/turnCancelled'), false,
    'client detach does not cancel the host run');
});

test(`runAttach lists actual ${PROTOCOL_VERSION} sessions over native HTTP/WebSocket`, { timeout: 10000 }, async t => {
  const host = await createProtocolFixture({ seeded: true });
  t.after(() => host.close());
  assert.equal(await runAttach(['--url', host.url], {}, { timeoutMs: 3000 }), 0);
});
