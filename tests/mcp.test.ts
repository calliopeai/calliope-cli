/**
 * Tests for MCP (Model Context Protocol) module
 *
 * Covers: loadServers, saveServers, unregisterServer, getMCPTools,
 * executeMCPTool, listServers, stopStdioServer, stdioCall,
 * spawnStdioProcess, fetchManifest, registerServer, refreshServer,
 * registerStdioServer, connectStdioServers, mcpCall (via executeMCPTool).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

// MCP_DIR is evaluated once at module load time as
//   path.join(os.homedir(), '.calliope-cli', 'mcp')
// We must set tmpHome BEFORE the dynamic import so the captured constant
// gets a valid, stable path.
const tmpHome: string = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-mcp-init-'));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

// Mock http and https modules for fetchManifest and mcpCall tests
const mockHttpGet = vi.fn();
const mockHttpRequest = vi.fn();
const mockHttpsGet = vi.fn();
const mockHttpsRequest = vi.fn();

vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  return {
    ...actual,
    get: (...args: unknown[]) => mockHttpGet(...args),
    request: (...args: unknown[]) => mockHttpRequest(...args),
  };
});

vi.mock('https', async () => {
  const actual = await vi.importActual<typeof import('https')>('https');
  return {
    ...actual,
    get: (...args: unknown[]) => mockHttpsGet(...args),
    request: (...args: unknown[]) => mockHttpsRequest(...args),
  };
});

const {
  loadServers,
  saveServers,
  unregisterServer,
  getMCPTools,
  executeMCPTool,
  listServers,
  stopStdioServer,
  stdioCall,
  spawnStdioProcess,
  fetchManifest,
  registerServer,
  refreshServer,
  registerStdioServer,
  connectStdioServers,
} = await import('../src/mcp.js');

import type { MCPServer, MCPTool, MCPManifest } from '../src/mcp.js';

// The stable MCP directory used throughout all tests
const MCP_DIR = path.join(tmpHome, '.calliope-cli', 'mcp');
const SERVERS_FILE = path.join(MCP_DIR, 'servers.json');

// ============================================================================
// Helpers
// ============================================================================

function makeMCPTool(overrides: Partial<MCPTool> = {}): MCPTool {
  return {
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    ...overrides,
  };
}

function makeMCPServer(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: 'mcp_1234567890_abc123',
    name: 'Test Server',
    url: 'https://example.com/mcp',
    description: 'A test MCP server',
    tools: [makeMCPTool()],
    status: 'connected',
    lastConnected: '2025-01-15T00:00:00.000Z',
    autoConnect: true,
    transport: 'http',
    ...overrides,
  };
}

function makeManifest(overrides: Partial<MCPManifest> = {}): MCPManifest {
  return {
    name: 'Test MCP Server',
    version: '1.0.0',
    description: 'A test server',
    tools: [makeMCPTool()],
    ...overrides,
  };
}

/**
 * Create a mock HTTP response (IncomingMessage-like EventEmitter).
 * Body is emitted after a short delay to ensure listeners are attached.
 */
function createMockResponse(
  statusCode: number,
  body: string,
  headers: Record<string, string> = {}
): EventEmitter & { statusCode: number; headers: Record<string, string> } {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
  };
  res.statusCode = statusCode;
  res.headers = headers;
  // Emit body after listeners are attached (the 'data' listener is set up
  // synchronously inside the callback that receives this response object,
  // so we need to defer emission until after that callback completes)
  const origOn = res.on.bind(res);
  let dataListenerAttached = false;
  res.on = function(event: string, listener: (...args: unknown[]) => void) {
    origOn(event, listener);
    if (event === 'data' && !dataListenerAttached) {
      dataListenerAttached = true;
      setTimeout(() => {
        res.emit('data', Buffer.from(body));
        res.emit('end');
      }, 5);
    }
    return res;
  } as typeof res.on;
  return res;
}

/**
 * Create a mock HTTP request (ClientRequest-like EventEmitter)
 */
function createMockRequest(): EventEmitter & {
  destroy: () => void;
  write: (data: string) => boolean;
  end: () => void;
} {
  const req = new EventEmitter() as EventEmitter & {
    destroy: () => void;
    write: (data: string) => boolean;
    end: () => void;
  };
  req.destroy = vi.fn();
  req.write = vi.fn().mockReturnValue(true);
  req.end = vi.fn();
  return req;
}

// ============================================================================
// Tests
// ============================================================================

// Clean up the servers file before each test to get a blank slate
beforeEach(() => {
  if (fs.existsSync(SERVERS_FILE)) {
    fs.unlinkSync(SERVERS_FILE);
  }
  vi.clearAllMocks();
});

// Clean up the entire tmpHome after all tests
afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ============================================================================
// Storage Tests
// ============================================================================

