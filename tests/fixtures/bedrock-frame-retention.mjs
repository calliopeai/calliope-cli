/** Isolated watchdog target: real source/ledger, synthetic binary HTTP only. */
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { crc32 } from 'node:zlib';
import { readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        for (const extension of ['.ts', '.tsx']) {
          const candidate = new URL(specifier.slice(0, -3) + extension, context.parentURL);
          if (existsSync(candidate)) return next(candidate.href, context);
        }
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith('file:') && /\.tsx?$/.test(url) && !url.includes('/node_modules/')) {
      return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }) };
    }
    return next(url, context);
  },
});

const { chat } = await import('../../src/providers/index.js');
const config = await import('../../src/config.js');
const { providerTarget } = await import('../../src/health/index.js');
const { ExecutionGuard, ReservationLedger, manifestHash } = await import('../../src/execution/index.js');
const { executionManifest } = await import('../helpers/execution-manifest.js');
const { syntheticWire } = await import('../helpers/provider-wire.js');
const root = realpathSync(process.argv[2]), scenario = process.argv[3], project = join(root, 'project');
mkdirSync(project); config.resetConfig(); config.setProviderCred('bedrock', { region: 'us-east-1' });
const manifest = executionManifest(project), ledger = new ReservationLedger(join(root, 'ledger'));
manifest.tokenBudget = 100000; manifest.costBudgetNanos = 100000000;
for (const account of manifest.accounts) {
  account.tokenBudget = account.parentId === null ? 100000 : 50000;
  account.costBudgetNanos = account.parentId === null ? 100000000 : 50000000;
}
ledger.create(manifest);
const messages = [{ role: 'user', content: 'Public malformed-frame fixture.' }];
const route = { provider: 'bedrock', model: 'fixture-model', target: providerTarget('bedrock').key, evidence: 'live', discoveredAt: new Date().toISOString(),
  capabilities: { chat: true, tools: true, streaming: true }, contextLength: 8192, maxOutputTokens: 100, price: { input: 2, output: 5 },
  estimatedCost: null, latencyMs: null, errorRate: null, score: 0, reason: 'synthetic' };
const guard = new ExecutionGuard({ ledger, manifestHash: manifestHash(manifest), agentId: 'a', maxOutputTokens: 100, measuredInputReservation: true }, project);
const trailer = Buffer.alloc(scenario === 'short-header' ? 17 : 12);
if (scenario === 'bad-length') trailer.writeUInt32BE(15, 0);
if (scenario === 'bad-headers') { trailer.writeUInt32BE(16, 0); trailer.writeUInt32BE(1, 4); }
if (scenario === 'short-header') { trailer.writeUInt32BE(17, 0); trailer.writeUInt32BE(1, 4); trailer[12] = 255; }
if (scenario !== 'zero') trailer.writeUInt32BE(crc32(trailer.subarray(0, 8)), 8);
if (scenario === 'short-header') trailer.writeUInt32BE(crc32(trailer.subarray(0, -4)), trailer.length - 4);
let calls = 0, checkpoints = 0, error;
globalThis.fetch = async input => {
  if (new URL(typeof input === 'string' ? input : input.url ?? input.toString()).hostname !== 'bedrock-runtime.us-east-1.amazonaws.com') throw Error('Unexpected fixture endpoint');
  calls++; const wire = syntheticWire('bedrock', 'text', true);
  return new Response(Buffer.concat([wire.body, trailer]), { headers: { 'content-type': wire.type } });
};
try {
  await chat('bedrock', messages, [], route.model, () => {}, undefined, {
    maxOutputTokens: 100, attemptBudget: guard.budget(route, messages, [], true), maxProviderRetries: 2,
    onStreamReset: () => {}, onResponseReceived: async () => { checkpoints++; },
  });
} catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
const saved = ledger.read(project);
process.stdout.write(JSON.stringify({ error, calls, checkpoints, states: Object.values(saved.projection.requests).map(entry => entry.state),
  settlements: saved.events.filter(event => event.change.type === 'settle').length, spent: saved.projection.spent }) + '\n');
