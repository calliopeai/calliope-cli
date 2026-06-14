import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';

// ============================================================================
// Mock dependencies (mirrors api-server.test.ts so the module loads cleanly)
// ============================================================================

const TEST_TOKEN = 'auth-token-xyz789';

vi.mock('../src/config.js', () => ({
  get: vi.fn(() => ''),
  getOrCreateApiToken: vi.fn(() => TEST_TOKEN),
}));

vi.mock('../src/version-check.js', () => ({
  getVersion: vi.fn(() => '1.0.0-test'),
}));

vi.mock('../src/background-jobs.js', () => ({
  listJobs: vi.fn(() => []),
  getJob: vi.fn(() => undefined),
  formatJobsList: vi.fn(() => ''),
  activeJobCount: vi.fn(() => 0),
}));

import {
  startApiServer,
  stopApiServer,
  broadcast,
  getServerTimeouts,
} from '../src/api-server.js';

// ============================================================================
// Helpers
// ============================================================================

const TEST_HOST = '127.0.0.1';
const TEST_PORT = 41000 + Math.floor(Math.random() * 2000);

/**
 * Attempt a WebSocket upgrade. Resolves with the HTTP status line and, if the
 * handshake succeeded (101), the first decoded message frame.
 */
function tryWsUpgrade(
  port: number,
  headers: string[],
): Promise<{ statusLine: string; upgraded: boolean; firstMessage?: any; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: TEST_HOST, port }, () => {
      const wsKey = crypto.randomBytes(16).toString('base64');
      socket.write(
        'GET / HTTP/1.1\r\n' +
        `Host: ${TEST_HOST}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        headers.map((h) => h + '\r\n').join('') +
        `Sec-WebSocket-Key: ${wsKey}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      );
    });

    let buf = Buffer.alloc(0);
    let resolved = false;

    const finishRejected = (statusLine: string) => {
      if (resolved) return;
      resolved = true;
      resolve({ statusLine, upgraded: false, socket });
    };

    const onData = (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      const str = buf.toString();
      if (!str.includes('\r\n\r\n')) return;
      const statusLine = str.split('\r\n')[0];

      if (!statusLine.startsWith('HTTP/1.1 101')) {
        socket.removeListener('data', onData);
        finishRejected(statusLine);
        return;
      }

      // Upgraded — decode the first frame (the "connected" message).
      const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n')) + 4;
      const frame = buf.slice(headerEnd);
      if (frame.length < 2) return;
      const payloadLen = frame[1] & 0x7f;
      let offset = 2;
      let actualLen = payloadLen;
      if (payloadLen === 126 && frame.length >= 4) {
        actualLen = frame.readUInt16BE(2);
        offset = 4;
      }
      if (frame.length < offset + actualLen) return;
      socket.removeListener('data', onData);
      resolved = true;
      resolve({
        statusLine,
        upgraded: true,
        firstMessage: JSON.parse(frame.slice(offset, offset + actualLen).toString('utf-8')),
        socket,
      });
    };

    socket.on('data', onData);
    // A rejected upgrade closes the socket; treat close-without-101 as rejection.
    socket.on('close', () => finishRejected(buf.toString().split('\r\n')[0] || 'closed'));
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('upgrade timeout')); }, 4000);
  });
}

function unauthHttp(path: string, headers?: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: TEST_HOST, port: TEST_PORT, path, method: 'GET', headers },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); },
    );
    req.on('error', reject);
    req.end();
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('API server WebSocket auth + timeouts (SEC-ws-auth)', () => {
  beforeAll(async () => {
    await startApiServer({ port: TEST_PORT, host: TEST_HOST, token: TEST_TOKEN });
  });

  afterAll(async () => {
    await stopApiServer();
  });

  describe('WebSocket upgrade auth', () => {
    it('rejects upgrade with no token (401, socket destroyed, not broadcast)', async () => {
      const result = await tryWsUpgrade(TEST_PORT, []);
      expect(result.upgraded).toBe(false);
      expect(result.statusLine).toContain('401');

      // The rejected client must NOT receive broadcasts. Emit one and confirm
      // the socket gets no data frame before it is closed.
      let received = false;
      result.socket.on('data', () => { received = true; });
      broadcast({ type: 'secret', data: { leak: true } });
      await new Promise((r) => setTimeout(r, 100));
      expect(received).toBe(false);
      result.socket.destroy();
    });

    it('rejects upgrade with a wrong token (401)', async () => {
      const result = await tryWsUpgrade(TEST_PORT, ['Authorization: Bearer wrong-token']);
      expect(result.upgraded).toBe(false);
      expect(result.statusLine).toContain('401');
      result.socket.destroy();
    });

    it('accepts upgrade with a valid Authorization Bearer token and broadcasts to it', async () => {
      const result = await tryWsUpgrade(TEST_PORT, [`Authorization: Bearer ${TEST_TOKEN}`]);
      expect(result.upgraded).toBe(true);
      expect(result.firstMessage.type).toBe('connected');

      // Authenticated client receives broadcasts.
      const got = new Promise<any>((resolve) => {
        result.socket.on('data', (d: Buffer) => {
          const len = d[1] & 0x7f;
          resolve(JSON.parse(d.slice(2, 2 + len).toString('utf-8')));
        });
      });
      broadcast({ type: 'evt', data: 1 });
      const msg = await got;
      expect(msg.type).toBe('evt');
      result.socket.destroy();
    });

    it('accepts upgrade with a valid token via Sec-WebSocket-Protocol', async () => {
      const result = await tryWsUpgrade(TEST_PORT, [`Sec-WebSocket-Protocol: bearer, ${TEST_TOKEN}`]);
      expect(result.upgraded).toBe(true);
      expect(result.firstMessage.type).toBe('connected');
      result.socket.destroy();
    });

    it('rejects upgrade with a wrong token via Sec-WebSocket-Protocol', async () => {
      const result = await tryWsUpgrade(TEST_PORT, ['Sec-WebSocket-Protocol: bearer, nope']);
      expect(result.upgraded).toBe(false);
      expect(result.statusLine).toContain('401');
      result.socket.destroy();
    });
  });

  describe('HTTP Bearer auth (constant-time compare)', () => {
    it('still returns 401 for a missing token', async () => {
      expect(await unauthHttp('/api/config')).toBe(401);
    });

    it('still returns 401 for a wrong token', async () => {
      expect(await unauthHttp('/api/config', { Authorization: 'Bearer wrong' })).toBe(401);
    });

    it('returns 200 for the correct token', async () => {
      expect(await unauthHttp('/api/config', { Authorization: `Bearer ${TEST_TOKEN}` })).toBe(200);
    });

    it('rejects a token that is a prefix of the valid one (length guard)', async () => {
      expect(await unauthHttp('/api/config', { Authorization: `Bearer ${TEST_TOKEN.slice(0, -1)}` })).toBe(401);
    });
  });

  describe('HTTP timeouts configured', () => {
    it('sets requestTimeout, headersTimeout, and keepAliveTimeout to non-zero values', () => {
      const t = getServerTimeouts();
      expect(t).not.toBeNull();
      expect(t!.requestTimeout).toBeGreaterThan(0);
      expect(t!.headersTimeout).toBeGreaterThan(0);
      expect(t!.keepAliveTimeout).toBeGreaterThan(0);
    });
  });
});
