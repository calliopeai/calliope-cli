import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as http from 'http';

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

function request(path: string, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
  });

  // --------------------------------------------------------------------------
  // broadcast
  // --------------------------------------------------------------------------

  describe('broadcast', () => {
    it('does not throw when no clients are connected', () => {
      expect(() => broadcast({ type: 'test', data: { message: 'hello' } })).not.toThrow();
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
});
