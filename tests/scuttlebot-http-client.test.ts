/**
 * Tests for src/scuttlebot/http-client.ts
 *
 * The HTTP client only touches the network through the global `fetch`, which
 * we stub. Each test asserts the request shape (URL, method, headers, body)
 * and the return / error behaviour for register / rotate / delete / presence
 * / health-check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScuttlebotHTTPClient, type ScuttlebotConfig } from '../src/scuttlebot/http-client.js';

const mockFetch = vi.fn();

const config: ScuttlebotConfig = {
  url: 'http://localhost:3000',
  token: 'tok-123',
  ircAddr: '127.0.0.1:6667',
  channel: 'general',
  channels: ['general', 'release'],
};

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean; statusText?: string } = {}) {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: init.statusText ?? '',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('register', () => {
  it('returns credentials on 201 Created and sends a normalized channel list', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ credentials: { nick: 'agent-1', passphrase: 'pw' } }, { status: 201 }),
    );
    const client = new ScuttlebotHTTPClient(config);

    const creds = await client.register('agent-1', 'worker', ['ops', '#eng']);

    expect(creds).toEqual({ nick: 'agent-1', passphrase: 'pw' });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/agents/register');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
    expect(opts.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ nick: 'agent-1', type: 'worker', channels: ['#ops', '#eng'] });
  });

  it('defaults the agent type to worker and uses config channels when none passed', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ credentials: { nick: 'a', passphrase: 'p' } }, { status: 201 }),
    );
    const client = new ScuttlebotHTTPClient(config);

    await client.register('a');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe('worker');
    expect(body.channels).toEqual(['#general', '#release']);
  });

  it('rotates when the nick already exists (409 Conflict)', async () => {
    const client = new ScuttlebotHTTPClient(config);
    mockFetch
      .mockResolvedValueOnce(jsonResponse('conflict', { status: 409 }))
      .mockResolvedValueOnce(jsonResponse({ passphrase: 'rotated-pw' }, { status: 200 }));

    const creds = await client.register('agent-1');

    expect(creds).toEqual({ nick: 'agent-1', passphrase: 'rotated-pw' });
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3000/v1/agents/agent-1/rotate');
  });

  it('throws with server detail on an unexpected status', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse('boom', { status: 500, statusText: 'Internal Server Error' }),
    );
    const client = new ScuttlebotHTTPClient(config);

    await expect(client.register('agent-1')).rejects.toThrow(
      /Registration failed: 500 Internal Server Error — boom/,
    );
  });
});

describe('rotate', () => {
  it('returns the new passphrase for an existing nick', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ passphrase: 'fresh' }));
    const client = new ScuttlebotHTTPClient(config);

    const creds = await client.rotate('agent-9');

    expect(creds).toEqual({ nick: 'agent-9', passphrase: 'fresh' });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/agents/agent-9/rotate');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
  });

  it('throws when the rotate request fails', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse('nope', { status: 403, statusText: 'Forbidden' }),
    );
    const client = new ScuttlebotHTTPClient(config);

    await expect(client.rotate('agent-9')).rejects.toThrow(/Rotate failed: 403 Forbidden — nope/);
  });
});

describe('deleteAgent', () => {
  it('issues a DELETE with the bearer token', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('', { status: 204 }));
    const client = new ScuttlebotHTTPClient(config);

    await client.deleteAgent('agent-1');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/agents/agent-1');
    expect(opts.method).toBe('DELETE');
    expect(opts.headers.Authorization).toBe('Bearer tok-123');
  });

  it('swallows network errors (best-effort cleanup)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const client = new ScuttlebotHTTPClient(config);

    await expect(client.deleteAgent('agent-1')).resolves.toBeUndefined();
  });
});

describe('touchPresence', () => {
  it('posts presence for a nick, stripping the leading # from the channel', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('', { status: 200 }));
    const client = new ScuttlebotHTTPClient(config);

    await client.touchPresence('#general', 'mybot');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/channels/general/presence');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ nick: 'mybot' });
  });

  it('does nothing when url or token is missing', async () => {
    const client = new ScuttlebotHTTPClient({ ...config, url: '', token: '' });

    await client.touchPresence('general', 'mybot');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('swallows presence post errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    const client = new ScuttlebotHTTPClient(config);

    await expect(client.touchPresence('general', 'mybot')).resolves.toBeUndefined();
  });
});

describe('healthCheck', () => {
  it('returns true when the status endpoint responds ok', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('ok', { status: 200 }));
    const client = new ScuttlebotHTTPClient(config);

    await expect(client.healthCheck()).resolves.toBe(true);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/status');
  });

  it('returns false on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('down', { status: 503 }));
    const client = new ScuttlebotHTTPClient(config);

    await expect(client.healthCheck()).resolves.toBe(false);
  });

  it('returns false when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('unreachable'));
    const client = new ScuttlebotHTTPClient(config);

    await expect(client.healthCheck()).resolves.toBe(false);
  });
});
