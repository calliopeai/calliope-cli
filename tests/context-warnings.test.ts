/**
 * Tests for context warnings module
 */

import { describe, it, expect } from 'vitest';
import {
  getContextLimit,
  getContextStatus,
  checkContextWarning,
  getContextSuggestions,
  formatTokenCount,
  getContextColor,
  WARNING_THRESHOLDS,
} from '../src/context-warnings.js';

describe('getContextLimit', () => {
  it('should return correct limit for Claude models', () => {
    expect(getContextLimit('claude-sonnet-4-20250514')).toBe(200000);
    expect(getContextLimit('claude-opus-4-20250514')).toBe(200000);
    expect(getContextLimit('claude-3-5-sonnet')).toBe(200000);
  });

  it('should return correct limit for GPT models', () => {
    expect(getContextLimit('gpt-4o')).toBe(128000);
    expect(getContextLimit('gpt-4-turbo-preview')).toBe(128000);
    expect(getContextLimit('gpt-4-0613')).toBe(8192);
  });

  it('should return correct limit for Gemini models', () => {
    expect(getContextLimit('gemini-2.0-flash')).toBe(1000000);
    expect(getContextLimit('gemini-1.5-pro-latest')).toBe(1000000);
  });

  it('should return default for unknown models', () => {
    expect(getContextLimit('unknown-model')).toBe(32000);
  });
});

describe('getContextStatus', () => {
  it('should return none level when under 50%', () => {
    const status = getContextStatus(50000, 'claude-sonnet-4');
    expect(status.level).toBe('none');
    expect(status.percentage).toBe(0.25);
    expect(status.message).toBeUndefined();
  });

  it('should return notice level at 50-75%', () => {
    const status = getContextStatus(110000, 'claude-sonnet-4');
    expect(status.level).toBe('notice');
    expect(status.percentage).toBe(0.55);
  });

  it('should return warning level at 75-90%', () => {
    const status = getContextStatus(160000, 'claude-sonnet-4');
    expect(status.level).toBe('warning');
    expect(status.message).toContain('Consider');
    expect(status.message).toContain('summarize');
  });

  it('should return critical level at 90%+', () => {
    const status = getContextStatus(185000, 'claude-sonnet-4');
    expect(status.level).toBe('critical');
    expect(status.message).toContain('⚠️');
    expect(status.message).toContain('/clear');
  });
});

describe('checkContextWarning', () => {
  it('should return message when crossing into warning', () => {
    // From 70% to 80%
    const previous = 140000; // 70%
    const current = 160000;  // 80%
    const message = checkContextWarning(current, previous, 'claude-sonnet-4');
    
    expect(message).toBeDefined();
    expect(message).toContain('summarize');
  });

  it('should return undefined when staying in same level', () => {
    const previous = 160000; // 80%
    const current = 165000;  // 82.5%
    const message = checkContextWarning(current, previous, 'claude-sonnet-4');
    
    expect(message).toBeUndefined();
  });

  it('should return message when crossing into critical', () => {
    const previous = 175000; // 87.5%
    const current = 185000;  // 92.5%
    const message = checkContextWarning(current, previous, 'claude-sonnet-4');
    
    expect(message).toBeDefined();
    expect(message).toContain('⚠️');
  });

  it('should not warn when decreasing', () => {
    // Going from critical to warning (after compacting)
    const previous = 185000;
    const current = 100000;
    const message = checkContextWarning(current, previous, 'claude-sonnet-4');
    
    // No warning when improving
    expect(message).toBeUndefined();
  });
});

describe('getContextSuggestions', () => {
  it('should return clear suggestion at critical level', () => {
    const suggestions = getContextSuggestions(0.95);
    expect(suggestions.some(s => s.includes('/clear'))).toBe(true);
  });

  it('should return compact suggestion at warning level', () => {
    const suggestions = getContextSuggestions(0.80);
    expect(suggestions.some(s => s.includes('compact'))).toBe(true);
  });

  it('should return summary suggestion at notice level', () => {
    const suggestions = getContextSuggestions(0.55);
    expect(suggestions.some(s => s.includes('summary'))).toBe(true);
  });

  it('should return empty array below notice', () => {
    const suggestions = getContextSuggestions(0.30);
    expect(suggestions).toHaveLength(0);
  });
});

describe('formatTokenCount', () => {
  it('should format thousands with K', () => {
    expect(formatTokenCount(5000)).toBe('5.0K');
    expect(formatTokenCount(12500)).toBe('12.5K');
  });

  it('should format millions with M', () => {
    expect(formatTokenCount(1000000)).toBe('1.0M');
    expect(formatTokenCount(2500000)).toBe('2.5M');
  });

  it('should show raw number below 1000', () => {
    expect(formatTokenCount(500)).toBe('500');
    expect(formatTokenCount(999)).toBe('999');
  });
});

describe('getContextColor', () => {
  it('should return green below warning threshold', () => {
    expect(getContextColor(0.5)).toBe('green');
    expect(getContextColor(0.74)).toBe('green');
  });

  it('should return yellow at warning threshold', () => {
    expect(getContextColor(0.75)).toBe('yellow');
    expect(getContextColor(0.89)).toBe('yellow');
  });

  it('should return red at critical threshold', () => {
    expect(getContextColor(0.9)).toBe('red');
    expect(getContextColor(0.99)).toBe('red');
  });
});