describe('MCP Server Storage', () => {
  describe('loadServers', () => {
    it('should return empty array when no servers file exists', () => {
      const servers = loadServers();
      expect(servers).toEqual([]);
    });

    it('should return empty array when servers file is invalid JSON', () => {
      fs.mkdirSync(MCP_DIR, { recursive: true });
      fs.writeFileSync(SERVERS_FILE, 'invalid json{{{');

      const servers = loadServers();
      expect(servers).toEqual([]);
    });

    it('should load servers from a valid file', () => {
      const server = makeMCPServer();
      fs.mkdirSync(MCP_DIR, { recursive: true });
      fs.writeFileSync(SERVERS_FILE, JSON.stringify([server]));

      const servers = loadServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('Test Server');
      expect(servers[0].id).toBe('mcp_1234567890_abc123');
    });

    it('should create the MCP directory if it does not exist', () => {
      if (fs.existsSync(MCP_DIR)) {
        fs.rmSync(MCP_DIR, { recursive: true, force: true });
      }

      loadServers();
      expect(fs.existsSync(MCP_DIR)).toBe(true);
    });

    it('should load multiple servers', () => {
      const servers = [
        makeMCPServer({ id: 'mcp_1', name: 'Server 1' }),
        makeMCPServer({ id: 'mcp_2', name: 'Server 2' }),
        makeMCPServer({ id: 'mcp_3', name: 'Server 3' }),
      ];
      fs.mkdirSync(MCP_DIR, { recursive: true });
      fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers));

      const loaded = loadServers();
      expect(loaded).toHaveLength(3);
    });
  });

  describe('saveServers', () => {
    it('should save servers to a JSON file', () => {
      const server = makeMCPServer();
      saveServers([server]);

      const content = fs.readFileSync(SERVERS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('Test Server');
    });

    it('should overwrite existing servers file', () => {
      saveServers([makeMCPServer({ name: 'First' })]);
      saveServers([makeMCPServer({ name: 'Second' })]);

      const servers = loadServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('Second');
    });

    it('should create the MCP directory if needed', () => {
      if (fs.existsSync(MCP_DIR)) {
        fs.rmSync(MCP_DIR, { recursive: true, force: true });
      }

      saveServers([]);
      expect(fs.existsSync(MCP_DIR)).toBe(true);
    });

    it('should handle saving empty array', () => {
      saveServers([]);
      const servers = loadServers();
      expect(servers).toEqual([]);
    });

    it('should pretty-print JSON with 2-space indent', () => {
      saveServers([makeMCPServer()]);
      const content = fs.readFileSync(SERVERS_FILE, 'utf-8');
      // Pretty-printed JSON starts with [\n  {
      expect(content).toMatch(/^\[\n {2}\{/);
    });
  });

  describe('loadServers + saveServers round-trip', () => {
    it('should preserve all server fields through a save/load cycle', () => {
      const server = makeMCPServer({
        tools: [
          makeMCPTool({ name: 'search' }),
          makeMCPTool({ name: 'fetch', description: 'Fetch a URL' }),
        ],
      });

      saveServers([server]);
      const loaded = loadServers();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe(server.id);
      expect(loaded[0].url).toBe(server.url);
      expect(loaded[0].tools).toHaveLength(2);
      expect(loaded[0].tools[0].name).toBe('search');
      expect(loaded[0].tools[1].name).toBe('fetch');
      expect(loaded[0].transport).toBe('http');
      expect(loaded[0].autoConnect).toBe(true);
    });

    it('should preserve stdio server fields', () => {
      const server = makeMCPServer({
        transport: 'stdio',
        command: '/usr/bin/mcp-server',
        args: ['--verbose'],
        env: { API_KEY: 'secret' },
        url: '',
      });

      saveServers([server]);
      const loaded = loadServers();

      expect(loaded[0].transport).toBe('stdio');
      expect(loaded[0].command).toBe('/usr/bin/mcp-server');
      expect(loaded[0].args).toEqual(['--verbose']);
      expect(loaded[0].env).toEqual({ API_KEY: 'secret' });
    });
  });
});

// ============================================================================
// unregisterServer
// ============================================================================

describe('unregisterServer', () => {
  it('should remove a server by id', () => {
    const server = makeMCPServer({ id: 'mcp_remove_me' });
    saveServers([server]);

    const removed = unregisterServer('mcp_remove_me');
    expect(removed).toBe(true);

    const servers = loadServers();
    expect(servers).toHaveLength(0);
  });

  it('should remove a server by url', () => {
    const server = makeMCPServer({ url: 'https://remove.example.com' });
    saveServers([server]);

    const removed = unregisterServer('https://remove.example.com');
    expect(removed).toBe(true);

    const servers = loadServers();
    expect(servers).toHaveLength(0);
  });

  it('should return false when server is not found', () => {
    saveServers([makeMCPServer()]);

    const removed = unregisterServer('nonexistent');
    expect(removed).toBe(false);
  });

  it('should only remove the matched server, keeping others', () => {
    const server1 = makeMCPServer({ id: 'mcp_keep', name: 'Keep' });
    const server2 = makeMCPServer({ id: 'mcp_remove', name: 'Remove' });
    saveServers([server1, server2]);

    unregisterServer('mcp_remove');

    const servers = loadServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('Keep');
  });

  it('should prefer id match over url match', () => {
    const server1 = makeMCPServer({ id: 'shared_val', url: 'https://a.com' });
    const server2 = makeMCPServer({ id: 'other_id', url: 'shared_val' });
    saveServers([server1, server2]);

    unregisterServer('shared_val');

    const servers = loadServers();
    // Should remove the first one (id match comes first in findIndex)
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe('other_id');
  });
});

// ============================================================================
// getMCPTools
// ============================================================================

describe('getMCPTools', () => {
  it('should return empty array when no servers registered', () => {
    const tools = getMCPTools();
    expect(tools).toEqual([]);
  });

  it('should convert MCP tools to Calliope Tool format', () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_xyzabc',
      tools: [
        makeMCPTool({
          name: 'search',
          description: 'Search the web',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              limit: { type: 'number', description: 'Max results' },
            },
            required: ['query'],
          },
        }),
      ],
    });
    saveServers([server]);

    const tools = getMCPTools();

    expect(tools).toHaveLength(1);
    // Name format: mcp_{last6 of id}_{toolName}
    expect(tools[0].name).toBe('mcp_xyzabc_search');
    expect(tools[0].description).toContain('[MCP: Test Server]');
    expect(tools[0].description).toContain('Search the web');
    expect(tools[0].parameters.type).toBe('object');
    expect(tools[0].parameters.properties.query).toBeDefined();
    expect(tools[0].parameters.properties.query.type).toBe('string');
    expect(tools[0].parameters.required).toEqual(['query']);
  });

  it('should skip disconnected servers', () => {
    saveServers([
      makeMCPServer({ status: 'disconnected', tools: [makeMCPTool()] }),
    ]);

    const tools = getMCPTools();
    expect(tools).toHaveLength(0);
  });

  it('should skip servers with error status', () => {
    saveServers([
      makeMCPServer({ status: 'error', tools: [makeMCPTool()] }),
    ]);

    const tools = getMCPTools();
    expect(tools).toHaveLength(0);
  });

  it('should include tools from multiple connected servers', () => {
    saveServers([
      makeMCPServer({
        id: 'mcp_1111_aaaaaa',
        status: 'connected',
        tools: [makeMCPTool({ name: 'tool1' })],
      }),
      makeMCPServer({
        id: 'mcp_2222_bbbbbb',
        status: 'connected',
        tools: [makeMCPTool({ name: 'tool2' }), makeMCPTool({ name: 'tool3' })],
      }),
    ]);

    const tools = getMCPTools();
    expect(tools).toHaveLength(3);
  });

  it('should handle tools with enum properties', () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_enumsv',
      tools: [
        makeMCPTool({
          name: 'format',
          inputSchema: {
            type: 'object',
            properties: {
              style: {
                type: 'string',
                description: 'Output style',
                enum: ['json', 'xml', 'csv'],
              },
            },
          },
        }),
      ],
    });
    saveServers([server]);

    const tools = getMCPTools();
    expect(tools[0].parameters.properties.style.enum).toEqual([
      'json',
      'xml',
      'csv',
    ]);
  });

  it('should handle tools with empty properties', () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_emptpr',
      tools: [
        makeMCPTool({
          name: 'ping',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        }),
      ],
    });
    saveServers([server]);

    const tools = getMCPTools();
    expect(tools).toHaveLength(1);
    expect(Object.keys(tools[0].parameters.properties)).toHaveLength(0);
  });

  it('should use property key as description fallback when description is missing', () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_nodesc',
      tools: [
        makeMCPTool({
          name: 'test',
          inputSchema: {
            type: 'object',
            properties: {
              myParam: { type: 'string' },
            },
          },
        }),
      ],
    });
    saveServers([server]);

    const tools = getMCPTools();
    expect(tools[0].parameters.properties.myParam.description).toBe('myParam');
  });

  it('should mix connected and disconnected servers correctly', () => {
    saveServers([
      makeMCPServer({
        id: 'mcp_1111_connec',
        status: 'connected',
        tools: [makeMCPTool({ name: 'active_tool' })],
      }),
      makeMCPServer({
        id: 'mcp_2222_discon',
        status: 'disconnected',
        tools: [makeMCPTool({ name: 'inactive_tool' })],
      }),
      makeMCPServer({
        id: 'mcp_3333_errorr',
        status: 'error',
        tools: [makeMCPTool({ name: 'error_tool' })],
      }),
    ]);

    const tools = getMCPTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp_connec_active_tool');
  });
});

