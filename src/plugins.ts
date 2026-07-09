/**
 * Calliope CLI - Plugin System
 *
 * Enables community-extensible tools and providers.
 * Plugins are loaded from ~/.calliope-cli/plugins/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { Tool, ToolCall, ToolResult } from './types.js';
import * as config from './config.js';
import { auditIntegrityViolation } from './runlog.js';

/** Short, human-comparable fingerprint of a full sha256 hex digest (#137). */
function fingerprint(hash: string): string {
  return `sha256:${hash.slice(0, 12)}`;
}

/** Blanket local-dev mode via env: exempts every plugin from hash pinning (#137). */
function isPluginDevEnvEnabled(): boolean {
  const v = process.env.CALLIOPE_PLUGIN_DEV;
  return v === '1' || v === 'true' || v === 'yes';
}

// ============================================================================
// Types
// ============================================================================

export interface PluginMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  license?: string;
}

export interface PluginTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>, cwd: string) => Promise<string>;
}

export interface PluginHook {
  event: 'pre-tool' | 'post-tool' | 'session-start' | 'session-end';
  handler: (context: Record<string, unknown>) => Promise<void>;
}

export interface Plugin {
  metadata: PluginMetadata;
  tools?: PluginTool[];
  hooks?: PluginHook[];
  init?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

export interface LoadedPlugin {
  id: string;
  path: string;
  plugin: Plugin;
  enabled: boolean;
  loadedAt: Date;
  error?: string;
}

/**
 * Confirmation request shown before a plugin's code is imported/executed (#137).
 * `reason` distinguishes a first-time load (TOFU) from a changed entry file.
 */
export interface PluginTrustConfirmation {
  name: string;
  path: string;
  version: string;
  description: string;
  reason: 'first-load' | 'entry-file-changed';
}

/**
 * Trust state of an installed plugin's entry file relative to its pinned hash (#137).
 *  - `pinned`     — index.js matches the recorded hash.
 *  - `changed`    — hash recorded but index.js no longer matches (refused at load).
 *  - `unverified` — no hash recorded yet.
 *  - `dev`        — user-exempted local dev plugin (not pinned by design).
 */
export type PluginTrust = 'pinned' | 'changed' | 'unverified' | 'dev';

// ============================================================================
// Plugin Manager
// ============================================================================

class PluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private pluginsDir: string;
  // Optional trust prompt invoked before importing/executing plugin code (#137).
  private trustConfirmHandler: ((info: PluginTrustConfirmation) => boolean | Promise<boolean>) | null = null;

  constructor() {
    this.pluginsDir = path.join(os.homedir(), '.calliope-cli', 'plugins');
  }

  /**
   * Register a trust prompt invoked before a plugin is imported/executed (#137).
   * Returning false aborts the load. Pass null to clear.
   */
  setTrustConfirmHandler(
    handler: ((info: PluginTrustConfirmation) => boolean | Promise<boolean>) | null
  ): void {
    this.trustConfirmHandler = handler;
  }

  /**
   * Path to the per-installation plugin trust store (entry-file hashes — #137).
   * Stored inside pluginsDir so it travels with the plugins it describes.
   */
  private getTrustStorePath(): string {
    return path.join(this.pluginsDir, 'trust.json');
  }

