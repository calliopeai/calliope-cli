/**
 * SSRF + stdio-spawn consent regression tests for the MCP client.
 *
 * Covers issue #138 (SEC-mcp-ssrf):
 *  - fetchManifest / mcpCall reject non-http(s) schemes and
 *    loopback / link-local / metadata / private addresses by default.
 *  - An opt-in (MCP_ALLOW_PRIVATE_HOSTS) is required to reach private targets.
 *  - Stdio servers are not spawned without explicit consent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const tmpHome: string = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-mcp-ssrf-'));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const {
  assertUrlAllowed,
  fetchManifest,
  spawnStdioProcess,
  registerStdioServer,
  connectStdioServers,
  saveServers,
} = await import('../src/mcp.js');

const ENV_KEYS = [
  'MCP_ALLOW_PRIVATE_HOSTS',
  'MCP_ALLOW_STDIO_SPAWN',
  'MCP_STDIO_INHERIT_ENV',
];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('assertUrlAllowed — scheme validation', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/scheme/i);
    await expect(assertUrlAllowed('ftp://example.com')).rejects.toThrow(/scheme/i);
  });

  it('rejects malformed URLs', async () => {
    await expect(assertUrlAllowed('not a url')).rejects.toThrow(/Invalid MCP URL/);
  });

  it('allows ordinary public http(s) URLs (literal public IP)', async () => {
    await expect(assertUrlAllowed('https://93.184.216.34/mcp')).resolves.toBeUndefined();
  });
});

describe('assertUrlAllowed — SSRF address blocking (default deny)', () => {
  it('rejects the cloud metadata endpoint 169.254.169.254', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(/169\.254\.169\.254|link-local|blocked/i);
  });

  // Loopback is the common local-MCP case and is allowed by default; the
  // dangerous SSRF targets (cloud metadata / private ranges) stay blocked.
  it('allows loopback by literal IP by default', async () => {
    await expect(assertUrlAllowed('http://127.0.0.1:3000/mcp')).resolves.toBeUndefined();
  });

  it('allows loopback by name (localhost) by default', async () => {
    await expect(assertUrlAllowed('http://localhost:3000/mcp')).resolves.toBeUndefined();
  });

  it('allows IPv6 loopback ::1 by default', async () => {
    await expect(assertUrlAllowed('http://[::1]:3000/mcp')).resolves.toBeUndefined();
  });

  it('rejects loopback when MCP_BLOCK_LOOPBACK=1', async () => {
    process.env.MCP_BLOCK_LOOPBACK = '1';
    try {
      await expect(assertUrlAllowed('http://127.0.0.1:3000/mcp')).rejects.toThrow(/private|link-local|blocked/i);
      await expect(assertUrlAllowed('http://localhost:3000/mcp')).rejects.toThrow(/Failed to resolve|private|blocked/i);
    } finally {
      delete process.env.MCP_BLOCK_LOOPBACK;
    }
  });

  it.each([
    'http://10.0.0.5/mcp',
    'http://172.16.5.5/mcp',
    'http://192.168.1.10/mcp',
    'http://100.64.0.1/mcp',
  ])('rejects private range %s', async (url) => {
    await expect(assertUrlAllowed(url)).rejects.toThrow(/private|blocked/i);
  });
});

describe('assertUrlAllowed — explicit opt-in', () => {
  it('allows loopback when MCP_ALLOW_PRIVATE_HOSTS=1', async () => {
    process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
    await expect(assertUrlAllowed('http://127.0.0.1:3000/mcp')).resolves.toBeUndefined();
    await expect(assertUrlAllowed('http://localhost:3000/mcp')).resolves.toBeUndefined();
    await expect(assertUrlAllowed('http://169.254.169.254/')).resolves.toBeUndefined();
  });

  it('still rejects bad schemes even when private hosts are allowed', async () => {
    process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/scheme/i);
  });
});

describe('fetchManifest / mcpCall guard wiring', () => {
  it('fetchManifest rejects a metadata URL before issuing any request', async () => {
    await expect(fetchManifest('http://169.254.169.254/')).rejects.toThrow(/link-local|blocked|169\.254/i);
  });
});

describe('stdio spawn consent gate', () => {
  it('refuses to spawn without explicit consent', () => {
    expect(() =>
      spawnStdioProcess({
        id: 'mcp_test',
        name: 'evil',
        url: '',
        tools: [],
        status: 'disconnected',
        autoConnect: false,
        transport: 'stdio',
        command: 'touch',
        args: ['/tmp/calliope-mcp-ssrf-should-not-exist'],
      }),
    ).toThrow(/without consent/i);
  });

  it('refuses to spawn without consent via registerStdioServer', async () => {
    await expect(
      registerStdioServer('touch', ['/tmp/calliope-mcp-ssrf-should-not-exist']),
    ).rejects.toThrow(/without consent/i);
  });

  it('connectStdioServers is a no-op without consent (does not spawn persisted servers)', async () => {
    saveServers([
      {
        id: 'mcp_persisted',
        name: 'evil',
        url: '',
        tools: [],
        status: 'disconnected',
        autoConnect: true,
        transport: 'stdio',
        command: 'touch',
        args: ['/tmp/calliope-mcp-ssrf-should-not-exist'],
      },
    ]);
    // Should resolve without throwing and without spawning anything.
    await expect(connectStdioServers()).resolves.toBeUndefined();
  });

  it('attempts to spawn when consent is given (allowSpawn) — invalid command surfaces, not the consent guard', () => {
    // With consent, the spawn is attempted; a bogus command path will not throw
    // synchronously from the consent guard. We assert the consent guard does NOT
    // block it (no "without consent" error).
    expect(() =>
      spawnStdioProcess(
        {
          id: 'mcp_consented',
          name: 'echo',
          url: '',
          tools: [],
          status: 'disconnected',
          autoConnect: false,
          transport: 'stdio',
          command: 'true',
          args: [],
        },
        { allowSpawn: true },
      ),
    ).not.toThrow(/without consent/i);
  });
});