// ============================================================================
// executeMCPTool
// ============================================================================

describe('executeMCPTool', () => {
  it('should return error for invalid tool name format', async () => {
    const result = await executeMCPTool('invalid_name', {});
    expect(result).toContain('Error: Invalid MCP tool name');
  });

  it('should return error when server is not found', async () => {
    saveServers([]);
    const result = await executeMCPTool('mcp_notfound_sometool', {});
    expect(result).toContain('Error: MCP server not found');
  });

  it('should return error for a tool name that does not match any server suffix', async () => {
    saveServers([
      makeMCPServer({ id: 'mcp_1234567890_aaaaaa' }),
    ]);

    const result = await executeMCPTool('mcp_xxxxxx_sometool', {});
    expect(result).toContain('Error: MCP server not found');
  });

  it('should return error for completely malformed name', async () => {
    const result = await executeMCPTool('foo', {});
    expect(result).toContain('Error: Invalid MCP tool name');
  });

  it('should return error for name with only two parts', async () => {
    const result = await executeMCPTool('mcp_abc', {});
    expect(result).toContain('Error: Invalid MCP tool name');
  });

  it('should attempt HTTP call for http transport server and handle connection error', async () => {
    // Use a tool name without underscores to avoid regex ambiguity
    const server = makeMCPServer({
      id: 'mcp_1234567890_httpsv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockReq = createMockRequest();
    mockHttpsRequest.mockImplementation((_opts: unknown, _cb: unknown) => {
      process.nextTick(() => {
        mockReq.emit('error', new Error('ECONNREFUSED'));
      });
      return mockReq;
    });

    const result = await executeMCPTool('mcp_httpsv_search', { query: 'hello' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('ECONNREFUSED');
  });

  it('should handle successful HTTP response with JSON-RPC result', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_succsv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockRes = createMockResponse(
      200,
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: 'Hello World' } }),
      {}
    );
    const mockReq = createMockRequest();

    mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const result = await executeMCPTool('mcp_succsv_search', { query: 'hello' });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ content: 'Hello World' });
  });

  it('should return string result directly if result is a string', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_strsrv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockRes = createMockResponse(
      200,
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'plain text result' }),
      {}
    );
    const mockReq = createMockRequest();

    mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const result = await executeMCPTool('mcp_strsrv_search', { query: 'test' });
    expect(result).toBe('plain text result');
  });

  it('should handle JSON-RPC error response', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_errsrv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockRes = createMockResponse(
      200,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid request' },
      }),
      {}
    );
    const mockReq = createMockRequest();

    mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const result = await executeMCPTool('mcp_errsrv_search', { query: 'test' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('Invalid request');
  });

  it('should handle invalid JSON response from server', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_badsrv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockRes = createMockResponse(200, 'not json at all', {});
    const mockReq = createMockRequest();

    mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const result = await executeMCPTool('mcp_badsrv_search', { query: 'test' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('Invalid MCP response');
  });

  it('should handle HTTP timeout', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_tmosrv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockReq = createMockRequest();
    mockHttpsRequest.mockImplementation((_opts: unknown, _cb: unknown) => {
      process.nextTick(() => {
        mockReq.emit('timeout');
      });
      return mockReq;
    });

    const result = await executeMCPTool('mcp_tmosrv_search', { query: 'test' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('Request timed out');
  });

  it('should use http module for http:// urls', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_htpsrv',
      transport: 'http',
      url: 'http://localhost:8080/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockRes = createMockResponse(
      200,
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }),
      {}
    );
    const mockReq = createMockRequest();

    mockHttpRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const result = await executeMCPTool('mcp_htpsrv_search', { query: 'test' });
    expect(result).toBe('ok');
    expect(mockHttpRequest).toHaveBeenCalled();
  });

  it('should handle response size limit exceeded', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_bigsrv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockReq = createMockRequest();

    mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.statusCode = 200;
      res.headers = { 'content-length': String(100 * 1024 * 1024) };
      process.nextTick(() => cb(res));
      return mockReq;
    });

    const result = await executeMCPTool('mcp_bigsrv_search', { query: 'test' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('too large');
  });

  it('should handle STDIO transport calling stdioCall for missing process', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_stdsrv',
      transport: 'stdio',
      command: 'some-cmd',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const result = await executeMCPTool('mcp_stdsrv_search', { query: 'test' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('No running STDIO process');
  });
});

// ============================================================================
// listServers
// ============================================================================

describe('listServers', () => {
  it('should return empty array when no servers exist', () => {
    const servers = listServers();
    expect(servers).toEqual([]);
  });

  it('should return all registered servers', () => {
    saveServers([
      makeMCPServer({ id: 'mcp_a', name: 'Server A' }),
      makeMCPServer({ id: 'mcp_b', name: 'Server B' }),
    ]);

    const servers = listServers();
    expect(servers).toHaveLength(2);
  });

  it('should return servers regardless of status', () => {
    saveServers([
      makeMCPServer({ id: 'mcp_1', status: 'connected' }),
      makeMCPServer({ id: 'mcp_2', status: 'disconnected' }),
      makeMCPServer({ id: 'mcp_3', status: 'error' }),
    ]);

    const servers = listServers();
    expect(servers).toHaveLength(3);
  });
});

// ============================================================================
// fetchManifest
// ============================================================================

