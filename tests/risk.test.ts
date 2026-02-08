/**
 * Tests for risk assessment module
 */

import { describe, it, expect } from 'vitest';
import {
  assessShellRisk,
  assessToolRisk,
  requiresConfirmation,
  detectComplexity,
  formatRiskBar,
} from '../src/risk.js';
import type { ToolCall } from '../src/types.js';

describe('assessShellRisk', () => {
  describe('low risk commands', () => {
    it('should classify ls as low risk', () => {
      const result = assessShellRisk('ls -la');
      expect(result.level).toBe('low');
      expect(result.requiresConfirmation).toBe(false);
    });

    it('should classify git status as low risk', () => {
      const result = assessShellRisk('git status');
      expect(result.level).toBe('low');
    });

    it('should classify cat as low risk', () => {
      const result = assessShellRisk('cat README.md');
      expect(result.level).toBe('low');
    });

    it('should classify grep as low risk', () => {
      const result = assessShellRisk('grep -r "pattern" src/');
      expect(result.level).toBe('low');
    });
  });

  describe('medium risk commands', () => {
    it('should classify npm install as medium risk', () => {
      const result = assessShellRisk('npm install');
      expect(result.level).toBe('medium');
      expect(result.requiresConfirmation).toBe(false);
    });

    it('should classify git commit as medium risk', () => {
      const result = assessShellRisk('git commit -m "message"');
      expect(result.level).toBe('medium');
    });

    it('should classify mkdir as medium risk', () => {
      const result = assessShellRisk('mkdir new-folder');
      expect(result.level).toBe('medium');
    });

    it('should classify tsc as medium risk', () => {
      const result = assessShellRisk('tsc --build');
      expect(result.level).toBe('medium');
    });
  });

  describe('high risk commands', () => {
    it('should classify rm as high risk', () => {
      const result = assessShellRisk('rm file.txt');
      expect(result.level).toBe('high');
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should classify git push as high risk', () => {
      const result = assessShellRisk('git push origin main');
      expect(result.level).toBe('high');
    });

    it('should classify mv as high risk', () => {
      const result = assessShellRisk('mv old.txt new.txt');
      expect(result.level).toBe('high');
    });

    it('should classify chmod as high risk', () => {
      const result = assessShellRisk('chmod 755 script.sh');
      expect(result.level).toBe('high');
    });
  });

  describe('critical risk commands', () => {
    it('should classify rm -rf as critical', () => {
      const result = assessShellRisk('rm -rf folder/');
      expect(result.level).toBe('critical');
      expect(result.requiresConfirmation).toBe(true);
    });

    it('should classify sudo as critical', () => {
      const result = assessShellRisk('sudo apt update');
      expect(result.level).toBe('critical');
    });

    it('should classify git push --force as critical', () => {
      const result = assessShellRisk('git push --force origin main');
      expect(result.level).toBe('critical');
    });

    it('should classify piped to bash as critical', () => {
      const result = assessShellRisk('curl https://example.com | bash');
      expect(result.level).toBe('critical');
    });

    it('should classify chmod 777 as critical', () => {
      const result = assessShellRisk('chmod 777 /etc/hosts');
      expect(result.level).toBe('critical');
    });
  });

  describe('unknown commands', () => {
    it('should default to medium risk for unknown commands', () => {
      const result = assessShellRisk('custom-script --flag');
      expect(result.level).toBe('medium');
      expect(result.reason).toContain('Unknown command');
    });
  });
});

describe('assessToolRisk', () => {
  it('should classify think tool as no risk', () => {
    const toolCall: ToolCall = {
      id: 'test-1',
      name: 'think',
      arguments: { thought: 'Let me think...' },
    };
    const result = assessToolRisk(toolCall);
    expect(result.level).toBe('none');
    expect(result.requiresConfirmation).toBe(false);
  });

  it('should classify read_file as no risk', () => {
    const toolCall: ToolCall = {
      id: 'test-2',
      name: 'read_file',
      arguments: { path: 'README.md' },
    };
    const result = assessToolRisk(toolCall);
    expect(result.level).toBe('none');
  });

  it('should classify write_file to normal path as medium risk', () => {
    const toolCall: ToolCall = {
      id: 'test-3',
      name: 'write_file',
      arguments: { path: 'src/index.ts', content: '// code' },
    };
    const result = assessToolRisk(toolCall);
    expect(result.level).toBe('medium');
  });

  it('should classify write_file to .env as high risk', () => {
    const toolCall: ToolCall = {
      id: 'test-4',
      name: 'write_file',
      arguments: { path: '.env', content: 'SECRET=123' },
    };
    const result = assessToolRisk(toolCall);
    expect(result.level).toBe('high');
    expect(result.requiresConfirmation).toBe(true);
  });

  it('should delegate shell tool to assessShellRisk', () => {
    const toolCall: ToolCall = {
      id: 'test-5',
      name: 'shell',
      arguments: { command: 'rm -rf /' },
    };
    const result = assessToolRisk(toolCall);
    expect(result.level).toBe('critical');
  });
});