  private loadTrustStore(): Record<string, { hash: string }> {
    try {
      const raw = fs.readFileSync(this.getTrustStorePath(), 'utf-8');
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveTrustStore(store: Record<string, { hash: string }>): void {
    try {
      if (!fs.existsSync(this.pluginsDir)) {
        fs.mkdirSync(this.pluginsDir, { recursive: true });
      }
      fs.writeFileSync(this.getTrustStorePath(), JSON.stringify(store, null, 2));
    } catch { /* best-effort */ }
  }

  private hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  /**
   * Whether a plugin is a user-trusted local dev plugin, exempt from entry-file
   * hash pinning (#137). Exemption is ALWAYS a user-side decision — the blanket
   * `CALLIOPE_PLUGIN_DEV` env flag or a `plugins.devTrustLocal` config allowlist.
   * A plugin can never mark itself exempt through its own manifest.
   */
  private isDevTrustExempt(name: string): boolean {
    if (isPluginDevEnvEnabled()) return true;
    try {
      const cfg = config.get('plugins') as { devTrustLocal?: string[] } | undefined;
      return Array.isArray(cfg?.devTrustLocal) && cfg.devTrustLocal.includes(name);
    } catch {
      return false;
    }
  }

  /**
   * Gate a plugin load behind trust-on-first-use + hash re-verification (#137).
   * Returns true if the plugin may be imported/executed.
   *
   * - Dev-exempt (user opt-in): load without pinning.
   * - First time seen: record the hash. If a trust handler is set, ask it;
   *   with no handler, trust-on-first-use (backward compatible).
   * - Seen before, hash matches: allow silently.
   * - Seen before, hash changed: require confirmation. With no handler, refuse
   *   (do not silently run changed code) and audit the refusal.
   */
  private async checkPluginTrust(name: string, indexPath: string, manifest: PluginMetadata): Promise<boolean> {
    // Locally-edited dev plugins the user explicitly trusts are exempt from
    // pinning, so an actively-changing entry file is not re-confirmed on every
    // edit. Never silent: still announce that the plugin is unverified (#137).
    if (this.isDevTrustExempt(name)) {
      console.log(`Plugin ${name}: loaded as trusted-local dev plugin (unverified — hash not pinned)`);
      return true;
    }

    const store = this.loadTrustStore();
    const currentHash = this.hashFile(indexPath);
    const known = store[name];

    if (known && known.hash === currentHash) {
      return true;
    }

    const reason: PluginTrustConfirmation['reason'] = known ? 'entry-file-changed' : 'first-load';

    if (this.trustConfirmHandler) {
      const ok = await this.trustConfirmHandler({
        name,
        path: indexPath,
        version: manifest.version,
        description: manifest.description,
        reason,
      });
      if (!ok) {
        console.warn(`Plugin ${name}: load declined by user`);
        return false;
      }
    } else if (known) {
      // Entry file changed and we cannot prompt — refuse rather than run silently,
      // and record the tamper in the audit trail (#137).
      console.warn(`Plugin ${name}: index.js changed since last load — refusing to load (re-trust required)`);
      auditIntegrityViolation(
        `plugin:${name}`,
        'index.js changed since last trusted load — refusing to load (re-trust required)',
      );
      return false;
    }

    // Pin (or re-pin) the entry file. Surface the fingerprint so both
    // trust-on-first-use and an approved re-trust are visible, never silent.
    if (known) {
      console.log(
        `Plugin ${name}: re-trusted — entry-file fingerprint ${fingerprint(known.hash)} → ${fingerprint(currentHash)}`,
      );
    } else {
      console.log(`Plugin ${name}: trusted on first use — entry-file fingerprint ${fingerprint(currentHash)}`);
    }
    store[name] = { hash: currentHash };
    this.saveTrustStore(store);
    return true;
  }

  /**
   * Trust state of a plugin's entry file relative to its pinned hash (#137), for
   * the listing surface. Reads disk only — never imports plugin code.
   */
  getPluginTrustState(name: string): { trust: PluginTrust; fingerprint?: string } {
    if (this.isDevTrustExempt(name)) return { trust: 'dev' };
    const known = this.loadTrustStore()[name];
    if (!known) return { trust: 'unverified' };
    let current: string | undefined;
    try {
      current = this.hashFile(path.join(this.pluginsDir, name, 'index.js'));
    } catch {
      current = undefined;
    }
    return current === known.hash
      ? { trust: 'pinned', fingerprint: fingerprint(known.hash) }
      : { trust: 'changed', fingerprint: fingerprint(known.hash) };
  }

  /**
   * Names of plugins present on disk whose pinned hash no longer matches their
   * entry file and that are not currently loaded — i.e. refused at load time
   * because the code changed. Surfaced in the listing so a "vanished" plugin is
   * explained rather than silently missing (#137).
   */
  private getChangedPluginDirs(): string[] {
    if (!fs.existsSync(this.pluginsDir)) return [];
    const store = this.loadTrustStore();
    const out: string[] = [];
    for (const entry of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (this.plugins.has(name) || this.isDevTrustExempt(name)) continue;
      const known = store[name];
      if (!known) continue;
      let current: string | undefined;
      try {
        current = this.hashFile(path.join(this.pluginsDir, name, 'index.js'));
      } catch {
        current = undefined;
      }
      if (current !== known.hash) out.push(name);
    }
    return out;
  }

  /**
   * Initialize the plugin system
   */
  async init(): Promise<void> {
    // Ensure plugins directory exists
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }

    // Load all plugins
    await this.loadAllPlugins();
  }

  /**
   * Load all plugins from the plugins directory
   */
  async loadAllPlugins(): Promise<void> {
    if (!fs.existsSync(this.pluginsDir)) return;

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.loadPlugin(entry.name);
      }
    }
  }

  /**
   * Validate a plugin manifest has required fields and correct types
   */
  private validateManifest(manifest: unknown, name: string): manifest is PluginMetadata {
    if (typeof manifest !== 'object' || manifest === null) {
      console.warn(`Plugin ${name}: plugin.json is not a valid object`);
      return false;
    }
    const m = manifest as Record<string, unknown>;
    if (typeof m.name !== 'string' || m.name.length === 0) {
      console.warn(`Plugin ${name}: plugin.json missing required "name" field`);
      return false;
    }
    if (typeof m.version !== 'string' || m.version.length === 0) {
      console.warn(`Plugin ${name}: plugin.json missing required "version" field`);
      return false;
    }
    if (typeof m.description !== 'string') {
      console.warn(`Plugin ${name}: plugin.json missing required "description" field`);
      return false;
    }
    return true;
  }

  /**
   * Validate a loaded plugin module has the expected structure
   */
  private validatePluginExports(plugin: unknown, name: string): plugin is Plugin {
    if (typeof plugin !== 'object' || plugin === null) {
      console.warn(`Plugin ${name}: module does not export an object`);
      return false;
    }
    const p = plugin as Record<string, unknown>;
    // tools must be an array if present
    if (p.tools !== undefined && !Array.isArray(p.tools)) {
      console.warn(`Plugin ${name}: "tools" export must be an array`);
      return false;
    }
    // hooks must be an array if present
    if (p.hooks !== undefined && !Array.isArray(p.hooks)) {
      console.warn(`Plugin ${name}: "hooks" export must be an array`);
      return false;
    }
    // init must be a function if present
    if (p.init !== undefined && typeof p.init !== 'function') {
      console.warn(`Plugin ${name}: "init" export must be a function`);
      return false;
    }
    // cleanup must be a function if present
    if (p.cleanup !== undefined && typeof p.cleanup !== 'function') {
      console.warn(`Plugin ${name}: "cleanup" export must be a function`);
      return false;
    }
    // Validate each tool has required fields
    if (Array.isArray(p.tools)) {
      for (const tool of p.tools) {
        if (typeof tool !== 'object' || tool === null) {
          console.warn(`Plugin ${name}: each tool must be an object`);
          return false;
        }
        const t = tool as Record<string, unknown>;
        if (typeof t.name !== 'string' || typeof t.description !== 'string' || typeof t.execute !== 'function') {
          console.warn(`Plugin ${name}: each tool must have name (string), description (string), and execute (function)`);
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Load a single plugin by name
   */
  async loadPlugin(name: string): Promise<LoadedPlugin | null> {
    const pluginPath = path.join(this.pluginsDir, name);
    const manifestPath = path.join(pluginPath, 'plugin.json');
    const indexPath = path.join(pluginPath, 'index.js');

    try {
      // Validate plugin name (prevent directory traversal)
      if (name.includes('..') || name.includes('/') || name.includes('\\')) {
        console.warn(`Plugin ${name}: invalid plugin name`);
        return null;
      }

      // Check for manifest (required)
      if (!fs.existsSync(manifestPath)) {
        console.warn(`Plugin ${name}: Missing plugin.json manifest — skipping`);
        return null;
      }

      // Read and validate manifest
      let manifestRaw: unknown;
      try {
        manifestRaw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch {
        console.warn(`Plugin ${name}: plugin.json is not valid JSON`);
        return null;
      }

      if (!this.validateManifest(manifestRaw, name)) {
        return null;
      }
      const manifest = manifestRaw as PluginMetadata;

      // Check for entry point — only .js files allowed
      if (!fs.existsSync(indexPath)) {
        console.warn(`Plugin ${name}: Missing index.js`);
        return null;
      }

      // Trust gate: confirm + verify entry-file hash before executing code (#137).
      const trusted = await this.checkPluginTrust(name, indexPath, manifest);
      if (!trusted) {
        return null;
      }

      // Log plugin loading for user awareness
      console.log(`Loading plugin: ${name} v${manifest.version} (${pluginPath})`);

      // Dynamic import the plugin
      const pluginModule = await import(indexPath);
      const pluginCandidate: unknown = pluginModule.default || pluginModule;

      // Validate the plugin exports have expected structure
      if (!this.validatePluginExports(pluginCandidate, name)) {
        return null;
      }
      const plugin = pluginCandidate as Plugin;

      // Merge manifest with plugin
      plugin.metadata = { ...manifest, ...plugin.metadata };

      // Initialize plugin if it has init function
      if (plugin.init) {
        await plugin.init();
      }

      const loaded: LoadedPlugin = {
        id: name,
        path: pluginPath,
        plugin,
        enabled: true,
        loadedAt: new Date(),
      };

      this.plugins.set(name, loaded);
      return loaded;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load plugin ${name}:`, errorMsg);
      
      const failed: LoadedPlugin = {
        id: name,
        path: pluginPath,
        plugin: { metadata: { name, version: '0.0.0', description: 'Failed to load' } },
        enabled: false,
        loadedAt: new Date(),
        error: errorMsg,
      };
      
      this.plugins.set(name, failed);
      return failed;
    }
  }

  /**
   * Unload a plugin
   */
  async unloadPlugin(name: string): Promise<boolean> {
    const loaded = this.plugins.get(name);
    if (!loaded) return false;

    try {
      if (loaded.plugin.cleanup) {
        await loaded.plugin.cleanup();
      }
      this.plugins.delete(name);
      return true;
    } catch (error) {
      console.error(`Failed to unload plugin ${name}:`, error);
      return false;
    }
  }

  /**
   * Enable/disable a plugin
   */
  setPluginEnabled(name: string, enabled: boolean): boolean {
    const loaded = this.plugins.get(name);
    if (!loaded) return false;
    loaded.enabled = enabled;
    return true;
  }

  /**
   * Get all loaded plugins
   */
  getPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get enabled plugins
   */
  getEnabledPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values()).filter(p => p.enabled && !p.error);
  }

  /**
   * Get a specific plugin
   */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all tools from enabled plugins
   */
  getPluginTools(): Tool[] {
    const tools: Tool[] = [];
    
    for (const loaded of this.getEnabledPlugins()) {
      if (loaded.plugin.tools) {
        for (const tool of loaded.plugin.tools) {
          tools.push({
            name: `${loaded.id}:${tool.name}`,
            description: `[${loaded.id}] ${tool.description}`,
            parameters: tool.parameters as Tool['parameters'],
          });
        }
      }
    }
    
    return tools;
  }

  /**
   * Execute a plugin tool
   */
  async executePluginTool(
    toolCall: ToolCall,
    cwd: string
  ): Promise<ToolResult> {
    const [pluginId = '', toolName] = toolCall.name.split(':');
    
    const loaded = this.plugins.get(pluginId);
    if (!loaded || !loaded.enabled) {
      return {
        toolCallId: toolCall.id,
        result: `Plugin not found or disabled: ${pluginId}`,
        isError: true,
      };
    }

    const tool = loaded.plugin.tools?.find(t => t.name === toolName);
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        result: `Tool not found: ${toolName} in plugin ${pluginId}`,
        isError: true,
      };
    }

    try {
      const result = await tool.execute(
        toolCall.arguments as Record<string, unknown>,
        cwd
      );
      return { toolCallId: toolCall.id, result };
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        result: `Plugin tool error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  /**
   * Check if a tool name is a plugin tool
   */
  isPluginTool(name: string): boolean {
    return name.includes(':');
  }

  /**
   * Execute hooks for an event
   */
  async executeHooks(
    event: PluginHook['event'],
    context: Record<string, unknown>
  ): Promise<void> {
    for (const loaded of this.getEnabledPlugins()) {
      if (loaded.plugin.hooks) {
        for (const hook of loaded.plugin.hooks) {
          if (hook.event === event) {
            try {
              await hook.handler(context);
            } catch (error) {
              console.error(`Plugin hook error (${loaded.id}):`, error);
            }
          }
        }
      }
    }
  }

  /**
   * Get plugins directory path
   */
  getPluginsDir(): string {
    return this.pluginsDir;
  }

  /**
   * Create a new plugin scaffold
   */
  createPluginScaffold(name: string): string {
    const pluginPath = path.join(this.pluginsDir, name);
    
    if (fs.existsSync(pluginPath)) {
      throw new Error(`Plugin directory already exists: ${name}`);
    }

    fs.mkdirSync(pluginPath, { recursive: true });

    // Create plugin.json
    const manifest: PluginMetadata = {
      name,
      version: '1.0.0',
      description: `${name} plugin for Calliope CLI`,
      author: 'Your Name',
    };
    fs.writeFileSync(
      path.join(pluginPath, 'plugin.json'),
      JSON.stringify(manifest, null, 2)
    );

    // Create index.js
    const indexContent = `/**
 * ${name} - Calliope CLI Plugin
 */

module.exports = {
  // Plugin tools
  tools: [
    {
      name: 'example',
      description: 'An example tool from ${name} plugin',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'A message to echo',
          },
        },
        required: ['message'],
      },
      execute: async (args, cwd) => {
        return \`[${name}] Echo: \${args.message}\`;
      },
    },
  ],

  // Plugin hooks (optional)
  hooks: [
    // {
    //   event: 'session-start',
    //   handler: async (context) => {
    //     console.log('${name} plugin: Session started');
    //   },
    // },
  ],

  // Called when plugin is loaded (optional)
  init: async () => {
    console.log('${name} plugin initialized');
  },

  // Called when plugin is unloaded (optional)
  cleanup: async () => {
    console.log('${name} plugin cleanup');
  },
};
`;
    fs.writeFileSync(path.join(pluginPath, 'index.js'), indexContent);

    return pluginPath;
  }

  /**
   * Get formatted plugin list for display
   */
  getPluginListFormatted(): string {
    const plugins = this.getPlugins();
    // Plugins whose code changed refuse to load, so they are absent from the
    // loaded set — list them explicitly so the trust state is visible (#137).
    const changed = this.getChangedPluginDirs();

    if (plugins.length === 0 && changed.length === 0) {
      return `No plugins installed.

To create a plugin:
  /plugin create <name>

Plugins directory: ${this.pluginsDir}`;
    }

    const lines = ['Installed Plugins:', ''];

    for (const p of plugins) {
      const status = p.error ? '❌' : p.enabled ? '✅' : '⏸️';
      const version = p.plugin.metadata.version;
      const toolCount = p.plugin.tools?.length || 0;
      const t = this.getPluginTrustState(p.id);
      const trustLabel =
        t.trust === 'pinned' ? t.fingerprint! :
        t.trust === 'dev' ? 'dev, unverified' :
        t.trust.toUpperCase();

      lines.push(`${status} ${p.id} v${version}  [${trustLabel}]`);
      lines.push(`   ${p.plugin.metadata.description}`);
      if (toolCount > 0) {
        lines.push(`   Tools: ${p.plugin.tools!.map(t => t.name).join(', ')}`);
      }
      if (p.error) {
        lines.push(`   Error: ${p.error}`);
      }
      lines.push('');
    }

    for (const name of changed) {
      lines.push(`⚠️  ${name}  [CHANGED]`);
      lines.push('   Entry file changed since it was trusted — refusing to load. Reinstall or re-trust to load again.');
      lines.push('');
    }

    return lines.join('\n');
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const pluginManager = new PluginManager();

// ============================================================================
// Convenience Functions
// ============================================================================

export async function initPlugins(): Promise<void> {
  await pluginManager.init();
}

export function getPluginTools(): Tool[] {
  return pluginManager.getPluginTools();
}

export function isPluginTool(name: string): boolean {
  return pluginManager.isPluginTool(name);
}

export async function executePluginTool(
  toolCall: ToolCall,
  cwd: string
): Promise<ToolResult> {
  return pluginManager.executePluginTool(toolCall, cwd);
}

export function getPluginList(): string {
  return pluginManager.getPluginListFormatted();
}

export function createPlugin(name: string): string {
  return pluginManager.createPluginScaffold(name);
}

export async function reloadPlugins(): Promise<void> {
  await pluginManager.loadAllPlugins();
}

export function enablePlugin(name: string, enabled: boolean): boolean {
  return pluginManager.setPluginEnabled(name, enabled);
}

export function setPluginTrustConfirmHandler(
  handler: ((info: PluginTrustConfirmation) => boolean | Promise<boolean>) | null
): void {
  pluginManager.setTrustConfirmHandler(handler);
}
