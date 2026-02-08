import { describe, it, expect } from 'vitest';
import {
  color,
  colors,
  getToolIcon,
  TOOL_ICONS,
  STATUS_ICONS,
  SPINNER_FRAMES,
  truncate,
  pad,
  formatNumber,
  formatBytes,
  formatDuration,
  formatCost,
  separator,
  indent,
} from '../src/styles.js';

describe('color function', () => {
  it('should apply single color', () => {
    const result = color('test', 'red');
    expect(result).toContain('\x1b[31m');
    expect(result).toContain('\x1b[0m');
    expect(result).toContain('test');
  });

  it('should apply multiple styles', () => {
    const result = color('test', 'bold', 'cyan');
    expect(result).toContain('\x1b[1m'); // bold
    expect(result).toContain('\x1b[36m'); // cyan
  });

  it('should return text unchanged with no styles', () => {
    expect(color('test')).toBe('test');
  });
});

describe('getToolIcon', () => {
  it('should return correct icon for known tools', () => {
    expect(getToolIcon('shell')).toBe('⚡');
    expect(getToolIcon('read_file')).toBe('📄');
    expect(getToolIcon('write_file')).toBe('✍️');
    expect(getToolIcon('think')).toBe('💭');
  });

  it('should return default icon for unknown tools', () => {
    expect(getToolIcon('unknown_tool')).toBe('⚙️');
  });
});

describe('truncate', () => {
  it('should not truncate short text', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should truncate long text with ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('should use custom suffix', () => {
    expect(truncate('hello world', 8, '…')).toBe('hello w…');
  });
});

describe('pad', () => {
  it('should pad left by default', () => {
    expect(pad('hi', 5)).toBe('hi   ');
  });

  it('should pad right', () => {
    expect(pad('hi', 5, 'right')).toBe('   hi');
  });

  it('should pad center', () => {
    expect(pad('hi', 6, 'center')).toBe('  hi  ');
  });

  it('should not pad if text is longer', () => {
    expect(pad('hello', 3)).toBe('hello');
  });
});

describe('formatNumber', () => {
  it('should format small numbers', () => {
    expect(formatNumber(500)).toBe('500');
  });

  it('should format thousands', () => {
    expect(formatNumber(1500)).toBe('1.5K');
    expect(formatNumber(50000)).toBe('50.0K');
  });

  it('should format millions', () => {
    expect(formatNumber(1500000)).toBe('1.5M');
  });
});

describe('formatBytes', () => {
  it('should format bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1500)).toBe('1.5 KB');
  });

  it('should format megabytes', () => {
    expect(formatBytes(1500000)).toBe('1.5 MB');
  });

  it('should format gigabytes', () => {
    expect(formatBytes(1500000000)).toBe('1.5 GB');
  });
});

describe('formatDuration', () => {
  it('should format milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('should format seconds', () => {
    expect(formatDuration(2500)).toBe('2.5s');
  });

  it('should format minutes', () => {
    expect(formatDuration(65000)).toBe('1m 5s');
  });

  it('should format hours', () => {
    expect(formatDuration(3665000)).toBe('1h 1m');
  });
});

describe('formatCost', () => {
  it('should format very small costs', () => {
    expect(formatCost(0.001)).toBe('<$0.01');
  });

  it('should format small costs with 3 decimals', () => {
    expect(formatCost(0.123)).toBe('$0.123');
  });

  it('should format dollar amounts with 2 decimals', () => {
    expect(formatCost(5.5)).toBe('$5.50');
  });
});

describe('separator', () => {
  it('should create separator of given width', () => {
    const sep = separator(10);
    expect(sep.length).toBe(10);
    expect(sep).toBe('──────────');
  });

  it('should use custom character', () => {
    expect(separator(5, '=')).toBe('=====');
  });
});

describe('indent', () => {
  it('should indent single line', () => {
    expect(indent('hello', 2)).toBe('  hello');
  });

  it('should indent multiple lines', () => {
    expect(indent('line1\nline2', 3)).toBe('   line1\n   line2');
  });
});

describe('constants', () => {
  it('should have all tool icons', () => {
    expect(TOOL_ICONS.shell).toBeDefined();
    expect(TOOL_ICONS.read_file).toBeDefined();
    expect(TOOL_ICONS.write_file).toBeDefined();
  });

  it('should have all status icons', () => {
    expect(STATUS_ICONS.success).toBe('✓');
    expect(STATUS_ICONS.error).toBe('✗');
    expect(STATUS_ICONS.warning).toBe('⚠️');
  });

  it('should have spinner frames', () => {
    expect(SPINNER_FRAMES.length).toBeGreaterThan(0);
  });

  it('should have all color codes', () => {
    expect(colors.reset).toBeDefined();
    expect(colors.red).toBeDefined();
    expect(colors.green).toBeDefined();
    expect(colors.cyan).toBeDefined();
  });
});

// ============================================================================
// Syntax highlighting (#30)
// ============================================================================

describe('syntax highlighting', () => {
  it('should highlight TypeScript keywords', async () => {
    const { highlightSyntax } = await import('../src/diff.js');
    const result = highlightSyntax('const foo = 42;', 'test.ts');
    expect(result).toContain('const');
    expect(result).toContain('42');
    // Should have ANSI codes injected
    expect(result.length).toBeGreaterThan('const foo = 42;'.length);
  });

  it('should highlight Python keywords', async () => {
    const { highlightSyntax } = await import('../src/diff.js');
    const result = highlightSyntax('def hello():', 'script.py');
    expect(result).toContain('def');
    expect(result.length).toBeGreaterThan('def hello():'.length);
  });

  it('should highlight strings', async () => {
    const { highlightSyntax } = await import('../src/diff.js');
    const result = highlightSyntax('const s = "hello";', 'test.js');
    expect(result).toContain('"hello"');
  });

  it('should not crash on unknown extensions', async () => {
    const { highlightSyntax } = await import('../src/diff.js');
    const result = highlightSyntax('some text', 'file.xyz');
    expect(result).toContain('some text');
  });

  it('should handle empty lines', async () => {
    const { highlightSyntax } = await import('../src/diff.js');
    const result = highlightSyntax('', 'test.ts');
    expect(result).toBe('');
  });
});

// ============================================================================
// Ollama context limits (#41)
// ============================================================================

describe('Ollama context limits', () => {
  it('should have context limits for common Ollama models', async () => {
    const { getModelContextLimit } = await import('../src/model-detection.js');
    // These should return specific limits, not the 32000 fallback
    expect(getModelContextLimit('ollama', 'llama3.1:70b')).toBe(128000);
    expect(getModelContextLimit('ollama', 'codellama:13b')).toBe(16384);
    expect(getModelContextLimit('ollama', 'deepseek-coder:33b')).toBe(128000);
    expect(getModelContextLimit('ollama', 'qwen2.5:7b')).toBe(128000);
    expect(getModelContextLimit('ollama', 'phi-3:mini')).toBe(128000);
  });

  it('should fall back to 32000 for unknown models', async () => {
    const { getModelContextLimit } = await import('../src/model-detection.js');
    expect(getModelContextLimit('ollama', 'unknown-model:7b')).toBe(32000);
  });
});
