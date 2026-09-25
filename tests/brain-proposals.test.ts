import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainError } from '../src/brain/types.js';
import {
  maintenanceReport,
  refuseForwardedIdentity,
  runBrainProposalsCommand,
  summaryPlan,
} from '../src/brain-proposals.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRoot(scriptName: string, content: string): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'brain-proposals-'));
  dirs.push(root);
  fs.mkdirSync(join(root, 'scripts'));
  fs.writeFileSync(join(root, 'scripts', scriptName), content);
  return root;
}

function writeJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  fs.writeFileSync(path, JSON.stringify(value));
  return path;
}

const ECHO_MAINTENANCE = `
const fs = require('fs');
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
const body = JSON.stringify({
  format: 'maintenance-proposals/v1', generator: 'semantic-maintenance/1.0',
  receivedRoot: get('--root'), receivedHostConfig: get('--host-config'),
  receivedActor: get('--actor'), receivedRequest: get('--request'),
  receivedMaxFindings: get('--max-findings'), proposals: [],
});
const output = get('--output');
if (output) fs.writeFileSync(output, body); else process.stdout.write(body);
`;

const ECHO_SUMMARY = `
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv.includes('--propose')) { process.stderr.write('--propose must never be sent'); process.exit(1); }
const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
const body = JSON.stringify({ format: 'synthesis-update-preview/v1', receivedInput: get('--input'), changedSections: [] });
const output = get('--output');
if (output) fs.writeFileSync(output, body); else process.stdout.write(body);
`;

const FAIL_SCRIPT = "process.stderr.write('synthetic failure detail'); process.exit(1);";
const NOT_JSON_SCRIPT = "process.stdout.write('not-json-output');";
const SLOW_SCRIPT = 'setTimeout(() => {}, 5000);';

// ============================================================================
// refuseForwardedIdentity — cheap, no fixture
// ============================================================================

it.each(['actor', 'grants', 'grant', 'principal', 'reviewer', 'reviewedBy', 'review'])(
  'refuses a payload carrying a model-selected %s field',
  (key) => {
    expect(() => refuseForwardedIdentity({ [key]: 'model-chosen' }, 'test payload')).toThrow(BrainError);
    try {
      refuseForwardedIdentity({ [key]: 'model-chosen' }, 'test payload');
    } catch (error) {
      expect((error as BrainError).code).toBe('policy-denied');
      expect((error as BrainError).message).toContain(key);
    }
  },
);

it('does not refuse a clean object, array, primitive or undefined payload', () => {
  expect(() => refuseForwardedIdentity({ record: 'doc:summary' }, 'x')).not.toThrow();
  expect(() => refuseForwardedIdentity(['actor'], 'x')).not.toThrow();
  expect(() => refuseForwardedIdentity('actor', 'x')).not.toThrow();
  expect(() => refuseForwardedIdentity(undefined, 'x')).not.toThrow();
  expect(() => refuseForwardedIdentity(null, 'x')).not.toThrow();
});

// ============================================================================
// maintenanceReport
// ============================================================================

it('refuses a forwarded actor in the maintenance request before any host lookup runs', async () => {
  // No scripts/inspect-maintenance.py at all: if the refusal did not run
  // first, this would fail with 'unavailable', not 'policy-denied'.
  const root = fs.mkdtempSync(join(tmpdir(), 'brain-proposals-'));
  dirs.push(root);
  const requestPath = writeJson(root, 'request.json', { actor: 'model-selected', query: 'x' });
  await expect(
    maintenanceReport({ root, hostConfig: 'host.json', actor: 'human-operator', requestPath, interpreter: 'node' }),
  ).rejects.toMatchObject({ code: 'policy-denied' });
});

it('builds a maintenance-proposals/v1 report from a real subprocess, forwarding only host-supplied identity', async () => {
  const root = makeRoot('inspect-maintenance.py', ECHO_MAINTENANCE);
  const requestPath = writeJson(root, 'request.json', { query: 'conflicts' });
  const result = await maintenanceReport({
    root,
    hostConfig: '_internal/context-host.json',
    actor: 'operator@example.test',
    requestPath,
    maxFindings: 50,
    interpreter: 'node',
  });
  expect(result.report).toMatchObject({
    format: 'maintenance-proposals/v1',
    receivedRoot: root,
    receivedHostConfig: '_internal/context-host.json',
    receivedActor: 'operator@example.test',
    receivedRequest: requestPath,
    receivedMaxFindings: '50',
  });
});

