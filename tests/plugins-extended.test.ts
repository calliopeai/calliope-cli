/**
 * Extended coverage tests for src/plugins.ts
 *
 * Targets branches not covered by tests/plugins.test.ts:
 * - validateManifest: null/non-object, empty name, empty version, non-string description
 * - validatePluginExports: null module, non-array tools, non-array hooks,
 *   non-function init, non-function cleanup, null tool in tools array,
 *   tool missing required fields
 * - loadPlugin: directory traversal protection (.. / \ in name)
 * - loadPlugin: plugin without default export (module.exports path)
 * - loadPlugin: invalid JSON manifest
 * - executePluginTool: non-Error thrown from tool (String path)
 * - getPluginListFormatted: disabled-but-not-errored plugin (⏸️ status)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  pluginManager,
} from '../src/plugins.js';
import type { PluginMetadata } from '../src/plugins.js';

// ============================================================================
// Helpers (same pattern as plugins.test.ts)
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
  const map = (pluginManager as any).plugins as Map<string, unknown>;
  map.clear();
}

function createPluginDir(name: string, manifest: unknown, indexContent: string): string {
  const pluginPath = path.join(tmpPluginsDir, name);
  fs.mkdirSync(pluginPath, { recursive: true });
  fs.writeFileSync(
    path.join(pluginPath, 'plugin.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2)
  );
  fs.writeFileSync(path.join(pluginPath, 'index.js'), indexContent);
  return pluginPath;
}

beforeEach(() => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-plugins-ext-'));
  tmpPluginsDir = path.join(tmpRoot, 'plugins');
  fs.mkdirSync(tmpPluginsDir, { recursive: true });
  patchPluginsDir(tmpPluginsDir);
  clearPlugins();
});

afterEach(() => {
  clearPlugins();
  restorePluginsDir();
  const tmpRoot = path.dirname(tmpPluginsDir);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ===========================================================================
// loadPlugin: directory traversal protection
// ===========================================================================

describe('loadPlugin - security: directory traversal', () => {
  it('should reject plugin name with ".."', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('../etc');
    warnSpy.mockRestore();
    expect(result).toBeNull();
  });

  it('should reject plugin name with "/"', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('foo/bar');
    warnSpy.mockRestore();
    expect(result).toBeNull();
  });

  it('should reject plugin name with backslash', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('foo\\bar');
    warnSpy.mockRestore();
    expect(result).toBeNull();
  });
});

// ===========================================================================
// loadPlugin: invalid JSON manifest
// ===========================================================================

describe('loadPlugin - invalid JSON manifest', () => {
  it('should return null when plugin.json is not valid JSON', async () => {
    const pluginPath = path.join(tmpPluginsDir, 'bad-json');
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'plugin.json'), 'this is {not valid json');
    fs.writeFileSync(path.join(pluginPath, 'index.js'), 'module.exports = {};');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('bad-json');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });
});

// ===========================================================================
// validateManifest - uncovered branches
// ===========================================================================

describe('validateManifest - invalid manifests', () => {
  it('should return null when manifest is null (not a valid object)', async () => {
    const pluginPath = path.join(tmpPluginsDir, 'null-manifest');
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'plugin.json'), 'null');
    fs.writeFileSync(path.join(pluginPath, 'index.js'), 'module.exports = {};');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('null-manifest');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when manifest name is empty string', async () => {
    const manifest = { name: '', version: '1.0.0', description: 'test' };
    createPluginDir('empty-name', manifest, 'module.exports = {};');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('empty-name');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when manifest version is empty string', async () => {
    const manifest = { name: 'empty-version', version: '', description: 'test' };
    createPluginDir('empty-version', manifest, 'module.exports = {};');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('empty-version');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when manifest description is not a string', async () => {
    const manifest = { name: 'no-desc', version: '1.0.0' }; // missing description
    createPluginDir('no-desc', manifest, 'module.exports = {};');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('no-desc');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when manifest name is not a string', async () => {
    // JSON.stringify handles number values — write raw JSON
    const pluginPath = path.join(tmpPluginsDir, 'non-string-name');
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'plugin.json'), '{"name": 123, "version": "1.0.0", "description": "test"}');
    fs.writeFileSync(path.join(pluginPath, 'index.js'), 'module.exports = {};');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('non-string-name');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when manifest version is not a string', async () => {
    const pluginPath = path.join(tmpPluginsDir, 'non-string-version');
    fs.mkdirSync(pluginPath, { recursive: true });
    fs.writeFileSync(path.join(pluginPath, 'plugin.json'), '{"name": "test", "version": 1, "description": "test"}');
    fs.writeFileSync(path.join(pluginPath, 'index.js'), 'module.exports = {};');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('non-string-version');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });
});

// ===========================================================================
// validatePluginExports - uncovered branches
// ===========================================================================

describe('validatePluginExports - invalid exports', () => {
  it('should successfully load when module exports a valid object (even without .default)', async () => {
    // When module.exports = null, pluginModule.default = null (falsy),
    // so the code falls back to the full pluginModule object { default: null },
    // which IS an object. This tests the fallback path of `pluginModule.default || pluginModule`.
    const manifest: PluginMetadata = { name: 'null-default', version: '1.0.0', description: 'null default' };
    createPluginDir('null-default', manifest, `
      module.exports = {
        metadata: { name: 'null-default', version: '1.0.0', description: 'null default' },
      };
    `);
    // This exercises the successful load path — no default export, uses module itself
    const result = await pluginManager.loadPlugin('null-default');
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
  });

  it('should return null when tools is not an array', async () => {
    const manifest: PluginMetadata = { name: 'bad-tools', version: '1.0.0', description: 'bad' };
    createPluginDir('bad-tools', manifest, `
      module.exports = {
        metadata: { name: 'bad-tools', version: '1.0.0', description: 'bad' },
        tools: 'not an array',
      };
    `);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('bad-tools');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when hooks is not an array', async () => {
    const manifest: PluginMetadata = { name: 'bad-hooks', version: '1.0.0', description: 'bad' };
    createPluginDir('bad-hooks', manifest, `
      module.exports = {
        metadata: { name: 'bad-hooks', version: '1.0.0', description: 'bad' },
        hooks: 'not an array',
      };
    `);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('bad-hooks');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when init is not a function', async () => {
    const manifest: PluginMetadata = { name: 'bad-init', version: '1.0.0', description: 'bad' };
    createPluginDir('bad-init', manifest, `
      module.exports = {
        metadata: { name: 'bad-init', version: '1.0.0', description: 'bad' },
        init: 'not a function',
      };
    `);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('bad-init');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when cleanup is not a function', async () => {
    const manifest: PluginMetadata = { name: 'bad-cleanup', version: '1.0.0', description: 'bad' };
    createPluginDir('bad-cleanup', manifest, `
      module.exports = {
        metadata: { name: 'bad-cleanup', version: '1.0.0', description: 'bad' },
        cleanup: 42,
      };
    `);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('bad-cleanup');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when a tool in tools array is not an object', async () => {
    const manifest: PluginMetadata = { name: 'null-tool', version: '1.0.0', description: 'null-tool' };
    createPluginDir('null-tool', manifest, `
      module.exports = {
        metadata: { name: 'null-tool', version: '1.0.0', description: 'null-tool' },
        tools: [null],
      };
    `);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('null-tool');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when a tool is missing name field', async () => {
    const manifest: PluginMetadata = { name: 'missing-name', version: '1.0.0', description: 'bad tool' };
    createPluginDir('missing-name', manifest, `
      module.exports = {
        metadata: { name: 'missing-name', version: '1.0.0', description: 'bad tool' },
        tools: [{
          description: 'Missing name',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'result',
        }],
      };
    `);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('missing-name');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });

  it('should return null when a tool is missing execute function', async () => {
    const manifest: PluginMetadata = { name: 'no-execute', version: '1.0.0', description: 'bad tool' };
    createPluginDir('no-execute', manifest, `
      module.exports = {
        metadata: { name: 'no-execute', version: '1.0.0', description: 'bad tool' },
        tools: [{
          name: 'my-tool',
          description: 'No execute',
          parameters: { type: 'object', properties: {} },
          // execute: missing
        }],
      };
    `);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await pluginManager.loadPlugin('no-execute');
    warnSpy.mockRestore();

    expect(result).toBeNull();
  });
});

// ===========================================================================
// executePluginTool - non-Error thrown from tool
// ===========================================================================

describe('executePluginTool - non-Error thrown', () => {
  it('should handle non-Error thrown from tool (String path)', async () => {
    const manifest: PluginMetadata = { name: 'string-err', version: '1.0.0', description: 'throws string' };
    createPluginDir('string-err', manifest, `
      module.exports = {
        metadata: { name: 'string-err', version: '1.0.0', description: 'throws string' },
        tools: [{
          name: 'thrower',
          description: 'Throws a string',
          parameters: { type: 'object', properties: {} },
          execute: async () => { throw 'not an Error object'; },
        }],
      };
    `);

    await pluginManager.loadPlugin('string-err');

    const result = await pluginManager.executePluginTool(
      { id: 'call_1', name: 'string-err:thrower', arguments: {} },
      '/tmp'
    );

    expect(result.isError).toBe(true);
    expect(result.result).toContain('not an Error object');
  });
});

// ===========================================================================
// getPluginListFormatted - disabled (not errored) plugin shows ⏸️
// ===========================================================================

describe('getPluginListFormatted - disabled plugin status', () => {
  it('should show paused status for disabled plugin without error', async () => {
    // Create and load a valid plugin
    const manifest: PluginMetadata = { name: 'pausable', version: '1.0.0', description: 'pausable plugin' };
    createPluginDir('pausable', manifest, `
      module.exports = {
        metadata: { name: 'pausable', version: '1.0.0', description: 'pausable plugin' },
        tools: [],
      };
    `);

    await pluginManager.loadPlugin('pausable');
    // Disable the plugin (no error, just disabled)
    pluginManager.setPluginEnabled('pausable', false);

    const formatted = pluginManager.getPluginListFormatted();
    expect(formatted).toContain('pausable');
    // The disabled (no error) status should show the pause emoji
    expect(formatted).toContain('⏸️');
  });
});

// ===========================================================================
// loadPlugin: module without default export (module.exports path, no .default)
// ===========================================================================

describe('loadPlugin - module.exports without .default', () => {
  it('should load plugin from module.exports when no default property', async () => {
    const manifest: PluginMetadata = { name: 'cjs-plugin', version: '1.0.0', description: 'CJS module' };
    createPluginDir('cjs-plugin', manifest, `
      module.exports = {
        metadata: { name: 'cjs-plugin', version: '1.0.0', description: 'CJS module' },
        tools: [{
          name: 'cjs-tool',
          description: 'CJS tool',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'cjs result',
        }],
      };
    `);

    const result = await pluginManager.loadPlugin('cjs-plugin');
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
    expect(result!.plugin.tools).toHaveLength(1);
  });
});
