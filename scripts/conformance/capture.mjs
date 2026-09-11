#!/usr/bin/env node
/** Opt-in toy probe capture. Never executes tools, reads a project or stores keys. */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BACKENDS, TOOL, invoke, probeMessages, normalize } from './contract.mjs';
import { validateCapture } from './captures.mjs';
import { createRecorder } from './recorder.mjs';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' },
  scenario: { type: 'string', default: 'text' }, stream: { type: 'boolean', default: false },
  output: { type: 'string' }, 'max-output-tokens': { type: 'string', default: '64' }, help: { type: 'boolean' },
} });
if (values.help || !values.live) {
  console.log('Usage: npm run capture:provider -- --live --provider <adapter-id> --model <model> --scenario text|tool [--stream] --output <capture.json>');
  console.log('Requires explicit authorization for live API use. Uses configured credentials, one HTTP request, at most 64 output tokens by default, 30s timeout. No files or tools execute.');
  console.log(`Adapters: ${BACKENDS.map(backend => backend.id).join(', ')}`);
  process.exit(values.help ? 0 : 2);
}
const backend = BACKENDS.find(backend => backend.id === values.provider);
const maxOutput = Number(values['max-output-tokens']);
if (!backend || !values.model || !values.output || !['text', 'tool'].includes(values.scenario) || !Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > 512) throw new Error('Supply a valid adapter, model, output path, scenario and token limit (1–512)');
const adapters = Object.fromEntries(await Promise.all(['anthropic', 'google', 'openai', 'compat', 'ollama', 'bedrock'].map(async name => [name, await import(`../../dist/providers/${name}.js`)])));
if (backend.provider === 'openai' && adapters.openai.requiresResponsesAPI(values.model) !== (backend.protocol === 'responses')) throw new Error('Model routing does not match the requested OpenAI API path');
const originalFetch = globalThis.fetch;
const signal = AbortSignal.timeout(30000);
const recorder = createRecorder(originalFetch, backend, maxOutput, signal);
globalThis.fetch = recorder.fetch;
try {
  const result = await invoke(adapters, backend, values.model, probeMessages(values.scenario), values.scenario === 'tool' ? [TOOL] : [], values.stream ? () => {} : undefined, signal, { maxOutputTokens: maxOutput });
  const sdkVersions = Object.fromEntries(['openai', '@anthropic-ai/sdk', '@google/genai'].map(name => [name, JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version]));
  const capture = validateCapture({ version: 1, backend: backend.id, model: values.model, scenario: values.scenario, stream: values.stream,
    provenance: { kind: 'captured', capturedAt: new Date().toISOString(), sourceOrigin: recorder.sourceOrigin(), sdkVersions }, exchanges: recorder.exchanges, expected: normalize(result) });
  const output = resolve(values.output); mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(capture, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Captured ${backend.id} to ${output}. Review decoded response bytes and expected semantics before adding it to CI; tool calls were not executed.`);
} finally { globalThis.fetch = originalFetch; }