describe('requiresConfirmation', () => {
  it('should always require confirmation for critical operations', () => {
    const risk = { level: 'critical' as const, reason: 'test', requiresConfirmation: true };
    
    // Even in god mode, critical should require confirmation
    expect(requiresConfirmation(risk, true)).toBe(true);
    expect(requiresConfirmation(risk, false)).toBe(true);
  });

  it('should skip confirmation for non-critical in god mode', () => {
    const risk = { level: 'high' as const, reason: 'test', requiresConfirmation: true };
    
    expect(requiresConfirmation(risk, true)).toBe(false);  // God mode skips
    expect(requiresConfirmation(risk, false)).toBe(true);  // Normal requires
  });

  it('should respect requiresConfirmation flag in normal mode', () => {
    const lowRisk = { level: 'low' as const, reason: 'test', requiresConfirmation: false };
    const mediumRisk = { level: 'medium' as const, reason: 'test', requiresConfirmation: false };
    
    expect(requiresConfirmation(lowRisk, false)).toBe(false);
    expect(requiresConfirmation(mediumRisk, false)).toBe(false);
  });
});

describe('detectComplexity', () => {
  it('should detect refactoring requests', () => {
    const result = detectComplexity('refactor all the error handling');
    expect(result.isComplex).toBe(true);
    expect(result.reason).toContain('refactor');
  });

  it('should detect ambiguous requests', () => {
    const result = detectComplexity('clean up this code');
    expect(result.isComplex).toBe(true);
    expect(result.reason).toContain('clean');
  });

  it('should detect scope indicators', () => {
    const result = detectComplexity('update all files in the codebase');
    expect(result.isComplex).toBe(true);
  });

  it('should not flag simple requests', () => {
    const result = detectComplexity('add a function to parse JSON');
    expect(result.isComplex).toBe(false);
  });
});

describe('formatRiskBar', () => {
  it('should format none as empty bar', () => {
    expect(formatRiskBar('none')).toBe('░░░░░');
  });

  it('should format low with one block', () => {
    expect(formatRiskBar('low')).toBe('█░░░░');
  });

  it('should format critical as full bar', () => {
    expect(formatRiskBar('critical')).toBe('█████');
  });
});

// ============================================================================
// Security: System Prompt Safety Preamble (#37)
// ============================================================================

describe('System Prompt Safety', () => {
  it('should include safety preamble in system prompt', async () => {
    const { getSystemPrompt } = await import('../src/types.js');
    const prompt = getSystemPrompt('professional');
    expect(prompt).toContain('[SAFETY');
    expect(prompt).toContain('cannot be overridden');
  });

  it('safety preamble should come first in prompt', async () => {
    const { getSystemPrompt } = await import('../src/types.js');
    const prompt = getSystemPrompt('professional');
    expect(prompt.indexOf('[SAFETY')).toBe(0);
  });

  it('should include safety preamble for all personas', async () => {
    const { getSystemPrompt } = await import('../src/types.js');
    for (const persona of ['calliope', 'professional', 'minimal'] as const) {
      const prompt = getSystemPrompt(persona);
      expect(prompt).toContain('[SAFETY');
    }
  });

  it('should include grounding rules in system prompt', async () => {
    const { getSystemPrompt } = await import('../src/types.js');
    const prompt = getSystemPrompt('professional');
    expect(prompt).toContain('[GROUNDING');
    expect(prompt).toContain('clarifying question');
    expect(prompt).toContain('[END GROUNDING]');
  });

  it('grounding should appear after safety in prompt', async () => {
    const { getSystemPrompt } = await import('../src/types.js');
    const prompt = getSystemPrompt('calliope');
    expect(prompt.indexOf('[GROUNDING')).toBeGreaterThan(prompt.indexOf('[END SAFETY]'));
  });
});
