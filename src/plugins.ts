/**
 * Calliope CLI - Plugin System
 *
 * Enables community-extensible tools and providers.
 * Plugins are loaded from ~/.calliope-cli/plugins/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Tool, ToolCall, ToolResult } from './types.js';

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

// ============================================================================
// Plugin Manager
// ============================================================================

class PluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private pluginsDir: string;

  constructor() {
    this.pluginsDir = path.join(os.homedir(), '.calliope-cli', 'plugins');
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
   * Load a single plugin by name
   */
  async loadPlugin(name: string): Promise<LoadedPlugin | null> {
    const pluginPath = path.join(this.pluginsDir, name);
    const manifestPath = path.join(pluginPath, 'plugin.json');
    const indexPath = path.join(pluginPath, 'index.js');

    try {
      // Check for manifest
      if (!fs.existsSync(manifestPath)) {
        console.warn(`Plugin ${name}: Missing plugin.json`);
        return null;
      }

      // Read manifest
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginMetadata;

      // Check for entry point
      if (!fs.existsSync(indexPath)) {
        console.warn(`Plugin ${name}: Missing index.js`);
        return null;
      }

      // Dynamic import the plugin
      const pluginModule = await import(indexPath);
      const plugin: Plugin = pluginModule.default || pluginModule;

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
    const [pluginId, toolName] = toolCall.name.split(':');
    
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
    
    if (plugins.length === 0) {
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
      
      lines.push(`${status} ${p.id} v${version}`);
      lines.push(`   ${p.plugin.metadata.description}`);
      if (toolCount > 0) {
        lines.push(`   Tools: ${p.plugin.tools!.map(t => t.name).join(', ')}`);
      }
      if (p.error) {
        lines.push(`   Error: ${p.error}`);
      }
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
