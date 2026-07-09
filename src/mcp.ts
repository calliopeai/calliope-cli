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
import * as net from 'net';
import * as dns from 'dns';
import { spawn, type ChildProcess } from 'child_process';
import type { Tool } from './types.js';
import { expandEnvMap } from './env-expansion.js';

// MCP storage directory
const MCP_DIR = path.join(os.homedir(), '.calliope-cli', 'mcp');

// Maximum response body sizes
const MAX_MANIFEST_SIZE = 10 * 1024 * 1024;  // 10MB for manifests
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024;  // 50MB for tool results

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
  transport: 'http' | 'stdio';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
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

interface StdioProcess {
  process: ChildProcess;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
  nextId: number;
}

const stdioProcesses = new Map<string, StdioProcess>();

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
// SSRF / network egress guards
// ============================================================================

/**
 * Whether private/loopback/link-local MCP targets are explicitly opted in.
 * Set MCP_ALLOW_PRIVATE_HOSTS=1 (or true) to allow them.
 */
function privateHostsAllowed(): boolean {
  const v = (process.env.MCP_ALLOW_PRIVATE_HOSTS || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Whether loopback MCP targets (localhost / 127.0.0.0/8 / ::1) are blocked.
 * Off by default — local MCP servers are the common legitimate case.
 * Set MCP_BLOCK_LOOPBACK=1 to disallow loopback targets too.
 */
function loopbackBlocked(): boolean {
  const v = (process.env.MCP_BLOCK_LOOPBACK || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Whether a spawned stdio MCP server may inherit the full parent environment.
 * Off by default to avoid leaking API keys/tokens to arbitrary commands.
 */
function inheritEnvAllowed(): boolean {
  const v = (process.env.MCP_STDIO_INHERIT_ENV || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Whether stdio MCP servers may be spawned without an explicit consent flag.
 * Off by default: callers must pass { allowSpawn: true } after surfacing the
 * exact command + args to the user.
 */
function autoSpawnAllowed(): boolean {
  const v = (process.env.MCP_ALLOW_STDIO_SPAWN || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Return true if a resolved IP address is loopback, link-local, private
 * (RFC1918 / ULA), unique-local, or otherwise non-routable / metadata.
 */
function isLoopbackAddress(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return /^127\./.test(ip);
  if (type === 6) return ip.toLowerCase() === '::1';
  return false;
}

function isBlockedAddress(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) {
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    // net.isIP(ip) === 4 guarantees exactly four numeric octets.
    const a = parts[0]!;
    const b = parts[1]!;
    // Loopback (127/8) is allowed by default — see assertUrlAllowed.
    if (a === 10) return true;                          // private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // private 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // private 192.168.0.0/16
    if (a === 169 && b === 254) return true;            // link-local / metadata 169.254.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT 100.64.0.0/10
    if (a === 0) return true;                           // 0.0.0.0/8
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::') return true;                            // unspecified (::1 loopback allowed)
    if (lower.startsWith('fe80')) return true;                  // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — recurse on the embedded v4
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return false;
  }
  // Not an IP literal — treat as unknown/unsafe.
  return true;
}

/**
 * Validate an MCP target URL against SSRF rules. Rejects non-http(s) schemes
 * and (unless opted in) loopback / link-local / private / metadata hosts.
 * Resolves DNS and re-checks every resolved address to defeat DNS rebinding.
 *
 * @returns the validated URL host info (no-op if allowed)
 * @throws if the scheme is unsupported or the host is blocked
 */
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid MCP URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported MCP URL scheme: ${url.protocol} (only http/https allowed)`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const lowerHost = host.toLowerCase();

  // Loopback / local MCP servers are allowed by default — running a local MCP
  // server on localhost is the common, legitimate case. Set MCP_BLOCK_LOOPBACK=1
  // to disallow it. The link-local cloud-metadata range and other private
  // ranges remain blocked (the real SSRF target) unless MCP_ALLOW_PRIVATE_HOSTS=1.
  const isLoopbackName = lowerHost === 'localhost' || lowerHost.endsWith('.localhost');
  if (isLoopbackName || isLoopbackAddress(host)) {
    if (!loopbackBlocked()) return;
    throw new Error(`MCP target ${host} is a loopback address (blocked by MCP_BLOCK_LOOPBACK)`);
  }

  if (privateHostsAllowed()) return;

  // Literal IP — check directly.
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`MCP target ${host} is a private/link-local address (blocked; set MCP_ALLOW_PRIVATE_HOSTS=1 to override)`);
    }
    return;
  }

  // Resolve and validate every address (anti-DNS-rebinding).
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch (e) {
    throw new Error(`Failed to resolve MCP host ${host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`MCP host ${host} resolves to blocked address ${address} (set MCP_ALLOW_PRIVATE_HOSTS=1 to override)`);
    }
  }
}

// ============================================================================
// MCP Client
// ============================================================================

/**
 * Fetch MCP manifest from a URL
 */
export async function fetchManifest(url: string): Promise<MCPManifest> {
  await assertUrlAllowed(url);
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
          // Check Content-Length if available
          const contentLength = parseInt(rootRes.headers['content-length'] || '0', 10);
          if (contentLength > MAX_MANIFEST_SIZE) {
            rootReq.destroy();
            reject(new Error(`MCP manifest too large: ${contentLength} bytes (max ${MAX_MANIFEST_SIZE})`));
            return;
          }

          let data = '';
          let dataSize = 0;
          rootRes.on('data', (chunk: Buffer | string) => {
            dataSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
            if (dataSize > MAX_MANIFEST_SIZE) {
              rootReq.destroy();
              reject(new Error(`MCP manifest exceeded size limit of ${MAX_MANIFEST_SIZE} bytes`));
              return;
            }
            data += chunk;
          });
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

      // Check Content-Length if available
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      if (contentLength > MAX_MANIFEST_SIZE) {
        req.destroy();
        reject(new Error(`MCP manifest too large: ${contentLength} bytes (max ${MAX_MANIFEST_SIZE})`));
        return;
      }

      let data = '';
      let dataSize = 0;
      res.on('data', (chunk: Buffer | string) => {
        dataSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (dataSize > MAX_MANIFEST_SIZE) {
          req.destroy();
          reject(new Error(`MCP manifest exceeded size limit of ${MAX_MANIFEST_SIZE} bytes`));
          return;
        }
        data += chunk;
      });
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
    transport: 'http',
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

  const serverId = match[1]!;
  const mcpToolName = match[2]!;
  const servers = loadServers();
  const server = servers.find(s => s.id.endsWith(serverId));

  if (!server) {
    return `Error: MCP server not found for tool: ${toolName}`;
  }

  // Make RPC call to server
  try {
    let result: unknown;
    if (server.transport === 'stdio') {
      result = await stdioCall(server.id, 'tools/call', {
        name: mcpToolName,
        arguments: args,
      });
    } else {
      result = await mcpCall(server.url, 'tools/call', {
        name: mcpToolName,
        arguments: args,
      });
    }
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
  await assertUrlAllowed(serverUrl);
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
      // Check Content-Length if available
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      if (contentLength > MAX_RESPONSE_SIZE) {
        req.destroy();
        reject(new Error(`MCP response too large: ${contentLength} bytes (max ${MAX_RESPONSE_SIZE})`));
        return;
      }

      let data = '';
      let dataSize = 0;
      res.on('data', (chunk: Buffer | string) => {
        dataSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        if (dataSize > MAX_RESPONSE_SIZE) {
          req.destroy();
          reject(new Error(`MCP response exceeded size limit of ${MAX_RESPONSE_SIZE} bytes`));
          return;
        }
        data += chunk;
      });
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

  const server = servers[index]!;

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

// ============================================================================
// STDIO Transport
// ============================================================================

/**
 * Options controlling how a stdio MCP server is spawned.
 */
export interface SpawnStdioOptions {
  /**
   * Explicit user consent to execute the (arbitrary) command. Spawning is
   * refused unless this is true or MCP_ALLOW_STDIO_SPAWN is set. Callers MUST
   * surface the exact command + args to the user before passing true.
   */
  allowSpawn?: boolean;
}

/**
 * Minimal env passed through to stdio MCP children when the full parent
 * environment is not inherited. Excludes secrets (API keys/tokens).
 */
const STDIO_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'TERM'];

function buildStdioEnv(serverEnv: Record<string, string>): NodeJS.ProcessEnv {
  if (inheritEnvAllowed()) {
    return { ...process.env, ...serverEnv };
  }
  const base: NodeJS.ProcessEnv = {};
  for (const key of STDIO_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
  }
  return { ...base, ...serverEnv };
}

/**
 * Spawn a child process for a STDIO MCP server.
 *
 * Spawning is gated: a stdio command is arbitrary local code execution, so the
 * caller must pass { allowSpawn: true } (after showing the command to the user)
 * or set MCP_ALLOW_STDIO_SPAWN. By default the child does NOT inherit the full
 * parent environment (see MCP_STDIO_INHERIT_ENV).
 */
export function spawnStdioProcess(server: MCPServer, options: SpawnStdioOptions = {}): StdioProcess {
  if (!server.command) {
    throw new Error(`STDIO server ${server.id} has no command configured`);
  }

  if (!options.allowSpawn && !autoSpawnAllowed()) {
    throw new Error(
      `Refusing to spawn stdio MCP server without consent: ${server.command} ${(server.args || []).join(' ')}`.trim() +
      ` (pass allowSpawn or set MCP_ALLOW_STDIO_SPAWN=1 after reviewing the command)`
    );
  }

  const { expanded: serverEnv, missing } = expandEnvMap(server.env);
  if (missing.length > 0) {
    throw new Error(`STDIO server ${server.id} is missing environment variables: ${missing.join(', ')}`);
  }

  const child = spawn(server.command, server.args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildStdioEnv(serverEnv),
  });

  const entry: StdioProcess = {
    process: child,
    pending: new Map(),
    buffer: '',
    nextId: 1,
  };

  child.stdout!.on('data', (chunk: Buffer) => {
    entry.buffer += chunk.toString();
    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = entry.buffer.indexOf('\n')) !== -1) {
      const line = entry.buffer.slice(0, newlineIdx).trim();
      entry.buffer = entry.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && entry.pending.has(msg.id)) {
          const { resolve, reject } = entry.pending.get(msg.id)!;
          entry.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || 'STDIO MCP error'));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines (e.g. debug output)
      }
    }
  });

  child.on('error', (err: Error) => {
    // Reject all pending requests
    for (const [, { reject }] of entry.pending) {
      reject(new Error(`STDIO process error: ${err.message}`));
    }
    entry.pending.clear();
  });

  child.on('exit', (code: number | null) => {
    // Reject all pending requests
    for (const [, { reject }] of entry.pending) {
      reject(new Error(`STDIO process exited with code ${code}`));
    }
    entry.pending.clear();
    stdioProcesses.delete(server.id);
  });

  stdioProcesses.set(server.id, entry);
  return entry;
}

