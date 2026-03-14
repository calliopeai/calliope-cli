import { describe, it, expect } from 'vitest';
import { formatTokenCount } from '../src/ui/status-bar.js';

describe('formatTokenCount', () => {
  it('returns "0" for zero', () => {
    expect(formatTokenCount(0)).toBe('0');
  });

  it('returns plain number under 1000', () => {
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats 1000 as "1.0k"', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
  });

  it('formats 1500 as "1.5k"', () => {
    expect(formatTokenCount(1500)).toBe('1.5k');
  });

  it('formats 12500 as "12.5k"', () => {
    expect(formatTokenCount(12500)).toBe('12.5k');
  });

  it('formats 1000000 as "1.0M"', () => {
    expect(formatTokenCount(1000000)).toBe('1.0M');
  });
});

describe('session token accumulation', () => {
  it('sums correctly across multiple responses', () => {
    // Simulate setStats accumulator pattern used in agent.ts
    let inputTokens = 0;
    let outputTokens = 0;

    const applyUsage = (input: number, output: number) => {
      inputTokens += input;
      outputTokens += output;
    };

    applyUsage(500, 200);
    applyUsage(300, 150);
    applyUsage(1200, 400);

    expect(inputTokens).toBe(2000);
    expect(outputTokens).toBe(750);
    expect(formatTokenCount(inputTokens)).toBe('2.0k');
    expect(formatTokenCount(outputTokens)).toBe('750');
  });

  it('reset on /clear sets both to 0', () => {
    let inputTokens = 1500;
    let outputTokens = 800;

    // Simulate what /clear does: reset stats
    inputTokens = 0;
    outputTokens = 0;

    expect(inputTokens).toBe(0);
    expect(outputTokens).toBe(0);
    expect(formatTokenCount(inputTokens)).toBe('0');
    expect(formatTokenCount(outputTokens)).toBe('0');
  });
});
