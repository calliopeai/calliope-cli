/**
 * Calliope CLI - MCP (Model Context Protocol) Support
 *
 * Implements MCP client for connecting to external tool servers.
 * Supports self-registering MCP servers from URLs.
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Tool } from './types.js';

// MCP storage directory
const MCP_DIR = path.join(os.homedir(), '.calliope-cli', 'mcp');

// ============================================================================
// Types
// ============================================================================

export interface MCPServer {
  id: string;
  name: string;
  url: string;
  description?: string;
  tools: MCPTool[];
  status: 'connected' | 'disconnected' | 'error';
  lastConnected?: string;
  autoConnect: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

export interface MCPManifest {
  name: string;
  version: string;
  description?: string;
  tools: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

// ============================================================================
// Storage
// ============================================================================

function ensureMCPDir(): void {
  if (!fs.existsSync(MCP_DIR)) {
    fs.mkdirSync(MCP_DIR, { recursive: true });
  }
}

function getServersFile(): string {
  return path.join(MCP_DIR, 'servers.json');
}

/**
 * Load registered MCP servers
 */
export function loadServers(): MCPServer[] {
  ensureMCPDir();
  const file = getServersFile();
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Save MCP servers
 */
export function saveServers(servers: MCPServer[]): void {
  ensureMCPDir();
  fs.writeFileSync(getServersFile(), JSON.stringify(servers, null, 2));
}

// ============================================================================
// MCP Client
// ============================================================================

/**
 * Fetch MCP manifest from a URL
 */
export async function fetchManifest(url: string): Promise<MCPManifest> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    // Try well-known MCP endpoint first
    const manifestUrl = url.endsWith('/') ? `${url}.well-known/mcp` : `${url}/.well-known/mcp`;

    const req = protocol.get(manifestUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Calliope-CLI/1.0',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode === 404) {
        // Try root URL
        const rootReq = protocol.get(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Calliope-CLI/1.0',
          },
          timeout: 10000,
        }, (rootRes) => {
          let data = '';
          rootRes.on('data', chunk => data += chunk);
          rootRes.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Invalid MCP manifest'));
            }
          });
        });
        rootReq.on('error', reject);
        rootReq.on('timeout', () => {
          rootReq.destroy();
          reject(new Error('Request timed out'));
        });
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid MCP manifest'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Register an MCP server from URL
 */
export async function registerServer(url: string, autoConnect = true): Promise<MCPServer> {
  const manifest = await fetchManifest(url);

  const server: MCPServer = {
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: manifest.name,
    url: url,
    description: manifest.description,
    tools: manifest.tools || [],
    status: 'connected',
    lastConnected: new Date().toISOString(),
    autoConnect,
  };

  const servers = loadServers();
  // Remove existing server with same URL
  const existing = servers.findIndex(s => s.url === url);
  if (existing >= 0) {
    servers[existing] = server;
  } else {
    servers.push(server);
  }
  saveServers(servers);

  return server;
}

/**
 * Unregister an MCP server
 */
export function unregisterServer(idOrUrl: string): boolean {
  const servers = loadServers();
  const index = servers.findIndex(s => s.id === idOrUrl || s.url === idOrUrl);
  if (index >= 0) {
    servers.splice(index, 1);
    saveServers(servers);
    return true;
  }
  return false;
}

/**
 * Get all registered MCP tools as Calliope tools
 */
export function getMCPTools(): Tool[] {
  const servers = loadServers();
  const tools: Tool[] = [];

  for (const server of servers) {
    if (server.status !== 'connected') continue;

    for (const mcpTool of server.tools) {
      tools.push({
        name: `mcp_${server.id.slice(-6)}_${mcpTool.name}`,
        description: `[MCP: ${server.name}] ${mcpTool.description}`,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(mcpTool.inputSchema.properties || {}).map(([key, value]) => [
              key,
              {
                type: value.type,
                description: value.description || key,
                enum: value.enum,
              },
            ])
          ),
          required: mcpTool.inputSchema.required,
        },
      });
    }
  }

  return tools;
}

/**
 * Execute an MCP tool call
 */
export async function executeMCPTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  // Parse tool name to find server and tool
  const match = toolName.match(/^mcp_(\w+)_(.+)$/);
  if (!match) {
    return `Error: Invalid MCP tool name: ${toolName}`;
  }

  const [, serverId, mcpToolName] = match;
  const servers = loadServers();
  const server = servers.find(s => s.id.endsWith(serverId));

  if (!server) {
    return `Error: MCP server not found for tool: ${toolName}`;
  }

  // Make RPC call to server
  try {
    const result = await mcpCall(server.url, 'tools/call', {
      name: mcpToolName,
      arguments: args,
    });
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch (e) {
    return `Error: MCP call failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Make an MCP RPC call
 */
async function mcpCall(
  serverUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(serverUrl);
    const protocol = url.protocol === 'https:' ? https : http;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });

    const req = protocol.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Calliope-CLI/1.0',
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.error) {
            reject(new Error(response.error.message || 'MCP error'));
          } else {
            resolve(response.result);
          }
        } catch (e) {
          reject(new Error('Invalid MCP response'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * List all registered servers
 */
export function listServers(): MCPServer[] {
  return loadServers();
}

/**
 * Refresh server connection status
 */
export async function refreshServer(idOrUrl: string): Promise<MCPServer | null> {
  const servers = loadServers();
  const index = servers.findIndex(s => s.id === idOrUrl || s.url === idOrUrl);

  if (index < 0) return null;

  const server = servers[index];

  try {
    const manifest = await fetchManifest(server.url);
    server.tools = manifest.tools || [];
    server.status = 'connected';
    server.lastConnected = new Date().toISOString();
  } catch {
    server.status = 'error';
  }

  saveServers(servers);
  return server;
}
