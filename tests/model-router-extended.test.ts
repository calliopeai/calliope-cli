/** Task complexity analysis; live selection is tested in live-routing.test.ts. */
import { describe, it, expect } from 'vitest';
import { analyzeComplexity } from '../src/router.js';

// ============================================================================
// analyzeComplexity — edge cases
// ============================================================================

describe('analyzeComplexity', () => {
  describe('message length signals', () => {
    it('should score short messages as less complex', () => {
      const result = analyzeComplexity('fix typo');
      expect(result.signals).toContain('short message');
      expect(result.complexity).toBe('trivial');
    });

    it('should score long messages as more complex', () => {
      const longMsg = Array(101).fill('word').join(' ');
      const result = analyzeComplexity(longMsg);
      expect(result.signals).toContain('long message');
    });

    it('should not add length signal for mid-length messages', () => {
      // Between 10 and 100 words — no length signal
      const midMsg = Array(50).fill('word').join(' ');
      const result = analyzeComplexity(midMsg);
      expect(result.signals).not.toContain('short message');
      expect(result.signals).not.toContain('long message');
    });
  });

  describe('simple task patterns', () => {
    it('should detect "what" keyword', () => {
      const result = analyzeComplexity('what is this variable');
      expect(result.signals).toContain('simple task keywords');
    });

    it('should detect "just" keyword', () => {
      const result = analyzeComplexity('just rename the file to something better');
      expect(result.signals).toContain('simple task keywords');
    });

    it('should detect "format" keyword', () => {
      const result = analyzeComplexity('format the code with prettier please');
      expect(result.signals).toContain('simple task keywords');
    });

    it('should detect "typo" keyword', () => {
      const result = analyzeComplexity('there is a typo in the readme that needs fixing');
      expect(result.signals).toContain('simple task keywords');
    });
  });

  describe('complex task patterns', () => {
    it('should detect "refactor" keyword', () => {
      const result = analyzeComplexity('refactor the authentication module');
      expect(result.signals).toContain('complex task keywords');
    });

    it('should detect "security" keyword in qualifying phrase', () => {
      const result = analyzeComplexity('perform a security review of this API endpoint');
      expect(result.signals).toContain('complex task keywords');
    });

    it('should not detect bare "security" as complex', () => {
      const result = analyzeComplexity('add a security header');
      expect(result.signals).not.toContain('complex task keywords');
    });

    it('should detect "performance" keyword', () => {
      const result = analyzeComplexity('optimize the performance of the database queries');
      expect(result.signals).toContain('complex task keywords');
    });

    it('should detect "debug" keyword', () => {
      const result = analyzeComplexity('debug this intermittent error in production');
      expect(result.signals).toContain('complex task keywords');
    });

    it('should detect "multiple files" pattern', () => {
      const result = analyzeComplexity('update multiple files in the codebase');
      expect(result.signals).toContain('complex task keywords');
    });

    it('should detect "several components" pattern', () => {
      const result = analyzeComplexity('modify several components in the UI layer');
      expect(result.signals).toContain('complex task keywords');
    });

    it('should accumulate multiple complex signals', () => {
      const result = analyzeComplexity('refactor and optimize the security across multiple modules');
      // Should have multiple matches of complex keywords
      const complexCount = result.signals.filter(s => s === 'complex task keywords').length;
      expect(complexCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('expert task patterns', () => {
    it('should detect "cryptograph" keyword', () => {
      const result = analyzeComplexity('implement a cryptographic signing mechanism');
      expect(result.signals).toContain('expert domain keywords');
    });

    it('should detect "concurrency" keyword', () => {
      const result = analyzeComplexity('fix the concurrency issue in the worker pool');
      expect(result.signals).toContain('expert domain keywords');
    });

    it('should detect "distributed" keyword', () => {
      const result = analyzeComplexity('design a distributed caching system');
      expect(result.signals).toContain('expert domain keywords');
    });

    it('should detect "algorithm" keyword', () => {
      const result = analyzeComplexity('implement a graph algorithm for shortest path');
      expect(result.signals).toContain('expert domain keywords');
    });

    it('should detect "data structure" keyword', () => {
      const result = analyzeComplexity('implement a custom data structure for the index');
      expect(result.signals).toContain('expert domain keywords');
    });

    it('should detect "machine learning" keyword', () => {
      const result = analyzeComplexity('train a machine learning model on the dataset');
      expect(result.signals).toContain('expert domain keywords');
    });

    it('should detect "security audit" keyword', () => {
      const result = analyzeComplexity('perform a security audit of the entire codebase');
      expect(result.signals).toContain('expert domain keywords');
    });

    it('should detect "vulnerability" keyword', () => {
      const result = analyzeComplexity('check for vulnerability in the auth flow');
      expect(result.signals).toContain('expert domain keywords');
    });
  });

  describe('context-based adjustments', () => {
    it('should add signal for long conversation', () => {
      const result = analyzeComplexity('continue working on this', { messageCount: 15 });
      expect(result.signals).toContain('long conversation');
    });

    it('should not add long conversation signal for short conversations', () => {
      const result = analyzeComplexity('hello', { messageCount: 5 });
      expect(result.signals).not.toContain('long conversation');
    });

    it('should add signal when code is involved', () => {
      const result = analyzeComplexity('update the code', { hasCode: true });
      expect(result.signals).toContain('involves code');
    });

    it('should not add code signal when hasCode is false', () => {
      const result = analyzeComplexity('update the code', { hasCode: false });
      expect(result.signals).not.toContain('involves code');
    });

    it('should add signal for multiple files', () => {
      const result = analyzeComplexity('update this', { fileCount: 5 });
      expect(result.signals).toContain('multiple files');
    });

    it('should not add file signal for few files', () => {
      const result = analyzeComplexity('update this', { fileCount: 2 });
      expect(result.signals).not.toContain('multiple files');
    });

    it('should add signal for multiple tools', () => {
      const result = analyzeComplexity('do something', { toolsUsed: ['read_file', 'write_file', 'shell'] });
      expect(result.signals).toContain('multiple tools needed');
    });

    it('should not add tools signal for few tools', () => {
      const result = analyzeComplexity('do something', { toolsUsed: ['read_file'] });
      expect(result.signals).not.toContain('multiple tools needed');
    });

    it('should combine all context signals', () => {
      const result = analyzeComplexity('update this', {
        messageCount: 20,
        hasCode: true,
        fileCount: 10,
        toolsUsed: ['read_file', 'write_file', 'shell'],
      });
      expect(result.signals).toContain('long conversation');
      expect(result.signals).toContain('involves code');
      expect(result.signals).toContain('multiple files');
      expect(result.signals).toContain('multiple tools needed');
    });
  });

  describe('complexity mapping', () => {
    it('should map low scores to trivial', () => {
      // Short message + simple keywords = score -2 => trivial
      const result = analyzeComplexity('fix typo');
      expect(result.complexity).toBe('trivial');
    });

    it('should map moderate scores correctly', () => {
      // "refactor" gives +2 (complex keyword), needs enough words (>10) to avoid short message penalty
      // and context to push into moderate range (score 2-3)
      const result = analyzeComplexity(
        'please refactor the authentication module to use a new pattern with better error handling throughout',
        { hasCode: true },
      );
      expect(['moderate', 'complex']).toContain(result.complexity);
    });

    it('should map expert-level scores', () => {
      // Multiple expert + complex keywords
      const result = analyzeComplexity(
        'implement distributed cryptographic concurrency with machine learning algorithms for security audit',
      );
      expect(result.complexity).toBe('expert');
    });
  });

  describe('confidence calculation', () => {
    it('should have higher confidence with more signals', () => {
      const simple = analyzeComplexity('hi');
      const complex = analyzeComplexity(
        'refactor and optimize the security of the distributed cryptographic system across multiple modules',
        { messageCount: 20, hasCode: true, fileCount: 10, toolsUsed: ['a', 'b', 'c'] },
      );
      expect(complex.confidence).toBeGreaterThan(simple.confidence);
    });

    it('should cap confidence at 0.9', () => {
      const result = analyzeComplexity(
        'refactor and optimize the security of the distributed cryptographic system',
        { messageCount: 20, hasCode: true, fileCount: 10, toolsUsed: ['a', 'b', 'c'] },
      );
      expect(result.confidence).toBeLessThanOrEqual(0.9);
    });

    it('should have minimum confidence of 0.5 with no signals beyond base', () => {
      // A mid-length message with no pattern matches => no signals
      const midMsg = Array(50).fill('lorem').join(' ');
      const result = analyzeComplexity(midMsg);
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });
  });
});
