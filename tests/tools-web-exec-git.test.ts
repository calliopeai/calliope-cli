/**
 * Tests for the web_search, execute_code and git executors in src/tools.ts,
 * driven through the real executeTool dispatch.
 *
 * - `https` is mocked so web_search parses a canned DuckDuckGo HTML page with no
 *   network access, and we can force the error / timeout branches.
 * - the sandbox backend is mocked so execute_code's native and unsandboxed
 *   output-formatting paths run without a real sandbox.
 * - git's security validations (unknown op, RCE flags, ext:: protocol, commit
 *   requires -m) short-circuit before any child process is spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── https mock (per-test controllable) ──────────────────────────────────
const httpsMock = vi.hoisted(() => ({ mode: 'success' as 'success' | 'error' | 'timeout', body: '', errMsg: 'boom' }));
vi.mock('https', () => ({
  get: (_url: any, _opts: any, cb?: any) => {
    const { EventEmitter } = require('events');
    const callback = typeof _opts === 'function' ? _opts : cb;
    const req: any = new EventEmitter();
    req.destroy = () => {};
    req.setTimeout = (_ms: number, onTimeout: () => void) => {
      if (httpsMock.mode === 'timeout') process.nextTick(onTimeout);
    };
    if (httpsMock.mode === 'error') {
      process.nextTick(() => req.emit('error', new Error(httpsMock.errMsg)));
      return req;
    }
    if (httpsMock.mode === 'success') {
      const res: any = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        callback(res);
        process.nextTick(() => {
          res.emit('data', httpsMock.body);
          res.emit('end');
        });
      });
    }
    return req;
  },
}));

// ── sandbox mock (per-test controllable) ────────────────────────────────
const sb = vi.hoisted(() => ({
  strategy: 'unsandboxed' as 'docker' | 'native' | 'unsandboxed',
  native: { stdout: '', stderr: '', exitCode: 0, sandboxed: true, backend: 'seatbelt' },
  unsafe: { success: true, stdout: '', stderr: '', exitCode: 0, duration: 5 },
}));
vi.mock('../src/sandbox/index.js', () => ({
  selectCodeSandbox: () => sb.strategy,
  executeInNativeSandbox: async () => sb.native,
  executeUnsafe: async () => sb.unsafe,
  execute: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0, duration: 1, sandboxed: true }),
  shouldUseNativeSandbox: () => 'skip',
  isDockerAvailable: () => false,
  isNativeSandboxAvailable: () => false,
  getSandboxMode: () => 'off',
}));

import { executeTool } from '../src/tools.js';
import { resetScope } from '../src/scope.js';
import type { ToolCall } from '../src/types.js';

function makeTool(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Date.now()}`, name, arguments: args };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-tools-weg-'));
  resetScope(tmpDir);
  httpsMock.mode = 'success';
  httpsMock.body = '';
  sb.strategy = 'unsandboxed';
  sb.native = { stdout: '', stderr: '', exitCode: 0, sandboxed: true, backend: 'seatbelt' };
  sb.unsafe = { success: true, stdout: '', stderr: '', exitCode: 0, duration: 5 };
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// web_search
// ═══════════════════════════════════════════════════════════════════════

const DDG_HTML = [
  '<a class="result__a" href="https://a.com">Title A</a>',
  '<a class="result__snippet">Snippet A</a>',
  '<a class="result__a" href="https://b.com">Title B</a>',
  '<a class="result__snippet">Snippet B</a>',
  '<a class="result__a" href="https://c.com">Title C</a>',
  '<a class="result__snippet">Snippet C</a>',
].join('\n');

describe('web_search', () => {
  it('rejects an empty query before hitting the network', async () => {
    const r = await executeTool(makeTool('web_search', { query: '   ' }), tmpDir);
    expect(r.isError).toBe(true);
    expect(r.result).toContain('query must be a non-empty string');
  });

  it('parses results from the DuckDuckGo HTML response', async () => {
    httpsMock.body = DDG_HTML;
    const r = await executeTool(makeTool('web_search', { query: 'calliope' }), tmpDir);
    expect(r.result).toContain('Web search results for "calliope"');
    expect(r.result).toContain('Title A');
    expect(r.result).toContain('https://a.com');
    expect(r.result).toContain('Snippet B');
  });

  it('honours num_results by limiting the number parsed', async () => {
    httpsMock.body = DDG_HTML;
    const r = await executeTool(makeTool('web_search', { query: 'calliope', num_results: 2 }), tmpDir);
    expect(r.result).toContain('Title A');
    expect(r.result).toContain('Title B');
    expect(r.result).not.toContain('Title C');
  });

  it('reports when there are no results', async () => {
    httpsMock.body = '<html><body>nothing here</body></html>';
    const r = await executeTool(makeTool('web_search', { query: 'zxqw' }), tmpDir);
    expect(r.result).toBe('No results found for: zxqw');
  });

  it('surfaces a request error', async () => {
    httpsMock.mode = 'error';
    httpsMock.errMsg = 'getaddrinfo ENOTFOUND';
    const r = await executeTool(makeTool('web_search', { query: 'calliope' }), tmpDir);
    expect(r.result).toContain('Search error: getaddrinfo ENOTFOUND');
  });

  it('surfaces a timeout', async () => {
    httpsMock.mode = 'timeout';
    const r = await executeTool(makeTool('web_search', { query: 'calliope' }), tmpDir);
    expect(r.result).toBe('Search timed out');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// execute_code
// ═══════════════════════════════════════════════════════════════════════

describe('execute_code', () => {
  it('rejects an unsupported language', async () => {
    const r = await executeTool(makeTool('execute_code', { language: 'ruby', code: 'puts 1' }), tmpDir);
    expect(r.isError).toBe(true);
    expect(r.result).toContain('language must be python, node, or bash');
  });

  it('rejects non-string code', async () => {
    const r = await executeTool(makeTool('execute_code', { language: 'python', code: 42 }), tmpDir);
    expect(r.isError).toBe(true);
    expect(r.result).toContain('code must be a string');
  });

  it('formats native-sandbox success output', async () => {
    sb.strategy = 'native';
    sb.native = { stdout: 'hello', stderr: '', exitCode: 0, sandboxed: true, backend: 'seatbelt' };
    const r = await executeTool(makeTool('execute_code', { language: 'python', code: 'print(1)' }), tmpDir);
    expect(r.result).toContain('[sandboxed:seatbelt] ok [python]');
    expect(r.result).toContain('Output:\nhello');
  });

  it('formats native-sandbox error output', async () => {
    sb.strategy = 'native';
    sb.native = { stdout: '', stderr: 'boom', exitCode: 1, sandboxed: true, backend: 'seatbelt' };
    const r = await executeTool(makeTool('execute_code', { language: 'node', code: 'throw 1' }), tmpDir);
    expect(r.result).toContain('[sandboxed:seatbelt] err [node]');
    expect(r.result).toContain('Errors:\nboom');
  });

  it('reports an exit code when native output is empty', async () => {
    sb.strategy = 'native';
    sb.native = { stdout: '', stderr: '', exitCode: 3, sandboxed: false, backend: 'none' };
    const r = await executeTool(makeTool('execute_code', { language: 'bash', code: 'exit 3' }), tmpDir);
    expect(r.result).toContain('[unsandboxed] err [bash]');
    expect(r.result).toContain('Exit code: 3');
  });

  it('formats unsandboxed output', async () => {
    sb.strategy = 'unsandboxed';
    sb.unsafe = { success: true, stdout: 'out', stderr: '', exitCode: 0, duration: 7 };
    const r = await executeTool(makeTool('execute_code', { language: 'bash', code: 'echo out' }), tmpDir);
    expect(r.result).toContain('[unsandboxed] ok [bash]');
    expect(r.result).toContain('Output:\nout');
    expect(r.result).toContain('Duration: 7ms');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// git security validation (short-circuits before any process spawns)
// ═══════════════════════════════════════════════════════════════════════

describe('git validation', () => {
  it('rejects a non-string operation', async () => {
    const r = await executeTool(makeTool('git', { operation: 42 }), tmpDir);
    expect(r.isError).toBe(true);
    expect(r.result).toContain('operation must be a string');
  });

  it('rejects an unknown operation', async () => {
    const r = await executeTool(makeTool('git', { operation: 'rebase' }), tmpDir);
    expect(r.result).toContain('Unknown git operation: rebase');
  });

  it('blocks RCE-prone flags like --upload-pack', async () => {
    const r = await executeTool(makeTool('git', { operation: 'push', args: '--upload-pack=evil origin' }), tmpDir);
    expect(r.result).toContain('is not allowed (RCE risk)');
  });

  it('blocks the ext:: remote protocol', async () => {
    const r = await executeTool(makeTool('git', { operation: 'pull', args: 'ext::sh -c evil' }), tmpDir);
    expect(r.result).toContain('ext::');
    expect(r.result).toContain('not allowed');
  });

  it('requires a -m message for commit', async () => {
    const r = await executeTool(makeTool('git', { operation: 'commit', args: '' }), tmpDir);
    expect(r.result).toBe('Error: commit requires -m "message"');
  });
});