/**
 * Send a JSON-RPC call over STDIO to a running MCP server process
 */
export async function stdioCall(
  serverId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const entry = stdioProcesses.get(serverId);
  if (!entry) {
    throw new Error(`No running STDIO process for server ${serverId}`);
  }

  const id = entry.nextId++;
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });

  return new Promise<unknown>((resolve, reject) => {
    // Wrap resolve/reject to clear the timeout on settlement
    const timer = setTimeout(() => {
      if (entry.pending.has(id)) {
        entry.pending.delete(id);
        reject(new Error('STDIO call timed out'));
      }
    }, 30000);

    entry.pending.set(id, {
      resolve: (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    const ok = entry.process.stdin!.write(request + '\n', (err) => {
      if (err) {
        clearTimeout(timer);
        entry.pending.delete(id);
        reject(new Error(`Failed to write to STDIO: ${err.message}`));
      }
    });

    if (!ok) {
      // Backpressure - wait for drain
      entry.process.stdin!.once('drain', () => {
        // Already written via callback above, just waiting for response
      });
    }
  });
}

/**
 * Register and start a STDIO MCP server
 */
export async function registerStdioServer(
  command: string,
  args?: string[],
  env?: Record<string, string>,
  autoConnect = true,
  options: SpawnStdioOptions = {}
): Promise<MCPServer> {
  const server: MCPServer = {
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: command,
    url: '',
    tools: [],
    status: 'disconnected',
    autoConnect,
    transport: 'stdio',
    command,
    args,
    env,
  };

  // Spawn and initialize (gated on explicit consent — see spawnStdioProcess)
  spawnStdioProcess(server, options);

  try {
    // Send initialize
    await stdioCall(server.id, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'calliope-cli', version: '0.8.20' },
    });

    // Discover tools
    const toolsResult = await stdioCall(server.id, 'tools/list', {}) as
      { tools?: MCPTool[] } | undefined;
    const tools = (toolsResult && toolsResult.tools) ? toolsResult.tools : [];

    server.tools = tools;
    server.status = 'connected';
    server.lastConnected = new Date().toISOString();

    // Use the command basename as name if we got one from init
    const basename = path.basename(command);
    server.name = basename;
  } catch (e) {
    server.status = 'error';
    stopStdioServer(server.id);
    throw new Error(`Failed to initialize STDIO server: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Persist
  const servers = loadServers();
  const existing = servers.findIndex(s =>
    s.transport === 'stdio' && s.command === command &&
    JSON.stringify(s.args || []) === JSON.stringify(args || [])
  );
  if (existing >= 0) {
    const oldId = server.id;
    server.id = servers[existing]!.id;
    // Move the process entry from the temporary id to the persisted id
    const proc = stdioProcesses.get(oldId);
    if (proc) {
      stdioProcesses.delete(oldId);
      stdioProcesses.set(server.id, proc);
    }
    servers[existing] = server;
  } else {
    servers.push(server);
  }
  saveServers(servers);

  return server;
}

/**
 * Stop a running STDIO MCP server process
 */
export function stopStdioServer(serverId: string): boolean {
  const entry = stdioProcesses.get(serverId);
  if (!entry) return false;

  // Reject all pending
  for (const [, { reject }] of entry.pending) {
    reject(new Error('STDIO server stopped'));
  }
  entry.pending.clear();

  entry.process.kill();
  stdioProcesses.delete(serverId);
  return true;
}

/**
 * Auto-connect all STDIO servers that have autoConnect=true.
 *
 * Persisted stdio servers are arbitrary local commands, so they are NOT spawned
 * on startup unless the caller explicitly consents via { allowSpawn: true } (or
 * MCP_ALLOW_STDIO_SPAWN is set) after reviewing the registered commands. Without
 * consent this is a no-op and the latent auto-spawn path stays disabled.
 */
export async function connectStdioServers(options: SpawnStdioOptions = {}): Promise<void> {
  if (!options.allowSpawn && !autoSpawnAllowed()) {
    return;
  }
  const servers = loadServers();
  for (const server of servers) {
    if (server.transport !== 'stdio' || !server.autoConnect) continue;
    if (stdioProcesses.has(server.id)) continue; // already running

    try {
      spawnStdioProcess(server, options);

      await stdioCall(server.id, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'calliope-cli', version: '0.8.20' },
      });

      // Refresh tools
      const toolsResult = await stdioCall(server.id, 'tools/list', {}) as
        { tools?: MCPTool[] } | undefined;
      const tools = (toolsResult && toolsResult.tools) ? toolsResult.tools : [];

      server.tools = tools;
      server.status = 'connected';
      server.lastConnected = new Date().toISOString();
    } catch {
      server.status = 'error';
      stopStdioServer(server.id);
    }
  }
  saveServers(servers);
}
