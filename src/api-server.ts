/**
 * Calliope CLI - Lightweight API Server
 *
 * Optional HTTP + WebSocket server for programmatic access.
 * Start with `calliope --serve` or `calliope --api`.
 * Zero external dependencies — uses Node.js built-in http module.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import * as config from './config.js';
import { getOrCreateApiToken } from './config.js';
import { getVersion } from './version-check.js';
import { listJobs, getJob, formatJobsList, activeJobCount } from './background-jobs.js';
import type { BackgroundJob } from './background-jobs.js';

// ============================================================================
// Types
// ============================================================================

export interface ApiServerConfig {
  port: number;          // Default: 3100
  host: string;          // Default: '127.0.0.1' (localhost only for security)
  enableWebSocket: boolean;
}

interface JsonResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

type WebSocketClient = {
  id: string;
  socket: import('net').Socket;
  send: (data: string) => void;
};

// ============================================================================
// WebSocket helpers (RFC 6455 minimal implementation)
// ============================================================================

function acceptWebSocket(req: http.IncomingMessage, socket: import('net').Socket): WebSocketClient | null {
  const key = req.headers['sec-websocket-key'];
  if (!key) return null;

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC11CE46')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  const client: WebSocketClient = {
    id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    socket,
    send: (data: string) => {
      const payload = Buffer.from(data);
      const frame: number[] = [0x81]; // FIN + text frame
      if (payload.length < 126) {
        frame.push(payload.length);
      } else if (payload.length < 65536) {
        frame.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
      } else {
        frame.push(127);
        // 8 bytes for length (simplified for reasonable sizes)
        for (let i = 7; i >= 0; i--) {
          frame.push((payload.length >> (i * 8)) & 0xff);
        }
      }
      socket.write(Buffer.concat([Buffer.from(frame), payload]));
    },
  };

  return client;
}

function decodeWebSocketFrame(data: Buffer): string | null {
  if (data.length < 2) return null;
  const opcode = data[0] & 0x0f;
  if (opcode === 0x08) return null; // Close frame
  if (opcode !== 0x01) return null; // Only handle text frames

  const masked = (data[1] & 0x80) !== 0;
  let payloadLength = data[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    payloadLength = data.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    payloadLength = Number(data.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    const mask = data.slice(offset, offset + 4);
    offset += 4;
    const payload = data.slice(offset, offset + payloadLength);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
    return payload.toString('utf-8');
  }

  return data.slice(offset, offset + payloadLength).toString('utf-8');
}

// ============================================================================
// API Server
// ============================================================================

let server: http.Server | null = null;
const wsClients: WebSocketClient[] = [];

// Bearer token for this server instance (set on startApiServer)
let activeToken: string = '';

/**
 * Check if the request carries a valid Bearer token.
 * Returns true if auth passes, false otherwise.
 * The GET /api/health endpoint is exempt from auth.
 */
export function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = new URL(req.url || '/', `http://127.0.0.1`);
  // Health endpoint is public (unauthenticated)
  if (req.method === 'GET' && url.pathname === '/api/health') return true;

  const authHeader = req.headers['authorization'] || '';
  const expected = `Bearer ${activeToken}`;
  if (authHeader === expected) return true;

  jsonReply(res, 401, { ok: false, error: 'Unauthorized: valid Bearer token required' });
  return false;
}

// Event broadcast to WebSocket clients
export function broadcast(event: { type: string; data: unknown }): void {
  const msg = JSON.stringify(event);
  for (const client of wsClients) {
    try { client.send(msg); } catch { /* client disconnected */ }
  }
}

function jsonReply(res: http.ServerResponse, status: number, body: JsonResponse): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:3100' });
  res.end(JSON.stringify(body));
}

function handleRoute(method: string, pathname: string, _body: string, res: http.ServerResponse): void {
  // Health
  if (method === 'GET' && pathname === '/api/health') {
    return jsonReply(res, 200, { ok: true, data: { version: getVersion(), uptime: process.uptime() } });
  }

  // Config
  if (method === 'GET' && pathname === '/api/config') {
    return jsonReply(res, 200, { ok: true, data: {
      provider: config.get('defaultProvider'),
      model: config.get('defaultModel'),
      persona: config.get('persona'),
    }});
  }

  // Jobs
  if (method === 'GET' && pathname === '/api/jobs') {
    return jsonReply(res, 200, { ok: true, data: { jobs: listJobs(), active: activeJobCount() } });
  }

  if (method === 'GET' && pathname.startsWith('/api/jobs/')) {
    const id = pathname.slice('/api/jobs/'.length);
    const job = getJob(id);
    if (!job) return jsonReply(res, 404, { ok: false, error: 'Job not found' });
    return jsonReply(res, 200, { ok: true, data: job });
  }

  // Version
  if (method === 'GET' && pathname === '/api/version') {
    return jsonReply(res, 200, { ok: true, data: { version: getVersion() } });
  }

  // 404
  jsonReply(res, 404, { ok: false, error: 'Not found' });
}

/** Start the API server */
export function startApiServer(opts?: Partial<ApiServerConfig & { token?: string }>): Promise<{ port: number; host: string; token: string }> {
  const port = opts?.port || 3100;
  const host = opts?.host || '127.0.0.1';
  const enableWs = opts?.enableWebSocket !== false;

  // Use provided token (for testing) or get/generate persistent token from config
  activeToken = opts?.token !== undefined ? opts.token : getOrCreateApiToken();

  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      // CORS preflight — always allowed without auth
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': 'http://localhost:3100',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        return res.end();
      }

      // Bearer token authentication
      if (!checkAuth(req, res)) return;

      const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB
      let body = '';
      let bodyExceeded = false;
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY_SIZE) {
          bodyExceeded = true;
          req.destroy();
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Request body too large' }));
        }
      });
      req.on('end', () => {
        if (bodyExceeded) return;
        const url = new URL(req.url || '/', `http://${host}:${port}`);
        handleRoute(req.method || 'GET', url.pathname, body, res);
      });
    });

    if (enableWs) {
      server.on('upgrade', (req, socket, head) => {
        const client = acceptWebSocket(req, socket as import('net').Socket);
        if (client) {
          wsClients.push(client);
          client.send(JSON.stringify({ type: 'connected', data: { id: client.id } }));

          socket.on('data', (data: Buffer) => {
            const msg = decodeWebSocketFrame(data);
            if (msg) {
              // Handle incoming WebSocket messages
              try {
                const parsed = JSON.parse(msg);
                if (parsed.type === 'ping') {
                  client.send(JSON.stringify({ type: 'pong' }));
                }
              } catch { /* ignore non-JSON */ }
            }
          });

          socket.on('close', () => {
            const idx = wsClients.indexOf(client);
            if (idx !== -1) wsClients.splice(idx, 1);
          });

          socket.on('error', () => {
            const idx = wsClients.indexOf(client);
            if (idx !== -1) wsClients.splice(idx, 1);
          });
        } else {
          socket.destroy();
        }
      });
    }

    server.on('error', reject);
    server.listen(port, host, () => resolve({ port, host, token: activeToken }));
  });
}

/** Stop the API server */
export function stopApiServer(): Promise<void> {
  return new Promise((resolve) => {
    // Close all WebSocket connections
    for (const client of wsClients) {
      try { client.socket.destroy(); } catch { /* ignore */ }
    }
    wsClients.length = 0;

    if (server) {
      server.close(() => { server = null; resolve(); });
    } else {
      resolve();
    }
  });
}

/** Check if server is running */
export function isApiServerRunning(): boolean {
  return server !== null && server.listening;
}
