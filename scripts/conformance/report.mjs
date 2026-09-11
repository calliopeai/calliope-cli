#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BACKENDS } from './contract.mjs';
import { createReadiness, credentialStatus } from './readiness.mjs';
import * as config from '../../dist/config.js';
import { hasAWSCredentials } from '../../dist/providers/bedrock.js';

const { values } = parseArgs({ options: {
  json: { type: 'boolean' }, output: { type: 'string' }, 'require-ready': { type: 'boolean' },
} });
const directory = new URL('../../tests/fixtures/provider-wire/', import.meta.url);
const captures = readdirSync(directory).filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(readFileSync(new URL(file, directory), 'utf8')));
const availability = Object.fromEntries(BACKENDS.map(backend => [backend.id, credentialStatus(backend, { ...config, hasAWSCredentials })]));
const report = createReadiness(captures, availability);
const json = JSON.stringify(report, null, 2) + '\n';
if (values.output) writeFileSync(values.output, json, { flag: 'wx', mode: 0o600 });
if (values.json) process.stdout.write(json);
else {
  console.log(`Wire evidence: ${report.capturedWireCombinations}/${report.requiredWireCombinations}; product gate: ${report.productGateReady ? 'ready' : 'blocked'}`);
  for (const adapter of report.adapters) console.log(`${adapter.id}: ${adapter.credentials}; ${Object.entries(adapter.checks).filter(([, status]) => status !== 'captured').map(([check, status]) => `${check}=${status}`).join(', ') || 'captured'}`);
}
if (values['require-ready'] && !report.productGateReady) process.exitCode = 1;
