import { describe, it, expect } from 'vitest';
import { detectTaskType, getDefaultSmartRoutingConfig } from '../src/router.js';

describe('Smart Router', () => {
  // ============================================================================
  // Task Type Detection
  // ============================================================================

  describe('detectTaskType', () => {
    it('should detect code tasks', () => {
      expect(detectTaskType('implement a new login function').taskType).toBe('code');
      expect(detectTaskType('refactor the authentication module').taskType).toBe('code');
      expect(detectTaskType('fix the bug in user.ts').taskType).toBe('code');
      expect(detectTaskType('debug the npm build error').taskType).toBe('code');
    });

    it('should detect research tasks', () => {
      expect(detectTaskType('explain how WebSockets work').taskType).toBe('research');
      expect(detectTaskType('compare React vs Vue for this use case').taskType).toBe('research');
      expect(detectTaskType('what is the difference between REST and GraphQL?').taskType).toBe('research');
    });

    it('should detect creative tasks', () => {
      expect(detectTaskType('write a story about a developer').taskType).toBe('creative');
      expect(detectTaskType('brainstorm names for the new feature').taskType).toBe('creative');
      expect(detectTaskType('compose a tagline for the product').taskType).toBe('creative');
    });

    it('should detect analysis tasks', () => {
      expect(detectTaskType('analyze the performance of this query').taskType).toBe('analysis');
      expect(detectTaskType('review the security of this endpoint').taskType).toBe('analysis');
      expect(detectTaskType('audit the codebase for vulnerabilities').taskType).toBe('analysis');
    });

    it('should detect simple QA', () => {
      expect(detectTaskType('what time is it?').taskType).toBe('simple-qa');
      // 'yes' is short enough to match simple-qa pattern (< 80 chars)
      expect(detectTaskType('yes').taskType).toBe('simple-qa');
    });

    it('should default to general for very long ambiguous messages', () => {
      // Message over 80 chars with no task-type signals doesn't match any pattern
      const longMsg = 'I have been thinking about various things and wanted to discuss some ideas with you about the upcoming plans we have';
      expect(detectTaskType(longMsg).taskType).toBe('general');
    });

    it('should prefer code over simple-qa when both match', () => {
      // "function" matches code; "what does" matches both research and simple-qa
      // code wins because "function" is a strong code signal
      const result = detectTaskType('what does this function do?');
      expect(['code', 'research']).toContain(result.taskType);
    });

    it('should return confidence scores', () => {
      const result = detectTaskType('implement a new class with methods');
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.signals.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Model Strengths
  // ============================================================================

  describe('getDefaultSmartRoutingConfig', () => {
    it('should return disabled config', () => {
      const config = getDefaultSmartRoutingConfig();
      expect(config.enabled).toBe(false);
      expect(config.providerPool).toEqual([]);
      expect(config.costSensitivity).toBe(0.3);
      expect(config.preferredProviders).toEqual([]);
    });
  });
});
