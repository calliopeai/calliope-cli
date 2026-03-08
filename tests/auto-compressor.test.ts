/**
 * Tests for auto-compressor module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  configureAutoCompressor,
  getAutoCompressorConfig,
  shouldCompress,
  autoCompress,
  llmSummarize,
} from '../src/auto-compressor.js';
import type { Message as LLMMessage } from '../src/types.js';

vi.mock('../src/providers/index.js', () => ({
  chat: vi.fn(),
  selectProvider: vi.fn((p: string) => p),
  getAvailableProviders: vi.fn(() => []),
}));

import { chat } from '../src/providers/index.js';

const mockedChat = vi.mocked(chat);

const makeMessages = (count: number): LLMMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i} with some content to take up tokens. `.repeat(50),
  }));

describe('auto-compressor', () => {
  beforeEach(() => {
    // Reset config to defaults before each test
    configureAutoCompressor({
      enabled: true,
      triggerThreshold: 75,
      targetThreshold: 50,
      preserveRecent: 10,
      useLlm: true,
      compressionModel: undefined,
    });
    vi.clearAllMocks();
  });

  // =========================================================================
  // configureAutoCompressor
  // =========================================================================

  describe('configureAutoCompressor', () => {
    it('updates config with partial options', () => {
      configureAutoCompressor({ triggerThreshold: 80 });
      const cfg = getAutoCompressorConfig();
      expect(cfg.triggerThreshold).toBe(80);
      expect(cfg.enabled).toBe(true); // unchanged
    });

    it('updates multiple fields at once', () => {
      configureAutoCompressor({ enabled: false, preserveRecent: 5 });
      const cfg = getAutoCompressorConfig();
      expect(cfg.enabled).toBe(false);
      expect(cfg.preserveRecent).toBe(5);
    });
  });

  // =========================================================================
  // getAutoCompressorConfig
  // =========================================================================

  describe('getAutoCompressorConfig', () => {
    it('returns a copy of config (not a reference)', () => {
      const cfg1 = getAutoCompressorConfig();
      cfg1.triggerThreshold = 999;
      const cfg2 = getAutoCompressorConfig();
      expect(cfg2.triggerThreshold).toBe(75);
    });

    it('returns default values initially', () => {
      const cfg = getAutoCompressorConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.triggerThreshold).toBe(75);
      expect(cfg.targetThreshold).toBe(50);
      expect(cfg.preserveRecent).toBe(10);
      expect(cfg.useLlm).toBe(true);
    });
  });

  // =========================================================================
  // shouldCompress
  // =========================================================================

  describe('shouldCompress', () => {
    it('returns true when tokens exceed threshold', () => {
      // threshold = 75% of 1000 = 750
      expect(shouldCompress(800, 1000)).toBe(true);
    });

    it('returns false when tokens are under threshold', () => {
      expect(shouldCompress(500, 1000)).toBe(false);
    });

    it('returns true when tokens exactly equal threshold', () => {
      expect(shouldCompress(750, 1000)).toBe(true);
    });

    it('returns false when disabled', () => {
      configureAutoCompressor({ enabled: false });
      expect(shouldCompress(800, 1000)).toBe(false);
    });

    it('respects custom trigger threshold', () => {
      configureAutoCompressor({ triggerThreshold: 90 });
      expect(shouldCompress(800, 1000)).toBe(false);
      expect(shouldCompress(900, 1000)).toBe(true);
    });
  });

  // =========================================================================
  // autoCompress - under threshold
  // =========================================================================

  describe('autoCompress - under threshold', () => {
    it('returns compressed:false when under threshold', async () => {
      const messages: LLMMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];
      const result = await autoCompress(messages, 1_000_000, 'anthropic');
      expect(result.compressed).toBe(false);
      expect(result.method).toBe('none');
      expect(result.messages).toBe(messages); // same reference
      expect(result.summarizedCount).toBe(0);
    });

    it('returns compressed:false when disabled', async () => {
      configureAutoCompressor({ enabled: false });
      const messages = makeMessages(100);
      const result = await autoCompress(messages, 100, 'anthropic');
      expect(result.compressed).toBe(false);
      expect(result.method).toBe('none');
    });
  });

  // =========================================================================
  // autoCompress - over threshold with heuristic fallback
  // =========================================================================

  describe('autoCompress - over threshold (heuristic fallback)', () => {
    it('returns compressed:true with heuristic method when LLM fails', async () => {
      mockedChat.mockRejectedValue(new Error('API error'));

      const messages = makeMessages(30);
      // Use a small context limit so tokens exceed 75%
      const result = await autoCompress(messages, 100, 'anthropic');

      expect(result.compressed).toBe(true);
      expect(result.method).toBe('heuristic');
      expect(result.summarizedCount).toBeGreaterThan(0);
      expect(result.summary).toBeDefined();
      expect(result.compressedTokens).toBeLessThan(result.originalTokens);
    });

    it('returns compressed:true with heuristic when useLlm is false', async () => {
      configureAutoCompressor({ useLlm: false });

      const messages = makeMessages(30);
      const result = await autoCompress(messages, 100, 'anthropic');

      expect(result.compressed).toBe(true);
      expect(result.method).toBe('heuristic');
      expect(mockedChat).not.toHaveBeenCalled();
    });

    it('returns compressed:true with llm method when LLM succeeds', async () => {
      mockedChat.mockResolvedValue({
        content: 'This is a summary of the conversation covering key points and decisions.',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 50,
      });

      const messages = makeMessages(30);
      const result = await autoCompress(messages, 100, 'anthropic');

      expect(result.compressed).toBe(true);
      expect(result.method).toBe('llm');
      expect(result.summary).toContain('summary of the conversation');
    });
  });

  // =========================================================================
  // autoCompress - preserves recent messages
  // =========================================================================

  describe('autoCompress - preserves recent messages', () => {
    it('keeps the last N non-system messages', async () => {
      configureAutoCompressor({ preserveRecent: 4, useLlm: false });

      const messages = makeMessages(20);
      const result = await autoCompress(messages, 100, 'anthropic');

      expect(result.compressed).toBe(true);
      // The last 4 non-system messages should be preserved
      const nonSystemResult = result.messages.filter(m => !m.content.toString().includes('[Auto-compressed') && m.role !== 'system');
      expect(nonSystemResult.length).toBe(4);
      // They should be the last 4 from the original
      expect(nonSystemResult[0].content).toBe(messages[16].content);
      expect(nonSystemResult[3].content).toBe(messages[19].content);
    });

    it('returns compressed:false when all messages must be preserved', async () => {
      configureAutoCompressor({ preserveRecent: 100 });

      const messages = makeMessages(5);
      // Even with a tiny limit, if preserveRecent > message count, nothing to summarize
      const result = await autoCompress(messages, 1, 'anthropic');

      expect(result.compressed).toBe(false);
      expect(result.method).toBe('none');
    });
  });

  // =========================================================================
  // autoCompress - preserves system messages
  // =========================================================================

  describe('autoCompress - preserves system messages', () => {
    it('keeps system messages in compressed output', async () => {
      configureAutoCompressor({ preserveRecent: 2, useLlm: false });

      const messages: LLMMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        ...makeMessages(20),
      ];

      const result = await autoCompress(messages, 100, 'anthropic');

      expect(result.compressed).toBe(true);
      // Original system message should be first
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toBe('You are a helpful assistant.');
      // Auto-compressed summary should be second
      expect(result.messages[1].role).toBe('system');
      expect((result.messages[1].content as string)).toContain('[Auto-compressed context');
    });
  });

  // =========================================================================
  // llmSummarize
  // =========================================================================

  describe('llmSummarize', () => {
    it('returns null on failure', async () => {
      mockedChat.mockRejectedValue(new Error('Network error'));

      const messages: LLMMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      const result = await llmSummarize(messages, 'anthropic');
      expect(result).toBeNull();
    });

    it('returns null when response is too short', async () => {
      mockedChat.mockResolvedValue({
        content: 'short',
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 5,
      });

      const messages: LLMMessage[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = await llmSummarize(messages, 'anthropic');
      expect(result).toBeNull();
    });

    it('returns summary text on success', async () => {
      const summaryText = 'The conversation covered setting up a new project with TypeScript configuration.';
      mockedChat.mockResolvedValue({
        content: summaryText,
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 20,
      });

      const messages: LLMMessage[] = [
        { role: 'user', content: 'Help me set up TypeScript' },
        { role: 'assistant', content: 'Sure, let me help you with that.' },
      ];

      const result = await llmSummarize(messages, 'anthropic');
      expect(result).toBe(summaryText);
    });

    it('handles messages with array content blocks', async () => {
      const summaryText = 'Summary of conversation with mixed content blocks.';
      mockedChat.mockResolvedValue({
        content: summaryText,
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 20,
      });

      const messages: LLMMessage[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello with blocks' }],
        },
      ];

      const result = await llmSummarize(messages, 'anthropic');
      expect(result).toBe(summaryText);
      // Verify chat was called with proper summarization messages
      expect(mockedChat).toHaveBeenCalledWith(
        'anthropic',
        expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user' }),
        ]),
        [],
        undefined,
      );
    });

    it('passes model override to chat', async () => {
      mockedChat.mockResolvedValue({
        content: 'A sufficiently long summary for the test to pass validation.',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 20,
      });

      await llmSummarize(
        [{ role: 'user', content: 'test' }],
        'anthropic',
        'claude-3-haiku-20240307',
      );

      expect(mockedChat).toHaveBeenCalledWith(
        'anthropic',
        expect.any(Array),
        [],
        'claude-3-haiku-20240307',
      );
    });
  });
});
