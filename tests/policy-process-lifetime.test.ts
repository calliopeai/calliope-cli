/** Real POSIX subprocesses; no process, signal, or policy mocks. */
import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePolicy } from '../src/policy.js';

const call = { id: 'policy-lifetime', name: 'write_file', arguments: { path: 'effect.txt', content: 'exact' } };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(kind: 'allow' | 'deny' | 'timeout' | 'cancel' | 'escaped-timeout' | 'escaped-cancel') {
  const root = mkdtempSync(join(tmpdir(), 'calliope-policy-lifetime-'));
  const childPid = join(root, 'child.pid'), ready = join(root, 'ready'), effect = join(root, 'late-effect');
  const child = join(root, 'child.cjs'), parent = join(root, 'parent.cjs');
  const escaped = kind.startsWith('escaped-');
  const ending = kind.endsWith('cancel') ? 'cancel' : kind.endsWith('timeout') ? 'timeout' : kind;
  // A ready file proves the actual child installed its signal handler before
  // the policy parent completes or the test requests cancellation.
  writeFileSync(child, `const fs=require('node:fs');process.on('SIGTERM',()=>{});` +
    `fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));fs.writeFileSync(${JSON.stringify(ready)},'ready');` +
    `setTimeout(()=>{fs.writeFileSync(${JSON.stringify(effect)},'late');process.exit(0)},4000);`);
  writeFileSync(parent, `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],` +
    `{detached:${escaped},stdio:${escaped ? "['ignore',process.stdout,process.stderr]" : "'ignore'"}});` +
    `const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(wait);` +
    (ending === 'allow' || ending === 'deny' ? `process.exit(${ending === 'allow' ? 0 : 2})` : 'setInterval(()=>{},1000)') + `}},5);`);
  const controller = new AbortController();
  let settled = false;
  const started = Date.now();
  const result = evaluatePolicy(call, { command: `${quote(process.execPath)} ${quote(parent)}`, timeoutMs: 500,
    signal: controller.signal }).then(value => { settled = true; return value; });
  try {
    if (ending === 'cancel') {
      while (!existsSync(ready) && Date.now() - started < 2000) await pause(10);
      expect(existsSync(ready)).toBe(true);
      controller.abort();
    }
    const value = await Promise.race([result, pause(1500).then(() => { throw new Error('Policy did not settle within its bounded lifetime'); })]);
    expect(value.decision).toBe(ending === 'allow' ? 'allow' : 'deny');
    if (ending === 'cancel') expect(value.reason).toContain('cancelled');
    if (ending === 'timeout') expect(value.reason).toContain('timed out');
    expect(existsSync(ready)).toBe(true);
    if (!escaped) {
      // SIGKILL can be asynchronous; a zombie cannot create the delayed effect.
      await pause(4200);
      expect(existsSync(effect)).toBe(false);
    }
  } finally {
    if (existsSync(childPid)) {
      try { process.kill(Number(readFileSync(childPid, 'utf8')), 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    if (!settled) controller.abort();
    await result;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const kind of ['allow', 'deny', 'timeout', 'cancel', 'escaped-timeout', 'escaped-cancel'] as const)
  it.skipIf(process.platform === 'win32')(`bounds real policy ${kind} and owns ordinary descendants`, { timeout: 10000 }, () => fixture(kind));

it.skipIf(process.platform === 'win32')('drains ignored stdout so a healthy policy can deliver its allow decision', async () => {
  const result = await evaluatePolicy(call, { command: `${quote(process.execPath)} -e ${quote("process.stdout.write('x'.repeat(2*1024*1024),()=>process.exit(0))")}`, timeoutMs: 1000 });
  expect(result.decision).toBe('allow');
});