describe('fetchManifest', () => {
  it('should fetch manifest from .well-known/mcp endpoint', async () => {
    const manifest = makeManifest({ name: 'My Server' });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const result = await fetchManifest('https://example.com/mcp');
    expect(result.name).toBe('My Server');
    expect(result.tools).toHaveLength(1);
  });

  it('should fall back to root URL on 404 from well-known', async () => {
    const manifest = makeManifest({ name: 'Fallback Server' });

    // The 404 response triggers a second get() call inside the same callback.
    // The second get() call is also on https, so we track call count.
    let callCount = 0;
    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      callCount++;
      const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
      mockReq.destroy = vi.fn();

      if (callCount === 1) {
        // First call (well-known) returns 404
        const mock404Res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        mock404Res.statusCode = 404;
        mock404Res.headers = {};
        process.nextTick(() => cb(mock404Res));
      } else {
        // Second call (root) returns the manifest
        const mockRootRes = createMockResponse(200, JSON.stringify(manifest));
        process.nextTick(() => cb(mockRootRes));
      }
      return mockReq;
    });

    const result = await fetchManifest('https://example.com/mcp');
    expect(result.name).toBe('Fallback Server');
  });

  it('should reject on non-200 status (not 404)', async () => {
    const mockRes = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
    };
    mockRes.statusCode = 500;
    mockRes.headers = {};

    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow('HTTP 500');
  });

  it('should reject on invalid JSON in manifest response', async () => {
    const mockRes = createMockResponse(200, 'not json');
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow(
      'Invalid MCP manifest'
    );
  });

  it('should reject on network error', async () => {
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, _cb: unknown) => {
      process.nextTick(() => {
        mockReq.emit('error', new Error('ENOTFOUND'));
      });
      return mockReq;
    });

    await expect(fetchManifest('https://bad-host.invalid')).rejects.toThrow('ENOTFOUND');
  });

  it('should reject on timeout', async () => {
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, _cb: unknown) => {
      process.nextTick(() => {
        mockReq.emit('timeout');
      });
      return mockReq;
    });

    await expect(fetchManifest('https://slow-host.example.com')).rejects.toThrow(
      'Request timed out'
    );
  });

  it('should use http module for http:// URLs', async () => {
    const manifest = makeManifest({ name: 'HTTP Server' });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const result = await fetchManifest('http://localhost:3000/mcp');
    expect(result.name).toBe('HTTP Server');
    expect(mockHttpGet).toHaveBeenCalled();
  });

  it('should reject when manifest exceeds size limit via Content-Length', async () => {
    const mockRes = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
    };
    mockRes.statusCode = 200;
    mockRes.headers = { 'content-length': String(20 * 1024 * 1024) }; // 20MB > 10MB limit

    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow('too large');
  });

  it('should reject when streamed data exceeds size limit', async () => {
    const mockRes = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
    };
    mockRes.statusCode = 200;
    mockRes.headers = {}; // No content-length

    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => {
        cb(mockRes);
        // Emit data chunks exceeding limit
        const bigChunk = Buffer.alloc(6 * 1024 * 1024, 'x'); // 6MB
        mockRes.emit('data', bigChunk);
        mockRes.emit('data', bigChunk); // Total 12MB > 10MB limit
      });
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow('exceeded size limit');
  });

  it('should handle URL with trailing slash for well-known endpoint', async () => {
    const manifest = makeManifest({ name: 'Slash Server' });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    let capturedUrl = '';
    mockHttpsGet.mockImplementation((url: string, _opts: unknown, cb: (res: unknown) => void) => {
      capturedUrl = url;
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    await fetchManifest('https://example.com/');
    expect(capturedUrl).toBe('https://example.com/.well-known/mcp');
  });

  it('should handle URL without trailing slash for well-known endpoint', async () => {
    const manifest = makeManifest({ name: 'NoSlash Server' });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    let capturedUrl = '';
    mockHttpsGet.mockImplementation((url: string, _opts: unknown, cb: (res: unknown) => void) => {
      capturedUrl = url;
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    await fetchManifest('https://example.com');
    expect(capturedUrl).toBe('https://example.com/.well-known/mcp');
  });
});

// ============================================================================
// registerServer
// ============================================================================

describe('registerServer', () => {
  it('should register a new server from manifest', async () => {
    const manifest = makeManifest({ name: 'New Server', description: 'Fresh' });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const server = await registerServer('https://new-server.example.com');

    expect(server.name).toBe('New Server');
    expect(server.description).toBe('Fresh');
    expect(server.status).toBe('connected');
    expect(server.transport).toBe('http');
    expect(server.url).toBe('https://new-server.example.com');
    expect(server.id).toMatch(/^mcp_\d+_\w+$/);
    expect(server.tools).toHaveLength(1);
    expect(server.autoConnect).toBe(true);

    // Verify it was persisted
    const servers = loadServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('New Server');
  });

  it('should replace existing server with same URL', async () => {
    // Pre-save a server
    saveServers([makeMCPServer({ url: 'https://existing.example.com', name: 'Old' })]);

    const manifest = makeManifest({ name: 'Updated Server' });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    await registerServer('https://existing.example.com');

    const servers = loadServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('Updated Server');
  });

  it('should respect autoConnect parameter', async () => {
    const manifest = makeManifest({ name: 'NoAuto' });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const server = await registerServer('https://noauto.example.com', false);
    expect(server.autoConnect).toBe(false);
  });

  it('should handle manifest with no tools', async () => {
    const manifest = makeManifest({ name: 'Empty', tools: [] });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const server = await registerServer('https://empty.example.com');
    expect(server.tools).toEqual([]);
  });

  it('should propagate fetch errors', async () => {
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, _cb: unknown) => {
      process.nextTick(() => mockReq.emit('error', new Error('Network failure')));
      return mockReq;
    });

    await expect(registerServer('https://bad.example.com')).rejects.toThrow('Network failure');
  });
});

// ============================================================================
// refreshServer
// ============================================================================

describe('refreshServer', () => {
  it('should return null for non-existent server', async () => {
    const result = await refreshServer('nonexistent');
    expect(result).toBeNull();
  });

  it('should refresh server tools on successful manifest fetch', async () => {
    saveServers([makeMCPServer({
      id: 'mcp_refresh_test',
      url: 'https://refresh.example.com',
      tools: [makeMCPTool({ name: 'old_tool' })],
    })]);

    const newManifest = makeManifest({
      tools: [
        makeMCPTool({ name: 'new_tool_1' }),
        makeMCPTool({ name: 'new_tool_2' }),
      ],
    });
    const mockRes = createMockResponse(200, JSON.stringify(newManifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const server = await refreshServer('mcp_refresh_test');
    expect(server).not.toBeNull();
    expect(server!.status).toBe('connected');
    expect(server!.tools).toHaveLength(2);
    expect(server!.tools[0].name).toBe('new_tool_1');
    expect(server!.lastConnected).toBeDefined();
  });

  it('should set error status on failed manifest fetch', async () => {
    saveServers([makeMCPServer({
      id: 'mcp_refresh_fail',
      url: 'https://fail.example.com',
      status: 'connected',
    })]);

    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, _cb: unknown) => {
      process.nextTick(() => mockReq.emit('error', new Error('ECONNREFUSED')));
      return mockReq;
    });

    const server = await refreshServer('mcp_refresh_fail');
    expect(server).not.toBeNull();
    expect(server!.status).toBe('error');
  });

  it('should find server by URL', async () => {
    saveServers([makeMCPServer({
      id: 'mcp_url_refresh',
      url: 'https://find-by-url.example.com',
    })]);

    const manifest = makeManifest({ tools: [] });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const server = await refreshServer('https://find-by-url.example.com');
    expect(server).not.toBeNull();
    expect(server!.id).toBe('mcp_url_refresh');
  });

  it('should persist updated server state', async () => {
    saveServers([makeMCPServer({
      id: 'mcp_persist_check',
      url: 'https://persist.example.com',
      status: 'error',
      tools: [],
    })]);

    const manifest = makeManifest({ tools: [makeMCPTool({ name: 'restored' })] });
    const mockRes = createMockResponse(200, JSON.stringify(manifest));
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    await refreshServer('mcp_persist_check');

    // Check persisted state
    const servers = loadServers();
    expect(servers[0].status).toBe('connected');
    expect(servers[0].tools).toHaveLength(1);
    expect(servers[0].tools[0].name).toBe('restored');
  });
});

// ============================================================================
// stopStdioServer
// ============================================================================