it('writes a maintenance report to --output instead of returning it inline, matching the upstream contract', async () => {
  const root = makeRoot('inspect-maintenance.py', ECHO_MAINTENANCE);
  const requestPath = writeJson(root, 'request.json', {});
  const outputPath = join(root, 'report.json');
  const result = await maintenanceReport({
    root,
    hostConfig: 'host.json',
    actor: 'operator@example.test',
    requestPath,
    outputPath,
    interpreter: 'node',
  });
  expect(result).toEqual({ report: null, outputPath });
  expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toMatchObject({ receivedRequest: requestPath });
});

it('rejects with unavailable when --root has no vendored inspect-maintenance.py', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'brain-proposals-'));
  dirs.push(root);
  const requestPath = writeJson(root, 'request.json', {});
  await expect(
    maintenanceReport({ root, hostConfig: 'host.json', actor: 'a', requestPath, interpreter: 'node' }),
  ).rejects.toMatchObject({ code: 'unavailable' });
});

it('rejects with unavailable when the configured interpreter does not exist', async () => {
  const root = makeRoot('inspect-maintenance.py', ECHO_MAINTENANCE);
  const requestPath = writeJson(root, 'request.json', {});
  await expect(
    maintenanceReport({ root, hostConfig: 'host.json', actor: 'a', requestPath, interpreter: 'calliope-test-no-such-interpreter' }),
  ).rejects.toMatchObject({ code: 'unavailable' });
});

it('relays a non-zero exit as unavailable with the script stderr', async () => {
  const root = makeRoot('inspect-maintenance.py', FAIL_SCRIPT);
  const requestPath = writeJson(root, 'request.json', {});
  await expect(
    maintenanceReport({ root, hostConfig: 'host.json', actor: 'a', requestPath, interpreter: 'node' }),
  ).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('synthetic failure detail') });
});

it('rejects malformed stdout instead of returning invalid JSON as a report', async () => {
  const root = makeRoot('inspect-maintenance.py', NOT_JSON_SCRIPT);
  const requestPath = writeJson(root, 'request.json', {});
  await expect(
    maintenanceReport({ root, hostConfig: 'host.json', actor: 'a', requestPath, interpreter: 'node' }),
  ).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('valid JSON') });
});

it('rejects a missing or malformed request file as invalid, before any subprocess runs', async () => {
  const root = makeRoot('inspect-maintenance.py', FAIL_SCRIPT);
  await expect(
    maintenanceReport({ root, hostConfig: 'host.json', actor: 'a', requestPath: join(root, 'missing.json'), interpreter: 'node' }),
  ).rejects.toMatchObject({ code: 'invalid' });
  const malformed = join(root, 'malformed.json');
  fs.writeFileSync(malformed, '{not json');
  await expect(
    maintenanceReport({ root, hostConfig: 'host.json', actor: 'a', requestPath: malformed, interpreter: 'node' }),
  ).rejects.toMatchObject({ code: 'invalid' });
});

it('cancels a pending maintenance-report subprocess', async () => {
  const root = makeRoot('inspect-maintenance.py', SLOW_SCRIPT);
  const requestPath = writeJson(root, 'request.json', {});
  const controller = new AbortController();
  const pending = maintenanceReport({ root, hostConfig: 'host.json', actor: 'a', requestPath, interpreter: 'node', signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow(/cancel/i);
});

// ============================================================================
// summaryPlan
// ============================================================================

it('refuses a forwarded reviewer on the candidate before any host lookup runs', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'brain-proposals-'));
  dirs.push(root);
  const inputPath = writeJson(root, 'input.json', {
    record: 'doc:summary',
    expectedRevision: 'abc',
    requestId: 'r1',
    reason: 'test',
    candidate: { format: 'synthesis-update/v1', reviewer: 'model-selected' },
  });
  await expect(summaryPlan({ root, hostConfig: 'host.json', inputPath, interpreter: 'node' })).rejects.toMatchObject({
    code: 'policy-denied',
  });
});

