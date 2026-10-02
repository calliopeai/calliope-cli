import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function probes(mode: 'healthy' | 'failed' | 'hang') {
  directory = mkdtempSync(join(tmpdir(), 'calliope-docker-probe-'));
  const records = join(directory, 'requests.jsonl');
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}\n
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify({pid: process.pid, args: process.argv.slice(2)}) + '\\n');
    if (${JSON.stringify(mode)} === 'hang') setInterval(() => {}, 1000);
    else if (${JSON.stringify(mode)} === 'failed') process.exit(1);
    else console.log('24.0.0');
  `, { mode: 0o700 });
  vi.stubEnv('PATH', `${directory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`);
  vi.resetModules();
  const sandbox = await import('../src/sandbox/docker.js');
  return { sandbox, records };
}

// Shell executable fixtures are for POSIX hosts; Windows uses CI's existing
// mocked Docker probes and independently packaged native runtime checks.
it.skipIf(process.platform === 'win32')('probes the actual daemon and the exact image with real subprocesses', async () => {
  const { sandbox, records } = await probes('healthy');
  expect(sandbox.isDockerAvailable()).toBe(true);
  expect(sandbox.imageExists('reviewed:image')).toBe(true);
  const requests = readFileSync(records, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(requests.map(request => request.args)).toEqual([
    ['info', '--format', '{{.ServerVersion}}'],
    ['image', 'inspect', '--', 'reviewed:image'],
  ]);
});

it.skipIf(process.platform === 'win32')('returns unavailable when the installed Docker command cannot contact its daemon', async () => {
  const { sandbox } = await probes('failed');
  expect(sandbox.isDockerAvailable()).toBe(false);
  expect(sandbox.imageExists('reviewed:image')).toBe(false);
});

it.skipIf(process.platform === 'win32')('bounds and reaps unresponsive daemon probes without starting pulls', async () => {
  const { sandbox, records } = await probes('hang');
  const started = Date.now();
  expect(sandbox.isDockerAvailable()).toBe(false);
  expect(sandbox.imageExists('reviewed:image')).toBe(false);
  expect(Date.now() - started).toBeLessThan(9000);
  const requests = readFileSync(records, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.args).not.toContain('pull');
    expect(() => process.kill(request.pid, 0)).toThrow();
  }
}, 10000);