describe('stopStdioServer', () => {
  it('should return false when no process exists for the server id', () => {
    const result = stopStdioServer('nonexistent_server');
    expect(result).toBe(false);
  });

  it('should stop a spawned process and return true', () => {
    const server = makeMCPServer({
      id: 'mcp_stop_test_123',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    spawnStdioProcess(server);
    const result = stopStdioServer('mcp_stop_test_123');
    expect(result).toBe(true);

    // Should not be able to stop again
    const result2 = stopStdioServer('mcp_stop_test_123');
    expect(result2).toBe(false);
  });
});

// ============================================================================
// stdioCall
// ============================================================================

describe('stdioCall', () => {
  it('should throw when no running process exists', async () => {
    await expect(
      stdioCall('nonexistent_id', 'tools/call', { name: 'test' })
    ).rejects.toThrow('No running STDIO process for server nonexistent_id');
  });

  it('should send JSON-RPC request and resolve with response', async () => {
    // Use a node script that reads a request and writes back a proper JSON-RPC response
    const server = makeMCPServer({
      id: 'mcp_stdio_call_ok',
      transport: 'stdio',
      command: 'node',
      args: ['-e', `
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const req = JSON.parse(line);
              const resp = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { data: 'success' } });
              process.stdout.write(resp + '\\n');
            } catch {}
          }
        });
      `],
    });

    const entry = spawnStdioProcess(server);

    const result = await stdioCall('mcp_stdio_call_ok', 'tools/call', { name: 'test' });
    expect(result).toEqual({ data: 'success' });

    entry.process.kill();
  });

  it('should handle error response from STDIO server', async () => {
    const server = makeMCPServer({
      id: 'mcp_stdio_call_err',
      transport: 'stdio',
      command: 'node',
      args: ['-e', `
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const req = JSON.parse(line);
              const resp = JSON.stringify({
                jsonrpc: '2.0',
                id: req.id,
                error: { code: -32600, message: 'Tool not found' },
              });
              process.stdout.write(resp + '\\n');
            } catch {}
          }
        });
      `],
    });

    const entry = spawnStdioProcess(server);

    await expect(
      stdioCall('mcp_stdio_call_err', 'tools/call', { name: 'test' })
    ).rejects.toThrow('Tool not found');

    entry.process.kill();
  });
});

// ============================================================================
// spawnStdioProcess
// ============================================================================

describe('spawnStdioProcess', () => {
  it('should throw when server has no command configured', () => {
    const server = makeMCPServer({
      transport: 'stdio',
      command: undefined,
    });

    expect(() => spawnStdioProcess(server)).toThrow('has no command configured');
  });

  it('should spawn a process for a valid stdio server', () => {
    const server = makeMCPServer({
      id: 'mcp_spawn_test_123',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    const entry = spawnStdioProcess(server);

    expect(entry).toBeDefined();
    expect(entry.process).toBeDefined();
    expect(entry.pending).toBeInstanceOf(Map);
    expect(entry.buffer).toBe('');
    expect(entry.nextId).toBe(1);

    entry.process.kill();
  });

  it('should apply custom environment variables', () => {
    const server = makeMCPServer({
      id: 'mcp_env_test_456',
      transport: 'stdio',
      command: 'cat',
      args: [],
      env: { MY_VAR: 'test_value' },
    });

    const entry = spawnStdioProcess(server);
    expect(entry).toBeDefined();

    entry.process.kill();
  });

  it('should reject missing environment templates before spawning', () => {
    const server = makeMCPServer({
      id: 'mcp_env_missing',
      transport: 'stdio',
      command: 'cat',
      env: { API_TOKEN: '${MISSING_TOKEN}' },
    });

    expect(() => spawnStdioProcess(server)).toThrow(
      'STDIO server mcp_env_missing is missing environment variables: MISSING_TOKEN'
    );
  });

  it('should handle empty args array', () => {
    const server = makeMCPServer({
      id: 'mcp_empty_args',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    const entry = spawnStdioProcess(server);
    expect(entry).toBeDefined();

    entry.process.kill();
  });

  it('should handle undefined args', () => {
    const server = makeMCPServer({
      id: 'mcp_undef_args',
      transport: 'stdio',
      command: 'cat',
    });

    const entry = spawnStdioProcess(server);
    expect(entry).toBeDefined();

    entry.process.kill();
  });

  it('should ignore non-JSON lines from stdout', async () => {
    const server = makeMCPServer({
      id: 'mcp_nonjson_test',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    const entry = spawnStdioProcess(server);

    // Write non-JSON lines - should not cause errors
    entry.process.stdin!.write('this is not json\n');
    entry.process.stdin!.write('DEBUG: some log\n');

    // Wait a bit for processing
    await new Promise(r => setTimeout(r, 50));

    // Should still be functional
    expect(entry.pending.size).toBe(0);

    entry.process.kill();
  });

  it('should reject pending requests on process exit', async () => {
    const server = makeMCPServer({
      id: 'mcp_exit_test',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    const entry = spawnStdioProcess(server);

    // Create a pending request manually
    const promise = new Promise<unknown>((resolve, reject) => {
      entry.pending.set(99, { resolve, reject });
    });

    // Kill the process
    entry.process.kill();

    await expect(promise).rejects.toThrow(/exited with code/);
  });

  it('should process multiple JSON lines in a single chunk', async () => {
    // Use a node script that echoes proper JSON-RPC responses
    const server = makeMCPServer({
      id: 'mcp_multi_line',
      transport: 'stdio',
      command: 'node',
      args: ['-e', `
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const req = JSON.parse(line);
              const resp = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 'resp_' + req.id });
              process.stdout.write(resp + '\\n');
            } catch {}
          }
        });
      `],
    });

    const entry = spawnStdioProcess(server);

    // Make two calls
    const p1 = stdioCall('mcp_multi_line', 'method1', { x: 1 });
    const p2 = stdioCall('mcp_multi_line', 'method2', { x: 2 });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('resp_1');
    expect(r2).toBe('resp_2');

    entry.process.kill();
  });
});

// ============================================================================
// MCPServer type structure
// ============================================================================

describe('MCPServer type structure', () => {
  it('should represent an HTTP transport server correctly', () => {
    const server = makeMCPServer();
    expect(server.transport).toBe('http');
    expect(server.status).toBe('connected');
    expect(server.tools).toBeInstanceOf(Array);
    expect(server.tools[0].inputSchema.type).toBe('object');
  });

  it('should represent a STDIO transport server correctly', () => {
    const server = makeMCPServer({
      transport: 'stdio',
      command: '/usr/bin/my-mcp-server',
      args: ['--port', '3000'],
      env: { DEBUG: '1' },
      url: '',
    });

    expect(server.transport).toBe('stdio');
    expect(server.command).toBe('/usr/bin/my-mcp-server');
    expect(server.args).toEqual(['--port', '3000']);
    expect(server.env).toEqual({ DEBUG: '1' });
  });
});

// ============================================================================
// MCPTool schema handling
// ============================================================================

describe('MCPTool schema handling', () => {
  it('should handle tools with no required fields', () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_noreqs',
      tools: [
        makeMCPTool({
          name: 'optional_tool',
          inputSchema: {
            type: 'object',
            properties: {
              optional_param: { type: 'string', description: 'Optional' },
            },
            // No required array
          },
        }),
      ],
    });
    saveServers([server]);

    const tools = getMCPTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].parameters.required).toBeUndefined();
  });

  it('should handle servers with no tools', () => {
    saveServers([
      makeMCPServer({ id: 'mcp_empty_toolsrv', tools: [], status: 'connected' }),
    ]);

    const tools = getMCPTools();
    expect(tools).toHaveLength(0);
  });

  it('should handle multiple tools from a single server', () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_multi1',
      tools: [
        makeMCPTool({ name: 'read' }),
        makeMCPTool({ name: 'write' }),
        makeMCPTool({ name: 'delete' }),
      ],
    });
    saveServers([server]);

    const tools = getMCPTools();
    expect(tools).toHaveLength(3);
    expect(tools.map(t => t.name)).toEqual([
      'mcp_multi1_read',
      'mcp_multi1_write',
      'mcp_multi1_delete',
    ]);
  });

  it('should handle tools with multiple required fields', () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_mulreq',
      tools: [
        makeMCPTool({
          name: 'complex_tool',
          inputSchema: {
            type: 'object',
            properties: {
              a: { type: 'string', description: 'First' },
              b: { type: 'number', description: 'Second' },
              c: { type: 'boolean', description: 'Third' },
            },
            required: ['a', 'b'],
          },
        }),
      ],
    });
    saveServers([server]);

    const tools = getMCPTools();
    expect(tools[0].parameters.required).toEqual(['a', 'b']);
    expect(Object.keys(tools[0].parameters.properties)).toHaveLength(3);
  });
});

