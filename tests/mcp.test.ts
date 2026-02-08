/**
 * Tests for MCP (Model Context Protocol) module
 *
 * Covers: loadServers, saveServers, unregisterServer, getMCPTools,
 * executeMCPTool, listServers, stopStdioServer, stdioCall error paths,
 * and spawnStdioProcess.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// MCP_DIR is evaluated once at module load time as
//   path.join(os.homedir(), '.calliope-cli', 'mcp')
// We must set tmpHome BEFORE the dynamic import so the captured constant
// gets a valid, stable path. We keep tmpHome fixed for the whole file
// and clean the servers.json between tests instead.
const tmpHome: string = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-mcp-init-'));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
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
} = await import('../src/mcp.js');

import type { MCPServer, MCPTool } from '../src/mcp.js';

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

// ============================================================================
// Tests
// ============================================================================

// Clean up the servers file before each test to get a blank slate
beforeEach(() => {
  if (fs.existsSync(SERVERS_FILE)) {
    fs.unlinkSync(SERVERS_FILE);
  }
});

// Clean up the entire tmpHome after all tests
afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

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
      // Remove the MCP dir if it exists from a previous test
      if (fs.existsSync(MCP_DIR)) {
        fs.rmSync(MCP_DIR, { recursive: true, force: true });
      }

      loadServers();
      expect(fs.existsSync(MCP_DIR)).toBe(true);
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
  });
});

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
});

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
});

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
});

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
});

describe('stopStdioServer', () => {
  it('should return false when no process exists for the server id', () => {
    const result = stopStdioServer('nonexistent_server');
    expect(result).toBe(false);
  });
});

describe('stdioCall', () => {
  it('should throw when no running process exists', async () => {
    await expect(
      stdioCall('nonexistent_id', 'tools/call', { name: 'test' })
    ).rejects.toThrow('No running STDIO process for server nonexistent_id');
  });
});

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

    // Clean up the spawned process
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

    // Clean up
    entry.process.kill();
  });
});

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
});
