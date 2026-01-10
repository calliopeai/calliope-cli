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
