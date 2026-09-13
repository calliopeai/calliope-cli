#!/usr/bin/env node
/** Opt-in toy probe capture. Never executes tools, reads a project or stores keys. */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BACKENDS, TOOL, invoke, probeMessages, normalize } from './contract.mjs';
import { validateCapture } from './captures.mjs';
import { createRecorder } from './recorder.mjs';
import { reserveProbe } from './budget.mjs';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' },
  scenario: { type: 'string', default: 'text' }, stream: { type: 'boolean', default: false },
  output: { type: 'string' }, 'max-output-tokens': { type: 'string', default: '64' }, help: { type: 'boolean' },
  ledger: { type: 'string' }, 'max-cost-usd': { type: 'string' },
  'run-id': { type: 'string' }, 'max-run-cost-usd': { type: 'string' },
  'input-usd-per-million': { type: 'string' }, 'output-usd-per-million': { type: 'string' },
} });
if (values.help || !values.live) {
  console.log('Usage: npm run capture:provider -- --live --provider <adapter-id> --model <model> --scenario text|tool [--stream] --output <capture.json>');
  console.log('Requires --ledger <path> --max-cost-usd <total> --input-usd-per-million <rate> --output-usd-per-million <rate>. Supply verified rates for the chosen model (zero only for local/unbilled inference).');
  console.log('Use --run-id <stable-id> --max-run-cost-usd <limit> to enforce a persistent per-run ceiling within the total. Reuse the ID on restart.');
  console.log('Uses configured credentials, one HTTP request, at most 64 output tokens by default, 30s timeout. Fixed public toy prompts only; no tools execute. Failed requests retain their reservation.');
  console.log(`Adapters: ${BACKENDS.map(backend => backend.id).join(', ')}`);
  process.exit(values.help ? 0 : 2);
}
const backend = BACKENDS.find(backend => backend.id === values.provider);
const maxOutput = Number(values['max-output-tokens']);
if (!backend || !values.model || !values.output || !['text', 'tool'].includes(values.scenario) || !Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > 512) throw new Error('Supply a valid adapter, model, output path, scenario and token limit (1–512)');
if (!values.ledger || ['max-cost-usd', 'input-usd-per-million', 'output-usd-per-million'].some(key => !values[key]?.trim())) throw new Error('A persistent ledger, dollar limit and verified model rates are required for live probes');
if (resolve(values.ledger) === resolve(values.output)) throw new Error('The budget ledger and capture must be separate files');
if (existsSync(resolve(values.output))) throw new Error('Capture already exists; refusing to spend or overwrite it');
const adapters = Object.fromEntries(await Promise.all(['anthropic', 'google', 'openai', 'compat', 'ollama', 'bedrock'].map(async name => [name, await import(`../../dist/providers/${name}.js`)])));
if (backend.provider === 'openai' && adapters.openai.requiresResponsesAPI(values.model) !== (backend.protocol === 'responses')) throw new Error('Model routing does not match the requested OpenAI API path');
const originalFetch = globalThis.fetch;
const signal = AbortSignal.timeout(30000);
const priceCeiling = backend.id === 'openrouter' ? { input: Number(values['input-usd-per-million']), output: Number(values['output-usd-per-million']) } : undefined;
const recorder = createRecorder(originalFetch, backend, maxOutput, signal, { maxPrice: priceCeiling });
const reservation = reserveProbe(resolve(values.ledger), { maxCostUsd: Number(values['max-cost-usd']),
  inputRate: Number(values['input-usd-per-million']), outputRate: Number(values['output-usd-per-million']), maxOutputTokens: maxOutput,
  runId: values['run-id'], maxRunCostUsd: values['max-run-cost-usd'] === undefined ? undefined : Number(values['max-run-cost-usd']) });
let outcome = 'failed';
globalThis.fetch = recorder.fetch;
try {
  const result = await invoke(adapters, backend, values.model, probeMessages(values.scenario), values.scenario === 'tool' ? [TOOL] : [], values.stream ? () => {} : undefined, signal, { maxOutputTokens: maxOutput, priceCeiling });
  const sdkVersions = Object.fromEntries(['openai', '@anthropic-ai/sdk', '@google/genai'].map(name => [name, JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version]));
  const capture = validateCapture({ version: 1, backend: backend.id, model: values.model, scenario: values.scenario, stream: values.stream,
    provenance: { kind: 'captured', capturedAt: new Date().toISOString(), sourceOrigin: recorder.sourceOrigin(), sdkVersions,
      budgetReservationId: reservation.id }, exchanges: recorder.exchanges, expected: normalize(result) });
  const output = resolve(values.output); mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(capture, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  outcome = 'captured';
  try {
    const { HealthStore, providerTarget, healthDigest } = await import('../../dist/health/index.js');
    const target = providerTarget(backend.provider);
    // A native Bedrock probe may coexist with a configured gateway. Avoid
    // attributing evidence to an endpoint different from the adapter invoked.
    if ((backend.id === 'bedrock-native') === (target.protocol === 'bedrock-converse') || backend.provider !== 'bedrock') {
      new HealthStore().append({ provider: target.provider, target: target.key, type: 'conformance', outcome: 'success', evidenceHash: healthDigest(capture),
        capabilities: { ...(values.scenario === 'tool' ? { tools: true } : {}), ...(values.stream ? { streaming: true } : {}), usage: !!capture.expected.usage } });
    }
  } catch { console.error('Capture saved; provider health history could not be updated.'); }
  console.log(`Captured ${backend.id} to ${output}. Review decoded response bytes and expected semantics before adding it to CI; tool calls were not executed.`);
} catch (error) {
  outcome = signal.aborted ? 'cancelled' : 'failed';
  const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
  // SDK exceptions can contain upstream response bodies or request headers.
  console.error(`Probe ${outcome}${status}; no capture saved. The budget reservation is retained.`);
  process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; reservation.finish(outcome); }
