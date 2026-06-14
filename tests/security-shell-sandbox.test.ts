/**
 * Regression tests for the security-shell-sandbox cluster.
 *
 * Covers:
 *  - #132 shell blocklist split on &, |, newline (per-fragment anchored match)
 *  - #133 native sandbox: network off by default, secret-read denial, fail-closed
 *  - #139 validatePath/scope: realpath resolution, drop /tmp escape,
 *         non-basename (symlink-target) secret match
 *  - #154 walkDir bounded recursion + visited-realpath guard + entry cap,
 *         grepFiles line-by-line scanning
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Mutable mock state (hoisted-safe via closures)
// ---------------------------------------------------------------------------

let mockSandboxMode: string = 'off';
let mockNativeAvailable = false;

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      get: (key: string) => {
        if (key === 'sandboxMode') return mockSandboxMode;
        return (actual.default as { get: (k: string) => unknown }).get(key);
      },
    },
  };
});

vi.mock('../src/sandbox-native.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox-native.js')>();
  return {
    ...actual,
    isNativeSandboxAvailable: () => mockNativeAvailable,
  };
});

import { executeTool } from '../src/tools.js';
import { resetScope, isInScope, validatePath } from '../src/scope.js';
import { buildSeatbeltProfile } from '../src/sandbox-native.js';
import type { ToolCall } from '../src/types.js';

let tmpDir: string;
function makeTool(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c-${Date.now()}-${Math.random()}`, name, arguments: args };
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-sec-')));
  resetScope(tmpDir);
  mockSandboxMode = 'off'; // unsandboxed fallback path so non-sandbox tests run
  mockNativeAvailable = false;
  delete process.env.CALLIOPE_SHELL_NETWORK;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.CALLIOPE_SHELL_NETWORK;
});

// ===========================================================================
// #132 - blocklist split on & | newline
// ===========================================================================

describe('#132 shell blocklist - extended separators', () => {
  it('blocks "sudo rm -rf /" after a single & (background) separator', async () => {
    const r = await executeTool(makeTool('shell', { command: 'echo x & sudo rm -rf /' }), tmpDir);
    expect(r.result).toContain('blocked');
  });

  it('blocks "sudo rm -rf /" after a newline separator', async () => {
    const r = await executeTool(makeTool('shell', { command: 'echo x\nsudo rm -rf /' }), tmpDir);
    expect(r.result).toContain('blocked');
  });

  it('blocks "sudo rm -rf /" after a single | separator', async () => {
    const r = await executeTool(makeTool('shell', { command: 'true | sudo rm -rf /' }), tmpDir);
    expect(r.result).toContain('blocked');
  });

  it('still blocks the plain "sudo rm -rf /" case (no regression)', async () => {
    const r = await executeTool(makeTool('shell', { command: 'sudo rm -rf /' }), tmpDir);
    expect(r.result).toContain('blocked');
  });

  it('does NOT block a benign pipeline "echo hi | cat"', async () => {
    const r = await executeTool(makeTool('shell', { command: 'echo hi | cat' }), tmpDir);
    expect(r.result).not.toContain('blocked');
    expect(r.result).toContain('hi');
  });

  it('does NOT block a benign background "sleep 0 & wait"', async () => {
    const r = await executeTool(makeTool('shell', { command: 'echo ok & wait' }), tmpDir);
    expect(r.result).not.toContain('blocked');
    expect(r.result).toContain('ok');
  });
});

// ===========================================================================
// #133 - native sandbox hardening
// ===========================================================================

describe('#133 Seatbelt profile - network + secret reads', () => {
  it('omits network rules when networkEnabled is false (default)', () => {
    const profile = buildSeatbeltProfile('/some/cwd', {});
    expect(profile).not.toContain('network-outbound');
  });

  it('includes network rules only when networkEnabled is true (opt-in)', () => {
    const profile = buildSeatbeltProfile('/some/cwd', { networkEnabled: true });
    expect(profile).toContain('network-outbound');
  });

  it('denies reads of ~/.ssh, ~/.aws and *.env even with broad file-read*', () => {
    const profile = buildSeatbeltProfile('/some/cwd', {});
    const home = os.homedir();
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain(`(deny file-read* (subpath "${home}/.ssh"))`);
    expect(profile).toContain(`(deny file-read* (subpath "${home}/.aws"))`);
    expect(profile).toContain('deny file-read* (regex');
  });
});

describe('#133 executeShell sandbox modes + network default', () => {
  it('runs (best-effort, unsandboxed) in auto mode when no native backend exists', async () => {
    // 'auto' must not fail closed on platforms without a native sandbox (e.g.
    // Linux/Windows) — shell execution has to keep working everywhere.
    mockSandboxMode = 'auto';
    mockNativeAvailable = false;
    const r = await executeTool(makeTool('shell', { command: 'echo ran-auto' }), tmpDir);
    expect(r.result).toContain('ran-auto');
  });

  it('fails closed only when the user explicitly requires native sandboxing', async () => {
    mockSandboxMode = 'native';
    mockNativeAvailable = false;
    const r = await executeTool(makeTool('shell', { command: 'echo should-not-run' }), tmpDir);
    expect(r.result).toMatch(/Native sandbox required|not available/i);
    expect(r.result).not.toContain('should-not-run');
  });

  it('runs (unsandboxed) when the user explicitly sets sandboxMode=off', async () => {
    mockSandboxMode = 'off';
    mockNativeAvailable = false;
    const r = await executeTool(makeTool('shell', { command: 'echo ran-off' }), tmpDir);
    expect(r.result).toContain('ran-off');
  });
});

// ===========================================================================
// #139 - validatePath / scope: realpath, /tmp, symlink secret match
// ===========================================================================

describe('#139 scope hardening - symlinks and /tmp', () => {
  it('rejects a symlink inside cwd that points outside scope (read)', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-outside-'));
    const secret = path.join(outside, 'target.txt');
    fs.writeFileSync(secret, 'secret');
    const link = path.join(tmpDir, 'innocent.txt');
    fs.symlinkSync(secret, link);
    try {
      expect(isInScope(link, tmpDir)).toBe(false);
      expect(() => validatePath(link, tmpDir)).toThrow(/Access denied|outside/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a write whose parent dir is a symlink out of scope', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-outdir-'));
    const linkDir = path.join(tmpDir, 'subdir');
    fs.symlinkSync(outside, linkDir);
    const writeTarget = path.join(linkDir, 'newfile.txt'); // does not exist yet
    try {
      expect(isInScope(writeTarget, tmpDir)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('blocks a denylist-evading symlink (notes.txt -> id_rsa) via real target', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-secret-'));
    const idrsa = path.join(outside, 'id_rsa');
    fs.writeFileSync(idrsa, 'KEY');
    const link = path.join(tmpDir, 'notes.txt');
    fs.symlinkSync(idrsa, link);
    try {
      const res = isInScope(link, tmpDir);
      expect(res).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does NOT allow /tmp by default (allowTmp=false)', () => {
    resetScope(tmpDir);
    const other = fs.realpathSync(os.tmpdir());
    // A path under the system tmp root but outside the cwd scope must be denied.
    expect(isInScope(path.join(other, 'definitely-not-in-scope-xyz.txt'), tmpDir)).toBe(false);
  });

  it('still allows ordinary in-scope files (happy path)', () => {
    const f = path.join(tmpDir, 'ok.txt');
    fs.writeFileSync(f, 'hi');
    expect(isInScope(f, tmpDir)).toBe(true);
    expect(validatePath(f, tmpDir)).toBeTruthy();
  });
});

// ===========================================================================
// #154 - walkDir bounds + grep line streaming
// ===========================================================================

describe('#154 walkDir/grep bounds', () => {
  it('does not stack-overflow on a deep directory tree (grep)', async () => {
    // Build a tree deeper than WALK_MAX_DEPTH (40).
    let cur = tmpDir;
    for (let i = 0; i < 80; i++) {
      cur = path.join(cur, `d${i}`);
      fs.mkdirSync(cur);
    }
    fs.writeFileSync(path.join(tmpDir, 'shallow.txt'), 'needle here\n');
    const r = await executeTool(makeTool('grep', { pattern: 'needle', path: '.' }), tmpDir);
    // Must complete without throwing; shallow match is found.
    expect(r.result).toContain('shallow.txt');
  });

  it('does not loop on a directory symlink cycle', async () => {
    const a = path.join(tmpDir, 'a');
    fs.mkdirSync(a);
    fs.writeFileSync(path.join(a, 'file.txt'), 'cyclehit\n');
    // Create a cycle: a/loop -> tmpDir
    fs.symlinkSync(tmpDir, path.join(a, 'loop'));
    const r = await executeTool(makeTool('grep', { pattern: 'cyclehit', path: '.' }), tmpDir);
    expect(r.result).toContain('cyclehit');
  });

  it('grep returns matching lines with correct line numbers (happy path)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'multi.txt'), 'alpha\nbeta\ngamma\nbeta again\n');
    const r = await executeTool(makeTool('grep', { pattern: 'beta', path: '.' }), tmpDir);
    expect(r.result).toContain('multi.txt:2: beta');
    expect(r.result).toContain('multi.txt:4: beta again');
  });

  it('grep respects MAX_RESULTS and stops early on a many-match file', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `match-${i}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'big.txt'), lines + '\n');
    const r = await executeTool(makeTool('grep', { pattern: 'match-', path: '.' }), tmpDir);
    expect(r.result).toContain('results truncated at 200');
  });
});

// ===========================================================================
// #141 - tool access to the CLI state dir (~/.calliope-cli) is refused
// ===========================================================================

describe('#141 protect the Calliope state directory', () => {
  const stateFile = path.join(os.homedir(), '.calliope-cli', 'hooks', 'planted.json');

  it('refuses write_file into ~/.calliope-cli (cannot self-plant a hook)', async () => {
    const r = await executeTool(makeTool('write_file', { path: stateFile, content: '{}' }), tmpDir);
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/state directory|protected/i);
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('refuses read_file from ~/.calliope-cli (cannot read trust/server tokens)', async () => {
    const r = await executeTool(makeTool('read_file', { path: path.join(os.homedir(), '.calliope-cli', 'servers.json') }), tmpDir);
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/state directory|protected/i);
  });
});
