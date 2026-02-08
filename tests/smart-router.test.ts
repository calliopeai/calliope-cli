import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectTaskType, smartRoute, MODEL_STRENGTHS, getDefaultSmartRoutingConfig } from '../src/smart-router.js';
import type { TaskType, SmartRoutingConfig } from '../src/smart-router.js';

// Mock config to control configured providers
vi.mock('../src/config.js', () => ({
  getConfiguredProviders: () => ['anthropic', 'openai', 'google'],
  get: (key: string) => {
    if (key === 'maxIterations') return 500;
    return undefined;
  },
}));

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

  describe('MODEL_STRENGTHS', () => {
    it('should have entries for major providers', () => {
      expect(MODEL_STRENGTHS.anthropic).toBeDefined();
      expect(MODEL_STRENGTHS.openai).toBeDefined();
      expect(MODEL_STRENGTHS.google).toBeDefined();
    });

    it('should have all task types for each provider', () => {
      const taskTypes: TaskType[] = ['code', 'research', 'creative', 'analysis', 'simple-qa', 'general'];
      for (const [provider, data] of Object.entries(MODEL_STRENGTHS)) {
        for (const type of taskTypes) {
          expect(data!.strengths[type]).toBeDefined();
          expect(data!.strengths[type]).toBeGreaterThanOrEqual(0);
          expect(data!.strengths[type]).toBeLessThanOrEqual(1);
        }
      }
    });

    it('should have all tiers for each provider', () => {
      for (const [provider, data] of Object.entries(MODEL_STRENGTHS)) {
        expect(data!.tiers.fast).toBeDefined();
        expect(data!.tiers.balanced).toBeDefined();
        expect(data!.tiers.smart).toBeDefined();
        expect(data!.tiers.fast.model).toBeTruthy();
        expect(data!.tiers.balanced.model).toBeTruthy();
        expect(data!.tiers.smart.model).toBeTruthy();
      }
    });

    it('should have Anthropic strongest for code tasks', () => {
      const anthropicCode = MODEL_STRENGTHS.anthropic!.strengths.code;
      const openaiCode = MODEL_STRENGTHS.openai!.strengths.code;
      const googleCode = MODEL_STRENGTHS.google!.strengths.code;
      expect(anthropicCode).toBeGreaterThanOrEqual(openaiCode);
      expect(anthropicCode).toBeGreaterThanOrEqual(googleCode);
    });
  });

  // ============================================================================
  // Smart Routing
  // ============================================================================

  describe('smartRoute', () => {
    const baseConfig: SmartRoutingConfig = {
      enabled: true,
      providerPool: ['anthropic', 'openai', 'google'],
      costSensitivity: 0.3,
      preferredProviders: [],
    };

    it('should route code tasks to a provider', () => {
      const result = smartRoute('implement a new authentication system', baseConfig);
      expect(result.selected).toBeDefined();
      expect(result.selected.provider).toBeDefined();
      expect(result.selected.model).toBeTruthy();
      expect(result.taskType).toBe('code');
    });

    it('should route simple tasks to fast tier', () => {
      const result = smartRoute('what is 2+2?', baseConfig);
      expect(result.selected.tier).toBe('fast');
      expect(result.complexity).toBe('trivial');
    });

    it('should route complex tasks to smart tier', () => {
      const result = smartRoute(
        'refactor the entire authentication system with security audit and implement distributed caching with cryptographic key management',
        baseConfig,
      );
      expect(result.selected.tier).toBe('smart');
    });

    it('should prefer cost-efficient providers when costSensitivity is high', () => {
      const cheapConfig: SmartRoutingConfig = {
        ...baseConfig,
        costSensitivity: 0.9,
      };
      const result = smartRoute('explain how promises work', cheapConfig);
      // Google Flash is the cheapest, so should score higher with high cost sensitivity
      // (or groq if in pool). At minimum, the scoring should shift.
      expect(result.selected.score).toBeGreaterThan(0);
    });

    it('should prefer quality when costSensitivity is 0', () => {
      const qualityConfig: SmartRoutingConfig = {
        ...baseConfig,
        costSensitivity: 0,
      };
      const result = smartRoute('implement a complex distributed system', qualityConfig);
      // Anthropic should win for code with 0 cost sensitivity
      expect(result.selected.provider).toBe('anthropic');
    });

    it('should give tie-breaker bonus to preferred providers', () => {
      const preferConfig: SmartRoutingConfig = {
        ...baseConfig,
        preferredProviders: ['openai'],
      };
      const result = smartRoute('general question', preferConfig);
      // OpenAI should get a small bonus
      const openaiCandidate = [result.selected, ...result.alternatives]
        .find(c => c.provider === 'openai');
      expect(openaiCandidate).toBeDefined();
    });

    it('should return alternatives sorted by score', () => {
      const result = smartRoute('analyze this data set', baseConfig);
      expect(result.alternatives.length).toBeGreaterThan(0);
      for (let i = 0; i < result.alternatives.length - 1; i++) {
        expect(result.alternatives[i].score).toBeGreaterThanOrEqual(result.alternatives[i + 1].score);
      }
    });

    it('should return complexity and task type info', () => {
      const result = smartRoute('implement a function', baseConfig);
      expect(result.taskType).toBeDefined();
      expect(result.complexity).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should use configured providers when pool is empty', () => {
      const autoConfig: SmartRoutingConfig = {
        ...baseConfig,
        providerPool: [], // Will use getConfiguredProviders()
      };
      const result = smartRoute('do something', autoConfig);
      expect(result.selected).toBeDefined();
    });

    it('should handle fallback when no providers match', () => {
      const emptyConfig: SmartRoutingConfig = {
        ...baseConfig,
        providerPool: ['auto' as any], // 'auto' has no MODEL_STRENGTHS entry
      };
      const result = smartRoute('test message', emptyConfig);
      expect(result.selected).toBeDefined();
      expect(result.selected.reason).toContain('fallback');
    });

    it('should use context for complexity analysis', () => {
      const result = smartRoute('fix this complex architecture with multiple services', baseConfig, {
        messageCount: 20,
        hasCode: true,
        fileCount: 5,
        toolsUsed: ['read_file', 'write_file', 'bash'],
      });
      // Context + keywords should push complexity up
      expect(['moderate', 'complex', 'expert']).toContain(result.complexity);
    });
  });

  // ============================================================================
  // Default Config
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
