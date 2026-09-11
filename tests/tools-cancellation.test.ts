import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { executeTool } from '../src/tools.js';
import { scopeManager } from '../src/scope.js';
import * as sandbox from '../src/sandbox/index.js';

vi.mock('../src/sandbox/index.js', async importActual => ({
  ...await importActual<typeof import('../src/sandbox/index.js')>(),
  getSandboxMode: vi.fn(() => 'off'),
  shouldUseNativeSandbox: vi.fn(() => 'skip'),
  selectCodeSandbox: vi.fn(() => 'unsandboxed'),
  executeInSandbox: vi.fn(),
}));
let cwd: string;
beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-cancel-tools-')));
  scopeManager.reset(cwd);
  vi.mocked(sandbox.getSandboxMode).mockReturnValue('off');
  vi.mocked(sandbox.selectCodeSandbox).mockReturnValue('unsandboxed');
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('tool cancellation', () => {
  it('does not perform a write after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executeTool({ id: 'write', name: 'write_file', arguments: { path: 'result.txt', content: 'forbidden' } }, cwd, 5000, undefined, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fs.existsSync(path.join(cwd, 'result.txt'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('stops a shell and a descendant that ignores TERM', async () => {
    const controller = new AbortController();
    const command = `node -e 'process.on("SIGTERM",()=>{}); require("fs").writeFileSync("ready.txt","yes"); setTimeout(()=>require("fs").writeFileSync("late.txt","bad"),700); setInterval(()=>{},1000)' >child-output.txt 2>&1 & while [ ! -f ready.txt ]; do sleep 0.01; done; echo ready; wait`;
    let started = false;
    const result = executeTool({ id: 'shell', name: 'shell', arguments: { command } }, cwd, 5000, chunk => {
      if (chunk.includes('ready')) started = true;
    }, { signal: controller.signal });
    const outcome = result.then(value => value, error => error);
    try { await vi.waitFor(() => expect(started).toBe(true), { timeout: 3000 }); }
    finally { controller.abort(); }
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(fs.existsSync(path.join(cwd, 'late.txt'))).toBe(false);
  });

  it('stops code execution and does not report cancellation as success', async () => {
    const controller = new AbortController();
    const result = executeTool({ id: 'code', name: 'execute_code', arguments: { language: 'node', code: 'setInterval(() => {}, 1000)' } }, cwd, 5000, undefined, { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    setTimeout(() => controller.abort(), 100);
    await assertion;
  });

  it.each(['shell', 'execute_code'])('keeps explicit Docker %s execution off the host when Docker is unavailable', async name => {
    vi.mocked(sandbox.getSandboxMode).mockReturnValue('docker');
    vi.mocked(sandbox.selectCodeSandbox).mockReturnValue('docker');
    vi.mocked(sandbox.executeInSandbox).mockResolvedValue({ success: false, stdout: '', stderr: 'Docker is not available', exitCode: 1, duration: 0, sandboxed: false });
    const args = name === 'shell' ? { command: 'echo bad > escaped.txt' } : { language: 'bash', code: 'echo bad > escaped.txt' };
    const result = await executeTool({ id: 'docker', name, arguments: args }, cwd);
    expect(result.result).toContain('Docker is not available');
    expect(fs.existsSync(path.join(cwd, 'escaped.txt'))).toBe(false);
    expect(sandbox.executeInSandbox).toHaveBeenCalled();
  });
});


it('cancels an editor read before write_file can send a write request', async () => {
  const controller = new AbortController();
  let reply!: (content: string) => void;
  const readTextFile = vi.fn(() => new Promise<string>(resolve => { reply = resolve; }));
  const writeTextFile = vi.fn(async () => {});
  const result = executeTool({ id: 'editor', name: 'write_file', arguments: { path: 'result.txt', content: 'new contents' } }, cwd, 5000, undefined, { signal: controller.signal, fs: { readTextFile, writeTextFile } });
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(1));
  controller.abort();
  await assertion;
  reply('old contents');
  await Promise.resolve();
  expect(writeTextFile).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(cwd, 'result.txt'))).toBe(false);
});