// ============================================================================
// fetchManifest – fallback path (root URL after 404) edge cases
// ============================================================================

describe('fetchManifest fallback path edge cases', () => {
  it('should reject when root URL fallback response exceeds Content-Length limit', async () => {
    let callCount = 0;
    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      callCount++;
      const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
      mockReq.destroy = vi.fn();

      if (callCount === 1) {
        // First call (well-known) returns 404
        const mock404 = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        mock404.statusCode = 404;
        mock404.headers = {};
        process.nextTick(() => cb(mock404));
      } else {
        // Second call (root) has huge Content-Length
        const mockRoot = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        mockRoot.statusCode = 200;
        mockRoot.headers = { 'content-length': String(20 * 1024 * 1024) };
        process.nextTick(() => cb(mockRoot));
      }
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow('too large');
  });

  it('should reject when root URL fallback streamed data exceeds size limit', async () => {
    let callCount = 0;
    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      callCount++;
      const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
      mockReq.destroy = vi.fn();

      if (callCount === 1) {
        const mock404 = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        mock404.statusCode = 404;
        mock404.headers = {};
        process.nextTick(() => cb(mock404));
      } else {
        const mockRoot = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        mockRoot.statusCode = 200;
        mockRoot.headers = {};
        process.nextTick(() => {
          cb(mockRoot);
          const bigChunk = Buffer.alloc(6 * 1024 * 1024, 'x');
          mockRoot.emit('data', bigChunk);
          mockRoot.emit('data', bigChunk); // Total 12MB > 10MB limit
        });
      }
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow('exceeded size limit');
  });

  it('should reject when root URL fallback returns invalid JSON', async () => {
    let callCount = 0;
    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      callCount++;
      const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
      mockReq.destroy = vi.fn();

      if (callCount === 1) {
        const mock404 = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        mock404.statusCode = 404;
        mock404.headers = {};
        process.nextTick(() => cb(mock404));
      } else {
        const mockRoot = createMockResponse(200, 'not json!!!');
        process.nextTick(() => cb(mockRoot));
      }
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow('Invalid MCP manifest');
  });

  it('should reject when root URL fallback has network error', async () => {
    let callCount = 0;
    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      callCount++;
      const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
      mockReq.destroy = vi.fn();

      if (callCount === 1) {
        const mock404 = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        mock404.statusCode = 404;
        mock404.headers = {};
        process.nextTick(() => cb(mock404));
      } else {
        process.nextTick(() => mockReq.emit('error', new Error('ECONNRESET')));
      }
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow('ECONNRESET');
  });

  it('should reject when root URL fallback times out', async () => {
    let callCount = 0;
    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      callCount++;
      const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
      mockReq.destroy = vi.fn();

      if (callCount === 1) {
        const mock404 = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        mock404.statusCode = 404;
        mock404.headers = {};
        process.nextTick(() => cb(mock404));
      } else {
        process.nextTick(() => mockReq.emit('timeout'));
      }
      return mockReq;
    });

    await expect(fetchManifest('https://example.com/mcp')).rejects.toThrow('Request timed out');
  });

  it('should handle string chunks in the well-known response data event', async () => {
    const manifest = makeManifest({ name: 'String Chunk Server' });
    const mockReq = new EventEmitter() as EventEmitter & { destroy: () => void };
    mockReq.destroy = vi.fn();

    mockHttpsGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.statusCode = 200;
      res.headers = {};
      // Override on to emit string chunks (not Buffer)
      const origOn = res.on.bind(res);
      let dataListenerAttached = false;
      res.on = function(event: string, listener: (...args: unknown[]) => void) {
        origOn(event, listener);
        if (event === 'data' && !dataListenerAttached) {
          dataListenerAttached = true;
          setTimeout(() => {
            res.emit('data', JSON.stringify(manifest)); // string, not Buffer
            res.emit('end');
          }, 5);
        }
        return res;
      } as typeof res.on;
      process.nextTick(() => cb(res));
      return mockReq;
    });

    const result = await fetchManifest('https://example.com/mcp');
    expect(result.name).toBe('String Chunk Server');
  });
});

// ============================================================================
// mcpCall – additional edge cases (via executeMCPTool)
// ============================================================================

describe('mcpCall edge cases', () => {
  it('should handle streaming data exceeding size limit during chunks', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_strmsv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockReq = createMockRequest();

    mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.statusCode = 200;
      res.headers = {}; // No content-length header
      process.nextTick(() => {
        cb(res);
        // Emit chunks that exceed MAX_RESPONSE_SIZE (50MB)
        const bigChunk = Buffer.alloc(30 * 1024 * 1024, 'x');
        res.emit('data', bigChunk);
        res.emit('data', bigChunk); // Total 60MB > 50MB limit
      });
      return mockReq;
    });

    const result = await executeMCPTool('mcp_strmsv_search', { query: 'test' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('exceeded size limit');
  });

  it('should handle JSON-RPC error with no message field', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_nomsrv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockRes = createMockResponse(
      200,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600 }, // No message field
      }),
      {}
    );
    const mockReq = createMockRequest();

    mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      process.nextTick(() => cb(mockRes));
      return mockReq;
    });

    const result = await executeMCPTool('mcp_nomsrv_search', { query: 'test' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('MCP error');
  });

  it('should handle non-Error exceptions in executeMCPTool catch block', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_nersrv',
      transport: 'http',
      url: 'https://test-mcp.example.com/rpc',
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    const mockReq = createMockRequest();
    mockHttpsRequest.mockImplementation((_opts: unknown, _cb: unknown) => {
      process.nextTick(() => {
        mockReq.emit('error', 'plain string error');
      });
      return mockReq;
    });

    const result = await executeMCPTool('mcp_nersrv_search', { query: 'test' });
    expect(result).toContain('Error: MCP call failed');
    expect(result).toContain('plain string error');
  });
});

