/**
 * Tests for src/hooks.ts
 *
 * Covers: loadHooks, saveHooks, addHook, removeHook, toggleHook,
 * getHooksForEvent, executeHooks, checkHooksAllow, initDefaultHooks,
 * listHooksFormatted, and hook condition matching.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create temp home ONCE before the module loads, so HOOKS_DIR is set correctly.
// vi.hoisted runs before vi.mock factories AND before module imports.
const { tmpHome } = vi.hoisted(() => {
  // We must use require here since fs/path/os are not imported yet in hoisted scope
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'calliope-hooks-test-'));
  return { tmpHome: dir };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import {
  loadHooks,
  saveHooks,
  addHook,
  removeHook,
  toggleHook,
  getHooksForEvent,
  executeHooks,
  checkHooksAllow,
  initDefaultHooks,
  listHooksFormatted,
} from '../src/hooks.js';
import type { Hook } from '../src/hooks.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const HOOKS_DIR = path.join(tmpHome, '.calliope-cli', 'hooks');
const HOOKS_FILE = path.join(HOOKS_DIR, 'hooks.json');

beforeEach(() => {
  // Clean hooks file between tests so state doesn't leak
  if (fs.existsSync(HOOKS_FILE)) {
    fs.unlinkSync(HOOKS_FILE);
  }
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHook(overrides: Partial<Omit<Hook, 'id'>> = {}): Omit<Hook, 'id'> {
  return {
    event: 'pre-tool',
    name: 'Test hook',
    command: 'echo test',
    enabled: true,
    async: false,
    ...overrides,
  };
}

// ===========================================================================
// loadHooks
// ===========================================================================

describe('loadHooks', () => {
  it('should return empty array when hooks file does not exist', () => {
    const hooks = loadHooks();
    expect(hooks).toEqual([]);
  });

  it('should create hooks directory if it does not exist', () => {
    // Remove the hooks dir first
    if (fs.existsSync(HOOKS_DIR)) {
      fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
    }
    loadHooks();
    expect(fs.existsSync(HOOKS_DIR)).toBe(true);
  });

  it('should return hooks from file when it exists', () => {
    const testHooks: Hook[] = [
      { id: 'h1', event: 'pre-tool', name: 'Hook 1', command: 'echo 1', enabled: true, async: false },
    ];
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    fs.writeFileSync(HOOKS_FILE, JSON.stringify(testHooks));

    const hooks = loadHooks();
    expect(hooks).toEqual(testHooks);
  });

  it('should return empty array for invalid JSON', () => {
    fs.mkdirSync(HOOKS_DIR, { recursive: true });
    fs.writeFileSync(HOOKS_FILE, 'not valid json{{{');

    const hooks = loadHooks();
    expect(hooks).toEqual([]);
  });
});

// ===========================================================================
// saveHooks
// ===========================================================================

describe('saveHooks', () => {
  it('should write hooks to file', () => {
    const testHooks: Hook[] = [
      { id: 'h1', event: 'post-tool', name: 'Save test', command: 'echo saved', enabled: true, async: false },
    ];
    saveHooks(testHooks);

    const raw = fs.readFileSync(HOOKS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(testHooks);
  });

  it('should create hooks directory if missing', () => {
    if (fs.existsSync(HOOKS_DIR)) {
      fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
    }
    saveHooks([]);
    expect(fs.existsSync(HOOKS_DIR)).toBe(true);
  });

  it('should format JSON with 2-space indentation', () => {
    saveHooks([{ id: 'h1', event: 'pre-tool', name: 'A', command: 'echo a', enabled: true, async: false }]);
    const raw = fs.readFileSync(HOOKS_FILE, 'utf-8');
    expect(raw).toContain('  "id"');
  });
});

// ===========================================================================
// addHook
// ===========================================================================

describe('addHook', () => {
  it('should add a hook and return it with an id', () => {
    const result = addHook(makeHook({ name: 'My Hook' }));
    expect(result.id).toBeDefined();
    expect(result.id).toMatch(/^hook_/);
    expect(result.name).toBe('My Hook');
  });

  it('should persist the hook to disk', () => {
    addHook(makeHook());
    const hooks = loadHooks();
    expect(hooks.length).toBe(1);
  });

  it('should generate unique ids', () => {
    const h1 = addHook(makeHook({ name: 'First' }));
    const h2 = addHook(makeHook({ name: 'Second' }));
    expect(h1.id).not.toBe(h2.id);
  });

  it('should append to existing hooks', () => {
    addHook(makeHook({ name: 'First' }));
    addHook(makeHook({ name: 'Second' }));
    const hooks = loadHooks();
    expect(hooks.length).toBe(2);
    expect(hooks[0].name).toBe('First');
    expect(hooks[1].name).toBe('Second');
  });
});

// ===========================================================================
// removeHook
// ===========================================================================

describe('removeHook', () => {
  it('should remove an existing hook and return true', () => {
    const hook = addHook(makeHook());
    const result = removeHook(hook.id);
    expect(result).toBe(true);
    expect(loadHooks().length).toBe(0);
  });

  it('should return false for non-existent id', () => {
    const result = removeHook('nonexistent');
    expect(result).toBe(false);
  });

  it('should leave other hooks intact', () => {
    const h1 = addHook(makeHook({ name: 'Keep' }));
    const h2 = addHook(makeHook({ name: 'Remove' }));
    removeHook(h2.id);
    const hooks = loadHooks();
    expect(hooks.length).toBe(1);
    expect(hooks[0].name).toBe('Keep');
  });
});

// ===========================================================================
// toggleHook
// ===========================================================================

describe('toggleHook', () => {
  it('should enable a disabled hook', () => {
    const hook = addHook(makeHook({ enabled: false }));
    const result = toggleHook(hook.id, true);
    expect(result).toBe(true);
    const hooks = loadHooks();
    expect(hooks[0].enabled).toBe(true);
  });

  it('should disable an enabled hook', () => {
    const hook = addHook(makeHook({ enabled: true }));
    const result = toggleHook(hook.id, false);
    expect(result).toBe(true);
    const hooks = loadHooks();
    expect(hooks[0].enabled).toBe(false);
  });

  it('should return false for non-existent id', () => {
    const result = toggleHook('fake-id', true);
    expect(result).toBe(false);
  });
});

// ===========================================================================
// getHooksForEvent
// ===========================================================================

describe('getHooksForEvent', () => {
  it('should return only enabled hooks for the given event', () => {
    addHook(makeHook({ event: 'pre-tool', name: 'A', enabled: true }));
    addHook(makeHook({ event: 'post-tool', name: 'B', enabled: true }));
    addHook(makeHook({ event: 'pre-tool', name: 'C', enabled: false }));

    const hooks = getHooksForEvent('pre-tool');
    expect(hooks.length).toBe(1);
    expect(hooks[0].name).toBe('A');
  });

  it('should return empty array when no hooks match', () => {
    addHook(makeHook({ event: 'pre-tool', enabled: true }));
    const hooks = getHooksForEvent('session-start');
    expect(hooks).toEqual([]);
  });
});

// ===========================================================================
// executeHooks
// ===========================================================================

describe('executeHooks', () => {
  it('should execute a simple echo hook and capture output', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'echo "hook ran"',
      enabled: true,
      async: false,
    }));

    const results = await executeHooks('pre-tool', {});
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].output).toBe('hook ran');
  });

  it('should pass environment variables to hook', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'echo "$CALLIOPE_TOOL"',
      enabled: true,
      async: false,
    }));

    const results = await executeHooks('pre-tool', { tool: 'shell' });
    expect(results[0].output).toBe('shell');
  });

  it('should pass CALLIOPE_FILE env var', async () => {
    addHook(makeHook({
      event: 'pre-write',
      command: 'echo "$CALLIOPE_FILE"',
      enabled: true,
      async: false,
    }));

    const results = await executeHooks('pre-write', { filePath: '/tmp/test.txt' });
    expect(results[0].output).toBe('/tmp/test.txt');
  });

  it('should pass CALLIOPE_TOOL_ARGS as JSON env var', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'echo "$CALLIOPE_TOOL_ARGS"',
      enabled: true,
      async: false,
    }));

    const results = await executeHooks('pre-tool', { toolArgs: { path: '/tmp/x' } });
    expect(results[0].output).toBe('{"path":"/tmp/x"}');
  });

  it('should handle hook failure (non-zero exit)', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'exit 1',
      enabled: true,
      async: false,
    }));

    const results = await executeHooks('pre-tool', {});
    expect(results[0].success).toBe(false);
  });

  it('should capture stderr', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'echo "oops" >&2; exit 1',
      enabled: true,
      async: false,
    }));

    const results = await executeHooks('pre-tool', {});
    expect(results[0].error).toBe('oops');
  });

  it('should detect blocking exit code 42', async () => {
    addHook(makeHook({
      event: 'pre-shell',
      command: 'exit 42',
      enabled: true,
      async: false,
    }));

    const results = await executeHooks('pre-shell', {});
    expect(results[0].blocked).toBe(true);
    expect(results[0].success).toBe(true);
  });

  it('should stop executing after a blocking hook', async () => {
    addHook(makeHook({
      event: 'pre-shell',
      name: 'blocker',
      command: 'exit 42',
      enabled: true,
      async: false,
    }));
    addHook(makeHook({
      event: 'pre-shell',
      name: 'after blocker',
      command: 'echo "should not run"',
      enabled: true,
      async: false,
    }));

    const results = await executeHooks('pre-shell', {});
    expect(results.length).toBe(1);
    expect(results[0].blocked).toBe(true);
  });

  it('should return empty array when no hooks match', async () => {
    const results = await executeHooks('session-start', {});
    expect(results).toEqual([]);
  });

  it('should handle async hooks (fire-and-forget)', async () => {
    addHook(makeHook({
      event: 'post-tool',
      command: 'echo "async"',
      enabled: true,
      async: true,
    }));

    const results = await executeHooks('post-tool', {});
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
  });

  it('should handle hook timeout', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'sleep 10',
      enabled: true,
      async: false,
      timeout: 200,
    }));

    const results = await executeHooks('pre-tool', {});
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('timed out');
  }, 10000);
});

// ===========================================================================
// Hook conditions
// ===========================================================================

describe('hook conditions', () => {
  it('should match tool: condition', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'echo "matched"',
      enabled: true,
      async: false,
      condition: 'tool:shell',
    }));

    const matched = await executeHooks('pre-tool', { tool: 'shell' });
    expect(matched.length).toBe(1);
    expect(matched[0].output).toBe('matched');

    // Should not match a different tool
    const notMatched = await executeHooks('pre-tool', { tool: 'read_file' });
    expect(notMatched.length).toBe(0);
  });

  it('should match file: condition', async () => {
    addHook(makeHook({
      event: 'pre-write',
      command: 'echo "file match"',
      enabled: true,
      async: false,
      condition: 'file:.ts',
    }));

    const matched = await executeHooks('pre-write', { filePath: '/tmp/app.ts' });
    expect(matched.length).toBe(1);

    const notMatched = await executeHooks('pre-write', { filePath: '/tmp/app.py' });
    expect(notMatched.length).toBe(0);
  });

  it('should match cmd: condition', async () => {
    addHook(makeHook({
      event: 'pre-shell',
      command: 'echo "cmd match"',
      enabled: true,
      async: false,
      condition: 'cmd:rm',
    }));

    const matched = await executeHooks('pre-shell', { command: 'rm -rf /tmp/test' });
    expect(matched.length).toBe(1);

    const notMatched = await executeHooks('pre-shell', { command: 'ls -la' });
    expect(notMatched.length).toBe(0);
  });

  it('should fall back to general pattern match', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'echo "general"',
      enabled: true,
      async: false,
      condition: 'dangerous',
    }));

    const matched = await executeHooks('pre-tool', { tool: 'shell', command: 'something dangerous' });
    expect(matched.length).toBe(1);

    const notMatched = await executeHooks('pre-tool', { tool: 'read_file' });
    expect(notMatched.length).toBe(0);
  });

  it('should skip hook when condition does not match', async () => {
    addHook(makeHook({
      event: 'pre-tool',
      command: 'echo "should not appear"',
      enabled: true,
      async: false,
      condition: 'tool:write_file',
    }));

    const results = await executeHooks('pre-tool', { tool: 'read_file' });
    expect(results.length).toBe(0);
  });
});

// ===========================================================================
// checkHooksAllow
// ===========================================================================

describe('checkHooksAllow', () => {
  it('should return allowed: true when no hooks block', async () => {
    addHook(makeHook({
      event: 'pre-shell',
      command: 'echo "ok"',
      enabled: true,
      async: false,
    }));

    const result = await checkHooksAllow('pre-shell', {});
    expect(result.allowed).toBe(true);
  });

  it('should return allowed: false when a hook blocks', async () => {
    addHook(makeHook({
      event: 'pre-shell',
      command: 'echo "blocked!"; exit 42',
      enabled: true,
      async: false,
    }));

    const result = await checkHooksAllow('pre-shell', {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('blocked!');
  });

  it('should return allowed: true when no hooks exist', async () => {
    const result = await checkHooksAllow('pre-tool', {});
    expect(result.allowed).toBe(true);
  });

  it('should use error as reason if no output', async () => {
    addHook(makeHook({
      event: 'pre-shell',
      command: 'echo "err msg" >&2; exit 42',
      enabled: true,
      async: false,
    }));

    const result = await checkHooksAllow('pre-shell', {});
    expect(result.allowed).toBe(false);
    // Output is empty, so it falls back to error
    expect(result.reason).toBe('err msg');
  });
});

// ===========================================================================
// initDefaultHooks
// ===========================================================================

describe('initDefaultHooks', () => {
  it('should create default hooks when none exist', () => {
    initDefaultHooks();
    const hooks = loadHooks();
    expect(hooks.length).toBe(3);
  });

  it('should not overwrite existing hooks', () => {
    addHook(makeHook({ name: 'Custom' }));
    initDefaultHooks();
    const hooks = loadHooks();
    expect(hooks.length).toBe(1);
    expect(hooks[0].name).toBe('Custom');
  });

  it('should create hooks that are disabled by default', () => {
    initDefaultHooks();
    const hooks = loadHooks();
    for (const hook of hooks) {
      expect(hook.enabled).toBe(false);
    }
  });

  it('should include expected default hooks', () => {
    initDefaultHooks();
    const hooks = loadHooks();
    const names = hooks.map(h => h.name);
    expect(names).toContain('Log dangerous commands');
    expect(names).toContain('Format on save');
    expect(names).toContain('Block sudo');
  });
});

// ===========================================================================
// listHooksFormatted
// ===========================================================================

describe('listHooksFormatted', () => {
  it('should return "No hooks configured." when no hooks exist', () => {
    expect(listHooksFormatted()).toBe('No hooks configured.');
  });

  it('should show enabled status with checkmark', () => {
    addHook(makeHook({ name: 'Enabled hook', enabled: true }));
    const output = listHooksFormatted();
    expect(output).toContain('\u2713');
    expect(output).toContain('Enabled hook');
  });

  it('should show disabled status with cross', () => {
    addHook(makeHook({ name: 'Disabled hook', enabled: false }));
    const output = listHooksFormatted();
    expect(output).toContain('\u2717');
    expect(output).toContain('Disabled hook');
  });

  it('should show (async) for async hooks', () => {
    addHook(makeHook({ name: 'Async hook', async: true }));
    const output = listHooksFormatted();
    expect(output).toContain('(async)');
  });

  it('should show event type in brackets', () => {
    addHook(makeHook({ event: 'post-write', name: 'Write hook' }));
    const output = listHooksFormatted();
    expect(output).toContain('[post-write]');
  });

  it('should show the command', () => {
    addHook(makeHook({ command: 'prettier --write "$CALLIOPE_FILE"' }));
    const output = listHooksFormatted();
    expect(output).toContain('prettier --write "$CALLIOPE_FILE"');
  });

  it('should list multiple hooks separated by double newlines', () => {
    addHook(makeHook({ name: 'Hook A' }));
    addHook(makeHook({ name: 'Hook B' }));
    const output = listHooksFormatted();
    expect(output).toContain('Hook A');
    expect(output).toContain('Hook B');
    expect(output).toContain('\n\n');
  });
});
