import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';

// ============================================================================
// Mock dependencies
// ============================================================================

vi.mock('../src/config.js', () => ({
  get: vi.fn((key: string) => {
    const defaults: Record<string, string> = {
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-20250514',
      persona: 'calliope',
    };
    return defaults[key] ?? '';
  }),
}));

vi.mock('../src/version-check.js', () => ({
  getVersion: vi.fn(() => '1.0.0-test'),
}));

vi.mock('../src/background-jobs.js', () => ({
  listJobs: vi.fn(() => [
    { id: 'job-1', status: 'running', command: 'test' },
  ]),
  getJob: vi.fn((id: string) => {
    if (id === 'job-1') return { id: 'job-1', status: 'running', command: 'test' };
    return undefined;
  }),
  formatJobsList: vi.fn(() => 'Jobs list'),
  activeJobCount: vi.fn(() => 1),
}));

// Import after mocks
import {
  startApiServer,
  stopApiServer,
  isApiServerRunning,
  broadcast,
} from '../src/api-server.js';

// ============================================================================
// Helpers
// ============================================================================

const TEST_PORT = 30000 + Math.floor(Math.random() * 20000);
const TEST_HOST = '127.0.0.1';

function request(path: string, method = 'GET', body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: TEST_HOST, port: TEST_PORT, path, method },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonRequest(path: string, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any }> {
  return request(path, method).then(({ status, headers, body }) => ({
    status,
    headers,
    data: JSON.parse(body),
  }));
}