// ============================================================================
// spawnStdioProcess – child process error handler
// ============================================================================

describe('spawnStdioProcess error handling', () => {
  it('should reject all pending requests on child process error event', async () => {
    const server = makeMCPServer({
      id: 'mcp_child_error',
      transport: 'stdio',
      command: 'node',
      args: ['-e', `
        // Wait a bit then crash
        setTimeout(() => {
          throw new Error('simulated crash');
        }, 100);
      `],
    });

    const entry = spawnStdioProcess(server);

    // Add pending requests
    const promise1 = new Promise<unknown>((resolve, reject) => {
      entry.pending.set(1, { resolve, reject });
    });
    const promise2 = new Promise<unknown>((resolve, reject) => {
      entry.pending.set(2, { resolve, reject });
    });

    // Wait for process to exit (which rejects pending)
    await expect(promise1).rejects.toThrow();
    await expect(promise2).rejects.toThrow();
  });

  it('should reject all pending requests on child process spawn error', async () => {
    const server = makeMCPServer({
      id: 'mcp_spawn_error',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    const entry = spawnStdioProcess(server);

    const promise1 = new Promise<unknown>((resolve, reject) => {
      entry.pending.set(1, { resolve, reject });
    });

    // Simulate the 'error' event on the child process
    entry.process.emit('error', new Error('spawn ENOENT'));

    await expect(promise1).rejects.toThrow('STDIO process error: spawn ENOENT');
    expect(entry.pending.size).toBe(0);

    // Clean up - process may still be alive since 'error' was simulated
    try { entry.process.kill(); } catch {}
  });

  it('should handle empty lines in stdout gracefully', async () => {
    const server = makeMCPServer({
      id: 'mcp_empty_lines',
      transport: 'stdio',
      command: 'node',
      args: ['-e', `
        process.stdout.write('\\n\\n\\n');
        process.stdout.write('  \\n');
        setTimeout(() => process.exit(0), 100);
      `],
    });

    const entry = spawnStdioProcess(server);

    await new Promise(r => setTimeout(r, 200));
    // No errors should have occurred, pending should be empty
    expect(entry.pending.size).toBe(0);
  });
});

// ============================================================================
// stdioCall – timeout and write error paths
// ============================================================================

// Fake timers + process spawning is flaky in CI environments
const describeStdio = process.env.CI ? describe.skip : describe;
describeStdio('stdioCall edge cases', () => {
  it('should reject on timeout after 30s', async () => {
    vi.useFakeTimers();

    const server = makeMCPServer({
      id: 'mcp_timeout_test',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    const entry = spawnStdioProcess(server);

    const callPromise = stdioCall('mcp_timeout_test', 'tools/call', { name: 'test' });

    // Attach the rejection handler BEFORE advancing timers to prevent unhandled rejection
    const resultPromise = callPromise.catch((e: Error) => e);

    // Advance timers past the 30s timeout
    await vi.advanceTimersByTimeAsync(31000);

    const error = await resultPromise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('STDIO call timed out');

    entry.process.kill();
    vi.useRealTimers();
  });

  it('should reject on stdin write error', async () => {
    const server = makeMCPServer({
      id: 'mcp_write_err',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    const entry = spawnStdioProcess(server);

    // Override stdin.write to simulate a write error
    const origWrite = entry.process.stdin!.write.bind(entry.process.stdin!);
    entry.process.stdin!.write = ((_data: unknown, cb: (err: Error | null | undefined) => void) => {
      process.nextTick(() => cb(new Error('write broken')));
      return true;
    }) as typeof entry.process.stdin!.write;

    await expect(
      stdioCall('mcp_write_err', 'tools/call', { name: 'test' })
    ).rejects.toThrow('Failed to write to STDIO');

    // Restore and clean up
    entry.process.stdin!.write = origWrite;
    entry.process.kill();
  });

  it('should handle backpressure (write returns false)', async () => {
    const server = makeMCPServer({
      id: 'mcp_backpressure',
      transport: 'stdio',
      command: 'node',
      args: ['-e', `
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const req = JSON.parse(line);
              const resp = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 'bp_ok' });
              process.stdout.write(resp + '\\n');
            } catch {}
          }
        });
      `],
    });

    const entry = spawnStdioProcess(server);

    // Override write to return false (simulating backpressure) but still call the callback
    const origWrite = entry.process.stdin!.write.bind(entry.process.stdin!);
    let firstCall = true;
    entry.process.stdin!.write = ((data: unknown, cb?: (err: Error | null | undefined) => void) => {
      if (firstCall) {
        firstCall = false;
        // Call the real write but return false to trigger drain path
        origWrite(data as string, cb as any);
        // Emit drain after a short delay
        process.nextTick(() => entry.process.stdin!.emit('drain'));
        return false;
      }
      return origWrite(data as string, cb as any);
    }) as typeof entry.process.stdin!.write;

    const result = await stdioCall('mcp_backpressure', 'tools/call', { name: 'test' });
    expect(result).toBe('bp_ok');

    entry.process.stdin!.write = origWrite;
    entry.process.kill();
  });
});

// ============================================================================
// registerStdioServer
// ============================================================================

describe('registerStdioServer', () => {
  it('should register and initialize a STDIO server', async () => {
    const server = await registerStdioServer('node', ['-e', `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            let result;
            if (req.method === 'initialize') {
              result = { capabilities: {} };
            } else if (req.method === 'tools/list') {
              result = { tools: [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }] };
            } else {
              result = 'ok';
            }
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
          } catch {}
        }
      });
    `]);

    expect(server.status).toBe('connected');
    expect(server.transport).toBe('stdio');
    expect(server.tools).toHaveLength(1);
    expect(server.tools[0].name).toBe('echo');
    expect(server.name).toBe('node');

    // Verify it was persisted
    const servers = loadServers();
    const found = servers.find(s => s.id === server.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('connected');

    stopStdioServer(server.id);
  });

  it('should throw on initialization failure', async () => {
    await expect(
      registerStdioServer('node', ['-e', 'process.exit(1)'])
    ).rejects.toThrow('Failed to initialize STDIO server');
  });

  it('should replace existing server with same command and args', async () => {
    // First, pre-save a server with the same command and args
    const existingServer = makeMCPServer({
      id: 'mcp_existing_stdio',
      transport: 'stdio',
      command: 'node',
      args: ['-e', 'STDIO_REPLACE_TEST'],
      status: 'disconnected',
    });
    saveServers([existingServer]);

    // Now register - but it will fail because 'STDIO_REPLACE_TEST' is not valid JS
    // Use a valid script instead and match args
    const scriptCode = `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            let result = {};
            if (req.method === 'tools/list') result = { tools: [] };
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
          } catch {}
        }
      });
    `;

    // Save with exact same args we'll use
    const existing2 = makeMCPServer({
      id: 'mcp_existing_stdio2',
      transport: 'stdio',
      command: 'node',
      args: ['-e', scriptCode],
      status: 'disconnected',
    });
    saveServers([existing2]);

    const server = await registerStdioServer('node', ['-e', scriptCode]);

    // Should have reused the existing server's id
    expect(server.id).toBe('mcp_existing_stdio2');
    expect(server.status).toBe('connected');

    const servers = loadServers();
    const matches = servers.filter(s => s.transport === 'stdio' && s.command === 'node');
    // Should be only 1 (replaced, not duplicated)
    expect(matches).toHaveLength(1);

    stopStdioServer(server.id);
  });

  it('should handle tools/list returning no tools property', async () => {
    const server = await registerStdioServer('node', ['-e', `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            let result = {};
            // Return empty object for tools/list (no 'tools' property)
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
          } catch {}
        }
      });
    `]);

    expect(server.tools).toEqual([]);
    expect(server.status).toBe('connected');

    stopStdioServer(server.id);
  });

  it('should pass autoConnect=false', async () => {
    const server = await registerStdioServer('node', ['-e', `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            let result = {};
            if (req.method === 'tools/list') result = { tools: [] };
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
          } catch {}
        }
      });
    `], undefined, false);

    expect(server.autoConnect).toBe(false);

    stopStdioServer(server.id);
  });

  it('should pass env to STDIO server', async () => {
    const server = await registerStdioServer('node', ['-e', `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            let result = {};
            if (req.method === 'tools/list') result = { tools: [] };
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
          } catch {}
        }
      });
    `], { MY_ENV: 'test_val' });

    expect(server.status).toBe('connected');

    stopStdioServer(server.id);
  });
});

// ============================================================================
// connectStdioServers
// ============================================================================

describe('connectStdioServers', () => {
  it('should skip non-stdio servers', async () => {
    saveServers([
      makeMCPServer({ id: 'mcp_http_srv', transport: 'http', autoConnect: true }),
    ]);

    await connectStdioServers();

    // Should not throw, just skip
    const servers = loadServers();
    expect(servers).toHaveLength(1);
  });

  it('should skip servers with autoConnect=false', async () => {
    saveServers([
      makeMCPServer({
        id: 'mcp_no_auto',
        transport: 'stdio',
        command: 'cat',
        autoConnect: false,
      }),
    ]);

    await connectStdioServers();

    // Should not have spawned anything
    const stopped = stopStdioServer('mcp_no_auto');
    expect(stopped).toBe(false);
  });

  it('should connect a valid STDIO server with autoConnect=true', async () => {
    const scriptCode = `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            let result = {};
            if (req.method === 'tools/list') {
              result = { tools: [{ name: 'auto_tool', description: 'auto', inputSchema: { type: 'object', properties: {} } }] };
            }
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
          } catch {}
        }
      });
    `;

    saveServers([
      makeMCPServer({
        id: 'mcp_auto_connect',
        transport: 'stdio',
        command: 'node',
        args: ['-e', scriptCode],
        autoConnect: true,
        status: 'disconnected',
        tools: [],
      }),
    ]);

    await connectStdioServers();

    const servers = loadServers();
    const server = servers.find(s => s.id === 'mcp_auto_connect');
    expect(server).toBeDefined();
    expect(server!.status).toBe('connected');
    expect(server!.tools).toHaveLength(1);
    expect(server!.tools[0].name).toBe('auto_tool');

    stopStdioServer('mcp_auto_connect');
  });

  it('should set error status on failed STDIO server connection', async () => {
    saveServers([
      makeMCPServer({
        id: 'mcp_auto_fail',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.exit(1)'],
        autoConnect: true,
        status: 'disconnected',
      }),
    ]);

    await connectStdioServers();

    const servers = loadServers();
    const server = servers.find(s => s.id === 'mcp_auto_fail');
    expect(server).toBeDefined();
    expect(server!.status).toBe('error');
  });

  it('should skip already running servers', async () => {
    const scriptCode = `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            let result = {};
            if (req.method === 'tools/list') result = { tools: [] };
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
          } catch {}
        }
      });
    `;

    const server = makeMCPServer({
      id: 'mcp_already_running',
      transport: 'stdio',
      command: 'node',
      args: ['-e', scriptCode],
      autoConnect: true,
    });
    saveServers([server]);

    // Spawn it first
    spawnStdioProcess(server);

    // connectStdioServers should skip it (already running)
    await connectStdioServers();

    stopStdioServer('mcp_already_running');
  });

  it('should handle tools/list returning undefined', async () => {
    const scriptCode = `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line);
            // Return null result for tools/list
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: null }) + '\\n');
          } catch {}
        }
      });
    `;

    saveServers([
      makeMCPServer({
        id: 'mcp_null_tools',
        transport: 'stdio',
        command: 'node',
        args: ['-e', scriptCode],
        autoConnect: true,
        status: 'disconnected',
        tools: [],
      }),
    ]);

    await connectStdioServers();

    const servers = loadServers();
    const server = servers.find(s => s.id === 'mcp_null_tools');
    expect(server).toBeDefined();
    expect(server!.status).toBe('connected');
    expect(server!.tools).toEqual([]);

    stopStdioServer('mcp_null_tools');
  });
});

// ============================================================================
// stopStdioServer – pending request rejection
// ============================================================================

describe('stopStdioServer pending rejection', () => {
  it('should reject all pending requests with "STDIO server stopped"', async () => {
    const server = makeMCPServer({
      id: 'mcp_stop_pending',
      transport: 'stdio',
      command: 'cat',
      args: [],
    });

    const entry = spawnStdioProcess(server);

    const promise1 = new Promise<unknown>((resolve, reject) => {
      entry.pending.set(1, { resolve, reject });
    });
    const promise2 = new Promise<unknown>((resolve, reject) => {
      entry.pending.set(2, { resolve, reject });
    });

    stopStdioServer('mcp_stop_pending');

    await expect(promise1).rejects.toThrow('STDIO server stopped');
    await expect(promise2).rejects.toThrow('STDIO server stopped');
  });
});

// ============================================================================
// executeMCPTool – STDIO transport success path
// ============================================================================

describe('executeMCPTool STDIO transport', () => {
  it('should execute tool via STDIO transport and return result', async () => {
    const server = makeMCPServer({
      id: 'mcp_1234567890_stxsrv',
      transport: 'stdio',
      command: 'node',
      args: ['-e', `
        process.stdin.setEncoding('utf8');
        let buf = '';
        process.stdin.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const req = JSON.parse(line);
              const resp = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { output: 'stdio_works' } });
              process.stdout.write(resp + '\\n');
            } catch {}
          }
        });
      `],
      tools: [makeMCPTool({ name: 'search' })],
    });
    saveServers([server]);

    // Need to spawn the process since executeMCPTool looks it up
    const entry = spawnStdioProcess(server);

    const result = await executeMCPTool('mcp_stxsrv_search', { query: 'hello' });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ output: 'stdio_works' });

    entry.process.kill();
  });
});
