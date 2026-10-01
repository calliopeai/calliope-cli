// Fixture shared with calliope-vscode at effe71908719e76ed6ddd7389b56ceb28e1f80a7.
/** Real AHP server handler/transport on loopback; no model process or cloud access. */
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = realpathSync(resolve(process.env.AHP_SOURCE || 'vscode'));
const require = createRequire(join(source, 'package.json'));
const ts = require('typescript');
export const WebSocket = require('ws');
const sourceUrl = pathToFileURL(join(source, 'src/')).href;
globalThis._VSCODE_FILE_ROOT = sourceUrl;
globalThis._VSCODE_PRODUCT_JSON = require('./product.json');
globalThis._VSCODE_PACKAGE_JSON = require('./package.json');
registerHooks({
 resolve(specifier, context, next) {
  // Preserve an isolated source view's URL when src is a read-only symlink.
  if (specifier.startsWith(sourceUrl) && specifier.endsWith('.ts')) return { url: specifier, shortCircuit: true };
  if (context.parentURL?.startsWith(sourceUrl) && specifier.startsWith('.') && specifier.endsWith('.js')) {
   const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href;
   if (existsSync(fileURLToPath(url))) return { url, shortCircuit: true };
  }
  return next(specifier, context);
 },
 load(url, context, next) {
  if (url.startsWith(sourceUrl) && url.endsWith('.ts')) return {
   format: 'module', shortCircuit: true,
   source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true, useDefineForClassFields: false,
   } }).outputText,
  };
  return next(url, context);
 },
});
export const loadSource = file => import(new URL(file, sourceUrl));
const load = loadSource;
const { Emitter, Event } = await load('vs/base/common/event.ts');
const { DisposableStore } = await load('vs/base/common/lifecycle.ts');
const { NullLogService } = await load('vs/platform/log/common/log.ts');
const { NullTelemetryService } = await load('vs/platform/telemetry/common/telemetryUtils.ts');
const { AgentHostStateManager } = await load('vs/platform/agentHost/node/agentHostStateManager.ts');
const { ProtocolServerHandler } = await load('vs/platform/agentHost/node/protocolServerHandler.ts');
const { WebSocketProtocolTransport } = await load('vs/platform/agentHost/node/webSocketTransport.ts');
const { AgentHostFileSystemProvider } = await load('vs/platform/agentHost/common/agentHostFileSystemProvider.ts');
const { AgentHostManagedSettingsService } = await load('vs/platform/agentHost/node/agentHostManagedSettingsService.ts');
const { AgentHostClientConnectionService } = await load('vs/platform/agentHost/node/agentHostClientConnectionService.ts');
export const { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = await load('vs/platform/agentHost/common/state/protocol/version/registry.ts');
export const { negotiateProtocolVersion } = await load('vs/platform/agentHost/common/state/protocol/version/negotiation.ts');
export const ROOT = 'ahp-root://';
const { URI } = await load('vs/base/common/uri.ts');
const { buildDefaultChatUri } = await load('vs/platform/agentHost/common/state/sessionState.ts');


/** Production transport/handler/reducers; deterministic provider, no model or cloud. */
export async function createProtocolFixture({ seeded = false } = {}) {
 const store = new DisposableStore();
 const log = new NullLogService();
 const state = store.add(new AgentHostStateManager(log));
 const connections = store.add(new Emitter());
 const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
 const session = URI.parse('copilot:///protocol-fixture').toString();
 const chat = buildDefaultChatUri(session);
 const receivedActions = [];
 const timestamp = '2026-01-01T00:00:00.000Z';
 if (seeded) {
  state.createSession({ resource: session, provider: 'copilot', title: 'Protocol fixture', status: 1, createdAt: timestamp, modifiedAt: timestamp });
  state.dispatchServerAction(session, { type: 'session/ready' });
 }
 const agent = {
  onMcpNotification: Event.None,
  addSubscriber() {}, unsubscribe() {},
  subscribe: async uri => state.getSnapshot(uri.toString()),
  listSessions: async () => seeded ? [{ session: URI.parse(session), summary: 'Protocol fixture', startTime: Date.parse(timestamp), modifiedTime: Date.parse(timestamp) }] : [],
  dispatchAction(channel, action, clientId, clientSeq) {
   receivedActions.push({ channel, action, clientId, clientSeq });
   state.dispatchClientAction(channel, action, { clientId, clientSeq });
  },
 };
 store.add(new ProtocolServerHandler(agent, state, { onConnection: connections.event },
  { allowExtensionMethods: false }, store.add(new AgentHostFileSystemProvider()), log,
  NullTelemetryService, store.add(new AgentHostManagedSettingsService()),
  store.add(new AgentHostClientConnectionService())));
 server.on('connection', socket => connections.fire(store.add(new WebSocketProtocolTransport(socket, WebSocket))));
 await once(server, 'listening');
 return {
  url: `ws://127.0.0.1:${server.address().port}/`,
  protocolVersion: PROTOCOL_VERSION, session, chat, receivedActions,
  snapshot: () => state.getSnapshot(chat),
  dispatch: action => state.dispatchServerAction(chat, action),
  start(turnId) {
   state.dispatchServerAction(chat, { type: 'chat/turnStarted', turnId, startedAt: timestamp, message: { text: 'Fixture turn', origin: { kind: 'user' } } });
  },
  requestApproval(turnId, toolCallId) {
   state.dispatchServerAction(chat, { type: 'chat/toolCallStart', turnId, toolCallId, toolName: 'fixture', displayName: 'Fixture tool' });
   state.dispatchServerAction(chat, { type: 'chat/toolCallReady', turnId, toolCallId, invocationMessage: 'Fixture tool', toolInput: '{}' });
  },
  finish(turnId, outcome) {
   const error = { message: 'Fixture error' };
   const action = outcome === 'error'
    ? { type: 'chat/error', turnId, duration: 1, ...(PROTOCOL_VERSION === '1.0.0' ? { error } : { part: { kind: 'error', error } }) }
    : { type: outcome === 'cancel' ? 'chat/turnCancelled' : 'chat/turnComplete', turnId, duration: 1 };
   state.dispatchServerAction(chat, action);
  },
  disconnect() { for (const socket of server.clients) socket.terminate(); },
  async close() {
   store.dispose();
   for (const socket of server.clients) socket.terminate();
   await new Promise(resolve => server.close(resolve));
  },
 };
}