/** Create a raw WebSocket connection via TCP */
function connectWebSocket(port: number): Promise<{ socket: net.Socket; firstMessage: any }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: TEST_HOST, port }, () => {
      const wsKey = crypto.randomBytes(16).toString('base64');
      socket.write(
        'GET / HTTP/1.1\r\n' +
        `Host: ${TEST_HOST}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${wsKey}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      );
    });

    let gotUpgrade = false;
    let buf = Buffer.alloc(0);

    const onData = (data: Buffer) => {
      buf = Buffer.concat([buf, data]);

      if (!gotUpgrade) {
        const str = buf.toString();
        if (str.includes('\r\n\r\n')) {
          // Check for 101 response
          if (!str.startsWith('HTTP/1.1 101')) {
            socket.removeListener('data', onData);
            reject(new Error('WebSocket upgrade failed: ' + str.split('\r\n')[0]));
            socket.destroy();
            return;
          }
          gotUpgrade = true;
          // Remove HTTP headers from buffer
          const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n')) + 4;
          buf = buf.slice(headerEnd);
        }
      }

      // Try to read a WebSocket frame from buf
      if (gotUpgrade && buf.length >= 2) {
        const payloadLen = buf[1] & 0x7f;
        let offset = 2;
        let actualLen = payloadLen;
        if (payloadLen === 126 && buf.length >= 4) {
          actualLen = buf.readUInt16BE(2);
          offset = 4;
        }
        if (buf.length >= offset + actualLen) {
          const payload = buf.slice(offset, offset + actualLen);
          const msg = JSON.parse(payload.toString('utf-8'));
          socket.removeListener('data', onData);
          resolve({ socket, firstMessage: msg });
        }
      }
    };
    socket.on('data', onData);

    socket.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000);
  });
}

/** Encode a masked WebSocket text frame (client must mask per RFC 6455) */
function encodeWebSocketFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | payload.length; // MASK bit + length
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  return Buffer.concat([header, mask, masked]);
}

/** Encode a WebSocket close frame */
function encodeCloseFrame(): Buffer {
  const mask = crypto.randomBytes(4);
  const header = Buffer.alloc(2);
  header[0] = 0x88; // FIN + close
  header[1] = 0x80; // MASK bit, zero length
  return Buffer.concat([header, mask]);
}

/** Read a WebSocket frame from a socket, returns parsed JSON */
function readWsFrame(socket: net.Socket): Promise<any> {
  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      socket.removeListener('data', onData);
      if (data.length < 2) { reject(new Error('Frame too short')); return; }
      const payloadLen = data[1] & 0x7f;
      let offset = 2;
      let actualLen = payloadLen;
      if (payloadLen === 126) {
        actualLen = data.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        actualLen = Number(data.readBigUInt64BE(2));
        offset = 10;
      }
      const payload = data.slice(offset, offset + actualLen);
      resolve(JSON.parse(payload.toString('utf-8')));
    };
    socket.on('data', onData);
    setTimeout(() => { socket.removeListener('data', onData); reject(new Error('Read timeout')); }, 5000);
  });
}

/** Connect raw TCP without WebSocket key header */
function connectRawUpgradeNoKey(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: TEST_HOST, port }, () => {
      // Send upgrade request WITHOUT Sec-WebSocket-Key
      socket.write(
        'GET / HTTP/1.1\r\n' +
        `Host: ${TEST_HOST}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      );
    });

    socket.on('close', () => resolve(true));
    socket.on('error', () => resolve(true));
    setTimeout(() => { socket.destroy(); resolve(false); }, 3000);
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('API Server', () => {
  beforeAll(async () => {
    await startApiServer({ port: TEST_PORT, host: TEST_HOST });
  });

  afterAll(async () => {
    await stopApiServer();
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('isApiServerRunning returns true when server is started', () => {
      expect(isApiServerRunning()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/health
  // --------------------------------------------------------------------------

  describe('GET /api/health', () => {
    it('returns ok with version and uptime', async () => {
      const { status, data } = await jsonRequest('/api/health');
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.data.version).toBe('1.0.0-test');
      expect(typeof data.data.uptime).toBe('number');
      expect(data.data.uptime).toBeGreaterThan(0);
    });

    it('includes CORS header', async () => {
      const { headers } = await request('/api/health');
      expect(headers['access-control-allow-origin']).toBe('*');
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/version
  // --------------------------------------------------------------------------

  describe('GET /api/version', () => {
    it('returns version', async () => {
      const { status, data } = await jsonRequest('/api/version');
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.data.version).toBe('1.0.0-test');
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/config
  // --------------------------------------------------------------------------

  describe('GET /api/config', () => {
    it('returns provider config', async () => {
      const { status, data } = await jsonRequest('/api/config');
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.data.provider).toBe('anthropic');
      expect(data.data.model).toBe('claude-sonnet-4-20250514');
      expect(data.data.persona).toBe('calliope');
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/jobs
  // --------------------------------------------------------------------------

  describe('GET /api/jobs', () => {
    it('returns jobs list with active count', async () => {
      const { status, data } = await jsonRequest('/api/jobs');
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.data.jobs).toEqual([
        { id: 'job-1', status: 'running', command: 'test' },
      ]);
      expect(data.data.active).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/jobs/:id
  // --------------------------------------------------------------------------

  describe('GET /api/jobs/:id', () => {
    it('returns a specific job by id', async () => {
      const { status, data } = await jsonRequest('/api/jobs/job-1');
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.data.id).toBe('job-1');
      expect(data.data.status).toBe('running');
    });

    it('returns 404 for unknown job', async () => {
      const { status, data } = await jsonRequest('/api/jobs/nonexistent');
      expect(status).toBe(404);
      expect(data.ok).toBe(false);
      expect(data.error).toBe('Job not found');
    });
  });

  // --------------------------------------------------------------------------
  // Unknown routes
  // --------------------------------------------------------------------------

  describe('unknown routes', () => {
    it('GET /unknown returns 404', async () => {
      const { status, data } = await jsonRequest('/unknown');
      expect(status).toBe(404);
      expect(data.ok).toBe(false);
      expect(data.error).toBe('Not found');
    });

    it('GET /api/nonexistent returns 404', async () => {
      const { status, data } = await jsonRequest('/api/nonexistent');
      expect(status).toBe(404);
      expect(data.ok).toBe(false);
      expect(data.error).toBe('Not found');
    });

    it('POST to unknown route returns 404', async () => {
      const { status, data } = await jsonRequest('/api/nonexistent', 'POST');
      expect(status).toBe(404);
      expect(data.ok).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // OPTIONS (CORS preflight)
  // --------------------------------------------------------------------------

  describe('OPTIONS (CORS preflight)', () => {
    it('returns 204 with CORS headers', async () => {
      const { status, headers } = await request('/api/health', 'OPTIONS');
      expect(status).toBe(204);
      expect(headers['access-control-allow-origin']).toBe('*');
      expect(headers['access-control-allow-methods']).toBe('GET, POST, DELETE');
      expect(headers['access-control-allow-headers']).toBe('Content-Type');
    });

    it('returns 204 for OPTIONS on any path', async () => {
      const { status } = await request('/any/path', 'OPTIONS');
      expect(status).toBe(204);
    });
  });

  // --------------------------------------------------------------------------
  // Request body handling
  // --------------------------------------------------------------------------

  describe('request body', () => {
    it('handles POST request with body', async () => {
      const { status, data } = await new Promise<{ status: number; data: any }>((resolve, reject) => {
        const req = http.request(
          { hostname: TEST_HOST, port: TEST_PORT, path: '/api/health', method: 'POST',
            headers: { 'Content-Type': 'application/json' } },
          (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(body) }));
          },
        );
        req.on('error', reject);
        req.write(JSON.stringify({ test: 'data' }));
        req.end();
      });
      // POST to /api/health is not a GET match, so it should 404
      expect(status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // broadcast (no clients)
  // --------------------------------------------------------------------------

  describe('broadcast', () => {
    it('does not throw when no clients are connected', () => {
      expect(() => broadcast({ type: 'test', data: { message: 'hello' } })).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // WebSocket upgrade and communication
  // --------------------------------------------------------------------------

  describe('WebSocket', () => {
    it('accepts WebSocket upgrade and sends connected message', async () => {
      const { socket, firstMessage } = await connectWebSocket(TEST_PORT);
      expect(firstMessage.type).toBe('connected');
      expect(firstMessage.data.id).toMatch(/^ws-/);
      socket.destroy();
    });

    it('responds to ping messages with pong', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Send a ping message
      const pingFrame = encodeWebSocketFrame(JSON.stringify({ type: 'ping' }));
      socket.write(pingFrame);

      // Read the pong response
      const pong = await readWsFrame(socket);
      expect(pong.type).toBe('pong');

      socket.destroy();
    });

    it('handles non-JSON WebSocket messages gracefully', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Send non-JSON text — should not crash
      const frame = encodeWebSocketFrame('this is not json');
      socket.write(frame);

      // Wait a bit to ensure server doesn't crash, then verify it still works
      await new Promise(r => setTimeout(r, 100));

      // Send a ping to confirm server is still responsive
      socket.write(encodeWebSocketFrame(JSON.stringify({ type: 'ping' })));
      const pong = await readWsFrame(socket);
      expect(pong.type).toBe('pong');

      socket.destroy();
    });

    it('handles non-ping JSON messages without crashing', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Send a JSON message with an unknown type
      const frame = encodeWebSocketFrame(JSON.stringify({ type: 'unknown', data: 'test' }));
      socket.write(frame);

      // Wait and verify server still works
      await new Promise(r => setTimeout(r, 100));

      socket.write(encodeWebSocketFrame(JSON.stringify({ type: 'ping' })));
      const pong = await readWsFrame(socket);
      expect(pong.type).toBe('pong');

      socket.destroy();
    });

    it('broadcasts messages to connected WebSocket clients', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Broadcast from server
      broadcast({ type: 'test-event', data: { hello: 'world' } });

      // Read the broadcast message
      const msg = await readWsFrame(socket);
      expect(msg.type).toBe('test-event');
      expect(msg.data).toEqual({ hello: 'world' });

      socket.destroy();
    });

    it('broadcasts to multiple clients', async () => {
      const conn1 = await connectWebSocket(TEST_PORT);
      const conn2 = await connectWebSocket(TEST_PORT);

      broadcast({ type: 'multi', data: 42 });

      const [msg1, msg2] = await Promise.all([
        readWsFrame(conn1.socket),
        readWsFrame(conn2.socket),
      ]);

      expect(msg1.type).toBe('multi');
      expect(msg2.type).toBe('multi');

      conn1.socket.destroy();
      conn2.socket.destroy();
    });

    it('removes client on socket close', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Close the socket
      socket.destroy();

      // Wait for close event to propagate
      await new Promise(r => setTimeout(r, 100));

      // broadcast should not throw (client removed)
      expect(() => broadcast({ type: 'after-close', data: null })).not.toThrow();
    });

    it('removes client on socket error', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Force an error by emitting one
      socket.emit('error', new Error('test error'));

      await new Promise(r => setTimeout(r, 100));

      // Should not throw
      expect(() => broadcast({ type: 'after-error', data: null })).not.toThrow();
      socket.destroy();
    });

    it('destroys socket when upgrade request has no WebSocket key', async () => {
      const closed = await connectRawUpgradeNoKey(TEST_PORT);
      expect(closed).toBe(true);
    });

    it('handles close frame (opcode 0x08)', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Send a close frame
      const closeFrame = encodeCloseFrame();
      socket.write(closeFrame);

      // The server should handle it gracefully (decodeWebSocketFrame returns null)
      // Verify server is still running
      await new Promise(r => setTimeout(r, 100));
      expect(isApiServerRunning()).toBe(true);

      socket.destroy();
    });

    it('handles binary frame (opcode != 0x01 and != 0x08)', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Send a binary frame (opcode 0x02) - should be ignored by decodeWebSocketFrame
      const mask = crypto.randomBytes(4);
      const payload = Buffer.from('binary data');
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i % 4];
      }
      const header = Buffer.alloc(2);
      header[0] = 0x82; // FIN + binary
      header[1] = 0x80 | payload.length;
      socket.write(Buffer.concat([header, mask, masked]));

      // Verify server still responds
      await new Promise(r => setTimeout(r, 100));
      socket.write(encodeWebSocketFrame(JSON.stringify({ type: 'ping' })));
      const pong = await readWsFrame(socket);
      expect(pong.type).toBe('pong');

      socket.destroy();
    });

    it('handles medium payload (126-65535 bytes) in send()', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Create a broadcast message that's > 125 bytes when serialized
      const largeData = 'x'.repeat(200);
      broadcast({ type: 'large', data: largeData });

      const msg = await readWsFrame(socket);
      expect(msg.type).toBe('large');
      expect(msg.data).toBe(largeData);

      socket.destroy();
    });

    it('handles medium WebSocket frame decoding (126 extended length)', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Send a masked frame with 126-byte extended length encoding
      const text = JSON.stringify({ type: 'ping', padding: 'y'.repeat(200) });
      const frame = encodeWebSocketFrame(text);
      socket.write(frame);

      const pong = await readWsFrame(socket);
      expect(pong.type).toBe('pong');

      socket.destroy();
    });

    it('handles unmasked frame decoding', async () => {
      const { socket } = await connectWebSocket(TEST_PORT);

      // Send an UNMASKED text frame (no mask bit set)
      // Note: RFC 6455 says client MUST mask, but the server code handles both
      const text = JSON.stringify({ type: 'ping' });
      const payload = Buffer.from(text);
      const header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text
      header[1] = payload.length; // No MASK bit
      socket.write(Buffer.concat([header, payload]));

      const pong = await readWsFrame(socket);
      expect(pong.type).toBe('pong');

      socket.destroy();
    });
  });
});

// ============================================================================
// Separate describe for stop/start lifecycle tests
// ============================================================================

describe('API Server lifecycle (stop/start)', () => {
  it('isApiServerRunning returns false after stop', async () => {
    const port = TEST_PORT + 1;
    await startApiServer({ port, host: TEST_HOST });
    expect(isApiServerRunning()).toBe(true);

    await stopApiServer();
    expect(isApiServerRunning()).toBe(false);
  });

  it('stopApiServer resolves even if server is already stopped', async () => {
    // Should not throw or hang
    await stopApiServer();
    expect(isApiServerRunning()).toBe(false);
  });

  it('can start server again after stopping', async () => {
    const port = TEST_PORT + 2;
    await startApiServer({ port, host: TEST_HOST });
    expect(isApiServerRunning()).toBe(true);

    // Verify it responds
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: TEST_HOST, port, path: '/api/health', method: 'GET' },
        (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode! })); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);

    await stopApiServer();
    expect(isApiServerRunning()).toBe(false);
  });

  it('stopApiServer closes connected WebSocket clients', async () => {
    const port = TEST_PORT + 3;
    await startApiServer({ port, host: TEST_HOST });

    const { socket } = await connectWebSocket(port);

    // Track if socket gets closed
    const closed = new Promise<boolean>((resolve) => {
      socket.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });

    await stopApiServer();

    const wasClosed = await closed;
    expect(wasClosed).toBe(true);
    expect(isApiServerRunning()).toBe(false);
  });
});

// ============================================================================
// Server with WebSocket disabled
// ============================================================================

describe('API Server with WebSocket disabled', () => {
  const wsDisabledPort = TEST_PORT + 4;

  beforeAll(async () => {
    await startApiServer({ port: wsDisabledPort, host: TEST_HOST, enableWebSocket: false });
  });

  afterAll(async () => {
    await stopApiServer();
  });

  it('still serves HTTP requests', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: TEST_HOST, port: wsDisabledPort, path: '/api/health', method: 'GET' },
        (r) => {
          let body = '';
          r.on('data', (chunk) => { body += chunk; });
          r.on('end', () => resolve({ status: r.statusCode!, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
  });
});

// ============================================================================
// Default options
// ============================================================================

describe('API Server default options', () => {
  afterEach(async () => {
    await stopApiServer();
  });

  it('starts with default port and host when no options provided', async () => {
    // This tests the default opts path (port 3100, host 127.0.0.1)
    const result = await startApiServer();
    expect(result.port).toBe(3100);
    expect(result.host).toBe('127.0.0.1');
    expect(isApiServerRunning()).toBe(true);
  });
});
