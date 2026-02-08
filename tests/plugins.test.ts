/**
 * Tests for plugins module
 *
 * Covers: PluginManager lifecycle (init, loadPlugin, unloadPlugin),
 * plugin tool registration and execution, hooks, enable/disable,
 * scaffold creation, getPluginTools, getPluginListFormatted,
 * isPluginTool, and convenience functions.
 *
 * Uses a temp directory as the plugins dir to avoid touching real ~/.calliope-cli.
 * We patch pluginManager.pluginsDir directly instead of mocking os.homedir(),
 * because the singleton is constructed at module load time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  pluginManager,
  initPlugins,
  getPluginTools,
  isPluginTool,
  executePluginTool,
  getPluginList,
  createPlugin,
  reloadPlugins,
  enablePlugin,
} from '../src/plugins.js';
import type { Plugin, PluginMetadata, LoadedPlugin } from '../src/plugins.js';

// ============================================================================
// Helpers
// ============================================================================

let tmpPluginsDir: string;
let origPluginsDir: string;

function patchPluginsDir(dir: string): void {
  origPluginsDir = (pluginManager as any).pluginsDir;
  (pluginManager as any).pluginsDir = dir;
}

function restorePluginsDir(): void {
  (pluginManager as any).pluginsDir = origPluginsDir;
}

function clearPlugins(): void {
  const map = (pluginManager as any).plugins as Map<string, LoadedPlugin>;
  map.clear();
}

function createPluginDir(name: string, manifest: PluginMetadata, indexContent: string): string {
  const pluginPath = path.join(tmpPluginsDir, name);
  fs.mkdirSync(pluginPath, { recursive: true });

  fs.writeFileSync(
    path.join(pluginPath, 'plugin.json'),
    JSON.stringify(manifest, null, 2)
  );

  fs.writeFileSync(path.join(pluginPath, 'index.js'), indexContent);
  return pluginPath;
}

function createMinimalPlugin(name: string, opts?: { tools?: boolean; hooks?: boolean }): string {
  const manifest: PluginMetadata = {
    name,
    version: '1.0.0',
    description: `Test plugin: ${name}`,
    author: 'Test',
  };

  let toolsBlock = '';
  if (opts?.tools !== false) {
    toolsBlock = `
  tools: [
    {
      name: 'greet',
      description: 'Say hello',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'Name' } }, required: ['name'] },
      execute: async (args) => 'Hello, ' + args.name + '!',
    },
  ],`;
  }

  let hooksBlock = '';
  if (opts?.hooks) {
    hooksBlock = `
  hooks: [
    {
      event: 'session-start',
      handler: async (ctx) => { global.__hookCalled = true; },
    },
  ],`;
  }

  const indexContent = `
module.exports = {
  metadata: { name: '${name}', version: '1.0.0', description: 'loaded' },
  ${toolsBlock}
  ${hooksBlock}
  init: async () => {},
  cleanup: async () => {},
};
`;

  return createPluginDir(name, manifest, indexContent);
}

beforeEach(() => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-plugins-test-'));
  tmpPluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(tmpPluginsDir, { recursive: true });
  patchPluginsDir(tmpPluginsDir);
  clearPlugins();
});

afterEach(() => {
  clearPlugins();
  restorePluginsDir();
  // Clean up tmpPluginsDir's parent
  const tmpRoot = path.dirname(tmpPluginsDir);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// PluginManager.init
// ============================================================================

describe('pluginManager.init', () => {
  it('should create plugins directory if it does not exist', async () => {
    // Remove the directory we created in beforeEach
    fs.rmSync(tmpPluginsDir, { recursive: true, force: true });

    await pluginManager.init();

    expect(fs.existsSync(pluginManager.getPluginsDir())).toBe(true);
  });

  it('should load all plugins from the directory', async () => {
    createMinimalPlugin('alpha');
    createMinimalPlugin('beta');

    await pluginManager.init();

    const plugins = pluginManager.getPlugins();
    expect(plugins.length).toBeGreaterThanOrEqual(2);
    expect(plugins.find(p => p.id === 'alpha')).toBeDefined();
    expect(plugins.find(p => p.id === 'beta')).toBeDefined();
  });

  it('should handle empty plugins directory', async () => {
    await pluginManager.init();
    const plugins = pluginManager.getPlugins();
    expect(plugins).toEqual([]);
  });
});

// ============================================================================
// loadPlugin
// ============================================================================

describe('pluginManager.loadPlugin', () => {
  it('should load a valid plugin', async () => {
    createMinimalPlugin('valid-plugin');

    const loaded = await pluginManager.loadPlugin('valid-plugin');

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('valid-plugin');
    expect(loaded!.enabled).toBe(true);
    expect(loaded!.error).toBeUndefined();
  });

  it('should return null for plugin without plugin.json', async () => {
    const pluginPath = path.join(tmpPluginsDir, 'no-manifest');
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'index.js'), 'module.exports = {};');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = await pluginManager.loadPlugin('no-manifest');
    warnSpy.mockRestore();

    expect(loaded).toBeNull();
  });

  it('should return null for plugin without index.js', async () => {
    const pluginPath = path.join(tmpPluginsDir, 'no-index');
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(
      path.join(pluginPath, 'plugin.json'),
      JSON.stringify({ name: 'no-index', version: '1.0.0', description: 'missing entry' })
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = await pluginManager.loadPlugin('no-index');
    warnSpy.mockRestore();

    expect(loaded).toBeNull();
  });

  it('should handle plugin that throws during import', async () => {
    const manifest: PluginMetadata = {
      name: 'broken',
      version: '1.0.0',
      description: 'This plugin throws',
    };
    createPluginDir('broken', manifest, 'throw new Error("boom");');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = await pluginManager.loadPlugin('broken');
    errorSpy.mockRestore();

    expect(loaded).not.toBeNull();
    expect(loaded!.enabled).toBe(false);
    expect(loaded!.error).toBeDefined();
    expect(loaded!.error).toContain('boom');
  });

  it('should call plugin init function if present', async () => {
    const manifest: PluginMetadata = {
      name: 'with-init',
      version: '1.0.0',
      description: 'Has init',
    };
    createPluginDir('with-init', manifest, `
      module.exports = {
        metadata: { name: 'with-init', version: '1.0.0', description: 'Has init' },
        init: async () => { global.__pluginInitCalled = true; },
      };
    `);

    (global as any).__pluginInitCalled = false;
    await pluginManager.loadPlugin('with-init');
    expect((global as any).__pluginInitCalled).toBe(true);
    delete (global as any).__pluginInitCalled;
  });

  it('should merge manifest with plugin metadata', async () => {
    const manifest: PluginMetadata = {
      name: 'merge-test',
      version: '2.0.0',
      description: 'From manifest',
      author: 'Manifest Author',
    };
    createPluginDir('merge-test', manifest, `
      module.exports = {
        metadata: { name: 'merge-test', version: '1.0.0', description: 'From plugin' },
      };
    `);

    const loaded = await pluginManager.loadPlugin('merge-test');
    // Plugin metadata should override manifest where both exist
    expect(loaded!.plugin.metadata.version).toBe('1.0.0'); // plugin wins
    expect(loaded!.plugin.metadata.author).toBe('Manifest Author'); // only in manifest
  });
});

// ============================================================================
// unloadPlugin
// ============================================================================

describe('pluginManager.unloadPlugin', () => {
  it('should unload an existing plugin', async () => {
    createMinimalPlugin('unload-me');
    await pluginManager.loadPlugin('unload-me');

    const result = await pluginManager.unloadPlugin('unload-me');
    expect(result).toBe(true);
    expect(pluginManager.getPlugin('unload-me')).toBeUndefined();
  });

  it('should return false for non-existent plugin', async () => {
    const result = await pluginManager.unloadPlugin('ghost-plugin');
    expect(result).toBe(false);
  });

  it('should call plugin cleanup function', async () => {
    const manifest: PluginMetadata = {
      name: 'with-cleanup',
      version: '1.0.0',
      description: 'Has cleanup',
    };
    createPluginDir('with-cleanup', manifest, `
      module.exports = {
        metadata: { name: 'with-cleanup', version: '1.0.0', description: 'cleanup' },
        cleanup: async () => { global.__pluginCleanupCalled = true; },
      };
    `);

    (global as any).__pluginCleanupCalled = false;
    await pluginManager.loadPlugin('with-cleanup');
    await pluginManager.unloadPlugin('with-cleanup');
    expect((global as any).__pluginCleanupCalled).toBe(true);
    delete (global as any).__pluginCleanupCalled;
  });

  it('should handle cleanup errors gracefully', async () => {
    const manifest: PluginMetadata = {
      name: 'bad-cleanup',
      version: '1.0.0',
      description: 'Bad cleanup',
    };
    createPluginDir('bad-cleanup', manifest, `
      module.exports = {
        metadata: { name: 'bad-cleanup', version: '1.0.0', description: 'bad' },
        cleanup: async () => { throw new Error('cleanup failed'); },
      };
    `);

    await pluginManager.loadPlugin('bad-cleanup');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await pluginManager.unloadPlugin('bad-cleanup');
    errorSpy.mockRestore();

    expect(result).toBe(false);
  });
});

// ============================================================================
// setPluginEnabled
// ============================================================================

describe('pluginManager.setPluginEnabled', () => {
  it('should enable a disabled plugin', async () => {
    createMinimalPlugin('toggle-plugin');
    await pluginManager.loadPlugin('toggle-plugin');

    pluginManager.setPluginEnabled('toggle-plugin', false);
    expect(pluginManager.getPlugin('toggle-plugin')!.enabled).toBe(false);

    pluginManager.setPluginEnabled('toggle-plugin', true);
    expect(pluginManager.getPlugin('toggle-plugin')!.enabled).toBe(true);
  });

  it('should return false for non-existent plugin', () => {
    const result = pluginManager.setPluginEnabled('nonexistent', true);
    expect(result).toBe(false);
  });

  it('should return true on success', async () => {
    createMinimalPlugin('enable-test');
    await pluginManager.loadPlugin('enable-test');

    const result = pluginManager.setPluginEnabled('enable-test', false);
    expect(result).toBe(true);
  });
});

// ============================================================================
// getPlugins / getEnabledPlugins
// ============================================================================

describe('getPlugins / getEnabledPlugins', () => {
  it('should return all plugins including disabled ones', async () => {
    createMinimalPlugin('p1');
    createMinimalPlugin('p2');
    await pluginManager.loadPlugin('p1');
    await pluginManager.loadPlugin('p2');

    pluginManager.setPluginEnabled('p2', false);

    const all = pluginManager.getPlugins();
    const enabled = pluginManager.getEnabledPlugins();

    expect(all).toHaveLength(2);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe('p1');
  });

  it('should exclude errored plugins from enabled', async () => {
    const manifest: PluginMetadata = { name: 'errored', version: '1.0.0', description: 'err' };
    createPluginDir('errored', manifest, 'throw new Error("fail");');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await pluginManager.loadPlugin('errored');
    errorSpy.mockRestore();

    const enabled = pluginManager.getEnabledPlugins();
    expect(enabled.find(p => p.id === 'errored')).toBeUndefined();
  });
});

// ============================================================================
// getPluginTools
// ============================================================================

describe('getPluginTools', () => {
  it('should return tools from enabled plugins with namespaced names', async () => {
    createMinimalPlugin('toolbox');
    await pluginManager.loadPlugin('toolbox');

    const tools = pluginManager.getPluginTools();

    expect(tools.length).toBeGreaterThanOrEqual(1);
    const greetTool = tools.find(t => t.name === 'toolbox:greet');
    expect(greetTool).toBeDefined();
    expect(greetTool!.description).toContain('[toolbox]');
    expect(greetTool!.parameters.type).toBe('object');
  });

  it('should return empty array when no plugins loaded', () => {
    const tools = pluginManager.getPluginTools();
    expect(tools).toEqual([]);
  });

  it('should not include tools from disabled plugins', async () => {
    createMinimalPlugin('disabled-tools');
    await pluginManager.loadPlugin('disabled-tools');
    pluginManager.setPluginEnabled('disabled-tools', false);

    const tools = pluginManager.getPluginTools();
    expect(tools.find(t => t.name.startsWith('disabled-tools:'))).toBeUndefined();
  });

  it('should not include tools from plugins without tools array', async () => {
    const manifest: PluginMetadata = { name: 'no-tools', version: '1.0.0', description: 'no tools' };
    createPluginDir('no-tools', manifest, `
      module.exports = {
        metadata: { name: 'no-tools', version: '1.0.0', description: 'no tools' },
      };
    `);

    await pluginManager.loadPlugin('no-tools');

    const tools = pluginManager.getPluginTools();
    expect(tools.find(t => t.name.startsWith('no-tools:'))).toBeUndefined();
  });
});

// ============================================================================
// executePluginTool
// ============================================================================

describe('executePluginTool', () => {
  it('should execute a valid plugin tool', async () => {
    createMinimalPlugin('exec-test');
    await pluginManager.loadPlugin('exec-test');

    const result = await pluginManager.executePluginTool(
      { id: 'call_1', name: 'exec-test:greet', arguments: { name: 'World' } },
      '/tmp'
    );

    expect(result.toolCallId).toBe('call_1');
    expect(result.result).toBe('Hello, World!');
    expect(result.isError).toBeUndefined();
  });

  it('should return error for unknown plugin', async () => {
    const result = await pluginManager.executePluginTool(
      { id: 'call_2', name: 'unknown:tool', arguments: {} },
      '/tmp'
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Plugin not found or disabled');
  });

  it('should return error for disabled plugin', async () => {
    createMinimalPlugin('disabled-exec');
    await pluginManager.loadPlugin('disabled-exec');
    pluginManager.setPluginEnabled('disabled-exec', false);

    const result = await pluginManager.executePluginTool(
      { id: 'call_3', name: 'disabled-exec:greet', arguments: { name: 'Test' } },
      '/tmp'
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('not found or disabled');
  });

  it('should return error for unknown tool name in valid plugin', async () => {
    createMinimalPlugin('valid-no-tool');
    await pluginManager.loadPlugin('valid-no-tool');

    const result = await pluginManager.executePluginTool(
      { id: 'call_4', name: 'valid-no-tool:nonexistent', arguments: {} },
      '/tmp'
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('Tool not found');
  });

  it('should handle tool execution errors', async () => {
    const manifest: PluginMetadata = { name: 'err-tool', version: '1.0.0', description: 'err' };
    createPluginDir('err-tool', manifest, `
      module.exports = {
        metadata: { name: 'err-tool', version: '1.0.0', description: 'err' },
        tools: [
          {
            name: 'fail',
            description: 'Always fails',
            parameters: { type: 'object', properties: {} },
            execute: async () => { throw new Error('tool exploded'); },
          },
        ],
      };
    `);

    await pluginManager.loadPlugin('err-tool');

    const result = await pluginManager.executePluginTool(
      { id: 'call_5', name: 'err-tool:fail', arguments: {} },
      '/tmp'
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('tool exploded');
  });
});

// ============================================================================
// isPluginTool
// ============================================================================

describe('isPluginTool', () => {
  it('should return true for namespaced tool names', () => {
    expect(pluginManager.isPluginTool('my-plugin:tool')).toBe(true);
    expect(pluginManager.isPluginTool('foo:bar')).toBe(true);
  });

  it('should return false for regular tool names', () => {
    expect(pluginManager.isPluginTool('shell')).toBe(false);
    expect(pluginManager.isPluginTool('read_file')).toBe(false);
    expect(pluginManager.isPluginTool('think')).toBe(false);
  });
});

// ============================================================================
// executeHooks
// ============================================================================

describe('executeHooks', () => {
  it('should execute hooks matching the event', async () => {
    createMinimalPlugin('hook-plugin', { tools: false, hooks: true });
    await pluginManager.loadPlugin('hook-plugin');

    (global as any).__hookCalled = false;
    await pluginManager.executeHooks('session-start', { test: true });
    expect((global as any).__hookCalled).toBe(true);
    delete (global as any).__hookCalled;
  });

  it('should not execute hooks for non-matching events', async () => {
    createMinimalPlugin('hook-plugin-2', { tools: false, hooks: true });
    await pluginManager.loadPlugin('hook-plugin-2');

    (global as any).__hookCalled = false;
    await pluginManager.executeHooks('session-end', {});
    expect((global as any).__hookCalled).toBe(false);
    delete (global as any).__hookCalled;
  });

  it('should handle hook errors gracefully', async () => {
    const manifest: PluginMetadata = { name: 'bad-hook', version: '1.0.0', description: 'bad' };
    createPluginDir('bad-hook', manifest, `
      module.exports = {
        metadata: { name: 'bad-hook', version: '1.0.0', description: 'bad' },
        hooks: [{
          event: 'pre-tool',
          handler: async () => { throw new Error('hook failed'); },
        }],
      };
    `);

    await pluginManager.loadPlugin('bad-hook');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Should not throw
    await pluginManager.executeHooks('pre-tool', {});
    errorSpy.mockRestore();
  });

  it('should skip hooks from disabled plugins', async () => {
    createMinimalPlugin('disabled-hooks', { tools: false, hooks: true });
    await pluginManager.loadPlugin('disabled-hooks');
    pluginManager.setPluginEnabled('disabled-hooks', false);

    (global as any).__hookCalled = false;
    await pluginManager.executeHooks('session-start', {});
    expect((global as any).__hookCalled).toBe(false);
    delete (global as any).__hookCalled;
  });
});

// ============================================================================
// createPluginScaffold
// ============================================================================

describe('createPluginScaffold', () => {
  it('should create plugin scaffold with plugin.json and index.js', () => {
    const result = pluginManager.createPluginScaffold('my-new-plugin');

    expect(fs.existsSync(result)).toBe(true);
    expect(fs.existsSync(path.join(result, 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(result, 'index.js'))).toBe(true);

    // Verify manifest content
    const manifest = JSON.parse(fs.readFileSync(path.join(result, 'plugin.json'), 'utf-8'));
    expect(manifest.name).toBe('my-new-plugin');
    expect(manifest.version).toBe('1.0.0');
  });

  it('should throw when plugin directory already exists', () => {
    pluginManager.createPluginScaffold('duplicate');

    expect(() => pluginManager.createPluginScaffold('duplicate'))
      .toThrow('Plugin directory already exists');
  });

  it('should create index.js with example tool', () => {
    const result = pluginManager.createPluginScaffold('example-scaffold');
    const content = fs.readFileSync(path.join(result, 'index.js'), 'utf-8');

    expect(content).toContain('tools:');
    expect(content).toContain('execute:');
    expect(content).toContain('example');
    expect(content).toContain('module.exports');
  });
});

// ============================================================================
// getPluginListFormatted
// ============================================================================

describe('getPluginListFormatted', () => {
  it('should show "No plugins installed" when empty', () => {
    const formatted = pluginManager.getPluginListFormatted();
    expect(formatted).toContain('No plugins installed');
    expect(formatted).toContain('Plugins directory:');
  });

  it('should list installed plugins with details', async () => {
    createMinimalPlugin('listed-plugin');
    await pluginManager.loadPlugin('listed-plugin');

    const formatted = pluginManager.getPluginListFormatted();
    expect(formatted).toContain('Installed Plugins:');
    expect(formatted).toContain('listed-plugin');
    expect(formatted).toContain('Tools:');
    expect(formatted).toContain('greet');
  });

  it('should show error status for failed plugins', async () => {
    const manifest: PluginMetadata = { name: 'fail-listed', version: '1.0.0', description: 'fails' };
    createPluginDir('fail-listed', manifest, 'throw new Error("kaboom");');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await pluginManager.loadPlugin('fail-listed');
    errorSpy.mockRestore();

    const formatted = pluginManager.getPluginListFormatted();
    expect(formatted).toContain('fail-listed');
    expect(formatted).toContain('Error:');
    expect(formatted).toContain('kaboom');
  });

  it('should show version information', async () => {
    createMinimalPlugin('versioned');
    await pluginManager.loadPlugin('versioned');

    const formatted = pluginManager.getPluginListFormatted();
    expect(formatted).toContain('v1.0.0');
  });
});

// ============================================================================
// getPluginsDir
// ============================================================================

describe('getPluginsDir', () => {
  it('should return the plugins directory path', () => {
    const dir = pluginManager.getPluginsDir();
    expect(dir).toBe(tmpPluginsDir);
  });
});

// ============================================================================
// Convenience functions
// ============================================================================

describe('Convenience functions', () => {
  it('initPlugins should call pluginManager.init()', async () => {
    const initSpy = vi.spyOn(pluginManager, 'init').mockResolvedValue();
    await initPlugins();
    expect(initSpy).toHaveBeenCalled();
    initSpy.mockRestore();
  });

  it('getPluginTools should return pluginManager.getPluginTools()', async () => {
    createMinimalPlugin('conv-tools');
    await pluginManager.loadPlugin('conv-tools');

    const tools = getPluginTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
  });

  it('isPluginTool should delegate to pluginManager', () => {
    expect(isPluginTool('foo:bar')).toBe(true);
    expect(isPluginTool('shell')).toBe(false);
  });

  it('executePluginTool should delegate to pluginManager', async () => {
    createMinimalPlugin('conv-exec');
    await pluginManager.loadPlugin('conv-exec');

    const result = await executePluginTool(
      { id: 'c1', name: 'conv-exec:greet', arguments: { name: 'CLI' } },
      '/tmp'
    );
    expect(result.result).toBe('Hello, CLI!');
  });

  it('getPluginList should return formatted list', () => {
    const list = getPluginList();
    expect(typeof list).toBe('string');
  });

  it('createPlugin should create scaffold and return path', () => {
    const pluginPath = createPlugin('conv-scaffold');
    expect(fs.existsSync(pluginPath)).toBe(true);
  });

  it('reloadPlugins should call loadAllPlugins', async () => {
    const spy = vi.spyOn(pluginManager, 'loadAllPlugins').mockResolvedValue();
    await reloadPlugins();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('enablePlugin should delegate to setPluginEnabled', async () => {
    createMinimalPlugin('conv-enable');
    await pluginManager.loadPlugin('conv-enable');

    const result = enablePlugin('conv-enable', false);
    expect(result).toBe(true);
    expect(pluginManager.getPlugin('conv-enable')!.enabled).toBe(false);
  });

  it('enablePlugin should return false for unknown plugin', () => {
    const result = enablePlugin('nope', true);
    expect(result).toBe(false);
  });
});

// ============================================================================
// loadAllPlugins
// ============================================================================

describe('loadAllPlugins', () => {
  it('should skip non-directory entries', async () => {
    // Create a file (not a directory) in the plugins dir
    fs.writeFileSync(
      path.join(tmpPluginsDir, 'not-a-dir.txt'),
      'just a file'
    );

    await pluginManager.loadAllPlugins();

    // Should not crash and should have no plugins loaded
    const plugins = pluginManager.getPlugins();
    expect(plugins.find(p => p.id === 'not-a-dir.txt')).toBeUndefined();
  });

  it('should handle non-existent plugins directory', async () => {
    // Point to a non-existent directory
    (pluginManager as any).pluginsDir = path.join(tmpPluginsDir, 'nonexistent');

    // loadAllPlugins checks existsSync and returns early
    await pluginManager.loadAllPlugins();

    // Should not throw
    expect(pluginManager.getPlugins()).toEqual([]);
  });
});
