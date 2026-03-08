/**
 * Tests for src/agents/dynamic-tools.ts
 *
 * Covers: DynamicToolRegistry (CRUD, execution, tool definitions),
 * meta-tool executor (create_tool, list_dynamic_tools, remove_tool),
 * exported helpers (getDynamicToolDefs, isDynamicTool, DYNAMIC_TOOL_NAMES),
 * and security (reserved names, invalid names, dangerous patterns, argument sanitization).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  DynamicToolRegistry,
  dynamicToolRegistry,
  isDynamicTool,
  executeDynamicTool,
  getDynamicToolDefs,
  executeMetaTool,
  DYNAMIC_TOOL_NAMES,
} from '../src/agents/dynamic-tools.js';
import type { DynamicTool } from '../src/agents/dynamic-tools.js';
import type { ToolCall } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Date.now()}-${Math.random()}`, name, arguments: args };
}

function makeDynamicTool(overrides: Partial<DynamicTool> = {}): DynamicTool {
  return {
    name: 'my_tool',
    description: 'A test tool',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path' },
      },
      required: ['file'],
    },
    command: 'echo {{file}}',
    createdBy: 'test',
    createdAt: new Date(),
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  dynamicToolRegistry.reset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-tools-test-'));
});

// ---------------------------------------------------------------------------
// DynamicToolRegistry
// ---------------------------------------------------------------------------

describe('DynamicToolRegistry', () => {
  describe('singleton', () => {
    it('getInstance returns the same instance', () => {
      const a = DynamicToolRegistry.getInstance();
      const b = DynamicToolRegistry.getInstance();
      expect(a).toBe(b);
    });

    it('exported singleton matches getInstance', () => {
      expect(dynamicToolRegistry).toBe(DynamicToolRegistry.getInstance());
    });
  });

  describe('register', () => {
    it('registers a tool with name, description, and command template', () => {
      const tool = makeDynamicTool();
      dynamicToolRegistry.register(tool);
      expect(dynamicToolRegistry.get('my_tool')).toBeDefined();
      expect(dynamicToolRegistry.get('my_tool')!.description).toBe('A test tool');
    });

    it('rejects reserved names', () => {
      const reserved = [
        'create_tool', 'list_dynamic_tools', 'remove_tool',
        'execute_command', 'read_file', 'write_file', 'think',
        'create_plan', 'list_files', 'search_files', 'search_code',
      ];
      for (const name of reserved) {
        expect(() => dynamicToolRegistry.register(makeDynamicTool({ name }))).toThrow('reserved');
      }
    });

    it('rejects names with spaces', () => {
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'my tool' }))).toThrow('Invalid tool name');
    });

    it('rejects names with special characters', () => {
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'my-tool' }))).toThrow('Invalid tool name');
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'my.tool' }))).toThrow('Invalid tool name');
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'my@tool' }))).toThrow('Invalid tool name');
    });

    it('rejects names starting with a digit', () => {
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: '1tool' }))).toThrow('Invalid tool name');
    });

    it('rejects names that are too short (1 char)', () => {
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'a' }))).toThrow('Invalid tool name');
    });

    it('rejects uppercase names', () => {
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'MyTool' }))).toThrow('Invalid tool name');
    });

    it('rejects duplicate registration', () => {
      dynamicToolRegistry.register(makeDynamicTool());
      expect(() => dynamicToolRegistry.register(makeDynamicTool())).toThrow('already registered');
    });

    it('stores a copy, not a reference', () => {
      const tool = makeDynamicTool();
      dynamicToolRegistry.register(tool);
      tool.description = 'mutated';
      expect(dynamicToolRegistry.get('my_tool')!.description).toBe('A test tool');
    });
  });

  describe('get', () => {
    it('returns registered tool', () => {
      dynamicToolRegistry.register(makeDynamicTool());
      const t = dynamicToolRegistry.get('my_tool');
      expect(t).toBeDefined();
      expect(t!.name).toBe('my_tool');
    });

    it('returns undefined for unregistered tool', () => {
      expect(dynamicToolRegistry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getAll / list', () => {
    it('returns empty array initially', () => {
      expect(dynamicToolRegistry.getAll()).toEqual([]);
    });

    it('returns all registered tools', () => {
      dynamicToolRegistry.register(makeDynamicTool({ name: 'tool_a' }));
      dynamicToolRegistry.register(makeDynamicTool({ name: 'tool_b' }));
      const all = dynamicToolRegistry.getAll();
      expect(all).toHaveLength(2);
      const names = all.map(t => t.name);
      expect(names).toContain('tool_a');
      expect(names).toContain('tool_b');
    });
  });

  describe('unregister', () => {
    it('removes a registered tool and returns true', () => {
      dynamicToolRegistry.register(makeDynamicTool());
      expect(dynamicToolRegistry.unregister('my_tool')).toBe(true);
      expect(dynamicToolRegistry.get('my_tool')).toBeUndefined();
    });

    it('returns false for non-existent tool', () => {
      expect(dynamicToolRegistry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('isDynamic', () => {
    it('returns true for registered tool', () => {
      dynamicToolRegistry.register(makeDynamicTool());
      expect(dynamicToolRegistry.isDynamic('my_tool')).toBe(true);
    });

    it('returns false for unregistered tool', () => {
      expect(dynamicToolRegistry.isDynamic('nope')).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all tools', () => {
      dynamicToolRegistry.register(makeDynamicTool({ name: 'tool_a' }));
      dynamicToolRegistry.register(makeDynamicTool({ name: 'tool_b' }));
      dynamicToolRegistry.reset();
      expect(dynamicToolRegistry.getAll()).toEqual([]);
    });
  });

  describe('getToolDefinitions', () => {
    it('returns Tool[] format with [dynamic] prefix', () => {
      dynamicToolRegistry.register(makeDynamicTool());
      const defs = dynamicToolRegistry.getToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0].name).toBe('my_tool');
      expect(defs[0].description).toBe('[dynamic] A test tool');
      expect(defs[0].parameters).toBeDefined();
      expect(defs[0].parameters.type).toBe('object');
    });

    it('returns empty array when no tools registered', () => {
      expect(dynamicToolRegistry.getToolDefinitions()).toEqual([]);
    });
  });

  describe('execute', () => {
    it('runs shell command with parameter substitution', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'echo_test',
        command: 'echo {{file}}',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('echo_test', { file: 'hello_world' }),
        tmpDir,
      );
      expect(result.result).toBe('hello_world');
      expect(result.isError).toBeUndefined();
    });

    it('returns error for unregistered tool', async () => {
      const result = await dynamicToolRegistry.execute(
        makeTool('nonexistent', {}),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('not found');
    });

    it('returns error when required parameter is missing', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'echo_test',
        command: 'echo {{file}}',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('echo_test', {}),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('Missing required parameter');
    });

    it('sanitizes arguments blocking semicolons with rm -rf', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'echo_test',
        command: 'echo {{file}}',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('echo_test', { file: 'foo; rm -rf /' }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('security check');
    });

    it('sanitizes arguments blocking backtick substitution', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'echo_test',
        command: 'echo {{file}}',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('echo_test', { file: '`whoami`' }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('security check');
    });

    it('sanitizes arguments blocking $() command substitution', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'echo_test',
        command: 'echo {{file}}',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('echo_test', { file: '$(whoami)' }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('security check');
    });

    it('sanitizes arguments blocking path traversal', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'echo_test',
        command: 'echo {{file}}',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('echo_test', { file: '../../etc/passwd' }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('security check');
    });

    it('sanitizes arguments blocking sudo injection', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'echo_test',
        command: 'echo {{file}}',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('echo_test', { file: 'foo; sudo rm /' }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('security check');
    });

    it('executes code-based tool (bash)', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'code_test',
        command: undefined,
        code: 'echo "code_output"',
        language: 'bash',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('code_test', {}),
        tmpDir,
      );
      expect(result.result).toBe('code_output');
    });

    it('executes code-based tool (node)', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'node_test',
        command: undefined,
        code: 'console.log("node_output")',
        language: 'node',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('node_test', {}),
        tmpDir,
      );
      expect(result.result).toBe('node_output');
    });

    it('executes code-based tool (python)', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'python_test',
        command: undefined,
        code: 'print("python_output")',
        language: 'python',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('python_test', {}),
        tmpDir,
      );
      expect(result.result).toBe('python_output');
    });

    it('executes code-based tool defaulting to bash when language is undefined', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'default_lang_test',
        command: undefined,
        code: 'echo "default_bash"',
        language: undefined,
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('default_lang_test', {}),
        tmpDir,
      );
      expect(result.result).toBe('default_bash');
    });

    it('throws for unsupported language in code execution', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'ruby_test',
        command: undefined,
        code: 'puts "hello"',
        language: 'ruby' as any,
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('ruby_test', {}),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('Unsupported language');
    });

    it('returns error when tool has neither command nor code', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'empty_tool',
        command: undefined,
        code: undefined,
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('empty_tool', {}),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('neither');
    });

    it('returns error when command execution fails', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'fail_test',
        command: 'exit 1',
      }));
      const result = await dynamicToolRegistry.execute(
        makeTool('fail_test', {}),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('Error executing dynamic tool');
    });
  });

  describe('persistence', () => {
    it('save and load round-trips persistent tools', () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'persistent_tool',
        persistent: true,
      }));
      dynamicToolRegistry.save(tmpDir);

      // Verify the file was written
      const toolsDir = path.join(tmpDir, '.calliope', 'tools');
      expect(fs.existsSync(path.join(toolsDir, 'persistent_tool.json'))).toBe(true);

      // Reset and reload
      dynamicToolRegistry.reset();
      dynamicToolRegistry.load(tmpDir);
      expect(dynamicToolRegistry.get('persistent_tool')).toBeDefined();
      expect(dynamicToolRegistry.get('persistent_tool')!.description).toBe('A test tool');
    });

    it('does not save non-persistent tools', () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'session_tool',
        persistent: false,
      }));
      dynamicToolRegistry.save(tmpDir);

      const toolsDir = path.join(tmpDir, '.calliope', 'tools');
      if (fs.existsSync(toolsDir)) {
        const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.json'));
        expect(files).toHaveLength(0);
      }
    });

    it('save cleans up removed tools', () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'persistent_tool',
        persistent: true,
      }));
      dynamicToolRegistry.save(tmpDir);

      dynamicToolRegistry.unregister('persistent_tool');
      dynamicToolRegistry.save(tmpDir);

      const toolsDir = path.join(tmpDir, '.calliope', 'tools');
      const files = fs.readdirSync(toolsDir).filter(f => f.endsWith('.json'));
      expect(files).toHaveLength(0);
    });

    it('load does not overwrite existing runtime tools', () => {
      // Save a persistent tool
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'persistent_tool',
        description: 'original',
        persistent: true,
      }));
      dynamicToolRegistry.save(tmpDir);
      dynamicToolRegistry.reset();

      // Register same name with different description at runtime
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'persistent_tool',
        description: 'runtime version',
      }));

      // Load should not overwrite
      dynamicToolRegistry.load(tmpDir);
      expect(dynamicToolRegistry.get('persistent_tool')!.description).toBe('runtime version');
    });

    it('load handles missing directory gracefully', () => {
      expect(() => dynamicToolRegistry.load('/nonexistent/path')).not.toThrow();
    });

    it('save handles non-existent tools directory during cleanup', () => {
      // Register a non-persistent tool and save — the tools dir won't be created
      // but the cleanup section should not crash
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'session_only',
        persistent: false,
      }));
      expect(() => dynamicToolRegistry.save(tmpDir)).not.toThrow();
      const toolsDir = path.join(tmpDir, '.calliope', 'tools');
      // Tools dir should still be created even if nothing persistent
      expect(fs.existsSync(toolsDir)).toBe(true);
    });

    it('save ignores non-JSON files when cleaning up', () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'persistent_tool',
        persistent: true,
      }));
      dynamicToolRegistry.save(tmpDir);

      // Place a non-JSON file in the tools directory
      const toolsDir = path.join(tmpDir, '.calliope', 'tools');
      fs.writeFileSync(path.join(toolsDir, 'readme.txt'), 'not a tool');

      // Save again — should not crash and should leave non-JSON file alone
      dynamicToolRegistry.save(tmpDir);
      expect(fs.existsSync(path.join(toolsDir, 'readme.txt'))).toBe(true);
    });

    it('load ignores non-JSON files in tools directory', () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'persistent_tool',
        persistent: true,
      }));
      dynamicToolRegistry.save(tmpDir);

      // Place a non-JSON file in the tools directory
      const toolsDir = path.join(tmpDir, '.calliope', 'tools');
      fs.writeFileSync(path.join(toolsDir, 'readme.txt'), 'not a tool');

      dynamicToolRegistry.reset();
      dynamicToolRegistry.load(tmpDir);
      // Should load only the JSON tool, not crash on .txt
      expect(dynamicToolRegistry.get('persistent_tool')).toBeDefined();
    });

    it('load skips malformed JSON files gracefully', () => {
      const toolsDir = path.join(tmpDir, '.calliope', 'tools');
      fs.mkdirSync(toolsDir, { recursive: true });
      fs.writeFileSync(path.join(toolsDir, 'bad_tool.json'), '{invalid json!!!');

      expect(() => dynamicToolRegistry.load(tmpDir)).not.toThrow();
      expect(dynamicToolRegistry.get('bad_tool')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Meta-tools
// ---------------------------------------------------------------------------

describe('executeMetaTool', () => {
  describe('create_tool', () => {
    it('creates a tool with command', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          name: 'greet',
          description: 'Says hello',
          parameters: '{"type":"object","properties":{"name":{"type":"string","description":"Name"}},"required":["name"]}',
          command: 'echo Hello {{name}}',
        }),
        tmpDir,
      );
      expect(result.isError).toBeUndefined();
      expect(result.result).toContain('created successfully');
      expect(dynamicToolRegistry.get('greet')).toBeDefined();
    });

    it('creates a persistent tool', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          name: 'greet',
          description: 'Says hello',
          parameters: '{}',
          command: 'echo hello',
          persistent: 'true',
        }),
        tmpDir,
      );
      expect(result.result).toContain('persistent');
    });

    it('returns error for invalid parameters JSON', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          name: 'greet',
          description: 'Says hello',
          parameters: 'not valid json{{{',
          command: 'echo hello',
        }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('valid JSON');
    });

    it('returns error when neither command nor code provided', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          name: 'greet',
          description: 'Says hello',
          parameters: '{}',
        }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('command');
    });

    it('returns error for reserved name', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          name: 'read_file',
          description: 'Reads a file',
          parameters: '{}',
          command: 'cat {{file}}',
        }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('reserved');
    });

    it('creates a tool with code instead of command', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          name: 'code_tool',
          description: 'A code tool',
          parameters: '{}',
          code: 'echo hello',
          language: 'bash',
        }),
        tmpDir,
      );
      expect(result.isError).toBeUndefined();
      expect(result.result).toContain('created successfully');
      const tool = dynamicToolRegistry.get('code_tool');
      expect(tool).toBeDefined();
      expect(tool!.code).toBe('echo hello');
      expect(tool!.command).toBeUndefined();
    });

    it('defaults parameters to empty object when not provided', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          name: 'no_params',
          description: 'No params provided',
          command: 'echo hi',
        }),
        tmpDir,
      );
      expect(result.isError).toBeUndefined();
      expect(result.result).toContain('created successfully');
    });

    it('returns error for invalid name', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          name: 'Bad Name!',
          description: 'Bad',
          parameters: '{}',
          command: 'echo hi',
        }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('Invalid tool name');
    });

    it('handles missing name and description arguments', async () => {
      const result = await executeMetaTool(
        makeTool('create_tool', {
          parameters: '{}',
          command: 'echo hi',
        }),
        tmpDir,
      );
      // Empty string name should fail validation
      expect(result.isError).toBe(true);
    });
  });

  describe('list_dynamic_tools', () => {
    it('returns message when no tools registered', async () => {
      const result = await executeMetaTool(
        makeTool('list_dynamic_tools', {}),
        tmpDir,
      );
      expect(result.result).toContain('No dynamic tools');
    });

    it('lists registered tools with details', async () => {
      dynamicToolRegistry.register(makeDynamicTool({ name: 'tool_a', description: 'Tool A', persistent: true }));
      dynamicToolRegistry.register(makeDynamicTool({ name: 'tool_b', description: 'Tool B' }));

      const result = await executeMetaTool(
        makeTool('list_dynamic_tools', {}),
        tmpDir,
      );
      expect(result.result).toContain('tool_a');
      expect(result.result).toContain('Tool A');
      expect(result.result).toContain('persistent');
      expect(result.result).toContain('tool_b');
      expect(result.result).toContain('session-only');
    });
  });

  describe('remove_tool', () => {
    it('removes an existing tool', async () => {
      dynamicToolRegistry.register(makeDynamicTool({ name: 'to_remove' }));
      const result = await executeMetaTool(
        makeTool('remove_tool', { name: 'to_remove' }),
        tmpDir,
      );
      expect(result.result).toContain('removed');
      expect(dynamicToolRegistry.get('to_remove')).toBeUndefined();
    });

    it('returns error for non-existent tool', async () => {
      const result = await executeMetaTool(
        makeTool('remove_tool', { name: 'nonexistent' }),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('not found');
    });

    it('handles missing name argument gracefully', async () => {
      const result = await executeMetaTool(
        makeTool('remove_tool', {}),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('not found');
    });
  });

  describe('unknown meta-tool', () => {
    it('returns error for unknown name', async () => {
      const result = await executeMetaTool(
        makeTool('unknown_meta', {}),
        tmpDir,
      );
      expect(result.isError).toBe(true);
      expect(result.result).toContain('Unknown meta-tool');
    });
  });
});

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

describe('exported helpers', () => {
  describe('getDynamicToolDefs', () => {
    it('returns meta-tool definitions', () => {
      const defs = getDynamicToolDefs();
      expect(defs).toHaveLength(3);
      const names = defs.map(d => d.name);
      expect(names).toContain('create_tool');
      expect(names).toContain('list_dynamic_tools');
      expect(names).toContain('remove_tool');
    });

    it('each definition has name, description, and parameters', () => {
      for (const def of getDynamicToolDefs()) {
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.parameters).toBeDefined();
        expect(def.parameters.type).toBe('object');
      }
    });
  });

  describe('isDynamicTool', () => {
    it('returns true for registered dynamic tool', () => {
      dynamicToolRegistry.register(makeDynamicTool({ name: 'check_me' }));
      expect(isDynamicTool('check_me')).toBe(true);
    });

    it('returns false for unregistered tool', () => {
      expect(isDynamicTool('not_registered')).toBe(false);
    });
  });

  describe('executeDynamicTool', () => {
    it('delegates to registry.execute', async () => {
      dynamicToolRegistry.register(makeDynamicTool({
        name: 'delegate_test',
        command: 'echo delegated',
      }));
      const result = await executeDynamicTool(
        makeTool('delegate_test', {}),
        tmpDir,
      );
      expect(result.result).toBe('delegated');
    });
  });

  describe('DYNAMIC_TOOL_NAMES', () => {
    it('contains the three meta-tool names', () => {
      expect(DYNAMIC_TOOL_NAMES).toContain('create_tool');
      expect(DYNAMIC_TOOL_NAMES).toContain('list_dynamic_tools');
      expect(DYNAMIC_TOOL_NAMES).toContain('remove_tool');
      expect(DYNAMIC_TOOL_NAMES).toHaveLength(3);
    });
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('security', () => {
  describe('dangerous command patterns', () => {
    const dangerousCases = [
      { label: 'rm -rf injection', value: 'foo; rm -rf /' },
      { label: 'sudo injection', value: 'foo; sudo reboot' },
      { label: 'dd injection', value: 'foo; dd if=/dev/zero of=/dev/sda' },
      { label: 'mkfs injection', value: 'foo; mkfs /dev/sda' },
      { label: 'command substitution $()', value: '$(cat /etc/passwd)' },
      { label: 'backtick substitution', value: '`cat /etc/passwd`' },
      { label: 'path traversal (unix)', value: '../../../etc/passwd' },
      { label: 'path traversal (windows)', value: '..\\..\\windows\\system32' },
    ];

    for (const { label, value } of dangerousCases) {
      it(`blocks ${label}`, async () => {
        dynamicToolRegistry.register(makeDynamicTool({
          name: 'sec_test',
          command: 'echo {{file}}',
        }));
        const result = await dynamicToolRegistry.execute(
          makeTool('sec_test', { file: value }),
          tmpDir,
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('security check');
        // Reset for next iteration
        dynamicToolRegistry.reset();
      });
    }
  });

  describe('name validation as security', () => {
    it('blocks path traversal in tool names', () => {
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: '../etc' }))).toThrow('Invalid tool name');
    });

    it('blocks shell metacharacters in tool names', () => {
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'tool;rm' }))).toThrow('Invalid tool name');
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'tool|cat' }))).toThrow('Invalid tool name');
      expect(() => dynamicToolRegistry.register(makeDynamicTool({ name: 'tool&bg' }))).toThrow('Invalid tool name');
    });
  });
});