it('previews a maintained-summary amendment through a real subprocess and never sends --propose', async () => {
  const root = makeRoot('maintain-summary.py', ECHO_SUMMARY);
  const inputPath = writeJson(root, 'input.json', { record: 'doc:summary', expectedRevision: 'abc', requestId: 'r1', reason: 'test', candidate: {} });
  const result = await summaryPlan({ root, hostConfig: '_internal/context-host.json', inputPath, interpreter: 'node' });
  expect(result.preview).toMatchObject({ format: 'synthesis-update-preview/v1', receivedInput: inputPath });
});

it('writes a summary plan preview to --output instead of returning it inline', async () => {
  const root = makeRoot('maintain-summary.py', ECHO_SUMMARY);
  const inputPath = writeJson(root, 'input.json', {});
  const outputPath = join(root, 'preview.json');
  const result = await summaryPlan({ root, hostConfig: 'host.json', inputPath, outputPath, interpreter: 'node' });
  expect(result).toEqual({ preview: null, outputPath });
  expect(fs.existsSync(outputPath)).toBe(true);
});

// ============================================================================
// runBrainProposalsCommand — CLI layer
// ============================================================================

it.each([
  [[], 'unknown action'],
  [['not-a-real-action'], 'unknown action'],
  [['maintenance-report'], 'missing --root/--host-config'],
  [['maintenance-report', '--root', 'r', '--host-config', 'h'], 'missing --actor/--request'],
  [['summary-plan', '--root', 'r'], 'missing --host-config/--input'],
])('rejects malformed CLI arguments %j (%s) with exit 2', async (args) => {
  const lines: string[] = [];
  const code = await runBrainProposalsCommand(args, { write: (l) => lines.push(l) });
  expect(code).toBe(2);
  expect(JSON.parse(lines[0]!)).toMatchObject({ version: 1, type: 'brain-proposals', error: { code: 'invalid' } });
});

it('rejects a non-integer or non-positive --max-findings as invalid', async () => {
  const root = makeRoot('inspect-maintenance.py', ECHO_MAINTENANCE);
  const requestPath = writeJson(root, 'request.json', {});
  const lines: string[] = [];
  const code = await runBrainProposalsCommand(
    ['maintenance-report', '--root', root, '--host-config', 'h', '--actor', 'a', '--request', requestPath, '--max-findings', '0'],
    { write: (l) => lines.push(l), interpreter: 'node' },
  );
  expect(code).toBe(2);
  expect(JSON.parse(lines[0]!)).toMatchObject({ error: { code: 'invalid' } });
});

it('exits 3 and reports policy-denied for a request carrying a forwarded grant', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'brain-proposals-'));
  dirs.push(root);
  const requestPath = writeJson(root, 'request.json', { grants: ['admin'] });
  const lines: string[] = [];
  const code = await runBrainProposalsCommand(
    ['maintenance-report', '--root', root, '--host-config', 'h', '--actor', 'a', '--request', requestPath],
    { write: (l) => lines.push(l), interpreter: 'node' },
  );
  expect(code).toBe(3);
  expect(JSON.parse(lines[0]!)).toMatchObject({ error: { code: 'policy-denied' } });
});

it('emits the standard headless envelope on success', async () => {
  const root = makeRoot('inspect-maintenance.py', ECHO_MAINTENANCE);
  const requestPath = writeJson(root, 'request.json', {});
  const lines: string[] = [];
  const code = await runBrainProposalsCommand(
    ['maintenance-report', '--root', root, '--host-config', 'h', '--actor', 'a', '--request', requestPath],
    { write: (l) => lines.push(l), interpreter: 'node' },
  );
  expect(code).toBe(0);
  expect(JSON.parse(lines[0]!)).toMatchObject({ version: 1, type: 'brain-proposals', action: 'maintenance-report', localOnly: true, data: { receivedActor: 'a' } });
});

it('exits 130 on cancellation', async () => {
  const root = makeRoot('maintain-summary.py', SLOW_SCRIPT);
  const inputPath = writeJson(root, 'input.json', {});
  const controller = new AbortController();
  const lines: string[] = [];
  const pending = runBrainProposalsCommand(
    ['summary-plan', '--root', root, '--host-config', 'h', '--input', inputPath],
    { write: (l) => lines.push(l), interpreter: 'node', signal: controller.signal },
  );
  controller.abort();
  expect(await pending).toBe(130);
  expect(JSON.parse(lines[0]!)).toMatchObject({ error: { code: 'cancelled' } });
});
